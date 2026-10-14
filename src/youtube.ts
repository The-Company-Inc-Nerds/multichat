import type {
  Badge,
  ChannelState,
  Emitter,
  MessageKind,
  YouTubeChannelConfig,
  YouTubeConfig,
} from "./types.ts";

const BASE = "https://www.googleapis.com/youtube/v3";

// ---- Quota model + cadences ------------------------------------------------
//
// Since 2026-06-01 the Data API has two daily buckets per Google project, both
// reset at 00:00 America/Los_Angeles: search.list gets its own 100 calls/day,
// and everything else shares one pool (10,000 units by default). The poller is
// built around them: an offline channel is watched through its uploads
// playlist (≈2 units per check) instead of search.list, search is rationed to
// a fallback, and live-chat polling is stretched so a whole stream fits in
// what's left of the day (see pollFloorMs).

/** Estimated units per liveChatMessages.list call. Google's table doesn't list
 *  the method; the long-standing community figure is 5, so plan for that (read
 *  the real figure off Cloud Console → Quotas if it matters). */
export const LIVE_CALL_COST = 5;
/** Units held back per watched channel and remaining hour of the Pacific day
 *  for discovery — an offline check every DISCOVERY_TICK_MS costs ≈2, so ≈40
 *  an hour per channel. */
export const DISCOVERY_UNITS_PER_HOUR = 40;
/** search.list calls per Pacific day the fallback may make (the bucket is 100;
 *  the rest is headroom for restarts and other tools on the project). */
export const SEARCH_DAILY_CAP = 40;
/** Never search more often than this, whatever is left of the cap. */
export const SEARCH_MIN_SPACING_MS = 20 * 60_000;
/** Offline recheck: playlistItems.list + videos.list, ≈2 units. */
export const DISCOVERY_TICK_MS = 3 * 60_000;
/** One quick recheck right after a chat ends, to catch an encoder restart that
 *  comes back as a new broadcast (new videoId). */
export const RESTART_RECHECK_MS = 30_000;
/** Recheck cadence while a scheduled stream is about to start (or overdue). */
export const UPCOMING_TICK_MS = 60_000;
/** While attached, confirm via videos.list that the broadcast is still live. */
export const LIVE_VERIFY_MS = 10 * 60_000;
/** Every Data API request gives up after this long. */
export const FETCH_TIMEOUT_MS = 15_000;
/** Message ids remembered per channel, so a re-attach doesn't replay rows. */
export const SEEN_MAX = 5000;
/** While catching up on a chat, items older than this are history (backlog);
 *  an unplanned gap this long between good polls means catching up again. */
export const BACKLOG_WINDOW_MS = 5 * 60_000;
/** Longest gap between chat polls once the quota floor takes over (YouTube's
 *  own suggestion is capped at 60s): at 10 min a chat costs ≈30 units/h, plus
 *  ≈6/h verifying it, under the 40/h discovery reserve released toward
 *  midnight — so a stream past budgetHours slows down instead of running the
 *  pool dry. */
export const MAX_GOVERNED_POLL_MS = 10 * 60_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const UNIT_COST = 1; // channels / playlistItems / videos .list
const DEFAULT_POLL_MS = 5_000; // when the API gives no pollingIntervalMillis
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 60_000; // ceiling for YouTube's own pollingIntervalMillis
const MIN_PLANNED_LIVE_MS = 30 * 60_000;
const UPCOMING_SOON_MS = 15 * 60_000;
const UPCOMING_OVERDUE_MS = 2 * HOUR_MS;
const ERROR_RETRY_MS = 60_000;
const DENIED_RETRY_MS = 10 * 60_000;
const TRANSIENT_BASE_MS = 5_000;
const TRANSIENT_MAX_MS = 60_000;
const TRANSIENT_ERROR_AFTER = 3; // failed polls / checks in a row → "error"
const RATE_LIMIT_MIN_MS = 10_000;
const OFFLINE_POLL_MIN_MS = 10_000; // poll floor while offlineAt is set
const OFFLINE_VERIFY_EVERY_MS = 60_000;
const DEAD_CHAT_TTL_MS = 10 * 60_000;
const QUOTA_JITTER_MIN_MS = 2 * 60_000;
const QUOTA_JITTER_SPAN_MS = 5 * 60_000;
const MAX_PAGE_TOKENS = 16;

export const DEFAULT_DAILY_QUOTA = 10_000;
export const DEFAULT_BUDGET_HOURS = 4;

// ---- Settings ----------------------------------------------------------------

function clampNumber(raw: unknown, lo: number, hi: number, def: number) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) {
    return def;
  }
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Validate the `youtube` block of settings.json. `dailyQuota` (default 10,000,
 * clamped to 1,000..10,000,000) is the project's main-pool units per day —
 * raise it after Google grants a quota increase; `budgetHours` (default 4,
 * clamped to 0.5..24) is how many hours of live chat a day the remaining quota
 * is spread over. The API key itself is resolved separately (see main.ts).
 */
export function normalizeYouTubeConfig(raw: unknown): YouTubeConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const channels = Array.isArray(r.channels)
    ? r.channels.filter((c): c is YouTubeChannelConfig =>
      !!c && typeof c === "object"
    )
    : [];
  return {
    apiKey: typeof r.apiKey === "string" ? r.apiKey : "",
    channels,
    dailyQuota: Math.round(
      clampNumber(r.dailyQuota, 1_000, 10_000_000, DEFAULT_DAILY_QUOTA),
    ),
    budgetHours: clampNumber(r.budgetHours, 0.5, 24, DEFAULT_BUDGET_HOURS),
  };
}

/** Sidebar/row name for a channel entry. `||`, not `??`: the NixOS module
 *  writes unset fields as "", which must fall through to the next one. */
export function youtubeLabel(ch: YouTubeChannelConfig): string {
  return ch.handle || ch.channelId || ch.videoId || "unknown";
}

/** Non-secret fingerprint of an API key (32-bit FNV-1a, hex) — enough to tell
 *  "a different key" apart in the persisted quota ledger without storing it. */
export function keyFingerprint(key: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(key)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---- Error classification --------------------------------------------------

/** How a failed Data API call should be handled. */
export type YtErrorKind =
  | "quotaDaily" // the main pool is spent: nothing works until 00:00 PT
  | "searchQuota" // search.list's own per-day bucket is spent (429)
  | "rateLimited" // too fast: a per-minute limit, or a chat polled too soon
  | "chatEnded" // the live chat is over, disabled, or never existed
  | "badPageToken" // the stored pageToken is no longer accepted
  | "denied" // key/project problem: bad key, API not enabled, blocked caller
  | "transient"; // 5xx, network error, timeout, unparseable body

export interface YtFailure {
  ok: false;
  kind: YtErrorKind;
  /** HTTP status; 0 when no response arrived (network error / timeout). */
  status: number;
  reason: string;
  message: string;
}

export type YtResult<T> = { ok: true; data: T } | YtFailure;

const CHAT_ENDED_REASONS = new Set([
  "liveChatEnded",
  "liveChatDisabled",
  "liveChatNotFound",
]);
const PAGE_TOKEN_REASONS = new Set(["pageTokenInvalid", "invalidPageToken"]);
const DAILY_QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "userRequestsExceedRateLimit",
]);
const DENIED_REASONS = new Set([
  "keyInvalid",
  "keyExpired",
  "API_KEY_INVALID",
  "API_KEY_EXPIRED",
  "accessNotConfigured",
  "SERVICE_DISABLED",
  "ipRefererBlocked",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_SERVICE_BLOCKED",
  "forbidden",
  "badRequest",
]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> =>
      !!x && typeof x === "object"
    )
    : [];

/**
 * Classify a failed response from its status and Google's error envelope
 * (`{error:{code,status,message,errors:[{reason,domain}],details:[{reason,
 * metadata:{quota_limit,quota_metric}}]}}`). The reason string alone is
 * ambiguous — `rateLimitExceeded` is both "chat polled too soon" (403) and the
 * search bucket running dry (429 … 'Search Queries per day') — so the status
 * and the quota metadata decide. `liveChat` marks a liveChatMessages request,
 * where a bare 404 means the chat is gone.
 */
export function classifyYtError(
  status: number,
  bodyText: string,
  liveChat = false,
): { kind: YtErrorKind; reason: string; message: string } {
  let err: Record<string, unknown> | null = null;
  try {
    const o = JSON.parse(bodyText);
    if (o && typeof o === "object" && o.error && typeof o.error === "object") {
      err = o.error as Record<string, unknown>;
    }
  } catch { /* not JSON — classified on the status alone */ }

  const errors = records(err?.errors);
  const details = records(err?.details);
  const reasons = errors.map((e) => str(e.reason)).filter((r) => r);
  const detailReasons = details.map((d) => str(d.reason)).filter((r) => r);
  const domains = errors.map((e) => str(e.domain));
  const meta = details.map((d) =>
    (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<
      string,
      unknown
    >
  );
  const quotaLimit = meta.map((m) => str(m.quota_limit)).join(" ");
  const quotaMetric = meta.map((m) => str(m.quota_metric)).join(" ");
  const quotaUnit = meta.map((m) => str(m.quota_unit)).join(" ");
  const message = str(err?.message) || bodyText.slice(0, 200);
  const reason = reasons[0] || detailReasons[0] || str(err?.status) ||
    (status ? `HTTP ${status}` : "network");
  const all = [...reasons, ...detailReasons];
  const has = (set: Set<string>) => all.some((r) => set.has(r));
  const out = (kind: YtErrorKind) => ({ kind, reason, message });

  if (status === 0 || status >= 500) return out("transient");
  if (!err) {
    if (status === 429) return out("rateLimited");
    if (status === 404 && liveChat) return out("chatEnded");
    return out("transient");
  }
  if (has(CHAT_ENDED_REASONS) || (status === 404 && liveChat)) {
    return out("chatEnded");
  }
  if (has(PAGE_TOKEN_REASONS)) return out("badPageToken");
  if (status === 429) {
    const search = /search_list/i.test(quotaMetric) ||
      /SearchList/i.test(quotaLimit) || /Search Queries/i.test(message);
    const perDay = /per day/i.test(message) || /PerDay/i.test(quotaLimit) ||
      /\/d\//.test(quotaUnit) || has(DAILY_QUOTA_REASONS);
    if (perDay) return out(search ? "searchQuota" : "quotaDaily");
    return out("rateLimited");
  }
  if (has(DAILY_QUOTA_REASONS)) return out("quotaDaily");
  // Before the domain check: a chat polled too soon must never read as "the
  // day's quota is gone" (that would park the channel until midnight).
  if (has(RATE_REASONS)) return out("rateLimited");
  if (domains.includes("youtube.quota")) return out("quotaDaily");
  if (has(DENIED_REASONS) || status >= 400) return out("denied");
  return out("transient");
}

/** A request URL as it may be logged: host/base and the `key` param removed. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("key");
    const path = u.pathname.replace(/^\/youtube\/v3/, "");
    return path + (u.search ? decodeURIComponent(u.search) : "");
  } catch {
    return url.replace(/([?&])key=[^&]*/g, "$1key=…");
  }
}

/**
 * Free text (a thrown fetch error, an unexpected exception) as it may be
 * logged: every `key=` parameter is masked, and so is the literal `key`
 * wherever else it appears — Deno's fetch errors embed the whole request URL,
 * sometimes re-encoded, so matching the URL verbatim isn't enough.
 */
export function redactKey(text: string, key = ""): string {
  const out = text.replace(/([?&])key=[^&\s)]*/g, "$1key=…");
  return key ? out.split(key).join("…") : out;
}

/** The `key` query parameter of a request URL ("" when it has none). */
function keyParam(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? "" : new URLSearchParams(url.slice(q + 1)).get("key") ?? "";
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type LogFn = (line: string, level?: "info" | "error") => void;

const defaultLog: LogFn = (line, level) =>
  level === "error" ? console.error(line) : console.log(line);

/**
 * GET a Data API URL. Never throws: returns the parsed body or a classified
 * failure. Every request is time-boxed (FETCH_TIMEOUT_MS) and tied to the
 * poller generation's `signal`, so neither a hung connection nor a torn-down
 * generation can stall or outlive the loop. A failure is logged once, with
 * the key stripped from the URL and the message (see redactKey); nothing is
 * logged for an aborted request.
 */
export async function ytFetch<T>(
  url: string,
  signal?: AbortSignal,
  deps: { fetch?: FetchFn; log?: LogFn } = {},
): Promise<YtResult<T>> {
  const doFetch = deps.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const log = deps.log ?? defaultLog;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let status = 0;
  let body = "";
  let netError = "";
  try {
    const r = await doFetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    status = r.status;
    body = await r.text();
    if (r.ok) {
      try {
        return { ok: true, data: JSON.parse(body) as T };
      } catch { /* unparseable 200 → transient below */ }
    }
  } catch (e) {
    netError = timeout.aborted
      ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
      : String(e);
  }
  const c = classifyYtError(status, body, url.includes("/liveChat/"));
  const fail: YtFailure = {
    ok: false,
    kind: c.kind,
    status,
    reason: netError ? (timeout.aborted ? "timeout" : "network") : c.reason,
    message: redactKey(
      netError || c.message.replace(/<[^>]*>/g, "").slice(0, 300),
      keyParam(url),
    ),
  };
  if (!signal?.aborted) {
    log(
      `[YouTube] GET ${redactUrl(url)} → ${
        status ? `HTTP ${status} ${fail.reason}` : fail.reason
      } (${fail.kind}): ${fail.message}`,
      "error",
    );
  }
  return fail;
}

// ---- Pacific clock -----------------------------------------------------------

const PT_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function ptParts(ms: number): { day: string; wallMs: number } {
  const p: Record<string, string> = {};
  for (const { type, value } of PT_FORMAT.formatToParts(ms)) p[type] = value;
  const wallMs = ((Number(p.hour) * 60 + Number(p.minute)) * 60 +
        Number(p.second)) * 1000 + (((ms % 1000) + 1000) % 1000);
  return { day: `${p.year}-${p.month}-${p.day}`, wallMs };
}

/** The quota day ("YYYY-MM-DD" in America/Los_Angeles) containing `nowMs`. */
export function pacificDay(nowMs: number): string {
  return ptParts(nowMs).day;
}

/** Milliseconds until the next 00:00 America/Los_Angeles — when Google resets
 *  the daily quota. Exact across DST changes (one refinement step). */
export function msUntilPacificMidnight(nowMs: number): number {
  const today = ptParts(nowMs);
  let t = nowMs + DAY_MS - today.wallMs; // right unless a DST shift is between
  const at = ptParts(t);
  if (at.day !== today.day) t -= at.wallMs; // overshot (a 23h day)
  else t += DAY_MS - at.wallMs; // undershot (a 25h day)
  return t - nowMs;
}

/** "11h4m" — for log lines. */
export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

// ---- Quota ledger ------------------------------------------------------------

/** One Pacific day of Data API spend — persisted, so a restart doesn't forget
 *  what's been used (Google's counter certainly won't). */
export interface QuotaSnapshot {
  day: string;
  /** Estimated main-pool units spent today. */
  units: number;
  /** search.list calls made today (their own bucket). */
  searches: number;
  /** search.list answered "per day" exhaustion: no more searches today. */
  searchBlocked: boolean;
  /** The main pool answered quotaExceeded: nothing more today. */
  exhausted: boolean;
  /** Time spent attached to a live chat today. */
  liveMs: number;
  lastSearchAt: number | null;
  /** keyFingerprint of the key this day's spend was counted against. */
  keyFp: string | null;
}

export function freshQuota(
  day: string,
  keyFp: string | null = null,
): QuotaSnapshot {
  return {
    day,
    units: 0,
    searches: 0,
    searchBlocked: false,
    exhausted: false,
    liveMs: 0,
    lastSearchAt: null,
    keyFp,
  };
}

/** Restore a persisted snapshot: anything malformed, or from an earlier
 *  Pacific day, starts `today` fresh (keeping the key fingerprint). */
export function normalizeQuotaSnapshot(
  raw: unknown,
  today: string,
): QuotaSnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const keyFp = typeof r.keyFp === "string" ? r.keyFp : null;
  if (r.day !== today) return freshQuota(today, keyFp);
  return {
    day: today,
    units: num(r.units),
    searches: num(r.searches),
    searchBlocked: r.searchBlocked === true,
    exhausted: r.exhausted === true,
    liveMs: num(r.liveMs),
    lastSearchAt: typeof r.lastSearchAt === "number" ? r.lastSearchAt : null,
    keyFp,
  };
}

/**
 * The slowest-allowed chat poll interval that still lets the rest of today's
 * budgeted live time fit in what's left of the quota:
 *
 *   remainingForChat   = dailyQuota − unitsSpent
 *                          − 40 × watchedChannels × hoursUntilMidnightPT
 *   plannedRemainingMs = max(budgetHours·1h − liveMsToday, 30 min)
 *   floor = LIVE_CALL_COST × plannedRemainingMs
 *             / max(remainingForChat / activeChats, LIVE_CALL_COST)
 *
 * i.e. spread each chat's share of the units evenly over the hours still
 * planned, after holding back each watched channel's discovery for the rest
 * of the day (`watching`, default 1). A fresh 10,000-unit day with a 4h
 * budget and one channel gives ≈8s; going past the budget keeps stretching
 * (30 min is always assumed left; governedIntervalMs caps it at
 * MAX_GOVERNED_POLL_MS) instead of exhausting the pool; a bigger dailyQuota
 * shrinks it towards the API's own pollingIntervalMillis.
 */
export function pollFloorMs(o: {
  dailyQuota: number;
  budgetHours: number;
  unitsSpent: number;
  liveMsToday: number;
  msUntilMidnight: number;
  activeChats: number;
  watching?: number;
}): number {
  const reserve = DISCOVERY_UNITS_PER_HOUR * Math.max(1, o.watching ?? 1) *
    (o.msUntilMidnight / HOUR_MS);
  const remainingForChat = o.dailyQuota - o.unitsSpent - reserve;
  const plannedRemainingMs = Math.max(
    o.budgetHours * HOUR_MS - o.liveMsToday,
    MIN_PLANNED_LIVE_MS,
  );
  const perChat = Math.max(
    remainingForChat / Math.max(1, o.activeChats),
    LIVE_CALL_COST,
  );
  return LIVE_CALL_COST * plannedRemainingMs / perChat;
}

/** The interval actually slept between chat polls: never faster than the API
 *  asks (pollingIntervalMillis, itself kept in 1s..60s) or than the quota
 *  floor, which may stretch it past 60s up to MAX_GOVERNED_POLL_MS. */
export function governedIntervalMs(
  pollingIntervalMillis: number | undefined,
  floorMs: number,
): number {
  const asked = Math.min(
    Math.max(pollingIntervalMillis ?? DEFAULT_POLL_MS, MIN_POLL_MS),
    MAX_POLL_MS,
  );
  return Math.min(Math.max(asked, floorMs), MAX_GOVERNED_POLL_MS);
}

/** Minimum gap before the next search: the day's remaining searches spread
 *  over what's left of it, never closer than SEARCH_MIN_SPACING_MS. */
export function searchSpacingMs(
  searchesToday: number,
  msUntilMidnight: number,
): number {
  const remaining = SEARCH_DAILY_CAP - searchesToday;
  if (remaining <= 0) return Infinity;
  return Math.max(SEARCH_MIN_SPACING_MS, msUntilMidnight / remaining);
}

/** Whether the shared search gate is open at `nowMs`. */
export function searchGateOpen(q: QuotaSnapshot, nowMs: number): boolean {
  if (q.searchBlocked || q.exhausted || q.searches >= SEARCH_DAILY_CAP) {
    return false;
  }
  if (q.lastSearchAt === null) return true;
  return nowMs - q.lastSearchAt >=
    searchSpacingMs(q.searches, msUntilPacificMidnight(nowMs));
}

export interface QuotaLedger {
  readonly dailyQuota: number;
  readonly budgetHours: number;
  /** Today's numbers (rolled over first if the Pacific day changed). */
  snapshot(): QuotaSnapshot;
  charge(units: number): void;
  noteSearch(): void;
  /** Returns true when this call blocked it (false: already blocked). */
  blockSearch(): boolean;
  /** Returns true when this call marked it (false: already exhausted). */
  markExhausted(): boolean;
  addLiveMs(ms: number): void;
  searchAllowed(): boolean;
  /** The governed chat interval with `chats` live and `watching` channels
   *  watched in all (each needs its discovery reserve; default 1). */
  pollIntervalMs(
    pollingIntervalMillis: number | undefined,
    chats: number,
    watching?: number,
  ): number;
  /** Record which key is spending. A different key than the stored one may
   *  belong to another Google project, so today restarts from zero (→ true). */
  adoptKey(fp: string): boolean;
}

/** The per-Pacific-day spend tracker. Rolls over by itself when the day
 *  changes; `onChange` fires after every mutation (the caller persists). */
export function createQuotaLedger(opts: {
  dailyQuota?: number;
  budgetHours?: number;
  snapshot?: unknown;
  onChange?: () => void;
  now?: () => number;
} = {}): QuotaLedger {
  const now = opts.now ?? Date.now;
  const dailyQuota = opts.dailyQuota ?? DEFAULT_DAILY_QUOTA;
  const budgetHours = opts.budgetHours ?? DEFAULT_BUDGET_HOURS;
  const changed = () => opts.onChange?.();
  let q = normalizeQuotaSnapshot(opts.snapshot, pacificDay(now()));

  function cur(): QuotaSnapshot {
    const day = pacificDay(now());
    if (q.day !== day) {
      q = freshQuota(day, q.keyFp);
      changed();
    }
    return q;
  }

  return {
    dailyQuota,
    budgetHours,
    snapshot: () => ({ ...cur() }),
    charge(units) {
      if (units <= 0) return;
      cur().units += units;
      changed();
    },
    noteSearch() {
      const s = cur();
      s.searches++;
      s.lastSearchAt = now();
      changed();
    },
    blockSearch() {
      const s = cur();
      if (s.searchBlocked) return false;
      s.searchBlocked = true;
      changed();
      return true;
    },
    markExhausted() {
      const s = cur();
      if (s.exhausted) return false;
      s.exhausted = true;
      changed();
      return true;
    },
    addLiveMs(ms) {
      if (!(ms > 0)) return;
      cur().liveMs += ms;
      changed();
    },
    searchAllowed: () => searchGateOpen(cur(), now()),
    pollIntervalMs(pollingIntervalMillis, chats, watching = 1) {
      const s = cur();
      const floor = pollFloorMs({
        dailyQuota,
        budgetHours,
        unitsSpent: s.units,
        liveMsToday: s.liveMs,
        msUntilMidnight: msUntilPacificMidnight(now()),
        activeChats: chats,
        watching,
      });
      return governedIntervalMs(pollingIntervalMillis, floor);
    },
    adoptKey(fp) {
      const s = cur();
      if (s.keyFp === fp) return false;
      const reset = s.keyFp !== null;
      q = reset ? freshQuota(s.day, fp) : { ...s, keyFp: fp };
      changed();
      return reset;
    },
  };
}

// ---- Chat items ----------------------------------------------------------------

export interface ChatItem {
  id: string;
  snippet: {
    type: string;
    displayMessage?: string;
    publishedAt: string;
    superChatDetails?: {
      amountDisplayString: string;
      userComment?: string;
      tier?: number;
    };
    superStickerDetails?: {
      amountDisplayString: string;
      tier?: number;
      superStickerMetadata?: { altText?: string };
    };
    newSponsorDetails?: { memberLevelName?: string };
    memberMilestoneChatDetails?: {
      memberLevelName?: string;
      memberMonth?: number;
      userComment?: string;
    };
    messageDeletedDetails?: { deletedMessageId: string };
  };
  authorDetails: {
    displayName: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
    isVerified?: boolean;
  };
}

interface ChatPage {
  items?: ChatItem[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  /** Present once the underlying stream went offline (it may come back). */
  offlineAt?: string;
}

// Super Chat / Super Sticker tier → YouTube's standard highlight color (1..7, clamped).
const TIER_COLORS = [
  "#1565C0", // 1 blue
  "#00B8D4", // 2 light blue
  "#00BFA5", // 3 teal
  "#FFCA28", // 4 yellow
  "#F57C00", // 5 orange
  "#E91E63", // 6 magenta
  "#E62117", // 7 red
];
export const tierColor = (tier?: number) =>
  TIER_COLORS[Math.min(Math.max((tier ?? 1) - 1, 0), TIER_COLORS.length - 1)];

export function buildBadges(a: ChatItem["authorDetails"]): Badge[] {
  const out: Badge[] = [];
  if (a.isChatOwner) out.push({ id: "owner", label: "Owner" });
  if (a.isChatModerator) out.push({ id: "moderator", label: "Mod" });
  if (a.isChatSponsor) out.push({ id: "member", label: "Member" });
  if (a.isVerified) out.push({ id: "verified", label: "Verified" });
  return out;
}

/** `opts.backlog` flags history fetched while catching up on a chat: rendered
 *  as usual, but the /alerts overlay won't pop it (see ChatMessage.backlog). */
export function emitItem(
  item: ChatItem,
  channel: string,
  emitter: Emitter,
  opts: { backlog?: boolean } = {},
): void {
  const sn = item.snippet;
  const author = item.authorDetails.displayName;
  const badges = buildBadges(item.authorDetails);
  const timestamp = new Date(sn.publishedAt).getTime();

  let kind: MessageKind = "chat";
  let content = sn.displayMessage ?? "";
  let amount: string | undefined;
  let accentColor: string | undefined;
  let eventText: string | undefined;

  switch (sn.type) {
    case "textMessageEvent":
      break;
    case "superChatEvent": {
      const d = sn.superChatDetails;
      kind = "superchat";
      amount = d?.amountDisplayString;
      accentColor = tierColor(d?.tier);
      eventText = `${author} sent a Super Chat`;
      content = d?.userComment ?? "";
      break;
    }
    case "superStickerEvent": {
      const d = sn.superStickerDetails;
      kind = "supersticker";
      amount = d?.amountDisplayString;
      accentColor = tierColor(d?.tier);
      eventText = `${author} sent a Super Sticker`;
      content = d?.superStickerMetadata?.altText ?? "";
      break;
    }
    case "newSponsorEvent": {
      kind = "membership";
      accentColor = "#2ba640";
      const level = sn.newSponsorDetails?.memberLevelName;
      eventText = level
        ? `${author} became a member (${level})`
        : `${author} became a member`;
      content = "";
      break;
    }
    case "memberMilestoneChatEvent": {
      const d = sn.memberMilestoneChatDetails;
      kind = "membership";
      accentColor = "#2ba640";
      const months = d?.memberMonth ? ` — ${d.memberMonth} months` : "";
      eventText = `${author} member milestone${months}`;
      content = d?.userComment ?? "";
      break;
    }
    case "messageDeletedEvent": {
      const id = sn.messageDeletedDetails?.deletedMessageId;
      if (id) emitter.delete({ platform: "youtube", channel, messageId: id });
      return;
    }
    default:
      return; // ignore tombstones, sponsor-only-mode toggles, chatEndedEvent, etc.
  }

  emitter.message({
    id: item.id,
    platform: "youtube",
    channel,
    author,
    content,
    badges: badges.length ? badges : undefined,
    kind,
    amount,
    accentColor,
    eventText,
    timestamp,
    backlog: opts.backlog ? true : undefined,
  });
}

/** Add `id` to a bounded insertion-ordered seen set (oldest evicted past
 *  `max`). Returns false when it was already there — a duplicate. */
export function rememberId(
  seen: Set<string>,
  id: string,
  max = SEEN_MAX,
): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  while (seen.size > max) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}

/**
 * One page of chat → the items to emit: ids already seen (a re-attach, a
 * dropped page token) are skipped, and when `backlogBefore` is set (the poller
 * is catching up — see pollChat) items published before it are flagged as
 * backlog.
 */
export function freshItems(
  items: ChatItem[],
  seen: Set<string>,
  backlogBefore: number | null,
  max = SEEN_MAX,
): { item: ChatItem; backlog: boolean }[] {
  const out: { item: ChatItem; backlog: boolean }[] = [];
  for (const item of items) {
    if (!item?.id || !rememberId(seen, item.id, max)) continue;
    const at = Date.parse(item.snippet?.publishedAt ?? "");
    out.push({ item, backlog: backlogBefore !== null && at < backlogBefore });
  }
  return out;
}

// ---- Live detection ------------------------------------------------------------

export interface VideoItem {
  id: string;
  snippet?: { liveBroadcastContent?: string };
  liveStreamingDetails?: {
    actualStartTime?: string;
    actualEndTime?: string;
    scheduledStartTime?: string;
    activeLiveChatId?: string;
  };
}

export interface LivePick {
  live: { videoId: string; chatId: string; startedAt: number } | null;
  /** A scheduled stream starts within 15 min (or is up to 2h overdue). */
  soon: boolean;
}

/**
 * Pick the live broadcast out of a videos.list (part=snippet,
 * liveStreamingDetails) response: live = liveBroadcastContent "live" with an
 * activeLiveChatId and no actualEndTime (an upcoming stream's waiting-room
 * chat doesn't count), the most recently started one winning. `skipChat`
 * excludes chats this poller just saw end (videos.list lags behind them).
 */
export function pickLiveVideo(
  resp: { items?: VideoItem[] } | null | undefined,
  nowMs: number,
  skipChat: (chatId: string) => boolean = () => false,
): LivePick {
  let live: LivePick["live"] = null;
  let soon = false;
  for (const v of resp?.items ?? []) {
    const d = v.liveStreamingDetails ?? {};
    const content = v.snippet?.liveBroadcastContent;
    if (
      content === "live" && d.activeLiveChatId && !d.actualEndTime &&
      !skipChat(d.activeLiveChatId)
    ) {
      const startedAt = Date.parse(d.actualStartTime ?? "") || 0;
      if (!live || startedAt > live.startedAt) {
        live = { videoId: v.id, chatId: d.activeLiveChatId, startedAt };
      }
    } else if (content === "upcoming" && d.scheduledStartTime) {
      const at = Date.parse(d.scheduledStartTime);
      if (at - nowMs <= UPCOMING_SOON_MS && nowMs - at <= UPCOMING_OVERDUE_MS) {
        soon = true;
      }
    }
  }
  return { live, soon };
}

// ---- Runtime -------------------------------------------------------------------

/** What a poller remembers about one channel across generations (key
 *  changes): resolved ids, the last live video, seen message ids, and the
 *  page token per live chat — so a re-attach resumes instead of replaying. */
export interface ChannelCache {
  channelId: string | null;
  uploadsId: string | null;
  lastLiveVideoId: string | null;
  seen: Set<string>;
  pageTokens: Map<string, string>;
  /** chatId → until: chats seen ending, skipped by discovery meanwhile. */
  deadChats: Map<string, number>;
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

// Abortable sleep: resolves early (does not reject) when the signal fires, so a
// poll loop parked in a backoff wakes immediately when its key is replaced. A
// timer that fires normally takes its abort listener with it — a generation's
// signal can live for months, and must not collect one listener per poll.
const sleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface YouTubeRuntime {
  readonly ledger: QuotaLedger;
  readonly now: () => number;
  readonly sleep: SleepFn;
  readonly fetch: FetchFn;
  readonly random: () => number;
  readonly log: LogFn;
  /** Per-channel caches keyed by youtubeLabel. */
  readonly channels: Map<string, ChannelCache>;
  /** Labels whose chat is being polled right now (they split the budget). */
  readonly active: Set<string>;
}

export interface YouTubeRuntimeOptions {
  dailyQuota?: number;
  budgetHours?: number;
  /** A persisted QuotaSnapshot to resume today's spend from. */
  snapshot?: unknown;
  /** Fired after every ledger change — persist ledger.snapshot(). */
  onChange?: () => void;
  now?: () => number;
  sleep?: SleepFn;
  fetch?: FetchFn;
  random?: () => number;
  log?: LogFn;
}

/** The state a poller keeps across generations, plus its injectable clock,
 *  sleep and fetch (tests drive the loop through these). */
export function createYouTubeRuntime(
  opts: YouTubeRuntimeOptions = {},
): YouTubeRuntime {
  const now = opts.now ?? Date.now;
  return {
    ledger: createQuotaLedger({
      dailyQuota: opts.dailyQuota,
      budgetHours: opts.budgetHours,
      snapshot: opts.snapshot,
      onChange: opts.onChange,
      now,
    }),
    now,
    sleep: opts.sleep ?? sleep,
    fetch: opts.fetch ?? ((u, i) => globalThis.fetch(u, i)),
    random: opts.random ?? Math.random,
    log: opts.log ?? defaultLog,
    channels: new Map(),
    active: new Set(),
  };
}

function channelCache(rt: YouTubeRuntime, label: string): ChannelCache {
  let c = rt.channels.get(label);
  if (!c) {
    c = {
      channelId: null,
      uploadsId: null,
      lastLiveVideoId: null,
      seen: new Set(),
      pageTokens: new Map(),
      deadChats: new Map(),
    };
    rt.channels.set(label, c);
  }
  return c;
}

function apiUrl(
  path: string,
  params: Record<string, string>,
  key: string,
): string {
  return `${BASE}/${path}?${new URLSearchParams({ ...params, key })}`;
}

/** One metered request: charges the ledger (Google bills even failed calls)
 *  and records quota exhaustion wherever it shows up. */
async function call<T>(
  rt: YouTubeRuntime,
  url: string,
  cost: number,
  signal?: AbortSignal,
): Promise<YtResult<T>> {
  if (signal?.aborted) {
    return {
      ok: false,
      kind: "transient",
      status: 0,
      reason: "aborted",
      message: "poller stopped",
    };
  }
  const res = await ytFetch<T>(url, signal, rt);
  if (res.ok || res.status !== 0) rt.ledger.charge(cost);
  if (!res.ok && res.kind === "quotaDaily") rt.ledger.markExhausted();
  if (!res.ok && res.kind === "searchQuota" && rt.ledger.blockSearch()) {
    rt.log(
      "[YouTube] search.list's daily bucket is spent — live detection " +
        "continues via uploads playlists; search resumes at 00:00 PT " +
        `(in ${formatDuration(msUntilPacificMidnight(rt.now()))}).`,
      "error",
    );
  }
  return res;
}

interface ChannelCtx {
  ch: YouTubeChannelConfig;
  label: string;
  key: string;
  emitter: Emitter;
  rt: YouTubeRuntime;
  cache: ChannelCache;
  signal?: AbortSignal;
  status: (state: ChannelState, why: string) => void;
}

type Discovery =
  | { kind: "live"; videoId: string; chatId: string; via: string }
  | { kind: "offline"; soon: boolean }
  | { kind: "failed"; failure: YtFailure; step: string };

const isDead = (ctx: ChannelCtx) => (chatId: string) =>
  (ctx.cache.deadChats.get(chatId) ?? 0) > ctx.rt.now();

const videosUrl = (ids: string[], key: string) =>
  apiUrl("videos", {
    part: "snippet,liveStreamingDetails",
    id: ids.join(","),
  }, key);

const configFailure = (reason: string, message: string): YtFailure => ({
  ok: false,
  kind: "denied",
  status: 0,
  reason,
  message,
});

/** One discovery tick: is this channel live right now, and on which chat? */
async function discover(ctx: ChannelCtx): Promise<Discovery> {
  const { ch, rt, cache, key, signal } = ctx;
  const skip = isDead(ctx);

  // A pinned video skips discovery: just check it (1 unit).
  if (ch.videoId) {
    const v = await call<{ items?: VideoItem[] }>(
      rt,
      videosUrl([ch.videoId], key),
      UNIT_COST,
      signal,
    );
    if (!v.ok) return { kind: "failed", failure: v, step: "videos.list" };
    const pick = pickLiveVideo(v.data, rt.now(), skip);
    return pick.live
      ? { kind: "live", ...pick.live, via: "configured videoId" }
      : { kind: "offline", soon: pick.soon };
  }

  // Resolve the channel id (handle → id) and its uploads playlist, once.
  if (!cache.channelId && ch.channelId) cache.channelId = ch.channelId;
  if (!cache.channelId) {
    if (!ch.handle) {
      return {
        kind: "failed",
        failure: configFailure("noChannel", "entry has no handle/channelId"),
        step: "config",
      };
    }
    const handle = ch.handle.startsWith("@") ? ch.handle : `@${ch.handle}`;
    const r = await call<
      {
        items?: {
          id?: string;
          contentDetails?: { relatedPlaylists?: { uploads?: string } };
        }[];
      }
    >(
      rt,
      apiUrl("channels", { part: "id,contentDetails", forHandle: handle }, key),
      UNIT_COST,
      signal,
    );
    if (!r.ok) return { kind: "failed", failure: r, step: "channels.list" };
    const it = r.data.items?.[0];
    if (!it?.id) {
      return {
        kind: "failed",
        failure: configFailure("handleNotFound", `no channel is ${handle}`),
        step: "channels.list",
      };
    }
    cache.channelId = it.id;
    cache.uploadsId = it.contentDetails?.relatedPlaylists?.uploads ?? null;
  }
  const cid = cache.channelId;
  if (!cache.uploadsId) {
    // UC… → UU… is the (undocumented, universal) uploads-playlist convention.
    const derived = cid.startsWith("UC") ? `UU${cid.slice(2)}` : null;
    const r = await call<
      {
        items?: {
          contentDetails?: { relatedPlaylists?: { uploads?: string } };
        }[];
      }
    >(
      rt,
      apiUrl("channels", { part: "contentDetails", id: cid }, key),
      UNIT_COST,
      signal,
    );
    if (r.ok) {
      const it = r.data.items?.[0];
      if (!it) {
        return {
          kind: "failed",
          failure: configFailure("channelNotFound", `no channel ${cid}`),
          step: "channels.list",
        };
      }
      cache.uploadsId = it.contentDetails?.relatedPlaylists?.uploads ??
        derived;
    } else if (r.kind === "transient" && derived) {
      cache.uploadsId = derived;
    } else {
      return { kind: "failed", failure: r, step: "channels.list" };
    }
  }

  // The newest uploads (a live stream is one of them) + the last live video,
  // checked in one videos.list: ≈2 units, where a search would burn 1 of 100.
  const candidates: string[] = [];
  let soon = false;
  if (cache.uploadsId) {
    const pl = await call<
      { items?: { contentDetails?: { videoId?: string } }[] }
    >(
      rt,
      apiUrl("playlistItems", {
        part: "contentDetails",
        maxResults: "5",
        playlistId: cache.uploadsId,
      }, key),
      UNIT_COST,
      signal,
    );
    if (pl.ok) {
      for (const it of pl.data.items ?? []) {
        const id = it.contentDetails?.videoId;
        if (id && !candidates.includes(id)) candidates.push(id);
      }
    } else if (pl.status !== 404) {
      // 404 = an empty/unknown uploads playlist: nothing to check yet.
      return { kind: "failed", failure: pl, step: "playlistItems.list" };
    }
  }
  if (cache.lastLiveVideoId && !candidates.includes(cache.lastLiveVideoId)) {
    candidates.push(cache.lastLiveVideoId);
  }
  if (candidates.length) {
    const v = await call<{ items?: VideoItem[] }>(
      rt,
      videosUrl(candidates, key),
      UNIT_COST,
      signal,
    );
    if (!v.ok) return { kind: "failed", failure: v, step: "videos.list" };
    const pick = pickLiveVideo(v.data, rt.now(), skip);
    if (pick.live) {
      cache.lastLiveVideoId = pick.live.videoId;
      return { kind: "live", ...pick.live, via: "uploads playlist" };
    }
    soon = pick.soon;
  }

  // Rationed fallback: some channels' live streams only reach the uploads
  // playlist after they end. The gate is shared by every channel and spends
  // at most SEARCH_DAILY_CAP of the 100-a-day bucket, spread over the day.
  if (!signal?.aborted && rt.ledger.searchAllowed()) {
    rt.ledger.noteSearch();
    const s = await call<{ items?: { id?: { videoId?: string } }[] }>(
      rt,
      apiUrl("search", {
        part: "id",
        channelId: cid,
        eventType: "live",
        type: "video",
        maxResults: "5",
      }, key),
      0, // billed to the search bucket (counted by noteSearch), not the pool
      signal,
    );
    if (s.ok) {
      const ids = (s.data.items ?? [])
        .map((it) => it.id?.videoId)
        .filter((id): id is string => !!id && !candidates.includes(id));
      if (ids.length) {
        const v = await call<{ items?: VideoItem[] }>(
          rt,
          videosUrl(ids, key),
          UNIT_COST,
          signal,
        );
        if (!v.ok) return { kind: "failed", failure: v, step: "videos.list" };
        const pick = pickLiveVideo(v.data, rt.now(), skip);
        if (pick.live) {
          cache.lastLiveVideoId = pick.live.videoId;
          return { kind: "live", ...pick.live, via: "search" };
        }
        soon ||= pick.soon;
      }
    } else if (s.kind === "quotaDaily") {
      return { kind: "failed", failure: s, step: "search.list" };
    }
    // Any other search failure is non-fatal: the playlist path answered.
  }
  return { kind: "offline", soon };
}

/** Is the attached broadcast still live on the same chat? (videos.list, 1
 *  unit.) Errors other than quota read as "live" — keep polling. */
async function verifyChat(
  ctx: ChannelCtx,
  videoId: string,
  chatId: string,
): Promise<"live" | "quota" | string> {
  const r = await call<{ items?: VideoItem[] }>(
    ctx.rt,
    videosUrl([videoId], ctx.key),
    UNIT_COST,
    ctx.signal,
  );
  if (!r.ok) return r.kind === "quotaDaily" ? "quota" : "live";
  const v = r.data.items?.[0];
  if (!v) return "the video is gone";
  const d = v.liveStreamingDetails ?? {};
  if (d.actualEndTime) return "the stream ended";
  if (v.snippet?.liveBroadcastContent !== "live") {
    return `the video is no longer live (${
      v.snippet?.liveBroadcastContent ?? "?"
    })`;
  }
  if (!d.activeLiveChatId) return "the live chat closed";
  if (d.activeLiveChatId !== chatId) return "the live chat moved";
  return "live";
}

function forgetChat(cache: ChannelCache, chatId: string, nowMs: number): void {
  cache.pageTokens.delete(chatId);
  cache.deadChats.set(chatId, nowMs + DEAD_CHAT_TTL_MS);
  for (const [id, until] of cache.deadChats) {
    if (until <= nowMs) cache.deadChats.delete(id);
  }
}

function rememberToken(cache: ChannelCache, chatId: string, token: string) {
  cache.pageTokens.delete(chatId); // re-insert: newest last
  cache.pageTokens.set(chatId, token);
  while (cache.pageTokens.size > MAX_PAGE_TOKENS) {
    const oldest = cache.pageTokens.keys().next().value;
    if (oldest === undefined) break;
    cache.pageTokens.delete(oldest);
  }
}

type ChatEnd =
  | { why: "ended"; detail: string }
  | { why: "denied"; failure: YtFailure }
  | { why: "quota" }
  | { why: "aborted" };

/** Poll one live chat until it ends, quota runs out, the key is refused, or
 *  the generation is torn down. */
async function pollChat(
  ctx: ChannelCtx,
  videoId: string,
  chatId: string,
  via: string,
): Promise<ChatEnd> {
  const { rt, cache, signal } = ctx;
  let token = cache.pageTokens.get(chatId);
  const attachedAt = rt.now();
  // Catching up: a fresh attach makes YouTube replay recent history, and a
  // resume (after a quota park, a key change, a rejected page token or a long
  // outage) returns everything since. Render it all, but while catching up
  // flag what's older than the window so overlays don't re-alert it; a page
  // with nothing that old on it means the poller has caught up.
  let catchingUp = true;
  let lastOkAt = attachedAt;
  let lastVerify = attachedAt;
  let lastOfflineCheck = -Infinity;
  let lastTick = attachedAt;
  let failures = 0;
  let backoff = TRANSIENT_BASE_MS;
  let interval = DEFAULT_POLL_MS;

  rt.active.add(ctx.label);
  ctx.status(
    "live",
    `polling live chat (video ${videoId}, found via ${via}${
      token ? ", resuming" : ""
    })`,
  );
  try {
    while (!signal?.aborted) {
      if (rt.ledger.snapshot().exhausted) return { why: "quota" };
      const tick = rt.now();
      rt.ledger.addLiveMs((tick - lastTick) / Math.max(1, rt.active.size));
      lastTick = tick;

      const params: Record<string, string> = {
        liveChatId: chatId,
        part: "snippet,authorDetails",
      };
      if (token) params.pageToken = token;
      const res = await call<ChatPage>(
        rt,
        apiUrl("liveChat/messages", params, ctx.key),
        LIVE_CALL_COST,
        signal,
      );
      if (signal?.aborted) break;

      if (!res.ok) {
        switch (res.kind) {
          case "chatEnded":
            forgetChat(cache, chatId, rt.now());
            return {
              why: "ended",
              detail: `${res.status || ""} ${res.reason}`.trim(),
            };
          case "denied":
            // A key or project problem, not the end of the chat: keep its page
            // token and don't mark it dead, so a fixed key re-attaches at once
            // and resumes where this one stopped.
            return { why: "denied", failure: res };
          case "quotaDaily":
            return { why: "quota" };
          case "badPageToken":
            // Start over without it: the seen set absorbs the replay, and
            // what's new in it but old is history.
            cache.pageTokens.delete(chatId);
            token = undefined;
            catchingUp = true;
            await rt.sleep(interval, signal);
            continue;
          case "rateLimited":
          case "searchQuota":
            // Polled too soon: wait it out on the same token, no rediscovery.
            await rt.sleep(Math.max(2 * interval, RATE_LIMIT_MIN_MS), signal);
            continue;
          default:
            failures++;
            if (failures >= TRANSIENT_ERROR_AFTER) {
              ctx.status("error", `${failures} chat polls failed in a row`);
            }
            await rt.sleep(backoff, signal);
            backoff = Math.min(backoff * 2, TRANSIENT_MAX_MS);
            continue;
        }
      }

      if (failures >= TRANSIENT_ERROR_AFTER) {
        ctx.status("live", "chat polling recovered");
      }
      failures = 0;
      backoff = TRANSIENT_BASE_MS;

      const page = res.data;
      const items = page.items ?? [];
      const okAt = rt.now();
      // More than the window beyond the planned sleep since the last good
      // page (failures, waits): what this page holds may be old. Measured
      // past `interval`, so a quota-stretched poll isn't mistaken for a gap.
      if (okAt - lastOkAt - interval > BACKLOG_WINDOW_MS) catchingUp = true;
      lastOkAt = okAt;
      const cutoff = catchingUp ? okAt - BACKLOG_WINDOW_MS : null;
      let ended = false;
      for (const { item, backlog } of freshItems(items, cache.seen, cutoff)) {
        emitItem(item, ctx.label, ctx.emitter, { backlog });
        if (item.snippet?.type === "chatEndedEvent") ended = true;
      }
      if (cutoff !== null) {
        // Seen ids count too: a page of old duplicates is still history.
        catchingUp = items.some((it) =>
          Date.parse(it?.snippet?.publishedAt ?? "") < cutoff
        );
      }
      if (page.nextPageToken) {
        token = page.nextPageToken;
        rememberToken(cache, chatId, token);
      }
      if (ended) {
        forgetChat(cache, chatId, rt.now());
        return { why: "ended", detail: "chatEndedEvent" };
      }

      interval = rt.ledger.pollIntervalMs(
        page.pollingIntervalMillis,
        rt.active.size,
        rt.channels.size, // every watched channel needs discovery units
      );
      const now = rt.now();
      let verify = now - lastVerify >= LIVE_VERIFY_MS;
      if (page.offlineAt) {
        // Stream offline: ended for good, or an encoder blip? Ask videos.list
        // now (then at most once a minute) and slow down meanwhile.
        interval = Math.max(interval, OFFLINE_POLL_MIN_MS);
        if (now - lastOfflineCheck >= OFFLINE_VERIFY_EVERY_MS) {
          verify = true;
          lastOfflineCheck = now;
        }
      }
      if (verify) {
        lastVerify = now;
        const v = await verifyChat(ctx, videoId, chatId);
        if (signal?.aborted) break;
        if (v === "quota") return { why: "quota" };
        if (v !== "live") {
          forgetChat(cache, chatId, rt.now());
          return { why: "ended", detail: v };
        }
      }
      await rt.sleep(interval, signal);
    }
  } finally {
    rt.active.delete(ctx.label);
  }
  return { why: "aborted" };
}

/**
 * Watch one channel until `signal` aborts: discover → attach → poll → back to
 * discovery when the chat ends. Exported for tests (startYouTubePoller is the
 * fire-and-forget wrapper). Status changes are emitted only while this
 * generation is current, and each transition is logged with its reason.
 */
export async function pollYouTubeChannel(
  ch: YouTubeChannelConfig,
  key: string,
  emitter: Emitter,
  rt: YouTubeRuntime,
  signal?: AbortSignal,
): Promise<void> {
  const label = youtubeLabel(ch);
  let last: ChannelState | null = null;
  const status = (state: ChannelState, why: string, force = false) => {
    if (signal?.aborted) return; // a torn-down generation stays silent
    if (state === last && !force) return;
    last = state;
    rt.log(
      `[YouTube] ${label}: ${state} — ${why}`,
      state === "error" ? "error" : "info",
    );
    emitter.status("youtube", label, state);
  };
  const ctx: ChannelCtx = {
    ch,
    label,
    key,
    emitter,
    rt,
    cache: channelCache(rt, label),
    signal,
    status,
  };

  // Transient discovery failures in a row, and the back-off before the next.
  let failures = 0;
  let backoff = TRANSIENT_BASE_MS;

  status("connecting", "looking for a live stream");
  while (!signal?.aborted) {
    let wait: number;
    try {
      if (rt.ledger.snapshot().exhausted) {
        const left = msUntilPacificMidnight(rt.now());
        status(
          "error",
          `daily YouTube API quota exhausted — resuming at 00:00 PT (in ${
            formatDuration(left)
          })`,
          true,
        );
        await rt.sleep(
          left + QUOTA_JITTER_MIN_MS + rt.random() * QUOTA_JITTER_SPAN_MS,
          signal,
        );
        if (signal?.aborted) break;
        status("connecting", "new quota day — looking for a live stream");
        continue;
      }

      const d = await discover(ctx);
      if (signal?.aborted) break;
      if (d.kind !== "failed") {
        failures = 0;
        backoff = TRANSIENT_BASE_MS;
      }
      if (d.kind === "live") {
        const end = await pollChat(ctx, d.videoId, d.chatId, d.via);
        if (signal?.aborted || end.why === "aborted") break;
        if (end.why === "quota") continue;
        if (end.why === "denied") {
          status(
            "error",
            `liveChatMessages.list failed (${end.failure.reason}: ${end.failure.message}) — retrying in 10m`,
          );
          wait = DENIED_RETRY_MS;
        } else {
          status(
            "offline",
            `live chat ended (${end.detail}) — rechecking in 30s`,
          );
          wait = RESTART_RECHECK_MS;
        }
      } else if (d.kind === "offline") {
        status(
          "offline",
          d.soon ? "not live yet (a scheduled stream is due)" : "not live",
        );
        wait = d.soon ? UPCOMING_TICK_MS : DISCOVERY_TICK_MS;
      } else {
        if (d.failure.kind === "quotaDaily") continue;
        const what =
          `${d.step} failed (${d.failure.reason}: ${d.failure.message})`;
        if (d.failure.kind === "denied") {
          wait = DENIED_RETRY_MS;
          status("error", `${what} — retrying in 10m`);
        } else {
          // A blip (5xx, timeout, network, rate limit): retry with back-off,
          // and only turn the dot red once it keeps failing.
          wait = backoff;
          backoff = Math.min(backoff * 2, TRANSIENT_MAX_MS);
          if (++failures >= TRANSIENT_ERROR_AFTER) {
            status(
              "error",
              `${what} — ${failures} checks failed in a row, retrying in ${
                wait / 1000
              }s`,
            );
          }
        }
      }
    } catch (e) {
      // A bug must not end the poller for good: report it and retry.
      if (signal?.aborted) break;
      status("error", `unexpected error: ${redactKey(String(e), key)}`);
      wait = ERROR_RETRY_MS;
    }
    await rt.sleep(wait, signal);
    if (signal?.aborted) break;
    if (last === "error") status("connecting", "retrying");
  }
}

// `signal` lets a running poller be torn down so a new one can start with a
// fresh API key (see the runtime-key control plane in main.ts / control.ts).
// When omitted, the poller runs forever, exactly as before. Pass the same
// `runtime` to every generation so the quota ledger, resolved ids, seen
// messages and page tokens carry over; omitted, a fresh one is made.
export function startYouTubePoller(
  config: YouTubeConfig,
  emitter: Emitter,
  signal?: AbortSignal,
  runtime?: YouTubeRuntime,
): void {
  const rt = runtime ?? createYouTubeRuntime({
    dailyQuota: config.dailyQuota,
    budgetHours: config.budgetHours,
  });
  for (const ch of config.channels) {
    pollYouTubeChannel(ch, config.apiKey, emitter, rt, signal).catch((e) =>
      rt.log(`[YouTube] ${youtubeLabel(ch)}: poller stopped: ${e}`, "error")
    );
  }
}

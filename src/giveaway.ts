// Pure helpers for the Twitch-only "!enter" giveaway / prize draw.
//
// Everything here is side-effect-free so the test suite can drive it directly:
// config normalization (from settings.json), command matching, the entrant-pool
// reducers, the eligibility decision, and the loopback control-wire format. The
// stateful engine (follow checks over Helix, chat replies, persistence, SSE
// broadcast) lives in main.ts, matching the project's "pure logic in src/, wiring
// in main.ts" split (see alerts.ts / fake.ts / control.ts).

import type {
  GiveawayCampaignState,
  GiveawayCampaignSummary,
  GiveawayConfig,
  GiveawayEntrant,
  GiveawayMessages,
  GiveawayState,
  GiveawayWinner,
} from "./types.ts";

/** An entrant as supplied by callers — the pool assigns the entry `number`. */
export type GiveawayEntry = Omit<GiveawayEntrant, "number">;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export const DEFAULT_PREFIX = "!";
export const DEFAULT_COMMAND = "enter";

/** Built-in reply templates. `{user}` is substituted with the display name;
 *  the engine also fills `{number}` (entry #), `{remaining}` (guaranteed slots
 *  left) on entry replies, and `{count}`/`{milestone}`/`{draws}` on `milestone`. */
export const DEFAULT_MESSAGES: Required<GiveawayMessages> = {
  entered: "🎉 @{user} you're in — entry #{number}. Good luck!",
  notFollowing: "@{user} you need to follow the channel to enter the giveaway!",
  alreadyEntered: "@{user} you're already entered — good luck!",
  winner: "🎉 Congratulations @{user}, you won the giveaway!",
  enteredPool:
    "@{user} you're in the bonus pool — entry #{number}. Winners are drawn at each follower milestone!",
  milestone: "🎉 {count} new followers! {draws} bonus giveaway draws unlocked!",
};

const MESSAGE_KEYS: readonly (keyof GiveawayMessages)[] = [
  "entered",
  "notFollowing",
  "alreadyEntered",
  "winner",
  "enteredPool",
  "milestone",
];

function normalizeMessages(x: unknown): GiveawayMessages | undefined {
  if (!isObj(x)) return undefined;
  const out: GiveawayMessages = {};
  for (const k of MESSAGE_KEYS) {
    const v = x[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Coerce to a non-negative integer; garbage/negatives fall back. */
function nonneg(x: unknown, fallback: number): number {
  const n = Math.floor(Number(x));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Validate/normalize the raw `giveaway` config from settings.json into a clean
 * `GiveawayConfig`. Missing/garbage input degrades to a disabled default. Booleans
 * default the safe way: `requireFollow`/`replies` are on unless explicitly `false`.
 * Campaign knobs default off (`firstN`/`followerStep` 0) so a config written
 * before they existed behaves exactly as it did.
 */
export function normalizeGiveawayConfig(raw: unknown): GiveawayConfig {
  const o = isObj(raw) ? raw : {};
  const prefix = typeof o.prefix === "string" && o.prefix.trim()
    ? o.prefix.trim()
    : DEFAULT_PREFIX;
  const command = typeof o.command === "string" && o.command.trim()
    ? o.command.trim()
    : DEFAULT_COMMAND;
  const channel = typeof o.channel === "string"
    ? o.channel.trim().toLowerCase()
    : "";
  const config: GiveawayConfig = {
    enabled: o.enabled === true,
    channel,
    prefix,
    command,
    requireFollow: o.requireFollow !== false,
    replies: o.replies !== false,
    firstN: nonneg(o.firstN, 0),
    followerStep: nonneg(o.followerStep, 0),
    milestoneDraws: Math.max(1, nonneg(o.milestoneDraws, 1)),
  };
  const messages = normalizeMessages(o.messages);
  if (messages) config.messages = messages;
  return config;
}

/**
 * True when `content` invokes the giveaway command. Whole-token and
 * case-insensitive: the command must be the first whitespace-delimited token, so
 * "!enter" and "!enter please" match but "!enterprise" does not.
 */
export function matchGiveawayCommand(
  content: string,
  prefix: string,
  command: string,
): boolean {
  const token = `${prefix}${command}`.toLowerCase();
  const first = content.trim().toLowerCase().split(/\s+/)[0];
  return first === token;
}

/** Fill a reply template: `{user}` gets the display name, then each `{key}`
 *  from `vars` (numbers stringified). Unknown placeholders pass through. */
export function giveawayMessage(
  config: GiveawayConfig,
  key: keyof GiveawayMessages,
  user: string,
  vars?: Record<string, string | number>,
): string {
  const tpl = config.messages?.[key] || DEFAULT_MESSAGES[key];
  let out = tpl.replaceAll("{user}", user);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

// ---- Pool model (pure reducers) ------------------------------------------

export function emptyPool(open = true): GiveawayState {
  return { open, entrants: [], nextNumber: 1 };
}

export function hasEntrant(state: GiveawayState, userId: string): boolean {
  return state.entrants.some((e) => e.userId === userId);
}

/** Add an entrant, assigning the next permanent entry number (#1, #2, … —
 *  never reused, even across removals/resets). No-op (added:false) when the
 *  pool is closed or the userId is already present, so callers can treat "not
 *  added" uniformly. */
export function addEntrant(
  state: GiveawayState,
  entry: GiveawayEntry,
): { state: GiveawayState; added: boolean } {
  if (!state.open) return { state, added: false };
  if (hasEntrant(state, entry.userId)) return { state, added: false };
  const entrant: GiveawayEntrant = { ...entry, number: state.nextNumber };
  return {
    state: {
      ...state,
      entrants: [...state.entrants, entrant],
      nextNumber: state.nextNumber + 1,
    },
    added: true,
  };
}

export function removeEntrant(
  state: GiveawayState,
  userId: string,
): GiveawayState {
  return {
    ...state,
    entrants: state.entrants.filter((e) => e.userId !== userId),
  };
}

/** Pick a winner, remove them from the pool, and record them as `lastWinner`.
 *  `rnd` is injectable so tests are deterministic. Empty pool → `winner: null`
 *  (never throws). */
export function drawWinner(
  state: GiveawayState,
  rnd: () => number = Math.random,
): { state: GiveawayState; winner: GiveawayEntrant | null } {
  if (state.entrants.length === 0) return { state, winner: null };
  const idx = Math.min(
    Math.floor(rnd() * state.entrants.length),
    state.entrants.length - 1,
  );
  const winner = state.entrants[idx];
  return {
    state: {
      ...state,
      entrants: state.entrants.filter((e) => e.userId !== winner.userId),
      lastWinner: winner,
    },
    winner,
  };
}

/** Campaign-aware draw. While un-drawn entrants with `number ≤ firstN` remain,
 *  the draw picks among only them (the guaranteed "who's next pack" queue);
 *  once that queue is exhausted it draws from everyone after (the milestone
 *  pool). `reel` is the pre-removal candidate list of the drawn segment, so the
 *  page animates over exactly the names that could have won. With `firstN` 0
 *  this is equivalent to `drawWinner` over the whole pool (segment "pool"). */
export function drawSegmented(
  state: GiveawayState,
  firstN: number,
  rnd: () => number = Math.random,
): {
  state: GiveawayState;
  winner: GiveawayEntrant | null;
  segment: "guaranteed" | "pool";
  reel: GiveawayEntrant[];
} {
  const guaranteed = firstN > 0
    ? state.entrants.filter((e) => e.number <= firstN)
    : [];
  const segment: "guaranteed" | "pool" = guaranteed.length > 0
    ? "guaranteed"
    : "pool";
  const candidates = segment === "guaranteed"
    ? guaranteed
    : firstN > 0
    ? state.entrants.filter((e) => e.number > firstN)
    : state.entrants;
  if (candidates.length === 0) return { state, winner: null, segment, reel: [] };
  const idx = Math.min(
    Math.floor(rnd() * candidates.length),
    candidates.length - 1,
  );
  const winner = candidates[idx];
  return {
    state: {
      ...state,
      entrants: state.entrants.filter((e) => e.userId !== winner.userId),
      lastWinner: winner,
    },
    winner,
    segment,
    reel: candidates,
  };
}

export function openPool(state: GiveawayState): GiveawayState {
  return { ...state, open: true };
}

export function closePool(state: GiveawayState): GiveawayState {
  return { ...state, open: false };
}

/** Clear the entrant list (and any recorded winner); keep the open/closed flag
 *  AND the entry-number counter — numbers are permanent, never reused. */
export function resetPool(state: GiveawayState): GiveawayState {
  return { open: state.open, entrants: [], nextNumber: state.nextNumber };
}

/** A fixed batch of fake entrants for previewing the reel without a live stream
 *  — injected by the loopback "demo" action (the `/giveaway` Demo button and
 *  `multichat giveaway demo`). Ids are stable so re-running dedupes rather than
 *  piling up; `now` stamps enteredAt (pass the real clock at the call site).
 *  16 names so a small `firstN` (e.g. 5) previews both the guaranteed queue and
 *  the milestone pool. */
export function demoEntrants(now = 0): GiveawayEntry[] {
  const names = [
    "PixelPanda",
    "NovaByte",
    "GlitchGremlin",
    "SirLootsalot",
    "QueenBraid",
    "TurboTaco",
    "LurkLord",
    "ConfettiCat",
    "ByteBandit",
    "MangoMage",
    "SofaSamurai",
    "EchoOtter",
    "PogChampette",
    "NoScopeNana",
    "WaffleWizard",
    "DuckOfDoom",
  ];
  return names.map((displayName, i) => ({
    userId: `demo-${i + 1}`,
    login: displayName.toLowerCase(),
    displayName,
    enteredAt: now + i,
  }));
}

/** Stable fake follower ids for previewing milestone progress (deduped by
 *  recordFollower, so re-running demo doesn't double count). */
export function demoFollowerIds(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => `demo-follower-${i + 1}`);
}

/** Validate a persisted pool (best-effort) read back from the state dir. Returns
 *  null for anything unparseable, so a corrupt file starts an empty pool rather
 *  than crashing. Migrates pre-campaign files: entrants without a `number` are
 *  numbered in array order (append order = entry order) and `nextNumber` is
 *  derived, so an old giveaway-pool file loads cleanly. */
export function normalizePoolState(raw: unknown): GiveawayState | null {
  if (!isObj(raw) || !Array.isArray(raw.entrants)) return null;
  const entrants: GiveawayEntrant[] = [];
  for (const e of raw.entrants) {
    const ent = normalizeEntrant(e);
    if (ent) entrants.push(ent);
  }
  // Migration: assign missing numbers (0) in array order, after any real ones.
  let maxNum = 0;
  for (const e of entrants) maxNum = Math.max(maxNum, e.number);
  for (const e of entrants) if (e.number === 0) e.number = ++maxNum;
  const rawNext = typeof raw.nextNumber === "number" &&
      Number.isInteger(raw.nextNumber) && raw.nextNumber >= 1
    ? raw.nextNumber
    : 0;
  const state: GiveawayState = {
    open: raw.open !== false,
    entrants,
    nextNumber: Math.max(rawNext, maxNum + 1),
  };
  const winner = normalizeEntrant(raw.lastWinner);
  if (winner) state.lastWinner = winner;
  return state;
}

function normalizeEntrant(x: unknown): GiveawayEntrant | null {
  if (!isObj(x)) return null;
  const userId = typeof x.userId === "string" ? x.userId : "";
  if (!userId) return null;
  const login = typeof x.login === "string" ? x.login : "";
  return {
    userId,
    login,
    displayName: typeof x.displayName === "string" && x.displayName
      ? x.displayName
      : (login || userId),
    enteredAt: typeof x.enteredAt === "number" ? x.enteredAt : 0,
    // 0 marks "missing" for the migration pass in normalizePoolState.
    number: typeof x.number === "number" && Number.isInteger(x.number) &&
        x.number >= 1
      ? x.number
      : 0,
  };
}

// ---- Campaign bookkeeping (pure reducers) --------------------------------

export function emptyCampaign(): GiveawayCampaignState {
  return {
    followerCount: 0,
    countedFollowerIds: [],
    milestonesReached: 0,
    creditsRemaining: 0,
  };
}

/**
 * Count one new follower (deduped by user id, so an unfollow/re-follow can't
 * double count). Milestones are recomputed as floor(count/step) — robust to a
 * mid-campaign `followerStep` change — and each newly crossed milestone arms
 * `milestoneDraws` advisory draw credits. `milestoneCrossed` is the milestone
 * ordinal just reached (for the announcement), or null.
 */
export function recordFollower(
  campaign: GiveawayCampaignState,
  userId: string,
  cfg: { followerStep: number; milestoneDraws: number },
): {
  campaign: GiveawayCampaignState;
  counted: boolean;
  milestoneCrossed: number | null;
} {
  if (!userId || campaign.countedFollowerIds.includes(userId)) {
    return { campaign, counted: false, milestoneCrossed: null };
  }
  const followerCount = campaign.followerCount + 1;
  let milestonesReached = campaign.milestonesReached;
  let creditsRemaining = campaign.creditsRemaining;
  let milestoneCrossed: number | null = null;
  if (cfg.followerStep > 0) {
    const reached = Math.floor(followerCount / cfg.followerStep);
    const delta = Math.max(0, reached - milestonesReached);
    if (delta > 0) {
      milestonesReached = reached;
      creditsRemaining += delta * Math.max(1, cfg.milestoneDraws);
      milestoneCrossed = reached;
    }
  }
  return {
    campaign: {
      followerCount,
      countedFollowerIds: [...campaign.countedFollowerIds, userId],
      milestonesReached,
      creditsRemaining,
    },
    counted: true,
    milestoneCrossed,
  };
}

/** Validate a persisted campaign state; null on garbage (start fresh). */
export function normalizeCampaignState(
  raw: unknown,
): GiveawayCampaignState | null {
  if (!isObj(raw)) return null;
  const ids = Array.isArray(raw.countedFollowerIds)
    ? raw.countedFollowerIds.filter((x): x is string =>
      typeof x === "string" && x.length > 0
    )
    : [];
  return {
    followerCount: nonneg(raw.followerCount, 0),
    countedFollowerIds: ids,
    milestonesReached: nonneg(raw.milestonesReached, 0),
    creditsRemaining: nonneg(raw.creditsRemaining, 0),
  };
}

/** The tier recorded on a winner: entrants #1..firstN are "guaranteed"; pool
 *  draws are "milestone-K" (the milestone era at draw time) while advisory
 *  credits remain, else "manual". */
export function winnerTier(
  number: number,
  firstN: number,
  creditsRemaining: number,
  milestonesReached: number,
): string {
  if (firstN > 0 && number <= firstN) return "guaranteed";
  if (creditsRemaining > 0) return `milestone-${Math.max(1, milestonesReached)}`;
  return "manual";
}

/** Build the broadcast-sized campaign snapshot attached to each state frame:
 *  counts + the last 10 winners — never the full winners list. */
export function campaignSummary(
  state: GiveawayState,
  campaign: GiveawayCampaignState,
  cfg: { firstN: number },
  winners: GiveawayWinner[],
  followTracking: boolean,
): GiveawayCampaignSummary {
  const firstN = cfg.firstN;
  const guaranteedRemaining = firstN > 0
    ? state.entrants.filter((e) => e.number <= firstN).length
    : 0;
  const poolSize = firstN > 0
    ? state.entrants.filter((e) => e.number > firstN).length
    : state.entrants.length;
  return {
    followerCount: campaign.followerCount,
    milestonesReached: campaign.milestonesReached,
    creditsRemaining: campaign.creditsRemaining,
    guaranteedRemaining,
    poolSize,
    winnersTotal: winners.length,
    recentWinners: winners.slice(-10),
    followTracking,
  };
}

// ---- Winners log (append-only JSONL) -------------------------------------

/** One JSONL line for the durable winners log (mailing list). */
export function serializeWinnerLine(w: GiveawayWinner): string {
  return JSON.stringify(w);
}

function normalizeWinner(x: unknown): GiveawayWinner | null {
  if (!isObj(x)) return null;
  const userId = typeof x.userId === "string" ? x.userId : "";
  if (!userId) return null;
  const login = typeof x.login === "string" ? x.login : "";
  return {
    userId,
    login,
    displayName: typeof x.displayName === "string" && x.displayName
      ? x.displayName
      : (login || userId),
    number: nonneg(x.number, 0),
    enteredAt: typeof x.enteredAt === "number" ? x.enteredAt : 0,
    wonAt: typeof x.wonAt === "number" ? x.wonAt : 0,
    tier: typeof x.tier === "string" && x.tier ? x.tier : "manual",
  };
}

/** Parse a winners JSONL file. Bad/truncated lines (e.g. a crash mid-append)
 *  are skipped, never fatal — the rest of the mailing list still loads. */
export function parseWinnersLog(text: string): GiveawayWinner[] {
  const out: GiveawayWinner[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const w = normalizeWinner(JSON.parse(t));
      if (w) out.push(w);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Winners as CSV (header + RFC-4180 quoting, ISO timestamps) — for mailing. */
export function winnersToCsv(winners: GiveawayWinner[]): string {
  const rows = [
    "number,displayName,login,userId,tier,enteredAt,wonAt",
    ...winners.map((w) =>
      [
        String(w.number),
        csvField(w.displayName),
        csvField(w.login),
        csvField(w.userId),
        csvField(w.tier),
        w.enteredAt ? new Date(w.enteredAt).toISOString() : "",
        w.wonAt ? new Date(w.wonAt).toISOString() : "",
      ].join(",")
    ),
  ];
  return rows.join("\n") + "\n";
}

// ---- Eligibility decision (pure) -----------------------------------------

export interface EligibilitySignals {
  /** true/false from a completed follow check; undefined when it couldn't be run. */
  following?: boolean;
}

export type EligibilityReason = "ok" | "not-following" | "unverifiable";

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
}

/** Decide whether the signals satisfy the requirements. When a follow is required
 *  but couldn't be verified, the result is `unverifiable` (fail-closed — a "must
 *  follow" gate can't grant an unverifiable entry). */
export function decideEligibility(
  requireFollow: boolean,
  signals: EligibilitySignals,
): EligibilityResult {
  if (!requireFollow) return { eligible: true, reason: "ok" };
  if (signals.following === true) return { eligible: true, reason: "ok" };
  if (signals.following === false) {
    return { eligible: false, reason: "not-following" };
  }
  return { eligible: false, reason: "unverifiable" };
}

// ---- Control-wire format (loopback POST /api/giveaway) --------------------

/** One operator action against the running giveaway, in wire form. `winners`
 *  fetches the full winners log; `campaign-reset` zeroes the campaign (counters,
 *  entry numbers, archived winners log) where plain `reset` only clears the
 *  entrant pool. */
export type GiveawayAction =
  | { action: "open" }
  | { action: "close" }
  | { action: "draw" }
  | { action: "reset" }
  | { action: "status" }
  | { action: "demo" }
  | { action: "winners" }
  | { action: "campaign-reset" }
  | { action: "remove"; userId: string };

export type GiveawayParseResult =
  | { ok: true; action: GiveawayAction }
  | { ok: false; message: string };

/** Serialize an action to the JSON body the `/api/giveaway` endpoint expects. */
export function serializeGiveawayAction(action: GiveawayAction): string {
  return JSON.stringify(action);
}

const SIMPLE_ACTIONS: readonly string[] = [
  "open",
  "close",
  "draw",
  "reset",
  "status",
  "demo",
  "winners",
  "campaign-reset",
];

/**
 * Parse and validate a JSON `/api/giveaway` body into a GiveawayAction. The
 * server-side trust boundary: loopback is trusted, but a hand-crafted request
 * still shouldn't push a malformed action through.
 */
export function parseGiveawayAction(raw: string): GiveawayParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, message: "body is not valid JSON" };
  }
  if (!isObj(body)) return { ok: false, message: "body must be a JSON object" };
  const action = body.action;
  if (action === "remove") {
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId) return { ok: false, message: "remove requires a userId" };
    return { ok: true, action: { action: "remove", userId } };
  }
  if (typeof action === "string" && SIMPLE_ACTIONS.includes(action)) {
    return {
      ok: true,
      action: { action } as GiveawayAction,
    };
  }
  return {
    ok: false,
    message: `unknown action "${String(action)}" (use ${
      SIMPLE_ACTIONS.join(", ")
    }, or remove)`,
  };
}

/** A one-line human summary of an action, for the CLI. */
export function describeGiveawayAction(a: GiveawayAction): string {
  switch (a.action) {
    case "remove":
      return `remove entrant ${a.userId}`;
    default:
      return a.action;
  }
}

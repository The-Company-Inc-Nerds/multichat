// Runtime control plane: the small, pure pieces behind setting the YouTube API
// key on a *running* server. The transport (the POST /api/youtube-key route) lives
// in server.ts and the stateful manager (poller restart + persistence) lives in
// main.ts; everything here is side-effect-free so the test suite can drive it
// directly, matching the project's "logic in src/, wiring in main.ts" split.

import type {
  ControlAccess,
  GiveawayEntrant,
  GiveawayPlan,
  GiveawayState,
  GiveawayTurn,
  GiveawayWinner,
  PackReport,
  RedemptionEntry,
  TurnAggregates,
} from "./types.ts";
import type { ReportRow } from "./turns.ts";
import type {
  ChannelPointsStatus,
  RewardsPauseResult,
  RewardsResult,
  RewardSyncReport,
} from "./channelpoints.ts";

/** Result of an attempt to set the runtime YouTube key (returned to the CLI client). */
export interface KeyUpdateResult {
  ok: boolean;
  message: string;
}

/** Operations the loopback POST /api/giveaway route dispatches to. Implemented by
 *  the giveaway engine in main.ts; each mutating op returns the resulting state so
 *  the CLI/page can render it. */
export interface GiveawayHooks {
  getState(): GiveawayState;
  open(): GiveawayState;
  close(): GiveawayState;
  reset(): GiveawayState;
  /** Remove whoever `target` resolves to — a userId, login, display name or
   *  #entry-number. Reports what happened rather than echoing the state either
   *  way: `removed` is null on a miss, and `matches` carries the candidates when
   *  the needle was ambiguous (nothing is removed then). */
  remove(target: string): {
    state: GiveawayState;
    removed: GiveawayEntrant | null;
    matches: GiveawayEntrant[];
  };
  draw(): {
    state: GiveawayState;
    winner: GiveawayEntrant | null;
    segment: "guaranteed" | "pool";
  };
  /** Inject a batch of sample entrants for previewing the reel (loopback demo). */
  demo(): GiveawayState;
  /** The full winners log (the mailing list) — never broadcast, only fetched. */
  winners(): GiveawayWinner[];
  /** Zero the whole campaign: counters, entry numbers, archived winners log.
   *  Distinct from reset(), which only clears the entrant pool. */
  campaignReset(): GiveawayState;
  /** Record a pack-opening summary pushed back by an integration (chat-cards).
   *  Upserts by packId; returns the stored report. Drives POST /api/turn-report. */
  turnReport(report: PackReport): PackReport;
  /** All recorded pack reports (newest opened first) — for the CLI / report. */
  packs(): PackReport[];
  /** The turn ledger + derived disposition aggregates — for the CLI / report. */
  turns(): { turns: GiveawayTurn[]; aggregates: TurnAggregates };
  /** The compiled per-user report (rows + totals + the render timezone). */
  report(): {
    rows: ReportRow[];
    aggregates: TurnAggregates;
    timezone: string;
  };
  /** Build/return the committed seeded draw plan (the pre-picked next-N order).
   *  `count` 0 returns the current plan without rebuilding; `reseed` forces a new
   *  seed. Operator-only (never broadcast). */
  plan(count: number, reseed: boolean): GiveawayPlan | null;
  /** Drop the committed plan — draws go back to fully random. */
  planClear(): GiveawayPlan | null;
}

/** Operations the loopback POST /api/rewards route dispatches to. Implemented by
 *  the channel-points engine in main.ts; most reach Twitch or the overlay, so
 *  they are async. */
export interface ChannelPointsHooks {
  /** Catalogue ↔ reward ids, pause state, overlay health, ledger counts. */
  status(): ChannelPointsStatus;
  /** Create/patch/disable the managed rewards on Twitch to match the catalogue. */
  sync(): Promise<RewardSyncReport>;
  /** Manually pause every managed reward (persisted; wins over auto-pause). */
  pause(): Promise<RewardsPauseResult>;
  /** Clear the manual pause (auto-pause may still hold them paused). */
  resume(): Promise<RewardsPauseResult>;
  /** Open ledger entries: unresolved, or resolved but not yet on Twitch. */
  pending(): RedemptionEntry[];
  /** Resolve an open redemption as a refund ("manual") and withdraw its effect. */
  refund(id: string): Promise<RewardsResult>;
  /** Inject a synthetic `sim-<uuid>` redemption of catalogue `key` through the
   *  whole pipeline (never PATCHed on Twitch). */
  simulate(key: string, user?: string): Promise<RewardsResult>;
}

/** Hooks createServer calls back into. Kept optional so tests can omit them. */
export interface ServerHooks {
  /** Invoked with a validated key when a loopback POST /api/youtube-key arrives. */
  setYouTubeKey?: (key: string) => Promise<KeyUpdateResult>;
  /** Present when a giveaway is enabled; drives the loopback POST /api/giveaway. */
  giveaway?: GiveawayHooks;
  /** Present when channel points are enabled; drives the loopback
   *  POST /api/rewards. */
  channelPoints?: ChannelPointsHooks;
}

/**
 * True when a connection originated locally. The control endpoint is exposed on
 * the same listener as the (unauthenticated) viewer, so when the viewer binds
 * 0.0.0.0 the endpoint must refuse anything that isn't loopback — otherwise the
 * whole LAN could set the API key. Unix-domain peers are inherently local.
 */
export function isLoopbackAddr(addr: Deno.Addr): boolean {
  // Non-IP transports (unix-domain, vsock, …) only carry local peers; narrowing
  // positively on tcp/udp also lets TS see `hostname` below.
  if (addr.transport !== "tcp" && addr.transport !== "udp") return true;
  const host = addr.hostname;
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host.startsWith("127.")
  );
}

/**
 * Extract the API key from a control-request body. Accepts a raw `text/plain`
 * body (the key itself) or a JSON object `{ "key": "..." }`. Returns the trimmed
 * key, or "" when the body is empty / unparseable / missing the field.
 */
export function parseYouTubeKeyBody(
  raw: string,
  contentType: string | null,
): string {
  if ((contentType ?? "").toLowerCase().includes("application/json")) {
    try {
      const obj = JSON.parse(raw) as { key?: unknown };
      return typeof obj?.key === "string" ? obj.key.trim() : "";
    } catch {
      return "";
    }
  }
  return raw.trim();
}

/**
 * Pick the API key to use at startup. A key the operator set at runtime
 * (persisted to disk) is the most recent intent, so it wins over a deploy-time
 * env var, which in turn wins over a static settings.json value. Returns "" when
 * none is set (the server then waits for a runtime key).
 */
export function resolveStartupKey(sources: {
  persisted?: string | null;
  env?: string | null;
  settings?: string | null;
}): string {
  for (const v of [sources.persisted, sources.env, sources.settings]) {
    if (v && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Where the runtime key is persisted: a file inside systemd's StateDirectory
 * ($STATE_DIRECTORY). Returns null when no state dir is provided (e.g. a plain
 * `deno task start`), in which case the key is held in memory only.
 */
export function keyStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/youtube-api-key` : null;
}

/**
 * Where a channel's (rotating) Twitch refresh token is persisted, keyed by
 * broadcaster id so a login rename doesn't orphan it. Returns null with no state
 * dir (the token is then in-memory / from settings only, and won't survive a
 * restart). Mirrors keyStatePath.
 */
export function twitchTokenStatePath(
  stateDir: string | null | undefined,
  broadcasterId: string,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir && broadcasterId ? `${dir}/twitch-refresh-${broadcasterId}` : null;
}

/** Where a login→broadcaster-id resolution is cached, to skip the Helix lookup on
 *  restart. Returns null with no state dir. */
export function twitchBroadcasterStatePath(
  stateDir: string | null | undefined,
  login: string,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir && login
    ? `${dir}/twitch-broadcaster-${login.toLowerCase()}`
    : null;
}

/** Where the giveaway entrant pool is persisted (JSON), so it survives a restart.
 *  Returns null with no state dir (the pool is then in-memory only). Mirrors
 *  keyStatePath. */
export function giveawayPoolStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/giveaway-pool` : null;
}

/** Where the campaign bookkeeping (follower count/dedupe, milestone credits) is
 *  persisted — separate from the pool so a pool reset can't lose it. */
export function giveawayCampaignStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/giveaway-campaign` : null;
}

/** Where winners are recorded, append-only JSONL (one winner per line) — the
 *  durable mailing list. campaign-reset archives it rather than deleting. */
export function giveawayWinnersLogPath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/giveaway-winners` : null;
}

/** Where pack reports pushed back by chat-cards are persisted (a JSON map keyed
 *  by packId, last write wins) — so a restart keeps the cards/values already
 *  reported for the current session. Returns null with no state dir. */
export function giveawayPacksStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/giveaway-packs` : null;
}

/** Where the turn ledger (draw → disposition records) is persisted (a JSON
 *  array, rewritten on change). Returns null with no state dir. */
export function giveawayTurnsStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/giveaway-turns` : null;
}

/** Where the terms-acceptance ledger is persisted (a JSON map keyed by userId).
 *  Returns null with no state dir. */
export function giveawayTermsStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/giveaway-terms` : null;
}

/** Where the committed seeded draw plan is persisted (a JSON object). Returns
 *  null with no state dir. */
export function giveawayPlanStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/giveaway-plan` : null;
}

/** Where the channel-points redemption ledger is persisted (a JSON array keyed
 *  by redemption id) — the only record of points still held, so it must survive
 *  a restart. Returns null with no state dir (in-memory only). */
export function channelPointsLedgerPath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/channelpoints-ledger.json` : null;
}

/** Where the catalogue key → Twitch reward id map is persisted, so a restart
 *  keeps recognising (and managing) the rewards it created. Null with no state
 *  dir. */
export function channelPointsRewardsPath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/channelpoints-rewards.json` : null;
}

/** Where the operator's manual pause is persisted. Null with no state dir. */
export function channelPointsControlPath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/channelpoints-control.json` : null;
}

/** Suffix every atomic-write temp file ends with (see stateTmpPath). */
export const STATE_TMP_SUFFIX = ".tmp";

/**
 * The temp file an atomic write of `path` goes through before its rename. The
 * name is unique per write (`unique` — the caller's pid + counter + random), so
 * two overlapping writes can never share, truncate or rename away each other's
 * file. Same directory as `path`, so the rename is atomic.
 */
export function stateTmpPath(path: string, unique: string): string {
  return `${path}.${unique.replace(/[^A-Za-z0-9_-]/g, "")}${STATE_TMP_SUFFIX}`;
}

/** True when `name` (a bare file name) is a temp file left behind by an
 *  interrupted atomic write of the file named `base`. */
export function isStaleStateTmp(name: string, base: string): boolean {
  return name.startsWith(`${base}.`) && name.endsWith(STATE_TMP_SUFFIX) &&
    name.length > base.length + 1 + STATE_TMP_SUFFIX.length;
}

/** Where a state file that failed to parse is moved aside, so it is kept for
 *  inspection instead of being overwritten by the next (empty) write. */
export function quarantinePath(path: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${path}.corrupt-${stamp}`;
}

// ---- Browser-origin hardening ---------------------------------------------

/**
 * Why a request looks like it came from a web page rather than the CLI, or
 * null when it doesn't. A loopback peer check alone can't tell the operator's
 * `multichat` CLI from a page in a browser on the same host — any site can
 * fire a cross-site "simple" POST at 127.0.0.1. Browsers always stamp such a
 * request with `Origin` (and `Sec-Fetch-Site: cross-site`/`same-site`); Deno's
 * fetch, curl and the CLI send neither. So an endpoint that moves viewers'
 * points or fires effects refuses any `Origin` and any `Sec-Fetch-Site` other
 * than `none` (typed/bookmarked) or `same-origin` (contract §5.5).
 */
export function browserRequestDenied(headers: Headers): string | null {
  if (headers.has("origin")) {
    return "requests from a web page (Origin header) are refused";
  }
  const site = headers.get("sec-fetch-site");
  if (site !== null) {
    const v = site.trim().toLowerCase();
    if (v !== "none" && v !== "same-origin") {
      return `cross-site requests (Sec-Fetch-Site: ${
        v.slice(0, 32)
      }) are refused`;
    }
  }
  return null;
}

// ---- Control-plane access policy -----------------------------------------

/** Coerce a settings.json value to a ControlAccess, defaulting to the safe one. */
export function normalizeControlAccess(raw: unknown): ControlAccess {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "lan" || v === "any" ? v : "loopback";
}

/**
 * True when a connection came from an address that cannot be routed in from the
 * internet — the private and link-local ranges, plus loopback. This is an
 * address check, not authentication: anyone already on the LAN passes it. That
 * is the intent (the giveaway console is meant to be shared with whoever is in
 * the room); pair it with a `controlToken` when the LAN is not trusted.
 */
export function isPrivateAddr(addr: Deno.Addr): boolean {
  if (isLoopbackAddr(addr)) return true;
  if (addr.transport !== "tcp" && addr.transport !== "udp") return true;
  // An IPv4 peer on a dual-stack listener arrives as ::ffff:192.168.1.7.
  const host = addr.hostname.replace(/^::ffff:/i, "").toLowerCase();
  const v4 = host.split(".");
  if (v4.length === 4 && v4.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = v4.map(Number);
    if ([a, b].some((n) => n > 255)) return false;
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // 169.254/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    return false;
  }
  // IPv6: unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
}

/** Why a control request was refused, or `null` when it may proceed. */
export interface ControlDenial {
  status: number;
  message: string;
}

/**
 * Decide whether a control request is allowed. Loopback is always allowed (the
 * CLI and the host's own browser must keep working, and a token there would be
 * pure friction). Everything else must clear the configured `access` mode and,
 * when a `token` is configured, present it.
 *
 * Returns null to allow, or the denial to render.
 */
export function checkControlAccess(opts: {
  addr: Deno.Addr;
  access: ControlAccess;
  /** Configured shared secret; "" (the default) means no token is required. */
  token: string;
  /** Token the request presented (bearer header, ?token=, or cookie). */
  presented: string;
  /** Endpoint name, for the error text (e.g. "giveaway"). */
  endpoint: string;
}): ControlDenial | null {
  if (isLoopbackAddr(opts.addr)) return null;
  if (opts.access === "loopback") {
    return {
      status: 403,
      message:
        `Forbidden: the ${opts.endpoint} endpoint is loopback-only. Set ` +
        `server.controlAccess to "lan" to allow the local network.`,
    };
  }
  if (opts.access === "lan" && !isPrivateAddr(opts.addr)) {
    return {
      status: 403,
      message: `Forbidden: the ${opts.endpoint} endpoint is limited to the ` +
        `local network (server.controlAccess = "lan").`,
    };
  }
  if (opts.token && !timingSafeEqual(opts.presented, opts.token)) {
    return {
      status: 403,
      message: `Forbidden: bad or missing control token. Open the page as ` +
        `/giveaway?token=… once and it is remembered.`,
    };
  }
  return null;
}

/** Length-independent-ish constant-time compare (mirrors server.ts's safeEqual,
 *  kept here so the policy is testable without the HTTP layer). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- State directory ------------------------------------------------------

/**
 * Where persistent state lives, resolved from the environment.
 *
 * systemd's `StateDirectory` wins when present (the NixOS service), so a managed
 * deployment keeps writing to /var/lib/multichat. Outside systemd we no longer
 * fall back to "nothing": a `deno task start` on a streaming PC should still
 * keep its entrant pool, winners log and turn ledger across a reboot. The XDG
 * state dir is the right home for that — not the working tree, which is where
 * `git clean` and rebuilds happen.
 *
 * `env` is injected so this stays pure and testable.
 */
export function resolveStateDir(
  env: (name: string) => string | undefined,
): string | null {
  const trim = (v: string | undefined) => (v ?? "").trim().replace(/\/+$/, "");
  const systemd = trim(env("STATE_DIRECTORY"));
  if (systemd) return systemd;
  const explicit = trim(env("MULTICHAT_STATE_DIR"));
  if (explicit) return explicit;
  const xdg = trim(env("XDG_STATE_HOME"));
  if (xdg) return `${xdg}/multichat`;
  const home = trim(env("HOME"));
  if (home) return `${home}/.local/state/multichat`;
  return null; // no writable home — in-memory only, as before
}

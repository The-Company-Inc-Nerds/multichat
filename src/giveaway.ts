// Pure helpers for the Twitch-only "!enter" giveaway / prize draw.
//
// Everything here is side-effect-free so the test suite can drive it directly:
// config normalization (from settings.json), command matching, the entrant-pool
// reducers, the eligibility decision, and the loopback control-wire format. The
// stateful engine (follow checks over Helix, chat replies, persistence, SSE
// broadcast) lives in main.ts, matching the project's "pure logic in src/, wiring
// in main.ts" split (see alerts.ts / fake.ts / control.ts).

import type {
  GiveawayConfig,
  GiveawayEntrant,
  GiveawayMessages,
  GiveawayState,
} from "./types.ts";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export const DEFAULT_PREFIX = "!";
export const DEFAULT_COMMAND = "enter";

/** Built-in reply templates. `{user}` is substituted with the display name. */
export const DEFAULT_MESSAGES: Required<GiveawayMessages> = {
  entered: "🎉 @{user} you're entered in the giveaway — good luck!",
  notFollowing: "@{user} you need to follow the channel to enter the giveaway!",
  alreadyEntered: "@{user} you're already entered — good luck!",
  winner: "🎉 Congratulations @{user}, you won the giveaway!",
};

const MESSAGE_KEYS: readonly (keyof GiveawayMessages)[] = [
  "entered",
  "notFollowing",
  "alreadyEntered",
  "winner",
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

/**
 * Validate/normalize the raw `giveaway` config from settings.json into a clean
 * `GiveawayConfig`. Missing/garbage input degrades to a disabled default. Booleans
 * default the safe way: `requireFollow`/`replies` are on unless explicitly `false`.
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

/** Fill a reply template's `{user}` placeholder with the display name. */
export function giveawayMessage(
  config: GiveawayConfig,
  key: keyof GiveawayMessages,
  user: string,
): string {
  const tpl = config.messages?.[key] || DEFAULT_MESSAGES[key];
  return tpl.replaceAll("{user}", user);
}

// ---- Pool model (pure reducers) ------------------------------------------

export function emptyPool(open = true): GiveawayState {
  return { open, entrants: [] };
}

export function hasEntrant(state: GiveawayState, userId: string): boolean {
  return state.entrants.some((e) => e.userId === userId);
}

/** Add an entrant. No-op (added:false) when the pool is closed or the userId is
 *  already present, so callers can treat "not added" uniformly. */
export function addEntrant(
  state: GiveawayState,
  entrant: GiveawayEntrant,
): { state: GiveawayState; added: boolean } {
  if (!state.open) return { state, added: false };
  if (hasEntrant(state, entrant.userId)) return { state, added: false };
  return {
    state: { ...state, entrants: [...state.entrants, entrant] },
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
      open: state.open,
      entrants: state.entrants.filter((e) => e.userId !== winner.userId),
      lastWinner: winner,
    },
    winner,
  };
}

export function openPool(state: GiveawayState): GiveawayState {
  return { ...state, open: true };
}

export function closePool(state: GiveawayState): GiveawayState {
  return { ...state, open: false };
}

/** Clear the entrant list (and any recorded winner); keep the open/closed flag. */
export function resetPool(state: GiveawayState): GiveawayState {
  return { open: state.open, entrants: [] };
}

/** A fixed batch of fake entrants for previewing the reel without a live stream
 *  — injected by the loopback "demo" action (the `/giveaway` Demo button and
 *  `multichat giveaway demo`). Ids are stable so re-running dedupes rather than
 *  piling up; `now` stamps enteredAt (pass the real clock at the call site). */
export function demoEntrants(now = 0): GiveawayEntrant[] {
  const names = [
    "PixelPanda",
    "NovaByte",
    "GlitchGremlin",
    "SirLootsalot",
    "QueenBraid",
    "TurboTaco",
    "LurkLord",
    "ConfettiCat",
  ];
  return names.map((displayName, i) => ({
    userId: `demo-${i + 1}`,
    login: displayName.toLowerCase(),
    displayName,
    enteredAt: now + i,
  }));
}

/** Validate a persisted pool (best-effort) read back from the state dir. Returns
 *  null for anything unparseable, so a corrupt file starts an empty pool rather
 *  than crashing. */
export function normalizePoolState(raw: unknown): GiveawayState | null {
  if (!isObj(raw) || !Array.isArray(raw.entrants)) return null;
  const entrants: GiveawayEntrant[] = [];
  for (const e of raw.entrants) {
    const ent = normalizeEntrant(e);
    if (ent) entrants.push(ent);
  }
  const state: GiveawayState = { open: raw.open !== false, entrants };
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
  };
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

/** One operator action against the running giveaway, in wire form. */
export type GiveawayAction =
  | { action: "open" }
  | { action: "close" }
  | { action: "draw" }
  | { action: "reset" }
  | { action: "status" }
  | { action: "demo" }
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

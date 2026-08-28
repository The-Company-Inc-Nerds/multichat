// Pure helpers for the giveaway "turn" lifecycle: the terms-acceptance ledger
// that `!enter` gates on, the winner-turn disposition commands
// (mail/donate/destroy/pass), the turn records themselves, and the campaign-wide
// disposition aggregates derived from turns + pack reports.
//
// Side-effect-free so the test suite drives it directly; the stateful wiring
// (persistence, chat replies, auto-advance draw on pass) lives in main.ts, and
// the config lives in giveaway.ts — the project's "pure logic in src/, wiring in
// main.ts" split.

import type {
  DispositionTotal,
  GiveawayDisposition,
  GiveawayDispositionConfig,
  GiveawayEntrant,
  GiveawayTurn,
  PackReport,
  TermsAcceptance,
  TurnAggregates,
} from "./types.ts";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

// ---- Disposition command matching ----------------------------------------

const DISPOSITIONS: readonly GiveawayDisposition[] = [
  "mail",
  "donate",
  "destroy",
  "pass",
];

/**
 * Match a winner-turn disposition command. The configured word may be typed bare
 * (`mail`) or with the giveaway prefix (`!mail`), and only the first token counts
 * — so "pass it on" matches `pass`. Returns the disposition, or null. Gating to
 * the current winner is the caller's job.
 */
export function matchDisposition(
  text: string,
  prefix: string,
  cfg: GiveawayDispositionConfig,
): GiveawayDisposition | null {
  if (!cfg.enabled) return null;
  const first = text.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const p = prefix.toLowerCase();
  const bare = p && first.startsWith(p) ? first.slice(p.length) : first;
  if (!bare) return null;
  const words: [string, GiveawayDisposition][] = [
    [cfg.mail.toLowerCase(), "mail"],
    [cfg.donate.toLowerCase(), "donate"],
    [cfg.destroy.toLowerCase(), "destroy"],
    [cfg.pass.toLowerCase(), "pass"],
  ];
  for (const [word, disp] of words) if (word && bare === word) return disp;
  return null;
}

// ---- Terms-acceptance ledger (pure reducers) -----------------------------

/** True when this user has a current (matching-version) acceptance on file. A
 *  bumped `version` invalidates an older acceptance, forcing a re-accept. */
export function hasAccepted(
  ledger: Record<string, TermsAcceptance>,
  userId: string,
  version: string,
): boolean {
  const e = ledger[userId];
  return !!e && e.version === version;
}

/** Record (or refresh) a user's acceptance. `changed` is false when they already
 *  had a current acceptance, so the caller can skip a redundant persist/reply. */
export function recordAcceptance(
  ledger: Record<string, TermsAcceptance>,
  who: { userId: string; login: string; displayName: string },
  version: string,
  now: number,
): { ledger: Record<string, TermsAcceptance>; changed: boolean } {
  if (hasAccepted(ledger, who.userId, version)) {
    return { ledger, changed: false };
  }
  return {
    ledger: {
      ...ledger,
      [who.userId]: {
        userId: who.userId,
        login: who.login,
        displayName: who.displayName,
        acceptedAt: now,
        version,
      },
    },
    changed: true,
  };
}

function normalizeAcceptance(x: unknown): TermsAcceptance | null {
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
    acceptedAt: typeof x.acceptedAt === "number" ? x.acceptedAt : 0,
    version: typeof x.version === "string" ? x.version : "",
  };
}

/** Validate a persisted terms ledger (userId → acceptance). Bad entries dropped. */
export function normalizeTermsLedger(
  raw: unknown,
): Record<string, TermsAcceptance> {
  const out: Record<string, TermsAcceptance> = {};
  if (!isObj(raw)) return out;
  for (const v of Object.values(raw)) {
    const a = normalizeAcceptance(v);
    if (a) out[a.userId] = a;
  }
  return out;
}

export function serializeTermsLedger(
  ledger: Record<string, TermsAcceptance>,
): string {
  return JSON.stringify(ledger);
}

// ---- Turn records (pure reducers) ----------------------------------------

/** Open a new turn for a freshly-drawn winner. `carriedFromTurnId` links a turn
 *  that received a `pass`. */
export function newTurn(opts: {
  id: string;
  winner: GiveawayEntrant;
  tier: string;
  now: number;
  carriedFromTurnId?: string;
}): GiveawayTurn {
  const t: GiveawayTurn = {
    id: opts.id,
    userId: opts.winner.userId,
    login: opts.winner.login,
    displayName: opts.winner.displayName,
    number: opts.winner.number,
    tier: opts.tier,
    startedAt: opts.now,
  };
  if (opts.carriedFromTurnId) t.carriedFromTurnId = opts.carriedFromTurnId;
  return t;
}

/** Stamp a disposition on a turn (and end it). Returns the updated list and the
 *  updated turn (null if the id wasn't found). */
export function recordTurnDisposition(
  turns: GiveawayTurn[],
  turnId: string,
  disposition: GiveawayDisposition,
  now: number,
): { turns: GiveawayTurn[]; turn: GiveawayTurn | null } {
  let updated: GiveawayTurn | null = null;
  const out = turns.map((t) => {
    if (t.id !== turnId) return t;
    updated = { ...t, disposition, dispositionAt: now, endedAt: now };
    return updated;
  });
  return { turns: out, turn: updated };
}

/** The current in-progress turn: the most recent one not yet ended, or undefined. */
export function activeTurn(turns: GiveawayTurn[]): GiveawayTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (!turns[i].endedAt) return turns[i];
  }
  return undefined;
}

export function findTurn(
  turns: GiveawayTurn[],
  turnId: string,
): GiveawayTurn | undefined {
  return turns.find((t) => t.id === turnId);
}

function normalizeTurn(x: unknown): GiveawayTurn | null {
  if (!isObj(x)) return null;
  const id = typeof x.id === "string" ? x.id : "";
  const userId = typeof x.userId === "string" ? x.userId : "";
  if (!id || !userId) return null;
  const login = typeof x.login === "string" ? x.login : "";
  const t: GiveawayTurn = {
    id,
    userId,
    login,
    displayName: typeof x.displayName === "string" && x.displayName
      ? x.displayName
      : (login || userId),
    number: typeof x.number === "number" && Number.isInteger(x.number)
      ? x.number
      : 0,
    tier: typeof x.tier === "string" && x.tier ? x.tier : "manual",
    startedAt: typeof x.startedAt === "number" ? x.startedAt : 0,
  };
  if (typeof x.endedAt === "number") t.endedAt = x.endedAt;
  if (
    typeof x.disposition === "string" &&
    (DISPOSITIONS as readonly string[]).includes(x.disposition)
  ) {
    t.disposition = x.disposition as GiveawayDisposition;
  }
  if (typeof x.dispositionAt === "number") t.dispositionAt = x.dispositionAt;
  if (typeof x.carriedFromTurnId === "string" && x.carriedFromTurnId) {
    t.carriedFromTurnId = x.carriedFromTurnId;
  }
  return t;
}

/** Validate a persisted turn ledger (an array). Bad entries dropped. */
export function normalizeTurns(raw: unknown): GiveawayTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: GiveawayTurn[] = [];
  for (const x of raw) {
    const t = normalizeTurn(x);
    if (t) out.push(t);
  }
  return out;
}

export function serializeTurns(turns: GiveawayTurn[]): string {
  return JSON.stringify(turns);
}

// ---- Disposition aggregates (derived from turns + pack reports) ----------

/** Group pack reports by their `ref` (the turn id they belong to). */
function packsByRef(
  packReports: Record<string, PackReport>,
): Record<string, PackReport[]> {
  const out: Record<string, PackReport[]> = {};
  for (const p of Object.values(packReports)) {
    if (!p.ref) continue;
    (out[p.ref] ??= []).push(p);
  }
  return out;
}

/**
 * Every pack report that ultimately belongs to `turnId` — its own, plus (walking
 * `carriedFromTurnId`) the packs of every turn that passed into it. So the final
 * mailer/donator/destroyer of a pass chain is credited the whole haul. The `seen`
 * set guards against a malformed cyclic chain.
 */
export function turnPacks(
  turnId: string,
  turnsById: Record<string, GiveawayTurn>,
  byRef: Record<string, PackReport[]>,
  seen: Set<string> = new Set(),
): PackReport[] {
  if (seen.has(turnId)) return [];
  seen.add(turnId);
  const own = byRef[turnId] ?? [];
  const turn = turnsById[turnId];
  if (turn?.carriedFromTurnId) {
    return own.concat(
      turnPacks(turn.carriedFromTurnId, turnsById, byRef, seen),
    );
  }
  return own;
}

function addPacks(total: DispositionTotal, packs: PackReport[]): void {
  total.turns += 1;
  for (const p of packs) {
    total.cards += p.cardCount;
    total.value += p.totalValue;
  }
}

/** One turn's card/value tally, folding in any packs passed to it. Used for the
 *  disposition chat reply and the compiled report. */
export function turnTotals(
  turnId: string,
  turns: GiveawayTurn[],
  packReports: Record<string, PackReport>,
): { cards: number; value: number; packs: PackReport[] } {
  const turnsById: Record<string, GiveawayTurn> = {};
  for (const t of turns) turnsById[t.id] = t;
  const packs = turnPacks(turnId, turnsById, packsByRef(packReports));
  let cards = 0;
  let value = 0;
  for (const p of packs) {
    cards += p.cardCount;
    value += p.totalValue;
  }
  return { cards, value: Math.round(value * 100) / 100, packs };
}

/**
 * Campaign-wide disposition totals. mail/donate/destroy fold in any cards passed
 * to them (via the carry chain), so their totals reflect where cards physically
 * ended up. `passed` counts the pass actions and the cards forfeited at each (an
 * informational tally — those same cards are also credited to the terminal
 * disposition that eventually received them).
 */
export function computeAggregates(
  turns: GiveawayTurn[],
  packReports: Record<string, PackReport>,
): TurnAggregates {
  const turnsById: Record<string, GiveawayTurn> = {};
  for (const t of turns) turnsById[t.id] = t;
  const byRef = packsByRef(packReports);
  const zero = (): DispositionTotal => ({ turns: 0, cards: 0, value: 0 });
  const agg: TurnAggregates = {
    mailed: zero(),
    donated: zero(),
    destroyed: zero(),
    passed: zero(),
  };
  for (const t of turns) {
    if (!t.disposition) continue;
    if (t.disposition === "pass") {
      addPacks(agg.passed, byRef[t.id] ?? []);
      continue;
    }
    const key = t.disposition === "mail"
      ? "mailed"
      : t.disposition === "donate"
      ? "donated"
      : "destroyed";
    addPacks(agg[key], turnPacks(t.id, turnsById, byRef));
  }
  for (const k of Object.keys(agg) as (keyof TurnAggregates)[]) {
    agg[k].value = Math.round(agg[k].value * 100) / 100;
  }
  return agg;
}

// ---- Compiled per-user report --------------------------------------------

/** One row of the compiled report — a single winner's turn. */
export interface ReportRow {
  number: number;
  displayName: string;
  login: string;
  userId: string;
  tier: string;
  startedAt: number;
  startedLocal: string;
  disposition: string;
  cardCount: number;
  totalValue: number;
  cardNames: string[];
  /** displayName that passed cards into this turn (a pass chain), if any. */
  carriedFrom?: string;
  /** displayName this turn passed its cards to, if it chose `pass`. */
  passedTo?: string;
}

/** Format an epoch-ms instant in an IANA timezone, e.g.
 *  "Aug 27, 2026, 20:45:31 MST". Falls back to ISO on an unknown zone. */
export function formatInZone(ms: number, timeZone: string): string {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Build the per-turn compiled report: who won, when their turn started (in the
 * configured timezone), what they pulled in their own pack, and what they chose.
 * Carry links (carriedFrom / passedTo) trace pass chains; the campaign totals
 * (computeAggregates) fold those chains for the summary.
 */
export function buildTurnReport(
  turns: GiveawayTurn[],
  packReports: Record<string, PackReport>,
  timeZone: string,
): ReportRow[] {
  const byRef = packsByRef(packReports);
  const byId: Record<string, GiveawayTurn> = {};
  for (const t of turns) byId[t.id] = t;
  const passedToOf: Record<string, string> = {};
  for (const t of turns) {
    if (t.carriedFromTurnId) passedToOf[t.carriedFromTurnId] = t.displayName;
  }
  return turns.map((t) => {
    const own = byRef[t.id] ?? [];
    let cardCount = 0;
    let value = 0;
    const cardNames: string[] = [];
    for (const p of own) {
      cardCount += p.cardCount;
      value += p.totalValue;
      for (const c of p.cards) cardNames.push(c.name || "?");
    }
    const row: ReportRow = {
      number: t.number,
      displayName: t.displayName,
      login: t.login,
      userId: t.userId,
      tier: t.tier,
      startedAt: t.startedAt,
      startedLocal: formatInZone(t.startedAt, timeZone),
      disposition: t.disposition ?? "",
      cardCount,
      totalValue: Math.round(value * 100) / 100,
      cardNames,
    };
    if (t.carriedFromTurnId && byId[t.carriedFromTurnId]) {
      row.carriedFrom = byId[t.carriedFromTurnId].displayName;
    }
    if (passedToOf[t.id]) row.passedTo = passedToOf[t.id];
    return row;
  });
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** The compiled report as CSV (header + RFC-4180 quoting, ISO + local times). */
export function reportToCsv(rows: ReportRow[]): string {
  const header =
    "number,displayName,login,userId,tier,startedAt,startedLocal,disposition,cardCount,totalValue,cards,carriedFrom,passedTo";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        String(r.number),
        csvField(r.displayName),
        csvField(r.login),
        csvField(r.userId),
        csvField(r.tier),
        r.startedAt ? new Date(r.startedAt).toISOString() : "",
        csvField(r.startedLocal),
        csvField(r.disposition),
        String(r.cardCount),
        r.totalValue.toFixed(2),
        csvField(r.cardNames.join("; ")),
        csvField(r.carriedFrom ?? ""),
        csvField(r.passedTo ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// Pure helpers for the outbound integration bus (giveaway lifecycle → external
// tools) and the inbound pack-report parser (external tools → giveaway ledger).
//
// Everything here is side-effect-free so the test suite can drive it directly:
// config normalization (from settings.json), event→request mapping per adapter,
// and the pack-report wire format. The fetch wiring lives in main.ts and the
// POST /api/turn-report route in server.ts — the project's "pure logic in src/,
// wiring in main.ts" split (see giveaway.ts / alerts.ts / control.ts).

import type {
  IntegrationsConfig,
  IntegrationSubscriber,
  PackCardSummary,
  PackReport,
} from "./types.ts";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x ? x : undefined;
}

function num(x: unknown, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/** The giveaway-lifecycle events multichat can push to subscribers. These are
 *  stable wire strings — an external tool matches on them, so don't rename. */
export type IntegrationEventType =
  | "giveaway.turn.start"
  | "giveaway.turn.disposition"
  | "giveaway.turn.end"
  | "giveaway.entrant.added"
  | "giveaway.terms.accepted";

export const INTEGRATION_EVENT_TYPES: readonly IntegrationEventType[] = [
  "giveaway.turn.start",
  "giveaway.turn.disposition",
  "giveaway.turn.end",
  "giveaway.entrant.added",
  "giveaway.terms.accepted",
];

/** One event on the bus: a stable `type`, an epoch-ms `ts`, and a type-specific
 *  `data` bag (kept loose so new events need no shared schema change). */
export interface IntegrationEvent {
  type: IntegrationEventType;
  ts: number;
  data: Record<string, unknown>;
}

const ADAPTERS: readonly string[] = ["webhook", "chat-cards"];

function normalizeSubscriber(raw: unknown): IntegrationSubscriber | null {
  if (!isObj(raw)) return null;
  const baseUrl = typeof raw.baseUrl === "string"
    ? raw.baseUrl.trim().replace(/\/+$/, "")
    : "";
  if (!baseUrl) return null; // a subscriber with nowhere to send is dropped
  const adapter =
    typeof raw.adapter === "string" && ADAPTERS.includes(raw.adapter)
      ? (raw.adapter as "webhook" | "chat-cards")
      : "webhook";
  const events = Array.isArray(raw.events)
    ? raw.events.filter((e): e is string =>
      typeof e === "string" && e.trim().length > 0
    )
    : [];
  const sub: IntegrationSubscriber = {
    name: typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : adapter,
    adapter,
    baseUrl,
    events: events.length ? events : ["*"], // no/blank list = everything
    enabled: raw.enabled !== false, // default on unless explicitly false
  };
  const token = str(raw.token);
  if (token) sub.token = token.trim();
  if (
    typeof raw.packSize === "number" && Number.isFinite(raw.packSize) &&
    raw.packSize > 0
  ) {
    sub.packSize = Math.floor(raw.packSize);
  }
  return sub;
}

/**
 * Validate/normalize the `integrations` config from settings.json. Garbage
 * degrades to an empty subscriber list (feature off), never a throw. Subscribers
 * without a `baseUrl` are dropped (nowhere to deliver).
 */
export function normalizeIntegrationsConfig(raw: unknown): IntegrationsConfig {
  const o = isObj(raw) ? raw : {};
  const subs: IntegrationSubscriber[] = [];
  if (Array.isArray(o.subscribers)) {
    for (const s of o.subscribers) {
      const sub = normalizeSubscriber(s);
      if (sub) subs.push(sub);
    }
  }
  const cfg: IntegrationsConfig = { subscribers: subs };
  const token = str(o.callbackToken);
  if (token) cfg.callbackToken = token.trim();
  return cfg;
}

/** True when a subscriber should receive this event type (`"*"` = all). A
 *  disabled subscriber wants nothing. */
export function subscriberWantsEvent(
  sub: IntegrationSubscriber,
  type: string,
): boolean {
  return sub.enabled && (sub.events.includes("*") || sub.events.includes(type));
}

/** One outbound HTTP request an adapter wants made (the caller performs it). */
export interface OutboundRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function bearer(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Map an event to the HTTP request(s) an adapter makes for it. Pure — the caller
 * (main.ts) performs the fetch. Returns [] when the adapter has nothing to do
 * for this event, so irrelevant events are silently skipped. The "webhook"
 * adapter forwards a stable envelope for every event; the "chat-cards" adapter
 * only maps the events that correspond to a chat-cards API call.
 */
export function buildIntegrationRequests(
  sub: IntegrationSubscriber,
  ev: IntegrationEvent,
): OutboundRequest[] {
  if (sub.adapter === "chat-cards") return chatCardsRequests(sub, ev);
  return [{
    url: sub.baseUrl,
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(sub.token) },
    body: JSON.stringify({ event: ev.type, ts: ev.ts, data: ev.data }),
  }];
}

function chatCardsRequests(
  sub: IntegrationSubscriber,
  ev: IntegrationEvent,
): OutboundRequest[] {
  // A new turn opens a pack in chat-cards named for the drawn winner. `ref` (the
  // winner's userId / a turn id) rides along so the pack report can be correlated
  // back to the turn. Other events don't (yet) map to a chat-cards call.
  if (ev.type === "giveaway.turn.start") {
    const d = ev.data;
    const body: Record<string, unknown> = { winner: str(d.winner) ?? "" };
    const ref = str(d.ref);
    if (ref) body.ref = ref;
    const label = str(d.label);
    if (label) body.label = label;
    if (sub.packSize) body.size = sub.packSize;
    return [{
      url: `${sub.baseUrl}/api/pack`,
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(sub.token) },
      body: JSON.stringify(body),
    }];
  }
  return [];
}

// ---- Inbound pack reports (chat-cards → POST /api/turn-report) ------------

function normalizeCard(x: unknown): PackCardSummary | null {
  if (!isObj(x)) return null;
  const card: PackCardSummary = {
    name: typeof x.name === "string" ? x.name : "",
    value: Math.round(num(x.value, 0) * 100) / 100,
  };
  const number = str(x.number);
  if (number) card.number = number;
  const set = str(x.set);
  if (set) card.set = set;
  const rarity = str(x.rarity);
  if (rarity) card.rarity = rarity;
  const image = str(x.image);
  if (image) card.image = image;
  return card;
}

export type TurnReportParseResult =
  | { ok: true; report: PackReport }
  | { ok: false; message: string };

/**
 * Parse/validate a pack report pushed back by chat-cards. `packId` is required
 * (the upsert key); everything else defaults defensively so a partial report
 * still records. `receivedAt` is stamped by the caller so the parser stays pure.
 */
export function parseTurnReport(
  raw: string,
  receivedAt: number,
): TurnReportParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, message: "body is not valid JSON" };
  }
  if (!isObj(body)) return { ok: false, message: "body must be a JSON object" };
  const packId = typeof body.packId === "string" ? body.packId.trim() : "";
  if (!packId) return { ok: false, message: "packId is required" };

  const cards: PackCardSummary[] = [];
  if (Array.isArray(body.cards)) {
    for (const c of body.cards) {
      const card = normalizeCard(c);
      if (card) cards.push(card);
    }
  }
  const report: PackReport = {
    packId,
    openedAt: num(body.openedAt, 0),
    totalValue: Math.round(num(body.totalValue, 0) * 100) / 100,
    cardCount:
      typeof body.cardCount === "number" && Number.isFinite(body.cardCount)
        ? Math.max(0, Math.floor(body.cardCount))
        : cards.length,
    cards,
    receivedAt,
  };
  const ref = str(body.ref);
  if (ref) report.ref = ref;
  const winner = str(body.winner);
  if (winner) report.winner = winner;
  const label = str(body.label);
  if (label) report.label = label;
  if (typeof body.index === "number" && Number.isFinite(body.index)) {
    report.index = Math.floor(body.index);
  }
  if (typeof body.size === "number" && Number.isFinite(body.size)) {
    report.size = Math.floor(body.size);
  }
  if (typeof body.closedAt === "number" && body.closedAt > 0) {
    report.closedAt = body.closedAt;
  }
  return { ok: true, report };
}

/** Serialize the packId→report map for the state file. */
export function serializePackReports(
  reports: Record<string, PackReport>,
): string {
  return JSON.stringify(reports);
}

/** Validate a persisted pack-reports map read back from the state dir. Non-fatal:
 *  bad entries are dropped, garbage yields an empty map (so a corrupt file starts
 *  fresh rather than crashing). */
export function normalizePackReports(raw: unknown): Record<string, PackReport> {
  const out: Record<string, PackReport> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!isObj(v)) continue;
    const parsed = parseTurnReport(JSON.stringify(v), num(v.receivedAt, 0));
    if (parsed.ok) out[k] = parsed.report;
  }
  return out;
}

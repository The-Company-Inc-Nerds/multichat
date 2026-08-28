import {
  buildIntegrationRequests,
  type IntegrationEvent,
  normalizeIntegrationsConfig,
  normalizePackReports,
  parseTurnReport,
  serializePackReports,
  subscriberWantsEvent,
} from "../src/integrations.ts";
import type { IntegrationSubscriber, PackReport } from "../src/types.ts";
import { assert, assertEquals } from "./_assert.ts";

const sub = (
  over: Partial<IntegrationSubscriber> = {},
): IntegrationSubscriber => ({
  name: "chat-cards",
  adapter: "chat-cards",
  baseUrl: "http://127.0.0.1:8787",
  events: ["*"],
  enabled: true,
  ...over,
});

const startEvent = (data: Record<string, unknown>): IntegrationEvent => ({
  type: "giveaway.turn.start",
  ts: 1000,
  data,
});

Deno.test("normalizeIntegrationsConfig: defaults, drops junk, keeps token", () => {
  assertEquals(normalizeIntegrationsConfig(undefined), { subscribers: [] });
  assertEquals(normalizeIntegrationsConfig("nope"), { subscribers: [] });

  const cfg = normalizeIntegrationsConfig({
    callbackToken: "  secret ",
    subscribers: [
      // full chat-cards subscriber, trailing slash trimmed
      {
        name: "cc",
        adapter: "chat-cards",
        baseUrl: "http://127.0.0.1:8787/",
        token: " t ",
        events: ["giveaway.turn.start"],
        packSize: 5.9,
      },
      // minimal: adapter defaults to webhook, events to ["*"], enabled true
      { baseUrl: "http://example.test/hook" },
      // dropped: no baseUrl
      { name: "nowhere", adapter: "webhook" },
    ],
  });
  assertEquals(cfg.callbackToken, "secret");
  assertEquals(cfg.subscribers.length, 2);
  assertEquals(cfg.subscribers[0], {
    name: "cc",
    adapter: "chat-cards",
    baseUrl: "http://127.0.0.1:8787",
    events: ["giveaway.turn.start"],
    enabled: true,
    token: "t",
    packSize: 5, // floored
  });
  assertEquals(cfg.subscribers[1], {
    name: "webhook",
    adapter: "webhook",
    baseUrl: "http://example.test/hook",
    events: ["*"],
    enabled: true,
  });
});

Deno.test("normalizeIntegrationsConfig: enabled=false honored, bad adapter → webhook", () => {
  const cfg = normalizeIntegrationsConfig({
    subscribers: [
      { baseUrl: "http://x.test", enabled: false, adapter: "carrier-pigeon" },
    ],
  });
  assertEquals(cfg.subscribers[0].enabled, false);
  assertEquals(cfg.subscribers[0].adapter, "webhook");
});

Deno.test("subscriberWantsEvent: wildcard, explicit list, disabled", () => {
  assert(subscriberWantsEvent(sub({ events: ["*"] }), "giveaway.turn.start"));
  assert(
    subscriberWantsEvent(
      sub({ events: ["giveaway.turn.start"] }),
      "giveaway.turn.start",
    ),
  );
  assert(
    !subscriberWantsEvent(
      sub({ events: ["giveaway.turn.end"] }),
      "giveaway.turn.start",
    ),
  );
  // A disabled subscriber wants nothing, even with a wildcard.
  assert(!subscriberWantsEvent(sub({ enabled: false }), "giveaway.turn.start"));
});

Deno.test("buildIntegrationRequests: chat-cards turn.start → POST /api/pack", () => {
  const reqs = buildIntegrationRequests(
    sub({ token: "tok", packSize: 5 }),
    startEvent({ winner: "Ann", ref: "42", login: "ann", number: 3 }),
  );
  assertEquals(reqs.length, 1);
  const r = reqs[0];
  assertEquals(r.url, "http://127.0.0.1:8787/api/pack");
  assertEquals(r.method, "POST");
  assertEquals(r.headers["authorization"], "Bearer tok");
  assertEquals(r.headers["content-type"], "application/json");
  assertEquals(JSON.parse(r.body!), { winner: "Ann", ref: "42", size: 5 });
});

Deno.test("buildIntegrationRequests: chat-cards omits size/ref when unset", () => {
  const reqs = buildIntegrationRequests(
    sub({ token: undefined }),
    startEvent({ winner: "Bo" }),
  );
  assertEquals(JSON.parse(reqs[0].body!), { winner: "Bo" });
  assertEquals(reqs[0].headers["authorization"], undefined);
});

Deno.test("buildIntegrationRequests: chat-cards ignores unmapped events", () => {
  const reqs = buildIntegrationRequests(sub(), {
    type: "giveaway.turn.end",
    ts: 1,
    data: { winner: "Ann" },
  });
  assertEquals(reqs, []);
});

Deno.test("buildIntegrationRequests: webhook forwards a stable envelope", () => {
  const reqs = buildIntegrationRequests(
    sub({
      adapter: "webhook",
      baseUrl: "http://example.test/hook",
      token: "wt",
    }),
    startEvent({ winner: "Ann", ref: "42" }),
  );
  assertEquals(reqs.length, 1);
  assertEquals(reqs[0].url, "http://example.test/hook");
  assertEquals(reqs[0].headers["authorization"], "Bearer wt");
  assertEquals(JSON.parse(reqs[0].body!), {
    event: "giveaway.turn.start",
    ts: 1000,
    data: { winner: "Ann", ref: "42" },
  });
});

Deno.test("parseTurnReport: valid report, defaults, card + total rounding", () => {
  const r = parseTurnReport(
    JSON.stringify({
      packId: "  p1 ",
      ref: "42",
      winner: "Ann",
      label: "seat 3",
      index: 3.4,
      size: 5,
      openedAt: 1700000000000,
      closedAt: 1700000100000,
      totalValue: 12.345,
      cards: [
        {
          name: "Charizard",
          number: "4/102",
          set: "Base",
          rarity: "Rare Holo",
          value: 12.344,
          image: "/img",
        },
        { name: "Energy", value: 0.1 },
        "junk",
      ],
    }),
    999,
  );
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.report.packId, "p1"); // trimmed
  assertEquals(r.report.index, 3); // floored
  assertEquals(r.report.totalValue, 12.35); // rounded to cents
  assertEquals(r.report.closedAt, 1700000100000);
  assertEquals(r.report.receivedAt, 999);
  assertEquals(r.report.cardCount, 2); // defaulted from card count (junk dropped)
  assertEquals(r.report.cards[0], {
    name: "Charizard",
    value: 12.34,
    number: "4/102",
    set: "Base",
    rarity: "Rare Holo",
    image: "/img",
  });
  assertEquals(r.report.cards[1], { name: "Energy", value: 0.1 });
});

Deno.test("parseTurnReport: explicit cardCount kept, open pack has no closedAt", () => {
  const r = parseTurnReport(
    JSON.stringify({
      packId: "p",
      cardCount: 5,
      cards: [],
      openedAt: 1,
      closedAt: 0,
    }),
    1,
  );
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.report.cardCount, 5);
    assertEquals(r.report.closedAt, undefined); // 0 = still open
  }
});

Deno.test("parseTurnReport: rejects bad JSON, non-object, missing packId", () => {
  assert(!parseTurnReport("not json", 0).ok);
  assert(!parseTurnReport("[]", 0).ok);
  assert(!parseTurnReport("{}", 0).ok);
  assert(!parseTurnReport(JSON.stringify({ packId: "  " }), 0).ok);
});

Deno.test("normalizePackReports: round-trips, drops garbage entries", () => {
  const rep: PackReport = {
    packId: "p1",
    ref: "42",
    winner: "Ann",
    openedAt: 100,
    totalValue: 9.5,
    cardCount: 1,
    cards: [{ name: "Pikachu", value: 9.5 }],
    receivedAt: 7,
  };
  const serialized = serializePackReports({
    p1: rep,
    bad: "nope" as unknown as PackReport,
  });
  const restored = normalizePackReports(JSON.parse(serialized));
  assertEquals(Object.keys(restored), ["p1"]);
  assertEquals(restored.p1.packId, "p1");
  assertEquals(restored.p1.receivedAt, 7);
  assertEquals(restored.p1.cards[0], { name: "Pikachu", value: 9.5 });

  assertEquals(normalizePackReports("garbage"), {});
});

import {
  classifyFrame,
  getKeepaliveSeconds,
  getNotification,
  getReconnectUrl,
  getSessionId,
  handleNotification,
  mapCheer,
  mapFollow,
  mapRaid,
  mapSubGift,
  mapSubMessage,
  mapSubscribe,
  subTierLabel,
} from "../src/eventsub.ts";
import { fakeEmitter } from "./_fake.ts";
import { assert, assertEquals } from "./_assert.ts";

Deno.test("mapFollow: 'X followed'", () => {
  const m = mapFollow({ user_name: "Alice" }, "chan", "id1");
  assertEquals(m.kind, "follow");
  assertEquals(m.author, "Alice");
  assertEquals(m.eventText, "Alice followed");
  assertEquals(m.platform, "twitch");
  assertEquals(m.channel, "chan");
  assertEquals(m.id, "id1");
});

Deno.test("mapCheer: amount + tier accent, anonymous fallback", () => {
  const m = mapCheer({ user_name: "Bob", bits: 1000 }, "chan", "id");
  assertEquals(m.kind, "cheer");
  assertEquals(m.amount, "1000 bits");
  assertEquals(m.accentColor, "#00b173"); // 1000-bit tier (matches IRC cheerColor)
  assertEquals(m.eventText, "Bob cheered 1000 bits");

  const anon = mapCheer(
    { is_anonymous: true, user_name: null, bits: 50 },
    "c",
    "i",
  );
  assertEquals(anon.author, "Anonymous");
  assertEquals(anon.eventText, "Anonymous cheered 50 bits");
});

Deno.test("mapSubscribe: new sub with tier; gifted sub emits nothing", () => {
  const m = mapSubscribe({ user_name: "Cara", tier: "2000" }, "chan", "id");
  assert(m !== null);
  assertEquals(m!.kind, "sub");
  assertEquals(m!.eventText, "Cara subscribed (Tier 2)");

  // A gifted channel.subscribe is covered by channel.subscription.gift → skip.
  assertEquals(
    mapSubscribe({ user_name: "Dan", tier: "1000", is_gift: true }, "c", "i"),
    null,
  );
});

Deno.test("mapSubGift: pluralized total + tier, anonymous gifter", () => {
  const m = mapSubGift(
    { user_name: "Eve", total: 5, sub_tier: "1000" },
    "c",
    "i",
  );
  assertEquals(m.kind, "sub");
  assertEquals(m.amount, "5 subs");
  assertEquals(m.eventText, "Eve gifted 5 Tier 1 subs");

  const one = mapSubGift(
    { user_name: "Eve", total: 1, sub_tier: "1000" },
    "c",
    "i",
  );
  assertEquals(one.amount, "1 sub");
  assertEquals(one.eventText, "Eve gifted 1 Tier 1 sub");

  const anon = mapSubGift(
    { is_anonymous: true, total: 2, sub_tier: "3000" },
    "c",
    "i",
  );
  assertEquals(anon.author, "Anonymous");
  assertEquals(anon.eventText, "Anonymous gifted 2 Tier 3 subs");
});

Deno.test("mapSubMessage: resub carries months + the user's message", () => {
  const m = mapSubMessage(
    {
      user_name: "Finn",
      cumulative_months: 12,
      tier: "1000",
      message: { text: "love it" },
    },
    "chan",
    "id",
  );
  assertEquals(m.kind, "sub");
  assertEquals(m.eventText, "Finn resubscribed for 12 months (Tier 1)");
  assertEquals(m.content, "love it");
});

Deno.test("mapRaid: from-broadcaster + viewer count", () => {
  const m = mapRaid(
    { from_broadcaster_user_name: "BigStreamer", viewers: 250 },
    "chan",
    "id",
  );
  assertEquals(m.kind, "raid");
  assertEquals(m.amount, "250 viewers");
  assertEquals(m.eventText, "BigStreamer is raiding with 250 viewers");
});

Deno.test("subTierLabel: maps 1000/2000/3000, defaults to Tier 1", () => {
  assertEquals(subTierLabel("1000"), "Tier 1");
  assertEquals(subTierLabel("2000"), "Tier 2");
  assertEquals(subTierLabel("3000"), "Tier 3");
  assertEquals(subTierLabel(undefined), "Tier 1");
});

Deno.test("handleNotification: emits for known types, false for unknown", () => {
  const e = fakeEmitter();
  assertEquals(
    handleNotification("channel.follow", { user_name: "A" }, "chan", "id", e),
    true,
  );
  assertEquals(e.captured.messages.length, 1);
  assertEquals(e.captured.messages[0].kind, "follow");

  // A gifted subscribe is "handled" (true) but emits nothing.
  assertEquals(
    handleNotification(
      "channel.subscribe",
      { user_name: "B", is_gift: true },
      "chan",
      "id2",
      e,
    ),
    true,
  );
  assertEquals(e.captured.messages.length, 1);

  assertEquals(
    handleNotification("channel.unknown", {}, "chan", "id3", e),
    false,
  );
});

Deno.test("classifyFrame: maps message_type to a frame kind", () => {
  assertEquals(
    classifyFrame({ metadata: { message_type: "session_welcome" } }),
    "welcome",
  );
  assertEquals(
    classifyFrame({ metadata: { message_type: "session_keepalive" } }),
    "keepalive",
  );
  assertEquals(
    classifyFrame({ metadata: { message_type: "notification" } }),
    "notification",
  );
  assertEquals(
    classifyFrame({ metadata: { message_type: "session_reconnect" } }),
    "reconnect",
  );
  assertEquals(
    classifyFrame({ metadata: { message_type: "revocation" } }),
    "revocation",
  );
  assertEquals(
    classifyFrame({ metadata: { message_type: "whatever" } }),
    "unknown",
  );
  assertEquals(classifyFrame({}), "unknown");
});

Deno.test("session-field extractors read welcome/reconnect frames", () => {
  const welcome = {
    metadata: { message_type: "session_welcome" },
    payload: { session: { id: "sess-42", keepalive_timeout_seconds: 30 } },
  };
  assertEquals(getSessionId(welcome), "sess-42");
  assertEquals(getKeepaliveSeconds(welcome), 30);

  const reconnect = {
    metadata: { message_type: "session_reconnect" },
    payload: { session: { id: "s", reconnect_url: "wss://new.example/ws" } },
  };
  assertEquals(getReconnectUrl(reconnect), "wss://new.example/ws");
});

Deno.test("getNotification: pulls type, event, and a stable id", () => {
  const n = getNotification({
    metadata: {
      message_type: "notification",
      message_id: "msg-1",
      subscription_type: "channel.cheer",
    },
    payload: { event: { bits: 100, user_name: "Z" } },
  });
  assert(n !== null);
  assertEquals(n!.type, "channel.cheer");
  assertEquals(n!.id, "msg-1");
  assertEquals(n!.event.bits, 100);

  assertEquals(
    getNotification({ metadata: { message_type: "notification" } }),
    null,
  );
});

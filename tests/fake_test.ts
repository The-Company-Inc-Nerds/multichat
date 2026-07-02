import {
  demoActions,
  describeFakeAction,
  type FakeAction,
  parseFakeAction,
  serializeFakeAction,
} from "../src/fake.ts";
import { assert, assertEquals } from "./_assert.ts";

// Recursively sort object keys so equality is by content, not key order — the
// stringify-based assertEquals shim is order-sensitive, but wire JSON is not.
function canon(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    const src = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canon(src[k]);
    return out;
  }
  return x;
}

Deno.test("demoActions: covers every kind and both platforms", () => {
  const actions = demoActions(1000);
  assert(actions.length >= 12, "expected a rich showcase");

  // Every message kind should appear at least once.
  const kinds = new Set(
    actions
      .filter((a): a is Extract<FakeAction, { action: "message" }> =>
        a.action === "message"
      )
      .map((a) => a.data.kind),
  );
  for (
    const k of [
      "chat",
      "action",
      "cheer",
      "sub",
      "raid",
      "superchat",
      "supersticker",
      "membership",
      "system",
    ]
  ) {
    assert(kinds.has(k as never), `demo is missing kind: ${k}`);
  }

  // Both platforms, a status change, and a live deletion are all exercised.
  assert(actions.some((a) => a.action === "status"), "no status event");
  assert(actions.some((a) => a.action === "delete"), "no delete event");
  const platforms = new Set(
    actions.map((a) =>
      a.action === "status"
        ? a.data.platform
        : (a.data as { platform: string }).platform
    ),
  );
  assert(platforms.has("twitch") && platforms.has("youtube"), "both platforms");
});

Deno.test("demoActions: the delete targets a message actually shown", () => {
  const actions = demoActions(1000);
  const del = actions.find((a) => a.action === "delete");
  assert(del && del.action === "delete");
  const id = del.data.messageId;
  assert(id, "delete should target a message id");
  const target = actions.some((a) =>
    a.action === "message" && a.data.id === id
  );
  assert(target, "delete targets a message id that was emitted earlier");
});

Deno.test("demoActions: deterministic ids/timestamps from `now`", () => {
  const a = demoActions(42);
  const msg = a.find((x) => x.action === "message");
  assert(msg && msg.action === "message");
  assertEquals(msg.data.timestamp, 42);
  assert(msg.data.id.includes("42"), "id should be seeded from now");
});

Deno.test("round-trip: parse(serialize(x)) === x for every demo action", () => {
  for (const action of demoActions(7)) {
    const parsed = parseFakeAction(serializeFakeAction(action));
    assert(parsed.ok, "demo actions must be valid");
    assertEquals(canon(parsed.action), canon(action));
  }
});

Deno.test("parseFakeAction: valid message with defaults filled", () => {
  const r = parseFakeAction(
    JSON.stringify({
      action: "message",
      data: { platform: "twitch", channel: "c", author: "A" },
    }),
  );
  assert(r.ok);
  assert(r.action.action === "message");
  assertEquals(r.action.data.content, "");
  assertEquals(r.action.data.timestamp, 0);
  assert(r.action.data.id.length > 0);
});

Deno.test("parseFakeAction: delete keeps exactly one targeting field", () => {
  const byId = parseFakeAction(
    JSON.stringify({
      action: "delete",
      data: { platform: "twitch", channel: "c", messageId: "m1" },
    }),
  );
  assert(byId.ok && byId.action.action === "delete");
  assertEquals(byId.action.data.messageId, "m1");

  // messageId wins over author when both are present.
  const both = parseFakeAction(
    JSON.stringify({
      action: "delete",
      data: { platform: "twitch", channel: "c", messageId: "m1", author: "A" },
    }),
  );
  assert(both.ok && both.action.action === "delete");
  assertEquals(both.action.data.messageId, "m1");
  assertEquals(both.action.data.author, undefined);
});

Deno.test("parseFakeAction: status validates the state enum", () => {
  const ok = parseFakeAction(
    JSON.stringify({
      action: "status",
      data: { platform: "youtube", name: "@x", state: "live" },
    }),
  );
  assert(ok.ok);
  const bad = parseFakeAction(
    JSON.stringify({
      action: "status",
      data: { platform: "youtube", name: "@x", state: "sleeping" },
    }),
  );
  assert(!bad.ok);
});

Deno.test("parseFakeAction: rejects malformed bodies with a matching reason", () => {
  // [label, body, token the rejection reason must mention] — covers the first
  // guard (non-object data) and each field guard of message / delete / status,
  // and asserts the *reason*, since that string is surfaced to the operator.
  const M = (data: unknown) => JSON.stringify({ action: "message", data });
  const D = (data: unknown) => JSON.stringify({ action: "delete", data });
  const S = (data: unknown) => JSON.stringify({ action: "status", data });
  const cases: Array<[string, string, string]> = [
    ["not json", "{{{", "JSON"],
    ["non-object body", "42", "object"],
    [
      "unknown action",
      JSON.stringify({ action: "explode", data: {} }),
      "unknown action",
    ],
    // message
    ["message: non-object data", M(42), "object"],
    [
      "message: bad platform",
      M({ platform: "discord", channel: "c", author: "A" }),
      "platform",
    ],
    [
      "message: missing channel",
      M({ platform: "twitch", author: "A" }),
      "channel",
    ],
    [
      "message: missing author",
      M({ platform: "twitch", channel: "c" }),
      "author",
    ],
    [
      "message: bad kind",
      M({ platform: "twitch", channel: "c", author: "A", kind: "nope" }),
      "kind",
    ],
    // delete
    ["delete: non-object data", D(42), "object"],
    [
      "delete: bad platform",
      D({ platform: "discord", channel: "c" }),
      "platform",
    ],
    ["delete: missing channel", D({ platform: "twitch" }), "channel"],
    // status
    ["status: non-object data", S(42), "object"],
    [
      "status: bad platform",
      S({ platform: "discord", name: "x", state: "live" }),
      "platform",
    ],
    ["status: missing name", S({ platform: "twitch", state: "live" }), "name"],
    [
      "status: bad state",
      S({ platform: "twitch", name: "x", state: "sleeping" }),
      "state",
    ],
  ];
  for (const [label, body, token] of cases) {
    const r = parseFakeAction(body);
    assert(!r.ok, `should reject: ${label}`);
    assert(
      !r.ok && r.message.includes(token),
      `reject reason for "${label}" should mention "${token}", got: ${
        !r.ok ? r.message : ""
      }`,
    );
  }
});

Deno.test("parseFakeAction: keeps valid segments and badges, drops junk", () => {
  const r = parseFakeAction(
    JSON.stringify({
      action: "message",
      data: {
        platform: "twitch",
        channel: "c",
        author: "A",
        badges: [{ id: "moderator" }, { nope: 1 }],
        segments: [
          { type: "text", text: "hi " },
          { type: "emote", url: "http://x/e.png", alt: "E" },
          { type: "bogus" },
        ],
      },
    }),
  );
  assert(r.ok && r.action.action === "message");
  assertEquals(r.action.data.badges, [{ id: "moderator", label: "moderator" }]);
  assertEquals(r.action.data.segments, [
    { type: "text", text: "hi " },
    { type: "emote", url: "http://x/e.png", alt: "E" },
  ]);
});

Deno.test("describeFakeAction: one-line summaries per action", () => {
  const [twStatus] = demoActions(0);
  assert(describeFakeAction(twStatus).startsWith("set twitch"));

  const del: FakeAction = {
    action: "delete",
    data: { platform: "twitch", channel: "c", messageId: "m" },
  };
  assertEquals(describeFakeAction(del), "delete message m in #c");

  const clear: FakeAction = {
    action: "delete",
    data: { platform: "twitch", channel: "c" },
  };
  assertEquals(describeFakeAction(clear), "clear all messages in #c");

  // A YouTube handle already starts with "@" — it must not get a second "#".
  const yt: FakeAction = {
    action: "message",
    data: {
      id: "y1",
      platform: "youtube",
      channel: "@demo_yt",
      author: "Viewer",
      content: "hi",
      timestamp: 0,
    },
  };
  assertEquals(describeFakeAction(yt), "youtube chat from Viewer in @demo_yt");
});

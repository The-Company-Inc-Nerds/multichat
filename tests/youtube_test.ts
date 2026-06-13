import {
  buildBadges,
  type ChatItem,
  emitItem,
  QuotaError,
  tierColor,
  ytGet,
} from "../src/youtube.ts";
import { fakeEmitter } from "./_fake.ts";
import { assert, assertEquals } from "./_assert.ts";

// Swap globalThis.fetch for a canned Response, run fn, then restore.
async function withFetch(
  response: Response,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(response);
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function item(
  snippet: Partial<ChatItem["snippet"]>,
  author: Partial<ChatItem["authorDetails"]> = {},
): ChatItem {
  return {
    id: "msg-1",
    snippet: {
      type: "textMessageEvent",
      publishedAt: "2024-01-01T00:00:00Z",
      ...snippet,
    },
    authorDetails: { displayName: "Viewer", ...author },
  };
}

Deno.test("tierColor maps tiers 1..7 and clamps out-of-range", () => {
  assertEquals(tierColor(1), "#1565C0");
  assertEquals(tierColor(7), "#E62117");
  assertEquals(tierColor(undefined), "#1565C0"); // defaults to tier 1
  assertEquals(tierColor(99), "#E62117"); // clamps high
  assertEquals(tierColor(0), "#1565C0"); // clamps low
});

Deno.test("buildBadges maps author flags to role badges", () => {
  const badges = buildBadges({
    displayName: "X",
    isChatOwner: true,
    isChatSponsor: true,
    isVerified: true,
  });
  assertEquals(badges.map((b) => b.id), ["owner", "member", "verified"]);
});

Deno.test("emitItem: textMessageEvent emits a plain chat message", () => {
  const e = fakeEmitter();
  emitItem(
    item({ type: "textMessageEvent", displayMessage: "hello" }),
    "@chan",
    e,
  );
  const m = e.captured.messages[0];
  assertEquals(m.kind, "chat");
  assertEquals(m.platform, "youtube");
  assertEquals(m.channel, "@chan");
  assertEquals(m.content, "hello");
});

Deno.test("emitItem: superChatEvent carries amount, accent color and comment", () => {
  const e = fakeEmitter();
  emitItem(
    item({
      type: "superChatEvent",
      superChatDetails: {
        amountDisplayString: "$5.00",
        userComment: "great stream",
        tier: 3,
      },
    }),
    "@chan",
    e,
  );
  const m = e.captured.messages[0];
  assertEquals(m.kind, "superchat");
  assertEquals(m.amount, "$5.00");
  assertEquals(m.accentColor, "#00BFA5"); // tier 3
  assertEquals(m.content, "great stream");
});

Deno.test("emitItem: superStickerEvent uses the sticker alt text", () => {
  const e = fakeEmitter();
  emitItem(
    item({
      type: "superStickerEvent",
      superStickerDetails: {
        amountDisplayString: "$2.00",
        tier: 1,
        superStickerMetadata: { altText: "waving cat" },
      },
    }),
    "@chan",
    e,
  );
  const m = e.captured.messages[0];
  assertEquals(m.kind, "supersticker");
  assertEquals(m.content, "waving cat");
});

Deno.test("emitItem: newSponsorEvent is a membership event", () => {
  const e = fakeEmitter();
  emitItem(
    item({
      type: "newSponsorEvent",
      newSponsorDetails: { memberLevelName: "Gold" },
    }, { displayName: "Pat" }),
    "@chan",
    e,
  );
  const m = e.captured.messages[0];
  assertEquals(m.kind, "membership");
  assertEquals(m.eventText, "Pat became a member (Gold)");
});

Deno.test("emitItem: messageDeletedEvent emits a delete, not a message", () => {
  const e = fakeEmitter();
  emitItem(
    item({
      type: "messageDeletedEvent",
      messageDeletedDetails: { deletedMessageId: "gone-1" },
    }),
    "@chan",
    e,
  );
  assertEquals(e.captured.messages.length, 0);
  assertEquals(e.captured.deletes, [{
    platform: "youtube",
    channel: "@chan",
    messageId: "gone-1",
  }]);
});

Deno.test("emitItem: unknown event types are ignored", () => {
  const e = fakeEmitter();
  emitItem(item({ type: "sponsorOnlyModeStartedEvent" }), "@chan", e);
  assertEquals(e.captured.messages.length, 0);
  assertEquals(e.captured.deletes.length, 0);
});

Deno.test("ytGet: parses a successful response", async () => {
  await withFetch(
    new Response(JSON.stringify({ items: [{ id: "x" }] }), { status: 200 }),
    async () => {
      const d = await ytGet<{ items: { id: string }[] }>("http://test");
      assertEquals(d?.items[0].id, "x");
    },
  );
});

Deno.test("ytGet: throws QuotaError on a 403 quota body", async () => {
  await withFetch(
    new Response('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', {
      status: 403,
    }),
    async () => {
      let caught: unknown;
      try {
        await ytGet("http://test");
      } catch (e) {
        caught = e;
      }
      assert(caught instanceof QuotaError, "expected QuotaError");
    },
  );
});

Deno.test("ytGet: returns null on a transient (non-quota) error", async () => {
  await withFetch(new Response("upstream boom", { status: 500 }), async () => {
    assertEquals(await ytGet("http://test"), null);
  });
});

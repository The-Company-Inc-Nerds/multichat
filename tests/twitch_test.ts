import {
  buildSegments,
  handleCommand,
  parseBadges,
  parseEmoteTag,
  parseIRC,
  parseTags,
  subPlanTier,
  type TwitchChatMessage,
  unescapeTag,
} from "../src/twitch.ts";
import { fakeEmitter } from "./_fake.ts";
import { assert, assertEquals, assertExists } from "./_assert.ts";

const SOH = String.fromCharCode(1); // \x01, the ACTION wrapper byte

Deno.test("parseTags splits key=value pairs and bare flags", () => {
  const tags = parseTags("display-name=Foo;mod=1;flag");
  assertEquals(tags["display-name"], "Foo");
  assertEquals(tags["mod"], "1");
  assertEquals(tags["flag"], "");
});

Deno.test("unescapeTag decodes IRCv3 escapes", () => {
  assertEquals(
    unescapeTag("Foo\\ssubscribed\\sfor\\s3\\smonths"),
    "Foo subscribed for 3 months",
  );
  assertEquals(unescapeTag("a\\:b\\\\c"), "a;b\\c");
});

Deno.test("parseIRC extracts tags, prefix, command, params", () => {
  const line =
    "@display-name=Foo;color=#FF0000 :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hello world";
  const msg = parseIRC(line);
  assertExists(msg);
  assertEquals(msg.command, "PRIVMSG");
  assertEquals(msg.tags["display-name"], "Foo");
  assertEquals(msg.params[0], "#chan");
  assertEquals(msg.params[1], "hello world");
});

Deno.test("handleCommand: PRIVMSG invokes onMessage with raw identity", () => {
  const line =
    "@display-name=Ann;user-id=1001;badges=subscriber/3 :ann!ann@ann.tmi.twitch.tv PRIVMSG #chan :!enter please";
  const msg = parseIRC(line);
  assertExists(msg);
  const em = fakeEmitter();
  const seen: TwitchChatMessage[] = [];
  handleCommand(msg, em, undefined, (m) => seen.push(m));
  assertEquals(seen.length, 1);
  const got = seen[0];
  assertEquals(got.channel, "chan");
  assertEquals(got.userId, "1001");
  assertEquals(got.login, "ann");
  assertEquals(got.displayName, "Ann");
  assertEquals(got.text, "!enter please");
  assertEquals(got.badges.map((b) => b.id), ["subscriber"]);
  // The message still renders through the normal emitter path.
  assertEquals(em.captured.messages.length, 1);
});

Deno.test("handleCommand: PRIVMSG without onMessage is a no-op (back-compat)", () => {
  const msg = parseIRC(":ann!ann@ann.tmi.twitch.tv PRIVMSG #chan :hi");
  assertExists(msg);
  const em = fakeEmitter();
  handleCommand(msg, em); // no onMessage arg — must not throw
  assertEquals(em.captured.messages.length, 1);
});

Deno.test("parseBadges maps known ids to friendly labels", () => {
  const badges = parseBadges("broadcaster/1,subscriber/12,vip/1,someunknown/1");
  assertEquals(badges.map((b) => b.id), [
    "broadcaster",
    "subscriber",
    "vip",
    "someunknown",
  ]);
  assertEquals(badges[0].label, "Broadcaster");
  assertEquals(badges[1].label, "Sub");
  assertEquals(badges[3].label, "someunknown"); // unknown ids fall back to the raw id
});

Deno.test("parseEmoteTag returns spans sorted by start", () => {
  const spans = parseEmoteTag("25:0-4,12-16/1902:6-10");
  assertEquals(spans.map((s) => [s.start, s.end, s.id]), [
    [0, 4, "25"],
    [6, 10, "1902"],
    [12, 16, "25"],
  ]);
});

Deno.test("buildSegments interleaves text and emote images", () => {
  const segs = buildSegments("Kappa Keepo Kappa", "25:0-4,12-16/1902:6-10");
  assertExists(segs);
  assertEquals(segs, [
    {
      type: "emote",
      url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0",
      alt: "Kappa",
    },
    { type: "text", text: " " },
    {
      type: "emote",
      url: "https://static-cdn.jtvnw.net/emoticons/v2/1902/default/dark/1.0",
      alt: "Keepo",
    },
    { type: "text", text: " " },
    {
      type: "emote",
      url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0",
      alt: "Kappa",
    },
  ]);
});

Deno.test("buildSegments uses codepoint offsets, not UTF-16 units", () => {
  // 🎉 is one codepoint at index 0; Kappa occupies 1-5.
  const segs = buildSegments("🎉Kappa", "25:1-5");
  assertExists(segs);
  assertEquals(segs[0], { type: "text", text: "🎉" });
  assertEquals(segs[1].type, "emote");
  assertEquals((segs[1] as { alt: string }).alt, "Kappa");
});

Deno.test("buildSegments returns undefined without an emotes tag", () => {
  assertEquals(buildSegments("hello world", ""), undefined);
});

Deno.test("handleCommand: normal PRIVMSG emits a chat message", () => {
  const e = fakeEmitter();
  const msg = parseIRC(
    "@id=abc;display-name=Foo;color=#00FF00;badges=subscriber/1 :foo!foo@x PRIVMSG #chan :hi there",
  )!;
  assertEquals(handleCommand(msg, e), true);
  assertEquals(e.captured.messages.length, 1);
  const m = e.captured.messages[0];
  assertEquals(m.id, "abc");
  assertEquals(m.kind, "chat");
  assertEquals(m.author, "Foo");
  assertEquals(m.authorColor, "#00FF00");
  assertEquals(m.content, "hi there");
  assertEquals(m.badges?.[0].id, "subscriber");
});

Deno.test("handleCommand: /me action strips the wrapper and sets kind", () => {
  const e = fakeEmitter();
  const msg = parseIRC(
    `@id=a;display-name=Foo :foo!foo@x PRIVMSG #chan :${SOH}ACTION waves${SOH}`,
  )!;
  handleCommand(msg, e);
  const m = e.captured.messages[0];
  assertEquals(m.kind, "action");
  assertEquals(m.content, "waves");
});

Deno.test("handleCommand: bits make a cheer with amount and accent", () => {
  const e = fakeEmitter();
  const msg = parseIRC(
    "@id=a;display-name=Foo;bits=1000 :foo!foo@x PRIVMSG #chan :cheer1000 go",
  )!;
  handleCommand(msg, e);
  const m = e.captured.messages[0];
  assertEquals(m.kind, "cheer");
  assertEquals(m.amount, "1000 bits");
  assertEquals(m.quantity, 1000);
  assertEquals(m.accentColor, "#00b173"); // 1000-bit tier
  assert(m.eventText?.includes("1000 bits") ?? false);
});

Deno.test("handleCommand: USERNOTICE resub becomes a sub event", () => {
  const e = fakeEmitter();
  const msg = parseIRC(
    "@msg-id=resub;display-name=Foo;system-msg=Foo\\ssubscribed\\sfor\\s3\\smonths! USERNOTICE #chan :love the stream",
  )!;
  handleCommand(msg, e);
  const m = e.captured.messages[0];
  assertEquals(m.kind, "sub");
  assertEquals(m.eventText, "Foo subscribed for 3 months!");
  assertEquals(m.content, "love the stream");
  assertEquals(m.sub, { tier: 1, variant: "resub" }); // no sub-plan tag → Tier 1
});

Deno.test("handleCommand: USERNOTICE subs carry structured tier/variant detail", () => {
  const e = fakeEmitter();
  handleCommand(
    parseIRC(
      "@msg-id=sub;display-name=Foo;msg-param-sub-plan=2000;system-msg=Foo\\ssubscribed! USERNOTICE #chan",
    )!,
    e,
  );
  handleCommand(
    parseIRC(
      "@msg-id=resub;display-name=Bar;msg-param-sub-plan=Prime;system-msg=x USERNOTICE #chan :hi",
    )!,
    e,
  );
  handleCommand(
    parseIRC(
      "@msg-id=submysterygift;display-name=Gwen;msg-param-sub-plan=1000;msg-param-mass-gift-count=5;system-msg=x USERNOTICE #chan",
    )!,
    e,
  );
  handleCommand(
    parseIRC(
      "@msg-id=subgift;display-name=Solo;msg-param-sub-plan=3000;system-msg=x USERNOTICE #chan",
    )!,
    e,
  );
  const [fresh, prime, bomb, single] = e.captured.messages;
  assertEquals(fresh.sub, { tier: 2, variant: "new" });
  assertEquals(prime.sub, { tier: 1, variant: "resub" }); // Prime counts as Tier 1
  assertEquals(bomb.sub, { tier: 1, variant: "gift", count: 5 });
  assertEquals(single.sub, { tier: 3, variant: "gift", count: 1 });
});

Deno.test("handleCommand: USERNOTICE drops a gift bomb's per-recipient children", () => {
  const e = fakeEmitter();
  // The child carries the bomb's community-gift-id → suppressed (the
  // submysterygift notice already announced the whole bomb).
  handleCommand(
    parseIRC(
      "@msg-id=subgift;display-name=Gwen;msg-param-sub-plan=1000;msg-param-community-gift-id=12345;system-msg=x USERNOTICE #chan",
    )!,
    e,
  );
  assertEquals(e.captured.messages.length, 0);

  // A direct gift (no community-gift-id) still notices.
  handleCommand(
    parseIRC(
      "@msg-id=subgift;display-name=Gwen;msg-param-sub-plan=1000;system-msg=x USERNOTICE #chan",
    )!,
    e,
  );
  assertEquals(e.captured.messages.length, 1);
  assertEquals(e.captured.messages[0].sub, {
    tier: 1,
    variant: "gift",
    count: 1,
  });
});

Deno.test("handleCommand: USERNOTICE giftpaidupgrade omits the unknowable tier", () => {
  const e = fakeEmitter();
  // These notices carry no msg-param-sub-plan, so no tier is claimed.
  handleCommand(
    parseIRC(
      "@msg-id=giftpaidupgrade;display-name=Kim;system-msg=Kim\\sis\\scontinuing\\sthe\\sGift\\sSub! USERNOTICE #chan",
    )!,
    e,
  );
  assertEquals(e.captured.messages[0].kind, "sub");
  assertEquals(e.captured.messages[0].sub, { variant: "resub" });
});

Deno.test("subPlanTier: 1000/2000/3000 → 1/2/3; Prime and absent → 1", () => {
  assertEquals(subPlanTier("1000"), 1);
  assertEquals(subPlanTier("2000"), 2);
  assertEquals(subPlanTier("3000"), 3);
  assertEquals(subPlanTier("Prime"), 1);
  assertEquals(subPlanTier(undefined), 1);
});

Deno.test("handleCommand: USERNOTICE raid carries viewer count", () => {
  const e = fakeEmitter();
  const msg = parseIRC(
    "@msg-id=raid;display-name=Foo;msg-param-viewerCount=50;system-msg=50\\sraiders USERNOTICE #chan",
  )!;
  handleCommand(msg, e);
  const m = e.captured.messages[0];
  assertEquals(m.kind, "raid");
  assertEquals(m.amount, "50 viewers");
  assertEquals(m.quantity, 50);
});

Deno.test("handleCommand: covered channel keeps a cheer as plain chat text", () => {
  const e = fakeEmitter();
  const msg = parseIRC(
    "@id=a;display-name=Foo;bits=1000 :foo!foo@x PRIVMSG #chan :cheer1000 go",
  )!;
  handleCommand(msg, e, () => true);
  const m = e.captured.messages[0];
  assertEquals(m.kind, "chat"); // EventSub emits the highlighted cheer instead
  assertEquals(m.amount, undefined);
  assertEquals(m.accentColor, undefined);
  assertEquals(m.content, "cheer1000 go"); // the comment is preserved
});

Deno.test("handleCommand: covered channel drops USERNOTICE sub and raid", () => {
  const e = fakeEmitter();
  handleCommand(
    parseIRC("@msg-id=resub;display-name=Foo USERNOTICE #chan :hi")!,
    e,
    () => true,
  );
  handleCommand(
    parseIRC("@msg-id=raid;msg-param-viewerCount=50 USERNOTICE #chan")!,
    e,
    () => true,
  );
  assertEquals(e.captured.messages.length, 0); // both come from EventSub instead
});

Deno.test("handleCommand: covered channel still emits announcements (not EventSub-covered)", () => {
  const e = fakeEmitter();
  handleCommand(
    parseIRC(
      "@msg-id=announcement;msg-param-color=BLUE;system-msg=Heads\\sup USERNOTICE #chan :read this",
    )!,
    e,
    () => true,
  );
  assertEquals(e.captured.messages.length, 1);
  assertEquals(e.captured.messages[0].eventText, "Heads up");
});

Deno.test("handleCommand: predicate is per-channel (other channels unaffected)", () => {
  const e = fakeEmitter();
  const covered = (ch: string) => ch === "covered";
  handleCommand(
    parseIRC(
      "@id=a;display-name=Foo;bits=500 :foo!foo@x PRIVMSG #other :cheer500",
    )!,
    e,
    covered,
  );
  const m = e.captured.messages[0];
  assertEquals(m.kind, "cheer"); // #other is not covered → normal IRC behavior
  assertEquals(m.amount, "500 bits");
});

Deno.test("handleCommand: CLEARMSG deletes a single message by id", () => {
  const e = fakeEmitter();
  const msg = parseIRC("@target-msg-id=xyz CLEARMSG #chan :nuked")!;
  handleCommand(msg, e);
  assertEquals(e.captured.deletes, [{
    platform: "twitch",
    channel: "chan",
    messageId: "xyz",
  }]);
});

Deno.test("handleCommand: CLEARCHAT with a user deletes that author; without, the channel", () => {
  const e = fakeEmitter();
  handleCommand(parseIRC("CLEARCHAT #chan :baduser")!, e);
  handleCommand(parseIRC("CLEARCHAT #chan")!, e);
  assertEquals(e.captured.deletes, [
    { platform: "twitch", channel: "chan", author: "baduser" },
    { platform: "twitch", channel: "chan" },
  ]);
});

Deno.test("handleCommand: ROOMSTATE marks the channel live", () => {
  const e = fakeEmitter();
  handleCommand(parseIRC("@room-id=1 ROOMSTATE #chan")!, e);
  assertEquals(e.captured.statuses, [{
    platform: "twitch",
    name: "chan",
    state: "live",
  }]);
});

Deno.test("handleCommand: returns false for unhandled commands (e.g. PING)", () => {
  const e = fakeEmitter();
  assertEquals(handleCommand(parseIRC("PING :tmi.twitch.tv")!, e), false);
});

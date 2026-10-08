import {
  buildBadges,
  type ChatItem,
  classifyYtError,
  createQuotaLedger,
  createYouTubeRuntime,
  DISCOVERY_TICK_MS,
  emitItem,
  formatDuration,
  freshItems,
  freshQuota,
  governedIntervalMs,
  keyFingerprint,
  msUntilPacificMidnight,
  normalizeQuotaSnapshot,
  normalizeYouTubeConfig,
  pacificDay,
  pickLiveVideo,
  pollFloorMs,
  pollYouTubeChannel,
  redactUrl,
  rememberId,
  RESTART_RECHECK_MS,
  SEARCH_DAILY_CAP,
  SEARCH_MIN_SPACING_MS,
  searchGateOpen,
  searchSpacingMs,
  startYouTubePoller,
  tierColor,
  UPCOMING_TICK_MS,
  type VideoItem,
  youtubeLabel,
  type YouTubeRuntime,
  ytFetch,
} from "../src/youtube.ts";
import { youtubeQuotaStatePath } from "../src/control.ts";
import type { YouTubeChannelConfig } from "../src/types.ts";
import { fakeEmitter } from "./_fake.ts";
import { assert, assertEquals } from "./_assert.ts";

const HOUR = 3_600_000;
const MIN = 60_000;

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
  assertEquals(m.backlog, undefined); // live messages carry no flag
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
  emitItem(item({ type: "chatEndedEvent" }), "@chan", e);
  assertEquals(e.captured.messages.length, 0);
  assertEquals(e.captured.deletes.length, 0);
});

Deno.test("emitItem: the backlog option flags replayed history", () => {
  const e = fakeEmitter();
  emitItem(
    item({
      type: "superChatEvent",
      superChatDetails: { amountDisplayString: "$5.00", tier: 2 },
    }),
    "@chan",
    e,
    { backlog: true },
  );
  emitItem(item({ displayMessage: "hi" }), "@chan", e, { backlog: false });
  assertEquals(e.captured.messages[0].backlog, true);
  assertEquals(e.captured.messages[1].backlog, undefined);
});

// ---- settings / labels -------------------------------------------------------

Deno.test('youtubeLabel skips empty strings (the NixOS module writes "")', () => {
  assertEquals(
    youtubeLabel({ handle: "", channelId: "UCabc", videoId: "" }),
    "UCabc",
  );
  assertEquals(youtubeLabel({ handle: "@chan", channelId: "UCabc" }), "@chan");
  assertEquals(youtubeLabel({ handle: "", videoId: "vid" }), "vid");
  assertEquals(youtubeLabel({}), "unknown");
});

Deno.test("normalizeYouTubeConfig: defaults and clamps the quota settings", () => {
  const d = normalizeYouTubeConfig(undefined);
  assertEquals(d, {
    apiKey: "",
    channels: [],
    dailyQuota: 10_000,
    budgetHours: 4,
  });
  const c = normalizeYouTubeConfig({
    apiKey: "k",
    channels: [{ handle: "@a" }, null, "x"],
    dailyQuota: 50,
    budgetHours: 100,
  });
  assertEquals(c.apiKey, "k");
  assertEquals(c.channels, [{ handle: "@a" }]);
  assertEquals(c.dailyQuota, 1_000);
  assertEquals(c.budgetHours, 24);
  const big = normalizeYouTubeConfig({ dailyQuota: 1e9, budgetHours: 0.1 });
  assertEquals(big.dailyQuota, 10_000_000);
  assertEquals(big.budgetHours, 0.5);
  const odd = normalizeYouTubeConfig({ dailyQuota: "abc", budgetHours: 6.5 });
  assertEquals(odd.dailyQuota, 10_000);
  assertEquals(odd.budgetHours, 6.5);
});

Deno.test("keyFingerprint is FNV-1a 32-bit hex", () => {
  assertEquals(keyFingerprint(""), "811c9dc5");
  assertEquals(keyFingerprint("a"), "e40c292c");
  assertEquals(keyFingerprint("foobar"), "bf9cf968");
});

Deno.test("youtubeQuotaStatePath sits in the state dir, else null", () => {
  assertEquals(
    youtubeQuotaStatePath("/var/lib/multichat/"),
    "/var/lib/multichat/youtube-quota.json",
  );
  assertEquals(youtubeQuotaStatePath(null), null);
  assertEquals(youtubeQuotaStatePath(""), null);
});

Deno.test("redactUrl drops the base and the key", () => {
  const u = redactUrl(
    "https://www.googleapis.com/youtube/v3/videos?part=id&id=abc&key=SECRET",
  );
  assertEquals(u, "/videos?part=id&id=abc");
  assert(!redactUrl("not a url?key=SECRET&x=1").includes("SECRET"));
});

// ---- error classification ------------------------------------------------------

const QUOTA_403 = JSON.stringify({
  error: {
    code: 403,
    message:
      'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.',
    errors: [{
      message: "The request cannot be completed because you have exceeded " +
        'your <a href="/youtube/v3/getting-started#quota">quota</a>.',
      domain: "youtube.quota",
      reason: "quotaExceeded",
    }],
  },
});

const SEARCH_429 = JSON.stringify({
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Search Queries' and limit 'Search Queries per day' of service 'youtube.googleapis.com' for consumer 'project_number:123456789'.",
    errors: [{
      message: "Quota exceeded for quota metric 'Search Queries' and limit " +
        "'Search Queries per day' of service 'youtube.googleapis.com'.",
      domain: "global",
      reason: "rateLimitExceeded",
    }],
    status: "RESOURCE_EXHAUSTED",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "RATE_LIMIT_EXCEEDED",
      domain: "googleapis.com",
      metadata: {
        quota_limit: "defaultSearchListPerDayPerProject",
        quota_metric: "youtube.googleapis.com/search_list",
        quota_unit: "1/d/{project}",
        quota_limit_value: "100",
        service: "youtube.googleapis.com",
      },
    }],
  },
});

const PER_MINUTE_429 = JSON.stringify({
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute' of service 'youtube.googleapis.com' for consumer 'project_number:1'.",
    errors: [{ domain: "global", reason: "rateLimitExceeded" }],
    status: "RESOURCE_EXHAUSTED",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "RATE_LIMIT_EXCEEDED",
      metadata: {
        quota_limit: "defaultPerMinutePerProject",
        quota_metric: "youtube.googleapis.com/default",
        quota_unit: "1/min/{project}",
      },
    }],
  },
});

const RATE_403 = JSON.stringify({
  error: {
    code: 403,
    message: "The request was sent too soon after the previous one.",
    errors: [{ domain: "youtube.liveChat", reason: "rateLimitExceeded" }],
  },
});

const CHAT_ENDED_403 = JSON.stringify({
  error: {
    code: 403,
    message: "The live chat is no longer live.",
    errors: [{ domain: "youtube.liveChat", reason: "liveChatEnded" }],
  },
});

const CHAT_NOT_FOUND_404 = JSON.stringify({
  error: {
    code: 404,
    message: "The live chat that you are trying to retrieve cannot be found.",
    errors: [{ domain: "youtube.liveChat", reason: "liveChatNotFound" }],
  },
});

const KEY_INVALID_400 = JSON.stringify({
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    errors: [{ domain: "global", reason: "badRequest" }],
    status: "INVALID_ARGUMENT",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "API_KEY_INVALID",
      domain: "googleapis.com",
      metadata: { service: "youtube.googleapis.com" },
    }],
  },
});

const ytErr = (code: number, reason: string, domain = "global") =>
  JSON.stringify({
    error: { code, message: reason, errors: [{ domain, reason }] },
  });

Deno.test("classifyYtError: 403 quotaExceeded is the daily pool", () => {
  const c = classifyYtError(403, QUOTA_403);
  assertEquals(c.kind, "quotaDaily");
  assertEquals(c.reason, "quotaExceeded");
});

Deno.test("classifyYtError: 429 'Search Queries per day' is the search bucket", () => {
  const c = classifyYtError(429, SEARCH_429);
  assertEquals(c.kind, "searchQuota");
  assertEquals(c.reason, "rateLimitExceeded");
});

Deno.test("classifyYtError: a 429 per-day on the main pool is daily quota", () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: "Quota exceeded for quota metric 'Queries' and limit " +
        "'Queries per day' of service 'youtube.googleapis.com'.",
      errors: [{ domain: "global", reason: "rateLimitExceeded" }],
      status: "RESOURCE_EXHAUSTED",
    },
  });
  assertEquals(classifyYtError(429, body).kind, "quotaDaily");
});

Deno.test("classifyYtError: 429 per-minute and bare 429s are rate limits", () => {
  assertEquals(classifyYtError(429, PER_MINUTE_429).kind, "rateLimited");
  assertEquals(classifyYtError(429, "Too Many Requests").kind, "rateLimited");
});

Deno.test("classifyYtError: 403 rateLimitExceeded (polled too soon) is not quota", () => {
  assertEquals(classifyYtError(403, RATE_403, true).kind, "rateLimited");
  // Even with the quota domain, a rate reason must not park us until midnight.
  assertEquals(
    classifyYtError(403, ytErr(403, "rateLimitExceeded", "youtube.quota"))
      .kind,
    "rateLimited",
  );
  assertEquals(
    classifyYtError(403, ytErr(403, "userRateLimitExceeded")).kind,
    "rateLimited",
  );
});

Deno.test("classifyYtError: ended / missing chats end the chat", () => {
  assertEquals(classifyYtError(403, CHAT_ENDED_403, true).kind, "chatEnded");
  assertEquals(
    classifyYtError(403, ytErr(403, "liveChatDisabled"), true).kind,
    "chatEnded",
  );
  assertEquals(
    classifyYtError(404, CHAT_NOT_FOUND_404, true).kind,
    "chatEnded",
  );
  // A bare 404 on liveChat/messages too — but not elsewhere.
  assertEquals(classifyYtError(404, "Not Found", true).kind, "chatEnded");
  assertEquals(classifyYtError(404, "Not Found", false).kind, "transient");
});

Deno.test("classifyYtError: key / project problems are denied", () => {
  const c = classifyYtError(400, KEY_INVALID_400);
  assertEquals(c.kind, "denied");
  assertEquals(c.reason, "badRequest");
  assertEquals(
    classifyYtError(403, ytErr(403, "forbidden")).kind,
    "denied",
  );
  assertEquals(
    classifyYtError(403, ytErr(403, "accessNotConfigured", "usageLimits"))
      .kind,
    "denied",
  );
  assertEquals(
    classifyYtError(403, ytErr(403, "ipRefererBlocked", "usageLimits")).kind,
    "denied",
  );
});

Deno.test("classifyYtError: bad page tokens are their own kind", () => {
  assertEquals(
    classifyYtError(400, ytErr(400, "pageTokenInvalid"), true).kind,
    "badPageToken",
  );
});

Deno.test("classifyYtError: 5xx, network and garbage are transient", () => {
  assertEquals(
    classifyYtError(500, ytErr(500, "backendError")).kind,
    "transient",
  );
  assertEquals(classifyYtError(503, "<html>oops</html>").kind, "transient");
  assertEquals(classifyYtError(0, "").kind, "transient");
  assertEquals(classifyYtError(403, "<html>proxy</html>").kind, "transient");
  assertEquals(classifyYtError(400, "{not json").kind, "transient");
});

// ---- ytFetch -------------------------------------------------------------------

Deno.test("ytFetch: parses a successful response", async () => {
  const r = await ytFetch<{ items: { id: string }[] }>(
    "http://test/x",
    undefined,
    {
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ items: [{ id: "x" }] }))),
    },
  );
  assert(r.ok);
  assertEquals(r.data.items[0].id, "x");
});

Deno.test("ytFetch: classifies failures and logs them without the key", async () => {
  const logs: string[] = [];
  const r = await ytFetch(
    "https://www.googleapis.com/youtube/v3/videos?id=a&key=SECRETKEY",
    undefined,
    {
      fetch: () => Promise.resolve(new Response(QUOTA_403, { status: 403 })),
      log: (l) => logs.push(l),
    },
  );
  assert(!r.ok);
  assertEquals(r.kind, "quotaDaily");
  assertEquals(r.status, 403);
  assertEquals(logs.length, 1);
  assert(!logs[0].includes("SECRETKEY"), logs[0]);
  assert(logs[0].includes("quotaExceeded"), logs[0]);
  assert(!logs[0].includes("<a href"), "HTML stripped from the message");
});

Deno.test("ytFetch: never throws — a network error is transient", async () => {
  const r = await ytFetch("http://test/x", undefined, {
    fetch: () => Promise.reject(new TypeError("connection reset")),
    log: () => {},
  });
  assert(!r.ok);
  assertEquals(r.kind, "transient");
  assertEquals(r.status, 0);
  assertEquals(r.reason, "network");
});

Deno.test("ytFetch: a liveChat URL makes a bare 404 chatEnded", async () => {
  const r = await ytFetch(
    "http://test/youtube/v3/liveChat/messages?x=1",
    undefined,
    {
      fetch: () => Promise.resolve(new Response("nope", { status: 404 })),
      log: () => {},
    },
  );
  assert(!r.ok);
  assertEquals(r.kind, "chatEnded");
});

Deno.test("ytFetch: aborted requests are not logged", async () => {
  const ac = new AbortController();
  ac.abort();
  const logs: string[] = [];
  const r = await ytFetch("http://test/x", ac.signal, {
    fetch: (_u, init) =>
      init?.signal?.aborted
        ? Promise.reject(new DOMException("aborted", "AbortError"))
        : Promise.resolve(new Response("{}")),
    log: (l) => logs.push(l),
  });
  assert(!r.ok);
  assertEquals(logs, []);
});

// ---- Pacific clock -------------------------------------------------------------

Deno.test("pacificDay follows America/Los_Angeles", () => {
  assertEquals(pacificDay(Date.parse("2026-10-08T06:59:59Z")), "2026-10-07");
  assertEquals(pacificDay(Date.parse("2026-10-08T07:00:00Z")), "2026-10-08");
  assertEquals(pacificDay(Date.parse("2026-01-15T07:59:59Z")), "2026-01-14");
  assertEquals(pacificDay(Date.parse("2026-01-15T08:00:00Z")), "2026-01-15");
});

Deno.test("msUntilPacificMidnight: ordinary days (PDT and PST)", () => {
  assertEquals(
    msUntilPacificMidnight(Date.parse("2026-10-08T20:00:00Z")),
    11 * HOUR,
  );
  assertEquals(
    msUntilPacificMidnight(Date.parse("2026-10-08T07:00:00Z")),
    24 * HOUR,
  );
  assertEquals(
    msUntilPacificMidnight(Date.parse("2026-10-09T06:59:30.250Z")),
    29_750,
  );
  assertEquals(
    msUntilPacificMidnight(Date.parse("2026-01-15T20:00:00Z")),
    12 * HOUR,
  );
});

Deno.test("msUntilPacificMidnight: DST transition days", () => {
  // 2026-03-08 springs forward (a 23h day): 01:00 PST → 22h to midnight PDT.
  assertEquals(
    msUntilPacificMidnight(Date.parse("2026-03-08T09:00:00Z")),
    22 * HOUR,
  );
  // After the jump, wall clock and real time agree again.
  assertEquals(
    msUntilPacificMidnight(Date.parse("2026-03-08T19:00:00Z")),
    12 * HOUR,
  );
  // 2026-11-01 falls back (a 25h day): 00:30 PDT → 24.5h to midnight PST.
  assertEquals(
    msUntilPacificMidnight(Date.parse("2026-11-01T07:30:00Z")),
    24.5 * HOUR,
  );
  assertEquals(
    pacificDay(
      Date.parse("2026-11-01T07:30:00Z") +
        msUntilPacificMidnight(Date.parse("2026-11-01T07:30:00Z")),
    ),
    "2026-11-02",
  );
});

Deno.test("formatDuration renders hours and minutes", () => {
  assertEquals(formatDuration(11 * HOUR + 4 * MIN), "11h4m");
  assertEquals(formatDuration(59_000), "0h1m");
  assertEquals(formatDuration(-5), "0h0m");
});

// ---- quota ledger / governor -----------------------------------------------------

Deno.test("pollFloorMs: a fresh 10k day with a 4h budget polls every ≈8s", () => {
  const base = {
    dailyQuota: 10_000,
    budgetHours: 4,
    unitsSpent: 0,
    liveMsToday: 0,
    msUntilMidnight: 24 * HOUR,
    activeChats: 1,
  };
  // 5 × 4h / (10000 − 40×24) = 72e6 / 9040
  assertEquals(Math.round(pollFloorMs(base)), 7965);
  // Two live chats split the units: twice as slow each.
  assertEquals(Math.round(pollFloorMs({ ...base, activeChats: 2 })), 15929);
  // Half the planned time used → half the floor.
  assertEquals(
    Math.round(pollFloorMs({ ...base, liveMsToday: 2 * HOUR })),
    3982,
  );
  // Past the budget, 30 min is always assumed left (keeps stretching).
  assertEquals(
    Math.round(pollFloorMs({ ...base, liveMsToday: 10 * HOUR })),
    Math.round(5 * 30 * MIN / 9040),
  );
  // Nothing left → the 60s cap takes over.
  assertEquals(
    governedIntervalMs(2000, pollFloorMs({ ...base, unitsSpent: 9_900 })),
    60_000,
  );
  // A big quota leaves the API's own pollingIntervalMillis in charge.
  assertEquals(
    governedIntervalMs(
      2000,
      pollFloorMs({ ...base, dailyQuota: 1_000_000 }),
    ),
    2000,
  );
});

Deno.test("governedIntervalMs clamps to 1s..60s and defaults to 5s", () => {
  assertEquals(governedIntervalMs(undefined, 0), 5000);
  assertEquals(governedIntervalMs(500, 0), 1000);
  assertEquals(governedIntervalMs(2000, 7965), 7965);
  assertEquals(governedIntervalMs(90_000, 0), 60_000);
});

Deno.test("searchSpacingMs spreads the remaining searches over the day", () => {
  assertEquals(searchSpacingMs(0, 24 * HOUR), 36 * MIN);
  assertEquals(searchSpacingMs(39, HOUR), HOUR);
  assertEquals(searchSpacingMs(39, 10 * MIN), SEARCH_MIN_SPACING_MS);
  assertEquals(searchSpacingMs(SEARCH_DAILY_CAP, HOUR), Infinity);
});

Deno.test("searchGateOpen: blocked, capped, spaced", () => {
  const now = Date.parse("2026-10-08T20:00:00Z");
  const q = freshQuota("2026-10-08");
  assert(searchGateOpen(q, now));
  assert(!searchGateOpen({ ...q, searchBlocked: true }, now));
  assert(!searchGateOpen({ ...q, exhausted: true }, now));
  assert(!searchGateOpen({ ...q, searches: SEARCH_DAILY_CAP }, now));
  assert(!searchGateOpen({ ...q, searches: 1, lastSearchAt: now - MIN }, now));
  assert(searchGateOpen({ ...q, searches: 1, lastSearchAt: now - HOUR }, now));
});

Deno.test("normalizeQuotaSnapshot keeps today, resets a stale or bad file", () => {
  const today = "2026-10-08";
  const kept = normalizeQuotaSnapshot({
    day: today,
    units: 120,
    searches: 3,
    searchBlocked: true,
    exhausted: false,
    liveMs: 5000,
    lastSearchAt: 42,
    keyFp: "abcd1234",
  }, today);
  assertEquals(kept.units, 120);
  assertEquals(kept.searchBlocked, true);
  assertEquals(kept.lastSearchAt, 42);
  const stale = normalizeQuotaSnapshot(
    { day: "2026-10-07", units: 9999, exhausted: true, keyFp: "abcd1234" },
    today,
  );
  assertEquals(stale, freshQuota(today, "abcd1234"));
  assertEquals(normalizeQuotaSnapshot("garbage", today), freshQuota(today));
  assertEquals(
    normalizeQuotaSnapshot({ day: today, units: -5, liveMs: "x" }, today).units,
    0,
  );
});

Deno.test("createQuotaLedger rolls over at Pacific midnight", () => {
  let t = Date.parse("2026-10-09T06:00:00Z"); // 23:00 PDT on the 8th
  let changes = 0;
  const l = createQuotaLedger({
    now: () => t,
    onChange: () => changes++,
  });
  l.charge(5);
  l.noteSearch();
  assert(l.markExhausted());
  assert(!l.markExhausted()); // already
  assert(l.blockSearch());
  l.adoptKey("k1");
  assertEquals(l.snapshot().day, "2026-10-08");
  assertEquals(l.snapshot().units, 5);
  assertEquals(l.snapshot().exhausted, true);
  const before = changes;
  t += 2 * HOUR; // 01:00 PDT on the 9th
  const s = l.snapshot();
  assertEquals(s.day, "2026-10-09");
  assertEquals(s.units, 0);
  assertEquals(s.searches, 0);
  assertEquals(s.exhausted, false);
  assertEquals(s.searchBlocked, false);
  assertEquals(s.keyFp, "k1"); // the key survives the day
  assert(changes > before, "rollover fires onChange");
});

Deno.test("createQuotaLedger: restore, key changes, live time", () => {
  const t = Date.parse("2026-10-08T20:00:00Z");
  const l = createQuotaLedger({
    now: () => t,
    snapshot: { day: "2026-10-08", units: 500, keyFp: "old" },
  });
  assertEquals(l.snapshot().units, 500);
  assert(!l.adoptKey("old"));
  assert(l.adoptKey("new")); // a different key → count from zero
  assertEquals(l.snapshot().units, 0);
  assertEquals(l.snapshot().keyFp, "new");
  l.addLiveMs(1000);
  l.addLiveMs(-5);
  assertEquals(l.snapshot().liveMs, 1000);
  // First adoption on a ledger without a key is not a reset.
  const fresh = createQuotaLedger({ now: () => t });
  fresh.charge(7);
  assert(!fresh.adoptKey("k"));
  assertEquals(fresh.snapshot().units, 7);
});

// ---- live detection / dedupe -----------------------------------------------------

const NOW = Date.parse("2026-10-08T20:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function liveVideo(id: string, chatId: string, startedAt = NOW - HOUR) {
  return {
    id,
    snippet: { liveBroadcastContent: "live" },
    liveStreamingDetails: {
      actualStartTime: iso(startedAt),
      activeLiveChatId: chatId,
    },
  };
}
function endedVideo(id: string) {
  return {
    id,
    snippet: { liveBroadcastContent: "none" },
    liveStreamingDetails: {
      actualStartTime: iso(NOW - 3 * HOUR),
      actualEndTime: iso(NOW - HOUR),
    },
  };
}
function upcomingVideo(id: string, scheduled: number) {
  return {
    id,
    snippet: { liveBroadcastContent: "upcoming" },
    liveStreamingDetails: {
      scheduledStartTime: iso(scheduled),
      activeLiveChatId: `waiting-${id}`,
    },
  };
}
const plainVideo = (id: string) => ({
  id,
  snippet: { liveBroadcastContent: "none" },
});

Deno.test("pickLiveVideo: live beats upcoming and ended; latest start wins", () => {
  const p = pickLiveVideo({
    items: [
      endedVideo("old"),
      liveVideo("a", "chatA", NOW - 2 * HOUR),
      liveVideo("b", "chatB", NOW - 10 * MIN),
      upcomingVideo("u", NOW + 5 * MIN),
    ],
  }, NOW);
  assertEquals(p.live?.videoId, "b");
  assertEquals(p.live?.chatId, "chatB");
  assertEquals(p.soon, true);
});

Deno.test("pickLiveVideo: an upcoming stream's waiting room is not live", () => {
  const soon = pickLiveVideo(
    { items: [upcomingVideo("u", NOW + 10 * MIN)] },
    NOW,
  );
  assertEquals(soon.live, null);
  assertEquals(soon.soon, true);
  const later = pickLiveVideo({ items: [upcomingVideo("u", NOW + HOUR)] }, NOW);
  assertEquals(later.soon, false);
  const overdue = pickLiveVideo(
    { items: [upcomingVideo("u", NOW - 90 * MIN)] },
    NOW,
  );
  assertEquals(overdue.soon, true);
  const abandoned = pickLiveVideo(
    { items: [upcomingVideo("u", NOW - 3 * HOUR)] },
    NOW,
  );
  assertEquals(abandoned.soon, false);
});

Deno.test("pickLiveVideo: ended, chat-less and skipped chats are not live", () => {
  const stillFlagged: VideoItem = {
    ...liveVideo("x", "chatX"),
    liveStreamingDetails: {
      ...liveVideo("x", "chatX").liveStreamingDetails,
      actualEndTime: iso(NOW),
    },
  };
  assertEquals(pickLiveVideo({ items: [stillFlagged] }, NOW).live, null);
  assertEquals(
    pickLiveVideo({
      items: [{ id: "y", snippet: { liveBroadcastContent: "live" } }],
    }, NOW).live,
    null,
  );
  assertEquals(
    pickLiveVideo(
      { items: [liveVideo("z", "dead")] },
      NOW,
      (c) => c === "dead",
    ).live,
    null,
  );
  assertEquals(pickLiveVideo(null, NOW), { live: null, soon: false });
});

Deno.test("rememberId bounds the seen set, evicting the oldest", () => {
  const seen = new Set<string>();
  assert(rememberId(seen, "a", 2));
  assert(!rememberId(seen, "a", 2));
  assert(rememberId(seen, "b", 2));
  assert(rememberId(seen, "c", 2));
  assertEquals([...seen], ["b", "c"]);
  assert(rememberId(seen, "a", 2)); // evicted, so new again
});

Deno.test("freshItems drops seen ids and flags first-page history as backlog", () => {
  const seen = new Set<string>(["dup"]);
  const at = (id: string, ms: number) =>
    ({ ...item({ publishedAt: iso(ms) }), id }) as ChatItem;
  const out = freshItems(
    [at("old", NOW - 10 * MIN), at("dup", NOW), at("new", NOW - MIN)],
    seen,
    NOW - 5 * MIN,
  );
  assertEquals(out.map((o) => [o.item.id, o.backlog]), [
    ["old", true],
    ["new", false],
  ]);
  // Later pages (backlogBefore null) are never backlog, and ids stay deduped.
  const again = freshItems(
    [at("old", NOW - HOUR), at("x", NOW - HOUR)],
    seen,
    null,
  );
  assertEquals(again.map((o) => [o.item.id, o.backlog]), [["x", false]]);
});

// ---- scenario harness ----------------------------------------------------------

interface Call {
  t: number;
  path: string;
  params: URLSearchParams;
}

interface Harness {
  clock: { t: number };
  rt: YouTubeRuntime;
  e: ReturnType<typeof fakeEmitter>;
  calls: Call[];
  sleeps: { t: number; ms: number }[];
  logs: string[];
  controller: AbortController;
  run(ch: YouTubeChannelConfig): Promise<void>;
  callsTo(path: string): Call[];
  states(): string[];
}

type Route = (call: Call, h: Harness) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/**
 * Drive pollYouTubeChannel with a fake clock, an instant sleep (that advances
 * the clock) and a fetch routed by URL path. `stop` is consulted after every
 * sleep; the loop is aborted when it says so (or after `maxSleeps`).
 */
function harness(opts: {
  start: string;
  route: Route;
  stop?: (h: Harness, ms: number) => boolean;
  maxSleeps?: number;
}): Harness {
  const h = {
    clock: { t: Date.parse(opts.start) },
    e: fakeEmitter(),
    calls: [] as Call[],
    sleeps: [] as { t: number; ms: number }[],
    logs: [] as string[],
    controller: new AbortController(),
  } as Harness;
  const maxSleeps = opts.maxSleeps ?? 2000;
  h.rt = createYouTubeRuntime({
    now: () => h.clock.t,
    random: () => 0.5,
    log: (line) => h.logs.push(line),
    fetch: async (url) => {
      const u = new URL(url);
      const call = {
        t: h.clock.t,
        path: u.pathname.replace("/youtube/v3/", ""),
        params: u.searchParams,
      };
      h.calls.push(call);
      if (h.calls.length > 20_000) h.controller.abort(); // runaway guard
      return await opts.route(call, h);
    },
    sleep: (ms, signal) => {
      if (signal?.aborted) return Promise.resolve();
      h.sleeps.push({ t: h.clock.t, ms });
      h.clock.t += ms;
      if (h.sleeps.length >= maxSleeps || opts.stop?.(h, ms)) {
        h.controller.abort();
      }
      return Promise.resolve();
    },
  });
  h.run = (ch) =>
    pollYouTubeChannel(ch, "SECRETKEY", h.e, h.rt, h.controller.signal);
  h.callsTo = (path) => h.calls.filter((c) => c.path === path);
  h.states = () => h.e.captured.statuses.map((s) => s.state);
  return h;
}

/** A videos.list route answering from a mutable id → video table. */
function videosFrom(db: Record<string, unknown>) {
  return (c: Call) =>
    json({
      items: (c.params.get("id") ?? "").split(",").map((id) => db[id]).filter(
        (v) => v,
      ),
    });
}

const UPLOADS = {
  items: [{
    id: "UCchan",
    contentDetails: { relatedPlaylists: { uploads: "UUchan" } },
  }],
};

function chatMsg(id: string, publishedAt: number, text = id) {
  return {
    id,
    snippet: {
      type: "textMessageEvent",
      displayMessage: text,
      publishedAt: iso(publishedAt),
    },
    authorDetails: { displayName: "Viewer" },
  };
}

function assertNoKeyLeak(h: Harness) {
  for (const l of h.logs) assert(!l.includes("SECRETKEY"), `key leaked: ${l}`);
}

Deno.test("scenario: an offline channel ticks on the playlist, rations search, never flickers", async () => {
  const start = "2026-10-08T07:00:00Z"; // 00:00 PDT
  const end = Date.parse(start) + 24 * HOUR - DISCOVERY_TICK_MS; // same PT day
  const h = harness({
    start,
    route: (c) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({
            items: [
              { contentDetails: { videoId: "v1" } },
              { contentDetails: { videoId: "v2" } },
            ],
          });
        case "videos":
          return videosFrom({ v1: plainVideo("v1"), v2: plainVideo("v2") })(c);
        case "search":
          return json({ items: [] });
      }
      return json({}, 500);
    },
    stop: (h) => h.clock.t >= end,
  });
  await h.run({ channelId: "UCchan" });

  assertEquals(h.states(), ["connecting", "offline"]);
  assertEquals(h.callsTo("channels").length, 1); // uploads id resolved once
  assert(h.sleeps.every((s) => s.ms === DISCOVERY_TICK_MS), "3 min ticks");
  const ticks = h.sleeps.length;
  assertEquals(h.callsTo("playlistItems").length, ticks);
  assertEquals(h.callsTo("videos").length, ticks);
  assertEquals(
    h.callsTo("playlistItems")[0].params.get("playlistId"),
    "UUchan",
  );
  const searches = h.callsTo("search");
  assert(searches.length <= SEARCH_DAILY_CAP, `${searches.length} searches`);
  assert(searches.length >= 30, `only ${searches.length} searches`);
  for (let i = 1; i < searches.length; i++) {
    const gap = searches[i].t - searches[i - 1].t;
    assert(gap >= SEARCH_MIN_SPACING_MS, `search gap ${gap}ms`);
  }
  // ≈2 units a tick plus the one-off channels.list; search is its own bucket.
  const q = h.rt.ledger.snapshot();
  assertEquals(q.units, 1 + 2 * ticks);
  assertEquals(q.searches, searches.length);
  assertNoKeyLeak(h);
});

Deno.test("scenario: live → chat ends (403) → offline → a restarted stream is found 30s later", async () => {
  let phase = 1;
  const t0 = Date.parse("2026-10-08T18:00:00Z");
  const db: Record<string, unknown> = {};
  let c2Calls = 0;
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({
            items: (phase === 1 ? ["v1"] : ["v2", "v1"]).map((videoId) => ({
              contentDetails: { videoId },
            })),
          });
        case "videos":
          db.v1 = liveVideo("v1", "c1", t0 - HOUR); // videos.list lags: still "live"
          if (phase === 2) db.v2 = liveVideo("v2", "c2", h.clock.t - MIN);
          return videosFrom(db)(c);
        case "liveChat/messages": {
          const chat = c.params.get("liveChatId");
          if (chat === "c1" && !c.params.get("pageToken")) {
            return json({
              items: [chatMsg("m1", h.clock.t), chatMsg("m2", h.clock.t)],
              nextPageToken: "t1",
              pollingIntervalMillis: 2000,
            });
          }
          if (chat === "c1") {
            phase = 2;
            return new Response(CHAT_ENDED_403, { status: 403 });
          }
          if (chat === "c2") {
            if (++c2Calls > 1) h.controller.abort();
            return json({
              items: [chatMsg("m3", h.clock.t)],
              nextPageToken: "u1",
              pollingIntervalMillis: 2000,
            });
          }
        }
      }
      return json({}, 500);
    },
  });
  await h.run({ handle: "@chan" });

  assertEquals(h.states(), ["connecting", "live", "offline", "live"]);
  assertEquals(h.e.captured.messages.map((m) => m.id), ["m1", "m2", "m3"]);
  // The handle was resolved (with its uploads playlist) in one call.
  assertEquals(h.callsTo("channels").length, 1);
  assertEquals(h.callsTo("channels")[0].params.get("forHandle"), "@chan");
  // The sleep after the end was the quick restart recheck.
  const chats = h.callsTo("liveChat/messages");
  assertEquals(chats.map((c) => c.params.get("liveChatId")), [
    "c1",
    "c1",
    "c2",
    "c2",
  ]);
  assertEquals(chats[1].params.get("pageToken"), "t1");
  assert(
    h.sleeps.some((s) => s.ms === RESTART_RECHECK_MS),
    `sleeps: ${h.sleeps.map((s) => s.ms)}`,
  );
  // The ended chat (still "live" in videos.list) was not re-attached.
  assertEquals(chats[2].params.get("liveChatId"), "c2");
  assertNoKeyLeak(h);
});

Deno.test("scenario: quotaExceeded mid-chat → error, then sleep until PT midnight", async () => {
  let chatCalls = 0;
  const h = harness({
    start: "2026-10-08T20:00:00Z", // 13:00 PDT
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          return videosFrom({ v1: liveVideo("v1", "c1") })(c);
        case "liveChat/messages":
          if (++chatCalls === 1) {
            return json({
              items: [chatMsg("m1", h.clock.t)],
              nextPageToken: "t1",
            });
          }
          return new Response(QUOTA_403, { status: 403 });
      }
      return json({}, 500);
    },
    stop: (_h, ms) => ms > HOUR,
  });
  await h.run({ channelId: "UCchan" });

  assertEquals(h.states(), ["connecting", "live", "error"]);
  assertEquals(chatCalls, 2); // no hammering after the 403
  const long = h.sleeps[h.sleeps.length - 1];
  // Until 00:00 PT plus 2–7 min of jitter (random 0.5 → 4.5 min).
  assertEquals(long.ms, msUntilPacificMidnight(long.t) + 4.5 * MIN);
  assert(long.ms > 10 * HOUR && long.ms < 12 * HOUR, `slept ${long.ms}`);
  assert(
    h.logs.some((l) =>
      l.includes(
        "daily YouTube API quota exhausted — resuming at 00:00 PT (in 1",
      )
    ),
    h.logs.join("\n"),
  );
  // Past midnight the ledger has rolled over to a fresh day.
  assertEquals(h.rt.ledger.snapshot().exhausted, false);
  assertEquals(h.rt.ledger.snapshot().day, "2026-10-09");
});

Deno.test("scenario: a 403 rateLimitExceeded waits briefly and keeps the page token", async () => {
  let chatCalls = 0;
  let done = false;
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          return videosFrom({ v1: liveVideo("v1", "c1") })(c);
        case "liveChat/messages":
          chatCalls++;
          if (chatCalls === 1) {
            return json({
              items: [chatMsg("m1", h.clock.t)],
              nextPageToken: "t1",
              pollingIntervalMillis: 3000,
            });
          }
          if (chatCalls === 2) {
            return new Response(RATE_403, { status: 403 });
          }
          done = true;
          return json({
            items: [chatMsg("m2", h.clock.t)],
            nextPageToken: "t2",
          });
      }
      return json({}, 500);
    },
    stop: () => done,
  });
  await h.run({ channelId: "UCchan" });

  assertEquals(h.states(), ["connecting", "live"]);
  const chats = h.callsTo("liveChat/messages");
  assertEquals(chats.map((c) => c.params.get("pageToken")), [null, "t1", "t1"]);
  assertEquals(h.callsTo("playlistItems").length, 1); // no rediscovery
  // First sleep = the governed interval; the rate-limit wait = 2× that.
  const [poll, wait, after] = h.sleeps.map((s) => s.ms);
  assertEquals(h.sleeps.length, 3);
  assert(after >= 5000, `next poll ${after}`);
  assert(poll >= 3000 && poll < 10_000, `poll interval ${poll}`);
  assertEquals(wait, Math.max(2 * poll, 10_000));
  assertEquals(h.e.captured.messages.map((m) => m.id), ["m1", "m2"]);
});

Deno.test("scenario: search 429 per-day blocks search; the playlist keeps running", async () => {
  const start = Date.parse("2026-10-08T15:00:00Z");
  const h = harness({
    start: "2026-10-08T15:00:00Z",
    route: (c) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          return videosFrom({ v1: plainVideo("v1") })(c);
        case "search":
          return new Response(SEARCH_429, { status: 429 });
      }
      return json({}, 500);
    },
    stop: (h) => h.clock.t >= start + 6 * HOUR,
  });
  await h.run({ channelId: "UCchan" });

  assertEquals(h.callsTo("search").length, 1);
  assert(h.callsTo("playlistItems").length >= 100, "playlist keeps ticking");
  assertEquals(h.rt.ledger.snapshot().searchBlocked, true);
  assertEquals(h.states(), ["connecting", "offline"]); // not an error
  assertEquals(
    h.logs.filter((l) => l.includes("search.list's daily bucket is spent"))
      .length,
    1,
  );
});

Deno.test("scenario: re-attaching to the same chat resumes its token without duplicates", async () => {
  let gen = 1;
  let polled = false;
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          return videosFrom({ v1: liveVideo("v1", "c1") })(c);
        case "liveChat/messages":
          polled = true; // one page per generation (stop after its sleep)
          return gen === 1
            ? json({
              items: [
                chatMsg("m0", h.clock.t - 20 * MIN), // history
                chatMsg("m1", h.clock.t - MIN),
                chatMsg("m2", h.clock.t),
              ],
              nextPageToken: "t1",
            })
            : json({
              items: [chatMsg("m2", h.clock.t - MIN), chatMsg("m3", h.clock.t)],
              nextPageToken: "t2",
            });
      }
      return json({}, 500);
    },
    stop: () => polled,
  });
  await h.run({ channelId: "UCchan" });
  // A key change: the next generation shares the runtime.
  gen = 2;
  polled = false;
  h.controller = new AbortController();
  await h.run({ channelId: "UCchan" });

  const msgs = h.e.captured.messages;
  assertEquals(msgs.map((m) => m.id), ["m0", "m1", "m2", "m3"]);
  assertEquals(msgs.map((m) => m.backlog ?? false), [
    true,
    false,
    false,
    false,
  ]);
  const chats = h.callsTo("liveChat/messages");
  assertEquals(chats.map((c) => c.params.get("pageToken")), [null, "t1"]);
  assertEquals(h.callsTo("channels").length, 1); // cached across generations
  assert(h.logs.some((l) => l.includes("resuming")), h.logs.join("\n"));
});

Deno.test("scenario: an aborted generation emits no further status", async () => {
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          h.controller.abort(); // torn down while this request is in flight
          return videosFrom({ v1: liveVideo("v1", "c1") })(c);
      }
      return json({}, 500);
    },
  });
  await h.run({ channelId: "UCchan" });
  assertEquals(h.states(), ["connecting"]);
  assertEquals(h.callsTo("liveChat/messages").length, 0);
  assertEquals(h.sleeps.length, 0);

  // An already-aborted signal: silence from the start.
  const e = fakeEmitter();
  const ac = new AbortController();
  ac.abort();
  startYouTubePoller(
    { apiKey: "k", channels: [{ channelId: "UCchan" }] },
    e,
    ac.signal,
    h.rt,
  );
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(e.captured.statuses, []);
});

Deno.test("scenario: transient chat failures back off, flag error after 3, recover to live", async () => {
  let chatCalls = 0;
  let done = false;
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          return videosFrom({ v1: liveVideo("v1", "c1") })(c);
        case "liveChat/messages":
          if (++chatCalls <= 3) return new Response("boom", { status: 503 });
          done = true;
          return json({ items: [chatMsg("m1", h.clock.t)] });
      }
      return json({}, 500);
    },
    stop: () => done,
  });
  await h.run({ channelId: "UCchan" });
  assertEquals(h.states(), ["connecting", "live", "error", "live"]);
  assertEquals(h.sleeps.slice(0, 3).map((s) => s.ms), [5000, 10_000, 20_000]);
  assertEquals(h.e.captured.messages.map((m) => m.id), ["m1"]);
});

Deno.test("scenario: offlineAt → videos.list says ended → back to discovery", async () => {
  let verify = 0;
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          // discovery sees it live; the offlineAt checks see an encoder
          // blip first, then the end
          verify++;
          return videosFrom({
            v1: verify <= 2 ? liveVideo("v1", "c1") : endedVideo("v1"),
          })(c);
        case "liveChat/messages":
          return json({
            items: [],
            offlineAt: iso(h.clock.t),
            pollingIntervalMillis: 2000,
          });
      }
      return json({}, 500);
    },
    stop: (_h, ms) => ms === RESTART_RECHECK_MS,
  });
  await h.run({ channelId: "UCchan" });
  assertEquals(h.states(), ["connecting", "live", "offline"]);
  // Blip: kept polling at ≥10s; then the once-a-minute re-verify found the end.
  assert(h.sleeps.slice(0, -1).every((s) => s.ms >= 10_000), "slowed down");
  assertEquals(h.sleeps[h.sleeps.length - 1].ms, RESTART_RECHECK_MS);
  assert(h.logs.some((l) => l.includes("the stream ended")), h.logs.join("\n"));
});

Deno.test("scenario: a chatEndedEvent ends the chat after emitting the page", async () => {
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c, h) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos":
          return videosFrom({ v1: liveVideo("v1", "c1") })(c);
        case "liveChat/messages":
          return json({
            items: [
              chatMsg("bye", h.clock.t),
              {
                ...chatMsg("end", h.clock.t),
                snippet: {
                  type: "chatEndedEvent",
                  publishedAt: iso(h.clock.t),
                },
              },
            ],
          });
      }
      return json({}, 500);
    },
    stop: () => true,
  });
  await h.run({ channelId: "UCchan" });
  assertEquals(h.e.captured.messages.map((m) => m.id), ["bye"]);
  assertEquals(h.states(), ["connecting", "live", "offline"]);
  assertEquals(h.sleeps[0].ms, RESTART_RECHECK_MS);
});

Deno.test("scenario: a pinned videoId skips discovery; a scheduled one rechecks every minute", async () => {
  const start = Date.parse("2026-10-08T18:00:00Z");
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c) =>
      c.path === "videos"
        ? videosFrom({ pin: upcomingVideo("pin", start + 10 * MIN) })(c)
        : json({}, 500),
    maxSleeps: 3,
  });
  await h.run({ videoId: "pin", handle: "" });
  assertEquals(h.calls.every((c) => c.path === "videos"), true);
  assertEquals(h.calls[0].params.get("id"), "pin");
  assertEquals(h.sleeps.map((s) => s.ms), [
    UPCOMING_TICK_MS,
    UPCOMING_TICK_MS,
    UPCOMING_TICK_MS,
  ]);
  assertEquals(h.e.captured.statuses[0].name, "pin"); // label skips the ""
  assertEquals(h.states(), ["connecting", "offline"]);
});

Deno.test("scenario: a rejected key is an error, retried every 10 min via connecting", async () => {
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: () => new Response(KEY_INVALID_400, { status: 400 }),
    maxSleeps: 2,
  });
  await h.run({ handle: "@chan" });
  assertEquals(h.states(), ["connecting", "error", "connecting", "error"]);
  assertEquals(h.sleeps.map((s) => s.ms), [10 * MIN, 10 * MIN]);
  assert(
    h.logs.some((l) => l.includes("API key not valid")),
    h.logs.join("\n"),
  );
  assertNoKeyLeak(h);
});

Deno.test("scenario: an ended chat videos.list still calls live is not re-attached", async () => {
  const h = harness({
    start: "2026-10-08T18:00:00Z",
    route: (c) => {
      switch (c.path) {
        case "channels":
          return json(UPLOADS);
        case "playlistItems":
          return json({ items: [{ contentDetails: { videoId: "v1" } }] });
        case "videos": // lags behind the chat: still "live" on c1
          return videosFrom({ v1: liveVideo("v1", "c1") })(c);
        case "liveChat/messages":
          return new Response(CHAT_ENDED_403, { status: 403 });
        case "search":
          return json({ items: [] });
      }
      return json({}, 500);
    },
    stop: (h) => h.clock.t >= Date.parse("2026-10-08T18:20:00Z"),
  });
  await h.run({ channelId: "UCchan" });
  // One attach, then quiet until the dead-chat memory (10 min) lapses, then
  // a single retry that ends the same way — no 30s hammering in between.
  const chats = h.callsTo("liveChat/messages");
  assertEquals(chats.length, 2);
  assertEquals(h.states(), [
    "connecting",
    "live",
    "offline",
    "live",
    "offline",
  ]);
  assert(chats[1].t - chats[0].t >= 10 * MIN, "re-attached too soon");
});

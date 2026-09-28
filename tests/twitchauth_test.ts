import {
  buildAuthCodeRequest,
  buildAuthorizeUrl,
  buildCheckFollowRequest,
  buildCreateCustomRewardRequest,
  buildCreateSubscriptionRequest,
  buildGetCustomRewardsRequest,
  buildGetRedemptionsRequest,
  buildRefreshRequest,
  buildSendChatMessageRequest,
  buildUpdateCustomRewardRequest,
  buildUpdateRedemptionStatusRequest,
  buildUsersRequest,
  CHAT_WRITE_SCOPE,
  EVENTSUB_SCOPES,
  LOGIN_SCOPES,
  parseCreateSubscriptionResponse,
  parseCustomRewardsResponse,
  parseFollowersResponse,
  parseHelixResponse,
  parseRedemptionsResponse,
  parseTokenResponse,
  parseUsersResponse,
  REDEMPTIONS_MANAGE_SCOPE,
  SUBSCRIPTIONS,
  subscriptionsFor,
} from "../src/twitchauth.ts";
import { assert, assertEquals, assertThrows } from "./_assert.ts";

Deno.test("buildRefreshRequest: form-encoded refresh grant to id.twitch.tv", () => {
  const req = buildRefreshRequest("cid", "secret", "r3fr3sh");
  assertEquals(req.url, "https://id.twitch.tv/oauth2/token");
  assertEquals(req.method, "POST");
  assertEquals(
    req.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  const p = new URLSearchParams(req.body);
  assertEquals(p.get("grant_type"), "refresh_token");
  assertEquals(p.get("refresh_token"), "r3fr3sh");
  assertEquals(p.get("client_id"), "cid");
  assertEquals(p.get("client_secret"), "secret");
});

Deno.test("buildAuthCodeRequest: exchanges a code with the redirect_uri", () => {
  const req = buildAuthCodeRequest(
    "cid",
    "secret",
    "the-code",
    "http://localhost:3000",
  );
  const p = new URLSearchParams(req.body);
  assertEquals(p.get("grant_type"), "authorization_code");
  assertEquals(p.get("code"), "the-code");
  assertEquals(p.get("redirect_uri"), "http://localhost:3000");
});

Deno.test("buildAuthorizeUrl: carries client_id, scopes, state, code response", () => {
  const url = buildAuthorizeUrl(
    "cid",
    "http://localhost:3000",
    ["a:b", "c:d"],
    "xyz",
  );
  const u = new URL(url);
  assertEquals(u.origin + u.pathname, "https://id.twitch.tv/oauth2/authorize");
  assertEquals(u.searchParams.get("client_id"), "cid");
  assertEquals(u.searchParams.get("response_type"), "code");
  assertEquals(u.searchParams.get("scope"), "a:b c:d");
  assertEquals(u.searchParams.get("state"), "xyz");
  assertEquals(u.searchParams.get("redirect_uri"), "http://localhost:3000");
});

Deno.test("parseTokenResponse: success carries the rotated refresh token", () => {
  const r = parseTokenResponse({
    access_token: "AT",
    refresh_token: "NEW_RT",
    expires_in: 14400,
    scope: ["bits:read"],
    token_type: "bearer",
  });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.accessToken, "AT");
    assertEquals(r.refreshToken, "NEW_RT");
    assertEquals(r.expiresIn, 14400);
    // The granted scopes are kept, so startup can catch a pre-scope token.
    assertEquals(r.scopes, ["bits:read"]);
  }
});

Deno.test("parseTokenResponse: no scope array means unknown, not 'none'", () => {
  const r = parseTokenResponse({ access_token: "AT", refresh_token: "RT" });
  assert(r.ok);
  if (r.ok) assertEquals(r.scopes, undefined);

  const empty = parseTokenResponse({
    access_token: "AT",
    refresh_token: "RT",
    scope: [],
  });
  assert(empty.ok);
  if (empty.ok) assertEquals(empty.scopes, []);

  // Non-string junk inside the array is dropped.
  const junk = parseTokenResponse({
    access_token: "AT",
    refresh_token: "RT",
    scope: ["channel:manage:redemptions", 7, null],
  });
  assert(junk.ok);
  if (junk.ok) assertEquals(junk.scopes, ["channel:manage:redemptions"]);
});

Deno.test("parseTokenResponse: 401/error body is a failure with a message", () => {
  const r = parseTokenResponse({
    status: 400,
    message: "Invalid refresh token",
  });
  assert(!r.ok);
  if (!r.ok) assertEquals(r.message, "Invalid refresh token");

  const r2 = parseTokenResponse("not an object");
  assert(!r2.ok);
});

Deno.test("parseUsersResponse: reads the first user id/login, else null", () => {
  assertEquals(
    parseUsersResponse({ data: [{ id: "12345", login: "streamer" }] }),
    { id: "12345", login: "streamer" },
  );
  assertEquals(parseUsersResponse({ data: [] }), null);
  assertEquals(parseUsersResponse({}), null);
  assertEquals(parseUsersResponse({ data: [{ login: "no-id" }] }), null);
});

Deno.test("buildUsersRequest: Helix /users with client-id + bearer", () => {
  const req = buildUsersRequest("Some_Streamer", "cid", "AT");
  assertEquals(
    req.url,
    "https://api.twitch.tv/helix/users?login=Some_Streamer",
  );
  assertEquals(req.headers["client-id"], "cid");
  assertEquals(req.headers["authorization"], "Bearer AT");
});

Deno.test("SUBSCRIPTIONS + EVENTSUB_SCOPES: complete, deduped scope set", () => {
  const types = SUBSCRIPTIONS.map((s) => s.type);
  for (
    const t of [
      "channel.follow",
      "channel.cheer",
      "channel.subscribe",
      "channel.subscription.gift",
      "channel.subscription.message",
      "channel.raid",
      "channel.channel_points_custom_reward_redemption.add",
      "channel.channel_points_custom_reward_redemption.update",
    ]
  ) {
    assert(types.includes(t), `missing subscription ${t}`);
  }
  // follow is v2; raid needs no scope.
  const follow = SUBSCRIPTIONS.find((s) => s.type === "channel.follow")!;
  assertEquals(follow.version, "2");
  assertEquals(follow.condition("42"), {
    broadcaster_user_id: "42",
    moderator_user_id: "42",
  });
  const raid = SUBSCRIPTIONS.find((s) => s.type === "channel.raid")!;
  assertEquals(raid.scope, null);
  assertEquals(raid.condition("42"), { to_broadcaster_user_id: "42" });

  assertEquals([...EVENTSUB_SCOPES].sort(), [
    "bits:read",
    "channel:manage:redemptions",
    "channel:read:subscriptions",
    "moderator:read:followers",
  ]);
});

Deno.test("redemption subscriptions: v1, broadcaster-wide, manage scope, gated", () => {
  for (
    const type of [
      "channel.channel_points_custom_reward_redemption.add",
      "channel.channel_points_custom_reward_redemption.update",
    ]
  ) {
    const spec = SUBSCRIPTIONS.find((s) => s.type === type)!;
    assertEquals(spec.version, "1");
    // No reward_id: one subscription covers every managed reward.
    assertEquals(spec.condition("42"), { broadcaster_user_id: "42" });
    assertEquals(spec.scope, REDEMPTIONS_MANAGE_SCOPE);
    assertEquals(spec.feature, "channelPoints");
  }
  assertEquals(REDEMPTIONS_MANAGE_SCOPE, "channel:manage:redemptions");
});

Deno.test("subscriptionsFor: gated specs only for channels that opted in", () => {
  const plain = subscriptionsFor([]).map((s) => s.type);
  assertEquals(plain.length, SUBSCRIPTIONS.length - 2);
  assert(!plain.some((t) => t.includes("channel_points")));
  // Every ungated spec is still there for an ordinary channel.
  assert(plain.includes("channel.follow"));
  assert(plain.includes("channel.raid"));

  const cp = subscriptionsFor(["channelPoints"]).map((s) => s.type);
  assertEquals(cp.length, SUBSCRIPTIONS.length);
  assert(cp.includes("channel.channel_points_custom_reward_redemption.add"));
  assert(cp.includes("channel.channel_points_custom_reward_redemption.update"));
});

Deno.test("buildCreateSubscriptionRequest: websocket transport body", () => {
  const spec = SUBSCRIPTIONS.find((s) => s.type === "channel.cheer")!;
  const req = buildCreateSubscriptionRequest(spec, "42", "sess-1", "cid", "AT");
  assertEquals(req.url, "https://api.twitch.tv/helix/eventsub/subscriptions");
  assertEquals(req.headers["authorization"], "Bearer AT");
  assertEquals(req.headers["client-id"], "cid");
  const body = JSON.parse(req.body!);
  assertEquals(body.type, "channel.cheer");
  assertEquals(body.version, "1");
  assertEquals(body.condition, { broadcaster_user_id: "42" });
  assertEquals(body.transport, { method: "websocket", session_id: "sess-1" });
});

Deno.test("LOGIN_SCOPES: EVENTSUB_SCOPES plus chat write, EVENTSUB_SCOPES unchanged", () => {
  // The login flow must request the chat-write scope for giveaway replies…
  assert(LOGIN_SCOPES.includes(CHAT_WRITE_SCOPE));
  assertEquals(CHAT_WRITE_SCOPE, "user:write:chat");
  // …and the redemptions scope channel points need (subs + Helix both)…
  assert(LOGIN_SCOPES.includes(REDEMPTIONS_MANAGE_SCOPE));
  // …on top of every EventSub scope…
  for (const s of EVENTSUB_SCOPES) assert(LOGIN_SCOPES.includes(s));
  // …but the EventSub scope set itself must stay exactly the subscription set
  // (SUBSCRIPTIONS drives EventSub creation — user:write:chat is not one of them).
  assert(!EVENTSUB_SCOPES.includes(CHAT_WRITE_SCOPE));
  assertEquals(new Set(LOGIN_SCOPES).size, LOGIN_SCOPES.length); // no dupes
});

Deno.test("buildCheckFollowRequest: Get Channel Followers filtered by user_id", () => {
  const req = buildCheckFollowRequest("42", "1001", "cid", "AT");
  const u = new URL(req.url);
  assertEquals(
    u.origin + u.pathname,
    "https://api.twitch.tv/helix/channels/followers",
  );
  assertEquals(u.searchParams.get("broadcaster_id"), "42");
  assertEquals(u.searchParams.get("user_id"), "1001");
  assertEquals(req.method, "GET");
  assertEquals(req.headers["client-id"], "cid");
  assertEquals(req.headers["authorization"], "Bearer AT");
});

Deno.test("parseFollowersResponse: non-empty data means following", () => {
  assert(parseFollowersResponse({ data: [{ user_id: "1001" }], total: 5 }));
  assert(!parseFollowersResponse({ data: [], total: 5 })); // filtered → empty = not following
  assert(!parseFollowersResponse({}));
  assert(!parseFollowersResponse(null));
  assert(!parseFollowersResponse("nope"));
});

Deno.test("buildSendChatMessageRequest: Helix POST /chat/messages as sender", () => {
  const req = buildSendChatMessageRequest(
    "42",
    "42",
    "you're in!",
    "cid",
    "AT",
  );
  assertEquals(req.url, "https://api.twitch.tv/helix/chat/messages");
  assertEquals(req.method, "POST");
  assertEquals(req.headers["client-id"], "cid");
  assertEquals(req.headers["authorization"], "Bearer AT");
  assertEquals(req.headers["content-type"], "application/json");
  const body = JSON.parse(req.body!);
  assertEquals(body, {
    broadcaster_id: "42",
    sender_id: "42",
    message: "you're in!",
  });
});

Deno.test("parseCreateSubscriptionResponse: 202 ok, 403 scope failure, 401 refresh", () => {
  assertEquals(parseCreateSubscriptionResponse(202, {}), { ok: true });

  const forbidden = parseCreateSubscriptionResponse(403, {
    error: "Forbidden",
    status: 403,
    message: "missing scope",
  });
  assert(!forbidden.ok);
  if (!forbidden.ok) {
    assertEquals(forbidden.status, 403);
    assertEquals(forbidden.message, "missing scope");
  }

  const unauth = parseCreateSubscriptionResponse(401, {});
  assert(!unauth.ok);
  if (!unauth.ok) assertEquals(unauth.status, 401);
});

// ---- channel-point custom rewards + redemptions -----------------------------

Deno.test("buildGetCustomRewardsRequest: manageable-only by default", () => {
  const req = buildGetCustomRewardsRequest("42", "cid", "AT");
  const u = new URL(req.url);
  assertEquals(
    u.origin + u.pathname,
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  assertEquals(u.searchParams.get("broadcaster_id"), "42");
  assertEquals(u.searchParams.get("only_manageable_rewards"), "true");
  assertEquals(req.method, "GET");
  assertEquals(req.headers["client-id"], "cid");
  assertEquals(req.headers["authorization"], "Bearer AT");
  assertEquals(req.body, undefined);

  const all = buildGetCustomRewardsRequest("42", "cid", "AT", false);
  assertEquals(
    new URL(all.url).searchParams.get("only_manageable_rewards"),
    null,
  );
});

Deno.test("buildCreateCustomRewardRequest: POST the full body as JSON", () => {
  const req = buildCreateCustomRewardRequest(
    "42",
    { title: "Butterfingers", cost: 250, is_global_cooldown_enabled: true },
    "cid",
    "AT",
  );
  assertEquals(req.method, "POST");
  assertEquals(new URL(req.url).searchParams.get("broadcaster_id"), "42");
  assertEquals(req.headers["content-type"], "application/json");
  assertEquals(JSON.parse(req.body!), {
    title: "Butterfingers",
    cost: 250,
    is_global_cooldown_enabled: true,
  });
});

Deno.test("buildUpdateCustomRewardRequest: PATCH ?broadcaster_id&id, just the fields", () => {
  const req = buildUpdateCustomRewardRequest(
    "42",
    "rw-1",
    { is_paused: true },
    "cid",
    "AT",
  );
  const u = new URL(req.url);
  assertEquals(req.method, "PATCH");
  assertEquals(u.searchParams.get("broadcaster_id"), "42");
  assertEquals(u.searchParams.get("id"), "rw-1");
  assertEquals(JSON.parse(req.body!), { is_paused: true });
});

Deno.test("buildGetRedemptionsRequest: UNFULFILLED, oldest first, 50 a page, cursor", () => {
  const req = buildGetRedemptionsRequest("42", "rw-1", "cid", "AT");
  const u = new URL(req.url);
  assertEquals(
    u.origin + u.pathname,
    "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions",
  );
  assertEquals(u.searchParams.get("broadcaster_id"), "42");
  assertEquals(u.searchParams.get("reward_id"), "rw-1");
  assertEquals(u.searchParams.get("status"), "UNFULFILLED");
  assertEquals(u.searchParams.get("sort"), "OLDEST");
  assertEquals(u.searchParams.get("first"), "50");
  assertEquals(u.searchParams.get("after"), null);
  assertEquals(req.method, "GET");

  const next = buildGetRedemptionsRequest("42", "rw-1", "cid", "AT", "CUR");
  assertEquals(new URL(next.url).searchParams.get("after"), "CUR");
});

Deno.test("buildUpdateRedemptionStatusRequest: repeated ids, status body, 1..50", () => {
  const req = buildUpdateRedemptionStatusRequest(
    "42",
    "rw-1",
    ["a", "b"],
    "CANCELED",
    "cid",
    "AT",
  );
  const u = new URL(req.url);
  assertEquals(req.method, "PATCH");
  assertEquals(u.searchParams.get("broadcaster_id"), "42");
  assertEquals(u.searchParams.get("reward_id"), "rw-1");
  assertEquals(u.searchParams.getAll("id"), ["a", "b"]);
  assertEquals(JSON.parse(req.body!), { status: "CANCELED" });

  // A caller bug must not silently drop ids that would then look synced.
  assertThrows(() =>
    buildUpdateRedemptionStatusRequest("42", "rw", [], "FULFILLED", "c", "t")
  );
  const fiftyOne = Array.from({ length: 51 }, (_, i) => `id${i}`);
  assertThrows(() =>
    buildUpdateRedemptionStatusRequest(
      "42",
      "rw",
      fiftyOne,
      "FULFILLED",
      "c",
      "t",
    )
  );
  const fifty = buildUpdateRedemptionStatusRequest(
    "42",
    "rw",
    fiftyOne.slice(0, 50),
    "FULFILLED",
    "c",
    "t",
  );
  assertEquals(new URL(fifty.url).searchParams.getAll("id").length, 50);
});

Deno.test("parseHelixResponse: ok carries the body; errors classified", () => {
  const ok = parseHelixResponse(200, { data: [1] });
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.json, { data: [1] });

  const kind = (status: number, json: unknown = {}) => {
    const r = parseHelixResponse(status, json);
    return r.ok ? "ok" : r.kind;
  };
  assertEquals(kind(204), "ok");
  assertEquals(kind(401), "unauthorized");
  assertEquals(
    kind(400, {
      error: "Bad Request",
      status: 400,
      message: "CREATE_CUSTOM_REWARD_DUPLICATE_REWARD",
    }),
    "duplicate",
  );
  assertEquals(kind(400, { message: "title too long" }), "error");
  assertEquals(kind(403), "forbidden");
  assertEquals(kind(404), "not_found");
  assertEquals(kind(429), "rate_limited");
  assertEquals(kind(500), "error");
  assertEquals(kind(0), "error");

  const msg = parseHelixResponse(403, { message: "not a partner" });
  assert(!msg.ok);
  if (!msg.ok) assertEquals(msg.message, "not a partner");
  const bare = parseHelixResponse(502, null);
  assert(!bare.ok);
  if (!bare.ok) assertEquals(bare.message, "HTTP 502");
});

Deno.test("parseCustomRewardsResponse: reads the Helix reward shape, drops junk", () => {
  const rewards = parseCustomRewardsResponse({
    data: [
      {
        id: "rw-1",
        title: "Butterfingers",
        prompt: "p",
        cost: 250,
        background_color: "#9aa5b1",
        is_enabled: true,
        is_paused: false,
        is_user_input_required: false,
        should_redemptions_skip_request_queue: false,
        max_per_stream_setting: { is_enabled: true, max_per_stream: 5 },
        max_per_user_per_stream_setting: {
          is_enabled: false,
          max_per_user_per_stream: 0,
        },
        global_cooldown_setting: {
          is_enabled: true,
          global_cooldown_seconds: 60,
        },
      },
      { title: "no id" },
      "junk",
    ],
  });
  assertEquals(rewards, [{
    id: "rw-1",
    title: "Butterfingers",
    prompt: "p",
    cost: 250,
    backgroundColor: "#9aa5b1",
    isEnabled: true,
    isPaused: false,
    isUserInputRequired: false,
    skipRequestQueue: false,
    maxPerStream: { enabled: true, value: 5 },
    maxPerUserPerStream: { enabled: false, value: 0 },
    globalCooldown: { enabled: true, seconds: 60 },
  }]);
  assertEquals(parseCustomRewardsResponse(null), []);
  assertEquals(parseCustomRewardsResponse({ data: "nope" }), []);
});

Deno.test("parseRedemptionsResponse: page + cursor, reward id required", () => {
  const page = parseRedemptionsResponse({
    data: [
      {
        id: "red-1",
        user_id: "1001",
        user_login: "ann",
        user_name: "Ann",
        status: "UNFULFILLED",
        redeemed_at: "2026-09-25T17:16:03Z",
        reward: { id: "rw-1", title: "Butterfingers", cost: 250 },
      },
      { id: "red-2", reward: {} }, // no reward id → can't be fulfilled, dropped
      { reward: { id: "rw-1" } }, // no redemption id → dropped
    ],
    pagination: { cursor: "NEXT" },
  });
  assertEquals(page.cursor, "NEXT");
  assertEquals(page.redemptions, [{
    id: "red-1",
    rewardId: "rw-1",
    rewardTitle: "Butterfingers",
    rewardCost: 250,
    userId: "1001",
    userLogin: "ann",
    userName: "Ann",
    status: "UNFULFILLED",
    redeemedAt: Date.parse("2026-09-25T17:16:03Z"),
  }]);
  // The last page has an empty pagination object.
  assertEquals(parseRedemptionsResponse({ data: [], pagination: {} }), {
    redemptions: [],
    cursor: "",
  });
  assertEquals(parseRedemptionsResponse(null).redemptions, []);
});

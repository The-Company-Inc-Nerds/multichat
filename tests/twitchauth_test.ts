import {
  buildAuthCodeRequest,
  buildAuthorizeUrl,
  buildCreateSubscriptionRequest,
  buildRefreshRequest,
  buildUsersRequest,
  EVENTSUB_SCOPES,
  parseCreateSubscriptionResponse,
  parseTokenResponse,
  parseUsersResponse,
  SUBSCRIPTIONS,
} from "../src/twitchauth.ts";
import { assert, assertEquals } from "./_assert.ts";

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
  }
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
    "channel:read:subscriptions",
    "moderator:read:followers",
  ]);
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

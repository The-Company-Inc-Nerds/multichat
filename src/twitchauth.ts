// Pure Twitch OAuth + EventSub request/response helpers (the trust-free layer).
//
// Everything here is side-effect-free: it builds request descriptors and parses
// JSON responses, so the test suite can drive it without a network. The actual
// `fetch` + token persistence lives in the EventSub manager in main.ts, mirroring
// the "pure helpers in src/, wiring in main.ts" split used by control.ts.
//
// Auth model (see docs/configuration.md): EventSub over WebSocket requires a USER
// access token, and one WS session may only use one user's token — so every
// monitored channel has its own broadcaster token. User tokens are short-lived and
// refresh tokens rotate on every refresh, so the manager refreshes reactively on a
// 401 and persists the new refresh token before using the new access token.

const OAUTH_BASE = "https://id.twitch.tv/oauth2";
const HELIX_BASE = "https://api.twitch.tv/helix";

/** A ready-to-issue HTTP request, so callers just hand it to `fetch`. */
export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** One EventSub subscription this server creates for each covered channel. */
export interface SubscriptionSpec {
  type: string;
  version: string;
  scope: string | null; // OAuth scope the token must carry (null = none needed)
  condition: (broadcasterId: string) => Record<string, string>;
}

// The single source of truth for what we subscribe to. `channel.follow` v2 uses
// the broadcaster as their own moderator (a broadcaster moderates their own
// channel), which is why moderator_user_id == broadcaster_user_id.
export const SUBSCRIPTIONS: readonly SubscriptionSpec[] = [
  {
    type: "channel.follow",
    version: "2",
    scope: "moderator:read:followers",
    condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }),
  },
  {
    type: "channel.cheer",
    version: "1",
    scope: "bits:read",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscribe",
    version: "1",
    scope: "channel:read:subscriptions",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.gift",
    version: "1",
    scope: "channel:read:subscriptions",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.message",
    version: "1",
    scope: "channel:read:subscriptions",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.raid",
    version: "1",
    scope: null,
    condition: (id) => ({ to_broadcaster_user_id: id }),
  },
];

/** The distinct OAuth scopes needed for all of SUBSCRIPTIONS, for the login flow. */
export const EVENTSUB_SCOPES: readonly string[] = [
  ...new Set(
    SUBSCRIPTIONS.map((s) => s.scope).filter((s): s is string => s !== null),
  ),
];

// ---- OAuth token flows ----------------------------------------------------

/** Authorization-code grant: exchange a `?code` (from the login redirect) for tokens. */
export function buildAuthCodeRequest(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): HttpRequest {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  return {
    url: `${OAUTH_BASE}/token`,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

/** Refresh-token grant: mint a fresh access token (and a rotated refresh token). */
export function buildRefreshRequest(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): HttpRequest {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return {
    url: `${OAUTH_BASE}/token`,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

/** The browser URL the operator visits to authorize the app (login flow). */
export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  scopes: readonly string[],
  state: string,
): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
  });
  return `${OAUTH_BASE}/authorize?${q.toString()}`;
}

export type TokenResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresIn: number }
  | { ok: false; message: string };

function asObj(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null
    ? x as Record<string, unknown>
    : null;
}

/** Parse an id.twitch.tv/oauth2/token response (works for both grant types). */
export function parseTokenResponse(json: unknown): TokenResult {
  const o = asObj(json);
  if (!o) return { ok: false, message: "token response was not an object" };
  if (
    typeof o.access_token === "string" && typeof o.refresh_token === "string"
  ) {
    return {
      ok: true,
      accessToken: o.access_token,
      refreshToken: o.refresh_token,
      expiresIn: typeof o.expires_in === "number" ? o.expires_in : 0,
    };
  }
  const msg = typeof o.message === "string" && o.message
    ? o.message
    : typeof o.error === "string"
    ? o.error
    : "missing access_token/refresh_token";
  return { ok: false, message: msg };
}

// ---- Helix: resolve a login to a broadcaster user id ----------------------

export function buildUsersRequest(
  login: string,
  clientId: string,
  accessToken: string,
): HttpRequest {
  // An empty login asks Helix for the token's own user (used by `twitch-login` to
  // learn the authorizing broadcaster's id); a login queries that specific user.
  const query = login ? `?login=${encodeURIComponent(login)}` : "";
  return {
    url: `${HELIX_BASE}/users${query}`,
    method: "GET",
    headers: {
      "client-id": clientId,
      "authorization": `Bearer ${accessToken}`,
    },
  };
}

/** Pull the first user's id/login out of a Helix /users response, or null. */
export function parseUsersResponse(
  json: unknown,
): { id: string; login: string } | null {
  const o = asObj(json);
  const data = o?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = asObj(data[0]);
  const id = first?.id;
  if (typeof id !== "string" || !id) return null;
  const login = typeof first?.login === "string" ? first.login : "";
  return { id, login };
}

// ---- Helix: create an EventSub (WebSocket transport) subscription ----------

export function buildCreateSubscriptionRequest(
  spec: SubscriptionSpec,
  broadcasterId: string,
  sessionId: string,
  clientId: string,
  accessToken: string,
): HttpRequest {
  return {
    url: `${HELIX_BASE}/eventsub/subscriptions`,
    method: "POST",
    headers: {
      "client-id": clientId,
      "authorization": `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: spec.type,
      version: spec.version,
      condition: spec.condition(broadcasterId),
      transport: { method: "websocket", session_id: sessionId },
    }),
  };
}

export type CreateSubResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/** Judge a create-subscription HTTP result. 202 Accepted is success; a 401 means
 *  the access token needs refreshing; other 4xx are per-sub failures (e.g. a
 *  missing scope 403) the caller logs without tearing down the whole socket. */
export function parseCreateSubscriptionResponse(
  status: number,
  json: unknown,
): CreateSubResult {
  if (status >= 200 && status < 300) return { ok: true };
  const o = asObj(json);
  const message = typeof o?.message === "string" && o.message
    ? o.message
    : `HTTP ${status}`;
  return { ok: false, status, message };
}

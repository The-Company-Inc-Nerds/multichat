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

/** A per-channel opt-in some subscriptions sit behind. A spec tagged with a
 *  feature is only created for channels that have it switched on, so a channel
 *  that never granted the scope doesn't log a 403 on every reconnect. */
export type SubscriptionFeature = "channelPoints";

/** One EventSub subscription this server creates for each covered channel. */
export interface SubscriptionSpec {
  type: string;
  version: string;
  scope: string | null; // OAuth scope the token must carry (null = none needed)
  condition: (broadcasterId: string) => Record<string, string>;
  /** Only created for channels with this feature on (absent = every channel). */
  feature?: SubscriptionFeature;
}

/** Scope for the channel-points pipeline: it covers the redemption EventSub
 *  subscriptions AND every custom-reward Helix call (create/update rewards, list
 *  and fulfil/refund redemptions), so one scope serves both halves. */
export const REDEMPTIONS_MANAGE_SCOPE = "channel:manage:redemptions";

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
  // Channel-point redemptions, broadcaster-wide (no reward_id): the app filters
  // to the rewards it created itself, so one subscription survives catalogue
  // edits. `.update` reports a status change made elsewhere (the streamer
  // fulfilling/refunding in the rewards queue) — and echoes our own PATCHes.
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    scope: REDEMPTIONS_MANAGE_SCOPE,
    condition: (id) => ({ broadcaster_user_id: id }),
    feature: "channelPoints",
  },
  {
    type: "channel.channel_points_custom_reward_redemption.update",
    version: "1",
    scope: REDEMPTIONS_MANAGE_SCOPE,
    condition: (id) => ({ broadcaster_user_id: id }),
    feature: "channelPoints",
  },
];

/** The subscriptions to create for one channel: every untagged spec plus the
 *  ones whose feature the channel has switched on. */
export function subscriptionsFor(
  features: readonly SubscriptionFeature[],
): SubscriptionSpec[] {
  return SUBSCRIPTIONS.filter((s) =>
    !s.feature || features.includes(s.feature)
  );
}

/** The distinct OAuth scopes needed for all of SUBSCRIPTIONS, for the login flow. */
export const EVENTSUB_SCOPES: readonly string[] = [
  ...new Set(
    SUBSCRIPTIONS.map((s) => s.scope).filter((s): s is string => s !== null),
  ),
];

/** Scope for sending chat messages via Helix (the giveaway replies). It is a
 *  Helix *action* scope, not an EventSub subscription, so it is kept out of
 *  SUBSCRIPTIONS/EVENTSUB_SCOPES and only added to the login flow via LOGIN_SCOPES. */
export const CHAT_WRITE_SCOPE = "user:write:chat";

/** The scopes the `login` flow requests: everything EventSub needs (which now
 *  includes channel:manage:redemptions, via the redemption subscriptions), plus
 *  chat write so the optional giveaway replies work. Existing tokens minted
 *  before a scope was added keep working for everything else but lack the new
 *  one until the operator re-runs `multichat login` — and replaces the persisted
 *  rotated token, which otherwise wins over the new seed (see
 *  docs/configuration.md). */
export const LOGIN_SCOPES: readonly string[] = [
  ...EVENTSUB_SCOPES,
  CHAT_WRITE_SCOPE,
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

/** `scopes` is what the token actually carries, copied from the response's
 *  `scope` array — present only when Twitch sent one, so a missing array reads
 *  as "unknown" rather than "no scopes". */
export type TokenResult =
  | {
    ok: true;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    scopes?: string[];
  }
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
    const result: TokenResult = {
      ok: true,
      accessToken: o.access_token,
      refreshToken: o.refresh_token,
      expiresIn: typeof o.expires_in === "number" ? o.expires_in : 0,
    };
    // Both grants echo the granted scopes; keeping them is what lets startup
    // notice a token minted before a scope was added (e.g. the redemptions one).
    if (Array.isArray(o.scope)) {
      result.scopes = o.scope.filter((s): s is string => typeof s === "string");
    }
    return result;
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

// ---- Helix: per-viewer follow check (giveaway eligibility) ----------------

/** Check whether `userId` follows `broadcasterId` (Get Channel Followers,
 *  filtered by user_id). Needs a user token for the broadcaster — or one of their
 *  moderators — carrying `moderator:read:followers` (already an EventSub scope). */
export function buildCheckFollowRequest(
  broadcasterId: string,
  userId: string,
  clientId: string,
  accessToken: string,
): HttpRequest {
  const q = new URLSearchParams({
    broadcaster_id: broadcasterId,
    user_id: userId,
  });
  return {
    url: `${HELIX_BASE}/channels/followers?${q.toString()}`,
    method: "GET",
    headers: {
      "client-id": clientId,
      "authorization": `Bearer ${accessToken}`,
    },
  };
}

/** True when a Get Channel Followers response (filtered by user_id) shows the
 *  user is a follower: a well-formed body with a non-empty `data` array. A
 *  not-following result is a 200 with an empty `data` array. */
export function parseFollowersResponse(json: unknown): boolean {
  const o = asObj(json);
  return Array.isArray(o?.data) && o.data.length > 0;
}

// ---- Helix: send a chat message (giveaway replies) ------------------------

/** Post `message` to `broadcasterId`'s chat as `senderId` (pass the broadcaster's
 *  own id to send as the broadcaster). Needs a user token carrying
 *  `user:write:chat` (see CHAT_WRITE_SCOPE / LOGIN_SCOPES). */
export function buildSendChatMessageRequest(
  broadcasterId: string,
  senderId: string,
  message: string,
  clientId: string,
  accessToken: string,
): HttpRequest {
  return {
    url: `${HELIX_BASE}/chat/messages`,
    method: "POST",
    headers: {
      "client-id": clientId,
      "authorization": `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message,
    }),
  };
}

// ---- Helix: channel-point custom rewards + redemptions --------------------
// Every call needs the BROADCASTER's user token carrying channel:manage:redemptions
// (REDEMPTIONS_MANAGE_SCOPE), and Twitch only lets the Client ID that CREATED a
// reward update it, list its redemptions or fulfil/refund them — which is why the
// channel-points engine provisions its own rewards instead of adopting ones made
// in the dashboard. See src/channelpoints.ts for the pure logic that drives these.

/** The writable fields of a custom reward, in Helix's own snake_case, for the
 *  Create (POST) and Update (PATCH) bodies. PATCH sends only the fields that
 *  changed; `is_paused` exists on PATCH only (Create has no such field). */
export interface CustomRewardFields {
  title?: string;
  cost?: number;
  prompt?: string;
  is_enabled?: boolean;
  background_color?: string;
  is_user_input_required?: boolean;
  is_max_per_stream_enabled?: boolean;
  max_per_stream?: number;
  is_max_per_user_per_stream_enabled?: boolean;
  max_per_user_per_stream?: number;
  is_global_cooldown_enabled?: boolean;
  global_cooldown_seconds?: number;
  is_paused?: boolean;
  should_redemptions_skip_request_queue?: boolean;
}

function helixHeaders(
  clientId: string,
  accessToken: string,
  json: boolean,
): Record<string, string> {
  return {
    "client-id": clientId,
    "authorization": `Bearer ${accessToken}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

/** Get Custom Reward. `onlyManageable` (the default) limits the list to rewards
 *  this Client ID created — the only ones the pipeline can drive. */
export function buildGetCustomRewardsRequest(
  broadcasterId: string,
  clientId: string,
  accessToken: string,
  onlyManageable = true,
): HttpRequest {
  const q = new URLSearchParams({ broadcaster_id: broadcasterId });
  if (onlyManageable) q.set("only_manageable_rewards", "true");
  return {
    url: `${HELIX_BASE}/channel_points/custom_rewards?${q.toString()}`,
    method: "GET",
    headers: helixHeaders(clientId, accessToken, false),
  };
}

/** Create Custom Rewards. Twitch requires `title` (≤45, unique across the whole
 *  channel) and `cost` (≥1); the caller supplies a complete body. */
export function buildCreateCustomRewardRequest(
  broadcasterId: string,
  fields: CustomRewardFields,
  clientId: string,
  accessToken: string,
): HttpRequest {
  const q = new URLSearchParams({ broadcaster_id: broadcasterId });
  return {
    url: `${HELIX_BASE}/channel_points/custom_rewards?${q.toString()}`,
    method: "POST",
    headers: helixHeaders(clientId, accessToken, true),
    body: JSON.stringify(fields),
  };
}

/** Update Custom Reward: PATCH just `fields` (drift corrections, `is_paused`,
 *  `is_enabled:false` for a retired reward — never DELETE, which would mark the
 *  reward's pending redemptions FULFILLED without a refund). */
export function buildUpdateCustomRewardRequest(
  broadcasterId: string,
  rewardId: string,
  fields: CustomRewardFields,
  clientId: string,
  accessToken: string,
): HttpRequest {
  const q = new URLSearchParams({
    broadcaster_id: broadcasterId,
    id: rewardId,
  });
  return {
    url: `${HELIX_BASE}/channel_points/custom_rewards?${q.toString()}`,
    method: "PATCH",
    headers: helixHeaders(clientId, accessToken, true),
    body: JSON.stringify(fields),
  };
}

/** Get Custom Reward Redemption: one page (≤50, oldest first) of a reward's
 *  UNFULFILLED redemptions — the reconcile pass that recovers redemptions made
 *  while the EventSub socket was down (EventSub never replays them). */
export function buildGetRedemptionsRequest(
  broadcasterId: string,
  rewardId: string,
  clientId: string,
  accessToken: string,
  after = "",
): HttpRequest {
  const q = new URLSearchParams({
    broadcaster_id: broadcasterId,
    reward_id: rewardId,
    status: "UNFULFILLED",
    sort: "OLDEST",
    first: "50",
  });
  if (after) q.set("after", after);
  return {
    url:
      `${HELIX_BASE}/channel_points/custom_rewards/redemptions?${q.toString()}`,
    method: "GET",
    headers: helixHeaders(clientId, accessToken, false),
  };
}

/** The most redemption ids one Update Redemption Status call accepts. */
export const MAX_REDEMPTION_IDS = 50;

/** Update Redemption Status: FULFILLED, or CANCELED (which refunds the points),
 *  for up to 50 redemptions of ONE reward. Only UNFULFILLED redemptions can be
 *  updated — a 404 means they were already resolved (terminal, not an error).
 *  Throws on an empty or oversized batch: that is a caller bug, and silently
 *  truncating would leave redemptions believed-synced but still holding points. */
export function buildUpdateRedemptionStatusRequest(
  broadcasterId: string,
  rewardId: string,
  redemptionIds: readonly string[],
  status: "FULFILLED" | "CANCELED",
  clientId: string,
  accessToken: string,
): HttpRequest {
  if (
    redemptionIds.length === 0 || redemptionIds.length > MAX_REDEMPTION_IDS
  ) {
    throw new RangeError(
      `Update Redemption Status takes 1..${MAX_REDEMPTION_IDS} ids, got ${redemptionIds.length}`,
    );
  }
  const q = new URLSearchParams({
    broadcaster_id: broadcasterId,
    reward_id: rewardId,
  });
  for (const id of redemptionIds) q.append("id", id);
  return {
    url:
      `${HELIX_BASE}/channel_points/custom_rewards/redemptions?${q.toString()}`,
    method: "PATCH",
    headers: helixHeaders(clientId, accessToken, true),
    body: JSON.stringify({ status }),
  };
}

/** Why a Helix call failed, in the terms the channel-points engine acts on:
 *  `unauthorized` → refresh the token once and retry; `duplicate` → a reward
 *  title already exists on the channel (400 CREATE_CUSTOM_REWARD_DUPLICATE_REWARD);
 *  `forbidden` → not Affiliate/Partner, or a reward another Client ID created;
 *  `not_found` → for a redemption update, it is no longer UNFULFILLED (terminal). */
export type HelixErrorKind =
  | "unauthorized"
  | "duplicate"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "error";

export type HelixResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number; kind: HelixErrorKind; message: string };

/** Judge a Helix HTTP result (status 0 = the request never got an answer). The
 *  raw body rides along on success for the endpoint-specific parser below. */
export function parseHelixResponse(status: number, json: unknown): HelixResult {
  if (status >= 200 && status < 300) return { ok: true, status, json };
  const o = asObj(json);
  const message = typeof o?.message === "string" && o.message
    ? o.message
    : status
    ? `HTTP ${status}`
    : "no response";
  const kind: HelixErrorKind = status === 401
    ? "unauthorized"
    : status === 400 && /DUPLICATE/i.test(message)
    ? "duplicate"
    : status === 403
    ? "forbidden"
    : status === 404
    ? "not_found"
    : status === 429
    ? "rate_limited"
    : "error";
  return { ok: false, status, kind, message };
}

/** One custom reward as Helix reports it (Get / Create / Update all return this
 *  shape in `data`), trimmed to what the sync diff compares. */
export interface TwitchCustomReward {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  backgroundColor: string;
  isEnabled: boolean;
  isPaused: boolean;
  isUserInputRequired: boolean;
  skipRequestQueue: boolean;
  maxPerStream: { enabled: boolean; value: number };
  maxPerUserPerStream: { enabled: boolean; value: number };
  globalCooldown: { enabled: boolean; seconds: number };
}

const bool = (x: unknown): boolean => x === true;
const int = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

function parseCustomReward(x: unknown): TwitchCustomReward | null {
  const o = asObj(x);
  if (!o || typeof o.id !== "string" || !o.id) return null;
  const mps = asObj(o.max_per_stream_setting);
  const mpu = asObj(o.max_per_user_per_stream_setting);
  const gc = asObj(o.global_cooldown_setting);
  return {
    id: o.id,
    title: typeof o.title === "string" ? o.title : "",
    prompt: typeof o.prompt === "string" ? o.prompt : "",
    cost: int(o.cost),
    backgroundColor: typeof o.background_color === "string"
      ? o.background_color
      : "",
    isEnabled: bool(o.is_enabled),
    isPaused: bool(o.is_paused),
    isUserInputRequired: bool(o.is_user_input_required),
    skipRequestQueue: bool(o.should_redemptions_skip_request_queue),
    maxPerStream: {
      enabled: bool(mps?.is_enabled),
      value: int(mps?.max_per_stream),
    },
    maxPerUserPerStream: {
      enabled: bool(mpu?.is_enabled),
      value: int(mpu?.max_per_user_per_stream),
    },
    globalCooldown: {
      enabled: bool(gc?.is_enabled),
      seconds: int(gc?.global_cooldown_seconds),
    },
  };
}

/** The rewards in a Get/Create/Update Custom Reward response (id-less entries
 *  dropped; a malformed body is an empty list). */
export function parseCustomRewardsResponse(
  json: unknown,
): TwitchCustomReward[] {
  const data = asObj(json)?.data;
  if (!Array.isArray(data)) return [];
  return data.map(parseCustomReward).filter((r): r is TwitchCustomReward =>
    r !== null
  );
}

/** One redemption from Get Custom Reward Redemption. `status` is Helix's
 *  UPPERCASE form (EventSub reports the same thing in lowercase). */
export interface TwitchRedemption {
  id: string;
  rewardId: string;
  rewardTitle: string;
  rewardCost: number;
  userId: string;
  userLogin: string;
  userName: string;
  status: string;
  /** Epoch ms of redeemed_at (0 when absent/unparseable). */
  redeemedAt: number;
}

/** A page of redemptions plus the cursor for the next one ("" = last page). */
export function parseRedemptionsResponse(
  json: unknown,
): { redemptions: TwitchRedemption[]; cursor: string } {
  const o = asObj(json);
  const out: TwitchRedemption[] = [];
  if (Array.isArray(o?.data)) {
    for (const x of o.data) {
      const r = asObj(x);
      const reward = asObj(r?.reward);
      if (!r || typeof r.id !== "string" || !r.id) continue;
      if (typeof reward?.id !== "string" || !reward.id) continue;
      const at = Date.parse(
        typeof r.redeemed_at === "string" ? r.redeemed_at : "",
      );
      out.push({
        id: r.id,
        rewardId: reward.id,
        rewardTitle: typeof reward.title === "string" ? reward.title : "",
        rewardCost: int(reward.cost),
        userId: typeof r.user_id === "string" ? r.user_id : "",
        userLogin: typeof r.user_login === "string" ? r.user_login : "",
        userName: typeof r.user_name === "string" ? r.user_name : "",
        status: typeof r.status === "string" ? r.status : "",
        redeemedAt: Number.isFinite(at) ? at : 0,
      });
    }
  }
  const cursor = asObj(o?.pagination)?.cursor;
  return { redemptions: out, cursor: typeof cursor === "string" ? cursor : "" };
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

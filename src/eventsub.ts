// Twitch EventSub over WebSocket — the source of truth for a channel's follow /
// cheer / sub / raid shoutouts (IRC only carries chat text for covered channels;
// see the `isCovered` predicate in twitch.ts). YouTube shoutouts still come from
// the API poller. Mapped events flow through the very same `Emitter` as chat, so
// SSE / rendering / the /alerts overlay are all identical downstream.
//
// Convention mirrors twitch.ts: the pure notification→ChatMessage mappers and the
// pure frame classifiers are `export`ed and unit-tested with a fake Emitter; the
// socket-holding `connectOnce` / `startTwitchEventSub` are the untestable wiring.
//
// EventSub over WebSocket is RECEIVE-ONLY: never `send()` on the socket (Twitch
// closes it with 4001). Subscriptions are created out-of-band via the Helix API
// within 10s of the welcome message. See docs/configuration.md.

import type {
  ChatMessage,
  Emitter,
  EventSubFrame,
  EventSubFrameKind,
} from "./types.ts";
import { cheerColor } from "./twitch.ts";
import {
  buildCreateSubscriptionRequest,
  parseCreateSubscriptionResponse,
  SUBSCRIPTIONS,
} from "./twitchauth.ts";

const WS_URL = "wss://eventsub.wss.twitch.tv/ws";

const FOLLOW_COLOR = "#a970ff";
const SUB_COLOR = "#9147ff";
const RAID_COLOR = "#00b173";

const str = (x: unknown): string => (typeof x === "string" ? x : "");
const num = (
  x: unknown,
): number => (typeof x === "number" ? x : Number(x) || 0);

/** "1000"/"2000"/"3000" → "Tier 1/2/3" (EventSub encodes tiers this way). */
export function subTierLabel(tier: unknown): string {
  switch (String(tier ?? "1000")) {
    case "3000":
      return "Tier 3";
    case "2000":
      return "Tier 2";
    default:
      return "Tier 1";
  }
}

// ---- pure notification → ChatMessage mappers ------------------------------
// Each returns null to deliberately emit nothing (e.g. a gifted channel.subscribe,
// which is already covered by channel.subscription.gift).

type Event = Record<string, unknown>;

function base(
  id: string,
  channel: string,
  author: string,
): Pick<
  ChatMessage,
  "id" | "platform" | "channel" | "author" | "content" | "timestamp"
> {
  return {
    id,
    platform: "twitch",
    channel,
    author,
    content: "",
    timestamp: Date.now(),
  };
}

export function mapFollow(e: Event, channel: string, id: string): ChatMessage {
  const author = str(e.user_name) || "Someone";
  return {
    ...base(id, channel, author),
    kind: "follow",
    accentColor: FOLLOW_COLOR,
    eventText: `${author} followed`,
  };
}

export function mapCheer(e: Event, channel: string, id: string): ChatMessage {
  const author = e.is_anonymous
    ? "Anonymous"
    : (str(e.user_name) || "Anonymous");
  const bits = num(e.bits);
  return {
    ...base(id, channel, author),
    kind: "cheer",
    amount: `${bits} bits`,
    accentColor: cheerColor(bits),
    eventText: `${author} cheered ${bits} bits`,
  };
}

export function mapSubscribe(
  e: Event,
  channel: string,
  id: string,
): ChatMessage | null {
  // A gifted sub also fires channel.subscription.gift (to the gifter); render the
  // gift there and skip the per-recipient subscribe to avoid double alerts.
  if (e.is_gift === true) return null;
  const author = str(e.user_name) || "Someone";
  const tier = subTierLabel(e.tier);
  return {
    ...base(id, channel, author),
    kind: "sub",
    accentColor: SUB_COLOR,
    eventText: `${author} subscribed (${tier})`,
  };
}

export function mapSubGift(e: Event, channel: string, id: string): ChatMessage {
  const author = e.is_anonymous
    ? "Anonymous"
    : (str(e.user_name) || "Anonymous");
  const total = num(e.total) || 1;
  const tier = subTierLabel(e.sub_tier);
  const plural = total === 1 ? "sub" : "subs";
  return {
    ...base(id, channel, author),
    kind: "sub",
    amount: `${total} ${plural}`,
    accentColor: SUB_COLOR,
    eventText: `${author} gifted ${total} ${tier} ${plural}`,
  };
}

export function mapSubMessage(
  e: Event,
  channel: string,
  id: string,
): ChatMessage {
  const author = str(e.user_name) || "Someone";
  const tier = subTierLabel(e.tier);
  const months = num(e.cumulative_months);
  const message = str((e.message as Event | undefined)?.text);
  return {
    ...base(id, channel, author),
    content: message,
    kind: "sub",
    accentColor: SUB_COLOR,
    eventText: months > 0
      ? `${author} resubscribed for ${months} months (${tier})`
      : `${author} resubscribed (${tier})`,
  };
}

export function mapRaid(e: Event, channel: string, id: string): ChatMessage {
  const from = str(e.from_broadcaster_user_name) || "Someone";
  const viewers = num(e.viewers);
  return {
    ...base(id, channel, from),
    kind: "raid",
    amount: `${viewers} viewers`,
    accentColor: RAID_COLOR,
    eventText: `${from} is raiding with ${viewers} viewers`,
  };
}

/** Route one notification to the emitter. Returns true if the type was handled
 *  (even when the mapper deliberately emits nothing). Mirrors twitch.ts's
 *  handleCommand "return true if handled" contract. */
export function handleNotification(
  type: string,
  event: Event,
  channel: string,
  id: string,
  emitter: Emitter,
): boolean {
  let msg: ChatMessage | null;
  switch (type) {
    case "channel.follow":
      msg = mapFollow(event, channel, id);
      break;
    case "channel.cheer":
      msg = mapCheer(event, channel, id);
      break;
    case "channel.subscribe":
      msg = mapSubscribe(event, channel, id);
      break;
    case "channel.subscription.gift":
      msg = mapSubGift(event, channel, id);
      break;
    case "channel.subscription.message":
      msg = mapSubMessage(event, channel, id);
      break;
    case "channel.raid":
      msg = mapRaid(event, channel, id);
      break;
    default:
      return false;
  }
  if (msg) emitter.message(msg);
  return true;
}

// ---- pure frame classification (unit-testable without a socket) ------------

export function classifyFrame(frame: EventSubFrame): EventSubFrameKind {
  switch (frame?.metadata?.message_type) {
    case "session_welcome":
      return "welcome";
    case "session_keepalive":
      return "keepalive";
    case "notification":
      return "notification";
    case "session_reconnect":
      return "reconnect";
    case "revocation":
      return "revocation";
    default:
      return "unknown";
  }
}

export const getSessionId = (f: EventSubFrame): string =>
  str(f?.payload?.session?.id);

export const getKeepaliveSeconds = (f: EventSubFrame): number =>
  num(f?.payload?.session?.keepalive_timeout_seconds);

export const getReconnectUrl = (f: EventSubFrame): string =>
  str(f?.payload?.session?.reconnect_url);

/** Pull the notification's subscription type, event body, and a stable id. */
export function getNotification(
  f: EventSubFrame,
): { type: string; event: Event; id: string } | null {
  const type = str(f?.metadata?.subscription_type) ||
    str(f?.payload?.subscription?.type);
  if (!type) return null;
  const event = (f?.payload?.event ?? {}) as Event;
  const id = str(f?.metadata?.message_id) ||
    `es-${type}-${Date.now()}-${Math.random()}`;
  return { type, event, id };
}

// ---- socket wiring (not unit-tested; logic lives in the pure helpers) -------

/** Everything one channel's WebSocket needs. `getToken(force)` is provided by the
 *  EventSub manager in main.ts: it returns a user access token (refreshing on
 *  `force`, e.g. after a 401), or null when no valid token can be obtained. */
export interface EventSubChannelContext {
  clientId: string;
  broadcasterId: string;
  channelLabel: string;
  emitter: Emitter;
  getToken(force?: boolean): Promise<string | null>;
}

const DEFAULT_KEEPALIVE_MS = 10_000;
const KEEPALIVE_GRACE_MS = 5_000;
const KEEPALIVE_CHECK_MS = 3_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

// Create all subscriptions for a session (must happen within 10s of welcome).
// Fires them in parallel; a per-sub failure (e.g. a missing-scope 403) is logged
// but never tears down the socket. If every create 401s, the token is stale, so
// refresh once and retry.
async function createSubscriptions(
  ctx: EventSubChannelContext,
  sessionId: string,
): Promise<void> {
  const attempt = async (token: string) =>
    await Promise.all(SUBSCRIPTIONS.map(async (spec) => {
      const req = buildCreateSubscriptionRequest(
        spec,
        ctx.broadcasterId,
        sessionId,
        ctx.clientId,
        token,
      );
      try {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        let json: unknown = null;
        try {
          json = await res.json();
        } catch { /* empty/non-JSON body */ }
        return {
          spec,
          result: parseCreateSubscriptionResponse(res.status, json),
        };
      } catch (e) {
        return {
          spec,
          result: { ok: false as const, status: 0, message: String(e) },
        };
      }
    }));

  const token = await ctx.getToken();
  if (!token) throw new Error("no access token available");
  let results = await attempt(token);

  const allUnauthorized = results.every((r) =>
    !r.result.ok && r.result.status === 401
  );
  if (allUnauthorized) {
    // getToken(true) chains a genuinely fresh refresh, so retry whenever it yields
    // a token (don't gate on it differing from the one that just 401'd).
    const fresh = await ctx.getToken(true);
    if (fresh) {
      results = await attempt(fresh);
    }
  }

  for (const { spec, result } of results) {
    if (!result.ok) {
      console.error(
        `[EventSub] ${ctx.channelLabel}: ${spec.type} subscribe failed ` +
          `(${result.status}): ${result.message}`,
      );
    }
  }
  const ok = results.filter((r) => r.result.ok).length;
  console.log(
    `[EventSub] ${ctx.channelLabel}: ${ok}/${results.length} subscriptions active`,
  );
}

/** Run one WebSocket session to completion. Resolves with a reconnect URL when
 *  Twitch asks us to migrate (subscriptions auto-transfer, so we don't re-create
 *  them), or with {} on a clean abort; rejects on any failure so the caller backs
 *  off and reconnects fresh. `resubscribe` is false on a reconnect handoff. */
function connectOnce(
  ctx: EventSubChannelContext,
  url: string,
  resubscribe: boolean,
  signal?: AbortSignal,
): Promise<{ reconnectUrl?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let keepaliveMs = DEFAULT_KEEPALIVE_MS;
    let lastData = Date.now();
    let settled = false;

    const timer = setInterval(() => {
      if (Date.now() - lastData > keepaliveMs + KEEPALIVE_GRACE_MS) {
        fail(new Error("keepalive timeout"));
      }
    }, KEEPALIVE_CHECK_MS);

    const finish = () => {
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch { /* already closing */ }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      finish();
      resolve({});
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(err);
    };
    const done = (out: { reconnectUrl?: string }) => {
      if (settled) return;
      settled = true;
      finish();
      resolve(out);
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    ws.onopen = () => {
      lastData = Date.now();
    };
    ws.onerror = () => fail(new Error("socket error"));
    ws.onclose = () => fail(new Error("closed"));
    ws.onmessage = ({ data }) => {
      lastData = Date.now();
      let frame: EventSubFrame;
      try {
        frame = JSON.parse(typeof data === "string" ? data : "");
      } catch {
        return;
      }
      switch (classifyFrame(frame)) {
        case "welcome": {
          const kaSec = getKeepaliveSeconds(frame);
          if (kaSec) keepaliveMs = kaSec * 1000;
          const sessionId = getSessionId(frame);
          if (!sessionId) return fail(new Error("welcome without session id"));
          // On a reconnect handoff the old subscriptions carry over — don't recreate.
          if (resubscribe) {
            createSubscriptions(ctx, sessionId).catch((e) =>
              console.error(`[EventSub] ${ctx.channelLabel}: subscribe: ${e}`)
            );
          }
          break;
        }
        case "notification": {
          const n = getNotification(frame);
          if (n) {
            handleNotification(
              n.type,
              n.event,
              ctx.channelLabel,
              n.id,
              ctx.emitter,
            );
          }
          break;
        }
        case "reconnect": {
          const rurl = getReconnectUrl(frame);
          if (rurl) done({ reconnectUrl: rurl });
          break;
        }
        case "revocation": {
          const s = str(frame?.payload?.subscription?.status);
          console.error(
            `[EventSub] ${ctx.channelLabel}: subscription revoked (${s})`,
          );
          break;
        }
          // keepalive / unknown: nothing to do (lastData already reset).
      }
    };
  });
}

/** Start (and keep alive) one channel's EventSub connection, mirroring
 *  startTwitchClient's reconnect/backoff loop. `signal` tears it down so a token
 *  rotation can restart it cleanly, exactly like the YouTube poller. */
export function startTwitchEventSub(
  ctx: EventSubChannelContext,
  signal?: AbortSignal,
): void {
  const delays = [2_000, 4_000, 8_000, 16_000, 30_000];
  let attempt = 0;

  (async () => {
    let url = WS_URL;
    let resubscribe = true;
    while (!signal?.aborted) {
      const start = Date.now();
      try {
        console.log(`[EventSub] Connecting: ${ctx.channelLabel}`);
        const out = await connectOnce(ctx, url, resubscribe, signal);
        if (signal?.aborted) break;
        if (out.reconnectUrl) {
          // Migrate immediately; subscriptions transfer automatically.
          url = out.reconnectUrl;
          resubscribe = false;
          continue;
        }
        // Clean close without a migration — reconnect fresh with backoff.
        url = WS_URL;
        resubscribe = true;
      } catch (err) {
        url = WS_URL;
        resubscribe = true;
        if (Date.now() - start > 60_000) attempt = 0;
        const delay = delays[Math.min(attempt++, delays.length - 1)];
        console.error(
          `[EventSub] ${ctx.channelLabel}: ${err} — retry in ${delay / 1000}s`,
        );
        await sleep(delay, signal);
      }
    }
  })();
}

import type {
  Badge,
  Emitter,
  MessageKind,
  YouTubeChannelConfig,
  YouTubeConfig,
} from "./types.ts";

const BASE = "https://www.googleapis.com/youtube/v3";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Thrown when the daily/rate quota is exhausted, so callers can back off for a long time
 *  instead of hammering the API (every request just returns 403 until quota resets). */
export class QuotaError extends Error {
  constructor() {
    super("YouTube API quota exceeded");
    this.name = "QuotaError";
  }
}

// Returns parsed JSON, or null on a transient error (caller should retry with backoff).
// Throws QuotaError on quota/rate-limit 403s so the caller can back off hard.
export async function ytGet<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text();
      if (
        r.status === 403 && /quota|rateLimitExceeded|dailyLimit/i.test(body)
      ) {
        throw new QuotaError();
      }
      console.error(`[YouTube] HTTP ${r.status}: ${body}`);
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    if (e instanceof QuotaError) throw e;
    console.error(`[YouTube] Fetch error: ${e}`);
    return null;
  }
}

async function resolveChannelId(
  key: string,
  ch: YouTubeChannelConfig,
): Promise<string | null> {
  if (ch.channelId) return ch.channelId;
  if (!ch.handle) return null;
  const handle = ch.handle.startsWith("@") ? ch.handle : `@${ch.handle}`;
  const d = await ytGet<{ items?: { id: string }[] }>(
    `${BASE}/channels?part=id&forHandle=${
      encodeURIComponent(handle)
    }&key=${key}`,
  );
  return d?.items?.[0]?.id ?? null;
}

async function findLiveVideo(
  key: string,
  channelId: string,
): Promise<string | null> {
  const d = await ytGet<{ items?: { id: { videoId: string } }[] }>(
    `${BASE}/search?part=id&channelId=${
      encodeURIComponent(channelId)
    }&eventType=live&type=video&maxResults=1&key=${key}`,
  );
  return d?.items?.[0]?.id?.videoId ?? null;
}

async function getLiveChatId(
  key: string,
  videoId: string,
): Promise<string | null> {
  const d = await ytGet<{
    items?: { liveStreamingDetails?: { activeLiveChatId?: string } }[];
  }>(
    `${BASE}/videos?part=liveStreamingDetails&id=${
      encodeURIComponent(videoId)
    }&key=${key}`,
  );
  return d?.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
}

export interface ChatItem {
  id: string;
  snippet: {
    type: string;
    displayMessage?: string;
    publishedAt: string;
    superChatDetails?: {
      amountDisplayString: string;
      userComment?: string;
      tier?: number;
    };
    superStickerDetails?: {
      amountDisplayString: string;
      tier?: number;
      superStickerMetadata?: { altText?: string };
    };
    newSponsorDetails?: { memberLevelName?: string };
    memberMilestoneChatDetails?: {
      memberLevelName?: string;
      memberMonth?: number;
      userComment?: string;
    };
    messageDeletedDetails?: { deletedMessageId: string };
  };
  authorDetails: {
    displayName: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
    isVerified?: boolean;
  };
}

interface ChatPage {
  items?: ChatItem[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
}

// Super Chat / Super Sticker tier → YouTube's standard highlight color (1..7, clamped).
const TIER_COLORS = [
  "#1565C0", // 1 blue
  "#00B8D4", // 2 light blue
  "#00BFA5", // 3 teal
  "#FFCA28", // 4 yellow
  "#F57C00", // 5 orange
  "#E91E63", // 6 magenta
  "#E62117", // 7 red
];
export const tierColor = (tier?: number) =>
  TIER_COLORS[Math.min(Math.max((tier ?? 1) - 1, 0), TIER_COLORS.length - 1)];

export function buildBadges(a: ChatItem["authorDetails"]): Badge[] {
  const out: Badge[] = [];
  if (a.isChatOwner) out.push({ id: "owner", label: "Owner" });
  if (a.isChatModerator) out.push({ id: "moderator", label: "Mod" });
  if (a.isChatSponsor) out.push({ id: "member", label: "Member" });
  if (a.isVerified) out.push({ id: "verified", label: "Verified" });
  return out;
}

export function emitItem(
  item: ChatItem,
  channel: string,
  emitter: Emitter,
): void {
  const sn = item.snippet;
  const author = item.authorDetails.displayName;
  const badges = buildBadges(item.authorDetails);
  const timestamp = new Date(sn.publishedAt).getTime();

  let kind: MessageKind = "chat";
  let content = sn.displayMessage ?? "";
  let amount: string | undefined;
  let accentColor: string | undefined;
  let eventText: string | undefined;

  switch (sn.type) {
    case "textMessageEvent":
      break;
    case "superChatEvent": {
      const d = sn.superChatDetails;
      kind = "superchat";
      amount = d?.amountDisplayString;
      accentColor = tierColor(d?.tier);
      eventText = `${author} sent a Super Chat`;
      content = d?.userComment ?? "";
      break;
    }
    case "superStickerEvent": {
      const d = sn.superStickerDetails;
      kind = "supersticker";
      amount = d?.amountDisplayString;
      accentColor = tierColor(d?.tier);
      eventText = `${author} sent a Super Sticker`;
      content = d?.superStickerMetadata?.altText ?? "";
      break;
    }
    case "newSponsorEvent": {
      kind = "membership";
      accentColor = "#2ba640";
      const level = sn.newSponsorDetails?.memberLevelName;
      eventText = level
        ? `${author} became a member (${level})`
        : `${author} became a member`;
      content = "";
      break;
    }
    case "memberMilestoneChatEvent": {
      const d = sn.memberMilestoneChatDetails;
      kind = "membership";
      accentColor = "#2ba640";
      const months = d?.memberMonth ? ` — ${d.memberMonth} months` : "";
      eventText = `${author} member milestone${months}`;
      content = d?.userComment ?? "";
      break;
    }
    case "messageDeletedEvent": {
      const id = sn.messageDeletedDetails?.deletedMessageId;
      if (id) emitter.delete({ platform: "youtube", channel, messageId: id });
      return;
    }
    default:
      return; // ignore tombstones, sponsor-only-mode toggles, etc.
  }

  emitter.message({
    id: item.id,
    platform: "youtube",
    channel,
    author,
    content,
    badges: badges.length ? badges : undefined,
    kind,
    amount,
    accentColor,
    eventText,
    timestamp,
  });
}

// Retry cadences. The live-stream lookup (search.list) costs 100 quota units, so an
// offline channel is rechecked sparingly; quota exhaustion backs off hardest of all.
const OFFLINE_RECHECK_MS = 5 * 60_000;
const ERROR_RETRY_MS = 60_000;
const QUOTA_BACKOFF_MS = 15 * 60_000;
const POLL_BACKOFF_MAX_MS = 120_000;

// Polls one channel's live chat until it ends or errors. Returns the resolved channelId
// (or null) so the caller can cache it and skip re-resolving on the next attempt.
async function pollChannel(
  key: string,
  ch: YouTubeChannelConfig,
  label: string,
  emitter: Emitter,
  cachedCid: string | null,
): Promise<string | null> {
  emitter.status("youtube", label, "connecting");
  let videoId = ch.videoId || null;
  let cid = cachedCid;

  if (!videoId) {
    if (!cid) cid = await resolveChannelId(key, ch);
    if (!cid) throw new Error(`Cannot resolve channel: ${JSON.stringify(ch)}`);
    videoId = await findLiveVideo(key, cid);
    if (!videoId) {
      console.log(`[YouTube] No live stream found for ${label}`);
      emitter.status("youtube", label, "offline");
      return cid;
    }
  }

  const chatId = await getLiveChatId(key, videoId);
  if (!chatId) {
    console.log(
      `[YouTube] No active live chat for ${label} (video: ${videoId})`,
    );
    emitter.status("youtube", label, "offline");
    return cid;
  }

  console.log(`[YouTube] Polling live chat: ${label} (video: ${videoId})`);
  emitter.status("youtube", label, "live");

  let token: string | undefined;
  let backoff = 15_000;
  while (true) {
    let url = `${BASE}/liveChat/messages?liveChatId=${
      encodeURIComponent(chatId)
    }&part=snippet,authorDetails&key=${key}`;
    if (token) url += `&pageToken=${encodeURIComponent(token)}`;

    const page = await ytGet<ChatPage>(url); // throws QuotaError → handled by caller
    if (!page) {
      // Transient error — back off exponentially instead of a fixed 15s hammer.
      await sleep(backoff);
      backoff = Math.min(backoff * 2, POLL_BACKOFF_MAX_MS);
      continue;
    }
    backoff = 15_000;

    for (const item of page.items ?? []) {
      emitItem(item, label, emitter);
    }

    token = page.nextPageToken;
    await sleep(page.pollingIntervalMillis ?? 5_000);
  }
}

export function startYouTubePoller(
  config: YouTubeConfig,
  emitter: Emitter,
): void {
  for (const ch of config.channels) {
    const label = ch.handle ?? ch.channelId ?? ch.videoId ?? "unknown";
    (async () => {
      let cid: string | null = ch.channelId || null; // resolve once, then reuse
      while (true) {
        try {
          // Normal return means the channel is offline / chat ended.
          cid = await pollChannel(config.apiKey, ch, label, emitter, cid);
          await sleep(OFFLINE_RECHECK_MS);
        } catch (e) {
          emitter.status("youtube", label, "error");
          if (e instanceof QuotaError) {
            console.error(
              `[YouTube] ${label}: quota exceeded — backing off 15m`,
            );
            await sleep(QUOTA_BACKOFF_MS);
          } else {
            console.error(`[YouTube] ${label}: ${e}`);
            await sleep(ERROR_RETRY_MS);
          }
        }
      }
    })();
  }
}

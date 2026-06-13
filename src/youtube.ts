import type { Badge, Emitter, MessageKind, YouTubeChannelConfig, YouTubeConfig } from "./types.ts";

const BASE = "https://www.googleapis.com/youtube/v3";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function ytGet<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`[YouTube] HTTP ${r.status}: ${await r.text()}`);
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
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
    `${BASE}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${key}`,
  );
  return d?.items?.[0]?.id ?? null;
}

async function findLiveVideo(
  key: string,
  channelId: string,
): Promise<string | null> {
  const d = await ytGet<{ items?: { id: { videoId: string } }[] }>(
    `${BASE}/search?part=id&channelId=${channelId}&eventType=live&type=video&maxResults=1&key=${key}`,
  );
  return d?.items?.[0]?.id?.videoId ?? null;
}

async function getLiveChatId(
  key: string,
  videoId: string,
): Promise<string | null> {
  const d = await ytGet<{
    items?: { liveStreamingDetails?: { activeLiveChatId?: string } }[];
  }>(`${BASE}/videos?part=liveStreamingDetails&id=${videoId}&key=${key}`);
  return d?.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
}

interface ChatItem {
  id: string;
  snippet: {
    type: string;
    displayMessage?: string;
    publishedAt: string;
    superChatDetails?: { amountDisplayString: string; userComment?: string; tier?: number };
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
const tierColor = (tier?: number) =>
  TIER_COLORS[Math.min(Math.max((tier ?? 1) - 1, 0), TIER_COLORS.length - 1)];

function buildBadges(a: ChatItem["authorDetails"]): Badge[] {
  const out: Badge[] = [];
  if (a.isChatOwner) out.push({ id: "owner", label: "Owner" });
  if (a.isChatModerator) out.push({ id: "moderator", label: "Mod" });
  if (a.isChatSponsor) out.push({ id: "member", label: "Member" });
  if (a.isVerified) out.push({ id: "verified", label: "Verified" });
  return out;
}

function emitItem(item: ChatItem, channel: string, emitter: Emitter): void {
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
      eventText = level ? `${author} became a member (${level})` : `${author} became a member`;
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

async function pollChannel(
  key: string,
  ch: YouTubeChannelConfig,
  label: string,
  emitter: Emitter,
): Promise<void> {
  emitter.status("youtube", label, "connecting");
  let videoId = ch.videoId || null;

  if (!videoId) {
    const cid = await resolveChannelId(key, ch);
    if (!cid) throw new Error(`Cannot resolve channel: ${JSON.stringify(ch)}`);
    videoId = await findLiveVideo(key, cid);
    if (!videoId) {
      console.log(`[YouTube] No live stream found for ${label}`);
      emitter.status("youtube", label, "offline");
      return;
    }
  }

  const chatId = await getLiveChatId(key, videoId);
  if (!chatId) {
    console.log(`[YouTube] No active live chat for ${label} (video: ${videoId})`);
    emitter.status("youtube", label, "offline");
    return;
  }

  console.log(`[YouTube] Polling live chat: ${label} (video: ${videoId})`);
  emitter.status("youtube", label, "live");

  let token: string | undefined;
  while (true) {
    let url =
      `${BASE}/liveChat/messages?liveChatId=${chatId}&part=snippet,authorDetails&key=${key}`;
    if (token) url += `&pageToken=${token}`;

    const page = await ytGet<ChatPage>(url);
    if (!page) {
      await sleep(15_000);
      continue;
    }

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
      while (true) {
        try {
          await pollChannel(config.apiKey, ch, label, emitter);
        } catch (e) {
          console.error(`[YouTube] ${label}: ${e}`);
          emitter.status("youtube", label, "error");
        }
        // Retry in 60s — stream may have ended or not started yet
        await sleep(60_000);
      }
    })();
  }
}

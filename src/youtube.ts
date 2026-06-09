import type { Broadcaster, YouTubeChannelConfig, YouTubeConfig } from "./types.ts";

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

interface ChatPage {
  items?: Array<{
    id: string;
    snippet: { displayMessage: string; publishedAt: string; type: string };
    authorDetails: { displayName: string };
  }>;
  nextPageToken?: string;
  pollingIntervalMillis?: number;
}

async function pollChannel(
  key: string,
  ch: YouTubeChannelConfig,
  label: string,
  onMessage: Broadcaster,
): Promise<void> {
  let videoId = ch.videoId || null;

  if (!videoId) {
    const cid = await resolveChannelId(key, ch);
    if (!cid) throw new Error(`Cannot resolve channel: ${JSON.stringify(ch)}`);
    videoId = await findLiveVideo(key, cid);
    if (!videoId) {
      console.log(`[YouTube] No live stream found for ${label}`);
      return;
    }
  }

  const chatId = await getLiveChatId(key, videoId);
  if (!chatId) {
    console.log(`[YouTube] No active live chat for ${label} (video: ${videoId})`);
    return;
  }

  console.log(`[YouTube] Polling live chat: ${label} (video: ${videoId})`);

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
      if (item.snippet.type !== "textMessageEvent") continue;
      onMessage({
        id: item.id,
        platform: "youtube",
        channel: label,
        author: item.authorDetails.displayName,
        content: item.snippet.displayMessage,
        timestamp: new Date(item.snippet.publishedAt).getTime(),
      });
    }

    token = page.nextPageToken;
    await sleep(page.pollingIntervalMillis ?? 5_000);
  }
}

export function startYouTubePoller(
  config: YouTubeConfig,
  onMessage: Broadcaster,
): void {
  for (const ch of config.channels) {
    const label = ch.handle ?? ch.channelId ?? ch.videoId ?? "unknown";
    (async () => {
      while (true) {
        try {
          await pollChannel(config.apiKey, ch, label, onMessage);
        } catch (e) {
          console.error(`[YouTube] ${label}: ${e}`);
        }
        // Retry in 60s — stream may have ended or not started yet
        await sleep(60_000);
      }
    })();
  }
}

// Fake-event support for previewing how messages render, without a live stream.
//
// The transport is a loopback-only `POST /api/fake` route (in server.ts) that
// injects an event straight into the SSE feed via the normal Emitter — so a
// faked message renders through the exact same path as a real one. Everything
// here is side-effect-free (no network, no Emitter) so the test suite can drive
// it directly, matching the project's "logic in src/, wiring in main.ts" split.
//
// The CLI (`multichat fake`) plays `demoActions()` — a fixed, curated sequence
// covering every message kind — one event at a time. `parseFakeAction` is the
// server-side trust boundary: it re-validates whatever arrives on the wire
// before it reaches the Emitter (loopback is trusted, but a hand-crafted curl
// still shouldn't be able to push a malformed frame to every viewer).

import type {
  Badge,
  ChannelState,
  ChatMessage,
  DeleteEvent,
  MessageKind,
  Platform,
  Segment,
} from "./types.ts";
import { cheerColor } from "./twitch.ts";
import { tierColor } from "./youtube.ts";

/** One thing the server should do with a faked event, in wire form. */
export type FakeAction =
  | { action: "message"; data: ChatMessage }
  | { action: "delete"; data: DeleteEvent }
  | {
    action: "status";
    data: { platform: Platform; name: string; state: ChannelState };
  };

export type FakeParseResult =
  | { ok: true; action: FakeAction }
  | { ok: false; message: string };

const STATES: readonly string[] = ["connecting", "live", "offline", "error"];
const MESSAGE_KINDS: readonly string[] = [
  "chat",
  "action",
  "cheer",
  "sub",
  "raid",
  "follow",
  "superchat",
  "supersticker",
  "membership",
  "system",
];

// A real Twitch emote (Kappa) so the demo exercises the image-emote render path.
const SAMPLE_EMOTE = {
  url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0",
  alt: "Kappa",
};

/**
 * A fixed, curated showcase of every message kind, in the order they should be
 * played. Includes a message with a known id and a later `delete` targeting it,
 * so the live-deletion path is exercised too. `now` stamps timestamps/ids so the
 * sequence is deterministic for tests (pass the real clock at the call site).
 */
export function demoActions(now = 0): FakeAction[] {
  let seq = 0;
  const nextId = () => `fake-${now}-${seq++}`;
  const message = (
    d: Omit<ChatMessage, "id" | "timestamp" | "content"> & {
      id?: string;
      content?: string;
    },
  ): FakeAction => ({
    action: "message",
    data: { content: "", ...d, id: d.id ?? nextId(), timestamp: now },
  });

  const TW = "demo_twitch";
  const YT = "@demo_yt";
  const delId = `fake-${now}-del`;

  return [
    { action: "status", data: { platform: "twitch", name: TW, state: "live" } },
    {
      action: "status",
      data: { platform: "youtube", name: YT, state: "live" },
    },
    message({
      platform: "twitch",
      channel: TW,
      author: "AlphaViewer",
      authorColor: "#ff7f50",
      badges: [{ id: "subscriber", label: "Sub" }],
      kind: "chat",
      content: "hey everyone, glad to be here o/",
    }),
    message({
      platform: "twitch",
      channel: TW,
      author: "ModSam",
      badges: [{ id: "moderator", label: "Mod" }],
      kind: "chat",
      content: "welcome to the stream Kappa",
      segments: [
        { type: "text", text: "welcome to the stream " },
        { type: "emote", url: SAMPLE_EMOTE.url, alt: SAMPLE_EMOTE.alt },
      ],
    }),
    message({
      platform: "twitch",
      channel: TW,
      author: "DancingBot",
      kind: "action",
      content: "does a little dance",
    }),
    message({
      id: delId,
      platform: "twitch",
      channel: TW,
      author: "OopsUser",
      kind: "chat",
      content: "this message will be deleted in a moment…",
    }),
    message({
      platform: "twitch",
      channel: TW,
      author: "NewFollower",
      kind: "follow",
      accentColor: "#a970ff",
      eventText: "NewFollower followed",
    }),
    message({
      platform: "twitch",
      channel: TW,
      author: "BitLord",
      badges: [{ id: "subscriber", label: "Sub" }],
      kind: "cheer",
      content: "take my bits!",
      amount: "1000 bits",
      accentColor: cheerColor(1000),
      eventText: "BitLord cheered 1000 bits",
    }),
    message({
      platform: "twitch",
      channel: TW,
      author: "LoyalFan",
      kind: "sub",
      content: "happy to keep supporting!",
      accentColor: "#9147ff",
      eventText: "LoyalFan subscribed for 6 months",
    }),
    message({
      platform: "twitch",
      channel: TW,
      author: "BigStreamer",
      kind: "raid",
      accentColor: "#00b173",
      amount: "250 viewers",
      eventText: "BigStreamer is raiding with a party of 250",
    }),
    {
      action: "delete",
      data: { platform: "twitch", channel: TW, messageId: delId },
    },
    message({
      platform: "youtube",
      channel: YT,
      author: "YT_Watcher",
      badges: [{ id: "member", label: "Member" }],
      kind: "chat",
      content: "first time catching you live, love it",
    }),
    message({
      platform: "youtube",
      channel: YT,
      author: "GenerousGeorge",
      kind: "superchat",
      content: "Keep up the great work!",
      amount: "$20.00",
      accentColor: tierColor(6),
      eventText: "GenerousGeorge sent a Super Chat",
    }),
    message({
      platform: "youtube",
      channel: YT,
      author: "StickerFan",
      kind: "supersticker",
      amount: "$2.00",
      accentColor: tierColor(3),
      eventText: "StickerFan sent a Super Sticker",
    }),
    message({
      platform: "youtube",
      channel: YT,
      author: "NewMember",
      kind: "membership",
      accentColor: "#2ba640",
      eventText: "NewMember became a member",
    }),
    message({
      platform: "twitch",
      channel: TW,
      author: "TheBroadcaster",
      kind: "system",
      accentColor: "#9147ff",
      eventText: "Chat is now in subscriber-only mode",
    }),
  ];
}

/** Serialize a FakeAction to the JSON wire body the /api/fake endpoint expects. */
export function serializeFakeAction(action: FakeAction): string {
  return JSON.stringify(action);
}

// A YouTube "channel" is a handle that already starts with "@"; only Twitch
// channels take a leading "#". Keeps the operator-facing summaries readable
// (avoids "#@demo_yt").
function channelLabel(name: string): string {
  return name.startsWith("@") ? name : `#${name}`;
}

/**
 * A one-line human summary of a faked event, returned to the CLI so `fake` can
 * report what it injected (and it round-trips: describe(parse(serialize(x)))).
 */
export function describeFakeAction(a: FakeAction): string {
  switch (a.action) {
    case "message":
      return `${a.data.platform} ${
        a.data.kind ?? "chat"
      } from ${a.data.author} in ${channelLabel(a.data.channel)}`;
    case "delete": {
      const d = a.data;
      const where = channelLabel(d.channel);
      if (d.messageId) return `delete message ${d.messageId} in ${where}`;
      if (d.author) return `delete all messages from ${d.author} in ${where}`;
      return `clear all messages in ${where}`;
    }
    case "status":
      return `set ${a.data.platform} ${a.data.name} → ${a.data.state}`;
  }
}

// ---- server-side validation (the trust boundary) -------------------------

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
/** Non-empty trimmed string, or "" when absent/blank/not-a-string. */
function reqStr(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function err(message: string): FakeParseResult {
  return { ok: false, message };
}

function parseBadges(x: unknown): Badge[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: Badge[] = [];
  for (const b of x) {
    if (isObj(b) && typeof b.id === "string") {
      out.push({
        id: b.id,
        label: typeof b.label === "string" ? b.label : b.id,
      });
    }
  }
  return out.length ? out : undefined;
}

function parseSegments(x: unknown): Segment[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: Segment[] = [];
  for (const s of x) {
    if (!isObj(s)) continue;
    if (s.type === "emote" && typeof s.url === "string") {
      out.push({
        type: "emote",
        url: s.url,
        alt: typeof s.alt === "string" ? s.alt : "",
      });
    } else if (s.type === "text" && typeof s.text === "string") {
      out.push({ type: "text", text: s.text });
    }
  }
  return out.length ? out : undefined;
}

function parseMessage(d: unknown): FakeParseResult {
  if (!isObj(d)) return err("message data must be an object");
  const platform = d.platform;
  if (platform !== "twitch" && platform !== "youtube") {
    return err("message.platform must be twitch or youtube");
  }
  const channel = reqStr(d.channel);
  if (!channel) return err("message.channel is required");
  const author = reqStr(d.author);
  if (!author) return err("message.author is required");

  const msg: ChatMessage = {
    id: reqStr(d.id) || `fake-${author}`,
    platform,
    channel,
    author,
    content: typeof d.content === "string" ? d.content : "",
    timestamp: typeof d.timestamp === "number" && Number.isFinite(d.timestamp)
      ? d.timestamp
      : 0,
  };
  if (typeof d.authorColor === "string") msg.authorColor = d.authorColor;
  if (d.kind != null) {
    if (typeof d.kind !== "string" || !MESSAGE_KINDS.includes(d.kind)) {
      return err(`message.kind is invalid: ${String(d.kind)}`);
    }
    msg.kind = d.kind as MessageKind;
  }
  if (typeof d.amount === "string") msg.amount = d.amount;
  if (typeof d.accentColor === "string") msg.accentColor = d.accentColor;
  if (typeof d.eventText === "string") msg.eventText = d.eventText;
  const badges = parseBadges(d.badges);
  if (badges) msg.badges = badges;
  const segments = parseSegments(d.segments);
  if (segments) msg.segments = segments;

  return { ok: true, action: { action: "message", data: msg } };
}

function parseDelete(d: unknown): FakeParseResult {
  if (!isObj(d)) return err("delete data must be an object");
  const platform = d.platform;
  if (platform !== "twitch" && platform !== "youtube") {
    return err("delete.platform must be twitch or youtube");
  }
  const channel = reqStr(d.channel);
  if (!channel) return err("delete.channel is required");
  const ev: DeleteEvent = { platform, channel };
  if (typeof d.messageId === "string") ev.messageId = d.messageId;
  else if (typeof d.author === "string") ev.author = d.author;
  return { ok: true, action: { action: "delete", data: ev } };
}

function parseStatus(d: unknown): FakeParseResult {
  if (!isObj(d)) return err("status data must be an object");
  const platform = d.platform;
  if (platform !== "twitch" && platform !== "youtube") {
    return err("status.platform must be twitch or youtube");
  }
  const name = reqStr(d.name);
  if (!name) return err("status.name is required");
  if (typeof d.state !== "string" || !STATES.includes(d.state)) {
    return err(`status.state must be one of: ${STATES.join(", ")}`);
  }
  return {
    ok: true,
    action: {
      action: "status",
      data: { platform, name, state: d.state as ChannelState },
    },
  };
}

/**
 * Parse and validate a JSON `/api/fake` body into a FakeAction. Lenient about
 * the Content-Type (always tries JSON) but strict about structure: any missing
 * required field / unknown enum value yields `{ ok:false }` with a reason.
 */
export function parseFakeAction(raw: string): FakeParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return err("body is not valid JSON");
  }
  if (!isObj(body)) return err("body must be a JSON object");
  switch (body.action) {
    case "message":
      return parseMessage(body.data);
    case "delete":
      return parseDelete(body.data);
    case "status":
      return parseStatus(body.data);
    default:
      return err(
        `unknown action "${
          String(body.action)
        }" (use message, delete, or status)`,
      );
  }
}

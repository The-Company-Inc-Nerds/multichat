export type Platform = "twitch" | "youtube";

export type ChannelState = "connecting" | "live" | "offline" | "error";

export interface ChannelStatus {
  platform: Platform;
  name: string;
  state: ChannelState;
}

export interface Badge {
  id: string;
  label: string;
}

export type Segment =
  | { type: "text"; text: string }
  | { type: "emote"; url: string; alt: string };

export type MessageKind =
  | "chat"
  | "action"
  | "cheer"
  | "sub"
  | "raid"
  | "superchat"
  | "supersticker"
  | "membership"
  | "system";

export interface ChatMessage {
  id: string;
  platform: Platform;
  channel: string;
  author: string;
  authorColor?: string;
  content: string;
  /** Pre-tokenized body (text + emote images). Falls back to `content` when absent. */
  segments?: Segment[];
  badges?: Badge[];
  /** Defaults to "chat" when omitted. */
  kind?: MessageKind;
  /** Monetary/quantity label, e.g. "500 bits" or "$5.00". */
  amount?: string;
  /** Highlight color for event rows / Super Chat tiers / cheer tiers. */
  accentColor?: string;
  /** Notice line for event rows, e.g. "X subscribed for 3 months". */
  eventText?: string;
  timestamp: number;
}

/** Frames pushed over SSE. The client switches on `type`. */
export type ServerEvent =
  | { type: "message"; data: ChatMessage }
  | {
    type: "delete";
    platform: Platform;
    channel: string;
    messageId?: string;
    author?: string;
  }
  | { type: "status"; data: ChannelStatus[] };

export interface DeleteEvent {
  platform: Platform;
  channel: string;
  messageId?: string;
  author?: string;
}

/** Sink handed to the platform clients by `createServer`. */
export interface Emitter {
  message(msg: ChatMessage): void;
  delete(ev: DeleteEvent): void;
  status(platform: Platform, name: string, state: ChannelState): void;
}

export interface TwitchConfig {
  channels: string[];
}

export interface YouTubeChannelConfig {
  channelId?: string;
  handle?: string;
  videoId?: string;
}

export interface YouTubeConfig {
  apiKey: string;
  channels: YouTubeChannelConfig[];
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface Settings {
  server: ServerConfig;
  twitch: TwitchConfig;
  youtube: YouTubeConfig;
}

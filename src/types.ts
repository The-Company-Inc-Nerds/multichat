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
  | "follow"
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

/** One channel to monitor over EventSub. Supply `login` (resolved to an id at
 *  startup) or `broadcasterId` directly; `refreshToken` is the seed used to mint
 *  user access tokens (a rotated one persisted to the state dir wins over it). */
export interface TwitchEventSubChannelConfig {
  login?: string;
  broadcasterId?: string;
  refreshToken?: string;
}

/** Optional Twitch EventSub config. When present, EventSub becomes the source of
 *  truth for that channel's follow/cheer/sub/raid events and IRC only carries its
 *  chat text (see the coverage predicate in twitch.ts). Requires a Twitch app
 *  (clientId + clientSecret) and a per-channel user token authorized by the
 *  broadcaster (scopes: moderator:read:followers, channel:read:subscriptions,
 *  bits:read). Channels without EventSub creds keep full anonymous IRC behavior. */
export interface TwitchEventSubConfig {
  clientId: string;
  clientSecret: string;
  channels: TwitchEventSubChannelConfig[];
}

export interface TwitchConfig {
  channels: string[];
  eventsub?: TwitchEventSubConfig;
}

// ---- Twitch EventSub WebSocket frames (only the fields we read) ----------

export interface EventSubSession {
  id: string;
  keepalive_timeout_seconds?: number;
  reconnect_url?: string;
  status?: string;
}

export interface EventSubFrame {
  metadata?: {
    message_type?: string;
    message_id?: string;
    subscription_type?: string;
  };
  payload?: {
    session?: EventSubSession;
    subscription?: { id?: string; type?: string; status?: string };
    // The event body varies per subscription type; the mappers read it loosely.
    event?: Record<string, unknown>;
  };
}

/** The frame kinds we act on; anything else is ignored. */
export type EventSubFrameKind =
  | "welcome"
  | "keepalive"
  | "notification"
  | "reconnect"
  | "revocation"
  | "unknown";

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

/** A named look for the /alerts overlay. `style` selects a built-in visual engine
 *  (e.g. "default" — the standard card — or "company-memo"); `events` limits which
 *  shoutout kinds it restyles (default: all); `options` is a style-specific bag
 *  (e.g. paper/ink colors) passed through to the engine. */
export interface AlertTheme {
  name: string;
  style: string;
  events?: MessageKind[];
  options?: Record<string, string | number | boolean>;
}

/** Alerts overlay theming. `activeTheme` names the theme in effect (unset = the
 *  default look). Configured in settings.json / the NixOS module. */
export interface AlertsConfig {
  activeTheme?: string;
  themes?: AlertTheme[];
}

export interface Settings {
  server: ServerConfig;
  twitch: TwitchConfig;
  youtube: YouTubeConfig;
  alerts?: AlertsConfig;
}

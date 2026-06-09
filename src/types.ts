export interface ChatMessage {
  id: string;
  platform: "twitch" | "youtube";
  channel: string;
  author: string;
  authorColor?: string;
  content: string;
  timestamp: number;
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

export type Broadcaster = (msg: ChatMessage) => void;

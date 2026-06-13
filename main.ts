import type { Settings } from "./src/types.ts";
import { startTwitchClient } from "./src/twitch.ts";
import { startYouTubePoller } from "./src/youtube.ts";
import { createServer } from "./src/server.ts";

async function loadSettings(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    console.error(`Cannot read settings file: ${path}`);
    console.error(
      "Copy settings.json.example to settings.json and configure it.",
    );
    Deno.exit(1);
  }

  const raw = JSON.parse(text);
  return {
    server: {
      port: Number(Deno.env.get("PORT") ?? raw.server?.port ?? 8080),
      host: Deno.env.get("HOST") ?? raw.server?.host ?? "127.0.0.1",
    },
    twitch: {
      channels: raw.twitch?.channels ?? [],
    },
    youtube: {
      apiKey: Deno.env.get("YOUTUBE_API_KEY") ?? raw.youtube?.apiKey ?? "",
      channels: raw.youtube?.channels ?? [],
    },
  };
}

const configPath = Deno.args[0] ?? "settings.json";
const settings = await loadSettings(configPath);
const emitter = createServer(settings);

const { twitch, youtube } = settings;

if (twitch.channels.length > 0) {
  startTwitchClient(twitch, emitter);
} else {
  console.log("No Twitch channels configured.");
}

if (youtube.channels.length > 0) {
  if (!youtube.apiKey) {
    console.warn(
      "YouTube channels configured but no API key found. " +
        "Set youtube.apiKey in settings.json or YOUTUBE_API_KEY env var.",
    );
  } else {
    startYouTubePoller(youtube, emitter);
  }
} else {
  console.log("No YouTube channels configured.");
}

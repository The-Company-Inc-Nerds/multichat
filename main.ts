import type { Emitter, Settings, YouTubeChannelConfig } from "./src/types.ts";
import { startTwitchClient } from "./src/twitch.ts";
import { startYouTubePoller } from "./src/youtube.ts";
import { createServer } from "./src/server.ts";
import {
  keyStatePath,
  type KeyUpdateResult,
  resolveStartupKey,
} from "./src/control.ts";
import { demoActions, serializeFakeAction } from "./src/fake.ts";

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
      // The key is resolved separately at startup (persisted/env/settings) so the
      // operator can also set it at runtime; see resolveStartupKey.
      apiKey: raw.youtube?.apiKey ?? "",
      channels: raw.youtube?.channels ?? [],
    },
  };
}

/**
 * Owns the live YouTube API key. Setting a key persists it (so it survives a
 * service restart), tears down any running poller, and starts a fresh one — so
 * the key can be supplied, replaced, or rotated while the server is running.
 */
function createYouTubeKeyManager(opts: {
  getEmitter: () => Emitter;
  channels: YouTubeChannelConfig[];
  statePath: string | null;
}) {
  let current = "";
  let controller: AbortController | null = null;

  async function persist(key: string): Promise<void> {
    if (!opts.statePath) return; // in-memory only (no StateDirectory)
    try {
      await Deno.writeTextFile(opts.statePath, key, { mode: 0o600 });
    } catch (e) {
      // Persistence is best-effort: the key still works for this run, it just
      // won't survive a restart. Never let it take the server down.
      console.error(
        `[Control] Could not persist API key (${opts.statePath}): ${e}`,
      );
    }
  }

  async function apply(
    rawKey: string,
    persistKey: boolean,
  ): Promise<KeyUpdateResult> {
    const key = rawKey.trim();
    if (!key) return { ok: false, message: "Empty API key" };
    if (key === current) {
      return { ok: true, message: "YouTube API key unchanged" };
    }

    current = key;
    if (persistKey) await persist(key);

    controller?.abort(); // stop the previous poller generation
    if (opts.channels.length === 0) {
      return {
        ok: true,
        message: "YouTube API key set (no channels configured)",
      };
    }
    controller = new AbortController();
    startYouTubePoller(
      { apiKey: key, channels: opts.channels },
      opts.getEmitter(),
      controller.signal,
    );
    const n = opts.channels.length;
    console.log(`[Control] YouTube poller (re)started for ${n} channel(s).`);
    return {
      ok: true,
      message: `YouTube API key accepted; polling ${n} channel(s)`,
    };
  }

  return { apply };
}

async function readKeyFile(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).trim() || null;
  } catch {
    return null; // not set yet — wait for a runtime key
  }
}

async function runServer(configPath: string): Promise<void> {
  const settings = await loadSettings(configPath);
  const statePath = keyStatePath(Deno.env.get("STATE_DIRECTORY"));

  // `keys` and `emitter` reference each other; the cycle is fine because each
  // only reaches the other through a deferred call: getEmitter() runs on a
  // control request (after `emitter` is assigned) and setYouTubeKey runs then too.
  const keys = createYouTubeKeyManager({
    getEmitter: () => emitter,
    channels: settings.youtube.channels,
    statePath,
  });
  const emitter = createServer(settings, {
    setYouTubeKey: (key) => keys.apply(key, true),
  });

  const { twitch, youtube } = settings;

  if (twitch.channels.length > 0) {
    startTwitchClient(twitch, emitter);
  } else {
    console.log("No Twitch channels configured.");
  }

  if (youtube.channels.length === 0) {
    console.log("No YouTube channels configured.");
    return;
  }

  const persisted = statePath ? await readKeyFile(statePath) : null;
  const startupKey = resolveStartupKey({
    persisted,
    env: Deno.env.get("YOUTUBE_API_KEY") ?? null,
    settings: youtube.apiKey,
  });
  if (startupKey) {
    // persist:false — don't rewrite a file we may have just read it from.
    await keys.apply(startupKey, false);
  } else {
    console.log(
      "YouTube channels configured but no API key yet. " +
        "Set one on the running server:  multichat set-youtube-key <KEY>",
    );
  }
}

function cliUsage(): string {
  return [
    "multichat — combined Twitch + YouTube live chat viewer",
    "",
    "Usage:",
    "  multichat [settings.json]                  run the server",
    "  multichat set-youtube-key [opts] [KEY]     set the YouTube API key on a running server",
    "  multichat fake [opts]                      play a demo of every message kind into a running server",
    "",
    "Options (set-youtube-key and fake share these):",
    "  -p, --port <port>   server port   (default: $PORT or 8080)",
    "  -h, --host <host>   server host   (default: $HOST or 127.0.0.1)",
    "      --help          show this help",
    "",
    "set-youtube-key: KEY may be passed as an argument or, preferably (keeps it out of",
    "the process list and shell history), piped on stdin:",
    '  echo -n "$YT_KEY" | multichat set-youtube-key',
    "",
    "fake: injects a scripted showcase of every message kind (chat, action, cheer, sub,",
    "raid, Super Chat, sticker, membership, system, a live deletion) into the SSE feed",
    "so you can preview how they render. Loopback-only, like set-youtube-key. Open the",
    "viewer (or /overlay), then:",
    "  multichat fake",
  ].join("\n");
}

/**
 * POST a body to a running server's loopback control endpoint, with the shared
 * "can't reach it" / "that's not multichat" error handling both CLI clients want.
 * Exits the process on a connection failure or a non-multichat responder; on a
 * reached multichat it returns the response + trimmed text for the caller to judge.
 */
async function postControl(
  host: string,
  port: number,
  path: string,
  body: string,
  contentType: string,
): Promise<{ res: Response; text: string }> {
  // The control endpoints are loopback-only; when the server binds 0.0.0.0 reach it
  // over loopback so the request actually originates from 127.0.0.1.
  const target = host === "0.0.0.0" ? "127.0.0.1" : host;

  let res: Response;
  try {
    res = await fetch(`http://${target}:${port}${path}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
  } catch (e) {
    console.error(`Could not reach multichat at ${target}:${port}: ${e}`);
    console.error("Is the server running and is the port correct?");
    Deno.exit(1);
  }

  const text = (await res.text()).trim();
  // No X-Multichat header on a failure => we reached some *other* server on this
  // port (another app, or multichat on a different port). Say so plainly instead
  // of surfacing that server's opaque error (e.g. a 401 from a neighbour).
  if (!res.ok && res.headers.get("x-multichat") === null) {
    console.error(
      `The server at ${target}:${port} does not look like multichat ` +
        `(HTTP ${res.status}, no X-Multichat header). Is multichat listening on ` +
        `that port? Pass the right one with --port <port>.`,
    );
    Deno.exit(1);
  }
  return { res, text };
}

/** CLI client: POST a key to a running server's loopback control endpoint. */
async function runSetYouTubeKey(args: string[]): Promise<void> {
  let host = Deno.env.get("HOST") ?? "127.0.0.1";
  let port = Number(Deno.env.get("PORT") ?? "8080");
  let key: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help") {
      console.log(cliUsage());
      Deno.exit(0);
    } else if (a === "-p" || a === "--port") {
      port = Number(args[++i]);
    } else if (a === "-h" || a === "--host") {
      host = args[++i] ?? host;
    } else {
      key = a;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    console.error("Invalid --port.");
    Deno.exit(2);
  }

  if (key === undefined) {
    key = (await new Response(Deno.stdin.readable).text()).trim();
  }
  key = key.trim();
  if (!key) {
    console.error("No API key provided (pass it as an argument or on stdin).");
    Deno.exit(2);
  }

  const { res, text } = await postControl(
    host,
    port,
    "/api/youtube-key",
    key,
    "text/plain",
  );
  if (res.ok) {
    console.log(text || "YouTube API key updated.");
    Deno.exit(0);
  }
  console.error(`Failed (HTTP ${res.status}): ${text}`);
  Deno.exit(1);
}

/**
 * CLI client: play the demo sequence into a running server's loopback /api/fake
 * endpoint, one event at a time, so the operator can watch every message kind
 * render in the viewer (or /overlay). Message control is intentionally omitted —
 * this is a fixed showcase (see docs/development/testing.md).
 */
async function runFake(args: string[]): Promise<void> {
  let host = Deno.env.get("HOST") ?? "127.0.0.1";
  let port = Number(Deno.env.get("PORT") ?? "8080");
  // ms between injected events, so they arrive as a readable trickle, not a burst.
  let gap = 450;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help") {
      console.log(cliUsage());
      Deno.exit(0);
    } else if (a === "-p" || a === "--port") {
      port = Number(args[++i]);
    } else if (a === "-h" || a === "--host") {
      host = args[++i] ?? host;
    } else if (a === "--gap") {
      gap = Number(args[++i]);
    } else if (a === "demo") {
      // `fake` and `fake demo` are the same; accept the explicit word too.
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error("Usage: multichat fake [--port P] [--host H] [--gap MS]");
      Deno.exit(2);
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    console.error("Invalid --port.");
    Deno.exit(2);
  }
  if (!Number.isFinite(gap) || gap < 0) gap = 450;

  const actions = demoActions(Date.now());
  console.log(`Playing ${actions.length} demo events into ${host}:${port} …`);
  for (const action of actions) {
    const { res, text } = await postControl(
      host,
      port,
      "/api/fake",
      serializeFakeAction(action),
      "application/json",
    );
    if (!res.ok) {
      console.error(`Failed (HTTP ${res.status}): ${text}`);
      Deno.exit(1);
    }
    console.log("  " + text);
    await new Promise((r) => setTimeout(r, gap));
  }
  console.log("Done. Reload the viewer if you don't see them.");
  Deno.exit(0);
}

const [first, ...rest] = Deno.args;
if (first === "set-youtube-key") {
  await runSetYouTubeKey(rest);
} else if (first === "fake") {
  await runFake(rest);
} else if (first === "--help" || first === "-h") {
  console.log(cliUsage());
} else {
  await runServer(first ?? "settings.json");
}

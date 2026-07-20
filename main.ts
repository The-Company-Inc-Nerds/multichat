import type {
  Emitter,
  Settings,
  TwitchEventSubChannelConfig,
  TwitchEventSubConfig,
  YouTubeChannelConfig,
} from "./src/types.ts";
import { startTwitchClient } from "./src/twitch.ts";
import { startYouTubePoller } from "./src/youtube.ts";
import { createServer } from "./src/server.ts";
import { normalizeAlertsConfig } from "./src/alerts.ts";
import {
  type EventSubChannelContext,
  startTwitchEventSub,
} from "./src/eventsub.ts";
import {
  buildAuthCodeRequest,
  buildAuthorizeUrl,
  buildRefreshRequest,
  buildUsersRequest,
  EVENTSUB_SCOPES,
  parseTokenResponse,
  parseUsersResponse,
} from "./src/twitchauth.ts";
import {
  keyStatePath,
  type KeyUpdateResult,
  resolveStartupKey,
  twitchBroadcasterStatePath,
  twitchTokenStatePath,
} from "./src/control.ts";
import {
  demoActions,
  type FakeAction,
  fakeActionForKind,
  MESSAGE_KINDS,
  serializeFakeAction,
} from "./src/fake.ts";

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
      eventsub: parseEventSubConfig(raw.twitch?.eventsub),
    },
    youtube: {
      // The key is resolved separately at startup (persisted/env/settings) so the
      // operator can also set it at runtime; see resolveStartupKey.
      apiKey: raw.youtube?.apiKey ?? "",
      channels: raw.youtube?.channels ?? [],
    },
    alerts: normalizeAlertsConfig(raw.alerts),
  };
}

// deno-lint-ignore no-explicit-any
function parseEventSubConfig(raw: any): TwitchEventSubConfig | undefined {
  const channels: TwitchEventSubChannelConfig[] = Array.isArray(raw?.channels)
    ? raw.channels
    : [];
  if (channels.length === 0) return undefined;
  return {
    clientId: raw?.clientId ?? "",
    // The client secret is a real secret; allow an env override so it need not sit
    // in settings.json (mirrors the YouTube key). See docs/configuration.md.
    clientSecret: Deno.env.get("TWITCH_CLIENT_SECRET") ?? raw?.clientSecret ??
      "",
    channels,
  };
}

/** Best-effort persist a value to a state file (0600). Never throws — a failure
 *  just means it won't survive a restart, matching the YouTube key's behavior. */
async function persistState(path: string, value: string): Promise<void> {
  try {
    await Deno.writeTextFile(path, value, { mode: 0o600 });
  } catch (e) {
    console.error(`[Control] Could not persist ${path}: ${e}`);
  }
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

/**
 * Owns the Twitch EventSub connections. One WebSocket per broadcaster (a WS
 * session may only carry one user's token), each with its own token lifecycle:
 * refresh tokens rotate, so the manager refreshes reactively (single-flight) and
 * persists the rotated token before use. Broadcaster ids are resolved once and
 * cached. Mirrors createYouTubeKeyManager's "logic here, pure helpers in src/" split.
 */
function createTwitchEventSubManager(opts: {
  getEmitter: () => Emitter;
  config: TwitchEventSubConfig;
  stateDir: string | null;
}) {
  const { clientId, clientSecret } = opts.config;

  async function startChannel(ch: TwitchEventSubChannelConfig): Promise<void> {
    const login = (ch.login ?? "").toLowerCase();
    const label = login || ch.broadcasterId || "unknown";

    let broadcasterId = ch.broadcasterId ?? "";
    let refreshToken = ch.refreshToken ?? "";
    let accessToken = "";
    let expiresAt = 0;
    let inflight: Promise<string | null> | null = null;
    let tokenPath: string | null = null;

    // If the broadcaster id is known up front (config or cache), we can key the
    // persisted (rotated) refresh token by it and prefer that over settings.
    const bidCachePath = twitchBroadcasterStatePath(opts.stateDir, login);
    if (!broadcasterId && bidCachePath) {
      broadcasterId = (await readKeyFile(bidCachePath)) ?? "";
    }
    if (broadcasterId) {
      tokenPath = twitchTokenStatePath(opts.stateDir, broadcasterId);
      const persisted = tokenPath ? await readKeyFile(tokenPath) : null;
      if (persisted) refreshToken = persisted;
    }

    async function doRefresh(): Promise<string | null> {
      if (!refreshToken) {
        console.error(
          `[EventSub] ${label}: no refresh token — run: multichat twitch-login`,
        );
        return null;
      }
      const req = buildRefreshRequest(clientId, clientSecret, refreshToken);
      let json: unknown = null;
      try {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        json = await res.json();
      } catch (e) {
        console.error(`[EventSub] ${label}: token refresh failed: ${e}`);
        return null;
      }
      const parsed = parseTokenResponse(json);
      if (!parsed.ok) {
        console.error(
          `[EventSub] ${label}: token refresh rejected: ${parsed.message}`,
        );
        return null;
      }
      // Rotation: persist the new refresh token BEFORE using the new access token,
      // so a crash can't strand us with an already-invalidated refresh token.
      refreshToken = parsed.refreshToken;
      if (tokenPath) await persistState(tokenPath, refreshToken);
      accessToken = parsed.accessToken;
      // Refresh a minute early to avoid using a token that expires mid-request.
      expiresAt = Date.now() + Math.max(0, parsed.expiresIn - 60) * 1000;
      return accessToken;
    }

    // Single-flight: overlapping 401s share one refresh instead of racing (which
    // would rotate the token twice and invalidate the loser).
    function getToken(force?: boolean): Promise<string | null> {
      if (!force && accessToken && Date.now() < expiresAt) {
        return Promise.resolve(accessToken);
      }
      if (!inflight) {
        inflight = doRefresh().finally(() => {
          inflight = null;
        });
      } else if (force) {
        // A forced refresh (after a 401) must not reuse an in-flight refresh that
        // began *before* the failure — that could hand back the same stale token.
        // Chain a fresh refresh after the current one so force always yields a
        // newly-minted token.
        inflight = inflight.catch(() => null).then(() => doRefresh()).finally(
          () => {
            inflight = null;
          },
        );
      }
      return inflight;
    }

    const token = await getToken();
    if (!token) {
      console.error(
        `[EventSub] ${label}: no usable token — skipping this channel`,
      );
      return;
    }

    if (!broadcasterId) {
      if (!login) {
        console.error(
          "[EventSub] a channel needs a login or broadcasterId — skipping",
        );
        return;
      }
      const req = buildUsersRequest(login, clientId, token);
      try {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
        });
        broadcasterId = parseUsersResponse(await res.json())?.id ?? "";
      } catch (e) {
        console.error(`[EventSub] ${label}: broadcaster lookup failed: ${e}`);
      }
      if (!broadcasterId) {
        console.error(
          `[EventSub] ${label}: could not resolve broadcaster id — skipping`,
        );
        return;
      }
      // Cache the id and (re)point the token file at it, persisting the current token.
      if (bidCachePath) await persistState(bidCachePath, broadcasterId);
      tokenPath = twitchTokenStatePath(opts.stateDir, broadcasterId);
      if (tokenPath) await persistState(tokenPath, refreshToken);
    }

    const ctx: EventSubChannelContext = {
      clientId,
      broadcasterId,
      channelLabel: login || broadcasterId,
      emitter: opts.getEmitter(),
      getToken,
    };
    startTwitchEventSub(ctx);
  }

  function start(): void {
    const seen = new Set<string>();
    for (const ch of opts.config.channels) {
      // Dedupe by login so one broadcaster never opens two sockets.
      const key = (ch.login ?? ch.broadcasterId ?? "").toLowerCase();
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      startChannel(ch).catch((e) =>
        console.error(`[EventSub] channel setup error: ${e}`)
      );
    }
  }

  return { start };
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
  const stateDir = Deno.env.get("STATE_DIRECTORY") ?? null;
  const statePath = keyStatePath(stateDir);

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

  // Channels with EventSub creds get their follow/cheer/sub/raid events from
  // EventSub; IRC then carries only their chat text (avoids duplicate events).
  const covered = new Set(
    (twitch.eventsub?.channels ?? [])
      .map((c) => (c.login ?? "").toLowerCase())
      .filter((l) => l),
  );

  if (twitch.channels.length > 0) {
    startTwitchClient(
      twitch,
      emitter,
      covered.size ? (ch) => covered.has(ch.toLowerCase()) : undefined,
    );
  } else {
    console.log("No Twitch channels configured.");
  }

  if (twitch.eventsub && twitch.eventsub.channels.length > 0) {
    if (!twitch.eventsub.clientId || !twitch.eventsub.clientSecret) {
      console.log(
        "Twitch EventSub is configured but clientId/clientSecret is missing — " +
          "skipping EventSub (follows/cheers/subs/raids will not appear).",
      );
    } else {
      createTwitchEventSubManager({
        getEmitter: () => emitter,
        config: twitch.eventsub,
        stateDir,
      }).start();
    }
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
    "  multichat login [opts]                     authorize a Twitch channel for EventSub alerts",
    "  multichat fake [kind] [opts]               inject fake events (all kinds, or just one) into a running server",
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
    "login (alias: twitch-login): runs the Twitch OAuth flow (via a temporary loopback",
    "redirect) and prints a settings.json snippet with the channel's refresh token, so",
    "EventSub can deliver follow/cheer/sub/raid alerts. It prompts for the Twitch app's",
    "Client ID + Secret if they aren't already in settings.json / flags / env. Register",
    "http://localhost:3000 as the app's OAuth redirect URL (or pass --redirect-port):",
    "  multichat login",
    "",
    "fake: injects fake events into the SSE feed so you can preview how they render —",
    "including on /alerts and /overlay. With no kind it plays the full showcase (chat,",
    "action, cheer, sub, raid, follow, Super Chat, sticker, membership, system, a live",
    "deletion); `fake <kind>` injects just one. Loopback-only, like set-youtube-key.",
    "Open the viewer (or /overlay, /alerts), then:",
    "  multichat fake            # the whole showcase",
    "  multichat fake follow     # just a Twitch follow (e.g. to preview an alert theme)",
    "  kind is one of: chat, action, cheer, sub, raid, follow, superchat, supersticker, membership, system",
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
 * CLI client: inject fake events into a running server's loopback /api/fake
 * endpoint so the operator can watch how they render (in the viewer, /overlay, or
 * /alerts). With no kind it plays the full curated showcase; `fake <kind>` injects
 * a single event of that kind — e.g. `fake follow` — for a quick preview. See
 * docs/development/testing.md.
 */
async function runFake(args: string[]): Promise<void> {
  let host = Deno.env.get("HOST") ?? "127.0.0.1";
  let port = Number(Deno.env.get("PORT") ?? "8080");
  // ms between injected events, so they arrive as a readable trickle, not a burst.
  let gap = 450;
  let kind: string | undefined; // a single kind to fake; undefined = full showcase

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
    } else if (MESSAGE_KINDS.includes(a)) {
      kind = a; // e.g. `fake follow` — inject just this one kind
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(
        "Usage: multichat fake [kind] [--port P] [--host H] [--gap MS]",
      );
      console.error(`  kind is one of: ${MESSAGE_KINDS.join(", ")}`);
      Deno.exit(2);
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    console.error("Invalid --port.");
    Deno.exit(2);
  }
  if (!Number.isFinite(gap) || gap < 0) gap = 450;

  let actions: FakeAction[];
  if (kind) {
    const one = fakeActionForKind(kind, Date.now());
    if (!one) {
      console.error(`No sample available for kind: ${kind}`);
      Deno.exit(2);
    }
    actions = [one];
    console.log(`Injecting a fake ${kind} into ${host}:${port} …`);
  } else {
    actions = demoActions(Date.now());
    console.log(`Playing ${actions.length} demo events into ${host}:${port} …`);
  }
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

/** Read the Twitch app clientId/clientSecret from env, then settings.json. */
async function loadEventSubCreds(
  settingsPath: string,
): Promise<{ clientId: string; clientSecret: string }> {
  let clientId = Deno.env.get("TWITCH_CLIENT_ID") ?? "";
  let clientSecret = Deno.env.get("TWITCH_CLIENT_SECRET") ?? "";
  try {
    const raw = JSON.parse(await Deno.readTextFile(settingsPath));
    clientId = clientId || raw?.twitch?.eventsub?.clientId || "";
    clientSecret = clientSecret || raw?.twitch?.eventsub?.clientSecret || "";
  } catch { /* no/unreadable settings — rely on env or flags */ }
  return { clientId, clientSecret };
}

/**
 * CLI client: run the Twitch Authorization Code flow to mint a channel's EventSub
 * refresh token. Spins up a temporary loopback server as the OAuth redirect
 * target, prints the authorize URL, captures the returned code, exchanges it, and
 * prints a settings.json snippet (login + broadcasterId + refreshToken). The
 * operator must be logged into Twitch as the broadcaster they want to monitor.
 */
async function runTwitchLogin(args: string[]): Promise<void> {
  let settingsPath = "settings.json";
  let redirectPort = 3000;
  let clientId = "";
  let clientSecret = "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help") {
      console.log(cliUsage());
      Deno.exit(0);
    } else if (a === "--redirect-port") {
      redirectPort = Number(args[++i]);
    } else if (a === "--client-id") {
      clientId = args[++i] ?? "";
    } else if (a === "--client-secret") {
      clientSecret = args[++i] ?? "";
    } else if (a === "--settings") {
      settingsPath = args[++i] ?? settingsPath;
    } else {
      settingsPath = a; // positional settings path
    }
  }

  if (!Number.isFinite(redirectPort) || redirectPort <= 0) {
    console.error("Invalid --redirect-port.");
    Deno.exit(2);
  }
  const redirectUri = `http://localhost:${redirectPort}`;

  const fromFile = await loadEventSubCreds(settingsPath);
  clientId = clientId || fromFile.clientId;
  clientSecret = clientSecret || fromFile.clientSecret;

  // Nothing configured yet? Walk the operator through it interactively, so this is
  // just "run the command and follow the prompts" — no editing settings.json first.
  if (!clientId || !clientSecret) {
    console.log(
      "\nTo receive Twitch alerts you need a Twitch application (one-time setup):\n" +
        "  1. Open https://dev.twitch.tv/console/apps and 'Register Your Application'\n" +
        `  2. Set an OAuth Redirect URL of exactly: ${redirectUri}\n` +
        "  3. Copy its Client ID and generate a Client Secret\n",
    );
    if (!clientId) clientId = (prompt("Client ID:") ?? "").trim();
    if (!clientSecret) clientSecret = (prompt("Client Secret:") ?? "").trim();
    console.log("");
  }
  if (!clientId || !clientSecret) {
    console.error(
      "A Client ID and Client Secret are required. Enter them at the prompt, or set " +
        "twitch.eventsub in settings.json (or --client-id/--client-secret, or " +
        "TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET).",
    );
    Deno.exit(2);
  }
  const state = `mc-${Math.random().toString(36).slice(2)}-${
    Math.random().toString(36).slice(2)
  }`;
  const authUrl = buildAuthorizeUrl(
    clientId,
    redirectUri,
    EVENTSUB_SCOPES,
    state,
  );

  console.log(
    "\nOpen this URL in a browser signed in as the broadcaster to authorize:\n",
  );
  console.log("  " + authUrl + "\n");
  console.log(`Waiting for the redirect to ${redirectUri} …\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const ac = new AbortController();
    // Don't wait forever if the operator never completes the browser flow.
    const timeout = setTimeout(() => {
      ac.abort();
      reject(
        new Error("timed out waiting for the authorization redirect (5m)"),
      );
    }, 5 * 60_000);
    const settle = (fn: () => void) => {
      clearTimeout(timeout);
      // Give the response a moment to flush before tearing down the listener.
      setTimeout(() => {
        ac.abort();
        fn();
      }, 150);
    };
    Deno.serve(
      {
        port: redirectPort,
        hostname: "127.0.0.1",
        signal: ac.signal,
        onListen() {},
      },
      (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/") {
          return new Response("Not found", { status: 404 });
        }
        const oauthErr = u.searchParams.get("error");
        if (oauthErr) {
          settle(() =>
            reject(
              new Error(
                `${oauthErr}: ${u.searchParams.get("error_description")}`,
              ),
            )
          );
          return htmlResponse(
            "<h2>Authorization failed</h2>You can close this tab.",
          );
        }
        const gotCode = u.searchParams.get("code");
        if (!gotCode || u.searchParams.get("state") !== state) {
          return new Response("Bad request", { status: 400 });
        }
        settle(() => resolve(gotCode));
        return htmlResponse(
          "<h2>multichat: authorized ✓</h2>You can close this tab and return to the terminal.",
        );
      },
    );
  });

  const tokReq = buildAuthCodeRequest(
    clientId,
    clientSecret,
    code,
    redirectUri,
  );
  const tokRes = await fetch(tokReq.url, {
    method: tokReq.method,
    headers: tokReq.headers,
    body: tokReq.body,
  });
  const tok = parseTokenResponse(await tokRes.json().catch(() => null));
  if (!tok.ok) {
    console.error(`Token exchange failed: ${tok.message}`);
    Deno.exit(1);
  }

  const usersReq = buildUsersRequest("", clientId, tok.accessToken);
  const usersRes = await fetch(usersReq.url, {
    method: usersReq.method,
    headers: usersReq.headers,
  });
  const user = parseUsersResponse(await usersRes.json().catch(() => null));

  console.log("Authorized ✓");
  if (user) console.log(`Channel: ${user.login} (broadcaster id ${user.id})`);
  console.log(
    "\nAdd this entry to settings.json under twitch.eventsub.channels:\n",
  );
  console.log(
    JSON.stringify(
      {
        login: user?.login ?? "<your-login>",
        broadcasterId: user?.id,
        refreshToken: tok.refreshToken,
      },
      null,
      2,
    ),
  );
  console.log(
    "\nThe refresh token rotates on first use; with a state directory the server " +
      "persists the rotated one, so this seed is only needed once.",
  );
  Deno.exit(0);
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const [first, ...rest] = Deno.args;
if (first === "set-youtube-key") {
  await runSetYouTubeKey(rest);
} else if (first === "twitch-login" || first === "login") {
  await runTwitchLogin(rest);
} else if (first === "fake") {
  await runFake(rest);
} else if (first === "--help" || first === "-h") {
  console.log(cliUsage());
} else {
  await runServer(first ?? "settings.json");
}

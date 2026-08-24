import type {
  Emitter,
  GiveawayCampaignState,
  GiveawayConfig,
  GiveawayDraw,
  GiveawayMessages,
  GiveawayState,
  GiveawayWinner,
  Settings,
  TwitchConfig,
  TwitchEventSubChannelConfig,
  TwitchEventSubConfig,
  YouTubeChannelConfig,
} from "./src/types.ts";
import { startTwitchClient, type TwitchChatMessage } from "./src/twitch.ts";
import { startYouTubePoller } from "./src/youtube.ts";
import { createServer } from "./src/server.ts";
import { normalizeAlertsConfig } from "./src/alerts.ts";
import {
  type EventSubChannelContext,
  type FollowEvent,
  type FollowHandler,
  startTwitchEventSub,
} from "./src/eventsub.ts";
import {
  buildAuthCodeRequest,
  buildAuthorizeUrl,
  buildCheckFollowRequest,
  buildRefreshRequest,
  buildSendChatMessageRequest,
  buildUsersRequest,
  CHAT_WRITE_SCOPE,
  LOGIN_SCOPES,
  parseFollowersResponse,
  parseTokenResponse,
  parseUsersResponse,
} from "./src/twitchauth.ts";
import {
  giveawayCampaignStatePath,
  type GiveawayHooks,
  giveawayPoolStatePath,
  giveawayWinnersLogPath,
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
import {
  addEntrant,
  campaignSummary,
  closePool,
  decideEligibility,
  demoEntrants,
  demoFollowerIds,
  drawSegmented,
  emptyCampaign,
  emptyPool,
  type GiveawayAction,
  giveawayMessage,
  hasEntrant,
  matchGiveawayCommand,
  normalizeCampaignState,
  normalizeGiveawayConfig,
  normalizePoolState,
  openPool,
  parseWinnersLog,
  recordFollower,
  removeEntrant,
  resetPool,
  serializeGiveawayAction,
  serializeWinnerLine,
  winnersToCsv,
  winnerTier,
} from "./src/giveaway.ts";

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
    giveaway: normalizeGiveawayConfig(raw.giveaway),
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

/** Best-effort append one line to a state file (0600) — the winners JSONL.
 *  Append-only means a crash can corrupt at most the trailing line. */
async function appendState(path: string, line: string): Promise<void> {
  try {
    await Deno.writeTextFile(path, line + "\n", { append: true, mode: 0o600 });
  } catch (e) {
    console.error(`[Control] Could not append to ${path}: ${e}`);
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
/** A channel's broadcaster id + token accessor, reused by the giveaway engine to
 *  run the follow check and post chat replies with the broadcaster's authority. */
export interface ChannelAuth {
  broadcasterId: string;
  getToken: (force?: boolean) => Promise<string | null>;
}

function createTwitchEventSubManager(opts: {
  getEmitter: () => Emitter;
  config: TwitchEventSubConfig;
  stateDir: string | null;
  /** Optional follow observer, forwarded to every channel's EventSub socket
   *  (the giveaway milestone counter). */
  onFollow?: FollowHandler;
}) {
  const { clientId, clientSecret } = opts.config;

  // Per-channel auth, keyed by lowercased login and by broadcaster id, populated
  // once a channel's broadcaster id + token are fully resolved (see startChannel).
  const channelAuth = new Map<string, ChannelAuth>();

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

    // Now that the broadcaster id + token are usable, publish this channel's auth
    // so the giveaway engine can call Helix with the broadcaster's authority.
    const auth: ChannelAuth = { broadcasterId, getToken };
    if (login) channelAuth.set(login, auth);
    channelAuth.set(broadcasterId, auth);

    const ctx: EventSubChannelContext = {
      clientId,
      broadcasterId,
      channelLabel: login || broadcasterId,
      emitter: opts.getEmitter(),
      getToken,
      onFollow: opts.onFollow,
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

  /** A channel's auth once resolved, by login or broadcaster id; undefined until
   *  its startChannel completes (the giveaway engine treats that as "can't verify"). */
  function getChannelAuth(key: string): ChannelAuth | undefined {
    return channelAuth.get(key.toLowerCase());
  }

  return { start, getChannelAuth };
}

async function readKeyFile(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).trim() || null;
  } catch {
    return null; // not set yet — wait for a runtime key
  }
}

/**
 * The giveaway engine (Twitch-only). Watches chat for the configured command,
 * gates entries on a live Helix follow check (fail-closed when it can't be run),
 * collects eligible viewers, persists the pool, optionally replies in chat as the
 * broadcaster (fail-soft), and drives the /giveaway page via the ServerHooks it
 * exposes. Campaign mode adds a guaranteed first-N queue, a live follower
 * counter (fed by onFollow from EventSub) arming milestone draw credits, and an
 * append-only winners log (the mailing list). Pure logic lives in
 * src/giveaway.ts; this is the wiring.
 */
function createGiveawayEngine(opts: {
  config: GiveawayConfig;
  clientId: string;
  stateDir: string | null;
  /** False when followerStep > 0 but follow events can't arrive (no EventSub). */
  followTracking: boolean;
  getChannelAuth: (login: string) => ChannelAuth | undefined;
  getBroadcast: () =>
    | ((state: GiveawayState, draw?: GiveawayDraw) => void)
    | undefined;
}): {
  onMessage: (m: TwitchChatMessage) => Promise<void>;
  onFollow: FollowHandler;
  hooks: GiveawayHooks;
  init: () => Promise<void>;
} {
  const { config } = opts;
  const poolPath = giveawayPoolStatePath(opts.stateDir);
  const campaignPath = giveawayCampaignStatePath(opts.stateDir);
  const winnersPath = giveawayWinnersLogPath(opts.stateDir);
  let state: GiveawayState = emptyPool(true);
  let campaign: GiveawayCampaignState = emptyCampaign();
  let winners: GiveawayWinner[] = [];

  /** The broadcast/return view: state with the derived campaign snapshot
   *  attached (counts + recent winners — never the full list). */
  function view(): GiveawayState {
    state.campaign = campaignSummary(
      state,
      campaign,
      config,
      winners,
      opts.followTracking,
    );
    return state;
  }

  // `draw` rides along only on a draw, so every connected page (incl. the OBS
  // overlay) plays the case-opening reel over the pre-removal entrant list.
  function broadcast(draw?: GiveawayDraw): void {
    opts.getBroadcast()?.(view(), draw);
  }
  function persist(): void {
    // The derived summary is not persisted (normalizePoolState drops it on load).
    if (poolPath) {
      const { campaign: _drop, ...bare } = state;
      void persistState(poolPath, JSON.stringify(bare));
    }
  }
  function persistCampaign(): void {
    if (campaignPath) void persistState(campaignPath, JSON.stringify(campaign));
  }

  /** Restore persisted pool + campaign + winners at startup (best-effort;
   *  corrupt files start empty — a bad winners line is skipped, not fatal). */
  async function init(): Promise<void> {
    if (poolPath) {
      const raw = await readKeyFile(poolPath);
      if (raw) {
        try {
          const restored = normalizePoolState(JSON.parse(raw));
          if (restored) state = restored;
        } catch { /* corrupt — start empty */ }
      }
    }
    if (campaignPath) {
      const raw = await readKeyFile(campaignPath);
      if (raw) {
        try {
          const restored = normalizeCampaignState(JSON.parse(raw));
          if (restored) campaign = restored;
        } catch { /* corrupt — start empty */ }
      }
    }
    if (winnersPath) {
      try {
        winners = parseWinnersLog(await Deno.readTextFile(winnersPath));
      } catch { /* no log yet */ }
    }
  }

  // Helix follow check with one forced-refresh retry on 401. Returns undefined
  // when it can't be determined (no auth / network / rate limit) so callers fail
  // closed — a "must follow" gate must not grant an unverifiable entry.
  async function checkFollow(userId: string): Promise<boolean | undefined> {
    const auth = opts.getChannelAuth(config.channel);
    if (!auth) {
      console.error(
        `[Giveaway] ${config.channel}: no EventSub token — cannot verify follow ` +
          `(authorize it with 'multichat login', or set requireFollow=false).`,
      );
      return undefined;
    }
    return await helixFollow(auth, userId, false);
  }

  async function helixFollow(
    auth: ChannelAuth,
    userId: string,
    retried: boolean,
  ): Promise<boolean | undefined> {
    const token = await auth.getToken(retried);
    if (!token) return undefined;
    const req = buildCheckFollowRequest(
      auth.broadcasterId,
      userId,
      opts.clientId,
      token,
    );
    let res: Response;
    try {
      res = await fetch(req.url, { method: req.method, headers: req.headers });
    } catch (e) {
      console.error(`[Giveaway] follow check failed: ${e}`);
      return undefined;
    }
    if (res.status === 401 && !retried) {
      await res.body?.cancel();
      return helixFollow(auth, userId, true); // token expired mid-flight — refresh once
    }
    if (!res.ok) {
      await res.body?.cancel();
      console.error(`[Giveaway] follow check HTTP ${res.status}`);
      return undefined;
    }
    return parseFollowersResponse(await res.json().catch(() => null));
  }

  // Post a reply as the broadcaster. Fail-soft: a missing user:write:chat scope or
  // any transient error is logged but never blocks an entry or the reel.
  async function reply(
    key: keyof GiveawayMessages,
    user: string,
    vars?: Record<string, string | number>,
  ): Promise<void> {
    if (!config.replies) return;
    const auth = opts.getChannelAuth(config.channel);
    if (!auth) return;
    const token = await auth.getToken();
    if (!token) return;
    const req = buildSendChatMessageRequest(
      auth.broadcasterId,
      auth.broadcasterId,
      giveawayMessage(config, key, user, vars),
      opts.clientId,
      token,
    );
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error(
          `[Giveaway] chat reply failed (HTTP ${res.status}). Ensure the token ` +
            `carries ${CHAT_WRITE_SCOPE} — re-run 'multichat login' for ` +
            `${config.channel}. ${t}`,
        );
      } else {
        await res.body?.cancel();
      }
    } catch (e) {
      console.error(`[Giveaway] chat reply error: ${e}`);
    }
  }

  async function onMessage(m: TwitchChatMessage): Promise<void> {
    if (!config.enabled) return;
    if (m.channel.toLowerCase() !== config.channel) return;
    if (!matchGiveawayCommand(m.text, config.prefix, config.command)) return;
    if (!m.userId) return; // no stable id — can't dedupe/verify
    if (!state.open) return; // entries closed; ignore silently
    if (hasEntrant(state, m.userId)) {
      await reply("alreadyEntered", m.displayName);
      return;
    }
    let following: boolean | undefined;
    if (config.requireFollow) following = await checkFollow(m.userId);
    const decision = decideEligibility(config.requireFollow, { following });
    if (!decision.eligible) {
      if (decision.reason === "not-following") {
        await reply("notFollowing", m.displayName);
      }
      // "unverifiable" already logged in checkFollow; stay quiet in chat.
      return;
    }
    const added = addEntrant(state, {
      userId: m.userId,
      login: m.login,
      displayName: m.displayName,
      enteredAt: Date.now(),
    });
    if (!added.added) return;
    state = added.state;
    persist();
    broadcast();
    // Entrants within the guaranteed first-N (or any entrant when firstN is
    // off) get `entered`; later entrants get `enteredPool` — they're in the
    // milestone draw pool, not the guaranteed queue.
    const number = state.nextNumber - 1; // the number just assigned
    if (config.firstN > 0 && number > config.firstN) {
      await reply("enteredPool", m.displayName, { number });
    } else {
      await reply("entered", m.displayName, {
        number,
        remaining: config.firstN > 0
          ? Math.max(0, config.firstN - number)
          : 0,
      });
    }
  }

  /** Count a new follower toward the milestone campaign (deduped by user id).
   *  A crossing announces in chat and arms advisory draw credits; every counted
   *  follow updates the on-screen progress via broadcast. */
  function onFollow(f: FollowEvent): void {
    if (!config.enabled || config.followerStep <= 0) return;
    if (f.channel.toLowerCase() !== config.channel) return;
    const r = recordFollower(campaign, f.userId, config);
    if (!r.counted) return;
    campaign = r.campaign;
    persistCampaign();
    broadcast();
    if (r.milestoneCrossed !== null) {
      console.log(
        `[Giveaway] milestone ${r.milestoneCrossed} reached ` +
          `(${campaign.followerCount} new followers) — ` +
          `${campaign.creditsRemaining} draw credit(s) armed.`,
      );
      void reply("milestone", f.displayName, {
        count: campaign.followerCount,
        milestone: r.milestoneCrossed,
        draws: config.milestoneDraws,
      });
    }
  }

  const hooks: GiveawayHooks = {
    getState: () => view(),
    open: () => {
      state = openPool(state);
      persist();
      broadcast();
      return view();
    },
    close: () => {
      state = closePool(state);
      persist();
      broadcast();
      return view();
    },
    reset: () => {
      state = resetPool(state);
      persist();
      broadcast();
      return view();
    },
    remove: (userId) => {
      state = removeEntrant(state, userId);
      persist();
      broadcast();
      return view();
    },
    draw: () => {
      // Guaranteed queue first (who's-next-pack), then the milestone pool.
      const r = drawSegmented(state, config.firstN, Math.random);
      state = r.state;
      if (r.winner) {
        const tier = winnerTier(
          r.winner.number,
          config.firstN,
          campaign.creditsRemaining,
          campaign.milestonesReached,
        );
        if (tier.startsWith("milestone-")) {
          campaign = {
            ...campaign,
            creditsRemaining: campaign.creditsRemaining - 1,
          };
          persistCampaign();
        }
        const w: GiveawayWinner = {
          userId: r.winner.userId,
          login: r.winner.login,
          displayName: r.winner.displayName,
          number: r.winner.number,
          enteredAt: r.winner.enteredAt,
          wonAt: Date.now(),
          tier,
        };
        // Append the mailing-list record BEFORE the pool persist: a crash here
        // can only leave the winner still in the pool (operator-visible), never
        // an un-recorded winner.
        winners.push(w);
        if (winnersPath) void appendState(winnersPath, serializeWinnerLine(w));
      }
      persist();
      broadcast(
        r.winner
          ? { winner: r.winner, reel: r.reel, segment: r.segment }
          : undefined,
      );
      if (r.winner) {
        void reply("winner", r.winner.displayName, { number: r.winner.number });
      }
      return { state: view(), winner: r.winner, segment: r.segment };
    },
    demo: () => {
      // Open the pool and add the sample entrants (deduped by their stable ids),
      // so the reel has something to run without a live stream. When follower
      // milestones are configured, also simulate ~60% progress toward the next
      // one (stable fake ids — idempotent). No chat replies.
      state = openPool(state);
      for (const e of demoEntrants(Date.now())) {
        state = addEntrant(state, e).state;
      }
      if (config.followerStep > 0) {
        const target = Math.floor(config.followerStep * 0.6);
        for (const id of demoFollowerIds(target)) {
          const r = recordFollower(campaign, id, config);
          campaign = r.campaign;
        }
        persistCampaign();
      }
      persist();
      broadcast();
      return view();
    },
    winners: () => winners.slice(),
    campaignReset: () => {
      // Zero the whole campaign. The winners log is a physical mailing list —
      // archive it (rename) rather than delete, best-effort.
      if (winnersPath && winners.length > 0) {
        void Deno.rename(winnersPath, `${winnersPath}.bak-${Date.now()}`)
          .catch((e) =>
            console.error(`[Giveaway] could not archive winners log: ${e}`)
          );
      }
      winners = [];
      campaign = emptyCampaign();
      state = { ...emptyPool(state.open) };
      persistCampaign();
      persist();
      broadcast();
      return view();
    },
  };

  return { onMessage, onFollow, hooks, init };
}

/** Log giveaway setup problems at startup (the follow gate depends on EventSub;
 *  chat replies depend on a re-authorized token) so a misconfig is visible early. */
function warnGiveawaySetup(config: GiveawayConfig, twitch: TwitchConfig): void {
  console.log(
    `[Giveaway] enabled on #${config.channel || "(unset)"} — command ` +
      `"${config.prefix}${config.command}".`,
  );
  if (!config.channel) {
    console.error(
      "[Giveaway] no channel set — set giveaway.channel to the Twitch login to run it on.",
    );
    return;
  }
  const chatChannels = twitch.channels.map((c) => c.toLowerCase());
  if (!chatChannels.includes(config.channel)) {
    console.error(
      `[Giveaway] "${config.channel}" is not in twitch.channels — the server won't ` +
        `join its chat, so ${config.prefix}${config.command} will never be seen.`,
    );
  }
  const esChannels = (twitch.eventsub?.channels ?? [])
    .map((c) => (c.login ?? "").toLowerCase());
  if (config.requireFollow && !esChannels.includes(config.channel)) {
    console.error(
      `[Giveaway] requireFollow is on but "${config.channel}" has no EventSub token ` +
        `— follow checks can't run, so entries fail closed. Authorize it with ` +
        `'multichat login', or set requireFollow=false.`,
    );
  }
  if (config.replies) {
    console.log(
      `[Giveaway] replies are on — the bot posts as the broadcaster (needs the ` +
        `${CHAT_WRITE_SCOPE} scope; re-run 'multichat login' for ${config.channel} ` +
        `if replies return 401).`,
    );
  }
  if (config.firstN > 0 || config.followerStep > 0) {
    console.log(
      `[Giveaway] campaign: first ${config.firstN} guaranteed` +
        (config.followerStep > 0
          ? `, +${config.milestoneDraws} draw(s) per ${config.followerStep} new followers`
          : ", no follower milestones"),
    );
  }
  if (config.followerStep > 0 && !esChannels.includes(config.channel)) {
    console.error(
      `[Giveaway] followerStep is set but "${config.channel}" has no EventSub ` +
        `connection — follow events can't be received, so milestone progress ` +
        `won't advance. Authorize it with 'multichat login'.`,
    );
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

  // The giveaway engine (when enabled) needs the per-channel broadcaster token to
  // run the follow check + post replies, but the EventSub manager only resolves it
  // later; this mutable accessor bridges the ordering (a no-op until start below).
  let getChannelAuth: (login: string) => ChannelAuth | undefined = () =>
    undefined;
  const giveawayCfg = settings.giveaway;
  // Follower milestones need follow events, which only arrive for channels with
  // an EventSub connection — surface "tracking unavailable" honestly in the UI.
  const esLogins = new Set(
    (settings.twitch.eventsub?.channels ?? [])
      .map((c) => (c.login ?? "").toLowerCase())
      .filter((l) => l),
  );
  const followTracking = !!settings.twitch.eventsub?.clientId &&
    esLogins.has(giveawayCfg?.channel ?? "");
  const giveawayEngine = giveawayCfg?.enabled
    ? createGiveawayEngine({
      config: giveawayCfg,
      clientId: settings.twitch.eventsub?.clientId ?? "",
      stateDir,
      followTracking,
      getChannelAuth: (login) => getChannelAuth(login),
      getBroadcast: () => broadcastGiveaway,
    })
    : undefined;
  if (giveawayEngine) await giveawayEngine.init();

  // `keys`/`giveawayEngine` reference `emitter`/`broadcastGiveaway` only through
  // deferred callbacks, so the forward reference to this destructure is fine.
  const { emitter, broadcastGiveaway } = createServer(settings, {
    setYouTubeKey: (key) => keys.apply(key, true),
    giveaway: giveawayEngine?.hooks,
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
      giveawayEngine
        ? (m) =>
          void giveawayEngine.onMessage(m).catch((e) =>
            console.error(`[Giveaway] handler error: ${e}`)
          )
        : undefined,
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
      const mgr = createTwitchEventSubManager({
        getEmitter: () => emitter,
        config: twitch.eventsub,
        stateDir,
        onFollow: giveawayEngine
          ? (f) => giveawayEngine.onFollow(f)
          : undefined,
      });
      getChannelAuth = mgr.getChannelAuth;
      mgr.start();
    }
  }

  if (giveawayEngine && giveawayCfg) warnGiveawaySetup(giveawayCfg, twitch);

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
    "  multichat giveaway [verb] [opts]           control the giveaway (status|open|close|draw|reset|demo|winners|campaign-reset|remove <userId>)",
    "",
    "Options (set-youtube-key, fake, and giveaway share these):",
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
    "",
    "giveaway: control the running !enter giveaway (Twitch-only) from the terminal —",
    "an alternative to the /giveaway page (a CS2-style case reel). Loopback-only, like fake.",
    "  multichat giveaway status   # entrant/queue/pool counts, follower progress, credits",
    "  multichat giveaway open     # start accepting entries",
    "  multichat giveaway close    # stop accepting entries",
    "  multichat giveaway draw     # pick + remove a winner (announced in chat if replies are on)",
    "  multichat giveaway reset    # clear the entrant pool (keeps campaign + winners)",
    "  multichat giveaway demo     # add sample entrants (+ follower progress) to preview the reel",
    "  multichat giveaway winners [--csv]   # the recorded winners / mailing list",
    "  multichat giveaway campaign-reset --yes   # zero campaign + numbers; archives the winners log",
    "  multichat giveaway remove <userId>   # drop one entrant",
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

/**
 * CLI client: drive the giveaway on a running server via its loopback
 * /api/giveaway endpoint. Useful for drawing a winner from the terminal or in a
 * script, without the /giveaway page. See docs/development/testing.md.
 */
async function runGiveaway(args: string[]): Promise<void> {
  let host = Deno.env.get("HOST") ?? "127.0.0.1";
  let port = Number(Deno.env.get("PORT") ?? "8080");
  let action = "";
  let userId = "";
  let csv = false;
  let yes = false;

  const VERBS = [
    "status",
    "open",
    "close",
    "draw",
    "reset",
    "demo",
    "winners",
    "campaign-reset",
    "remove",
  ];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help") {
      console.log(cliUsage());
      Deno.exit(0);
    } else if (a === "-p" || a === "--port") {
      port = Number(args[++i]);
    } else if (a === "-h" || a === "--host") {
      host = args[++i] ?? host;
    } else if (a === "--csv") {
      csv = true;
    } else if (a === "--yes") {
      yes = true;
    } else if (VERBS.includes(a)) {
      action = a;
    } else if (action === "remove" && !userId) {
      userId = a; // the userId positional after `remove`
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(`Usage: multichat giveaway [${VERBS.join("|")}] [userId]`);
      Deno.exit(2);
    }
  }
  if (!action) action = "status";
  if (!Number.isFinite(port) || port <= 0) {
    console.error("Invalid --port.");
    Deno.exit(2);
  }
  if (action === "remove" && !userId) {
    console.error("giveaway remove needs a userId (see `giveaway status`).");
    Deno.exit(2);
  }
  if (action === "campaign-reset" && !yes) {
    console.error(
      "campaign-reset zeroes follower progress + entry numbers and archives " +
        "the winners log. Re-run with --yes to confirm.",
    );
    Deno.exit(2);
  }

  const wire: GiveawayAction = action === "remove"
    ? { action: "remove", userId }
    : { action } as GiveawayAction;
  const { res, text } = await postControl(
    host,
    port,
    "/api/giveaway",
    serializeGiveawayAction(wire),
    "application/json",
  );
  if (!res.ok) {
    console.error(`Failed (HTTP ${res.status}): ${text}`);
    Deno.exit(1);
  }
  try {
    const data = JSON.parse(text) as {
      state?: GiveawayState;
      winner?: GiveawayWinner | null;
      segment?: string;
      winners?: GiveawayWinner[];
    };
    if (action === "winners") {
      const list = data.winners ?? [];
      if (csv) {
        // Raw CSV on stdout so it can be piped straight to a file.
        console.log(winnersToCsv(list).trimEnd());
      } else if (list.length === 0) {
        console.log("No winners recorded yet.");
      } else {
        for (const w of list) {
          const entered = w.enteredAt
            ? new Date(w.enteredAt).toISOString()
            : "?";
          const won = w.wonAt ? new Date(w.wonAt).toISOString() : "?";
          console.log(
            `#${w.number}  ${w.displayName} (${w.login || w.userId})  ` +
              `[${w.tier}]  entered ${entered}  won ${won}`,
          );
        }
        console.log(`${list.length} winner(s).`);
      }
      Deno.exit(0);
    }
    if (data.winner) {
      const w = data.winner;
      console.log(
        `Winner: #${w.number} ${w.displayName || w.login || w.userId}` +
          (data.segment ? ` (${data.segment})` : ""),
      );
    } else if (action === "draw") {
      console.log("No entrants to draw from.");
    }
    if (data.state) {
      const s = data.state;
      console.log(
        `Pool: ${s.entrants.length} entrant(s), entries ${
          s.open ? "OPEN" : "CLOSED"
        }.`,
      );
      const c = s.campaign;
      if (c && (c.guaranteedRemaining > 0 || c.followerCount > 0 ||
            c.winnersTotal > 0 || c.poolSize !== s.entrants.length)) {
        console.log(
          `Campaign: ${c.guaranteedRemaining} guaranteed in queue · ` +
            `${c.poolSize} in bonus pool · ${c.winnersTotal} winner(s) recorded.`,
        );
        if (c.followTracking) {
          console.log(
            `Followers: ${c.followerCount} new · milestone ${c.milestonesReached} ` +
              `· ${c.creditsRemaining} draw credit(s) armed.`,
          );
        }
      }
    }
  } catch {
    console.log(text);
  }
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
    LOGIN_SCOPES,
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
} else if (first === "giveaway") {
  await runGiveaway(rest);
} else if (first === "--help" || first === "-h") {
  console.log(cliUsage());
} else {
  await runServer(first ?? "settings.json");
}

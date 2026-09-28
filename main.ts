import type {
  ChannelPointsConfig,
  Emitter,
  GiveawayCampaignState,
  GiveawayConfig,
  GiveawayDisposition,
  GiveawayDraw,
  GiveawayEntrant,
  GiveawayMessages,
  GiveawayPlan,
  GiveawayState,
  GiveawayTurn,
  GiveawayWinner,
  IntegrationsConfig,
  PackReport,
  RedemptionEntry,
  RedemptionOutcome,
  Settings,
  TurnAggregates,
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
  type RedemptionEvent,
  type RedemptionHandler,
  startTwitchEventSub,
} from "./src/eventsub.ts";
import {
  buildAuthCodeRequest,
  buildAuthorizeUrl,
  buildCheckFollowRequest,
  buildCreateCustomRewardRequest,
  buildGetCustomRewardsRequest,
  buildGetRedemptionsRequest,
  buildRefreshRequest,
  buildSendChatMessageRequest,
  buildUpdateCustomRewardRequest,
  buildUpdateRedemptionStatusRequest,
  buildUsersRequest,
  CHAT_WRITE_SCOPE,
  type HelixResult,
  type HttpRequest,
  LOGIN_SCOPES,
  parseCustomRewardsResponse,
  parseFollowersResponse,
  parseHelixResponse,
  parseRedemptionsResponse,
  parseTokenResponse,
  parseUsersResponse,
  REDEMPTIONS_MANAGE_SCOPE,
  type SubscriptionFeature,
} from "./src/twitchauth.ts";
import {
  admitRedemption,
  applyChannelPointsEnv,
  buildEffectCancelRequest,
  buildEffectEnqueueRequest,
  buildEffectsHealthRequest,
  buildEffectsLookupRequest,
  cancelAcknowledged,
  type ChannelPointsControl,
  channelPointsScopeWarning,
  channelPointsSetupProblems,
  type ChannelPointsStatus,
  dueCancels,
  dueSyncBatches,
  effectOutcome,
  emptyManagedRewards,
  healthGood,
  initialAutoPauseGate,
  interpretEnqueueResponse,
  judgeSyncBatch,
  ledgerCounts,
  type ManagedRewards,
  markAttempt,
  markCancelDone,
  markCancelFailed,
  markQueued,
  markSynced,
  markSyncFailed,
  MAX_LOOKUP_IDS,
  normalizeChannelPointsConfig,
  normalizeChannelPointsControl,
  normalizeLedger,
  normalizeManagedRewards,
  openEntries,
  overlayCancelReason,
  type OverlayRequest,
  oweCancel,
  parseEffectsHealth,
  parseEffectsLookup,
  planRewardSync,
  pruneLedger,
  queuedTimedOut,
  redemptionChatMessage,
  type RedemptionInput,
  requeueEntry,
  resolveEntry,
  rewardFields,
  rewardKeyById,
  type RewardsAction,
  type RewardsPauseResult,
  type RewardsResult,
  rewardStatusRows,
  type RewardSyncReport,
  serializeLedger,
  serializeRewardsAction,
  simulatedRedemption,
  stepAutoPause,
  type SyncBatch,
  TIER_COLORS,
} from "./src/channelpoints.ts";
import {
  channelPointsControlPath,
  type ChannelPointsHooks,
  channelPointsLedgerPath,
  channelPointsRewardsPath,
  giveawayCampaignStatePath,
  type GiveawayHooks,
  giveawayPacksStatePath,
  giveawayPlanStatePath,
  giveawayPoolStatePath,
  giveawayTurnsStatePath,
  giveawayWinnersLogPath,
  isStaleStateTmp,
  keyStatePath,
  type KeyUpdateResult,
  normalizeControlAccess,
  quarantinePath,
  resolveStartupKey,
  resolveStateDir,
  stateTmpPath,
  twitchBroadcasterStatePath,
  twitchTokenStatePath,
} from "./src/control.ts";
import {
  activeTurn,
  buildTurnReport,
  computeAggregates,
  matchDisposition,
  newTurn,
  normalizeTurns,
  recordTurnDisposition,
  type ReportRow,
  reportToCsv,
  serializeTurns,
  turnTotals,
} from "./src/turns.ts";
import {
  applyIntegrationEnv,
  buildIntegrationRequests,
  type IntegrationEvent,
  normalizeIntegrationsConfig,
  normalizePackReports,
  type OutboundRequest,
  serializePackReports,
  subscriberWantsEvent,
} from "./src/integrations.ts";
import {
  demoActions,
  type FakeAction,
  fakeActionForKind,
  MESSAGE_KINDS,
  serializeFakeAction,
} from "./src/fake.ts";
import {
  addEntrant,
  buildDrawPlan,
  campaignSummary,
  closePool,
  consumePlan,
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
  nextPlannedUserId,
  normalizeCampaignState,
  normalizeGiveawayConfig,
  normalizePlan,
  normalizePoolState,
  openPool,
  parseWinnersLog,
  recordFollower,
  removeByNeedle,
  resetPool,
  serializeGiveawayAction,
  serializePlan,
  serializeWinnerLine,
  winnersToCsv,
  winnerTier,
} from "./src/giveaway.ts";

/** Read an env var without ever throwing. Deno's `--allow-env` is an allow-list
 *  (see the wrapper in build.nix), and reading a name outside it raises
 *  NotCapable. The integration token names are dynamic — one per subscriber — so
 *  a wrapper built before those names existed must degrade to "no override"
 *  rather than take the server down at startup. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

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
      // Who may press Draw. Env overrides exist so the NixOS unit can carry the
      // token via LoadCredential instead of the Nix-store settings.json.
      controlAccess: normalizeControlAccess(
        readEnv("MULTICHAT_CONTROL_ACCESS") ?? raw.server?.controlAccess,
      ),
      controlToken: (readEnv("MULTICHAT_CONTROL_TOKEN") ??
        raw.server?.controlToken ?? "").trim(),
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
    // Tokens may arrive from the environment instead of the file, so a
    // Nix-store settings.json carries no secrets; see src/integrations.ts.
    integrations: applyIntegrationEnv(
      normalizeIntegrationsConfig(raw.integrations),
      readEnv,
    ),
    // The overlay token may come from MULTICHAT_EFFECTS_TOKEN (a LoadCredential
    // file under NixOS) instead of the file. Dropped/adjusted catalogue entries
    // are logged so a bad line is visible rather than silently missing.
    channelPoints: applyChannelPointsEnv(
      normalizeChannelPointsConfig(
        raw.channelPoints,
        (m) => console.error(`[ChannelPoints] ${m}`),
      ),
      readEnv,
    ),
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

/**
 * Make sure the resolved state directory exists and is ours (0700), returning it
 * — or null when it can't be created, in which case every persist below degrades
 * to in-memory, exactly as it did before a state dir was resolved outside
 * systemd. Never fatal: losing persistence must not cost you the stream.
 */
async function ensureStateDir(dir: string | null): Promise<string | null> {
  if (!dir) return null;
  try {
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch (e) {
    console.error(
      `[Control] Cannot use state directory ${dir} (${e}) — the giveaway pool, ` +
        `winners log and turn ledger will not survive a restart.`,
    );
    return null;
  }
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

let atomicWriteSeq = 0;

/**
 * Crash-safe variant of persistState for state that must never come back torn
 * (the channel-points ledger holds the only record of viewers' points in
 * flight): write a uniquely named temp file beside `path`, fsync it, then
 * rename it over `path` — a reader, or the next boot after a SIGKILL or power
 * loss mid-write, sees the old file or the new one, never half of one. Never
 * throws; a failure is logged and the temp file removed.
 */
async function persistStateAtomic(path: string, value: string): Promise<void> {
  const tmp = stateTmpPath(
    path,
    `${Deno.pid}-${++atomicWriteSeq}-${crypto.randomUUID().slice(0, 8)}`,
  );
  try {
    const f = await Deno.open(tmp, {
      write: true,
      create: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      const bytes = new TextEncoder().encode(value);
      let off = 0;
      while (off < bytes.length) off += await f.write(bytes.subarray(off));
      await f.syncData();
    } finally {
      f.close();
    }
    await Deno.rename(tmp, path);
  } catch (e) {
    console.error(`[Control] Could not persist ${path}: ${e}`);
    await Deno.remove(tmp).catch(() => {});
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

/** What the channel-points engine hangs off its channel's EventSub socket: the
 *  redemption observer, a one-shot "this channel's token is usable" callback
 *  (with the scopes the token carries, null when unknown), and a per-session
 *  "subscriptions are live" callback that drives the reconcile pass. */
interface ChannelPointsWiring {
  channel: string;
  onRedemption: RedemptionHandler;
  onAuthReady: (auth: ChannelAuth, scopes: readonly string[] | null) => void;
  onSessionReady: () => void;
}

/** Back-off between attempts to get a channel's first token / broadcaster id
 *  (the last step repeats). */
const CHANNEL_START_RETRY_MS = [
  5_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
];

function createTwitchEventSubManager(opts: {
  getEmitter: () => Emitter;
  config: TwitchEventSubConfig;
  stateDir: string | null;
  /** Optional follow observer, forwarded to every channel's EventSub socket
   *  (the giveaway milestone counter). */
  onFollow?: FollowHandler;
  /** Optional channel-points engine: only its channel subscribes to the
   *  redemption events (others would 403 on every reconnect without the scope). */
  channelPoints?: ChannelPointsWiring;
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
    // The scopes the current token carries, per the last refresh response
    // (null until one reports them) — how a pre-redemptions token is caught.
    let grantedScopes: string[] | null = null;

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
          // Bounded: a hung refresh would wedge the single-flight `inflight`
          // (and every Helix call behind it) for good.
          signal: AbortSignal.timeout(15_000),
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
      if (parsed.scopes) grantedScopes = parsed.scopes;
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

    // Only a configuration problem skips a channel outright; nothing at runtime
    // can supply a refresh token or a login.
    if (!refreshToken) {
      console.error(
        `[EventSub] ${label}: no refresh token — run: multichat twitch-login ` +
          `(skipping this channel)`,
      );
      return;
    }
    if (!broadcasterId && !login) {
      console.error(
        "[EventSub] a channel needs a login or broadcasterId — skipping",
      );
      return;
    }

    const cp = opts.channelPoints && login &&
        login === opts.channelPoints.channel
      ? opts.channelPoints
      : undefined;

    // The token and the broadcaster id are retried with back-off rather than
    // given up on: a network blip or an id.twitch.tv hiccup at boot used to
    // strand the channel until a restart — and for the channel-points channel
    // that means rewards left live on Twitch with nothing syncing, pausing,
    // fulfilling or refunding them.
    for (let attempt = 0;; attempt++) {
      const token = await getToken();
      if (token && !broadcasterId) {
        const req = buildUsersRequest(login, clientId, token);
        try {
          const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            signal: AbortSignal.timeout(15_000),
          });
          broadcasterId = parseUsersResponse(await res.json())?.id ?? "";
        } catch (e) {
          console.error(`[EventSub] ${label}: broadcaster lookup failed: ${e}`);
        }
        if (broadcasterId) {
          // Cache the id and (re)point the token file at it, persisting the
          // current token.
          if (bidCachePath) await persistState(bidCachePath, broadcasterId);
          tokenPath = twitchTokenStatePath(opts.stateDir, broadcasterId);
          if (tokenPath) await persistState(tokenPath, refreshToken);
        }
      }
      if (token && broadcasterId) break;
      const delay = CHANNEL_START_RETRY_MS[
        Math.min(attempt, CHANNEL_START_RETRY_MS.length - 1)
      ];
      console.error(
        `[EventSub] ${label}: ${
          token ? "could not resolve broadcaster id" : "no usable token"
        } — retrying in ${delay / 1000}s${
          cp
            ? " (channel points are stalled until then: no reward sync, " +
              "auto-pause, fulfil or refund)"
            : ""
        }`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    // Now that the broadcaster id + token are usable, publish this channel's auth
    // so the giveaway engine can call Helix with the broadcaster's authority.
    const auth: ChannelAuth = { broadcasterId, getToken };
    if (login) channelAuth.set(login, auth);
    channelAuth.set(broadcasterId, auth);

    // The channel-points channel gets the redemption subscriptions + observers.
    // Its token must carry channel:manage:redemptions; a token minted before
    // that scope was requested is the classic re-login trap (the persisted
    // rotated token beats any new seed), so say exactly what to do, loudly.
    const features: SubscriptionFeature[] = cp ? ["channelPoints"] : [];
    if (cp) {
      const warning = channelPointsScopeWarning(
        login,
        grantedScopes,
        tokenPath,
      );
      if (warning) console.error(warning);
      cp.onAuthReady(auth, grantedScopes);
    }

    const ctx: EventSubChannelContext = {
      clientId,
      broadcasterId,
      channelLabel: login || broadcasterId,
      emitter: opts.getEmitter(),
      getToken,
      onFollow: opts.onFollow,
      features,
      onRedemption: cp?.onRedemption,
      onSessionReady: cp?.onSessionReady,
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
 * The outbound integration bus. Pushes giveaway-lifecycle events to each
 * configured subscriber (e.g. the chat-cards adapter, which opens a pack for the
 * drawn winner). Delivery is fire-and-forget with a single retry: a subscriber
 * being down must never block or roll back a draw — it's logged, and
 * /api/turn-report reconciles values when the tool comes back. Pure event→request
 * mapping lives in integrations.ts; this is the wiring.
 */
function createIntegrationDispatcher(config: IntegrationsConfig): {
  emit: (ev: IntegrationEvent) => void;
} {
  const subs = config.subscribers.filter((s) => s.enabled);
  if (subs.length > 0) {
    console.log(
      `[Integration] ${subs.length} subscriber(s): ${
        subs.map((s) => `${s.name} (${s.adapter})`).join(", ")
      }`,
    );
  }

  async function fire(
    name: string,
    req: OutboundRequest,
    retry: boolean,
  ): Promise<void> {
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error(
          `[Integration:${name}] ${req.method} ${req.url} → HTTP ${res.status} ${
            t.slice(0, 200)
          }`,
        );
      } else {
        await res.body?.cancel();
      }
    } catch (e) {
      if (retry) {
        // One retry after a short delay — a transient blip shouldn't drop the
        // delivery, but it must never block the draw that triggered it.
        setTimeout(() => void fire(name, req, false), 500);
        return;
      }
      console.error(`[Integration:${name}] ${req.url} failed: ${e}`);
    }
  }

  function emit(ev: IntegrationEvent): void {
    for (const sub of subs) {
      if (!subscriberWantsEvent(sub, ev.type)) continue;
      for (const req of buildIntegrationRequests(sub, ev)) {
        void fire(sub.name, req, true);
      }
    }
  }

  return { emit };
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
  /** Push a giveaway-lifecycle event to the integration bus (chat-cards etc.).
   *  No-op when integrations aren't configured. */
  emitIntegration?: (ev: IntegrationEvent) => void;
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
  const packsPath = giveawayPacksStatePath(opts.stateDir);
  const turnsPath = giveawayTurnsStatePath(opts.stateDir);
  const planPath = giveawayPlanStatePath(opts.stateDir);
  let state: GiveawayState = emptyPool(true);
  let campaign: GiveawayCampaignState = emptyCampaign();
  let winners: GiveawayWinner[] = [];
  // Pack reports pushed back by chat-cards, keyed by packId (last write wins).
  let packReports: Record<string, PackReport> = {};
  // The turn ledger (draw → disposition).
  let turns: GiveawayTurn[] = [];
  // The committed seeded draw plan (operator-only; consumed as draws happen).
  let plan: GiveawayPlan | null = null;

  /** The broadcast/return view: state with the derived campaign snapshot
   *  attached (counts + recent winners), plus the active turn and disposition
   *  aggregates — all derived, none persisted (see persist()). */
  function view(): GiveawayState {
    state.campaign = campaignSummary(
      state,
      campaign,
      config,
      winners,
      opts.followTracking,
    );
    const active = activeTurn(turns);
    if (active) state.activeTurn = active;
    else delete state.activeTurn;
    state.aggregates = computeAggregates(turns, packReports);
    return state;
  }

  // `draw` rides along only on a draw, so every connected page (incl. the OBS
  // overlay) plays the case-opening reel over the pre-removal entrant list.
  function broadcast(draw?: GiveawayDraw): void {
    opts.getBroadcast()?.(view(), draw);
  }
  function persist(): void {
    // Derived fields (campaign snapshot, active turn, aggregates) are not
    // persisted — they're rebuilt in view() from the pool/turns/packs.
    if (poolPath) {
      const { campaign: _c, activeTurn: _a, aggregates: _g, ...bare } = state;
      void persistState(poolPath, JSON.stringify(bare));
    }
  }
  function persistCampaign(): void {
    if (campaignPath) void persistState(campaignPath, JSON.stringify(campaign));
  }
  function persistPacks(): void {
    if (packsPath) {
      void persistState(packsPath, serializePackReports(packReports));
    }
  }
  function persistTurns(): void {
    if (turnsPath) void persistState(turnsPath, serializeTurns(turns));
  }
  function persistPlan(): void {
    if (planPath) void persistState(planPath, serializePlan(plan));
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
    if (packsPath) {
      const raw = await readKeyFile(packsPath);
      if (raw) {
        try {
          packReports = normalizePackReports(JSON.parse(raw));
        } catch { /* corrupt — start empty */ }
      }
    }
    if (turnsPath) {
      const raw = await readKeyFile(turnsPath);
      if (raw) {
        try {
          turns = normalizeTurns(JSON.parse(raw));
        } catch { /* corrupt — start empty */ }
      }
    }
    if (planPath) {
      const raw = await readKeyFile(planPath);
      if (raw) {
        try {
          plan = normalizePlan(JSON.parse(raw));
        } catch { /* corrupt — no plan */ }
      }
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
    if (!m.userId) return; // no stable id — can't dedupe/verify

    // Terms command (e.g. "!terms") — replies with a link to the published T&C.
    // Purely informational; it does not gate entry. Checked before the enter
    // command so the terms word can't also be read as an entry.
    if (
      config.terms &&
      matchGiveawayCommand(m.text, config.prefix, config.terms.command)
    ) {
      await handleTerms(m);
      return;
    }

    // Winner-turn disposition (mail/donate/destroy/pass). Gated to the current
    // winner inside handleDisposition — a non-winner saying the word is a no-op.
    if (config.disposition) {
      const disp = matchDisposition(m.text, config.prefix, config.disposition);
      if (disp) {
        await handleDisposition(m, disp);
        return;
      }
    }

    if (!matchGiveawayCommand(m.text, config.prefix, config.command)) return;
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
        remaining: config.firstN > 0 ? Math.max(0, config.firstN - number) : 0,
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

  /** Draw the next winner (guaranteed queue first, then the pool), record the
   *  win, open a turn, and tell the integration bus to open a pack. Shared by the
   *  operator `draw` hook and the `pass` disposition (which auto-advances,
   *  carrying the passed cards into the new turn via `carriedFromTurnId`). */
  function performDraw(
    carriedFromTurnId?: string,
  ): {
    state: GiveawayState;
    winner: GiveawayEntrant | null;
    segment: "guaranteed" | "pool";
  } {
    // A committed plan forces who's next (still looks like a random spin);
    // otherwise it's a random draw. Guaranteed queue first, then the pool.
    const forced = nextPlannedUserId(plan, state);
    const r = drawSegmented(state, config.firstN, Math.random, forced);
    state = r.state;
    if (r.winner) {
      if (plan) {
        // Consume the drawn winner from the plan (in draw order).
        plan = consumePlan(plan, r.winner.userId);
        persistPlan();
      }
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
      // Append the mailing-list record BEFORE the pool persist: a crash here can
      // only leave the winner still in the pool (operator-visible), never an
      // un-recorded winner.
      winners.push(w);
      if (winnersPath) void appendState(winnersPath, serializeWinnerLine(w));
      // Open the turn. Its id is the correlation `ref` chat-cards echoes back on
      // the pack report, so a pull can be tied to the exact turn.
      const turnId = crypto.randomUUID();
      turns = [
        ...turns,
        newTurn({
          id: turnId,
          winner: r.winner,
          tier,
          now: Date.now(),
          carriedFromTurnId,
        }),
      ];
      persistTurns();
      opts.emitIntegration?.({
        type: "giveaway.turn.start",
        ts: Date.now(),
        data: {
          winner: r.winner.displayName,
          ref: turnId,
          userId: r.winner.userId,
          login: r.winner.login,
          number: r.winner.number,
          segment: r.segment,
          tier,
          ...(carriedFromTurnId ? { carriedFromTurnId } : {}),
        },
      });
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
  }

  /** Reply to the terms command (e.g. `!terms`) with a link to the published
   *  T&C. Nothing is recorded — the campaign no longer gates entry on the terms. */
  async function handleTerms(m: TwitchChatMessage): Promise<void> {
    if (!config.terms) return;
    await reply("terms", m.displayName, {
      terms: config.terms.url || "see the panel",
      enter: `${config.prefix}${config.command}`,
    });
  }

  /** Apply a winner-only disposition (mail/donate/destroy/pass). No-op unless
   *  it's the current winner's turn and they haven't already decided. `pass`
   *  carries the pull to the next person and auto-advances the draw. */
  async function handleDisposition(
    m: TwitchChatMessage,
    disposition: GiveawayDisposition,
  ): Promise<void> {
    const active = activeTurn(turns);
    if (!active || active.userId !== m.userId || active.disposition) return;
    const res = recordTurnDisposition(
      turns,
      active.id,
      disposition,
      Date.now(),
    );
    turns = res.turns;
    persistTurns();
    const tally = turnTotals(active.id, turns, packReports);
    opts.emitIntegration?.({
      type: "giveaway.turn.disposition",
      ts: Date.now(),
      data: {
        ref: active.id,
        userId: active.userId,
        disposition,
        cards: tally.cards,
        value: tally.value,
      },
    });
    if (disposition === "pass") {
      // The forfeited cards carry into the next person's turn, and the draw
      // advances so the next winner also opens a fresh pack.
      const next = performDraw(active.id);
      await reply("passed", m.displayName, {
        next: next.winner?.displayName ?? "the next winner",
        cards: tally.cards,
        value: tally.value.toFixed(2),
      });
    } else {
      broadcast(); // turn ended → clear activeTurn, refresh aggregates
      const key = disposition === "mail"
        ? "mailed"
        : disposition === "donate"
        ? "donated"
        : "destroyed";
      await reply(key, m.displayName, {
        cards: tally.cards,
        value: tally.value.toFixed(2),
      });
    }
    opts.emitIntegration?.({
      type: "giveaway.turn.end",
      ts: Date.now(),
      data: { ref: active.id, userId: active.userId, disposition },
    });
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
      // The committed plan referenced the now-cleared entrants — drop it.
      plan = null;
      persistPlan();
      persist();
      broadcast();
      return view();
    },
    remove: (target) => {
      const r = removeByNeedle(state, target);
      // A miss or an ambiguous needle changes nothing — don't persist or
      // broadcast a no-op, and let the caller say so.
      if (!r.removed) {
        return { state: view(), removed: null, matches: r.matches };
      }
      state = r.state;
      // The committed plan may name the entrant we just dropped; consuming them
      // keeps the plan and the pool from disagreeing on who is next.
      plan = consumePlan(plan, r.removed.userId);
      persistPlan();
      persist();
      broadcast();
      return { state: view(), removed: r.removed, matches: r.matches };
    },
    draw: () => performDraw(),
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
      // The turn ledger + pack reports + plan are per-campaign, so clear them.
      turns = [];
      packReports = {};
      plan = null;
      persistTurns();
      persistPacks();
      persistPlan();
      persistCampaign();
      persist();
      broadcast();
      return view();
    },
    turnReport: (report) => {
      // Upsert by packId: chat-cards re-reports the same pack as cards are priced,
      // so the latest report is the authoritative one.
      packReports[report.packId] = report;
      persistPacks();
      return report;
    },
    packs: () =>
      Object.values(packReports).sort((a, b) => b.openedAt - a.openedAt),
    turns: () => ({
      turns: turns.slice(),
      aggregates: computeAggregates(turns, packReports),
    }),
    report: () => ({
      rows: buildTurnReport(turns, packReports, config.timezone),
      aggregates: computeAggregates(turns, packReports),
      timezone: config.timezone,
    }),
    plan: (count, reseed) => {
      if (count > 0) {
        // Reuse the stored seed unless reseeding, so re-running `plan` (e.g. to
        // extend the count) keeps the same order; reseed shuffles afresh.
        const seed = reseed || !plan ? Date.now() >>> 0 : plan.seed;
        plan = {
          seed,
          createdAt: Date.now(),
          order: buildDrawPlan(state.entrants, config.firstN, seed, count),
        };
        persistPlan();
      }
      return plan; // count 0 → return the current plan without rebuilding
    },
    planClear: () => {
      plan = null;
      persistPlan();
      return plan;
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

// Channel-points engine cadence. The pump moves redemptions along (overlay
// delivery, result polling, Twitch fulfil/refund); health drives auto-pause;
// reconcile recovers redemptions EventSub dropped (it never replays them).
const CP_PUMP_MS = 2_000;
const CP_HEALTH_MS = 15_000;
const CP_RECONCILE_MS = 5 * 60_000;
// Every outbound call is bounded: the loops are single-flight, so one hung
// request would otherwise stall the whole pipeline.
const CP_OVERLAY_TIMEOUT_MS = 5_000;
const CP_HELIX_TIMEOUT_MS = 10_000;
// Pages of 50 UNFULFILLED redemptions read per reward per reconcile.
const CP_RECONCILE_PAGES = 20;

/**
 * The channel-points engine. Twitch EventSub redemptions of the rewards this app
 * created land in a persisted ledger (deduped by redemption id), a pump hands
 * each to the cobblemon-overlay's effect queue (POST /effects, loopback), polls
 * the results, and turns them into a Twitch fulfil (applied/armed) or refund
 * (anything else, including never getting delivered before the deadline) — so a
 * viewer's points are never silently eaten. It also provisions the rewards
 * (sync), recovers redemptions EventSub missed (reconcile), and pauses the
 * rewards on Twitch while the game isn't taking effects (auto-pause; a manual
 * pause wins). Pure logic lives in src/channelpoints.ts; this is the wiring.
 */
function createChannelPointsEngine(opts: {
  config: ChannelPointsConfig;
  clientId: string;
  stateDir: string | null;
  getEmitter: () => Emitter;
  getChannelAuth: (login: string) => ChannelAuth | undefined;
  /** The channel has an EventSub connection configured, so its token is
   *  expected to arrive (otherwise only `rewards simulate` works). */
  expectAuth: boolean;
}): {
  wiring: ChannelPointsWiring;
  hooks: ChannelPointsHooks;
  init: () => Promise<void>;
  start: () => void;
  /** Write every state file's latest contents to disk (graceful shutdown). */
  flush: () => Promise<void>;
} {
  const { config } = opts;
  const ledgerPath = channelPointsLedgerPath(opts.stateDir);
  const rewardsPath = channelPointsRewardsPath(opts.stateDir);
  const controlPath = channelPointsControlPath(opts.stateDir);
  const specByKey = new Map(config.rewards.map((r) => [r.key, r]));

  let ledger: RedemptionEntry[] = [];
  let managed: ManagedRewards = emptyManagedRewards();
  let control: ChannelPointsControl = { manualPause: false };
  // Runtime-only observations (not persisted).
  let scopes: readonly string[] | null = null;
  let authSeen = false;
  const startedAt = Date.now();
  let accepting: boolean | null = null;
  let ready: boolean | null = null;
  let healthOk: boolean | null = null;
  // Auto-pause hysteresis (contract §5.3): paused until the first good health
  // check, then only after AUTO_PAUSE_BAD_CHECKS bad ones in a row.
  let autoGate = initialAutoPauseGate();
  let lastHealthAt: number | null = null;
  let twitchPaused: boolean | null = null;
  let overlayUp: boolean | null = null;
  let lastSyncAt: number | null = null;
  let lastSyncError: string | null = null;
  let syncing: Promise<RewardSyncReport> | null = null;
  let reconciling: Promise<void> | null = null;
  // Reward sync and pause application both PATCH the managed rewards and both
  // read or write `managed` / `twitchPaused`, so they run strictly one at a
  // time on this chain: a pause run can't act on a reward map a sync is about
  // to replace, nor record a pause state over a sync's "new rewards are born
  // unpaused" reset.
  let rewardsChain: Promise<unknown> = Promise.resolve();
  let pumping = false;
  let pumpAgain = false;

  // One writer per file: a change that lands while a write is in flight is
  // coalesced into one follow-up write of the latest state, so two quick
  // changes can neither interleave on disk nor lose the second one. Each
  // write is atomic (temp file + fsync + rename): a crash, kill or power loss
  // mid-write leaves the previous state, never a torn file.
  function writer(
    path: string | null,
    snapshot: () => string,
  ): { (): void; flush: () => Promise<void> } {
    let running: Promise<void> | null = null;
    let again = false;
    const schedule = () => {
      if (!path) return;
      if (running) {
        again = true;
        return;
      }
      running = (async () => {
        do {
          again = false;
          await persistStateAtomic(path, snapshot());
        } while (again);
      })().finally(() => {
        running = null;
      });
    };
    return Object.assign(schedule, {
      // Write the latest state now, or right after the write in flight.
      flush: async () => {
        schedule();
        if (running) await running;
      },
    });
  }
  const persistLedger = writer(ledgerPath, () => serializeLedger(ledger));
  const persistRewards = writer(rewardsPath, () => JSON.stringify(managed));
  const persistControl = writer(controlPath, () => JSON.stringify(control));

  /**
   * Read one state file back: "missing" on a first run; "corrupt" for anything
   * that isn't the expected JSON shape (a torn or empty file from a crash, a
   * hand edit gone wrong) — that file is moved aside, kept for inspection
   * instead of being overwritten by the next write, and reported loudly, so
   * the caller falls back on purpose rather than silently starting empty.
   */
  async function readState(
    path: string,
    what: string,
    shapeOk: (v: unknown) => boolean,
  ): Promise<
    { kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "corrupt" }
  > {
    let raw: string;
    try {
      raw = await Deno.readTextFile(path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return { kind: "missing" };
      console.error(
        `[ChannelPoints] !!! could not read the ${what} (${path}): ${e}`,
      );
      return { kind: "corrupt" };
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (shapeOk(value)) return { kind: "ok", value };
    } catch { /* torn or empty */ }
    const aside = quarantinePath(path, Date.now());
    const moved = await Deno.rename(path, aside).then(() => true, () => false);
    console.error(
      `[ChannelPoints] !!! the ${what} (${path}) is corrupt${
        moved ? ` — moved aside to ${aside}` : " and could not be moved aside"
      }.`,
    );
    return { kind: "corrupt" };
  }

  /** Remove temp files an interrupted atomic write left in the state dir. */
  async function sweepStaleTmp(): Promise<void> {
    const dir = opts.stateDir;
    const bases = [ledgerPath, rewardsPath, controlPath]
      .filter((p): p is string => !!p)
      .map((p) => p.slice(p.lastIndexOf("/") + 1));
    if (!dir || bases.length === 0) return;
    try {
      for await (const ent of Deno.readDir(dir)) {
        if (ent.isFile && bases.some((b) => isStaleStateTmp(ent.name, b))) {
          await Deno.remove(`${dir}/${ent.name}`).catch(() => {});
        }
      }
    } catch { /* best-effort */ }
  }

  /** Restore the ledger, reward map and manual pause. A corrupt file is moved
   *  aside and reported with what starting without it means. */
  async function init(): Promise<void> {
    await sweepStaleTmp();
    const isObject = (v: unknown) =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    if (ledgerPath) {
      const r = await readState(ledgerPath, "redemption ledger", Array.isArray);
      if (r.kind === "ok") {
        ledger = pruneLedger(normalizeLedger(r.value), Date.now());
      } else if (r.kind === "corrupt") {
        console.error(
          "[ChannelPoints] !!! starting with an EMPTY redemption ledger. The " +
            "reconcile pass re-admits redemptions still UNFULFILLED on Twitch " +
            "(those past their deadline are refunded as stale — including any " +
            "whose effect already ran but wasn't marked FULFILLED yet); " +
            "in-flight simulations are forgotten.",
        );
      }
    }
    if (rewardsPath) {
      const r = await readState(rewardsPath, "reward id map", isObject);
      if (r.kind === "ok") managed = normalizeManagedRewards(r.value);
      else if (r.kind === "corrupt") {
        console.error(
          "[ChannelPoints] !!! starting without the reward id map: the next " +
            "reward sync re-adopts the rewards by title; until it runs, " +
            "redemptions of them are not recognised (reconcile picks them up " +
            "after the sync).",
        );
      }
    }
    if (controlPath) {
      const r = await readState(controlPath, "pause control", isObject);
      if (r.kind === "ok") control = normalizeChannelPointsControl(r.value);
      else if (r.kind === "corrupt") {
        // Fail safe: the operator may have paused the rewards on purpose.
        control = { manualPause: true };
        persistControl();
        console.error(
          "[ChannelPoints] !!! the manual-pause state was lost, so the rewards " +
            "are treated as MANUALLY PAUSED — run `multichat rewards resume` " +
            "to release them.",
        );
      }
    }
  }

  /** Graceful shutdown: every state file's latest contents on disk. */
  async function flush(): Promise<void> {
    await Promise.all([
      persistLedger.flush(),
      persistRewards.flush(),
      persistControl.flush(),
    ]);
  }

  // Helix as the broadcaster, with one forced-refresh retry on 401 (the same
  // pattern as the giveaway's follow check). Never throws: a missing token or a
  // network failure comes back as a failed HelixResult (status 0).
  async function helix(
    build: (auth: ChannelAuth, token: string) => HttpRequest,
    retried = false,
  ): Promise<HelixResult> {
    const auth = opts.getChannelAuth(config.channel);
    if (!auth) {
      return parseHelixResponse(0, {
        message: `no EventSub token for ${config.channel}`,
      });
    }
    const token = await auth.getToken(retried);
    if (!token) return parseHelixResponse(0, { message: "no usable token" });
    const req = build(auth, token);
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(CP_HELIX_TIMEOUT_MS),
      });
    } catch (e) {
      return parseHelixResponse(0, { message: String(e) });
    }
    if (res.status === 401 && !retried) {
      await res.body?.cancel();
      return helix(build, true); // token expired mid-flight — refresh once
    }
    return parseHelixResponse(res.status, await res.json().catch(() => null));
  }

  /** A hint for the Helix failures an operator can act on. */
  function helixHint(r: HelixResult): string {
    if (r.ok) return "";
    if (r.kind === "unauthorized") {
      return ` — the token may lack ${REDEMPTIONS_MANAGE_SCOPE}; re-run ` +
        `'multichat login' for ${config.channel} (see docs/configuration.md)`;
    }
    if (r.kind === "forbidden") {
      return " — channel points need Affiliate/Partner, and only the Client ID " +
        "that created a reward may manage it";
    }
    return "";
  }

  // The overlay's effect API over loopback. Status 0 = no answer at all.
  async function overlay(
    req: OverlayRequest,
  ): Promise<{ status: number; json: unknown }> {
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(CP_OVERLAY_TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      noteOverlay(true, "");
      return { status: res.status, json };
    } catch (e) {
      noteOverlay(false, String(e));
      return { status: 0, json: null };
    }
  }

  // Log overlay reachability on transitions only, not on every 2s pump.
  function noteOverlay(up: boolean, err: string): void {
    if (overlayUp === up) return;
    overlayUp = up;
    if (up) {
      console.log(`[ChannelPoints] overlay reachable at ${config.overlayUrl}`);
    } else {
      console.error(
        `[ChannelPoints] overlay unreachable at ${config.overlayUrl}: ${err}`,
      );
    }
  }

  /**
   * Send one owed withdrawal (POST /effects/<id>/cancel with the reason, §5.1)
   * and settle it: 200/404 clears `cancelOwed`, anything else backs off for
   * the next pump. Durable because the flag is persisted — a refund made while
   * the overlay is down or restarting is withdrawn once it's back, before the
   * mod can be handed the effect again. Returns true when acknowledged, null
   * when nothing was owed.
   */
  async function withdraw(id: string): Promise<boolean | null> {
    const e = ledger.find((x) => x.id === id);
    if (!e?.cancelOwed) return null;
    const reason = overlayCancelReason(e);
    const res = await overlay(buildEffectCancelRequest(config, id, reason));
    if (cancelAcknowledged(res.status)) {
      const r = markCancelDone(ledger, id);
      if (r.changed) {
        ledger = r.ledger;
        persistLedger();
      }
      return true;
    }
    const r = markCancelFailed(ledger, id, Date.now(), res.status);
    if (r.changed) {
      ledger = r.ledger;
      persistLedger();
    }
    // No answer is reported by noteOverlay (on transitions); an HTTP error is
    // logged on the first failure and then every 20th, not every retry.
    const n = ledger.find((x) => x.id === id)?.cancelAttempts ?? 1;
    if (res.status !== 0 && (n === 1 || n % 20 === 0)) {
      console.error(
        `[ChannelPoints] withdrawing ${id} (${reason}): overlay HTTP ` +
          `${res.status} — retrying (attempt ${n}) until it confirms.`,
      );
    }
    return false;
  }

  /** Every owed withdrawal that is due, oldest first; stops at the first
   *  no-answer (the overlay is down — don't wait out a timeout per entry). */
  async function withdrawDue(): Promise<void> {
    for (const e of dueCancels(ledger, Date.now())) {
      if ((await withdraw(e.id)) === false && overlayUp === false) break;
    }
  }

  function announce(e: RedemptionEntry): void {
    if (!config.announce) return;
    const color = specByKey.get(e.key)?.color ?? TIER_COLORS[1];
    opts.getEmitter().message(redemptionChatMessage(e, config.channel, color));
  }

  /** Admit one redemption (EventSub, reconcile or simulate) and kick the pump. */
  function admit(
    input: RedemptionInput,
    source: string,
  ): { entry: RedemptionEntry; added: boolean } {
    const r = admitRedemption(
      ledger,
      input,
      specByKey.get(input.key),
      Date.now(),
      config.ttlSec,
    );
    if (!r.added) return r;
    ledger = r.ledger;
    persistLedger();
    const e = r.entry;
    if (e.state === "resolved") {
      console.log(
        `[ChannelPoints] ${e.viewer} redeemed ${e.title} (${e.id}, ${source}) — ` +
          `refunding: ${e.reason}`,
      );
    } else {
      console.log(
        `[ChannelPoints] ${e.viewer} redeemed ${e.title} (${e.id}, ${source}) → ` +
          `${e.effect}`,
      );
      announce(e);
    }
    void pump();
    return r;
  }

  /** Resolve an entry. `withdraw` = multichat decided this itself (not the
   *  overlay's own final result), so if a POST /effects was ever attempted a
   *  withdrawal is owed and goes out on the next pump round. */
  function resolve(
    id: string,
    outcome: RedemptionOutcome,
    reason: string,
    how: { detail?: string; withdraw?: boolean } = {},
  ): void {
    const r = resolveEntry(ledger, id, outcome, reason, Date.now(), how);
    if (!r.changed || !r.entry) return;
    ledger = r.ledger;
    persistLedger();
    const { detail } = how;
    console.log(
      `[ChannelPoints] ${r.entry.viewer}'s ${r.entry.title} (${id}) → ` +
        `${outcome === "fulfilled" ? "FULFILLED" : "REFUNDED"} (${reason}` +
        `${detail ? `: ${detail}` : ""})${
          r.entry.cancelOwed ? " — withdrawing it from the overlay" : ""
        }`,
    );
    if (r.entry.cancelOwed) pumpAgain = true;
  }

  /** The streamer fulfilled/refunded it in the Twitch rewards queue: Twitch
   *  already has the status, so no PATCH — just withdraw the effect (owed
   *  whenever it was ever sent to the overlay, and retried until confirmed). */
  function resolveExternally(id: string, outcome: RedemptionOutcome): void {
    const r = resolveEntry(ledger, id, outcome, "external", Date.now(), {
      twitchSynced: true,
      withdraw: true,
    });
    if (!r.changed) return;
    ledger = r.ledger;
    persistLedger();
    console.log(
      `[ChannelPoints] ${id} was ${
        outcome === "fulfilled" ? "fulfilled" : "refunded"
      } in the Twitch rewards queue${
        r.entry?.cancelOwed ? " — withdrawing its effect" : ""
      }.`,
    );
    if (r.entry?.cancelOwed) void withdraw(id); // the pump retries a failure
  }

  function onRedemption(r: RedemptionEvent): void {
    if (r.channel.toLowerCase() !== config.channel) return;
    const key = rewardKeyById(managed.byKey).get(r.rewardId);
    // Not a reward this app created (dashboard / another app): it can't be
    // fulfilled or refunded from here, so leave it to the streamer.
    if (key === undefined) return;
    if (r.kind === "add") {
      if (r.status && r.status !== "unfulfilled") return; // already final
      admit({
        id: r.redemptionId,
        rewardId: r.rewardId,
        key,
        title: r.rewardTitle,
        cost: r.cost,
        viewer: r.displayName,
        login: r.login,
        redeemedAt: r.redeemedAt,
        simulated: false,
      }, "EventSub");
      return;
    }
    // `.update` also echoes our own PATCHes; those entries are already
    // resolved, so resolving them again is a no-op.
    if (r.status === "fulfilled") {
      resolveExternally(r.redemptionId, "fulfilled");
    } else if (r.status === "canceled") {
      resolveExternally(r.redemptionId, "canceled");
    }
  }

  // ---- the pump: received → overlay → result → Twitch ----------------------

  async function pump(): Promise<void> {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      // A few rounds at most per call: work that keeps re-arming itself (a
      // requeue the overlay never keeps) waits for the next tick, not a spin.
      let rounds = 0;
      do {
        pumpAgain = false;
        // Withdrawals first: the moment an overlay that was down comes back,
        // it restores its queue and the mod claims within seconds.
        await withdrawDue();
        await deliver();
        await poll();
        await syncTwitch();
      } while (pumpAgain && ++rounds < 3);
    } catch (e) {
      console.error(`[ChannelPoints] pump error: ${e}`);
    } finally {
      pumping = false;
    }
  }

  /** Hand every `received` entry to the overlay, oldest first. */
  async function deliver(): Promise<void> {
    const due = ledger.filter((e) => e.state === "received")
      .sort((a, b) => a.receivedAt - b.receivedAt);
    for (const e of due) {
      // Refunded (or resolved in the rewards queue) during an earlier await
      // of this loop: don't hand the overlay an effect nobody paid for.
      if (ledger.find((x) => x.id === e.id)?.state !== "received") continue;
      const now = Date.now();
      if (now >= e.expiresAt) {
        // An earlier POST that timed out may still have landed (and the
        // overlay keeps an effect at least 30s), so a failed delivery owes a
        // withdrawal.
        resolve(
          e.id,
          "canceled",
          e.attempts > 0 ? "overlay_unreachable" : "timeout",
          { withdraw: true },
        );
        continue;
      }
      const res = await overlay(buildEffectEnqueueRequest(config, e, now));
      const out = interpretEnqueueResponse(res.status, res.json);
      if (ledger.find((x) => x.id === e.id)?.state === "resolved") {
        // Refunded (or resolved in the rewards queue) while the POST was in
        // flight. Unless the overlay cleanly refused it, it may now hold an
        // effect nobody paid for: owe the withdrawal (durably — retried until
        // the overlay confirms).
        if (out.kind !== "refused") {
          const r = oweCancel(ledger, e.id, Date.now());
          if (r.changed) {
            ledger = r.ledger;
            persistLedger();
            pumpAgain = true;
          }
        }
        continue;
      }
      if (out.kind === "queued") {
        ledger = markQueued(ledger, e.id).ledger;
        persistLedger();
      } else if (out.kind === "refused") {
        // Only an earlier, unanswered POST could have left the overlay a copy.
        resolve(e.id, "canceled", out.reason, { withdraw: true });
      } else {
        ledger = markAttempt(ledger, e.id).ledger;
        persistLedger();
        if (res.status === 0) break; // overlay down — don't hammer the rest
      }
    }
  }

  /** Ask the overlay how the queued effects went; map finals to outcomes. */
  async function poll(): Promise<void> {
    const queued = ledger.filter((e) => e.state === "queued");
    for (let i = 0; i < queued.length; i += MAX_LOOKUP_IDS) {
      const batch = queued.slice(i, i + MAX_LOOKUP_IDS);
      const res = await overlay(
        buildEffectsLookupRequest(config, batch.map((e) => e.id)),
      );
      const known = res.status >= 200 && res.status < 300
        ? parseEffectsLookup(res.json)
        : null;
      const now = Date.now();
      for (const e of batch) {
        // Resolved while the lookup was in flight (a manual refund): done.
        if (ledger.find((x) => x.id === e.id)?.state !== "queued") continue;
        const s = known?.get(e.id);
        const outcome = s ? effectOutcome(s.status) : null;
        if (s && outcome) {
          // The overlay's own final result: nothing to withdraw.
          resolve(e.id, outcome, s.reason || s.status, { detail: s.detail });
        } else if (queuedTimedOut(e, now)) {
          resolve(e.id, "canceled", "timeout", { withdraw: true });
        } else if (known && !s) {
          // The overlay answered but has never heard of it (it lost its
          // queue): deliver it again — every hop dedupes on the id.
          ledger = requeueEntry(ledger, e.id).ledger;
          persistLedger();
          pumpAgain = true;
        }
      }
    }
  }

  /** PATCH resolved redemptions to FULFILLED/CANCELED on Twitch, ≤50 per
   *  reward per call, backing off on failure. Only the ids Twitch echoes back
   *  count as settled; a multi-id batch it won't take whole (404/400 — one
   *  stale id can sink it) is re-sent one id at a time, where a 404 is
   *  terminal (no longer UNFULFILLED), so one bad id never strands the rest. */
  async function syncTwitch(): Promise<void> {
    const batches = dueSyncBatches(ledger, Date.now());
    if (batches.length === 0 || !opts.getChannelAuth(config.channel)) return;
    const patch = (b: SyncBatch, ids: string[]) =>
      helix((auth, token) =>
        buildUpdateRedemptionStatusRequest(
          auth.broadcasterId,
          b.rewardId,
          ids,
          b.status,
          opts.clientId,
          token,
        )
      );
    const settle = (b: SyncBatch, ids: string[], res: HelixResult) => {
      const v = judgeSyncBatch(ids, res);
      if (v.synced.length) ledger = markSynced(ledger, v.synced);
      if (v.failed.length) {
        ledger = markSyncFailed(ledger, v.failed, Date.now());
        if (!res.ok) {
          console.error(
            `[ChannelPoints] could not mark ${v.failed.length} redemption(s) ` +
              `${b.status} (HTTP ${res.status}): ${res.message}${
                helixHint(res)
              }`,
          );
        }
      }
      persistLedger();
      return v.split;
    };
    for (const b of batches) {
      const split = settle(b, b.ids, await patch(b, b.ids));
      for (const id of split) settle(b, [id], await patch(b, [id]));
    }
  }

  // ---- reward sync ----------------------------------------------------------

  /** Queue `fn` on the rewards chain (see `rewardsChain`). */
  function onRewardsChain<T>(fn: () => Promise<T>): Promise<T> {
    const run = rewardsChain.then(fn);
    rewardsChain = run.catch(() => {});
    return run;
  }

  /** Single-flight reward sync, serialized with pause application — and the
   *  wanted pause state is applied in the same step, straight after the sync,
   *  so a reward it just created (born unpaused) is never left live while the
   *  rest are paused, not even for the length of a reconcile pass. */
  function sync(): Promise<RewardSyncReport> {
    if (!syncing) {
      syncing = onRewardsChain(async () => {
        const report = await doSync();
        await runApplyPause().catch((e) =>
          console.error(`[ChannelPoints] pause error: ${e}`)
        );
        return report;
      }).finally(() => {
        syncing = null;
      });
    }
    return syncing;
  }

  async function doSync(): Promise<RewardSyncReport> {
    const report: RewardSyncReport = {
      ok: false,
      message: "",
      created: [],
      updated: [],
      disabled: [],
      unchanged: 0,
      errors: [],
    };
    if (!opts.getChannelAuth(config.channel)) {
      report.message = `No EventSub token for "${config.channel}" yet — the ` +
        `rewards live on its broadcaster token (see twitch.eventsub).`;
      lastSyncError = report.message;
      return report;
    }
    const list = await helix((auth, token) =>
      buildGetCustomRewardsRequest(auth.broadcasterId, opts.clientId, token)
    );
    if (!list.ok) {
      report.message = `Could not list the channel's rewards (HTTP ` +
        `${list.status}): ${list.message}${helixHint(list)}`;
      lastSyncError = report.message;
      console.error(`[ChannelPoints] sync: ${report.message}`);
      return report;
    }
    const plan = planRewardSync(
      config.rewards,
      parseCustomRewardsResponse(list.json),
      managed.byKey,
    );
    const byKey: Record<string, string> = { ...plan.matched };
    for (const s of plan.create) {
      const res = await helix((auth, token) =>
        buildCreateCustomRewardRequest(
          auth.broadcasterId,
          rewardFields(s),
          opts.clientId,
          token,
        )
      );
      const created = res.ok ? parseCustomRewardsResponse(res.json)[0] : null;
      if (created) {
        byKey[s.key] = created.id;
        report.created.push(s.key);
      } else if (!res.ok && res.kind === "duplicate") {
        report.errors.push(
          `create ${s.key}: a reward titled "${s.title}" already exists but ` +
            `wasn't created by multichat, so it can never be fulfilled or ` +
            `refunded from here — delete or rename it in the Twitch dashboard`,
        );
      } else {
        report.errors.push(
          `create ${s.key}: ${
            res.ok
              ? "no reward in the response"
              : `HTTP ${res.status} ${res.message}`
          }${helixHint(res)}`,
        );
      }
    }
    for (const u of plan.update) {
      const res = await helix((auth, token) =>
        buildUpdateCustomRewardRequest(
          auth.broadcasterId,
          u.rewardId,
          u.fields,
          opts.clientId,
          token,
        )
      );
      if (res.ok) report.updated.push(u.key);
      else {
        report.errors.push(
          `update ${u.key}: HTTP ${res.status} ${res.message}${helixHint(res)}`,
        );
      }
    }
    // Retired keys: disabled, never deleted — a DELETE fulfils their pending
    // redemptions without a refund.
    for (const d of plan.disable) {
      const res = await helix((auth, token) =>
        buildUpdateCustomRewardRequest(
          auth.broadcasterId,
          d.rewardId,
          { is_enabled: false },
          opts.clientId,
          token,
        )
      );
      if (res.ok) report.disabled.push(d.key);
      else {
        report.errors.push(
          `disable ${d.key}: HTTP ${res.status} ${res.message}${
            helixHint(res)
          }`,
        );
      }
    }
    report.unchanged = Object.keys(plan.matched).length - plan.update.length -
      plan.disable.length;
    managed = { byKey, syncedAt: Date.now() };
    persistRewards();
    // New rewards are born unpaused; re-apply the pause state to all of them.
    if (report.created.length > 0) twitchPaused = null;
    report.ok = report.errors.length === 0;
    const parts = [
      report.created.length ? `created ${report.created.join(", ")}` : "",
      report.updated.length ? `updated ${report.updated.join(", ")}` : "",
      report.disabled.length ? `disabled ${report.disabled.join(", ")}` : "",
      `${report.unchanged} unchanged`,
    ].filter((p) => p);
    report.message = `${report.ok ? "Synced" : "Synced with errors"}: ` +
      parts.join(" · ");
    lastSyncAt = Date.now();
    lastSyncError = report.ok ? null : report.errors.join("; ");
    console.log(`[ChannelPoints] ${report.message}`);
    for (const err of report.errors) console.error(`[ChannelPoints] ${err}`);
    return report;
  }

  // ---- reconcile: recover what EventSub dropped ------------------------------

  function reconcile(): Promise<void> {
    if (!reconciling) {
      reconciling = doReconcile()
        .catch((e) => console.error(`[ChannelPoints] reconcile error: ${e}`))
        .finally(() => {
          reconciling = null;
        });
    }
    return reconciling;
  }

  async function doReconcile(): Promise<void> {
    // The reward map may be about to change.
    if (syncing) await syncing.catch(() => null);
    if (!opts.getChannelAuth(config.channel)) return;
    let found = 0;
    // Retired keys are included: their stragglers get admitted as "retired"
    // and refunded.
    for (const [key, rewardId] of Object.entries(managed.byKey)) {
      let after = "";
      for (let page = 0; page < CP_RECONCILE_PAGES; page++) {
        const res = await helix((auth, token) =>
          buildGetRedemptionsRequest(
            auth.broadcasterId,
            rewardId,
            opts.clientId,
            token,
            after,
          )
        );
        if (!res.ok) {
          if (res.kind !== "not_found") {
            console.error(
              `[ChannelPoints] reconcile ${key}: HTTP ${res.status} ` +
                `${res.message}${helixHint(res)}`,
            );
          }
          break;
        }
        const { redemptions, cursor } = parseRedemptionsResponse(res.json);
        for (const x of redemptions) {
          const r = admit({
            id: x.id,
            rewardId,
            key,
            title: x.rewardTitle,
            cost: x.rewardCost,
            viewer: x.userName,
            login: x.userLogin,
            redeemedAt: x.redeemedAt,
            simulated: false,
          }, "reconcile");
          if (r.added) found++;
        }
        if (!cursor || redemptions.length === 0) break;
        after = cursor;
      }
    }
    if (found > 0) {
      console.log(
        `[ChannelPoints] reconcile picked up ${found} redemption(s) EventSub missed.`,
      );
    }
  }

  // ---- auto-pause ------------------------------------------------------------

  /** One GET /effects/health, fed through the auto-pause hysteresis. Good =
   *  the mod is polling AND says it's ready (not ESC-paused, not `/chaos
   *  pause`d, the streamer online and alive) — a mod that polls but can't run
   *  anything would otherwise hold viewers' points until the deadline. */
  async function checkHealth(): Promise<void> {
    const res = await overlay(buildEffectsHealthRequest(config));
    const h = res.status >= 200 && res.status < 300
      ? parseEffectsHealth(res.json)
      : null;
    lastHealthAt = Date.now();
    const good = healthGood(h);
    if (healthOk !== good) {
      const why = !h
        ? "overlay down or not answering"
        : !h.enabled
        ? "effects are off in the overlay"
        : !h.accepting
        ? "the game isn't polling for effects"
        : "the game isn't ready — paused, loading, /chaos pause, or the " +
          "streamer is dead";
      console.log(
        `[ChannelPoints] overlay ${
          good ? "is taking effects" : `is NOT taking effects (${why})`
        }.`,
      );
    }
    healthOk = good;
    accepting = h?.accepting ?? false;
    ready = h?.ready ?? false;
    autoGate = stepAutoPause(autoGate, good);
  }

  /** Paused when the operator said so, or (auto-pause) once the game has
   *  been unable to take effects for two checks in a row — Twitch then blocks
   *  redemptions instead of us refunding them after the fact. */
  function desiredPaused(): boolean {
    return control.manualPause || (config.autoPause && autoGate.paused);
  }

  // On the rewards chain, so a health tick, a CLI pause and a reward sync
  // can't interleave; each run re-reads the desired state and the reward map,
  // so a queued run is a cheap no-op.
  function applyPause(): Promise<void> {
    return onRewardsChain(runApplyPause).catch((e) =>
      console.error(`[ChannelPoints] pause error: ${e}`)
    );
  }

  async function runApplyPause(): Promise<void> {
    const want = desiredPaused();
    if (twitchPaused === want || !opts.getChannelAuth(config.channel)) return;
    const targets = config.rewards
      .filter((r) => r.enabled && managed.byKey[r.key])
      .map((r) => ({ key: r.key, id: managed.byKey[r.key] }));
    if (targets.length === 0) return;
    let failed = 0;
    for (const t of targets) {
      const res = await helix((auth, token) =>
        buildUpdateCustomRewardRequest(
          auth.broadcasterId,
          t.id,
          { is_paused: want },
          opts.clientId,
          token,
        )
      );
      if (!res.ok) {
        failed++;
        console.error(
          `[ChannelPoints] ${want ? "pause" : "unpause"} ${t.key}: HTTP ` +
            `${res.status} ${res.message}${helixHint(res)}`,
        );
      }
    }
    // Only record it when every reward took it; otherwise the next health tick
    // tries again.
    if (failed === 0) {
      twitchPaused = want;
      const why = control.manualPause
        ? "manual pause"
        : want
        ? "auto: the game isn't taking effects"
        : "the game is taking effects";
      console.log(
        `[ChannelPoints] rewards ${
          want ? "PAUSED" : "live"
        } on Twitch (${why}).`,
      );
    }
  }

  async function healthTick(): Promise<void> {
    await checkHealth();
    await applyPause();
  }

  // ---- EventSub wiring --------------------------------------------------------

  /** First time the channel's token is usable: provision the rewards and
   *  apply the pause state (in that one step — new rewards start live), then
   *  recover missed redemptions. */
  function onAuthReady(_auth: ChannelAuth, granted: readonly string[] | null) {
    scopes = granted;
    if (authSeen) return;
    authSeen = true;
    void (async () => {
      await sync();
      await reconcile();
      await healthTick();
      void pump();
    })().catch((e) => console.error(`[ChannelPoints] startup error: ${e}`));
  }

  // ---- operator hooks (POST /api/rewards) ----------------------------------

  function status(): ChannelPointsStatus {
    const { rows, retired } = rewardStatusRows(config.rewards, managed.byKey);
    return {
      channel: config.channel,
      overlayUrl: config.overlayUrl,
      authReady: !!opts.getChannelAuth(config.channel),
      scopeOk: scopes ? scopes.includes(REDEMPTIONS_MANAGE_SCOPE) : null,
      accepting,
      ready,
      lastHealthAt,
      autoPause: config.autoPause,
      manualPause: control.manualPause,
      twitchPaused,
      lastSyncAt,
      lastSyncError,
      rewards: rows,
      retired,
      counts: ledgerCounts(ledger),
    };
  }

  const hooks: ChannelPointsHooks = {
    status,
    sync: async () => {
      const r = await sync(); // applies the pause state in the same step
      if (r.ok) void reconcile();
      return r;
    },
    pause: async (): Promise<RewardsPauseResult> => {
      control = { manualPause: true };
      persistControl();
      await applyPause();
      const ok = twitchPaused === true;
      return {
        ok,
        message: ok
          ? "Rewards paused on Twitch (manual — held until `rewards resume`, " +
            "across restarts)."
          : "Manual pause recorded, but Twitch wasn't updated yet (no token, " +
            "rewards not synced, or a PATCH failed) — it is applied as soon as " +
            "it can be.",
        status: status(),
      };
    },
    resume: async (): Promise<RewardsPauseResult> => {
      control = { manualPause: false };
      persistControl();
      await checkHealth();
      await applyPause();
      const want = desiredPaused();
      const ok = twitchPaused === want;
      return {
        ok,
        message: want && ok
          ? "Manual pause cleared, but auto-pause keeps the rewards paused: " +
            "the overlay says the game isn't taking effects (not polling, or " +
            "not ready)."
          : ok
          ? "Rewards are live on Twitch."
          : "Manual pause cleared, but Twitch wasn't updated yet (no token, " +
            "rewards not synced, or a PATCH failed).",
        status: status(),
      };
    },
    pending: () => openEntries(ledger),
    refund: async (id): Promise<RewardsResult> => {
      const before = ledger.find((e) => e.id === id);
      if (!before) {
        return { ok: false, message: `No redemption ${id} in the ledger.` };
      }
      if (before.state === "resolved") {
        return {
          ok: false,
          message: `${id} is already resolved (${before.outcome}: ` +
            `${before.reason ?? "?"}).`,
          entry: before,
        };
      }
      const r = resolveEntry(ledger, id, "canceled", "manual", Date.now(), {
        withdraw: true,
      });
      ledger = r.ledger;
      persistLedger();
      // Withdraw it from the overlay now if it was ever sent there; when the
      // overlay doesn't confirm, the pump keeps retrying until it does.
      const withdrawn = r.entry?.cancelOwed ? await withdraw(id) : null;
      void pump(); // the Twitch refund goes out on this pass
      const overlayNote = withdrawn === false
        ? " The overlay didn't confirm the effect's withdrawal yet — it is " +
          "retried until it does."
        : "";
      return {
        ok: true,
        message:
          (before.simulated
            ? `Simulated redemption ${id} canceled (nothing to refund on Twitch).`
            : `Refunding ${before.viewer}'s ${before.title} on Twitch.`) +
          overlayNote,
        entry: ledger.find((e) => e.id === id) ?? r.entry ?? undefined,
      };
    },
    simulate: (key, user): Promise<RewardsResult> => {
      const spec = specByKey.get(key);
      if (!spec) {
        return Promise.resolve({
          ok: false,
          message: `Unknown reward key "${key}" — one of: ${
            [...specByKey.keys()].join(", ")
          }`,
        });
      }
      const r = admit(
        simulatedRedemption(
          spec,
          managed.byKey[key] ?? "",
          user ?? "",
          crypto.randomUUID(),
          Date.now(),
        ),
        "simulate",
      );
      return Promise.resolve({
        ok: true,
        message: `Simulated ${r.entry.viewer} redeeming ${spec.title} ` +
          `(${r.entry.id}) → ${spec.effect}. Watch it with \`rewards pending\`.`,
        entry: r.entry,
      });
    },
  };

  /** The channel's token never arrived (EventSub keeps retrying it): say so
   *  loudly and repeatedly, because nothing here works without it — rewards
   *  left live on Twitch take points that are neither fulfilled nor refunded. */
  function nagIfNoAuth(): void {
    if (authSeen || !opts.expectAuth) return;
    console.error(
      `[ChannelPoints] !!! still no usable Twitch token for #${config.channel} ` +
        `after ${
          Math.round((Date.now() - startedAt) / 60_000)
        } min — rewards ` +
        `can't be synced, paused, fulfilled or refunded, and redemptions of any ` +
        `reward left live on Twitch are NOT being processed. See the [EventSub] ` +
        `errors above (token refresh / broadcaster lookup, retried with back-off).`,
    );
  }

  function start(): void {
    setInterval(() => void pump(), CP_PUMP_MS);
    setInterval(() => void healthTick(), CP_HEALTH_MS);
    setTimeout(nagIfNoAuth, 60_000);
    setInterval(() => {
      nagIfNoAuth();
      // The startup sync never got as far as listing the rewards (a network
      // blip, Twitch down): keep trying rather than wait for `rewards sync`.
      if (authSeen && lastSyncAt === null && !syncing) void sync();
      void reconcile();
      const pruned = pruneLedger(ledger, Date.now());
      if (pruned.length !== ledger.length) {
        ledger = pruned;
        persistLedger();
      }
    }, CP_RECONCILE_MS);
    void healthTick();
    void pump();
  }

  return {
    wiring: {
      channel: config.channel,
      onRedemption,
      onAuthReady,
      onSessionReady: () => void reconcile(),
    },
    hooks,
    init,
    start,
    flush,
  };
}

/** Log channel-points setup at startup (and anything that will stop it from
 *  reaching Twitch or the game), so a misconfig is visible early. */
function warnChannelPointsSetup(
  config: ChannelPointsConfig,
  twitch: TwitchConfig,
): void {
  console.log(
    `[ChannelPoints] enabled on #${config.channel || "(unset)"} — ` +
      `${config.rewards.length} reward(s), effects → ${config.overlayUrl}` +
      `${config.overlayToken ? " (token set)" : ""}, auto-pause ` +
      `${config.autoPause ? "on" : "off"}, deadline ${config.ttlSec}s.`,
  );
  const es = twitch.eventsub;
  const logins = (es?.channels ?? []).map((c) => (c.login ?? "").toLowerCase());
  for (
    const p of channelPointsSetupProblems(
      config,
      logins,
      !!es?.clientId && !!es?.clientSecret,
    )
  ) {
    console.error(`[ChannelPoints] ${p}`);
  }
}

/** Grace period for writing state on SIGTERM/SIGINT before exiting anyway. */
const SHUTDOWN_FLUSH_MS = 3_000;

/**
 * On SIGTERM (systemd stop / deploy) or SIGINT (Ctrl-C), write the latest
 * state before exiting instead of dying mid-write, bounded so a stuck disk
 * can't hold the stop up. A second signal exits at once.
 */
function flushOnShutdown(flush: () => Promise<void>): void {
  let stopping = false;
  const onSignal = (sig: "SIGTERM" | "SIGINT") => {
    const code = sig === "SIGINT" ? 130 : 0;
    if (stopping) Deno.exit(code);
    stopping = true;
    console.log(`[Control] ${sig} — saving state before exit.`);
    const deadline = new Promise<void>((r) => setTimeout(r, SHUTDOWN_FLUSH_MS));
    void Promise.race([flush().catch(() => {}), deadline]).finally(() =>
      Deno.exit(code)
    );
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(sig, () => onSignal(sig));
    } catch { /* signal unsupported on this platform */ }
  }
}

async function runServer(configPath: string): Promise<void> {
  const settings = await loadSettings(configPath);
  const stateDir = await ensureStateDir(
    resolveStateDir(readEnv),
  );
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
  // The outbound integration bus (chat-cards etc.). Always constructed; a no-op
  // when no subscribers are configured. The giveaway engine emits lifecycle
  // events into it (e.g. a draw → open a pack for the winner).
  const integrations = createIntegrationDispatcher(
    settings.integrations ?? normalizeIntegrationsConfig(undefined),
  );
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
      emitIntegration: (ev) => integrations.emit(ev),
    })
    : undefined;
  if (giveawayEngine) await giveawayEngine.init();

  // Channel points (when enabled): Twitch redemptions → overlay effects →
  // fulfil/refund. Built before the server so /api/rewards can drive it; it
  // reaches Twitch through the same deferred getChannelAuth bridge.
  const channelPointsCfg = settings.channelPoints;
  const channelPoints = channelPointsCfg?.enabled
    ? createChannelPointsEngine({
      config: channelPointsCfg,
      clientId: settings.twitch.eventsub?.clientId ?? "",
      stateDir,
      getEmitter: () => emitter,
      getChannelAuth: (login) => getChannelAuth(login),
      expectAuth: !!channelPointsCfg.channel &&
        esLogins.has(channelPointsCfg.channel) &&
        !!settings.twitch.eventsub?.clientId &&
        !!settings.twitch.eventsub?.clientSecret,
    })
    : undefined;
  if (channelPoints) {
    await channelPoints.init();
    flushOnShutdown(() => channelPoints.flush());
  }

  // `keys`/`giveawayEngine`/`channelPoints` reference `emitter`/
  // `broadcastGiveaway` only through deferred callbacks, so the forward
  // reference to this destructure is fine.
  const { emitter, broadcastGiveaway } = createServer(settings, {
    setYouTubeKey: (key) => keys.apply(key, true),
    giveaway: giveawayEngine?.hooks,
    channelPoints: channelPoints?.hooks,
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
        channelPoints: channelPoints?.wiring,
      });
      getChannelAuth = mgr.getChannelAuth;
      mgr.start();
    }
  }

  if (giveawayEngine && giveawayCfg) warnGiveawaySetup(giveawayCfg, twitch);
  if (channelPoints && channelPointsCfg) {
    warnChannelPointsSetup(channelPointsCfg, twitch);
    // Runs even without EventSub: `rewards simulate` still drives the overlay.
    channelPoints.start();
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
    "  multichat giveaway [verb] [opts]           control the giveaway (status|open|close|draw|reset|demo|winners|packs|turns|report|plan|campaign-reset|remove <who>)",
    "  multichat rewards [verb] [opts]            control channel-point chaos (status|sync|pause|resume|pending|refund <id>|simulate <key> [--user NAME])",
    "",
    "Options (set-youtube-key, fake, giveaway and rewards share these):",
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
    "  multichat giveaway packs   # pack-opening reports pushed back by chat-cards (cards pulled + value)",
    "  multichat giveaway turns   # the turn ledger (winner, disposition) + mailed/donated/destroyed/passed totals",
    "  multichat giveaway report [--csv]   # compiled per-user report: MST turn-start, cards pulled, value, disposition",
    "  multichat giveaway plan [N] [--reseed] [--csv]   # commit/show the next-N seeded draw order (off-stream prep)",
    "  multichat giveaway plan-clear   # drop the committed draw order (draws go fully random)",
    "  multichat giveaway campaign-reset --yes   # zero campaign + numbers; archives the winners log",
    "  multichat giveaway remove <who>      # drop one entrant: login, display name, #entry-number or userId",
    "",
    "rewards: drive channel-point chaos (Twitch custom rewards → game effects via the",
    "cobblemon-overlay) on the running server. Loopback-only, like fake.",
    "  multichat rewards status     # catalogue ↔ Twitch reward ids, pause state, overlay health, ledger counts",
    "  multichat rewards sync       # create/update the managed rewards on Twitch (retired ones are disabled)",
    "  multichat rewards pause      # pause every managed reward on Twitch (manual; wins over auto-pause)",
    "  multichat rewards resume     # clear the manual pause (auto-pause may still hold them)",
    "  multichat rewards pending    # redemptions still in flight or not yet fulfilled/refunded on Twitch",
    "  multichat rewards refund <id>          # refund one open redemption and withdraw its effect",
    "  multichat rewards simulate <key> [--user NAME]   # fake a redemption through the whole pipeline (no Twitch)",
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
  let target = "";
  let csv = false;
  let yes = false;
  let count = 0;
  let reseed = false;

  const VERBS = [
    "status",
    "open",
    "close",
    "draw",
    "reset",
    "demo",
    "winners",
    "packs",
    "turns",
    "report",
    "plan",
    "plan-clear",
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
    } else if (a === "--reseed") {
      reseed = true;
    } else if (VERBS.includes(a)) {
      action = a;
    } else if (action === "remove" && !target) {
      target = a; // the name/userId/#number positional after `remove`
    } else if (action === "plan" && Number.isFinite(Number(a))) {
      count = Math.max(0, Math.floor(Number(a))); // `plan <N>` positional
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(
        `Usage: multichat giveaway [${VERBS.join("|")}] [name|N]`,
      );
      Deno.exit(2);
    }
  }
  if (!action) action = "status";
  if (!Number.isFinite(port) || port <= 0) {
    console.error("Invalid --port.");
    Deno.exit(2);
  }
  if (action === "remove" && !target) {
    console.error(
      "giveaway remove needs someone to remove: a login, display name, " +
        "#entry-number or userId (see `giveaway status`).",
    );
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
    ? { action: "remove", target }
    : action === "plan"
    ? { action: "plan", count, reseed }
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
      packs?: PackReport[];
      turns?: GiveawayTurn[];
      aggregates?: TurnAggregates;
      rows?: ReportRow[];
      timezone?: string;
      plan?: GiveawayPlan | null;
      removed?: GiveawayEntrant | null;
      matches?: GiveawayEntrant[];
    };
    if (action === "remove") {
      // Say what actually happened. An unmatched or ambiguous needle leaves the
      // pool alone, and exits non-zero so a script notices.
      if (data.removed) {
        const n = data.removed.number ? `#${data.removed.number} ` : "";
        console.log(
          `Removed ${n}${data.removed.displayName || data.removed.login} ` +
            `(${data.removed.userId}). ${data.state?.entrants.length ?? 0} ` +
            `entrant(s) left.`,
        );
        Deno.exit(0);
      }
      const matches = data.matches ?? [];
      if (matches.length > 1) {
        console.error(`"${target}" matches ${matches.length} entrants:`);
        for (const m of matches) {
          console.error(
            `  ${m.userId}  ${m.displayName || m.login}` +
              (m.number ? `  (#${m.number})` : ""),
          );
        }
        console.error("Re-run with the userId to pick one.");
      } else {
        console.error(`No entrant matches "${target}".`);
      }
      Deno.exit(1);
    }
    if (action === "report") {
      const rows = data.rows ?? [];
      if (csv) {
        console.log(reportToCsv(rows).trimEnd()); // raw CSV, pipe to a file
        Deno.exit(0);
      }
      if (rows.length === 0) {
        console.log("No turns to report yet.");
      } else {
        console.log(`Compiled report (times in ${data.timezone ?? "?"}):`);
        for (const r of rows) {
          console.log(
            `  #${r.number} ${r.displayName} [${r.tier}]  ${r.startedLocal}  → ${
              r.disposition || "(in progress)"
            }`,
          );
          if (r.cardCount > 0) {
            console.log(
              `      ${r.cardCount} card(s), $${r.totalValue.toFixed(2)}: ${
                r.cardNames.join(", ")
              }`,
            );
          }
          if (r.carriedFrom) {
            console.log(`      ↳ received a pass from ${r.carriedFrom}`);
          }
          if (r.passedTo) console.log(`      ↳ passed to ${r.passedTo}`);
        }
      }
      const a = data.aggregates;
      if (a) {
        const fmt = (d: { turns: number; cards: number; value: number }) =>
          `${d.turns}/${d.cards}c/$${d.value.toFixed(2)}`;
        console.log(
          `  Totals (turns/cards/value) — mailed ${fmt(a.mailed)} · donated ${
            fmt(a.donated)
          } · destroyed ${fmt(a.destroyed)} · passed ${fmt(a.passed)}`,
        );
      }
      Deno.exit(0);
    }
    if (action === "plan-clear") {
      console.log("Draw plan cleared — draws are fully random again.");
      Deno.exit(0);
    }
    if (action === "plan") {
      const p = data.plan ?? null;
      if (!p || p.order.length === 0) {
        console.log(
          "No draw plan committed. Run `giveaway plan <N>` with entrants in the pool.",
        );
        Deno.exit(0);
      }
      if (csv) {
        const q = (s: string) =>
          /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
        console.log("position,number,displayName,login,userId");
        p.order.forEach((e, i) =>
          console.log(
            `${i + 1},${e.number},${q(e.displayName)},${q(e.login)},${
              q(e.userId)
            }`,
          )
        );
        Deno.exit(0);
      }
      console.log(
        `Committed draw order (seed ${p.seed}, ${p.order.length} planned) — ` +
          `keep this off-stream:`,
      );
      p.order.forEach((e, i) =>
        console.log(
          `  ${String(i + 1).padStart(3)}. #${e.number} ${e.displayName} (${
            e.login || e.userId
          })`,
        )
      );
      Deno.exit(0);
    }
    if (action === "turns") {
      const list = data.turns ?? [];
      const a = data.aggregates;
      if (list.length === 0) {
        console.log("No turns yet.");
      } else {
        for (const t of list) {
          const started = t.startedAt
            ? new Date(t.startedAt).toISOString()
            : "?";
          const disp = t.disposition ? `→ ${t.disposition}` : "(in progress)";
          console.log(
            `#${t.number} ${t.displayName} [${t.tier}] ${disp}  started ${started}` +
              (t.carriedFromTurnId ? "  (received a pass)" : ""),
          );
        }
        console.log(`${list.length} turn(s).`);
      }
      if (a) {
        const fmt = (d: { turns: number; cards: number; value: number }) =>
          `${d.turns} turn(s), ${d.cards} card(s), $${d.value.toFixed(2)}`;
        console.log(
          `Totals — mailed: ${fmt(a.mailed)} · donated: ${fmt(a.donated)} · ` +
            `destroyed: ${fmt(a.destroyed)} · passed: ${fmt(a.passed)}`,
        );
      }
      Deno.exit(0);
    }
    if (action === "packs") {
      const list = data.packs ?? [];
      if (list.length === 0) {
        console.log("No pack reports yet (chat-cards hasn't reported any).");
      } else {
        for (const p of list) {
          const opened = p.openedAt ? new Date(p.openedAt).toISOString() : "?";
          const who = p.winner || p.ref || "?";
          console.log(
            `${who}  ${p.cardCount} card(s)  $${p.totalValue.toFixed(2)}  ` +
              `[${p.closedAt ? "closed" : "open"}]  opened ${opened}`,
          );
          for (const c of p.cards) {
            console.log(
              `    · ${c.name}${c.number ? ` #${c.number}` : ""}  $${
                c.value.toFixed(2)
              }`,
            );
          }
        }
        console.log(`${list.length} pack(s).`);
      }
      Deno.exit(0);
    }
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
      if (
        c && (c.guaranteedRemaining > 0 || c.followerCount > 0 ||
          c.winnersTotal > 0 || c.poolSize !== s.entrants.length)
      ) {
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

/** "12s" / "4m" / "3h" / "2d" — for ages and last-check times in the CLI. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** One ledger entry as a CLI line (pending / refund / simulate). */
function describeRedemption(e: RedemptionEntry): string {
  const where = e.state === "resolved"
    ? `${e.outcome === "fulfilled" ? "FULFILLED" : "REFUNDED"} (${
      e.reason ?? "?"
    }${e.detail ? `: ${e.detail}` : ""})${
      e.twitchSynced || e.simulated ? "" : " — Twitch not told yet"
    }${e.cancelOwed ? " — overlay withdrawal not confirmed yet" : ""}`
    : e.state;
  return `${e.id}  ${e.key} → ${e.effect || "?"}  ${e.viewer}  ${where}  ` +
    `${ago(Date.now() - e.receivedAt)} ago${
      e.simulated ? "  [simulated]" : ""
    }`;
}

/**
 * CLI client: drive channel-point chaos on a running server via its loopback
 * /api/rewards endpoint — sync the rewards to Twitch, pause/resume them, watch
 * or refund in-flight redemptions, and simulate one end to end without Twitch.
 * See docs/configuration.md#channel-points.
 */
async function runRewards(args: string[]): Promise<void> {
  let host = Deno.env.get("HOST") ?? "127.0.0.1";
  let port = Number(Deno.env.get("PORT") ?? "8080");
  let action = "";
  let target = "";
  let user = "";

  const VERBS = [
    "status",
    "sync",
    "pause",
    "resume",
    "pending",
    "refund",
    "simulate",
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
    } else if (a === "--user") {
      user = args[++i] ?? "";
    } else if (!action && VERBS.includes(a)) {
      action = a;
    } else if ((action === "refund" || action === "simulate") && !target) {
      target = a; // the redemption id / reward key positional
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(
        `Usage: multichat rewards [${VERBS.join("|")}] [id|key] [--user NAME]`,
      );
      Deno.exit(2);
    }
  }
  if (!action) action = "status";
  if (!Number.isFinite(port) || port <= 0) {
    console.error("Invalid --port.");
    Deno.exit(2);
  }
  if (action === "refund" && !target) {
    console.error(
      "rewards refund needs a redemption id (see `multichat rewards pending`).",
    );
    Deno.exit(2);
  }
  if (action === "simulate" && !target) {
    console.error(
      "rewards simulate needs a reward key (see `multichat rewards status`).",
    );
    Deno.exit(2);
  }

  const wire: RewardsAction = action === "refund"
    ? { action: "refund", id: target }
    : action === "simulate"
    ? (user
      ? { action: "simulate", key: target, user }
      : { action: "simulate", key: target })
    : { action } as RewardsAction;
  const { res, text } = await postControl(
    host,
    port,
    "/api/rewards",
    serializeRewardsAction(wire),
    "application/json",
  );
  if (!res.ok) {
    console.error(`Failed (HTTP ${res.status}): ${text}`);
    Deno.exit(1);
  }
  try {
    const data = JSON.parse(text) as {
      status?: ChannelPointsStatus;
      sync?: RewardSyncReport;
      pending?: RedemptionEntry[];
      ok?: boolean;
      message?: string;
      entry?: RedemptionEntry;
    };
    if (action === "sync") {
      const s = data.sync;
      if (!s) {
        console.log(text);
        Deno.exit(1);
      }
      console.log(s.message);
      for (const err of s.errors) console.error(`  ✗ ${err}`);
      Deno.exit(s.ok ? 0 : 1);
    }
    if (action === "pending") {
      const list = data.pending ?? [];
      if (list.length === 0) {
        console.log(
          "Nothing in flight — every redemption is settled on Twitch.",
        );
      } else {
        for (const e of list) console.log(describeRedemption(e));
        console.log(`${list.length} open redemption(s).`);
      }
      Deno.exit(0);
    }
    if (action === "refund" || action === "simulate") {
      (data.ok ? console.log : console.error)(data.message ?? text);
      if (data.entry) console.log("  " + describeRedemption(data.entry));
      Deno.exit(data.ok ? 0 : 1);
    }
    // status / pause / resume all carry the status block.
    if (data.message) {
      (data.ok ? console.log : console.error)(data.message);
    }
    const s = data.status;
    if (s) {
      const now = Date.now();
      console.log(
        `Channel points on #${
          s.channel || "(unset)"
        } → overlay ${s.overlayUrl}`,
      );
      const token = s.authReady
        ? `token ready${
          s.scopeOk === false
            ? `, MISSING ${REDEMPTIONS_MANAGE_SCOPE} (re-run 'multichat login')`
            : s.scopeOk
            ? ", scope ok"
            : ""
        }`
        : "no EventSub token yet";
      const paused = s.twitchPaused === null
        ? "pause state not applied yet"
        : s.twitchPaused
        ? `rewards PAUSED (${s.manualPause ? "manual" : "auto"})`
        : "rewards LIVE";
      console.log(`  Twitch: ${token} · ${paused}`);
      console.log(
        `  Overlay: ${
          s.accepting === null
            ? "not checked yet"
            : !s.accepting
            ? "NOT accepting effects (game not polling, or overlay down)"
            : s.ready === false
            ? "game polling but NOT ready (paused, loading or dead)"
            : "accepting effects, game ready"
        }${
          s.lastHealthAt ? ` (checked ${ago(now - s.lastHealthAt)} ago)` : ""
        }` +
          ` · auto-pause ${s.autoPause ? "on" : "off"}` +
          `${s.manualPause ? " · manual pause ON" : ""}`,
      );
      console.log(
        `  Last sync: ${
          s.lastSyncAt ? `${ago(now - s.lastSyncAt)} ago` : "not yet"
        }${s.lastSyncError ? ` — ${s.lastSyncError}` : ""}`,
      );
      console.log(`  Rewards (${s.rewards.length}):`);
      for (const r of s.rewards) {
        console.log(
          `    ${r.key.padEnd(22)} ${String(r.cost).padStart(6)}  ` +
            `${r.title.padEnd(24)} → ${r.effect.padEnd(16)} ${
              r.rewardId ?? "(not on Twitch yet)"
            }${r.enabled ? "" : "  [disabled]"}`,
        );
      }
      for (const r of s.retired) {
        console.log(
          `    ${r.key.padEnd(22)} retired (kept disabled) ${r.rewardId}`,
        );
      }
      const c = s.counts;
      console.log(
        `  Ledger: ${c.received} received · ${c.queued} queued · ` +
          `${c.unsynced} awaiting Twitch · ${c.resolved} resolved${
            c.withdrawing
              ? ` · ${c.withdrawing} being withdrawn from the overlay`
              : ""
          }`,
      );
    }
    Deno.exit(data.ok === false ? 1 : 0);
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
  if (tok.scopes) {
    console.log(`Scopes granted: ${tok.scopes.join(" ") || "(none)"}`);
    const missing = LOGIN_SCOPES.filter((s) => !tok.scopes!.includes(s));
    if (missing.length > 0) {
      console.error(`Missing (requested, not granted): ${missing.join(" ")}`);
    }
  }
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
  console.log(
    "Re-authorizing a channel the server already runs (e.g. to add a scope)? " +
      "The persisted rotated token (<state dir>/twitch-refresh-" +
      `${
        user?.id ?? "<broadcasterId>"
      }) wins over any seed: replace the seed ` +
      "(settings.json / refreshTokenFile) AND delete that file, then restart. " +
      "See docs/configuration.md.",
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
} else if (first === "rewards") {
  await runRewards(rest);
} else if (first === "--help" || first === "-h") {
  console.log(cliUsage());
} else {
  await runServer(first ?? "settings.json");
}

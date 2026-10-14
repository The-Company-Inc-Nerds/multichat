# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this is

Multichat is a dependency-free Deno server that combines Twitch IRC chat and
YouTube Live Chat into a single browser-based viewer. It uses Server-Sent Events
(SSE) to push messages to the browser in real time.

User-facing docs live in `docs/` (see `docs/index.md`). This file is the
dev-facing guide; keep both in sync when structure changes.

## Development commands

```bash
deno task start          # run the server (reads settings.json)
deno task dev            # run with --watch (auto-restarts on file changes)
deno task test           # run the test suite (tests/, no permissions needed)
deno task check          # type-check main.ts, src/, tests/
deno task lint           # lint
deno task fmt            # format
deno task compile        # build a standalone binary ./multichat
deno task fake           # play a demo of every message kind into a running server
```

In the dev shell, `runchecks` runs fmt-check + lint + check + test (the
pre-commit gate).

Or directly:

```bash
deno run --allow-net --allow-read --allow-write=/var/lib/multichat,/var/lib/private/multichat --allow-env=YOUTUBE_API_KEY,TWITCH_CLIENT_ID,TWITCH_CLIENT_SECRET,PORT,HOST,STATE_DIRECTORY main.ts [config-path]
```

`config-path` defaults to `./settings.json`. Env vars `PORT` and `HOST` override
their settings.json counterparts; the YouTube key is resolved as persisted
runtime key → `YOUTUBE_API_KEY` → `youtube.apiKey`.

`--allow-write` exists so state can be persisted: the runtime YouTube key and
its per-Pacific-day quota ledger, the rotated Twitch refresh tokens, the whole giveaway (entrant pool, campaign
counters, append-only winners log, turn ledger, chat-cards pack reports,
committed draw plan), and channel points (the redemption ledger, the catalogue
key → Twitch reward id map, the manual pause). `resolveStateDir` in
`src/control.ts` picks the directory — `$STATE_DIRECTORY` (systemd) →
`$MULTICHAT_STATE_DIR` → `$XDG_STATE_HOME/multichat` →
`$HOME/.local/state/multichat`, never the working tree — and `ensureStateDir` in
main.ts creates it 0700. Everything degrades to in-memory (with a warning) if it
can't be created; persistence must never cost someone their stream. Deno's
`--allow-write` is an allow-list, so those default paths are in `deno.json` and
`build.nix`; a custom `MULTICHAT_STATE_DIR` outside them is denied by Deno.

The same binary is also a small CLI client:

- `multichat set-youtube-key [KEY]` POSTs a key to a running server's loopback
  `POST /api/youtube-key` endpoint (key from arg or stdin). See
  `docs/configuration.md`.
- `multichat login` (alias `twitch-login`) runs the Twitch OAuth flow via a
  temporary loopback redirect and prints a `twitch.eventsub.channels` entry
  (login + broadcasterId + refreshToken) to paste into `settings.json`, enabling
  EventSub alerts. Needs the app's clientId/clientSecret (from settings or
  `--client-id`/`--client-secret`). See `docs/configuration.md`.
- `multichat fake` injects fake events into a running server's loopback
  `POST /api/fake` endpoint for previewing how they render (incl. `/alerts` and
  `/overlay`) without a live stream. With no argument it plays a fixed showcase
  of every message kind (chat, action, cheer, sub, raid, follow, Super Chat,
  sticker, membership, system, a live deletion); `multichat fake <kind>` injects
  just one (e.g. `fake follow`). See `docs/development/testing.md`.
- `multichat giveaway <verb>` drives the Twitch `!enter` giveaway on a running
  server via its loopback `POST /api/giveaway` endpoint (`status` / `open` /
  `close` / `draw` / `reset` / `demo` / `winners [--csv]` / `packs` / `turns` /
  `report [--csv]` / `plan [N] [--reseed] [--csv]` / `plan-clear` /
  `campaign-reset --yes` / `remove <who>` (a login, display name, `#entry-number`
  or userId — resolved server-side, refusing a miss or an ambiguous name rather
  than dropping the wrong person); `demo` injects sample entrants +
  follower progress to preview the reel, `winners` prints the recorded mailing
  list, `packs` the pack reports pushed back by chat-cards, `turns` the turn
  ledger + disposition totals, `report` the compiled per-user list (turn-start
  in Mountain Time, cards pulled, value, disposition), `plan` commits/shows a
  seeded next-N draw order for off-stream prep) — the terminal equivalent of the
  `/giveaway` page (a CS2-style case reel; `?overlay` is a transparent OBS
  source, `?overlay&progress` adds a follower-milestone pill). See
  `docs/configuration.md#giveaway-mode`.
- `multichat rewards <verb>` drives channel-point chaos on a running server via
  its loopback-only `POST /api/rewards` endpoint (`status` / `sync` / `pause` /
  `resume` / `pending` / `refund <id>` / `simulate <key> [--user NAME]`; it also
  refuses anything a browser sends — an `Origin` or a cross-site
  `Sec-Fetch-Site` gets `403`): `status` shows the catalogue ↔ Twitch reward
  ids, pause state, overlay health and ledger counts; `sync` creates/patches the
  managed rewards on Twitch; `pause`/`resume` set the persisted manual pause;
  `pending` lists redemptions still in flight, not yet fulfilled/refunded on
  Twitch, or still being withdrawn from the overlay; `refund` cancels one
  (refund + effect withdrawn, retried until the overlay confirms); `simulate`
  injects a `sim-<uuid>` redemption through the whole overlay → mod pipeline
  without touching Twitch. See `docs/configuration.md#channel-points`.

## Configuration

Copy `settings.json.example` to `settings.json` and edit:

- `server.port` / `server.host` — where the web UI is served
- `server.controlAccess` — who may drive `POST /api/giveaway` (the `/giveaway`
  buttons and `multichat giveaway <verb>`): `"loopback"` (default, host only),
  `"lan"` (also private/link-local peers — the setting for "anyone in the room
  can press Draw"), `"any"` (no address check). `server.controlToken` optionally
  requires a shared secret of non-loopback callers, presented as a bearer header,
  `?token=`, or the cookie `GET /giveaway?token=…` mints. Loopback is never asked
  for the token, so the CLI keeps working. Scoped to `/api/giveaway` — the
  youtube-key and fake-event endpoints stay loopback-only, and the read-only
  pages have no auth either way. Both are env-overridable
  (`MULTICHAT_CONTROL_ACCESS`, `MULTICHAT_CONTROL_TOKEN`) so the NixOS module can
  carry the token via `LoadCredential`. See `src/control.ts`
- `twitch.channels` — list of Twitch channel names (normalized on load: case,
  a leading `#` and duplicates don't matter — `normalizeChannels`)
- `twitch.eventsub` — optional `{clientId, clientSecret, channels}` for follow/
  cheer/sub/raid **alerts** via Twitch EventSub (chat alone works without it).
  Its `clientId` + `clientSecret` alone (no channels needed; or
  `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`) also unlock the channel's own
  sub/bits **badge art** via an app token (`TwitchConfig.app`); global badges
  render from a built-in snapshot with no credentials at all
- `youtube.apiKey` — YouTube Data API v3 key (get one at Google Cloud Console)
- `youtube.channels` — list of `{handle, channelId, videoId}` objects; supply at
  least one field per entry
- `youtube.dailyQuota` / `youtube.budgetHours` — optional quota pacing (default
  10000 units/day, 4 live hours/day): the chat poll interval is stretched so a
  `budgetHours` stream fits what's left of the Pacific day's quota; past
  `budgetHours` the quota floor keeps stretching polling (YouTube's own interval
  is capped at 60s, the floor at 10 min) instead of exhausting the pool — set
  `budgetHours` to the real daily stream length for responsiveness
- `alerts` — optional `{activeTheme, themes}` registry that skins the `/alerts`
  overlay (built-in styles `default` / `company-memo`); unset = default look.
  Under `company-memo`, three kinds get stamped Company documents: subs =
  hiring paperwork (tier → job title, Tier 1/2/3 = INTERN/ASSOCIATE/EXECUTIVE;
  resub = contract renewal; gift = referrals) driven by the structured
  `ChatMessage.sub` detail (`{tier?, variant, count?}`), raids = an FBI search
  warrant (viewers as agents, police-light glow), cheers = a petty-cash
  receipt ("OFF THE BOOKS") — the latter two driven by `ChatMessage.quantity`
  (the numeric twin of `amount`)
- `giveaway` — optional Twitch-only `!enter` prize draw
  `{enabled, channel,
  prefix, command, requireFollow, replies, firstN, followerStep, milestoneDraws,
  timezone, terms, disposition, messages}`;
  `requireFollow`/`followerStep` need the channel in `twitch.eventsub`,
  `replies` needs a `user:write:chat` token (re-run `multichat login`). Campaign
  mode: `firstN` = guaranteed first-N queue (draws pick who's next),
  `followerStep`/`milestoneDraws` = advisory draw credits per N new followers,
  winners logged append-only (JSONL mailing list). `terms`
  `{required, command, version, url}` is an informational terms command — viewers
  type `!terms` and the bot replies with a link to `url`. It does NOT gate entry
  (`required`/`version` are retained for config compatibility only); `disposition`
  `{enabled, mail, donate, destroy, pass}` are
  winner-only chat words deciding a pull's fate (`pass` carries the cards to the
  next person's turn + auto-advances the draw); `timezone` (default
  `America/Denver`) is what the compiled `report` renders turn-start times in.
  Draw on `/giveaway` (a CS2-style case reel; `?overlay` = transparent OBS
  source). `terms`/`disposition` are only honoured when the block is PRESENT —
  module.nix therefore emits each one only when its `enable` is set, rather than
  writing a disabled block. The terms command needs `replies`: the response is a
  chat reply, so with replies off the command is silently inert. There is no
  `/terms` HTTP route — `terms.url` is substituted into the reply as `{terms}`
  and nothing more. See `docs/configuration.md`
- `integrations` — optional outbound event bus
  `{callbackToken, subscribers:
  [{name, adapter, baseUrl, token, events, enabled, packSize}]}`.
  Each giveaway draw fires `giveaway.turn.start` (+ disposition/end,
  terms.accepted) to the subscribers: a `webhook` adapter POSTs a generic
  `{event, ts, data}` envelope, a `chat-cards` adapter opens a pack under the
  drawn winner (`POST baseUrl/api/pack`). chat-cards reports the cards pulled +
  value back to `POST /api/turn-report` (bearer `callbackToken`; loopback-only
  when unset), feeding the `packs`/`report` views. Delivery is fire-and-forget —
  a subscriber outage never blocks or rolls back a draw. Both tokens can come
  from the environment instead of the file (`MULTICHAT_CALLBACK_TOKEN`,
  `MULTICHAT_INTEGRATION_TOKEN_<NAME>` — see `subscriberTokenEnvVar`), which is
  how the NixOS module keeps them out of the store. Note that `--allow-net` is an
  allow-list: a subscriber host must be passed to `build.nix`'s `extraNetHosts`
  (module.nix derives it from `baseUrl`) or every delivery is denied. See
  `docs/configuration.md`
- `channelPoints` — optional channel-point chaos
  `{enabled, channel, overlayUrl, overlayToken, ttlSec, autoPause, announce,
  rewards}`:
  multichat creates and owns Twitch custom rewards on `channel` (only the Client
  ID that created a reward may fulfil/refund it, so dashboard rewards can't be
  used), each redemption becomes a game effect queued on the cobblemon-overlay
  (`POST {overlayUrl}/effects`, loopback on the broadcast host; bearer
  `overlayToken` / `MULTICHAT_EFFECTS_TOKEN`), and the outcome FULFILs
  (applied/armed) or refunds (CANCELED: refused, expired, undeliverable, timed
  out) the redemption. `rewards` null = `DEFAULT_CATALOG` (14 rewards,
  corporate-villain prompts), a list replaces it; every reward has a ≥60s
  cooldown (so none is redeemable offline), no user input, never skips the
  request queue. `ttlSec` (30..3600, default 600) is the give-up deadline;
  `autoPause` pauses the rewards on Twitch once the overlay's `/effects/health`
  says the game isn't taking effects — not polling, or the mod not `ready`
  (ESC-paused, `/chaos pause`, streamer dead) — two checks in a row (≈30s), and
  resumes on the first good check (a manual pause wins); `announce` adds a
  `kind:"system"` chat row per redemption. Needs the channel in
  `twitch.eventsub.channels` with a token carrying `channel:manage:redemptions`
  — a pre-existing token needs the re-login procedure (new login + replace the
  seed + delete the persisted `twitch-refresh-<broadcasterId>`); startup warns
  loudly when the scope is missing. See `docs/configuration.md#channel-points`

YouTube channels require an API key, but it need not be in `settings.json` — it
can be set on the running server with `multichat set-youtube-key` (see above).
Twitch **chat** works anonymously (read-only via `justinfan*`); Twitch
**alerts** (follows/cheers/subs/raids) require `twitch.eventsub` — a Twitch
app + a per-channel OAuth token from `multichat login` (YouTube Super Chats/
stickers/memberships need only the API key). Full reference:
`docs/configuration.md`.

## Architecture

```
main.ts          entry point — loads settings, wires the emitter to server + clients;
                 also the `set-youtube-key` / `login` / `fake` / `giveaway` / `rewards` CLI
                 subcommands + the runtime-key manager (owns one YouTube runtime across key
                 changes: quota ledger persisted to youtube-quota.json (stale temp files swept
                 before it loads), throttled, reset when the
                 key's fingerprint changes), the Twitch badge manager (createTwitchBadgeManager:
                 a BadgeSource — snapshot-only without app creds; with them a lazily minted
                 client-credentials app token, Helix global badges refreshed daily and each
                 room's custom badges (room-id from IRC) every 6h, failures retried after 5 min,
                 all fetches time-boxed, never throws into the IRC path), the EventSub manager (per-channel token
                 lifecycle + one WebSocket per broadcaster; exposes getChannelAuth, forwards
                 onFollow; captures the token's granted scopes and hands the channel-points
                 channel its redemption subscriptions + observers, warning loudly when its
                 token lacks channel:manage:redemptions; a channel's first token refresh /
                 broadcaster-id lookup is retried with back-off instead of skipping it), and
                 the giveaway engine (follow check + chat replies + entrant pool + campaign:
                 guaranteed-queue draws, follower-milestone counter fed by onFollow, append-only
                 winners JSONL; the turn lifecycle: per-draw turns, winner-only
                 mail/donate/destroy/pass disposition, seeded draw plan; driving the /giveaway page)
                 + the integration dispatcher (fires giveaway.turn.* events to configured subscribers)
                 + the channel-points engine (createChannelPointsEngine: persisted redemption
                 ledger fed by onRedemption; a 2s pump — retry owed overlay withdrawals
                 (POST /effects/<id>/cancel {reason}, persisted `cancelOwed` until the overlay
                 answers 200/404), deliver to the overlay's POST /effects, poll GET /effects for
                 results, PATCH Twitch FULFILLED/CANCELED in ≤50-id batches (only echoed ids
                 settle; 404/400 batches fall back to single ids) with back-off; reward sync on
                 first auth + `rewards sync`, serialized with pause application on one chain and
                 applying the pause right after; reconcile of UNFULFILLED redemptions on auth,
                 every EventSub session and every 5 min; auto-pause from GET /effects/health
                 every 15s with 2-check hysteresis on accepting && ready; a loud log every 5 min
                 while the channel's token never arrived; state files written atomically (tmp +
                 fsync + rename; leftover temp files swept at init by the shared
                 sweepStaleTmp), flushed on SIGTERM/SIGINT, a corrupt one moved aside loudly;
                 all outbound calls time-boxed)
src/types.ts     shared TypeScript interfaces (Settings, ChatMessage w/ SubDetail + backlog flag,
                 Badge w/ version/info/title/url/url2x/url4x, ServerEvent, Emitter, TwitchConfig.app,
                 TwitchEventSubConfig, EventSub frames, GiveawayConfig/State/Entrant/
                 CampaignState/CampaignSummary/Winner/Draw/Turn/Disposition/Plan, TermsAcceptance,
                 TurnAggregates, IntegrationsConfig/Subscriber, PackReport, ChannelPointsConfig/
                 RewardSpec/RewardParams, RedemptionEntry/State/Outcome)
src/twitch.ts    Twitch IRC over WebSocket (wss://irc-ws.chat.twitch.tv), with reconnect;
                 handleCommand takes an optional isCovered predicate so EventSub-covered
                 channels emit only chat text (their events come from EventSub instead), and
                 an optional onMessage callback that surfaces each PRIVMSG's raw user-id/login
                 to the giveaway watcher (kept out of the rendered ChatMessage/SSE), and an
                 optional BadgeSource that decorates each badge with art by the message's
                 room-id (Shared Chat: source-badges vs source-room-id; ROOMSTATE → noteRoom);
                 parseBadges keeps version + badge-info; normalizeChannels for settings
src/badges.ts    pure badge-art helpers: BadgeArt/BadgeArtMap, resolveBadgeArt (channel exact →
                 channel nearest-lower sub in the same tier → the channel's Tier 1 art for a
                 Tier 2/3 sub → Helix global → snapshot → channel nearest-lower bits →
                 generic subscriber/founder), badgeLabel (short chip text, kept as
                 Badge.label), decorateBadge (adds url/url2x/url4x + Twitch's title as
                 Badge.title), the BadgeSource interface + SNAPSHOT_BADGES
src/twitchbadges.ts generated snapshot of Twitch's global chat badges (set/version → CDN uuid +
                 title); regenerate with tools/gen-global-badges.ts; live Helix data wins
src/eventsub.ts  Twitch EventSub over WebSocket (wss://eventsub.wss.twitch.tv) — the source
                 of truth for follow/cheer/sub/raid on configured channels; pure
                 notification→ChatMessage mappers + classifyFrame are exported/tested, the
                 socket-holding connectOnce/startTwitchEventSub are the wiring (receive-only);
                 an optional onFollow callback surfaces each follow's user_id/login to the
                 giveaway milestone counter (kept out of the rendered ChatMessage/SSE); an
                 optional onRedemption callback surfaces channel-point redemption .add/.update
                 (mapRedemption; nothing rendered), a per-channel `features` list gates the
                 redemption subscriptions, and onSessionReady fires once a session's
                 subscriptions are live (the reconcile trigger)
src/twitchauth.ts pure Twitch OAuth + EventSub request builders / response parsers
                 (refresh + auth-code grants incl. the granted `scope[]`, /users,
                 create-subscription, /channels/followers follow check + /chat/messages send,
                 custom rewards GET/POST/PATCH + redemptions GET/PATCH + parseHelixResponse,
                 client-credentials app token + Helix chat badges global/channel builders +
                 parseChatBadgesResponse, resolveAppCredentials)
                 + the SUBSCRIPTIONS table (source of truth for EventSub types/versions/scopes;
                 the redemption pair is tagged feature "channelPoints", see subscriptionsFor)
                 + LOGIN_SCOPES (EVENTSUB_SCOPES — now incl. channel:manage:redemptions — + the
                 user:write:chat action scope the login flow requests for giveaway replies)
src/youtube.ts   YouTube Data API v3 polling, quota-aware: live detection from the uploads
                 playlist + videos.list (~2 units/check every 3 min) with a rationed search.list
                 fallback (daily cap + spacing, parked until Pacific midnight on its 429);
                 classifyYtError/ytFetch (JSON error reasons → quotaDaily/searchQuota/
                 rateLimited/chatEnded/badPageToken/denied/transient; time-boxed, key
                 redacted from URLs and error text by redactKey); the per-Pacific-day quota
                 ledger + poll-interval governor (pollFloorMs holds back ≈40 units/h of
                 discovery per watched channel; governedIntervalMs caps the API's ask at
                 60s but lets the quota floor stretch to MAX_GOVERNED_POLL_MS = 10 min);
                 the chat loop ends on liveChatEnded/offlineAt/chatEndedEvent/periodic
                 videos.list check and rediscovers; a key/project rejection mid-chat is an
                 `error` on the 10-min retry that keeps the chat's page token, so a new key
                 resumes at once; discovery rides out transient failures (5s→60s back-off,
                 `error` after 3 in a row); seen-id dedupe + page tokens survive
                 re-attaches; while catching up (any attach, a pageTokenInvalid reset, an
                 unplanned gap > 5 min) items older than 5 min are flagged backlog. createYouTubeRuntime
                 (injectable clock/sleep/fetch for the scenario tests) is shared across poller
                 generations; startYouTubePoller takes an AbortSignal so it can be torn down
src/server.ts    Deno.serve HTTP server: GET / + GET /overlay + GET /alerts + GET /giveaway
                 (embedded HTML; overlay = transparent chat OBS source, alerts = animated
                 shoutout pop-ups with selectable themes, e.g. the "company-memo" redacted-memo
                 look, giveaway = CS2-style case-reel picker w/ transparent ?overlay OBS mode;
                 ?direction=up|down flips the
                 message flow on any chat-rendering page), GET /events (SSE, replays the
                 giveaway pool on connect), POST /api/youtube-key + POST /api/fake +
                 POST /api/rewards (always loopback-only, and refuses browser-originated
                 requests: any Origin / cross-site Sec-Fetch-Site → 403) +
                 POST /api/giveaway (operator control; loopback-only unless server.controlAccess
                 widens it — see checkControlAccess) + POST /api/turn-report (the inbound
                 integration callback: chat-cards pushes back pack/card summaries; bearer
                 integrations.callbackToken, else loopback-only); createServer returns
                 { emitter, broadcastGiveaway }
src/alerts.ts    pure alerts-theme helpers: normalizeAlertsConfig (validates the theme
                 registry from settings.json) + ALERT_EVENT_KINDS; the resolved config is
                 injected into the page as window.MULTICHAT_ALERTS for the overlay to apply
src/giveaway.ts  pure giveaway helpers: normalizeGiveawayConfig (incl. terms/disposition/
                 timezone sub-configs), matchGiveawayCommand, the entrant-pool reducers (add w/
                 permanent entry numbers, remove, findEntrants/removeByNeedle — resolve a
                 typed login/display-name/#number to one entrant, refusing ties —
                 draw + drawSegmented guaranteed-queue-then-pool
                 w/ an optional forcedUserId for a committed plan, open/close/reset) +
                 normalizePoolState (migrates number-less files), campaign reducers
                 (recordFollower dedupe + milestone crossing, winnerTier, campaignSummary), the
                 winners JSONL/CSV helpers, the seeded draw-plan primitives (mulberry32,
                 seededShuffle, buildDrawPlan, nextPlannedUserId, consumePlan, normalizePlan),
                 decideEligibility, and the POST /api/giveaway wire (de)serialization
src/turns.ts     pure turn-lifecycle helpers: the terms-acceptance ledger (hasAccepted/
                 recordAcceptance), matchDisposition (mail/donate/destroy/pass), the turn
                 reducers (newTurn/recordTurnDisposition/activeTurn), computeAggregates +
                 turnTotals (fold pass carry-chains via carriedFromTurnId), and the compiled
                 report builder (buildTurnReport/reportToCsv + formatInZone for the MST render)
src/integrations.ts  pure integration-bus helpers: normalizeIntegrationsConfig, the outbound
                 event→request mapping per adapter (webhook envelope / chat-cards /api/pack) +
                 subscriberWantsEvent, and the inbound pack-report parser (parseTurnReport /
                 normalizePackReports behind POST /api/turn-report), plus applyIntegrationEnv /
                 subscriberTokenEnvVar (env overrides for both tokens; the env-var naming rule
                 is mirrored in module.nix and must stay in sync). The fetch wiring is in main.ts
src/channelpoints.ts pure channel-points helpers: normalizeChannelPointsConfig /
                 normalizeRewardSpec / applyChannelPointsEnv, DEFAULT_CATALOG + TIER_COLORS +
                 KNOWN_EFFECTS, startup problems + the scope warning, the reward sync diff
                 (rewardFields / planRewardSync: match by persisted id then exact title, PATCH
                 drift, disable — never delete — retired keys), the ledger reducers keyed by
                 redemption id (admitRedemption w/ dedupe + stale/retired/disabled refunds,
                 markQueued/markAttempt/requeueEntry/resolveEntry/markSynced/markSyncFailed,
                 dueSyncBatches + judgeSyncBatch, pruneLedger, normalizeLedger), the durable
                 overlay withdrawal (resolveEntry {withdraw} / oweCancel / overlayCancelReason /
                 markCancelDone / markCancelFailed / dueCancels — never pruned while owed), the
                 overlay effect-API wire (enqueue/lookup/cancel{reason}/health builders,
                 interpretEnqueueResponse, parseEffectsLookup, effectOutcome: applied/armed →
                 fulfil, rejected/expired/canceled → refund), the auto-pause hysteresis
                 (healthGood / stepAutoPause), the announce chat row, and the POST /api/rewards
                 wire
src/control.ts   pure control-plane helpers (loopback + private-range checks, the
                 controlAccess/controlToken policy behind POST /api/giveaway, key-body parse,
                 startup-key resolution, resolveStateDir + the state paths under it incl.
                 YouTube quota ledger + Twitch token/broadcaster-id + giveaway
                 pool/campaign/winners-log/packs/turns/terms/plan + channel-points
                 ledger/rewards/control, the atomic-write temp / corrupt-file quarantine names,
                 browserRequestDenied) + the ServerHooks
                 (setYouTubeKey + giveaway + channelPoints) / GiveawayHooks (draw/turnReport/
                 packs/turns/report/plan/…) / ChannelPointsHooks / KeyUpdateResult types
src/fake.ts      pure fake-event helpers: the curated demo sequence + wire
                 (de)serialization/validation behind POST /api/fake
tests/           one *_test.ts per source module; dependency-free assert shim in _assert.ts
tools/           dev scripts (shot.ts screenshots, gen-global-badges.ts regenerates
                 src/twitchbadges.ts) — not part of the server
```

Pure helpers (`parseIRC`, `handleCommand`, `buildSegments`, `emitItem`,
`colorFor`, …) are `export`ed from the source modules so the tests can drive
them with a fake `Emitter` (`tests/_fake.ts`). The HTTP server is only started
by `createServer`, which tests never call. Deeper notes:
`docs/development/architecture.md`.

The `Emitter` is an object `{ message, delete, status }` created by
`createServer` and passed to the platform clients. Each call broadcasts a tagged
`ServerEvent` (`message` / `delete` / `status`) to all connected SSE streams via
a `Set<ReadableStreamDefaultController>`; the browser switches on `event.type`.
`createServer` also keeps a per-channel status registry (seeded from settings)
so it can push a roster snapshot to each newly connected client.

The browser renders platform-specific richness: Twitch badge images (text chips
when no art is known) and YouTube role badges,
author colors, image emotes (Twitch only — see note), `/me` actions, highlighted
event rows (cheers, subs, raids, Super Chats, Super Stickers, memberships), and
live message deletions. A left sidebar lists every watched channel with a
live/offline/connecting/error dot.

> YouTube custom emoji cannot be rendered as images: the Data API v3 returns
> `displayMessage` as plain text only (no emoji image URLs or runs), so YouTube
> emotes show as `:shortcodes:`/unicode. Image emotes are Twitch-only.

No external imports — only Deno built-ins (`Deno.serve`, `Deno.readTextFile`,
`WebSocket`, `fetch`, `ReadableStream`).

## Nix file layout

`flake.nix` is thin orchestration; the real definitions are split out (mirrors
the convention in CalamooseLabs/OpenReturn and QuorumCall):

```
flake.nix    wires the three files below into flake outputs (x86_64-linux)
build.nix    the package derivation — { pkgs }: → mkDerivation (standalone-buildable)
shell.nix    dev shell + runserver / runchecks / demoalerts / gcommit helper scripts
module.nix   the NixOS service module (portable — importable without the flake)
```

## NixOS module

`module.nix` (exposed as `nixosModules.default`). Minimal NixOS configuration:

```nix
{
  inputs.multichat.url = "github:youruser/multichat";

  outputs = { nixpkgs, multichat, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        multichat.nixosModules.default
        {
          services.multichat = {
            enable = true;
            port = 8080;
            twitch.channels = [ "streamer1" ];
            youtube.apiKeyFile = "/run/secrets/youtube-api-key";  # file containing just the raw key
            youtube.channels = [{ handle = "@channelhandle"; }];
            openFirewall = true;
          };
        }
      ];
    };
  };
}
```

The systemd service runs as a `DynamicUser` (no persistent system user needed)
with an aggressively hardened unit. For production, `apiKeyFile` points to a
file containing just the raw key, staged via systemd `LoadCredential` at service
start so it needs no world/group-read permissions (compatible with
agenix/sops-nix); `youtube.apiKey` is the convenience path (stored in the Nix
store, emits a warning). Full options + secrets + hardening table:
`docs/nixos.md`.

## Nix dev shell

```bash
nix develop        # enters the shell with deno + claude-code + helper scripts
direnv allow       # auto-activates via .envrc if direnv is installed
```

Helper scripts (defined in `shell.nix`): `runserver` (= `deno task start`),
`runchecks` (fmt-check + lint + check + test), `demoalerts [PORT]` (throwaway
`/alerts` demo server on its own port, looping the fake showcase — previews the
configured theme without touching a running server), and `gcommit`. Commits are
GPG-signed: write the message to `GIT_COMMIT_MSG`, then run `gcommit` (prints
it, prompts, runs `git commit -S -F GIT_COMMIT_MSG`). Both `GIT_COMMIT_MSG` and
`gcommit` are gitignored.

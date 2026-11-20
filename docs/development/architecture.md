# Architecture

multichat is a dependency-free Deno server. Two platform clients feed a
broadcaster, which pushes events to connected browsers over Server-Sent Events.

## Module layout

| File                   | Responsibility                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`              | Entry point — loads settings, creates the server, starts the platform clients, owns the runtime-key manager (shared YouTube runtime + quota ledger, key source + fallback, go-live hints), the Twitch badge manager, the EventSub manager, the state-file writers and the CLI subcommands |
| `src/types.ts`         | Shared interfaces: `Settings`, `ChatMessage`, `ServerEvent`, `Emitter`, `ChannelStatus`, `TwitchEventSubConfig`, EventSub frames                                                                                                                                                          |
| `src/twitch.ts`        | Twitch IRC over WebSocket (`wss://irc-ws.chat.twitch.tv`), with reconnect; suppresses events for EventSub-covered channels; decorates badges with art via a `BadgeSource`                                                                                                                 |
| `src/eventsub.ts`      | Twitch EventSub over WebSocket (`wss://eventsub.wss.twitch.tv`) — follow/cheer/sub/raid; pure mappers + socket client                                                                                                                                                                     |
| `src/twitchauth.ts`    | Pure Twitch OAuth + Helix/EventSub request builders / response parsers (incl. the app-token grant and chat-badge lists) + the `SUBSCRIPTIONS` table                                                                                                                                       |
| `src/badges.ts`        | Pure badge-art resolution (`resolveBadgeArt`, `badgeLabel`, `decorateBadge`) + `src/twitchbadges.ts`, a generated snapshot of Twitch's global badges                                                                                                                                      |
| `src/youtube.ts`       | YouTube Data API v3 polling — quota-aware live detection (uploads playlist + rationed search), chat polling paced by a per-day quota ledger                                                                                                                                               |
| `src/server.ts`        | `Deno.serve` HTTP server + the embedded viewer HTML/CSS/JS (`/`, `/overlay`, `/alerts`)                                                                                                                                                                                                   |
| `src/control.ts`       | Pure control-plane helpers (loopback check, key-body + live-hint body parse, startup-key resolution, state paths, the single-flight state writer)                                                                                                                                         |
| `src/status.ts`        | Pure `GET /api/status` shapes, their assembly, and the text `multichat status` prints; also the package `VERSION` (read by `build.nix`)                                                                                                                                                   |
| `src/fake.ts`          | Fake-event demo sequence + wire (de)serialization/validation behind `POST /api/fake`                                                                                                                                                                                                      |
| `src/alerts.ts`        | Pure `/alerts` theme-registry validation (`normalizeAlertsConfig`), injected into the page as `window.MULTICHAT_ALERTS`                                                                                                                                                                   |
| `src/channelpoints.ts` | Pure channel-points logic: config + `DEFAULT_CATALOG`, the reward sync diff, the redemption-ledger reducers, the cobblemon-overlay effect-API wire; the engine that drives them lives in `main.ts`                                                                                        |

## Data flow

```
twitch.ts   ─┐  (IRC: chat text; events unless EventSub covers the channel)
eventsub.ts ─┤  (Twitch follow/cheer/sub/raid)
             ├─► Emitter ─► ServerEvent ─► SSE (/events) ─► browser
youtube.ts  ─┘  (chat + Super Chat/sticker/membership)
```

`createServer(settings)` (in `src/server.ts`) returns an **`Emitter`** — an
object with three methods that the platform clients call:

| Method                          | Emits                                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| `message(msg)`                  | `{ type: "message", data }` — a chat message or event row        |
| `delete(ev)`                    | `{ type: "delete", … }` — remove displayed messages (moderation) |
| `status(platform, name, state)` | `{ type: "status", data }` — the channel roster                  |

Each call is serialized to a `data:` SSE frame and broadcast to every connected
client (tracked in a `Set<ReadableStreamDefaultController>`). The browser
switches on `event.type`. See [HTTP & SSE API](../api.md) for the wire format.

## Twitch client

A single WebSocket joins all configured channels anonymously (`justinfan*`,
read-only). Lines are parsed by `parseIRC`; `handleCommand` routes the
emitter-only commands (`PRIVMSG`, `USERNOTICE`, `CLEARMSG`, `CLEARCHAT`,
`ROOMSTATE`), while `PING`/`RECONNECT` are handled inline because they need the
socket. `handlePrivmsg` / `handleUsernotice` build the `ChatMessage` (badges,
emote segments, cheers, sub/raid notices). Reconnect uses exponential backoff.

Badges keep their version and `badge-info` (`parseBadges`) and are decorated
with image URLs by an optional `BadgeSource`, keyed by the message's `room-id`
(Shared Chat messages use `source-badges` against `source-room-id`). main.ts's
`createTwitchBadgeManager` is that source: without Twitch app credentials it
serves the built-in snapshot of global badges; with them it mints an app token
(client-credentials grant) and loads Helix global badges plus each room's custom
sub/bits badges as ROOMSTATE announces the room. A Tier 2/3 subscriber badge
with no art in its own tier uses the channel's Tier 1 art for the same months,
as Twitch does. `decorateBadge` keeps the short `badgeLabel` text in `label`
(the page's fallback chip) and puts Twitch's title in `title` (the image's
alt/tooltip). `resolve` is synchronous and never throws, so badge loading can't
stall or drop chat.

When a channel is configured for EventSub, `handleCommand` is passed an
`isCovered` predicate: for that channel it drops the IRC copies of
cheer/sub/raid (they come from EventSub instead) but keeps the chat text, so
nothing is emitted twice. Channels without EventSub creds are untouched.

## Twitch EventSub client

For channels in `twitch.eventsub`, `eventsub.ts` opens one **receive-only**
WebSocket per broadcaster (a session may only carry one user's token). On the
`session_welcome` it creates the follow/cheer/sub/gift/resub/raid subscriptions
via the Helix API (within the 10-second window), then maps each `notification`
to a `ChatMessage` through the same `Emitter`. It also subscribes to
`stream.online` / `stream.offline` (no scope needed), which render nothing: they
reach an `onStream` observer that `main.ts` turns into the YouTube poller's
[go-live hint](#go-live-hints). It mirrors the IRC client's idle watchdog
(driven by the session's `keepalive_timeout_seconds`) and backoff, and migrates
on `session_reconnect`. The pure mappers and `classifyFrame` live outside the
socket for testing. `main.ts`'s EventSub manager owns each channel's token: user
access tokens are refreshed reactively (single-flight) using the rotating
refresh token, which is persisted (rotated-token-first, atomically) to the state
directory. The configured seed stays the fallback: a persisted file that is
empty or unreadable starts from the seed (`chooseRefreshToken`), and an
`Invalid refresh token` answer is retried once with a different seed
(`shouldRetryWithSeed`). `twitchauth.ts` holds the pure request builders /
response parsers. EventSub does not touch the sidebar status (IRC owns the
Twitch dot); its token, session and subscription state are reported by
`GET /api/status` instead (`applySessionEvent` folds the socket's `onSession`
events into it).

## YouTube client

One independent poll loop per channel, all sharing one `YouTubeRuntime` (quota
ledger + per-channel caches) that outlives key changes. Discovery checks the
channel's uploads playlist + `videos.list` every 3 minutes (about 2 units);
`search.list` is only a rationed fallback because its bucket is 100 calls a day.
Once a live video with an `activeLiveChatId` is found, the loop polls
`liveChat/messages` at the larger of the API's suggested interval (capped at
60s) and the quota governor's floor (which may stretch it up to 10 minutes).
`emitItem` maps each `snippet.type` to a `ChatMessage` (text, Super Chat, Super
Sticker, membership) or a delete. The chat loop ends — and discovery resumes 30
seconds later, to catch a restarted stream — on
`liveChatEnded`/`liveChatNotFound`, a confirmed `offlineAt`, a `chatEndedEvent`,
or the periodic `videos.list` check. Page tokens and a seen-id set survive
re-attaches, so a re-attach neither replays nor duplicates chat. While catching
up — any attach, a page-token reset, or an unplanned gap of more than 5 minutes
— items older than 5 minutes are flagged `backlog`. A key or project rejection
mid-chat shows `error` and keeps the chat's page token, so a new key resumes it
at once. See [Reliability & limits](#reliability--limits) for the quota
handling.

### Go-live hints

`liveHint(rt, "live" | "offline")` is how something that already knows the
stream started or stopped — `POST /api/live`, `multichat live on|off`, Twitch's
`stream.online` — nudges the poller. It is synchronous and only ever changes
_when_ the loops look:

- `live` starts a **boost**: it stamps `boostAt` in the quota ledger (counted
  against `BOOST_DAILY_CAP`, so the cap and a running boost survive a restart)
  and wakes every offline discovery sleep. While `boostActive`, the plain
  offline wait is `BOOST_TICK_MS` instead of the 3 minute tick, and
  `searchGateOpen` lets one search through early (`earlySearchDue`:
  `BOOST_SEARCH_DELAY_MS` into the boost, skipping only the spacing — never the
  block, the exhausted pool or the 40-a-day cap). The ledger records that search
  as `earlySearchAt`, not `lastSearchAt`: it counts toward the cap, but the
  spacing keeps running from the last regular search, so an early search that
  was too early does not restart it. The gate is shared, so with several
  channels the early search goes to whichever ticks first.
- A hint flagged `resync` — `parseLiveSignalBody` sets it for a webhook event
  that is read by its `data.streaming` rather than being `stream.started` /
  `stream.stopped` — reports the state instead of a change. `rt.hint.state`
  remembers what the last hint said; a `live` re-sync that repeats it starts no
  boost, so a sender's once-a-minute "still streaming" cannot chain boosts until
  the day's allowance is gone.
- `offline` marks the attached chats in `rt.verifyNow` and wakes the chat
  sleeps; each chat runs its ordinary `videos.list` verification at once and
  then sleeps the rest of its interval, so the chat itself is never polled
  early. A hint that lands while a poll or a verification is in flight is picked
  up before the chat goes to sleep.

The wake is `hintableSleep`: each sleeper registers one callback in
`rt.discoveryWakers` / `rt.chatWakers` and removes it (and its abort listener)
on waking. Only the plain offline wait and the chat interval are hintable — the
quota park, the denied-key retry and the transient back-offs keep their own
pace, which is what makes "a hint never bypasses a park" structural rather than
a check. The pollers also keep a per-channel `ChannelReport` (state, the reason
of the last transition, the attached video, the park) that
`youtubeRuntimeStatus` exposes to `GET /api/status`.

A failure Google attributes to the key itself is flagged `keyRefused`
(`classifyYtError`) and reported through the runtime's `onKeyRefused`; the key
manager in `main.ts` uses it to fall back from a refused runtime key to the
declared one (`resolveStartupKeySource` keeps both). The quota ledger counts per
key: `adoptKey` shelves the numbers of the key being left (`shelved`, one deep,
persisted with the rest) and takes them up again when that key returns the same
Pacific day — otherwise a stale runtime key, tried first and refused at every
start, would reset the working key's day (search count, parks, boosts) with each
restart.

## Design notes

- **Dependency-free.** Only Deno built-ins (`Deno.serve`, `WebSocket`, `fetch`,
  `ReadableStream`). The one external runtime fetch is Twitch's emote-image CDN,
  loaded by the browser.
- **Codepoint emote indexing.** Twitch emote positions index Unicode codepoints,
  not UTF-16 units, so `buildSegments` walks `[...text]` to keep emoji from
  shifting offsets.
- **Status registry.** The server seeds a per-channel status map from settings
  and pushes a snapshot to each newly connected client, so the panel is correct
  immediately on load.
- **Author colors.** Derived once, server-side (`colorFor`), so a name maps to a
  stable color across both platforms.
- **Fake events reuse the real path.** The loopback-only `POST /api/fake`
  endpoint (driven by `multichat fake`) dispatches parsed events through the
  same `Emitter` instance the platform clients use, so a previewed message is
  identical downstream to a real one. `src/fake.ts` holds the curated demo
  sequence and re-validates the wire body before it reaches the emitter — the
  same "logic in `src/`, wiring elsewhere" split as `src/control.ts`.

## Reliability & limits

Tuned for unattended multi-hour streams:

- **Idle watchdog (Twitch).** A NAT/proxy can silently drop a long-lived TCP
  connection without a close frame, leaving the socket "open" but permanently
  silent. The read loop tracks the time of the last received byte and
  force-closes after 90s of silence (Twitch sends a server PING at least every
  ~5 min), which triggers the reconnect loop. This is the main thing that keeps
  chat alive across long sessions.
- **Reconnect backoff.** Exponential (2→30s). It resets after a connection that
  stayed up over a minute, so a mid-stream blip reconnects quickly instead of
  waiting the maxed-out delay.
- **Bounded parser buffer.** The IRC line buffer is discarded if it exceeds 64
  KB without a newline, so a misbehaving peer can't grow memory.
- **YouTube quota handling.** `classifyYtError` reads the JSON error reason: a
  spent daily pool (`quotaExceeded`) parks the channel until midnight Pacific, a
  spent search bucket (`429 … Search Queries per day`) only stops searching
  until then, "polled too fast" (`rateLimitExceeded`) waits briefly on the same
  page token, and transient failures back off 5s→60s, for chat polls and
  discovery checks alike (`error` only after 3 in a row). A per-Pacific-day
  ledger (persisted as `youtube-quota.json`) estimates spend and stretches the
  chat poll interval — holding back ≈40 units/h of discovery per watched
  channel, and slowing to as much as 10 minutes between polls past the budget
  rather than exhausting the pool — so a `youtube.budgetHours` stream fits
  `youtube.dailyQuota`. Every request is time-boxed (15s) and the key is
  redacted from logs, including network-error text that quotes the request URL.
  See
  [Configuration → Quota and long streams](../configuration.md#quota-and-long-streams).
- **State that survives a power cut.** Every state file goes through
  `persistStateAtomic` (temp file + fsync + rename, then an fsync of the
  directory so the rename itself is on disk), and the files that change often —
  the giveaway's pool, campaign, packs, turns and plan, the channel-points
  ledger, reward map and pause — through `createStateWriter`, a single-flight
  writer that folds overlapping changes into one follow-up write and is flushed
  on SIGTERM/SIGINT. On load, a file that is not the expected JSON shape
  (`decodeStateFile` + a shape check such as `GIVEAWAY_FILE_SHAPE`), or that
  exists but cannot be read, is moved aside to `<name>.corrupt-<timestamp>` and
  reported, never read as "empty" and overwritten; a writer that was never
  called writes nothing on flush, so the empty state doesn't replace the file
  either.
- **SSE client cap.** `/events` is capped at 50 concurrent connections (returns
  `503` beyond that) so an exposed port can't be flooded with open streams.
- **Bounded browser memory.** The viewer keeps at most 500 messages, removing
  the oldest, so a long stream doesn't grow the DOM without limit. Which end
  holds the oldest row depends on `?direction`, so the trim and the insertion
  point are decided by the same flag — trimming the wrong end would drop the row
  just added and silently freeze the feed at the cap.
- **Scoped permissions.** The process runs with `--allow-net` limited to
  `irc-ws.chat.twitch.tv`, `eventsub.wss.twitch.tv`, `api.twitch.tv`,
  `id.twitch.tv`, `www.googleapis.com`, and the local bind addresses, plus a
  scoped `--allow-env`. Emote images load in the browser, not the server, so the
  CDN isn't in the server's net allowlist. (A Twitch `session_reconnect` URL is
  expected to stay under `eventsub.wss.twitch.tv`; a different host would be
  blocked by the allowlist, after which the backoff loop reconnects fresh.)

## Nix file layout

| File         | Role                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| `flake.nix`  | Thin orchestration — wires the three files below into flake outputs             |
| `build.nix`  | The package derivation (standalone-buildable)                                   |
| `shell.nix`  | Dev shell + `runserver` / `runchecks` / `demoalerts` / `gcommit` helper scripts |
| `module.nix` | The NixOS service module (portable; importable without the flake)               |

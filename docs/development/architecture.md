# Architecture

multichat is a dependency-free Deno server. Two platform clients feed a
broadcaster, which pushes events to connected browsers over Server-Sent Events.

## Module layout

| File             | Responsibility                                                                          |
| ---------------- | --------------------------------------------------------------------------------------- |
| `main.ts`        | Entry point — loads settings, creates the server, starts the platform clients           |
| `src/types.ts`   | Shared interfaces: `Settings`, `ChatMessage`, `ServerEvent`, `Emitter`, `ChannelStatus` |
| `src/twitch.ts`  | Twitch IRC over WebSocket (`wss://irc-ws.chat.twitch.tv`), with reconnect               |
| `src/youtube.ts` | YouTube Data API v3 polling — resolves channel → live video → live chat                 |
| `src/server.ts`  | `Deno.serve` HTTP server + the embedded viewer HTML/CSS/JS                              |
| `src/control.ts` | Pure control-plane helpers (loopback check, key-body parse, startup-key resolution)     |
| `src/fake.ts`    | Fake-event demo sequence + wire (de)serialization/validation behind `POST /api/fake`    |

## Data flow

```
twitch.ts ─┐
           ├─► Emitter ─► ServerEvent ─► SSE (/events) ─► browser
youtube.ts ┘
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

## YouTube client

One independent poll loop per channel. Each resolves handle/channelId → current
live video → active live-chat id, then long-polls `liveChat/messages` at the
interval the API suggests. `emitItem` maps each `snippet.type` to a
`ChatMessage` (text, Super Chat, Super Sticker, membership) or a delete. The
resolved channel id is cached so it isn't looked up again; an offline channel is
rechecked every 5 minutes (the live-stream lookup is the expensive 100-unit
call). See [Reliability & limits](#reliability--limits) for the quota handling.

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
- **YouTube quota handling.** `quotaExceeded`/rate-limit 403s raise a
  `QuotaError` and back off 15 minutes; other transient errors back off
  exponentially (15s→2m). Resolved channel ids are cached and offline channels
  rechecked sparingly to conserve the 100-unit `search.list`. See
  [Configuration → Quota and long streams](../configuration.md#quota-and-long-streams).
- **SSE client cap.** `/events` is capped at 50 concurrent connections (returns
  `503` beyond that) so an exposed port can't be flooded with open streams.
- **Bounded browser memory.** The viewer keeps at most 500 messages, removing
  the oldest, so a long stream doesn't grow the DOM without limit.
- **Scoped permissions.** The process runs with `--allow-net` limited to
  `irc-ws.chat.twitch.tv`, `www.googleapis.com`, and the local bind addresses,
  plus a scoped `--allow-env`. Emote images load in the browser, not the server,
  so the CDN isn't in the server's net allowlist.

## Nix file layout

| File         | Role                                                                |
| ------------ | ------------------------------------------------------------------- |
| `flake.nix`  | Thin orchestration — wires the three files below into flake outputs |
| `build.nix`  | The package derivation (standalone-buildable)                       |
| `shell.nix`  | Dev shell + `runserver` / `runchecks` / `gcommit` helper scripts    |
| `module.nix` | The NixOS service module (portable; importable without the flake)   |

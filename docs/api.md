# HTTP & SSE API

multichat serves a single page and a Server-Sent Events stream. The viewer
surface is read-only and unauthenticated — meant to run on a trusted network —
plus loopback-only control endpoints: setting the YouTube API key, injecting
fake events for previewing how they render, and driving the giveaway.

## Endpoints

| Method | Path                    | Response            | Description                                                                            |
| ------ | ----------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `GET`  | `/` (and `/index.html`) | `text/html`         | The viewer page (HTML/CSS/JS embedded in the binary)                                   |
| `GET`  | `/overlay`              | `text/html`         | Same page in OBS overlay mode (see below)                                              |
| `GET`  | `/alerts`               | `text/html`         | Same page in OBS alerts mode — animated shoutout pop-ups (see below)                   |
| `GET`  | `/giveaway`             | `text/html`         | Giveaway picker — CS2-style case reel; `?overlay` = transparent OBS source (see below) |
| `GET`  | `/events`               | `text/event-stream` | The live SSE feed of chat events                                                       |
| `POST` | `/api/youtube-key`      | `text/plain`        | Set the YouTube API key (loopback-only — see below)                                    |
| `POST` | `/api/fake`             | `text/plain`        | Inject a fake chat event for previewing (loopback-only — see below)                    |
| `POST` | `/api/giveaway`         | `application/json`  | Drive the giveaway: open/close/draw/reset/remove (loopback-only)                       |
| any    | anything else           | `404`               | Not found                                                                              |

The viewer page also takes `?overlay` and `?alerts` query params (`/?overlay` is
equivalent to `/overlay`, `/?alerts` to `/alerts`), plus `?direction=up|down`
(message flow — honored on `/` as well as on `/overlay`) and `?theme=NAME`
(alerts mode only), documented with their modes below.

## Overlay mode (`/overlay`)

A stripped-down rendering of the same feed for use as an **OBS browser source**:
transparent background (no chroma key needed), no header or channel sidebar,
just the messages — new ones appear at the bottom and older ones slide up and
clip off the top (with a soft fade at the edge they exit through). Each row also
pops in, and highlighted event rows glow their accent color. The platform badge
still tags each message's source. Point an OBS Browser source at
`http://<host>:<port>/overlay` and size it to your scene; everything else (SSE
feed, message shapes) is identical to the normal viewer.

The feed grows downward by default; a `?direction=up|down` query param picks the
direction for that source (`/overlay?direction=up`). With `up`, new messages
appear at the **top** and older ones are pushed down and clip off the bottom —
the fade, the row spacing and the pop-in all mirror to match. `down` is the
default, and any other value falls back to it. The same param also works on the
scrollable viewer (`/?direction=up`), where the newest message sits at the top
and the "Latest" jump button points there instead.

## Alerts mode (`/alerts`)

A dedicated **shoutout** browser source: also transparent, but instead of the
chat stream it plays one big animated card at a time, centered, for the
highlight events — follows, cheers/bits, subs, gift subs, resubs, raids (Twitch,
via EventSub) and Super Chats, Super Stickers, memberships (YouTube). Cards are
queued and auto-dismiss (~6s each) so a burst never overlaps; plain chat and
system notices are ignored. It reads the same `/events` SSE feed, so
[`multichat fake`](development/testing.md) previews it too. Point a second OBS
Browser source at `http://<host>:<port>/alerts`. Configuring the events requires
[Twitch EventSub](configuration.md#twitch-eventsub-alerts).

The alerts overlay renders the configured **alert theme** (from
`settings.json`'s `alerts` block, see
[Alert themes](configuration.md#alert-themes)); a `?theme=NAME` query param
overrides the active theme for that source
(`/alerts?theme=The%20Company,%20Inc`).

## Giveaway mode (`/giveaway`)

The picker for the Twitch-only `!enter` giveaway. The reveal is a **CS2-style
case reel**: entrant cards scroll past and ease to a stop with the winner
centered under a ticker. It reads the same `/events` SSE feed (acting only on
the `giveaway` frame — the public pages ignore it) and drives the loopback
`POST /api/giveaway` control endpoint from its buttons.

Two views of the same page, chosen by a query param:

- **Control view** (`/giveaway`) — dark background, the reel, the operator
  buttons (Draw winner / Open / Close / Reset / Demo) and the entrant list.
  Because the control endpoint is loopback-only, open this on the **same
  machine** as the server. `multichat giveaway` is the CLI equivalent of the
  buttons.
- **Overlay** (`/giveaway?overlay`) — **transparent** background, no controls,
  just the reel; it stays blank between draws and auto-hides a few seconds after
  the winner lands. Point an OBS browser source at it. It plays the reel
  whenever a draw happens (triggered from the control view or the CLI), so your
  audience sees the reveal without you sharing the operator screen.

The draw is **server-authoritative**: the server picks the winner and removes
them from the pool, then broadcasts the winner plus the entrant list to animate
over — so every open page (control view and overlay) plays the _same_ reel and
lands on the _same_ winner, and a reload can't re-draw. See
[Giveaway mode](configuration.md#giveaway-mode) for setup.

To try it without a live stream, click **Demo** (or run
`multichat giveaway
demo`) to inject sample entrants, then draw. `Reset` clears
them.

`/events` returns `503` once 50 concurrent streams are open (a flood guard,
since the viewer is unauthenticated). The browser's `EventSource` retries
automatically.

## `POST /api/youtube-key`

Sets the YouTube Data API v3 key on the running server, which (re)starts YouTube
polling for the configured channels. Normally invoked through the CLI
(`multichat set-youtube-key`, see [Configuration](configuration.md)) rather than
called directly.

- **Loopback-only.** Requests whose peer is not `127.0.0.1` / `::1` (or a
  unix-domain socket) get `403`. The viewer is unauthenticated and may bind
  `0.0.0.0`, so this guard keeps the rest of the network from setting the key.
- **Body.** Either the raw key as `text/plain`, or JSON `{ "key": "AIza…" }`
  (`Content-Type: application/json`). The value is trimmed.

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `200`  | Key accepted; body describes how many channels are now polling |
| `400`  | Body was empty or could not be parsed into a key               |
| `403`  | Request did not originate from loopback                        |
| `405`  | Method was not `POST`                                          |
| `501`  | The server was started without runtime-key control enabled     |

## `POST /api/fake`

Injects a single fabricated event straight into the SSE feed, so you can preview
how each message kind renders without a live stream. The event goes through the
exact same `Emitter` path as a real message (author-color fill, status registry,
broadcast) — it is indistinguishable downstream. Normally driven by the CLI
(`multichat fake`, see
[Testing](development/testing.md#previewing-message-rendering-with-fake)) rather
than called directly.

- **Loopback-only.** Same guard as `/api/youtube-key` — a non-loopback peer gets
  `403`. The viewer is unauthenticated and may bind `0.0.0.0`, so this keeps the
  rest of the network from pushing events to every viewer.
- **Body.** A JSON object `{ "action": …, "data": … }`, one of:
  - `{"action":"message","data":{/* ChatMessage — platform, channel, author required */}}`
  - `{"action":"delete","data":{"platform":…,"channel":…,"messageId"?:…,"author"?:…}}`
  - `{"action":"status","data":{"platform":…,"name":…,"state":…}}`

| Status | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| `200`  | Injected; body is a one-line summary of what was broadcast |
| `400`  | Body was not valid JSON, or a field was missing/invalid    |
| `403`  | Request did not originate from loopback                    |
| `405`  | Method was not `POST`                                      |

## `POST /api/giveaway`

Drives the giveaway on the running server. Backs the `/giveaway` page's buttons
and the `multichat giveaway` CLI verb; only present when a giveaway is enabled
in settings.

- **Loopback-only.** Same guard as the endpoints above — a non-loopback peer
  gets `403`.
- **Body.** A JSON object `{ "action": … }`, one of `open`, `close`, `draw`,
  `reset`, `status`, `demo` (inject sample entrants to preview the reel), or
  `{"action":"remove","userId":"<id>"}`.
- **Response.** JSON `{ "state": GiveawayState }` (or `501` if no giveaway is
  configured). `draw` also carries the picked entrant as `winner` (or `null`
  when the pool is empty). `GiveawayState` is
  `{ open, entrants: [{userId, login,
  displayName, enteredAt}], lastWinner? }`.

Mutating actions broadcast the new pool to every connected page as a `giveaway`
SSE frame. Entries themselves are **not** an action here — they come from
viewers typing the command in chat (see
[Giveaway mode](configuration.md#giveaway-mode)).

| Status | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| `200`  | Applied; JSON body carries the resulting state (+ winner)  |
| `400`  | Body was not valid JSON, or the action was unknown/invalid |
| `403`  | Request did not originate from loopback                    |
| `405`  | Method was not `POST`                                      |
| `501`  | No giveaway is enabled in settings                         |

## The SSE stream

`/events` is a Server-Sent Events stream. On connect, the server sends a
`: connected` comment and an immediate `status` snapshot so the channel panel
populates right away, then a `: ping` comment every 25s to keep proxies from
closing the connection.

Each `data:` frame is a JSON `ServerEvent`, discriminated by `type`. The browser
switches on it.

### `message`

A chat message or highlighted event.

```json
{ "type": "message", "data": {/* ChatMessage, see below */} }
```

### `delete`

Remove already-displayed messages (moderation). Exactly one targeting field is
set.

```json
{
  "type": "delete",
  "platform": "twitch",
  "channel": "somechan",
  "messageId": "abc"
}
```

| Field                     | Meaning                                           |
| ------------------------- | ------------------------------------------------- |
| `messageId`               | Remove the one message with this id               |
| `author` (no `messageId`) | Remove all of this author's messages in `channel` |
| neither                   | Clear all messages in `channel`                   |

### `status`

The full channel roster (sent on connect and whenever any channel's state
changes).

```json
{
  "type": "status",
  "data": [{ "platform": "twitch", "name": "somechan", "state": "live" }]
}
```

`state` is one of `connecting`, `live`, `offline`, `error`.

### `giveaway`

The current giveaway pool (sent to the `/giveaway` page on connect and whenever
it changes). Only emitted when a giveaway is enabled; other pages ignore it.

```json
{
  "type": "giveaway",
  "data": {
    "open": true,
    "entrants": [
      { "userId": "1001", "login": "ann", "displayName": "Ann", "enteredAt": 0 }
    ]
  }
}
```

On a **draw**, the frame additionally carries a `draw` object — the just-picked
`winner` plus `reel` (the pre-removal entrant list) — so every page plays the
case reel and lands on the same winner. `data` is the post-removal pool; the
snapshot replayed on connect never includes `draw`, so a fresh page doesn't
replay an old animation.

```json
{
  "type": "giveaway",
  "data": { "open": false, "entrants": [/* winner removed */] },
  "draw": {
    "winner": {
      "userId": "1001",
      "login": "ann",
      "displayName": "Ann",
      "enteredAt": 0
    },
    "reel": [/* the entrants as they were, for the animation */]
  }
}
```

## `ChatMessage` shape

Defined in [`src/types.ts`](../src/types.ts). All fields beyond the first block
are optional.

| Field         | Type                    | Description                                                                                                       |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`          | string                  | Stable message id (used for deletions)                                                                            |
| `platform`    | `"twitch" \| "youtube"` | Source platform                                                                                                   |
| `channel`     | string                  | Channel name / label                                                                                              |
| `author`      | string                  | Display name                                                                                                      |
| `content`     | string                  | Plain-text body (fallback when `segments` is absent)                                                              |
| `timestamp`   | number                  | Epoch milliseconds                                                                                                |
| `authorColor` | string?                 | CSS color; derived from the name if the platform gives none                                                       |
| `segments`    | Segment[]?              | Tokenized body: `{type:"text",text}` or `{type:"emote",url,alt}`                                                  |
| `badges`      | Badge[]?                | Role chips: `{id,label}`                                                                                          |
| `kind`        | MessageKind?            | `chat` (default), `action`, `cheer`, `sub`, `raid`, `follow`, `superchat`, `supersticker`, `membership`, `system` |
| `amount`      | string?                 | e.g. `"500 bits"`, `"$5.00"`                                                                                      |
| `accentColor` | string?                 | Highlight color for event rows / tiers                                                                            |
| `eventText`   | string?                 | Notice line for event rows, e.g. "X subscribed for 3 months"                                                      |

See [Chat Features](features.md) for how these fields are rendered.

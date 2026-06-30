# HTTP & SSE API

multichat serves a single page and a Server-Sent Events stream. The viewer
surface is read-only and unauthenticated — meant to run on a trusted network —
plus one loopback-only control endpoint for setting the YouTube API key.

## Endpoints

| Method | Path                    | Response            | Description                                          |
| ------ | ----------------------- | ------------------- | ---------------------------------------------------- |
| `GET`  | `/` (and `/index.html`) | `text/html`         | The viewer page (HTML/CSS/JS embedded in the binary) |
| `GET`  | `/events`               | `text/event-stream` | The live SSE feed of chat events                     |
| `POST` | `/api/youtube-key`      | `text/plain`        | Set the YouTube API key (loopback-only — see below)  |
| any    | anything else           | `404`               | Not found                                            |

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

## `ChatMessage` shape

Defined in [`src/types.ts`](../src/types.ts). All fields beyond the first block
are optional.

| Field         | Type                    | Description                                                                                             |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`          | string                  | Stable message id (used for deletions)                                                                  |
| `platform`    | `"twitch" \| "youtube"` | Source platform                                                                                         |
| `channel`     | string                  | Channel name / label                                                                                    |
| `author`      | string                  | Display name                                                                                            |
| `content`     | string                  | Plain-text body (fallback when `segments` is absent)                                                    |
| `timestamp`   | number                  | Epoch milliseconds                                                                                      |
| `authorColor` | string?                 | CSS color; derived from the name if the platform gives none                                             |
| `segments`    | Segment[]?              | Tokenized body: `{type:"text",text}` or `{type:"emote",url,alt}`                                        |
| `badges`      | Badge[]?                | Role chips: `{id,label}`                                                                                |
| `kind`        | MessageKind?            | `chat` (default), `action`, `cheer`, `sub`, `raid`, `superchat`, `supersticker`, `membership`, `system` |
| `amount`      | string?                 | e.g. `"500 bits"`, `"$5.00"`                                                                            |
| `accentColor` | string?                 | Highlight color for event rows / tiers                                                                  |
| `eventText`   | string?                 | Notice line for event rows, e.g. "X subscribed for 3 months"                                            |

See [Chat Features](features.md) for how these fields are rendered.

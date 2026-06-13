# HTTP & SSE API

multichat serves a single page and a Server-Sent Events stream. There is no REST
surface and no authentication — it is a read-only viewer meant to run on a
trusted network.

## Endpoints

| Method | Path                    | Response            | Description                                          |
| ------ | ----------------------- | ------------------- | ---------------------------------------------------- |
| `GET`  | `/` (and `/index.html`) | `text/html`         | The viewer page (HTML/CSS/JS embedded in the binary) |
| `GET`  | `/events`               | `text/event-stream` | The live SSE feed of chat events                     |
| any    | anything else           | `404`               | Not found                                            |

`/events` returns `503` once 50 concurrent streams are open (a flood guard,
since the viewer is unauthenticated). The browser's `EventSource` retries
automatically.

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

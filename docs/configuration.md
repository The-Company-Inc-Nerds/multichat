# Configuration

multichat reads a JSON config file — `./settings.json` by default, or a path
passed as the first CLI argument. Copy `settings.json.example` to
`settings.json` and edit it.

```json
{
  "server": {
    "port": 8080,
    "host": "127.0.0.1"
  },
  "twitch": {
    "channels": ["streamer1", "streamer2"]
  },
  "youtube": {
    "apiKey": "AIzaSy...",
    "channels": [
      { "handle": "@channelhandle" },
      { "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxxx" },
      { "videoId": "xxxxxxxxxxx" }
    ]
  }
}
```

## `server`

| Field  | Type   | Default     | Description                                                           |
| ------ | ------ | ----------- | --------------------------------------------------------------------- |
| `port` | number | `8080`      | Port the web UI is served on                                          |
| `host` | string | `127.0.0.1` | Bind address. Defaults to localhost (right for an OBS browser source) |

> **Exposing to other machines.** To serve on the LAN, set `host` to `0.0.0.0`.
> The bind address must also be allowed in Deno's `--allow-net` flag —
> `127.0.0.1` and `0.0.0.0` are already included in the `deno task` /
> packaged-binary flags, so the default and `0.0.0.0` both work; a specific LAN
> IP would need adding there. There is no authentication, so only expose it on a
> trusted network, and note the server caps concurrent viewers at 50.

## `twitch`

| Field      | Type     | Description                                                                        |
| ---------- | -------- | ---------------------------------------------------------------------------------- |
| `channels` | string[] | Lowercase Twitch channel names. Anonymous read-only access — no credentials needed |

## `youtube`

| Field      | Type     | Description                                                                      |
| ---------- | -------- | -------------------------------------------------------------------------------- |
| `apiKey`   | string   | YouTube Data API v3 key (see below). Required if any YouTube channels are listed |
| `channels` | object[] | One entry per channel; set at least one of the fields below                      |

Each `youtube.channels` entry:

| Field       | Description                                                                               |
| ----------- | ----------------------------------------------------------------------------------------- |
| `handle`    | The `@username` shown on the channel page                                                 |
| `channelId` | The `UC…` ID from the channel URL                                                         |
| `videoId`   | A specific video ID — skips the live-stream lookup and goes straight to that video's chat |

Twitch works anonymously. YouTube requires an API key and resolves each channel
to its current live stream, so a channel only produces messages while it is
actually live.

## Environment variable overrides

These override their `settings.json` counterparts at startup:

| Variable          | Overrides        |
| ----------------- | ---------------- |
| `PORT`            | `server.port`    |
| `HOST`            | `server.host`    |
| `YOUTUBE_API_KEY` | `youtube.apiKey` |

## Getting a YouTube API key

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one).
3. Enable the **YouTube Data API v3** under _APIs & Services → Library_.
4. Create an API key under _APIs & Services → Credentials_.
5. Optionally restrict the key to the YouTube Data API v3.

The free quota (10,000 units/day) is sufficient for casual use. Each chat poll
costs 5 units.

### Quota and long streams

The default quota is small relative to a multi-hour stream. At the API's typical
~5s poll interval a single live chat burns ~3,600 units/hour, and the
live-stream lookup (`search.list`, used to find a channel's current broadcast)
costs **100 units per check** — so quota can run out partway through a long
stream, after which YouTube chat stops until the quota resets (midnight
Pacific). multichat reduces the burn by:

- caching the resolved channel id (no repeat lookup),
- rechecking offline channels only every 5 minutes (not every minute),
- detecting `quotaExceeded` and backing off 15 minutes instead of hammering the
  API.

For all-day streams, either pin a specific `videoId` (skips the 100-unit
`search.list` entirely), use a dedicated API key per channel, or
[request a quota increase](https://support.google.com/youtube/contact/yt_api_form).
A channel whose quota is exhausted shows the `error` state in the sidebar.

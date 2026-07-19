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
    "channels": ["streamer1", "streamer2"],
    "eventsub": {
      "clientId": "your-twitch-app-client-id",
      "clientSecret": "your-twitch-app-client-secret",
      "channels": [
        { "login": "streamer1", "refreshToken": "the-refresh-token" }
      ]
    }
  },
  "youtube": {
    "apiKey": "AIzaSy...",
    "channels": [
      { "handle": "@channelhandle" },
      { "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxxx" },
      { "videoId": "xxxxxxxxxxx" }
    ]
  },
  "alerts": {
    "activeTheme": "The Company, Inc",
    "themes": [
      {
        "name": "The Company, Inc",
        "style": "company-memo",
        "events": ["follow"]
      }
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

| Field      | Type     | Description                                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `channels` | string[] | Lowercase Twitch channel names to read chat from. Anonymous read-only access — no credentials needed   |
| `eventsub` | object   | Optional. Enables follow/cheer/sub/raid **alerts** via Twitch EventSub (see below). Omit for chat-only |

Chat (`twitch.channels`) works anonymously with no credentials. Shoutout
**alerts** (follows, cheers/bits, subs, gifts, resubs, raids) need
`twitch.eventsub`, because those events are not available on the anonymous IRC
connection.

### `twitch.eventsub`

EventSub is Twitch's authenticated event API. When a channel is configured here,
its follow/cheer/sub/raid events come from EventSub, and the anonymous IRC
connection carries only that channel's chat text (so nothing is emitted twice).
Channels listed only in `twitch.channels` keep full anonymous behavior.

| Field          | Type     | Description                                                      |
| -------------- | -------- | ---------------------------------------------------------------- |
| `clientId`     | string   | Your Twitch application's Client ID                              |
| `clientSecret` | string   | Your Twitch application's Client Secret (used to refresh tokens) |
| `channels`     | object[] | One entry per channel to monitor for alerts                      |

Each `twitch.eventsub.channels` entry:

| Field           | Description                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- |
| `login`         | The channel's login name (same as in `twitch.channels`). Used to match chat + resolve the id |
| `refreshToken`  | The broadcaster's OAuth refresh token (from `multichat login`, see below)                    |
| `broadcasterId` | Optional. The numeric user id — supply it to skip the one-time login→id lookup               |

See [Twitch EventSub alerts](#twitch-eventsub-alerts) below for the full setup.

## `youtube`

| Field      | Type     | Description                                                                                    |
| ---------- | -------- | ---------------------------------------------------------------------------------------------- |
| `apiKey`   | string   | YouTube Data API v3 key (see below). Optional — may instead be supplied at runtime (see below) |
| `channels` | object[] | One entry per channel; set at least one of the fields below                                    |

Each `youtube.channels` entry:

| Field       | Description                                                                               |
| ----------- | ----------------------------------------------------------------------------------------- |
| `handle`    | The `@username` shown on the channel page                                                 |
| `channelId` | The `UC…` ID from the channel URL                                                         |
| `videoId`   | A specific video ID — skips the live-stream lookup and goes straight to that video's chat |

Twitch works anonymously. YouTube requires an API key and resolves each channel
to its current live stream, so a channel only produces messages while it is
actually live.

## Setting the YouTube API key at runtime

The API key does not have to be baked into the config. If `youtube.channels` is
set but no key is available at startup, the server runs (Twitch chat works
immediately) and waits — then you hand it a key on the running server:

```bash
# pass the key on stdin (keeps it out of the process list and shell history)
echo -n "$YT_KEY" | multichat set-youtube-key

# or as an argument
multichat set-youtube-key AIzaSy...

# non-default port / host
echo -n "$YT_KEY" | multichat set-youtube-key --port 8080
```

The command POSTs the key to the running server's control endpoint
(`POST /api/youtube-key`, see [HTTP & SSE API](api.md)). That endpoint is
**loopback-only** — it refuses any connection that is not from
`127.0.0.1`/`::1`, so it is safe even when the viewer binds `0.0.0.0`. Setting
the key (re)starts YouTube polling immediately; sending a new key rotates it
without a restart.

**Persistence.** When the server has a writable state directory it stores the
key there (mode `0600`) and reloads it on the next start, so you only set it
once. Under the NixOS module this is systemd's `StateDirectory`
(`/var/lib/multichat`, exported as `$STATE_DIRECTORY`); with a plain
`deno task start` and no `STATE_DIRECTORY` the key is held in memory only and
must be re-sent after a restart. See [NixOS Module](nixos.md).

The startup key is chosen in this order: the persisted runtime key, then
`$YOUTUBE_API_KEY`, then `youtube.apiKey` from `settings.json`.

## Twitch EventSub alerts

Follows, cheers/bits, subs, gift subs, resubs, and raids are surfaced as
**shoutout alerts** (shown in the [`/alerts` overlay](api.md#alerts-mode-alerts)
and as highlighted rows in the chat). Twitch delivers these over **EventSub**,
which — unlike anonymous chat — requires a Twitch application and a per-channel
OAuth token authorized by that broadcaster.

YouTube's Super Chats, Super Stickers, and memberships already come through the
YouTube API poller and need nothing extra here. (YouTube has no "follow" event.)

### 1. Create a Twitch application

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console/apps) →
   **Register Your Application**.
2. Set an **OAuth Redirect URL** of `http://localhost:3000` (the default used by
   `multichat login`; pass `--redirect-port` to change it).
3. Note the **Client ID** and generate a **Client Secret**.

### 2. Authorize each channel with `multichat login`

Run the login flow **signed into Twitch as the broadcaster** you want alerts
for:

```bash
multichat login
```

If it doesn't already have the app's Client ID / Secret (from `settings.json`,
`--client-id`/`--client-secret`, or `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`),
it **prompts for them**. Then it prints an authorization URL — open it, approve,
and it prints a ready-to-paste `twitch.eventsub.channels` entry containing the
channel's `login`, `broadcasterId`, and `refreshToken`. Add that entry (and the
`clientId` / `clientSecret`) to `settings.json`. The requested scopes are
`moderator:read:followers` (follows), `channel:read:subscriptions`
(subs/gifts/resubs), and `bits:read` (cheers); raids need no scope. If you skip
a scope, that alert type simply won't appear.

`multichat login` (also spelled `twitch-login`) runs a temporary loopback web
server as the OAuth redirect target; it needs no running multichat server.
Flags: `--client-id`, `--client-secret`, `--redirect-port`, and a positional
settings path.

### 3. Token persistence & rotation

Refresh tokens **rotate** on every use. On startup the server refreshes the
configured `refreshToken` to get a working access token, and — when it has a
writable state directory — persists the rotated refresh token
(`$STATE_DIRECTORY/twitch-refresh-<broadcasterId>`, mode `0600`) and prefers it
over `settings.json` on the next start. So the `refreshToken` in `settings.json`
is only a seed you need **once**.

Because the state directory lives outside the Nix store (systemd's
`StateDirectory` = `/var/lib/multichat` under the NixOS module), the persisted
token **survives restarts, reboots, `nixos-rebuild switch`, and package
updates** — you don't re-login on an upgrade. With a plain `deno task start` and
no `STATE_DIRECTORY`, the token lives only in memory and the seed is re-read
(and re-rotated) each start, so set `STATE_DIRECTORY` (or use the NixOS module)
if you want persistence outside systemd.

The server refreshes reactively when a token is rejected, so it recovers on its
own as long as the refresh token stays valid (re-run `multichat login` if you
revoke the app's access). EventSub health is logged to the console; it does not
change the sidebar status dots (chat's IRC connection owns those).

## Alert themes

The `alerts` block skins the [`/alerts` overlay](api.md#alerts-mode-alerts).
It's a registry of named themes plus a selector; with no `alerts` block (or no
`activeTheme`) the overlay uses its default card, unchanged.

```json
"alerts": {
  "activeTheme": "The Company, Inc",
  "themes": [
    { "name": "The Company, Inc", "style": "company-memo", "events": ["follow"] }
  ]
}
```

| Field         | Type     | Description                                                       |
| ------------- | -------- | ----------------------------------------------------------------- |
| `activeTheme` | string   | The `name` of the theme to apply (empty/unset = the default look) |
| `themes`      | object[] | The available themes                                              |

Each `themes` entry:

| Field     | Type     | Description                                                                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | string   | Selection/display name (referenced by `activeTheme`)                                                                                                                      |
| `style`   | string   | Built-in visual engine: `default` (the standard card) or `company-memo` (see below)                                                                                       |
| `events`  | string[] | Shoutout kinds this theme restyles (`follow`, `cheer`, `sub`, `raid`, `superchat`, `supersticker`, `membership`). Omit/empty = all; kinds not listed use the default card |
| `options` | object   | Style-specific knobs (string/number/bool), e.g. `{ "paper": "#f4efdc", "hold": 4500, "redact": false }`                                                                   |

**`company-memo` ("The Company, Inc").** Renders the alert as an opaque office
memo — a `THE COMPANY, INC` letterhead over `"[Name] just followed!"` — and,
just before it disappears, draws a black **redaction** bar across one of the
three words at random (name / "just" / action). `options`: `paper` / `ink`
(colors), `hold` (ms on screen, default 4500), `redact` (`false` to disable the
bar). With `events: ["follow"]` it fires on Twitch follows only (YouTube has no
follow event); other shoutouts keep the default card.

**Per-source override.** Append `?theme=NAME` to the overlay URL
(`/alerts?theme=The%20Company,%20Inc`) to override `activeTheme` for that OBS
source — handy for testing or running different looks on different sources.

## Environment variable overrides

These override their `settings.json` counterparts at startup:

| Variable               | Overrides                                                |
| ---------------------- | -------------------------------------------------------- |
| `PORT`                 | `server.port`                                            |
| `HOST`                 | `server.host`                                            |
| `YOUTUBE_API_KEY`      | the startup YouTube key (below a persisted runtime key)  |
| `TWITCH_CLIENT_SECRET` | `twitch.eventsub.clientSecret`                           |
| `TWITCH_CLIENT_ID`     | `twitch.eventsub.clientId` (read by `multichat login`)   |
| `STATE_DIRECTORY`      | directory runtime keys/tokens are persisted in (systemd) |

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

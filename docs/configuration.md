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

| Field           | Type   | Default      | Description                                                           |
| --------------- | ------ | ------------ | --------------------------------------------------------------------- |
| `port`          | number | `8080`       | Port the web UI is served on                                          |
| `host`          | string | `127.0.0.1`  | Bind address. Defaults to localhost (right for an OBS browser source) |
| `controlAccess` | string | `"loopback"` | Who may press the `/giveaway` buttons — `loopback`, `lan`, or `any`   |
| `controlToken`  | string | `""`         | Shared secret non-loopback control requests must present              |

> **Exposing to other machines.** To serve on the LAN, set `host` to `0.0.0.0`.
> The bind address must also be allowed in Deno's `--allow-net` flag —
> `127.0.0.1` and `0.0.0.0` are already included in the `deno task` /
> packaged-binary flags, so the default and `0.0.0.0` both work; a specific LAN
> IP would need adding there. There is no authentication, so only expose it on a
> trusted network, and note the server caps concurrent viewers at 50.

### Drawing from another machine (`controlAccess`)

Binding `0.0.0.0` lets anyone on the network *watch* `/giveaway`, but the
buttons — open, close, draw, reset — POST to `/api/giveaway`, which defaults to
loopback-only. Press Draw from a phone or a second PC and it answers `403`.
`server.controlAccess` widens that:

| Value        | Who may drive the draw                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `"loopback"` | (default) only the machine running the server                                                                       |
| `"lan"`      | loopback plus private/link-local peers — `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `fc00::/7`, `fe80::/10` |
| `"any"`      | no address check at all                                                                                             |

For a box that is only reachable from your own network, `"lan"` is the setting
you want:

```json
"server": { "port": 8080, "host": "0.0.0.0", "controlAccess": "lan" }
```

Understand what it buys, though: `"lan"` is an **address** check, not
authentication. Every device on that network can draw. That is usually the
point — whoever is in the room runs the giveaway — but on a shared or guest
network, set `server.controlToken` as well:

```json
"server": { "host": "0.0.0.0", "controlAccess": "lan", "controlToken": "pick-something-long" }
```

A non-loopback caller must then present it as an `Authorization: Bearer …`
header, a `?token=` query parameter, or the cookie the page mints. Open
`http://<host>:<port>/giveaway?token=pick-something-long` once on the phone and
it is remembered for 30 days — bookmark the plain `/giveaway` afterwards.
Loopback is never asked for the token, so `multichat giveaway draw` on the host
keeps working unchanged.

Scope: this covers `/api/giveaway` only. `/api/youtube-key` and `/api/fake` stay
loopback-only whatever `controlAccess` says — one sets a secret, the other forges
events. And the read-only surfaces (`/`, `/overlay`, `/alerts`, `/giveaway`,
`/events`) have never had authentication; `controlAccess` gates the buttons, not
the pages.

## State directory

The entrant pool, the campaign counters, the append-only winners log, the turn
ledger, the pack reports pushed back by chat-cards, and any committed draw plan
are all written to disk as they change and reloaded at startup — so a reboot
mid-giveaway costs you nothing. The directory is resolved in this order:

| Source                 | Used when                                                     |
| ---------------------- | ------------------------------------------------------------- |
| `$STATE_DIRECTORY`     | running under systemd (the NixOS module — `/var/lib/multichat`) |
| `$MULTICHAT_STATE_DIR` | you set it explicitly                                          |
| `$XDG_STATE_HOME/multichat` | `XDG_STATE_HOME` is set                                  |
| `$HOME/.local/state/multichat` | otherwise                                             |

Deliberately never the working tree: that is where `git clean` and rebuilds
happen. If the directory cannot be created the server logs a warning and runs
with in-memory state — the stream is never held up by a disk problem.

Deno's `--allow-write` is an allow-list, so a state directory outside the paths
baked into `deno.json` / the packaged wrapper is denied. The defaults above are
covered; a custom `MULTICHAT_STATE_DIR` needs adding to those flags.

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

## Giveaway mode

The optional `giveaway` block runs a **Twitch-only** prize draw: viewers type a
command (e.g. `!enter`) in chat, the server verifies eligibility, collects the
eligible viewers into a pool, and you draw a winner on the
[`/giveaway`](api.md#giveaway-mode-giveaway) page — a **CS2-style case reel**
that scrolls and lands on the winner (also available as a transparent OBS
overlay, see below).

```json
"giveaway": {
  "enabled": true,
  "channel": "streamer1",
  "prefix": "!",
  "command": "enter",
  "requireFollow": true,
  "replies": true,
  "firstN": 0,
  "followerStep": 0,
  "milestoneDraws": 1
}
```

| Field            | Type   | Description                                                                                                                           |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | bool   | Turn the giveaway on. Default off.                                                                                                    |
| `channel`        | string | The single Twitch channel (login, lowercase) it runs on. Must be in `twitch.channels`; for `requireFollow` also in `twitch.eventsub`. |
| `prefix`         | string | Command prefix. Default `"!"`.                                                                                                        |
| `command`        | string | Command word after the prefix. Default `"enter"` (so viewers type `!enter`).                                                          |
| `requireFollow`  | bool   | Only admit viewers who follow the channel, checked live via Helix. Default on. See the note below.                                    |
| `replies`        | bool   | Post confirmation/denial/winner messages back to chat as the broadcaster. Default on. See the note below.                             |
| `firstN`         | number | Campaign mode: entrants #1..N are **all** guaranteed winners (draws pick who's next). 0 = off. See below.                             |
| `followerStep`   | number | Arm `milestoneDraws` draw credits every N **new** followers (live via EventSub). 0 = no tracking. See below.                          |
| `milestoneDraws` | number | Draw credits armed per milestone crossed. Default 1.                                                                                  |
| `messages`       | object | Optional reply templates — see [Message templates](#giveaway-message-templates) below.                                                |
| `timezone`       | string | IANA zone the compiled report renders turn times in. Default `"America/Denver"`.                                                      |
| `terms`          | object | Optional terms-acceptance gate on entry — see below. Omit the block for no gate.                                                      |
| `disposition`    | object | Optional winner-turn commands for what happens to the pull — see below. Omit for none.                                               |

**Why Twitch-only.** YouTube's API has no way to verify whether a viewer is
subscribed to a channel (subscriber lists are private and un-queryable), so a
follow/sub-gated giveaway can't be built for YouTube. The giveaway watches one
Twitch channel's chat.

**`requireFollow` needs EventSub.** The follow check calls Helix with the
channel's **broadcaster token** (the `moderator:read:followers` scope, already
requested), so the channel must be authorized in
[`twitch.eventsub`](#twitch-eventsub-alerts) via `multichat login`. If it isn't,
follows can't be verified and entries **fail closed** (nobody is admitted). Set
`requireFollow: false` to let anyone who types the command enter.

**`replies` needs a re-authorization.** Sending chat as the broadcaster uses the
`user:write:chat` scope, which is **new** — the `login` flow now requests it,
but tokens minted before this release don't carry it. If replies are on, re-run
`multichat login` for the giveaway channel so its token gains the scope;
otherwise the follow gate and reel still work, but replies log a `401` and are
skipped. Set `replies: false` to run silently (the `/giveaway` page still shows
entries and the winner).

**Running it.** Open `/giveaway` (the control view). Its buttons use the
[`/api/giveaway`](api.md#post-apigiveaway) endpoint, which is loopback-only
until [`server.controlAccess`](#drawing-from-another-machine-controlaccess)
widens it — so out of the box the control view only works on the server's own
machine. Or drive it from the terminal: `multichat giveaway
status|open|close|draw|reset|demo|winners|campaign-reset|remove <who>`. The
entrant pool, campaign progress, and winners log are persisted to the
[state directory](#state-directory), so they survive a restart.

**Removing an entrant.** Every name in the ENTRANTS list has a `✕` next to it,
and the box above the list filters by name or `#number` — which is what makes
one person findable in a pool of a few hundred. Removal asks for confirmation:
there is no undo, and in campaign mode a re-entry comes back with a new entry
number.

From the terminal, `multichat giveaway remove <who>` takes whatever you can read
off the screen — a login, a display name, `#12`, or a raw userId:

```bash
multichat giveaway remove pixelpanda   # login
multichat giveaway remove "Nova Byte"  # display name (case-insensitive)
multichat giveaway remove '#12'        # entry number
```

It prints who it dropped and how many entrants are left. If nothing matches, or
if two entrants share the display name you typed, it removes **nothing**, lists
the candidates, and exits non-zero — so a script notices, and so you never
silently drop the wrong person mid-stream. Re-run with the userId to pick one.

**On stream (OBS overlay).** Point an OBS browser source at `/giveaway?overlay`
— a **transparent** version that shows only the reel, stays blank between draws,
and auto-hides shortly after the winner lands. When you draw (from the control
view or the CLI), the overlay plays the reveal for your audience, so you never
have to share the operator screen.

**Previewing it.** No live stream? Click **Demo** on the `/giveaway` page (or
run `multichat giveaway demo`) to inject a batch of sample entrants (and, when
`followerStep` is set, some simulated follower progress), then draw — handy for
testing the reel before going live. `Reset` clears the pool; before going live
for real, run `multichat giveaway campaign-reset --yes` so demo entrants don't
occupy entry numbers.

### Campaign mode: guaranteed first-N + follower milestones

`firstN` and `followerStep` turn the one-off giveaway into a running
**campaign**. The worked example — *"the first 500 entrants each get a card
pack (opened on stream, mailed); after that, every 100 new followers we open 10
more packs for random people from the pool"*:

```json
"giveaway": {
  "enabled": true,
  "channel": "streamer1",
  "firstN": 500,
  "followerStep": 100,
  "milestoneDraws": 10
}
```

- **Entry numbers.** Every entrant gets a permanent `#N` (shown in the UI, the
  reel cards, chat replies via `{number}`, and the winners log) plus an
  entered-at timestamp — assigned once, never reused, surviving removals and
  pool resets.
- **The guaranteed queue (`firstN`).** Entrants #1..500 are all winners; each
  **draw** just picks *who's next* (random among the un-drawn ≤ 500) so the reel
  is your "next pack to open" moment. The draw button reads "Draw next pack"
  while the queue has anyone left. Entries stay open past 500 — later entrants
  join the **bonus pool** and get the `enteredPool` reply instead.
- **Follower milestones (`followerStep`).** The server counts **new** followers
  live (via the channel's EventSub connection, deduped by user id, persisted).
  Every 100, it announces the milestone in chat (the `milestone` template),
  flashes a banner on `/giveaway` (and the overlay), and arms 10 advisory **draw
  credits**. Credits are displayed and counted down but never hard-block the
  button — you stay in control. A progress bar (63/100) shows on the control
  view; add `&progress` to the overlay URL (`/giveaway?overlay&progress`) for an
  always-on corner pill on stream.
- **The winners log.** Every draw appends to a durable log (who, entry `#`,
  entered-at, won-at, and tier: `guaranteed` / `milestone-K` / `manual`) — your
  mailing list. View it with the **Winners** panel on `/giveaway`, or export it:
  `multichat giveaway winners --csv > winners.csv`. `campaign-reset` archives
  the log to a `.bak-<timestamp>` file (never deletes it) and zeroes the
  counters + entry numbers.

### Terms gate

```json
"terms": { "required": true, "command": "accept", "version": "1", "url": "https://example.com/terms" }
```

With the block present, `!enter` admits only entrants who have already typed the
accept command (`prefix` + `terms.command`, so `!accept` by default); everyone
else gets the `termsRequired` reply instead of an entry. Acceptances are
persisted with the rest of the giveaway state. Bump `version` to invalidate every
acceptance on file and make people accept again after the terms change.

**multichat does not host a terms page.** `url` is only substituted into the
`termsRequired` reply as `{terms}` — it has to point at a page you publish
yourself. If you have no page yet, leave `url` empty and write the terms into the
`termsRequired` message; the built-in prompt would otherwise render an empty
`()` where the link belongs.

The gate is only as visible as your chat replies. With `replies: false` an
entrant who hasn't accepted is refused **in silence**, with nothing telling them
the accept command exists — so keep replies on whenever the gate is, or announce
the command another way.

Omitting the block entirely is what turns the gate off. A block that is present
but sets `"required": false` is treated as "configured on purpose, then
disabled"; the NixOS module never emits one.

### Winner dispositions

```json
"disposition": { "enabled": true, "mail": "mail", "donate": "donate", "destroy": "destroy", "pass": "pass" }
```

The current winner can say one of these words in chat — with or without the
command prefix — to choose what happens to their pull. `mail`, `donate` and
`destroy` record the choice and add to the campaign tally; `pass` also carries
the cards onto the next winner's turn and advances the draw, so it changes state
rather than just recording. Each choice fires `giveaway.turn.disposition` on the
[integration bus](#integrations) and gets a `mailed`/`donated`/`destroyed`/
`passed` chat reply.

**Chat is the only route, and only the winner can take it.** The handler checks
the speaker's own Twitch user id against the active turn and ignores everyone
else, including you; it also refuses a second decision once one is recorded.
There is no operator override — no `/api/giveaway` action, no CLI verb, and no
control on the `/giveaway` page, which only *displays* the active turn. So a
winner who says nothing leaves their turn open indefinitely, and a winner who
won't cooperate cannot be dispositioned on their behalf.

### Giveaway message templates

The `messages` object overrides any of the built-in chat replies. `{user}` is
always the viewer's display name; the other placeholders are filled per key:

| Key              | Sent when…                                    | Extra placeholders                                                       |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| `entered`        | an entrant joins (within `firstN`, or always when `firstN` is 0) | `{number}` entry #, `{remaining}` guaranteed slots left |
| `enteredPool`    | an entrant joins beyond `firstN`              | `{number}`                                                               |
| `alreadyEntered` | a repeat `!enter`                             | —                                                                        |
| `notFollowing`   | `requireFollow` rejects a non-follower        | —                                                                        |
| `winner`         | a draw lands                                  | `{number}`                                                               |
| `milestone`      | a follower milestone is crossed               | `{count}` total new follows, `{milestone}` ordinal, `{draws}` credits    |
| `termsRequired`  | `!enter` from someone who hasn't accepted the terms | `{accept}` the accept command, `{terms}` the T&C url            |
| `termsAccepted`  | a successful `!accept`                        | `{enter}` the entry command                                              |
| `mailed`         | the winner chooses `mail`                     | `{cards}` count, `{value}` pack total                                    |
| `donated`        | the winner chooses `donate`                   | `{cards}`, `{value}`                                                     |
| `destroyed`      | the winner chooses `destroy`                  | `{cards}`, `{value}`                                                     |
| `passed`         | the winner chooses `pass`                     | `{cards}`, `{value}`, `{next}` the winner drawn next                     |

```json
"messages": {
  "entered": "🎉 @{user} you're pack #{number} of 500 — we'll open it on stream!",
  "enteredPool": "@{user} the first 500 are full, but you're in the pool for every follower milestone (entry #{number})!",
  "milestone": "🔥 {count} new followers! Opening {draws} more packs!",
  "winner": "🎉 @{user} (entry #{number}) — your pack is getting opened!"
}
```

## Environment variable overrides

These override their `settings.json` counterparts at startup:

| Variable               | Overrides                                                |
| ---------------------- | -------------------------------------------------------- |
| `PORT`                 | `server.port`                                            |
| `HOST`                 | `server.host`                                            |
| `YOUTUBE_API_KEY`      | the startup YouTube key (below a persisted runtime key)  |
| `TWITCH_CLIENT_SECRET` | `twitch.eventsub.clientSecret`                           |
| `TWITCH_CLIENT_ID`     | `twitch.eventsub.clientId` (read by `multichat login`)   |
| `STATE_DIRECTORY`      | directory all persistent state is written to (systemd)   |
| `MULTICHAT_STATE_DIR`  | the same, outside systemd (see [State directory](#state-directory)) |
| `MULTICHAT_CONTROL_ACCESS` | `server.controlAccess` |
| `MULTICHAT_CONTROL_TOKEN` | `server.controlToken` |
| `MULTICHAT_CALLBACK_TOKEN` | `integrations.callbackToken` |
| `MULTICHAT_INTEGRATION_TOKEN_<NAME>` | a subscriber's `token` (see [Integrations](#integrations)) |

## Integrations

The `integrations` block wires multichat's giveaway to external tools. It has two
halves that together form a loop: multichat pushes giveaway-lifecycle events
**out** to subscribers, and a subscriber pushes results **back** to
`POST /api/turn-report`, where they attach to the winner's turn in the ledger.

```json
{
  "integrations": {
    "callbackToken": "",
    "subscribers": [
      {
        "name": "chat-cards",
        "adapter": "chat-cards",
        "baseUrl": "http://127.0.0.1:8787",
        "token": "",
        "events": ["giveaway.turn.start"],
        "enabled": true,
        "packSize": 5
      }
    ]
  }
}
```

| Field           | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `callbackToken` | Bearer an external tool must present on `/api/turn-report`. Empty = loopback only |
| `name`          | Identifies the subscriber in logs; also names its token env var               |
| `adapter`       | `"webhook"` or `"chat-cards"` — how events become HTTP calls                  |
| `baseUrl`       | Where to deliver. Trailing slash trimmed. A subscriber without one is dropped |
| `token`         | Bearer sent with every delivery, when the target requires one                 |
| `events`        | Event types to deliver; `["*"]` (or omitted) means all of them                |
| `enabled`       | `false` silences this subscriber without deleting its config                  |
| `packSize`      | chat-cards only: cards per pack. `0`/unset uses chat-cards' own default       |

### Events

| Event                         | Fires when…                                    |
| ----------------------------- | ---------------------------------------------- |
| `giveaway.turn.start`         | a draw lands and the winner's turn opens       |
| `giveaway.turn.disposition`   | the winner picks mail / donate / destroy / pass |
| `giveaway.turn.end`           | the turn closes                                |
| `giveaway.entrant.added`      | an entrant is accepted into the pool           |
| `giveaway.terms.accepted`     | an entrant accepts the T&Cs                    |

The `webhook` adapter POSTs `{event, ts, data}` for every subscribed event. The
`chat-cards` adapter only maps events it has a call for — today that is
`giveaway.turn.start`, which becomes `POST {baseUrl}/api/pack` with
`{winner, ref, label?, size?}`. `ref` is the turn id; it comes back on the pack
report, which is how a report finds its turn.

Delivery is fire-and-forget with one retry. A subscriber being down never blocks
or rolls back a draw — the draw stands, and the report reconciles values whenever
the tool comes back.

### The chat-cards loop

[chat-cards](https://github.com/The-Company-Inc-Nerds/chat-cards) opens and
prices a physical card pack on stream. Wired as a subscriber, a draw opens a pack
under the winner's name; as each card is scanned and priced, chat-cards POSTs the
pack back to `/api/turn-report` and the `/giveaway` page shows what was pulled and
what it was worth.

Point chat-cards back at this server with its own `--report-url`
(`services.chat-cards.report.url` on NixOS):

```
multichat: integrations.subscribers[].baseUrl  →  http://chat-cards:8787
chat-cards: --report-url                       →  http://multichat:8080/api/turn-report
```

`/api/turn-report` needs the giveaway enabled — with no giveaway it answers
`501`.

### Tokens

Neither token is required when both services share a machine: `/api/turn-report`
accepts loopback requests with no `callbackToken` set, the same rule the other
control endpoints follow. Across machines both halves need one.

Tokens can come from the environment instead of `settings.json`, so a
world-readable config file (a Nix store path, say) carries no secrets. The
callback token reads from `MULTICHAT_CALLBACK_TOKEN`; a subscriber's outbound
token from `MULTICHAT_INTEGRATION_TOKEN_<NAME>`, where `<NAME>` is its `name`
uppercased with every run of non-alphanumerics collapsed to one `_` — so
`chat-cards` becomes `MULTICHAT_INTEGRATION_TOKEN_CHAT_CARDS`. The environment
wins over the file. The [NixOS module](nixos.md) does all of this for you from
`callbackTokenFile` / `tokenFile`.

Because those names are derived from your config, the packaged deno wrapper
allows the whole `MULTICHAT_INTEGRATION_TOKEN_*` prefix rather than an
enumerated list. A wrapper built before this existed simply finds no override
instead of failing to start.

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

# multichat

Combines Twitch IRC chat and YouTube Live Chat into a single browser-based
viewer, streamed in real time over Server-Sent Events. Dependency-free — pure
Deno built-ins only.

- **One merged feed** — Twitch and YouTube chat side by side, each message
  tagged by platform
- **Channel panel** — every watched channel with a live / offline / connecting /
  error indicator
- **Role badges** — Twitch broadcaster/mod/VIP/sub, YouTube
  owner/moderator/member/verified
- **Twitch image emotes** — rendered from the emote tag (YouTube emotes are text
  — see the docs)
- **`/me` actions and event rows** — follows, cheers, subs, raids, Super Chats,
  Super Stickers, memberships
- **Shoutout alerts** — a dedicated `/alerts` OBS overlay pops up follows / bits
  / subs / raids / donations one at a time (Streamlabs-style, auto-dismissing),
  with selectable **themes** (e.g. the "The Company, Inc" redacted-memo look)
- **Live deletions** — moderator timeouts/bans and removed messages disappear
  from the feed
- **OBS overlays** — `/overlay` renders the chat feed transparent and
  messages-only for a browser source; `/alerts` is the animated shoutout box

Twitch **chat** connects anonymously (no account or token). Twitch **alerts**
(follows/cheers/subs/raids) use Twitch EventSub, which needs a Twitch app + a
per-channel token from `multichat login`. YouTube requires a free Data API v3
key (its Super Chats / stickers / memberships need nothing more).

## Quick Start

```bash
nix develop              # enter the dev shell (provides deno)
cp settings.json.example settings.json
# edit settings.json with your channels and YouTube API key
deno task start          # start the server
```

Open `http://localhost:8080`. Use `deno task dev` to auto-restart on changes.

The YouTube API key need not live in `settings.json` — you can set it on the
running server instead (it persists under systemd), which keeps it out of your
config and Nix store:

```bash
echo -n "$YT_KEY" | multichat set-youtube-key
```

See
[Configuration](docs/configuration.md#setting-the-youtube-api-key-at-runtime).

### Twitch alerts (follows / bits / subs / raids)

Chat works with no credentials. To also get **shoutout alerts** on `/alerts` and
`/overlay`, authorize each channel over Twitch EventSub — one interactive login:

```bash
# 1. Create a Twitch app at https://dev.twitch.tv/console/apps
#    with OAuth Redirect URL  http://localhost:3000  (login prints these steps too)
# 2. Run the login flow, signed into Twitch as the broadcaster:
multichat login
```

It prompts for the app's Client ID / Secret (if not already configured), opens
an authorization URL, then prints a `twitch.eventsub.channels` entry (with the
channel's refresh token) to paste into `settings.json`. YouTube Super Chats,
Super Stickers, and memberships already appear as alerts with just the API key —
nothing extra needed.

**You only log in once per channel.** The refresh token rotates automatically
and is persisted to the service's state directory (`/var/lib/multichat` under
the NixOS/systemd module), so it **survives restarts, reboots, `nixos-rebuild`,
and package updates** — the state directory lives outside the Nix store and is
never touched by a rebuild. (Running bare via `deno task start` with no
`STATE_DIRECTORY` keeps the token in memory only, so re-login is needed after a
restart.)

See
[Configuration → Twitch EventSub alerts](docs/configuration.md#twitch-eventsub-alerts)
and, for production secrets, the
[NixOS Module](docs/nixos.md#twitch-eventsub-secrets).

## Documentation

| Doc                                              | Contents                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [Installation & Setup](docs/install.md)          | Dev environment, running, building a binary, installing                                      |
| [Configuration](docs/configuration.md)           | `settings.json` reference, channels, env vars, YouTube API key, Twitch EventSub alerts       |
| [Chat Features](docs/features.md)                | Per-platform rendering: badges, emotes, events, alerts overlay, deletions, the channel panel |
| [HTTP & SSE API](docs/api.md)                    | The `/`, `/overlay`, `/alerts`, `/events` endpoints and the event/message shapes             |
| [NixOS Module](docs/nixos.md)                    | Module options and secrets management                                                        |
| [Architecture](docs/development/architecture.md) | Module layout, data flow, design notes                                                       |
| [Testing](docs/development/testing.md)           | Running checks and tests, commit workflow                                                    |

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
- **`/me` actions and event rows** — cheers, subs, raids, Super Chats, Super
  Stickers, memberships
- **Live deletions** — moderator timeouts/bans and removed messages disappear
  from the feed
- **OBS overlay** — `/overlay` renders the feed transparent and messages-only
  (new at the bottom, old sliding off the top) for a browser source

Twitch connects anonymously (no account or token). YouTube requires a free Data
API v3 key.

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

## Documentation

| Doc                                              | Contents                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [Installation & Setup](docs/install.md)          | Dev environment, running, building a binary, installing                      |
| [Configuration](docs/configuration.md)           | `settings.json` reference, channels, env vars, YouTube API key               |
| [Chat Features](docs/features.md)                | Per-platform rendering: badges, emotes, events, deletions, the channel panel |
| [HTTP & SSE API](docs/api.md)                    | The `/` and `/events` endpoints and the event/message shapes                 |
| [NixOS Module](docs/nixos.md)                    | Module options and secrets management                                        |
| [Architecture](docs/development/architecture.md) | Module layout, data flow, design notes                                       |
| [Testing](docs/development/testing.md)           | Running checks and tests, commit workflow                                    |

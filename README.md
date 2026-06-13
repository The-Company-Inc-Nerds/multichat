# multichat

Combines Twitch IRC chat and YouTube Live Chat into a single browser-based viewer. No dependencies — pure Deno built-ins only.

Messages from all configured channels are streamed to the browser in real time via Server-Sent Events. A sidebar lists every watched channel with a live/offline/connecting/error indicator, and each message carries its platform's richness:

- **Platform identity** — colored left border + `T`/`YT` badge, channel name, colored username
- **Role badges** — Twitch broadcaster/mod/VIP/sub, YouTube owner/moderator/member/verified
- **Image emotes** — Twitch emotes render as images (see note below)
- **`/me` actions** and **highlighted event rows** — Twitch cheers, subs/resubs, raids, announcements; YouTube Super Chats, Super Stickers, and memberships
- **Live deletions** — moderator timeouts/bans and removed messages disappear from the feed

> **YouTube emotes** show as `:shortcodes:`/unicode text, not images. The YouTube Data API v3 returns chat messages as plain text only — it does not expose custom-emoji image URLs. Image emotes are therefore Twitch-only.

**Twitch** connects anonymously (no account or token required). **YouTube** requires a free Data API v3 key.

---

## Quick start

```bash
nix develop                  # enter the dev shell (provides deno)
cp settings.json settings.json.bak
# edit settings.json with your channels and YouTube API key
deno task start              # starts the server
```

Open `http://localhost:8080`.

Use `deno task dev` to auto-restart on file changes during development.

---

## Configuration

Edit `settings.json` in the project root:

```json
{
  "server": {
    "port": 8080,
    "host": "0.0.0.0"
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

**`twitch.channels`** — lowercase channel names. Anonymous read-only access, no credentials needed.

**`youtube.channels`** — for each entry, provide one of:
- `handle` — the `@username` shown on the channel page
- `channelId` — the `UC…` ID from the channel URL
- `videoId` — a specific video ID; skips the live-stream lookup and goes straight to that video's chat

**`youtube.apiKey`** — see [Getting a YouTube API key](#getting-a-youtube-api-key) below. Can also be set via the `YOUTUBE_API_KEY` environment variable, which takes precedence over the file.

**`server.host`** — use `127.0.0.1` to restrict to localhost, `0.0.0.0` to expose on all interfaces.

### Getting a YouTube API key

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Enable the **YouTube Data API v3** under *APIs & Services → Library*
4. Create an API key under *APIs & Services → Credentials*
5. Optionally restrict the key to the YouTube Data API v3

The free quota (10,000 units/day) is sufficient for casual use. Each chat poll costs 5 units.

---

## Standalone binary

Build a self-contained executable that does not require Deno at runtime:

```bash
deno task compile
./multichat                          # uses ./settings.json
./multichat /path/to/settings.json   # custom config path
```

---

## NixOS installation

The flake exposes a NixOS module at `nixosModules.default`.

### flake.nix

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    multichat.url = "github:youruser/multichat";
  };

  outputs = { nixpkgs, multichat, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        multichat.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

### configuration.nix

```nix
services.multichat = {
  enable = true;
  port   = 8080;
  host   = "127.0.0.1";   # change to "0.0.0.0" to expose publicly

  twitch.channels = [ "streamer1" "streamer2" ];

  youtube.apiKeyFile = "/run/secrets/youtube-api-key";
  youtube.channels = [
    { handle = "@channelhandle"; }
  ];

  openFirewall = false;   # set true if host is "0.0.0.0"
};
```

The service runs as a systemd `DynamicUser` (no persistent system account required) and starts automatically on boot after the network is online.

### Module options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enable` | bool | `false` | Enable the service |
| `port` | port | `8080` | Web interface port |
| `host` | string | `"127.0.0.1"` | Bind address |
| `openFirewall` | bool | `false` | Open `port` in the firewall |
| `twitch.channels` | `[string]` | `[]` | Twitch channel names |
| `youtube.apiKey` | string | `""` | API key inline (stored in Nix store — prefer `apiKeyFile`) |
| `youtube.apiKeyFile` | path | `null` | Path to a plain file containing just the raw key; takes precedence over `apiKey` |
| `youtube.channels` | `[{handle,channelId,videoId}]` | `[]` | YouTube channels |
| `package` | package | built from flake | Override the multichat package |

### Secrets management

`youtube.apiKeyFile` points to a file containing **just the raw API key** — no `KEY=VALUE` prefix:

```
AIzaSy...
```

The file is read at service start time, so it works with any tool that writes plain secret files:

| Tool | Typical path | Config note |
|------|-------------|-------------|
| [agenix](https://github.com/ryantm/agenix) | `/run/agenix/youtube-api-key` | Set `mode = "0444"` or add the service to the secret's group |
| [sops-nix](https://github.com/Mic92/sops-nix) | `/run/secrets/youtube-api-key` | Set `mode = "0444"` |
| Plain file | anywhere readable | Ensure the service can read it |

Because the service runs as a `DynamicUser`, the secret file must be world-readable (`0444`) or have its group set to one granted via `supplementaryGroups`.

`youtube.apiKey` accepts the key as a plain string directly in your NixOS config. It is convenient for local or non-sensitive environments but the value will be stored in the Nix store. When both options are set, `apiKeyFile` takes precedence.

---

## Environment variables

All three override their `settings.json` counterparts:

| Variable | Description |
|----------|-------------|
| `YOUTUBE_API_KEY` | YouTube Data API v3 key |
| `PORT` | Server port |
| `HOST` | Server bind address |

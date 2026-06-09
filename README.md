# multichat

Combines Twitch IRC chat and YouTube Live Chat into a single browser-based viewer. No dependencies — pure Deno built-ins only.

Messages from all configured channels are streamed to the browser in real time via Server-Sent Events. Each message shows a platform badge, channel name, and colored username.

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
| `youtube.apiKey` | string | `""` | API key (stored in Nix store — prefer `apiKeyFile`) |
| `youtube.apiKeyFile` | path | `null` | Path to a file containing `YOUTUBE_API_KEY=…` |
| `youtube.channels` | `[{handle,channelId,videoId}]` | `[]` | YouTube channels |
| `package` | package | built from flake | Override the multichat package |

### Secrets management

`youtube.apiKeyFile` should point to a file with the content:

```
YOUTUBE_API_KEY=AIzaSy...
```

This file is never written to the Nix store. It works with any secrets manager that writes files at boot ([agenix](https://github.com/ryantm/agenix), [sops-nix](https://github.com/Mic92/sops-nix), etc.).

`youtube.apiKey` is a convenience option for local or trusted environments where the key being in the Nix store is acceptable.

---

## Environment variables

All three override their `settings.json` counterparts:

| Variable | Description |
|----------|-------------|
| `YOUTUBE_API_KEY` | YouTube Data API v3 key |
| `PORT` | Server port |
| `HOST` | Server bind address |

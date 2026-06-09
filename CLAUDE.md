# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multichat is a dependency-free Deno server that combines Twitch IRC chat and YouTube Live Chat into a single browser-based viewer. It uses Server-Sent Events (SSE) to push messages to the browser in real time.

## Development commands

```bash
deno task start          # run the server (reads settings.json)
deno task dev            # run with --watch (auto-restarts on file changes)
deno task compile        # build a standalone binary ./multichat
```

Or directly:
```bash
deno run --allow-net --allow-read --allow-env=YOUTUBE_API_KEY,PORT,HOST main.ts [config-path]
```

`config-path` defaults to `./settings.json`. Env vars `PORT`, `HOST`, and `YOUTUBE_API_KEY` override their settings.json counterparts.

## Configuration

Edit `settings.json`:
- `server.port` / `server.host` — where the web UI is served
- `twitch.channels` — list of Twitch channel names (lowercase)
- `youtube.apiKey` — YouTube Data API v3 key (get one at Google Cloud Console)
- `youtube.channels` — list of `{handle, channelId, videoId}` objects; supply at least one field per entry

YouTube channels require an API key. Twitch works anonymously (read-only via `justinfan*`).

## Architecture

```
main.ts          entry point — loads settings, wires broadcaster to server + clients
src/types.ts     shared TypeScript interfaces (Settings, ChatMessage, Broadcaster)
src/twitch.ts    Twitch IRC over WebSocket (wss://irc-ws.chat.twitch.tv), with reconnect
src/youtube.ts   YouTube Data API v3 polling — resolves channel → live video → live chat
src/server.ts    Deno.serve HTTP server: GET / returns embedded HTML, GET /events is SSE
```

The `Broadcaster` is a plain callback `(msg: ChatMessage) => void` created by `createServer` and passed to the platform clients. Messages are pushed to all connected SSE streams via a `Set<ReadableStreamDefaultController>`.

No external imports — only Deno built-ins (`Deno.serve`, `Deno.readTextFile`, `WebSocket`, `fetch`, `ReadableStream`).

## NixOS module

The flake exposes `nixosModules.default`. Minimal NixOS configuration:

```nix
{
  inputs.multichat.url = "github:youruser/multichat";

  outputs = { nixpkgs, multichat, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        multichat.nixosModules.default
        {
          services.multichat = {
            enable = true;
            port = 8080;
            twitch.channels = [ "streamer1" ];
            youtube.apiKeyFile = "/run/secrets/youtube-api-key";  # contains YOUTUBE_API_KEY=...
            youtube.channels = [{ handle = "@channelhandle"; }];
            openFirewall = true;
          };
        }
      ];
    };
  };
}
```

The systemd service runs as a `DynamicUser` (no persistent system user needed). The YouTube API key is supplied via `EnvironmentFile` (`apiKeyFile`) for production, or `youtube.apiKey` for convenience (stored in Nix store).

## Nix dev shell

```bash
nix develop        # enters the shell with deno + claude-code
direnv allow       # auto-activates via .envrc if direnv is installed
```

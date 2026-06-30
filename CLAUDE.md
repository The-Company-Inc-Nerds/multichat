# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this is

Multichat is a dependency-free Deno server that combines Twitch IRC chat and
YouTube Live Chat into a single browser-based viewer. It uses Server-Sent Events
(SSE) to push messages to the browser in real time.

User-facing docs live in `docs/` (see `docs/index.md`). This file is the
dev-facing guide; keep both in sync when structure changes.

## Development commands

```bash
deno task start          # run the server (reads settings.json)
deno task dev            # run with --watch (auto-restarts on file changes)
deno task test           # run the test suite (tests/, no permissions needed)
deno task check          # type-check main.ts, src/, tests/
deno task lint           # lint
deno task fmt            # format
deno task compile        # build a standalone binary ./multichat
```

In the dev shell, `runchecks` runs fmt-check + lint + check + test (the
pre-commit gate).

Or directly:

```bash
deno run --allow-net --allow-read --allow-write=/var/lib/multichat,/var/lib/private/multichat --allow-env=YOUTUBE_API_KEY,PORT,HOST,STATE_DIRECTORY main.ts [config-path]
```

`config-path` defaults to `./settings.json`. Env vars `PORT` and `HOST` override
their settings.json counterparts; the YouTube key is resolved as persisted
runtime key → `YOUTUBE_API_KEY` → `youtube.apiKey`. `--allow-write` /
`STATE_DIRECTORY` exist only so a runtime-set key can be persisted to
`$STATE_DIRECTORY/youtube-api-key` (systemd `StateDirectory`); with no state dir
the key is in-memory only.

The same binary is also a small CLI client: `multichat set-youtube-key [KEY]`
POSTs a key to a running server's loopback `POST /api/youtube-key` endpoint (key
from arg or stdin). See `docs/configuration.md`.

## Configuration

Copy `settings.json.example` to `settings.json` and edit:

- `server.port` / `server.host` — where the web UI is served
- `twitch.channels` — list of Twitch channel names (lowercase)
- `youtube.apiKey` — YouTube Data API v3 key (get one at Google Cloud Console)
- `youtube.channels` — list of `{handle, channelId, videoId}` objects; supply at
  least one field per entry

YouTube channels require an API key, but it need not be in `settings.json` — it
can be set on the running server with `multichat set-youtube-key` (see above).
Twitch works anonymously (read-only via `justinfan*`). Full reference:
`docs/configuration.md`.

## Architecture

```
main.ts          entry point — loads settings, wires the emitter to server + clients;
                 also the `set-youtube-key` CLI subcommand + the runtime-key manager
src/types.ts     shared TypeScript interfaces (Settings, ChatMessage, ServerEvent, Emitter)
src/twitch.ts    Twitch IRC over WebSocket (wss://irc-ws.chat.twitch.tv), with reconnect
src/youtube.ts   YouTube Data API v3 polling — resolves channel → live video → live chat;
                 startYouTubePoller takes an AbortSignal so it can be torn down/restarted
src/server.ts    Deno.serve HTTP server: GET / + GET /overlay (embedded HTML; overlay
                 mode = transparent OBS browser source), GET /events (SSE),
                 POST /api/youtube-key (loopback-only runtime key control)
src/control.ts   pure control-plane helpers (loopback check, key-body parse, startup-key
                 resolution, state path) + the ServerHooks/KeyUpdateResult types
tests/           one *_test.ts per source module; dependency-free assert shim in _assert.ts
```

Pure helpers (`parseIRC`, `handleCommand`, `buildSegments`, `emitItem`,
`colorFor`, …) are `export`ed from the source modules so the tests can drive
them with a fake `Emitter` (`tests/_fake.ts`). The HTTP server is only started
by `createServer`, which tests never call. Deeper notes:
`docs/development/architecture.md`.

The `Emitter` is an object `{ message, delete, status }` created by
`createServer` and passed to the platform clients. Each call broadcasts a tagged
`ServerEvent` (`message` / `delete` / `status`) to all connected SSE streams via
a `Set<ReadableStreamDefaultController>`; the browser switches on `event.type`.
`createServer` also keeps a per-channel status registry (seeded from settings)
so it can push a roster snapshot to each newly connected client.

The browser renders platform-specific richness: Twitch/YouTube role badges,
author colors, image emotes (Twitch only — see note), `/me` actions, highlighted
event rows (cheers, subs, raids, Super Chats, Super Stickers, memberships), and
live message deletions. A left sidebar lists every watched channel with a
live/offline/connecting/error dot.

> YouTube custom emoji cannot be rendered as images: the Data API v3 returns
> `displayMessage` as plain text only (no emoji image URLs or runs), so YouTube
> emotes show as `:shortcodes:`/unicode. Image emotes are Twitch-only.

No external imports — only Deno built-ins (`Deno.serve`, `Deno.readTextFile`,
`WebSocket`, `fetch`, `ReadableStream`).

## Nix file layout

`flake.nix` is thin orchestration; the real definitions are split out (mirrors
the convention in CalamooseLabs/OpenReturn and QuorumCall):

```
flake.nix    wires the three files below into flake outputs (x86_64-linux)
build.nix    the package derivation — { pkgs }: → mkDerivation (standalone-buildable)
shell.nix    dev shell + runserver / runchecks / gcommit helper scripts
module.nix   the NixOS service module (portable — importable without the flake)
```

## NixOS module

`module.nix` (exposed as `nixosModules.default`). Minimal NixOS configuration:

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
            youtube.apiKeyFile = "/run/secrets/youtube-api-key";  # file containing just the raw key
            youtube.channels = [{ handle = "@channelhandle"; }];
            openFirewall = true;
          };
        }
      ];
    };
  };
}
```

The systemd service runs as a `DynamicUser` (no persistent system user needed)
with an aggressively hardened unit. For production, `apiKeyFile` points to a
file containing just the raw key, staged via systemd `LoadCredential` at service
start so it needs no world/group-read permissions (compatible with
agenix/sops-nix); `youtube.apiKey` is the convenience path (stored in the Nix
store, emits a warning). Full options + secrets + hardening table:
`docs/nixos.md`.

## Nix dev shell

```bash
nix develop        # enters the shell with deno + claude-code + helper scripts
direnv allow       # auto-activates via .envrc if direnv is installed
```

Helper scripts (defined in `shell.nix`): `runserver` (= `deno task start`),
`runchecks` (fmt-check + lint + check + test), and `gcommit`. Commits are
GPG-signed: write the message to `GIT_COMMIT_MSG`, then run `gcommit` (prints
it, prompts, runs `git commit -S -F GIT_COMMIT_MSG`). Both `GIT_COMMIT_MSG` and
`gcommit` are gitignored.

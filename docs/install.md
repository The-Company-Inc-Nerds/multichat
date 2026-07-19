# Installation & Setup

## Prerequisites

- [Deno](https://deno.com/) 2.x, or [Nix](https://nixos.org/) with flakes
  enabled.

No other dependencies — multichat uses only Deno built-ins.

## Development Environment

```bash
nix develop        # enter the dev shell (provides deno + helper scripts)
direnv allow       # or auto-activate via .envrc if direnv is installed
```

### Dev-shell shortcuts

The dev shell adds a few helper commands on top of `deno`:

| Command     | Equivalent                                                   | Purpose                                    |
| ----------- | ------------------------------------------------------------ | ------------------------------------------ |
| `runserver` | `deno task start`                                            | Run the server against `./settings.json`   |
| `runchecks` | `deno fmt --check && deno lint && deno check … && deno test` | Full pre-commit gate                       |
| `gcommit`   | `git commit -S -F GIT_COMMIT_MSG`                            | Review `GIT_COMMIT_MSG` and sign-commit it |

## Running the Server

```bash
deno task start          # run the server (reads ./settings.json)
deno task dev            # run with --watch (auto-restarts on file changes)
```

Open `http://localhost:8080` (or whatever `server.port` you configured).

A config path may be passed explicitly; it defaults to `./settings.json`:

```bash
deno run --allow-net --allow-read --allow-env=YOUTUBE_API_KEY,TWITCH_CLIENT_ID,TWITCH_CLIENT_SECRET,PORT,HOST,STATE_DIRECTORY main.ts /path/to/settings.json
```

See [Configuration](configuration.md) for the settings format. Twitch chat and
YouTube work from `settings.json` alone; to enable Twitch **alerts** (follows /
bits / subs / raids) run the one-time `multichat login` per channel — see
[Configuration → Twitch EventSub alerts](configuration.md#twitch-eventsub-alerts).

## Building a Standalone Binary

```bash
deno task compile        # produces ./multichat
./multichat              # uses ./settings.json
./multichat /path/to/settings.json
```

The binary embeds Deno, so it does not require Deno to be installed at runtime.

## Installing on NixOS

multichat ships a NixOS module for declarative deployment. See
[NixOS Module](nixos.md).

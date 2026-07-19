# NixOS Module

The flake exposes a NixOS module at `nixosModules.default`. It runs multichat as
a hardened systemd `DynamicUser` service (no persistent system account needed).

The viewer has no authentication, so `host` defaults to `127.0.0.1`. Only set
`0.0.0.0` + `openFirewall` on a trusted network, or front it with an
authenticating reverse proxy. The server caps concurrent viewers at 50.

`host` must be `"127.0.0.1"` or `"0.0.0.0"` — the packaged `deno` wrapper
restricts `--allow-net` to those bind addresses, so any other value is rejected
at build time (see [Validation](#validation)).

## Usage

### flake.nix

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    multichat = {
      url = "github:youruser/multichat";
      inputs.nixpkgs.follows = "nixpkgs";   # share one nixpkgs
    };
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

  # Optional: follow/cheer/sub/raid alerts via Twitch EventSub (see below).
  twitch.eventsub = {
    clientId = "your-twitch-app-client-id";
    clientSecretFile = "/run/secrets/twitch-client-secret";
    channels = [
      {
        login = "streamer1";
        broadcasterId = "12345678";                       # from `multichat login`
        refreshTokenFile = "/run/secrets/twitch-refresh-streamer1";
      }
    ];
  };

  youtube.apiKeyFile = "/run/secrets/youtube-api-key";
  youtube.channels = [
    { handle = "@channelhandle"; }
  ];

  # Optional: a themed /alerts overlay (see "Alert themes" below).
  alerts = {
    activeTheme = "The Company, Inc";
    themes = [
      { name = "The Company, Inc"; style = "company-memo"; events = [ "follow" ]; }
    ];
  };

  openFirewall = false;   # set true if host is "0.0.0.0"
};
```

The module is also importable without the flake —
`imports = [ (import ./module.nix) ];` — and the package builds standalone from
`build.nix`.

## Supplying the YouTube key at runtime

The YouTube key is **optional at build time**. You can omit both
`youtube.apiKey` and `youtube.apiKeyFile` and instead hand the key to the
running service — handy when you would rather not put the key in Nix/agenix at
all:

```bash
echo -n "$YT_KEY" | multichat set-youtube-key
```

The module puts the `multichat` CLI on `PATH` (`environment.systemPackages`) and
gives the unit a `StateDirectory` (`/var/lib/multichat`), so a key set this way
is written there (mode `0600`, owned by the service) and reloaded on the next
start — set it once. Twitch chat works immediately regardless; only YouTube
waits for the key. The control endpoint is loopback-only (see
[HTTP & SSE API](api.md)). Full reference: [Configuration](configuration.md).

## Module options

| Option                             | Type                                                    | Default                | Description                                                                |
| ---------------------------------- | ------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `enable`                           | bool                                                    | `false`                | Enable the service                                                         |
| `package`                          | package                                                 | built from `build.nix` | Override the multichat package                                             |
| `port`                             | port                                                    | `8080`                 | Web interface port                                                         |
| `host`                             | string                                                  | `"127.0.0.1"`          | Bind address — must be `"127.0.0.1"` or `"0.0.0.0"`                        |
| `openFirewall`                     | bool                                                    | `false`                | Open `port` in the firewall                                                |
| `twitch.channels`                  | `[string]`                                              | `[]`                   | Twitch channel names (chat, anonymous)                                     |
| `twitch.eventsub.clientId`         | string                                                  | `""`                   | Twitch app Client ID for alerts (not secret)                               |
| `twitch.eventsub.clientSecret`     | string                                                  | `""`                   | Client Secret inline (Nix store — prefer `clientSecretFile`)               |
| `twitch.eventsub.clientSecretFile` | path                                                    | `null`                 | File with the raw Client Secret; staged via `LoadCredential`               |
| `twitch.eventsub.channels`         | `[{login,broadcasterId,refreshToken,refreshTokenFile}]` | `[]`                   | Channels to alert on (from `multichat login`)                              |
| `youtube.apiKey`                   | string                                                  | `""`                   | API key inline (stored in the Nix store — prefer `apiKeyFile`)             |
| `youtube.apiKeyFile`               | path                                                    | `null`                 | Path to a file containing just the raw key; takes precedence over `apiKey` |
| `youtube.channels`                 | `[{handle,channelId,videoId}]`                          | `[]`                   | YouTube channels                                                           |
| `alerts.activeTheme`               | string                                                  | `""`                   | Name of the active `/alerts` theme (empty = default look)                  |
| `alerts.themes`                    | `[{name,style,events,options}]`                         | `[]`                   | Named alert themes; `style` = `default` or `company-memo`                  |

## Secrets management

`youtube.apiKeyFile` points to a file containing **just the raw API key** (no
`KEY=VALUE` prefix). The module stages it through systemd's `LoadCredential`:
the file is copied into a private per-service tmpfs (`$CREDENTIALS_DIRECTORY`,
mode `0400`, owned by the service) and read from there at start, so it never
enters the Nix store or `systemctl show`.

Because the credential is staged by systemd as root, the source file **only
needs to be readable by root** at activation time — it does _not_ need to be
world- or group-readable, even though the service runs as a `DynamicUser`. It
composes with any secret manager that writes a plain file:

| Tool                                          | Typical path                               | Note                    |
| --------------------------------------------- | ------------------------------------------ | ----------------------- |
| [agenix](https://github.com/ryantm/agenix)    | `config.age.secrets.youtube-api-key.path`  | no special mode needed  |
| [sops-nix](https://github.com/Mic92/sops-nix) | `config.sops.secrets.youtube-api-key.path` | no special mode needed  |
| Plain file                                    | anywhere root can read                     | provisioned out of band |

`youtube.apiKey` accepts the key as a plain string directly in your config —
convenient for local or non-sensitive setups, but the value lands in the Nix
store **and** `systemctl show multichat`, so the module emits a build-time
warning when it is set. When both are given, `apiKeyFile` takes precedence and
the inline key is not written into the unit at all.

### Twitch EventSub secrets

The Twitch Client Secret and each channel's refresh token are handled the same
way. `twitch.eventsub.clientSecretFile` is staged via `LoadCredential` and
exported as `TWITCH_CLIENT_SECRET` at start (never entering the Nix store); the
`clientId` is not secret and is written into the settings file as normal.

Each `twitch.eventsub.channels` entry can carry its refresh token via
`refreshTokenFile` (preferred) or an inline `refreshToken` (warned, Nix store).
A `refreshTokenFile` is staged via `LoadCredential` and, on first start,
installed into the `StateDirectory` as `twitch-refresh-<broadcasterId>` — and
**only if it is not already there**, so the rotated token the app persists is
never clobbered. This is why `broadcasterId` is required alongside
`refreshTokenFile`. Obtain both with `multichat login` (see
[Configuration](configuration.md#twitch-eventsub-alerts)). Inline `clientSecret`
/ `refreshToken` each emit a build-time warning.

**Persistence across rebuilds.** `StateDirectory` (`/var/lib/multichat`) lives
outside the Nix store, so the rotated refresh token survives
`nixos-rebuild
switch`, package updates, and reboots — you authorize each
channel once and never re-login on an upgrade. The refresh token in Nix
(`refreshTokenFile` / `refreshToken`) is only the first-run seed; after that the
persisted, rotated token wins and the seed is ignored.

## Alert themes

`alerts.themes` is a registry of named looks for the `/alerts` OBS overlay, and
`alerts.activeTheme` selects the one in effect (empty = the default card). Each
theme sets a built-in `style` (`default`, or `company-memo` — an office memo
that redacts one of its three words before it disappears), an optional `events`
list limiting which shoutout kinds it restyles (empty = all; others fall back to
the default card), and an `options` attrset of style knobs. Example — the
flagship memo on Twitch follows only:

```nix
services.multichat.alerts = {
  activeTheme = "The Company, Inc";
  themes = [
    { name = "The Company, Inc"; style = "company-memo"; events = [ "follow" ]; }
  ];
};
```

A theme is selectable at runtime too: `http://<host>:<port>/alerts?theme=NAME`
overrides `activeTheme` for that OBS source. Full reference:
[Configuration → Alert themes](configuration.md#alert-themes).

## Validation

The module **fails the build** (assertion) when:

- a `youtube.channels` entry sets none of `handle` / `channelId` / `videoId`;
- `host` is anything other than `"127.0.0.1"` or `"0.0.0.0"`;
- a `twitch.eventsub.channels` entry has no `login`;
- a `twitch.eventsub.channels` entry sets `refreshTokenFile` without a
  `broadcasterId` (needed to name the persisted token file).

It emits a build-time **warning** when the insecure inline `youtube.apiKey`,
`twitch.eventsub.clientSecret`, or a channel's inline `refreshToken` is used;
when both `twitch.channels` and `youtube.channels` are empty (the viewer would
show no chat); when `youtube.channels` is set but no build-time key is given (a
reminder that the key can be supplied at runtime — not an error); when
`twitch.eventsub.channels` is set but `clientId` is empty (alerts would be
skipped); or when `alerts.activeTheme` names no theme in `alerts.themes` (the
overlay falls back to the default look).

## Security hardening

multichat is stateless and network-only, so the unit is sandboxed aggressively
on top of the `DynamicUser`:

- empty `CapabilityBoundingSet` / `AmbientCapabilities` for `port >= 1024`; a
  privileged port (`port < 1024`, e.g. 80) is granted **only**
  `CAP_NET_BIND_SERVICE`, so it binds without root;
- `ProtectSystem = strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
  `PrivateMounts`, `ProtectProc = invisible`, `ProcSubset = pid`;
- `ProtectKernelTunables` / `Modules` / `Logs`, `ProtectControlGroups`,
  `ProtectClock`, `ProtectHostname`, `RestrictNamespaces`, `RestrictRealtime`,
  `RestrictSUIDSGID`, `LockPersonality`, `RemoveIPC`, `UMask = 0077`;
- `RestrictAddressFamilies = AF_UNIX AF_INET AF_INET6` and a
  `SystemCallFilter = @system-service` allowlist (`native` architectures only).

`MemoryDenyWriteExecute` is deliberately **not** set: Deno's V8 JIT needs
writable+executable memory, so enabling it would break the server.

## Restart behaviour

The unit restarts on failure (`RestartSec = 5s`) with the start-limit window
disabled (`StartLimitIntervalSec = 0`), so a burst of crashes during a long
Twitch/YouTube outage never parks the service in `failed` — it keeps retrying
every 5 seconds.

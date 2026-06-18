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

  youtube.apiKeyFile = "/run/secrets/youtube-api-key";
  youtube.channels = [
    { handle = "@channelhandle"; }
  ];

  openFirewall = false;   # set true if host is "0.0.0.0"
};
```

The module is also importable without the flake —
`imports = [ (import ./module.nix) ];` — and the package builds standalone from
`build.nix`.

## Module options

| Option               | Type                           | Default                | Description                                                                |
| -------------------- | ------------------------------ | ---------------------- | -------------------------------------------------------------------------- |
| `enable`             | bool                           | `false`                | Enable the service                                                         |
| `package`            | package                        | built from `build.nix` | Override the multichat package                                             |
| `port`               | port                           | `8080`                 | Web interface port                                                         |
| `host`               | string                         | `"127.0.0.1"`          | Bind address — must be `"127.0.0.1"` or `"0.0.0.0"`                        |
| `openFirewall`       | bool                           | `false`                | Open `port` in the firewall                                                |
| `twitch.channels`    | `[string]`                     | `[]`                   | Twitch channel names                                                       |
| `youtube.apiKey`     | string                         | `""`                   | API key inline (stored in the Nix store — prefer `apiKeyFile`)             |
| `youtube.apiKeyFile` | path                           | `null`                 | Path to a file containing just the raw key; takes precedence over `apiKey` |
| `youtube.channels`   | `[{handle,channelId,videoId}]` | `[]`                   | YouTube channels                                                           |

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

## Validation

The module **fails the build** (assertion) when:

- a `youtube.channels` entry sets none of `handle` / `channelId` / `videoId`;
- `youtube.channels` is non-empty but neither `youtube.apiKey` nor
  `youtube.apiKeyFile` is set (YouTube polling requires a Data API v3 key);
- `host` is anything other than `"127.0.0.1"` or `"0.0.0.0"`.

It emits a build-time **warning** when the insecure inline `youtube.apiKey` is
used, or when both `twitch.channels` and `youtube.channels` are empty (the
viewer would show no chat).

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

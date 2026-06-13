# NixOS Module

The flake exposes a NixOS module at `nixosModules.default`. It runs multichat as
a hardened systemd `DynamicUser` service (no persistent system account needed).

The viewer has no authentication, so `host` defaults to `127.0.0.1`. Only set
`0.0.0.0` + `openFirewall` on a trusted network, or front it with an
authenticating reverse proxy. The server caps concurrent viewers at 50.

## Usage

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

The module is also importable without the flake —
`imports = [ (import ./module.nix) ];` — and the package builds standalone from
`build.nix`.

## Module options

| Option               | Type                           | Default                | Description                                                                |
| -------------------- | ------------------------------ | ---------------------- | -------------------------------------------------------------------------- |
| `enable`             | bool                           | `false`                | Enable the service                                                         |
| `package`            | package                        | built from `build.nix` | Override the multichat package                                             |
| `port`               | port                           | `8080`                 | Web interface port                                                         |
| `host`               | string                         | `"127.0.0.1"`          | Bind address                                                               |
| `openFirewall`       | bool                           | `false`                | Open `port` in the firewall                                                |
| `twitch.channels`    | `[string]`                     | `[]`                   | Twitch channel names                                                       |
| `youtube.apiKey`     | string                         | `""`                   | API key inline (stored in the Nix store — prefer `apiKeyFile`)             |
| `youtube.apiKeyFile` | path                           | `null`                 | Path to a file containing just the raw key; takes precedence over `apiKey` |
| `youtube.channels`   | `[{handle,channelId,videoId}]` | `[]`                   | YouTube channels                                                           |

## Secrets management

`youtube.apiKeyFile` points to a file containing **just the raw API key** (no
`KEY=VALUE` prefix). It is read at service start time, so it works with any tool
that writes plain secret files:

| Tool                                          | Typical path                   | Note                                                         |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| [agenix](https://github.com/ryantm/agenix)    | `/run/agenix/youtube-api-key`  | Set `mode = "0444"` or add the service to the secret's group |
| [sops-nix](https://github.com/Mic92/sops-nix) | `/run/secrets/youtube-api-key` | Set `mode = "0444"`                                          |
| Plain file                                    | anywhere readable              | Ensure the service can read it                               |

Because the service runs as a `DynamicUser`, the secret file must be
world-readable (`0444`) or have its group set to one granted via
`supplementaryGroups`.

`youtube.apiKey` accepts the key as a plain string directly in your config —
convenient for local or non-sensitive setups, but the value lands in the Nix
store. When both are set, `apiKeyFile` takes precedence.

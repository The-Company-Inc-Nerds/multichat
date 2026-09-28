# NixOS Module

The flake exposes a NixOS module at `nixosModules.default`. It runs multichat as
a hardened systemd `DynamicUser` service (no persistent system account needed).

The viewer has no authentication, so `host` defaults to `127.0.0.1`. Only set
`0.0.0.0` + `openFirewall` on a trusted network, or front it with an
authenticating reverse proxy. The server caps concurrent viewers at 50.

Exposing the port lets other machines *watch* `/giveaway`; it does not let them
draw. The buttons POST to a control endpoint that is loopback-only until
`controlAccess` says otherwise — see [Running the draw from another
machine](#running-the-draw-from-another-machine).

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
      { name = "The Company, Inc"; style = "company-memo"; events = [ "follow" "sub" "raid" "cheer" ]; }
    ];
  };

  openFirewall = false;   # set true if host is "0.0.0.0"
};
```

The module is also importable without the flake —
`imports = [ (import ./module.nix) ];` — and the package builds standalone from
`build.nix`.

## Running the draw from another machine

The `/giveaway` page is a display surface and a control panel at once. Anyone who
can reach the port sees the reel; only callers cleared by `controlAccess` can
open, close, draw or reset.

```nix
services.multichat = {
  enable = true;
  host = "0.0.0.0";
  openFirewall = true;
  controlAccess = "lan";              # loopback + private/link-local peers
  # controlTokenFile = "/run/secrets/multichat-control-token";  # if the LAN is shared
};
```

- `"loopback"` (default) — only the machine running the service.
- `"lan"` — also `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`,
  `fc00::/7`, `fe80::/10`. Public addresses are still refused, which is what
  makes it safe to leave on for a box only reachable from your own network. It
  is an address check, not authentication: **every device on that network can
  draw.** Add `controlTokenFile` where that is not acceptable.
- `"any"` — no address check. Pair it with a token or a reverse proxy; the module
  warns if you do not.

With a token set, a non-loopback caller presents it as `Authorization: Bearer …`,
`?token=…`, or the cookie that `GET /giveaway?token=…` mints (30 days, HttpOnly)
— open that URL once on the phone and the buttons work thereafter. Loopback is
never asked for it, so `multichat giveaway draw` on the host is unaffected.

`controlAccess` covers `POST /api/giveaway` only. `/api/youtube-key`,
`/api/fake` and `/api/rewards` stay loopback-only regardless.

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

| Option                             | Type                                                    | Default                | Description                                                                                    |
| ---------------------------------- | ------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `enable`                           | bool                                                    | `false`                | Enable the service                                                                             |
| `package`                          | package                                                 | built from `build.nix` | Override the multichat package                                                                 |
| `port`                             | port                                                    | `8080`                 | Web interface port                                                                             |
| `host`                             | string                                                  | `"127.0.0.1"`          | Bind address — must be `"127.0.0.1"` or `"0.0.0.0"`                                            |
| `openFirewall`                     | bool                                                    | `false`                | Open `port` in the firewall                                                                    |
| `controlAccess`                    | `"loopback"` \| `"lan"` \| `"any"`                      | `"loopback"`           | Who may drive the giveaway draw (see below)                                                    |
| `controlToken`                     | string                                                  | `""`                   | Control token inline (Nix store — prefer `controlTokenFile`)                                   |
| `controlTokenFile`                 | path                                                    | `null`                 | File with the raw control token; staged via `LoadCredential`                                   |
| `twitch.channels`                  | `[string]`                                              | `[]`                   | Twitch channel names (chat, anonymous)                                                         |
| `twitch.eventsub.clientId`         | string                                                  | `""`                   | Twitch app Client ID for alerts (not secret)                                                   |
| `twitch.eventsub.clientSecret`     | string                                                  | `""`                   | Client Secret inline (Nix store — prefer `clientSecretFile`)                                   |
| `twitch.eventsub.clientSecretFile` | path                                                    | `null`                 | File with the raw Client Secret; staged via `LoadCredential`                                   |
| `twitch.eventsub.channels`         | `[{login,broadcasterId,refreshToken,refreshTokenFile}]` | `[]`                   | Channels to alert on (from `multichat login`)                                                  |
| `youtube.apiKey`                   | string                                                  | `""`                   | API key inline (stored in the Nix store — prefer `apiKeyFile`)                                 |
| `youtube.apiKeyFile`               | path                                                    | `null`                 | Path to a file containing just the raw key; takes precedence over `apiKey`                     |
| `youtube.channels`                 | `[{handle,channelId,videoId}]`                          | `[]`                   | YouTube channels                                                                               |
| `alerts.activeTheme`               | string                                                  | `""`                   | Name of the active `/alerts` theme (empty = default look)                                      |
| `alerts.themes`                    | `[{name,style,events,options}]`                         | `[]`                   | Named alert themes; `style` = `default` or `company-memo`                                      |
| `giveaway.enable`                  | bool                                                    | `false`                | Enable the Twitch `!enter` giveaway / prize draw (CS2-style case reel)                         |
| `giveaway.channel`                 | string                                                  | `""`                   | Twitch channel (login) the giveaway runs on (in `twitch.channels`)                             |
| `giveaway.prefix`                  | string                                                  | `"!"`                  | Command prefix                                                                                 |
| `giveaway.command`                 | string                                                  | `"enter"`              | Command word (default gives `!enter`)                                                          |
| `giveaway.requireFollow`           | bool                                                    | `true`                 | Gate entries on a live follow check (needs the channel in `twitch.eventsub`)                   |
| `giveaway.replies`                 | bool                                                    | `true`                 | Reply in chat as the broadcaster (needs re-`login` — see below)                                |
| `giveaway.firstN`                  | int                                                     | `0`                    | Campaign: entrants #1..N are all guaranteed winners (0 = off), e.g. `500`                      |
| `giveaway.followerStep`            | int                                                     | `0`                    | Arm draw credits every N new followers via EventSub (0 = no tracking), e.g. `100`              |
| `giveaway.milestoneDraws`          | int                                                     | `1`                    | Draw credits armed per milestone, e.g. `10`                                                    |
| `giveaway.messages`                | `attrs of string`                                       | `{}`                   | Optional reply templates incl. `enteredPool`/`milestone`; placeholders `{user}`/`{number}`/…   |
| `giveaway.timezone`                | string                                                  | `"America/Denver"`     | IANA zone the compiled report renders turn times in (DST-aware — not a fixed `MST`)            |
| `giveaway.terms.enable`            | bool                                                    | `false`                | Gate entry on accepting the terms; needs `replies` (the prompt is a chat reply)                |
| `giveaway.terms.command`           | string                                                  | `"accept"`             | Accept command word after `prefix`, giving `!accept`                                           |
| `giveaway.terms.version`           | string                                                  | `"1"`                  | Bump to invalidate every acceptance on file                                                    |
| `giveaway.terms.url`               | string                                                  | `""`                   | Where the full T&C is published — multichat does **not** host it                               |
| `giveaway.disposition.enable`      | bool                                                    | `false`                | Let the winner pick their pull's fate in chat                                                  |
| `giveaway.disposition.{mail,donate,destroy,pass}` | string                                   | the same word          | The chat words for each choice; `pass` also advances the draw                                  |
| `integrations.callbackToken`       | string                                                  | `""`                   | Callback bearer inline (Nix store — prefer `callbackTokenFile`)                                |
| `integrations.callbackTokenFile`   | path                                                    | `null`                 | File with the raw callback bearer; staged via `LoadCredential`                                 |
| `integrations.subscribers`         | `[{name,adapter,baseUrl,events,enabled,token,tokenFile,packSize}]` | `[]`        | External tools to push giveaway events to (see below)                                          |
| `channelPoints.enable`             | bool                                                    | `false`                | Channel-point chaos: managed Twitch rewards → cobblemon-overlay effects (see below)            |
| `channelPoints.channel`            | string                                                  | `""`                   | Twitch login the rewards live on (must be in `twitch.eventsub.channels`)                       |
| `channelPoints.overlayUrl`         | string                                                  | `"http://127.0.0.1:8082"` | The cobblemon-overlay's base URL; its host joins `--allow-net`                              |
| `channelPoints.overlayTokenFile`   | path                                                    | `null`                 | File with the overlay's effects bearer; staged via `LoadCredential`                            |
| `channelPoints.ttlSec`             | int (30–3600)                                           | `600`                  | How long a redemption may wait to run before it is refunded                                    |
| `channelPoints.autoPause`          | bool                                                    | `true`                 | Pause the rewards on Twitch while the game isn't taking effects                                |
| `channelPoints.announce`           | bool                                                    | `true`                 | A highlighted system chat row per redemption                                                   |
| `channelPoints.rewards`            | `null` or `[{key,title,cost,prompt,effect,params,cooldownSec,maxPerStream,maxPerUserPerStream,color,enabled}]` | `null` | The catalogue; `null` = the built-in 14 rewards               |

See [Giveaway mode](configuration.md#giveaway-mode) for the full behavior
(including the campaign mode the 500/100/10 example configures). Three gotchas
the module warns about at build time: `giveaway.requireFollow` needs the channel
authorized in `twitch.eventsub.channels` (the follow check uses its broadcaster
token — otherwise entries fail closed); `giveaway.followerStep` also needs that
EventSub connection (follow events feed the milestone counter); and
`giveaway.replies` requires re-running `multichat login` so the token gains the
new `user:write:chat` scope (tokens minted before this release don't carry it).

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

**Re-login for a new scope.** The flip side: when a release needs a scope the
current token lacks (`user:write:chat` for giveaway replies,
`channel:manage:redemptions` for channel points), a fresh `multichat login` is
ignored until the persisted token goes. In order: run `multichat login` as the
broadcaster; put the new refresh token into the `refreshTokenFile` secret (the
password-manager item — Proton Pass, agenix, sops — that feeds it); then
`sudo rm /var/lib/private/multichat/twitch-refresh-<broadcasterId>` (the unit
re-installs the seed only when that file is missing, so it must already be the
new one) and `systemctl restart multichat`. Full walk-through:
[Adding a scope later](configuration.md#4-adding-a-scope-later-re-login).

## Integrations (chat-cards)

`integrations.subscribers` pushes giveaway-lifecycle events to external tools,
and `/api/turn-report` takes results back. The pair completes a loop with
[chat-cards](https://github.com/The-Company-Inc-Nerds/chat-cards): a draw opens a
physical card pack under the winner's name, and the cards pulled — with their
prices — come back onto that winner's turn.

```nix
services.multichat = {
  enable = true;
  port = 8081;
  giveaway = { enable = true; channel = "yourchannel"; };
  integrations.subscribers = [{
    name = "chat-cards";
    adapter = "chat-cards";
    baseUrl = "http://127.0.0.1:8787";
    events = [ "giveaway.turn.start" ];
    packSize = 5;
  }];
};

services.chat-cards = {
  enable = true;
  port = 8787;
  report.url = "http://127.0.0.1:8081/api/turn-report";
};
```

Both halves are needed: without the subscriber no pack is ever opened, and
without `report.url` nothing comes back. `/api/turn-report` also needs
`giveaway.enable` — with no giveaway running it answers `501`, and the module
warns at build time if subscribers are configured without one.

The field-by-field reference is in
[Integrations](configuration.md#integrations); the module options map onto it
one-to-one.

### Tokens and the store

`integrations.callbackTokenFile` and a subscriber's `tokenFile` are staged via
`LoadCredential` and exported into the service's environment at start, exactly
like the YouTube key. Their `settings.json` counterparts are written as `""`, so
the world-readable store copy carries no secret. The inline `callbackToken` /
`token` options do land in the store, and the module warns when they are set.

Neither token is needed when both services share a machine: `/api/turn-report`
accepts unauthenticated loopback requests, and a same-box chat-cards typically
runs without a token of its own.

### `--allow-net` and subscriber hosts

The packaged deno wrapper runs with an `--allow-net` allow-list, so a subscriber
on a host that isn't on it would have every delivery denied. The default
`package` handles this: it passes each subscriber's `baseUrl` host to
`build.nix`'s `extraNetHosts`, so configuring a subscriber is enough. **Override
`package` and you take that over** — build it with `extraNetHosts` yourself, or
outbound calls fail.

## Channel points (cobblemon-overlay)

`channelPoints` turns Twitch channel-point redemptions into game effects: the
module's service creates and owns the rewards, queues each redemption on the
cobblemon-overlay running on the same host, and fulfils or refunds it on Twitch
from the outcome. Behaviour, the catalogue and the CLI are in
[Channel points](configuration.md#channel-points).

```nix
services.multichat = {
  enable = true;
  port = 8081;
  twitch.channels = [ "thecompanyinc" ];
  twitch.eventsub = {
    clientId = "your-twitch-app-client-id";
    clientSecretFile = "/run/secrets/twitch-client-secret";
    channels = [{
      login = "thecompanyinc";
      broadcasterId = "12345678";
      refreshTokenFile = "/run/secrets/twitch-refresh-thecompanyinc";
    }];
  };
  channelPoints = {
    enable = true;
    channel = "thecompanyinc";
    overlayUrl = "http://127.0.0.1:8082";   # the overlay on the same host
    # overlayTokenFile = "/run/secrets/cobblemon-overlay-effects-token";
    # rewards = null;                       # the built-in catalogue
  };
};
```

- **The overlay first.** Deploy the cobblemon-overlay with its effect routes
  before enabling this — an overlay without them answers `404`, which counts as
  a refusal, so every redemption would be refunded. Then multichat, then the
  mod.
- **Token.** `overlayTokenFile` is staged via `LoadCredential` and exported as
  `MULTICHAT_EFFECTS_TOKEN`; the settings file carries `overlayToken = ""`. Set
  it to the same secret as the overlay's `effects.tokenFile`. Without one the
  overlay's loopback check is the only gate — fine for a same-host overlay.
- **Scope.** The channel's token must carry `channel:manage:redemptions`. A
  token minted before this release doesn't — follow the re-login above; the
  service logs a loud warning naming the exact state file until it's done.
- **Control.**
  `multichat rewards status|sync|pause|resume|pending|refund|simulate` talks to
  the loopback-only `POST /api/rewards`; `controlAccess` never widens it.
- **`--allow-net`.** A remote `overlayUrl` host is added to the wrapper's
  allow-list by the default `package`, like an integration subscriber.

## Alert themes

`alerts.themes` is a registry of named looks for the `/alerts` OBS overlay, and
`alerts.activeTheme` selects the one in effect (empty = the default card). Each
theme sets a built-in `style` (`default`, or `company-memo` — an office memo
that redacts one of its three words before it disappears; subs render as
hiring paperwork with tier job titles, raids as an FBI search warrant under
police lights, and cheers as a petty-cash receipt, each with a stamped
verdict), an optional `events` list limiting which shoutout kinds it restyles
(empty = all; others fall back to the default card), and an `options` attrset
of style knobs. Example — the flagship memo on its Twitch shoutouts:

```nix
services.multichat.alerts = {
  activeTheme = "The Company, Inc";
  themes = [
    { name = "The Company, Inc"; style = "company-memo"; events = [ "follow" "sub" "raid" "cheer" ]; }
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
  `broadcasterId` (needed to name the persisted token file);
- `giveaway.enable` is set without a `giveaway.channel`.

It emits a build-time **warning** when the insecure inline `youtube.apiKey`,
`twitch.eventsub.clientSecret`, `controlToken`, or a channel's inline
`refreshToken` is used; when `controlAccess = "any"` is set with no control token
(anyone who can reach the port could draw); when `controlAccess` is widened while
`host` is still `"127.0.0.1"` (nothing off-box can reach the server at all);
when both `twitch.channels` and `youtube.channels` are empty (the viewer would
show no chat); when `youtube.channels` is set but no build-time key is given (a
reminder that the key can be supplied at runtime — not an error); when
`twitch.eventsub.channels` is set but `clientId` is empty (alerts would be
skipped); when `alerts.activeTheme` names no theme in `alerts.themes` (the
overlay falls back to the default look); when the `giveaway.channel` isn't in
`twitch.channels` (its chat won't be joined); when `giveaway.requireFollow` is
on but the channel isn't in `twitch.eventsub.channels` (follow checks can't
run); when `giveaway.followerStep` is set but the channel isn't in
`twitch.eventsub.channels` (follow events can't be received, so milestone
progress won't advance); or when `giveaway.replies` is on (a reminder to re-run
`multichat login` for the `user:write:chat` scope).

Integrations add three assertions: a subscriber without a `baseUrl` (nothing to
deliver to), a `tokenFile` without a `name` (the name is what identifies the
credential and its env var), and two subscriber names that collapse to the same
env var — `"chat-cards"` and `"chat cards"` both become
`MULTICHAT_INTEGRATION_TOKEN_CHAT_CARDS`, so one would silently take the other's
token. Inline `integrations.callbackToken` / subscriber `token` warn like the
other in-store secrets, and configuring subscribers with `giveaway.enable = false`
warns too: the bus only carries giveaway events, so nothing would ever be sent.

Channel points add three assertions — `channelPoints.enable` without a
`channelPoints.channel`, a reward title outside 1–45 characters or a prompt over
200 (Twitch rejects them), and duplicate reward keys or titles (titles compared
case-insensitively) — on top of the option types themselves (`cooldownSec`
60–604800, `ttlSec` 30–3600, `color` as `#RRGGBB`). It warns when the
channel-points channel isn't in `twitch.eventsub.channels` (nothing can reach
Twitch; only `rewards simulate` works), and always reminds you that the
channel's token needs `channel:manage:redemptions` — naming the persisted token
file to delete for the re-login. The subscribers-without-a-giveaway warning now
also says that channel-point redemptions don't ride the integration bus.

The terms gate warns in two more cases: with `replies` off (the "you must accept
first" prompt is a chat reply, so entrants would be refused in silence), and with
neither `terms.url` nor a custom `messages.termsRequired` (the built-in prompt
renders an empty `()` where the link belongs). `terms` and `disposition` are
emitted into `settings.json` only when enabled — the app reads a present block as
"configured on purpose", so a disabled one is never written.

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

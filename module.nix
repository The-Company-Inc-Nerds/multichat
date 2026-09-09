# NixOS service module for multichat. Portable — importable without the flake:
#   imports = [ (import ./module.nix) ];
# The package defaults to ./build.nix so the module works standalone.
{ config, lib, pkgs, ... }:
let
  cfg = config.services.multichat;
  esCfg = cfg.twitch.eventsub;
  intCfg = cfg.integrations;

  # Subscribers whose outbound bearer token is staged from a file.
  intTokenFiles = builtins.filter (s: s.tokenFile != null) intCfg.subscribers;

  # Uppercase, every run of non-alphanumerics collapsed to one "_", no leading or
  # trailing "_". Used for both the env-var name and the systemd credential id, so
  # the credential id is always a safe filename whatever the subscriber is called.
  intTokenSlug = name:
    lib.concatStringsSep "_"
      (builtins.filter (p: builtins.isString p && p != "")
        (builtins.split "[^A-Z0-9]+" (lib.toUpper name)));

  # Must mirror subscriberTokenEnvVar() in src/integrations.ts exactly. If the two
  # ever disagree the token is exported under a name the app doesn't read, and the
  # subscriber silently calls out unauthenticated.
  intTokenEnv = name: "MULTICHAT_INTEGRATION_TOKEN_" + intTokenSlug name;

  intTokenCred = name: "integration-token-" + intTokenSlug name;

  # Host part of a subscriber's baseUrl, for the package's --allow-net allow-list.
  # Scheme and any port/path are dropped (Deno matches a bare host on any port).
  # Bracketed IPv6 literals aren't handled — set `package` yourself for those.
  urlHost = url:
    lib.head (lib.splitString ":"
      (lib.head (lib.splitString "/" (lib.last (lib.splitString "://" url)))));

  subscriberHosts = lib.unique (map (s: urlHost s.baseUrl) intCfg.subscribers);

  # EventSub channels whose seed refresh token is staged from a file (needs the
  # broadcasterId to name the persisted state file).
  esTokenFiles = builtins.filter
    (ch: ch.refreshTokenFile != null && ch.broadcasterId != "")
    esCfg.channels;

  # systemd LoadCredential entries for every file-based secret.
  loadCreds =
    lib.optional (cfg.youtube.apiKeyFile != null)
      "youtube-api-key:${toString cfg.youtube.apiKeyFile}"
    ++ lib.optional (esCfg.clientSecretFile != null)
      "twitch-client-secret:${toString esCfg.clientSecretFile}"
    ++ map
      (ch: "twitch-refresh-${ch.broadcasterId}:${toString ch.refreshTokenFile}")
      esTokenFiles
    ++ lib.optional (cfg.controlTokenFile != null)
      "control-token:${toString cfg.controlTokenFile}"
    ++ lib.optional (intCfg.callbackTokenFile != null)
      "integration-callback-token:${toString intCfg.callbackTokenFile}"
    ++ map
      (s: "${intTokenCred s.name}:${toString s.tokenFile}")
      intTokenFiles;

  # Inline (non-file) secrets passed as env. These land in the Nix store /
  # `systemctl show` — the *File options are preferred for real secrets.
  envList =
    lib.optional (cfg.youtube.apiKeyFile == null && cfg.youtube.apiKey != "")
      "YOUTUBE_API_KEY=${lib.replaceStrings [ "%" ] [ "%%" ] cfg.youtube.apiKey}"
    ++ lib.optional (esCfg.clientSecretFile == null && esCfg.clientSecret != "")
      "TWITCH_CLIENT_SECRET=${lib.replaceStrings [ "%" ] [ "%%" ] esCfg.clientSecret}";

  # Settings without secrets — the YouTube key comes from YOUTUBE_API_KEY and the
  # Twitch client secret from TWITCH_CLIENT_SECRET at runtime.
  settingsFile = pkgs.writeText "multichat-settings.json" (builtins.toJSON {
    server = {
      port = cfg.port;
      host = cfg.host;
      controlAccess = cfg.controlAccess;
      # File-sourced like the other secrets: blanked here, exported from the unit.
      controlToken =
        if cfg.controlTokenFile != null then "" else cfg.controlToken;
    };
    twitch = {
      channels = cfg.twitch.channels;
      eventsub = {
        clientId = esCfg.clientId;
        clientSecret = "";
        channels = map
          (ch: { inherit (ch) login broadcasterId refreshToken; })
          esCfg.channels;
      };
    };
    youtube = {
      apiKey = "";
      channels = map (ch: { inherit (ch) channelId handle videoId; }) cfg.youtube.channels;
    };
    alerts = {
      activeTheme = cfg.alerts.activeTheme;
      themes = map (t: {
        inherit (t) name style options;
        events = t.events;
      }) cfg.alerts.themes;
    };
    giveaway = {
      enabled = cfg.giveaway.enable;
      inherit (cfg.giveaway)
        channel prefix command requireFollow replies messages
        firstN followerStep milestoneDraws timezone;
    }
    # Both blocks are omitted entirely when off, rather than emitted with a false
    # flag: the app reads a *present* block as "this gate was configured on
    # purpose", so shipping a disabled one is more surprising than shipping none.
    // lib.optionalAttrs cfg.giveaway.terms.enable {
      terms = {
        required = true;
        inherit (cfg.giveaway.terms) command version url;
      };
    }
    // lib.optionalAttrs cfg.giveaway.disposition.enable {
      disposition = {
        enabled = true;
        inherit (cfg.giveaway.disposition) mail donate destroy pass;
      };
    };
    # File-sourced tokens are blanked here and supplied from the environment at
    # runtime (see the unit script), so this store-readable file holds no secret.
    integrations = {
      callbackToken =
        if intCfg.callbackTokenFile != null then "" else intCfg.callbackToken;
      subscribers = map
        (s: {
          inherit (s) name adapter baseUrl events enabled packSize;
          token = if s.tokenFile != null then "" else s.token;
        })
        intCfg.subscribers;
    };
  });
in
{
  options.services.multichat = {
    enable = lib.mkEnableOption "multichat combined chat viewer";

    package = lib.mkOption {
      type = lib.types.package;
      default = import ./build.nix {
        inherit pkgs;
        extraNetHosts = subscriberHosts;
      };
      defaultText = lib.literalExpression
        "import ./build.nix { inherit pkgs; extraNetHosts = <integration subscriber hosts>; }";
      description = ''
        The multichat package to use. The default is built with each
        {option}`integrations.subscribers` host added to the deno wrapper's
        --allow-net allow-list, so the outbound integration bus can reach them.
        Override it and you must widen that list yourself (build.nix takes an
        `extraNetHosts` argument) or every outbound call is denied by Deno.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Port the web interface listens on.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Bind address for the web interface. Must be "127.0.0.1" (loopback) or
        "0.0.0.0" (all interfaces): the packaged deno wrapper restricts
        --allow-net to those addresses, so binding any other host is denied by
        Deno's permission layer. Use "0.0.0.0" + openFirewall to expose it.
      '';
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the configured port in the firewall.";
    };

    controlAccess = lib.mkOption {
      type = lib.types.enum [ "loopback" "lan" "any" ];
      default = "loopback";
      example = "lan";
      description = ''
        Who may drive the giveaway control endpoint (`POST /api/giveaway`) —
        the open/close/draw/reset buttons on `/giveaway`, and `multichat
        giveaway <verb>`.

        - "loopback" (default): only the machine running the service. A browser
          on another PC or a phone gets 403 when it presses Draw.
        - "lan": also accepts private and link-local peers (RFC1918, CGNAT,
          169.254/16, fc00::/7, fe80::/10), so anyone on the home network can
          run the draw. Public addresses are still refused, so this stays safe
          on a box whose port is only reachable from the LAN — but note it is an
          address check, not authentication: every device on that network can
          draw. Add controlTokenFile if the network is shared.
        - "any": no address check. Only sensible together with a control token
          or an authenticating reverse proxy.

        Read-only surfaces (`/`, `/overlay`, `/alerts`, `/giveaway`, `/events`)
        are unauthenticated regardless — this option gates the buttons, not the
        pages. The other two control endpoints (`/api/youtube-key`, `/api/fake`)
        stay loopback-only: they set a secret and forge events.
      '';
    };

    controlToken = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = ''
        Shared secret a non-loopback control request must present, as a bearer
        header, `?token=`, or the cookie `/giveaway?token=…` sets. Empty (the
        default) means controlAccess alone decides. Loopback is never asked for
        it, so the local CLI keeps working.

        Ends up in the Nix store and in `systemctl show multichat` — use
        controlTokenFile for a real secret.
      '';
    };

    controlTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/multichat-control-token";
      description = ''
        Path to a file containing the raw control token. Staged via systemd
        LoadCredential and exported as MULTICHAT_CONTROL_TOKEN, so it never
        enters the Nix store. Takes precedence over controlToken.
      '';
    };

    twitch.channels = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = lib.literalExpression ''[ "streamer1" "streamer2" ]'';
      description = "Twitch channel names (lowercase) to monitor. Chat works anonymously.";
    };

    twitch.eventsub.clientId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = ''
        Twitch application Client ID for EventSub alerts (follows, cheers, subs,
        raids). Not a secret. Leave empty (and channels empty) to disable EventSub
        and run Twitch chat anonymously.
      '';
    };

    twitch.eventsub.clientSecret = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Twitch Client Secret as a plain string. Ends up in the Nix store — use clientSecretFile for production secrets.";
    };

    twitch.eventsub.clientSecretFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/twitch-client-secret";
      description = ''
        Path to a file containing the raw Twitch Client Secret. Staged via systemd
        LoadCredential (mode 0400, service-owned) and exported as TWITCH_CLIENT_SECRET,
        so it only needs to be root-readable at start. Takes precedence over clientSecret.
      '';
    };

    twitch.eventsub.channels = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          login = lib.mkOption {
            type = lib.types.str;
            description = "Channel login name (same value as in twitch.channels).";
          };
          broadcasterId = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = "Numeric broadcaster user id (from `multichat twitch-login`). Required when using refreshTokenFile.";
          };
          refreshToken = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = "Seed OAuth refresh token as a plain string. Ends up in the Nix store — use refreshTokenFile for production.";
          };
          refreshTokenFile = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            example = "/run/secrets/twitch-refresh-streamer1";
            description = ''
              Path to a file containing the raw seed refresh token. Staged via
              LoadCredential and installed into the StateDirectory on first start
              (only when not already present, so the rotated token is never clobbered).
              Requires broadcasterId. Takes precedence over refreshToken.
            '';
          };
        };
      });
      default = [ ];
      example = lib.literalExpression ''
        [ { login = "streamer1"; broadcasterId = "12345678"; refreshTokenFile = "/run/secrets/twitch-refresh-streamer1"; } ]
      '';
      description = ''
        Twitch channels to receive EventSub alerts for. Obtain each channel's
        broadcasterId + refresh token with `multichat twitch-login`.
      '';
    };

    youtube.apiKey = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      description = "YouTube Data API v3 key as a plain string. This value ends up in the Nix store — use apiKeyFile for production secrets.";
    };

    youtube.apiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/youtube-api-key";
      description = ''
        Path to a file containing the raw YouTube API key (just the key value, no KEY=VALUE prefix).
        The file is staged via systemd's LoadCredential into a private tmpfs (mode 0400, owned by the
        service), so it only needs to be readable by root at service start — it does NOT need to be
        world- or group-readable. Compatible with agenix, sops-nix, systemd-creds, and any secrets
        manager that writes plain files. Takes precedence over youtube.apiKey when both are set.
      '';
    };

    youtube.channels = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          handle = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = "YouTube channel handle, e.g. @channelname.";
          };
          channelId = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = "YouTube channel ID, e.g. UCxxxxxxxxxxxxxxxxxxxxxxxx.";
          };
          videoId = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = "Specific video ID — skips live-stream lookup.";
          };
        };
      });
      default = [ ];
      example = lib.literalExpression ''
        [
          { handle = "@channelhandle"; }
          { channelId = "UCxxxxxxxxxxxxxxxxxxxxxx"; }
          { videoId = "dQw4w9WgXcQ"; }
        ]
      '';
      description = "YouTube channels to monitor. Set handle, channelId, or videoId.";
    };

    alerts.activeTheme = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "The Company, Inc";
      description = ''
        Name of the theme to apply on the /alerts overlay. Empty = the default
        look. Must match a `name` in alerts.themes. Can be overridden per OBS
        source with a ?theme=NAME query param.
      '';
    };

    alerts.themes = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          name = lib.mkOption {
            type = lib.types.str;
            description = "Selection/display name for this theme.";
          };
          style = lib.mkOption {
            type = lib.types.str;
            default = "default";
            description = ''
              Built-in visual engine: "default" (the standard card) or
              "company-memo" (an office memo that redacts a word before it leaves).
            '';
          };
          events = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            example = [ "follow" ];
            description = ''
              Shoutout kinds this theme restyles (cheer, sub, raid, follow,
              superchat, supersticker, membership). Empty = all of them; kinds not
              listed fall back to the default card.
            '';
          };
          options = lib.mkOption {
            type = lib.types.attrsOf (lib.types.oneOf [
              lib.types.str
              lib.types.int
              lib.types.bool
            ]);
            default = { };
            example = lib.literalExpression ''{ paper = "#f4efdc"; hold = 4500; redact = true; }'';
            description = "Style-specific options passed to the visual engine.";
          };
        };
      });
      default = [ ];
      example = lib.literalExpression ''
        [ { name = "The Company, Inc"; style = "company-memo"; events = [ "follow" ]; } ]
      '';
      description = "Named alert themes for the /alerts overlay; select one with alerts.activeTheme.";
    };

    integrations.callbackToken = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = ''
        Bearer token an external tool must present to POST results back to
        `/api/turn-report`. With no token set that endpoint accepts loopback
        requests only — which is all two services on the same machine need.

        Ends up in the Nix store and in `systemctl show multichat` — use
        callbackTokenFile for a real secret.
      '';
    };

    integrations.callbackTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/multichat-callback-token";
      description = ''
        Path to a file containing the raw callback token. Staged via systemd
        LoadCredential and exported as MULTICHAT_CALLBACK_TOKEN, so it never
        enters the Nix store. Takes precedence over callbackToken.
      '';
    };

    integrations.subscribers = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          name = lib.mkOption {
            type = lib.types.str;
            default = "";
            example = "chat-cards";
            description = ''
              Identifies this subscriber in logs and names its token env var.
              Must be unique across subscribers.
            '';
          };

          adapter = lib.mkOption {
            type = lib.types.enum [ "webhook" "chat-cards" ];
            default = "webhook";
            description = ''
              How events are delivered. "webhook" POSTs a generic
              `{event, ts, data}` envelope to baseUrl. "chat-cards" maps events
              onto the chat-cards HTTP API — today `giveaway.turn.start` opens a
              pack for the drawn winner via `POST baseUrl/api/pack`, carrying the
              turn id as `ref` so the pack report can be correlated back.
            '';
          };

          baseUrl = lib.mkOption {
            type = lib.types.str;
            example = "http://127.0.0.1:8787";
            description = ''
              Where to deliver. For the webhook adapter this is the exact POST
              target; for chat-cards it is the service root (paths are appended).
              A trailing slash is trimmed. This host is added to the deno
              wrapper's --allow-net allow-list via the default `package`.
            '';
          };

          events = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "*" ];
            example = [ "giveaway.turn.start" ];
            description = ''
              Event types to deliver; "*" means all of them. Known types:
              giveaway.turn.start, giveaway.turn.disposition, giveaway.turn.end,
              giveaway.entrant.added, giveaway.terms.accepted. Events an adapter
              has no mapping for are skipped regardless.
            '';
          };

          enabled = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Whether to deliver to this subscriber at all.";
          };

          token = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = ''
              Bearer token sent with every delivery, when the target requires
              one. Ends up in the Nix store — use tokenFile for a real secret.
            '';
          };

          tokenFile = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            example = "/run/secrets/chat-cards-token";
            description = ''
              Path to a file containing the raw bearer token. Staged via systemd
              LoadCredential and exported to the service, so it never enters the
              Nix store. Requires a non-empty `name`. Takes precedence over token.
            '';
          };

          packSize = lib.mkOption {
            type = lib.types.ints.unsigned;
            default = 0;
            example = 5;
            description = ''
              chat-cards adapter only: how many cards the opened pack holds.
              0 leaves it to chat-cards' own default pack size.
            '';
          };
        };
      });
      default = [ ];
      example = lib.literalExpression ''
        [ { name = "chat-cards"; adapter = "chat-cards"; baseUrl = "http://127.0.0.1:8787"; packSize = 5; } ]
      '';
      description = ''
        External tools to push giveaway-lifecycle events to. The chat-cards
        adapter completes a loop: a draw opens a pack in chat-cards, and
        chat-cards POSTs the pulled cards and their value back to
        `/api/turn-report`, where they land on the winner's turn in the ledger.
        Point chat-cards at this server with `services.chat-cards.report.url`.
      '';
    };

    giveaway.enable =
      lib.mkEnableOption "the Twitch !enter giveaway / prize-wheel";

    giveaway.channel = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "streamer1";
      description = ''
        The single Twitch channel (login, lowercase) the giveaway runs on. Must be
        in twitch.channels (so its chat is joined); for requireFollow it must also
        be in twitch.eventsub.channels (the follow check uses the broadcaster token).
      '';
    };

    giveaway.prefix = lib.mkOption {
      type = lib.types.str;
      default = "!";
      description = "Command prefix, e.g. \"!\".";
    };

    giveaway.command = lib.mkOption {
      type = lib.types.str;
      default = "enter";
      description = ''
        Command word after the prefix. With the defaults, viewers type "!enter".
      '';
    };

    giveaway.requireFollow = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Only add entrants who follow the channel, checked live via Helix
        (moderator:read:followers — already an EventSub scope). Requires the channel
        to be in twitch.eventsub.channels; if it isn't, follow checks can't run and
        entries fail closed. Set false to let anyone who types the command enter.
      '';
    };

    giveaway.replies = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Post confirmation/denial/winner messages back to Twitch chat as the
        broadcaster. Needs the user:write:chat scope — re-run `multichat login` for
        the giveaway channel so its token carries it (tokens minted before this
        release don't). Set false to run silently (the /giveaway page still works).
      '';
    };

    giveaway.timezone = lib.mkOption {
      type = lib.types.str;
      default = "America/Denver";
      example = "America/New_York";
      description = ''
        IANA timezone the compiled winners/turns report renders turn-start times
        in. Defaults to Mountain Time (DST-aware — do NOT use a fixed "MST",
        which would be an hour off for half the year). An unrecognised zone falls
        back to the default at runtime rather than failing.
      '';
    };

    giveaway.terms.enable = lib.mkEnableOption ''
      a terms command on the giveaway. With it on, viewers who type the terms
      command (e.g. `!terms`) get the `terms` reply — a link to the published
      T&C. This is NOT an acceptance gate: entry is never blocked on it
    '';

    giveaway.terms.command = lib.mkOption {
      type = lib.types.str;
      default = "terms";
      description = ''
        Command word viewers type to get the terms link, after the same
        {option}`giveaway.prefix` — so the default gives `!terms`.
      '';
    };

    giveaway.terms.version = lib.mkOption {
      type = lib.types.str;
      default = "1";
      example = "2";
      description = ''
        Retained for config compatibility; no longer affects entry (there is no
        acceptance ledger anymore). Safe to leave at the default.
      '';
    };

    giveaway.terms.url = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://example.com/giveaway-terms";
      description = ''
        Where the full terms live. multichat does NOT host them — this string is
        substituted into the `terms` chat reply as `{terms}`, so it must point at
        a page you publish yourself.
      '';
    };

    giveaway.disposition.enable = lib.mkEnableOption ''
      the winner-turn disposition commands. The current winner can say one of the
      words below in chat (with or without the command prefix) to choose what
      happens to their pull; each choice is recorded and tallied for the campaign
      report
    '';

    giveaway.disposition.mail = lib.mkOption {
      type = lib.types.str;
      default = "mail";
      description = "Word that records the cards as being mailed to the winner.";
    };

    giveaway.disposition.donate = lib.mkOption {
      type = lib.types.str;
      default = "donate";
      description = "Word that records the cards as donated (e.g. to a shop's free pile).";
    };

    giveaway.disposition.destroy = lib.mkOption {
      type = lib.types.str;
      default = "destroy";
      description = "Word that records the cards as destroyed on air.";
    };

    giveaway.disposition.pass = lib.mkOption {
      type = lib.types.str;
      default = "pass";
      description = ''
        Word that carries the cards to the next winner's turn and advances the
        draw. Unlike the other three this one changes the giveaway's state, not
        just the tally.
      '';
    };

    giveaway.messages = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        { entered = "🎉 @{user} you're pack #{number} of 500!"; winner = "🎉 @{user} won a pack!"; }
      '';
      description = ''
        Optional reply templates (keys: entered, notFollowing, alreadyEntered,
        winner, enteredPool, milestone). "{user}" is the entrant's display name;
        entry replies also fill "{number}" (entry #) and "{remaining}"
        (guaranteed slots left), and milestone fills "{count}"/"{milestone}"/
        "{draws}". Unset keys fall back to built-in defaults.
      '';
    };

    giveaway.firstN = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 0;
      example = 500;
      description = ''
        Campaign mode: entrants #1..firstN are ALL guaranteed winners — each
        draw just picks who's next (e.g. "the first 500 entrants each get a
        card pack"). Later entrants pool up for milestone draws. 0 = off.
      '';
    };

    giveaway.followerStep = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 0;
      example = 100;
      description = ''
        Arm milestoneDraws advisory draw credits every this many NEW followers
        (counted live via the channel's EventSub connection, deduped). Shown as
        a progress bar on /giveaway and ?overlay&progress. 0 = no tracking.
      '';
    };

    giveaway.milestoneDraws = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 1;
      example = 10;
      description = ''
        Draw credits armed per follower milestone crossed (e.g. "every 100 new
        followers we open 10 more packs"). Advisory — the draw button is never
        hard-blocked.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all
          (ch: ch.handle != "" || ch.channelId != "" || ch.videoId != "")
          cfg.youtube.channels;
        message = "services.multichat.youtube.channels: every entry must set at least one of handle, channelId, or videoId.";
      }
      {
        # NB: a YouTube key is NOT required at build time — it can be supplied to
        # the running server with `multichat set-youtube-key` and is persisted in
        # the StateDirectory. The missing-key case is a warning below, not an error.
        assertion = builtins.elem cfg.host [ "127.0.0.1" "0.0.0.0" ];
        message = ''services.multichat.host must be "127.0.0.1" or "0.0.0.0": the packaged deno wrapper restricts --allow-net to those addresses, so binding any other host is denied by Deno's permission layer.'';
      }
      {
        assertion = lib.all (ch: ch.login != "") esCfg.channels;
        message = "services.multichat.twitch.eventsub.channels: every entry must set a login.";
      }
      {
        assertion = lib.all (ch: ch.refreshTokenFile == null || ch.broadcasterId != "") esCfg.channels;
        message = "services.multichat.twitch.eventsub.channels: broadcasterId is required when refreshTokenFile is set (it names the persisted token file).";
      }
      {
        assertion = !cfg.giveaway.enable || cfg.giveaway.channel != "";
        message = "services.multichat.giveaway.enable requires giveaway.channel (the Twitch login the giveaway runs on).";
      }
      {
        assertion = lib.all (s: s.baseUrl != "") intCfg.subscribers;
        message = "services.multichat.integrations.subscribers: every entry must set a baseUrl (a subscriber with nowhere to deliver is dropped at runtime).";
      }
      {
        assertion = lib.all (s: s.tokenFile == null || s.name != "") intCfg.subscribers;
        message = "services.multichat.integrations.subscribers: name is required when tokenFile is set (it names the credential and the env var the app reads).";
      }
      {
        # Names map to env vars by collapsing non-alphanumerics, so "chat-cards"
        # and "chat cards" would fight over one variable and one credential.
        assertion =
          let named = map (s: s.name) (builtins.filter (s: s.name != "") intCfg.subscribers);
          in lib.length (lib.unique (map intTokenEnv named)) == lib.length named;
        message = "services.multichat.integrations.subscribers: names must be unique after uppercasing and collapsing punctuation (e.g. \"chat-cards\" and \"chat cards\" collide).";
      }
    ];

    warnings =
      lib.optional (cfg.youtube.apiKey != "")
        ("services.multichat.youtube.apiKey is written world-readable into the Nix store and shown by "
          + "`systemctl show multichat`. Use youtube.apiKeyFile (agenix/sops-nix/systemd credentials) for real secrets.")
      ++ lib.optional (cfg.twitch.channels == [ ] && cfg.youtube.channels == [ ])
        "services.multichat is enabled but both twitch.channels and youtube.channels are empty; the viewer will show no chat."
      ++ lib.optional
        (cfg.youtube.channels != [ ] && cfg.youtube.apiKey == "" && cfg.youtube.apiKeyFile == null)
        ("services.multichat: youtube.channels is set but no build-time API key (youtube.apiKey / "
          + "youtube.apiKeyFile). Twitch works immediately; set the YouTube key on the running server "
          + "with `multichat set-youtube-key <KEY>` — it persists to the StateDirectory (/var/lib/multichat).")
      ++ lib.optional (esCfg.clientSecret != "")
        ("services.multichat.twitch.eventsub.clientSecret is written into the Nix store and shown by "
          + "`systemctl show multichat`. Use clientSecretFile (agenix/sops-nix/systemd credentials) for real secrets.")
      ++ lib.optional (lib.any (ch: ch.refreshToken != "") esCfg.channels)
        ("services.multichat.twitch.eventsub.channels has an inline refreshToken written into the Nix store. "
          + "Use refreshTokenFile for real secrets.")
      ++ lib.optional
        (esCfg.channels != [ ] && esCfg.clientId == "")
        "services.multichat.twitch.eventsub.channels is set but clientId is empty — EventSub alerts will be skipped."
      ++ lib.optional
        (cfg.alerts.activeTheme != ""
          && !(lib.any (t: t.name == cfg.alerts.activeTheme) cfg.alerts.themes))
        ("services.multichat.alerts.activeTheme = \"" + cfg.alerts.activeTheme
          + "\" does not match any theme in alerts.themes — the /alerts overlay will use the default look.")
      ++ lib.optional
        (cfg.giveaway.enable && cfg.giveaway.channel != ""
          && !(builtins.elem cfg.giveaway.channel cfg.twitch.channels))
        ("services.multichat.giveaway.channel = \"" + cfg.giveaway.channel
          + "\" is not in twitch.channels — the server won't join its chat, so the giveaway command will never be seen.")
      ++ lib.optional
        (cfg.giveaway.enable && cfg.giveaway.requireFollow
          && !(lib.any (ch: ch.login == cfg.giveaway.channel) esCfg.channels))
        ("services.multichat.giveaway.requireFollow needs the follow check, which uses \""
          + cfg.giveaway.channel
          + "\"'s EventSub broadcaster token. Add it to twitch.eventsub.channels (via `multichat login`), or set giveaway.requireFollow = false.")
      ++ lib.optional (cfg.giveaway.enable && cfg.giveaway.replies)
        ("services.multichat.giveaway.replies is on: the bot posts to Twitch chat as the broadcaster, "
          + "which needs the user:write:chat scope. Re-run `multichat login` for \""
          + cfg.giveaway.channel
          + "\" so its token carries that scope (tokens minted before this release don't).")
      ++ lib.optional
        (cfg.giveaway.enable && cfg.giveaway.followerStep > 0
          && !(lib.any (ch: ch.login == cfg.giveaway.channel) esCfg.channels))
        ("services.multichat.giveaway.followerStep is set but \""
          + cfg.giveaway.channel
          + "\" has no EventSub connection — follow events can't be received, so milestone "
          + "progress won't advance. Add it to twitch.eventsub.channels (via `multichat login`).")
      ++ lib.optional
        (cfg.giveaway.enable && cfg.giveaway.terms.enable && !cfg.giveaway.replies)
        ("services.multichat.giveaway.terms.enable is on but giveaway.replies is off — the "
          + "`terms` reply (to \"" + cfg.giveaway.prefix + cfg.giveaway.terms.command
          + "\") is a chat reply, so nothing is posted and the terms command is silently inert. "
          + "Turn replies on, or drop the terms command.")
      ++ lib.optional
        (cfg.giveaway.enable && cfg.giveaway.terms.enable && cfg.giveaway.terms.url == ""
          && !(cfg.giveaway.messages ? terms))
        ("services.multichat.giveaway.terms.enable is on with no terms.url and no custom "
          + "`terms` message — the built-in reply renders \"see the panel\" where the link "
          + "should be. Set terms.url, or write the terms into messages.terms.")
      ++ lib.optional (cfg.controlTokenFile == null && cfg.controlToken != "")
        ("services.multichat.controlToken is written into the Nix store and shown by "
          + "`systemctl show multichat`. Use controlTokenFile for real secrets.")
      ++ lib.optional
        (cfg.controlAccess == "any" && cfg.controlTokenFile == null && cfg.controlToken == "")
        ("services.multichat.controlAccess = \"any\" with no control token: anyone who can "
          + "reach the port can open, draw and reset the giveaway. Set controlTokenFile, or "
          + "use \"lan\" if you only meant the local network.")
      ++ lib.optional (cfg.controlAccess != "loopback" && cfg.host == "127.0.0.1")
        ("services.multichat.controlAccess is widened but host is \"127.0.0.1\", so nothing "
          + "off-box can reach the server at all. Set host = \"0.0.0.0\" (and openFirewall) "
          + "to actually let another machine draw.")
      ++ lib.optional (intCfg.callbackTokenFile == null && intCfg.callbackToken != "")
        ("services.multichat.integrations.callbackToken is written into the Nix store and shown by "
          + "`systemctl show multichat`. Use callbackTokenFile for real secrets.")
      ++ lib.optional (lib.any (s: s.tokenFile == null && s.token != "") intCfg.subscribers)
        ("services.multichat.integrations.subscribers has an inline token written into the Nix store. "
          + "Use tokenFile for real secrets.")
      ++ lib.optional
        (intCfg.subscribers != [ ] && !cfg.giveaway.enable)
        ("services.multichat.integrations.subscribers is set but giveaway.enable is false — the bus "
          + "only carries giveaway-lifecycle events, so nothing will ever be delivered and "
          + "POST /api/turn-report answers 501.");

    # Make the `multichat` CLI available so an operator can run
    # `multichat set-youtube-key <KEY>` against the running service.
    environment.systemPackages = [ cfg.package ];

    systemd.services.multichat = {
      description = "Multichat combined chat viewer";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      # Never rate-limit restarts: a chat viewer should keep reconnecting through
      # long Twitch/YouTube outages instead of being parked in `failed` after a
      # burst of crashes. Must live at the unit ([Unit]) level, not serviceConfig.
      startLimitIntervalSec = 0;

      # apiKeyFile (preferred) is staged via systemd LoadCredential into a private
      # tmpfs (mode 0400, owned by the DynamicUser); the source file only needs to
      # be readable by root at start. The app reads only YOUTUBE_API_KEY, so we cat
      # the credential into it. $CREDENTIALS_DIRECTORY is expanded by the shell at
      # runtime (single-quoted Nix string => no Nix interpolation here).
      script = ''
        ${lib.optionalString (cfg.youtube.apiKeyFile != null) ''
          export YOUTUBE_API_KEY="$(cat "$CREDENTIALS_DIRECTORY/youtube-api-key")"
        ''}
        ${lib.optionalString (esCfg.clientSecretFile != null) ''
          export TWITCH_CLIENT_SECRET="$(cat "$CREDENTIALS_DIRECTORY/twitch-client-secret")"
        ''}
        ${lib.optionalString (cfg.controlTokenFile != null) ''
          export MULTICHAT_CONTROL_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/control-token")"
        ''}
        ${lib.optionalString (intCfg.callbackTokenFile != null) ''
          export MULTICHAT_CALLBACK_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/integration-callback-token")"
        ''}
        ${lib.concatMapStringsSep "\n" (s: ''
          export ${intTokenEnv s.name}="$(cat "$CREDENTIALS_DIRECTORY/${intTokenCred s.name}")"
        '') intTokenFiles}
        ${lib.concatMapStringsSep "\n" (ch: ''
          # Seed the refresh token once; never overwrite the rotated token the app persists.
          if [ ! -e "$STATE_DIRECTORY/twitch-refresh-${ch.broadcasterId}" ]; then
            install -m600 "$CREDENTIALS_DIRECTORY/twitch-refresh-${ch.broadcasterId}" "$STATE_DIRECTORY/twitch-refresh-${ch.broadcasterId}"
          fi
        '') esTokenFiles}
        exec ${cfg.package}/bin/multichat ${settingsFile}
      '';

      serviceConfig = {
        Restart = "on-failure";
        RestartSec = "5s";
        DynamicUser = true;

        # Persist a YouTube key set at runtime (`multichat set-youtube-key`) across
        # restarts/reboots. systemd creates /var/lib/multichat (0700, owned by the
        # DynamicUser) and exports $STATE_DIRECTORY; the app writes the key there
        # (mode 0600). With ProtectSystem=strict this is the only writable path.
        StateDirectory = "multichat";
        StateDirectoryMode = "0700";

        # --- Sandboxing: stateless, network-only Deno service ---
        # MemoryDenyWriteExecute is deliberately NOT set — V8's JIT requires
        # writable+executable memory (PROT_EXEC mmap); enabling it breaks Deno.
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateMounts = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RemoveIPC = true;
        UMask = "0077";
        # Keep AF_UNIX (nscd / systemd-resolved DNS sockets) alongside AF_INET/6
        # (the bind + outbound Twitch/YouTube connections); dropping it breaks DNS.
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        # Allowlist. @system-service keeps every syscall V8/Tokio need (mmap/
        # mprotect/futex/clone/setrlimit/sched_setaffinity). Do NOT append
        # ~@resources — it strips the thread-pool/heap syscalls V8 relies on.
        SystemCallFilter = [ "@system-service" ];
        SystemCallErrorNumber = "EPERM";
        SystemCallArchitectures = "native";
        # Stateless service needs no Linux capabilities in the common case.
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
      }
      // lib.optionalAttrs (cfg.port < 1024) {
        # Privileged port (e.g. 80/443): grant only CAP_NET_BIND_SERVICE so the
        # DynamicUser can bind it without root. NoNewPrivileges stays on — it only
        # blocks *gaining* privileges, not the ambient cap systemd grants at exec.
        CapabilityBoundingSet = "CAP_NET_BIND_SERVICE";
        AmbientCapabilities = "CAP_NET_BIND_SERVICE";
      }
      // lib.optionalAttrs (loadCreds != [ ]) {
        # Every file-based secret (YouTube key, Twitch client secret, per-channel
        # refresh-token seeds), staged into a private tmpfs at $CREDENTIALS_DIRECTORY.
        LoadCredential = loadCreds;
      }
      // lib.optionalAttrs (envList != [ ]) {
        # Inline (non-file) secrets. % is escaped so systemd does not read it as a
        # specifier. These land in the Nix store / `systemctl show` — the *File
        # options are preferred for real secrets.
        Environment = envList;
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}

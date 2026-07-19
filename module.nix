# NixOS service module for multichat. Portable — importable without the flake:
#   imports = [ (import ./module.nix) ];
# The package defaults to ./build.nix so the module works standalone.
{ config, lib, pkgs, ... }:
let
  cfg = config.services.multichat;
  esCfg = cfg.twitch.eventsub;

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
      esTokenFiles;

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
    server = { port = cfg.port; host = cfg.host; };
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
  });
in
{
  options.services.multichat = {
    enable = lib.mkEnableOption "multichat combined chat viewer";

    package = lib.mkOption {
      type = lib.types.package;
      default = import ./build.nix { inherit pkgs; };
      defaultText = lib.literalExpression "import ./build.nix { inherit pkgs; }";
      description = "The multichat package to use.";
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
          + "\" does not match any theme in alerts.themes — the /alerts overlay will use the default look.");

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

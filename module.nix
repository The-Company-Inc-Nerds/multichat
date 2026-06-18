# NixOS service module for multichat. Portable — importable without the flake:
#   imports = [ (import ./module.nix) ];
# The package defaults to ./build.nix so the module works standalone.
{ config, lib, pkgs, ... }:
let
  cfg = config.services.multichat;

  # Settings without the API key — supplied via YOUTUBE_API_KEY env var at runtime.
  settingsFile = pkgs.writeText "multichat-settings.json" (builtins.toJSON {
    server = { port = cfg.port; host = cfg.host; };
    twitch.channels = cfg.twitch.channels;
    youtube = {
      apiKey = "";
      channels = map (ch: { inherit (ch) channelId handle videoId; }) cfg.youtube.channels;
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
      description = "Twitch channel names (lowercase) to monitor.";
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
        assertion = cfg.youtube.channels == [ ]
          || cfg.youtube.apiKey != ""
          || cfg.youtube.apiKeyFile != null;
        message = "services.multichat: youtube.channels is non-empty but no YouTube API key is set. Set youtube.apiKey or youtube.apiKeyFile (YouTube polling requires a Data API v3 key).";
      }
      {
        assertion = builtins.elem cfg.host [ "127.0.0.1" "0.0.0.0" ];
        message = ''services.multichat.host must be "127.0.0.1" or "0.0.0.0": the packaged deno wrapper restricts --allow-net to those addresses, so binding any other host is denied by Deno's permission layer.'';
      }
    ];

    warnings =
      lib.optional (cfg.youtube.apiKey != "")
        ("services.multichat.youtube.apiKey is written world-readable into the Nix store and shown by "
          + "`systemctl show multichat`. Use youtube.apiKeyFile (agenix/sops-nix/systemd credentials) for real secrets.")
      ++ lib.optional (cfg.twitch.channels == [ ] && cfg.youtube.channels == [ ])
        "services.multichat is enabled but both twitch.channels and youtube.channels are empty; the viewer will show no chat.";

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
        exec ${cfg.package}/bin/multichat ${settingsFile}
      '';

      serviceConfig = {
        Restart = "on-failure";
        RestartSec = "5s";
        DynamicUser = true;

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
      // lib.optionalAttrs (cfg.youtube.apiKeyFile != null) {
        LoadCredential = [ "youtube-api-key:${toString cfg.youtube.apiKeyFile}" ];
      }
      // lib.optionalAttrs (cfg.youtube.apiKeyFile == null && cfg.youtube.apiKey != "") {
        # Inline fallback only when no file is given. Escape % so systemd does not
        # read it as a specifier. This value lands in the Nix store and
        # `systemctl show` — apiKeyFile is preferred for real secrets.
        Environment = [ "YOUTUBE_API_KEY=${lib.replaceStrings [ "%" ] [ "%%" ] cfg.youtube.apiKey}" ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}

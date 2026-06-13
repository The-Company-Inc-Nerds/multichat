# NixOS service module for multichat. Portable — importable without the flake:
#   imports = [ (import ./module.nix) ];
# The package defaults to ./build.nix so the module works standalone.
{ config, lib, pkgs, ... }:
with lib;
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
    enable = mkEnableOption "multichat combined chat viewer";

    package = mkOption {
      type = types.package;
      default = import ./build.nix { inherit pkgs; };
      defaultText = literalExpression "import ./build.nix { inherit pkgs; }";
      description = "The multichat package to use.";
    };

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "Port the web interface listens on.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Bind address for the web interface.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the configured port in the firewall.";
    };

    twitch.channels = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = literalExpression ''[ "streamer1" "streamer2" ]'';
      description = "Twitch channel names (lowercase) to monitor.";
    };

    youtube.apiKey = mkOption {
      type = types.str;
      default = "";
      description = "YouTube Data API v3 key as a plain string. This value ends up in the Nix store — use apiKeyFile for production secrets.";
    };

    youtube.apiKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/youtube-api-key";
      description = ''
        Path to a file containing the raw YouTube API key (just the key value, no KEY=VALUE prefix).
        Compatible with agenix, sops-nix, and any secrets manager that writes plain files.
        Takes precedence over youtube.apiKey when both are set.
        The file must be readable by the service (world-readable or group-readable with supplementary groups).
      '';
    };

    youtube.channels = mkOption {
      type = types.listOf (types.submodule {
        options = {
          handle = mkOption {
            type = types.str;
            default = "";
            description = "YouTube channel handle, e.g. @channelname.";
          };
          channelId = mkOption {
            type = types.str;
            default = "";
            description = "YouTube channel ID, e.g. UCxxxxxxxxxxxxxxxxxxxxxxxx.";
          };
          videoId = mkOption {
            type = types.str;
            default = "";
            description = "Specific video ID — skips live-stream lookup.";
          };
        };
      });
      default = [ ];
      description = "YouTube channels to monitor. Set handle, channelId, or videoId.";
    };
  };

  config = mkIf cfg.enable {
    systemd.services.multichat = {
      description = "Multichat combined chat viewer";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      # Inline apiKey lands in the process environment via this attrset.
      environment = mkIf (cfg.youtube.apiKey != "") {
        YOUTUBE_API_KEY = cfg.youtube.apiKey;
      };

      # Read the raw secret file at start time so any secrets manager that writes a
      # plain file is supported (agenix, sops-nix, etc.). apiKeyFile wins over apiKey.
      script = ''
        ${optionalString (cfg.youtube.apiKeyFile != null) ''
          export YOUTUBE_API_KEY="$(cat ${lib.escapeShellArg (toString cfg.youtube.apiKeyFile)})"
        ''}
        exec ${cfg.package}/bin/multichat ${settingsFile}
      '';

      serviceConfig = {
        Restart = "on-failure";
        RestartSec = "5s";
        DynamicUser = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];
  };
}

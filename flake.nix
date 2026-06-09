{
  description = "Multichat — combined Twitch and YouTube live chat viewer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {self, nixpkgs}:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {inherit system; config.allowUnfree = true;};

      # Builds multichat for any pkgs instance (used by both packages output and nixosModule)
      makePackage = p:
        p.stdenv.mkDerivation {
          pname = "multichat";
          version = "0.1.0";
          src = p.lib.cleanSource ./.;
          nativeBuildInputs = [p.makeWrapper];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/multichat/src
            cp main.ts deno.json $out/share/multichat/
            cp src/types.ts src/twitch.ts src/youtube.ts src/server.ts $out/share/multichat/src/
            makeWrapper ${p.deno}/bin/deno $out/bin/multichat \
              --add-flags "run --allow-net --allow-read --allow-env=YOUTUBE_API_KEY,PORT,HOST $out/share/multichat/main.ts"
            runHook postInstall
          '';
        };
    in
    {
      packages.${system}.default = makePackage pkgs;

      devShells.${system}.default = import ./shell.nix {inherit pkgs;};

      nixosModules.default = {
        config,
        lib,
        pkgs,
        ...
      }:
        with lib; let
          cfg = config.services.multichat;

          # Settings without the API key — supplied via YOUTUBE_API_KEY env var at runtime
          settingsFile = pkgs.writeText "multichat-settings.json" (builtins.toJSON {
            server = {port = cfg.port; host = cfg.host;};
            twitch.channels = cfg.twitch.channels;
            youtube = {
              apiKey = "";
              channels = map (ch: {
                inherit (ch) channelId handle videoId;
              }) cfg.youtube.channels;
            };
          });
        in {
          options.services.multichat = {
            enable = mkEnableOption "multichat combined chat viewer";

            package = mkOption {
              type = types.package;
              default = makePackage pkgs;
              defaultText = literalExpression "pkgs.callPackage ./. {}";
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
              default = [];
              example = literalExpression ''["streamer1" "streamer2"]'';
              description = "Twitch channel names (lowercase) to monitor.";
            };

            youtube.apiKey = mkOption {
              type = types.str;
              default = "";
              description = "YouTube Data API v3 key. Stored in Nix store — use apiKeyFile for production.";
            };

            youtube.apiKeyFile = mkOption {
              type = types.nullOr types.path;
              default = null;
              example = "/run/secrets/youtube-api-key";
              description = ''
                Path to a file containing the YouTube API key in the format:
                YOUTUBE_API_KEY=AIza...
                Takes precedence over youtube.apiKey.
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
              default = [];
              description = "YouTube channels to monitor. Set handle, channelId, or videoId.";
            };
          };

          config = mkIf cfg.enable {
            systemd.services.multichat = {
              description = "Multichat combined chat viewer";
              wantedBy = ["multi-user.target"];
              after = ["network-online.target"];
              wants = ["network-online.target"];

              environment = mkIf (cfg.youtube.apiKey != "") {
                YOUTUBE_API_KEY = cfg.youtube.apiKey;
              };

              serviceConfig =
                {
                  ExecStart = "${cfg.package}/bin/multichat ${settingsFile}";
                  Restart = "on-failure";
                  RestartSec = "5s";
                  DynamicUser = true;
                  NoNewPrivileges = true;
                  PrivateTmp = true;
                  ProtectSystem = "strict";
                  ProtectHome = true;
                }
                // optionalAttrs (cfg.youtube.apiKeyFile != null) {
                  EnvironmentFile = cfg.youtube.apiKeyFile;
                };
            };

            networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [cfg.port];
          };
        };
    };
}

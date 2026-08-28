{
  description = "Multichat — combined Twitch and YouTube live chat viewer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  # Thin orchestration only. The real definitions live in:
  #   build.nix   — the package derivation (standalone-buildable)
  #   shell.nix   — the dev shell + helper scripts
  #   module.nix  — the NixOS service module (portable, importable without this flake)
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      # allowUnfree is scoped to the dev shell — its only unfree dependency is
      # pkgs.claude-code. The package itself needs only deno (MIT), so its build
      # (and downstream consumers of nixosModules.default) stays free of the flag.
      pkgsUnfree = import nixpkgs { inherit system; config.allowUnfree = true; };
    in
    {
      packages.${system}.default = import ./build.nix { inherit pkgs; };
      devShells.${system}.default = import ./shell.nix { pkgs = pkgsUnfree; };
      nixosModules.default = import ./module.nix;

      checks.${system} = {
        # Drives the integration bus end to end against a stand-in for chat-cards.
        # Three things can only break here, not in the unit tests: deno's
        # --allow-net allow-list (an unlisted subscriber host is denied), its
        # --allow-env allow-list (the token env vars must be readable), and the
        # LoadCredential path that keeps both tokens out of the Nix store.
        integrations = pkgs.testers.runNixOSTest {
          name = "multichat-integrations";
          nodes.machine = { pkgs, ... }: {
            imports = [ (import ./module.nix) ];

            # A hostname, not 127.0.0.1: the wrapper's allow-net list is baked at
            # build time, so this passes only if module.nix really did derive the
            # host from baseUrl and hand it to build.nix.
            networking.hosts."127.0.0.1" = [ "packsink" ];

            environment.etc."multichat-callback-token".text = "callback-secret";
            environment.etc."packsink-token".text = "outbound-secret";

            services.multichat = {
              enable = true;
              port = 8080;
              twitch.channels = [ "demo" ];
              giveaway = {
                enable = true;
                channel = "demo";
                requireFollow = false; # no EventSub in the test VM
                replies = false;
              };
              integrations = {
                callbackTokenFile = "/etc/multichat-callback-token";
                subscribers = [{
                  name = "chat-cards";
                  adapter = "chat-cards";
                  baseUrl = "http://packsink:8787";
                  tokenFile = "/etc/packsink-token";
                  packSize = 5;
                }];
              };
            };

            # Stands in for chat-cards: records every POST /api/pack it receives.
            systemd.services.packsink = {
              description = "chat-cards stand-in recording POST /api/pack";
              wantedBy = [ "multi-user.target" ];
              before = [ "multichat.service" ];
              serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${
                pkgs.writeText "packsink.py" ''
                  import http.server, json

                  class Sink(http.server.BaseHTTPRequestHandler):
                      def do_POST(self):
                          body = self.rfile.read(int(self.headers["content-length"]))
                          with open("/var/log/packs.jsonl", "a") as fh:
                              fh.write(json.dumps({
                                  "path": self.path,
                                  "auth": self.headers.get("authorization"),
                                  "body": json.loads(body),
                              }) + "\n")
                          self.send_response(200)
                          self.send_header("content-type", "application/json")
                          self.end_headers()
                          self.wfile.write(b'{"id": "pack-1"}')

                  http.server.HTTPServer(("0.0.0.0", 8787), Sink).serve_forever()
                ''
              }";
            };
          };

          testScript = ''
            import json

            machine.wait_for_unit("packsink.service")
            machine.wait_for_unit("multichat.service")
            machine.wait_for_open_port(8080)
            machine.wait_for_open_port(8787)

            def giveaway(action):
                return machine.succeed(
                    "curl -sf -X POST http://127.0.0.1:8080/api/giveaway "
                    f"-H 'Content-Type: application/json' -d '{{\"action\": \"{action}\"}}'"
                )

            # Neither token may appear in the world-readable settings file.
            machine.fail("grep -rq callback-secret /nix/store/*-multichat-settings.json")
            machine.fail("grep -rq outbound-secret /nix/store/*-multichat-settings.json")

            # Outbound: a draw must open a pack in the subscriber.
            giveaway("open")
            giveaway("demo")
            drawn = json.loads(giveaway("draw"))
            assert drawn["winner"], drawn

            machine.wait_until_succeeds("test -s /var/log/packs.jsonl")
            pack = json.loads(machine.succeed("tail -n1 /var/log/packs.jsonl"))
            assert pack["path"] == "/api/pack", pack
            assert pack["body"]["winner"], pack
            assert pack["body"]["ref"], pack
            assert pack["body"]["size"] == 5, pack
            # The bearer proves tokenFile → LoadCredential → env → outbound header.
            assert pack["auth"] == "Bearer outbound-secret", pack

            # Inbound: /api/turn-report is gated on the callback token, even from
            # loopback, because callbackTokenFile is set.
            report = (
                '{"packId": "pack-1", "ref": "%s", "totalValue": 12.5, '
                '"cards": [{"name": "Pikachu", "value": 12.5}]}' % pack["body"]["ref"]
            )
            machine.succeed(
                "curl -s -o /dev/null -w '%{http_code}' -X POST "
                "http://127.0.0.1:8080/api/turn-report "
                "-H 'Authorization: Bearer wrong' "
                f"-d '{report}' | grep -q 403"
            )
            machine.succeed(
                "curl -sf -X POST http://127.0.0.1:8080/api/turn-report "
                "-H 'Authorization: Bearer callback-secret' "
                f"-d '{report}' | grep -q '\"ok\": *true'"
            )
          '';
        };
      };
    };
}

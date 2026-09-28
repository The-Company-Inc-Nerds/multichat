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
        # Drives the integration bus end to end against a stand-in for chat-cards,
        # and the channel-points overlay leg against a stand-in for the
        # cobblemon-overlay's effect API. Three things can only break here, not in
        # the unit tests: deno's --allow-net allow-list (an unlisted subscriber or
        # overlay host is denied), its --allow-env allow-list (the token env vars
        # must be readable), and the LoadCredential path that keeps the tokens
        # out of the Nix store.
        integrations = pkgs.testers.runNixOSTest {
          name = "multichat-integrations";
          nodes.machine = { pkgs, ... }: {
            imports = [ (import ./module.nix) ];

            # Hostnames, not 127.0.0.1: the wrapper's allow-net list is baked at
            # build time, so this passes only if module.nix really did derive the
            # hosts from baseUrl / overlayUrl and hand them to build.nix.
            networking.hosts."127.0.0.1" = [ "packsink" "fxsink" ];

            environment.etc."multichat-callback-token".text = "callback-secret";
            environment.etc."packsink-token".text = "outbound-secret";
            environment.etc."multichat-control-token".text = "control-secret";
            environment.etc."multichat-effects-token".text = "effects-secret";

            services.multichat = {
              enable = true;
              port = 8080;
              # Bound to every interface and drawable from the LAN behind a token:
              # the address policy is only observable off-loopback, which a VM with
              # its own eth0 address can actually exercise.
              host = "0.0.0.0";
              controlAccess = "lan";
              controlTokenFile = "/etc/multichat-control-token";
              twitch.channels = [ "demo" ];
              giveaway = {
                enable = true;
                channel = "demo";
                requireFollow = false; # no EventSub in the test VM
                replies = false;
                timezone = "America/Denver";
                terms = { enable = true; version = "3"; url = "https://example.test/terms"; };
                disposition.enable = true;
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
              # No EventSub in the VM, so only `rewards simulate` can drive it —
              # which is exactly the overlay leg under test.
              channelPoints = {
                enable = true;
                channel = "demo";
                overlayUrl = "http://fxsink:8082";
                overlayTokenFile = "/etc/multichat-effects-token";
              };
            };

            # Stands in for the cobblemon-overlay effect API: records every POST
            # (enqueue / cancel), reports every effect it is asked about as
            # applied, and is always accepting.
            systemd.services.fxsink = {
              description = "cobblemon-overlay effects stand-in";
              wantedBy = [ "multi-user.target" ];
              before = [ "multichat.service" ];
              serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${
                pkgs.writeText "fxsink.py" ''
                  import http.server, json
                  from urllib.parse import urlparse, parse_qs

                  class Fx(http.server.BaseHTTPRequestHandler):
                      def reply(self, code, obj):
                          body = json.dumps(obj).encode()
                          self.send_response(code)
                          self.send_header("content-type", "application/json")
                          self.send_header("content-length", str(len(body)))
                          self.end_headers()
                          self.wfile.write(body)

                      def do_GET(self):
                          url = urlparse(self.path)
                          if url.path == "/effects/health":
                              return self.reply(200, {"ok": True, "enabled": True,
                                  "accepting": True, "lastPollAgoMs": 0,
                                  "ready": True, "open": 0, "pending": 0})
                          if url.path == "/effects":
                              ids = parse_qs(url.query).get("ids", [""])[0].split(",")
                              return self.reply(200, {"ok": True, "effects": [
                                  {"id": i, "status": "applied", "detail": "stand-in",
                                   "updatedAt": 0} for i in ids if i]})
                          self.reply(404, {"ok": False})

                      def do_POST(self):
                          n = int(self.headers.get("content-length") or 0)
                          body = json.loads(self.rfile.read(n) or b"null")
                          with open("/var/log/effects.jsonl", "a") as fh:
                              fh.write(json.dumps({
                                  "path": self.path,
                                  "auth": self.headers.get("authorization"),
                                  "body": body,
                              }) + "\n")
                          if self.path == "/effects":
                              return self.reply(202, {"ok": True, "status": "pending"})
                          self.reply(200, {"ok": True, "status": "canceled"})

                  http.server.HTTPServer(("0.0.0.0", 8082), Fx).serve_forever()
                ''
              }";
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
            machine.wait_for_unit("fxsink.service")
            machine.wait_for_unit("multichat.service")
            machine.wait_for_open_port(8080)
            machine.wait_for_open_port(8787)
            machine.wait_for_open_port(8082)

            def giveaway(action):
                return machine.succeed(
                    "curl -sf -X POST http://127.0.0.1:8080/api/giveaway "
                    f"-H 'Content-Type: application/json' -d '{{\"action\": \"{action}\"}}'"
                )

            # No token may appear in the world-readable settings file.
            machine.fail("grep -rq callback-secret /nix/store/*-multichat-settings.json")
            machine.fail("grep -rq outbound-secret /nix/store/*-multichat-settings.json")
            machine.fail("grep -rq control-secret /nix/store/*-multichat-settings.json")
            machine.fail("grep -rq effects-secret /nix/store/*-multichat-settings.json")

            # The control policy, exercised from a non-loopback address (the VM's
            # own eth0). Loopback never needs the token; the LAN always does.
            lan = machine.succeed(
                "ip -4 -o addr show scope global | awk '{print $4}' "
                "| cut -d/ -f1 | head -n1"
            ).strip()
            assert lan and not lan.startswith("127."), lan

            def code(cmd):
                return machine.succeed(cmd + " -s -o /dev/null -w '%{http_code}'").strip()

            draw_body = "-H 'Content-Type: application/json' -d '{\"action\": \"status\"}'"
            assert code(
                f"curl -X POST http://{lan}:8080/api/giveaway {draw_body}"
            ) == "403", "a LAN caller with no token must be refused"
            assert code(
                f"curl -X POST http://{lan}:8080/api/giveaway {draw_body} "
                "-H 'Authorization: Bearer control-secret'"
            ) == "200", "a LAN caller with the token must be allowed"
            assert code(
                f"curl -X POST http://127.0.0.1:8080/api/giveaway {draw_body}"
            ) == "200", "loopback must never be asked for the token"

            # Opening the page with the token mints the cookie the buttons ride on.
            # Headers are checked here rather than piped into `grep -q`, which
            # exits on its first match and can fail curl's write (exit 23).
            def headers(path):
                return machine.succeed(
                    f"curl -s -D- -o /dev/null 'http://{lan}:8080{path}'"
                ).lower()

            assert "set-cookie: mc_control=" in headers(
                "/giveaway?token=control-secret"
            ), "the right ?token= must mint the control cookie"
            assert "set-cookie" not in headers(
                "/giveaway?token=wrong"
            ), "a wrong ?token= must not mint a cookie"

            # The other control endpoints stay loopback-only regardless.
            assert code(
                f"curl -X POST http://{lan}:8080/api/fake -d 'follow'"
            ) == "403", "/api/fake must not follow controlAccess"

            # The gates the module emits conditionally: present and switched on,
            # with the operator's own values rather than the app's defaults.
            settings = json.loads(
                machine.succeed("cat /nix/store/*-multichat-settings.json")
            )["giveaway"]
            assert settings["timezone"] == "America/Denver", settings
            assert settings["terms"] == {
                "required": True,
                "command": "terms",
                "version": "3",
                "url": "https://example.test/terms",
            }, settings
            assert settings["disposition"]["enabled"] is True, settings
            assert settings["disposition"]["destroy"] == "destroy", settings

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

            # Channel points: the block is emitted (enabled, catalogue left to
            # the built-in default) with the token blanked — it comes from the
            # credential instead.
            cp = json.loads(
                machine.succeed("cat /nix/store/*-multichat-settings.json")
            )["channelPoints"]
            assert cp["enabled"] is True, cp
            assert cp["overlayToken"] == "" and cp["rewards"] is None, cp

            # /api/rewards refunds points and fires effects in the streamer's
            # game: loopback-only, whatever controlAccess and the token say.
            assert code(
                f"curl -X POST http://{lan}:8080/api/rewards "
                "-d '{\"action\": \"status\"}' -H 'Authorization: Bearer control-secret'"
            ) == "403", "/api/rewards must stay loopback-only"

            # A simulated redemption runs the whole overlay leg: the effect is
            # delivered with the credential-staged bearer, and the stand-in's
            # "applied" result resolves the ledger entry.
            sim = json.loads(machine.succeed(
                "curl -sf -X POST http://127.0.0.1:8080/api/rewards "
                "-d '{\"action\": \"simulate\", \"key\": \"butterfingers\", \"user\": \"Nova\"}'"
            ))
            assert sim["ok"] and sim["entry"]["id"].startswith("sim-"), sim
            machine.wait_until_succeeds("grep -q '\"/effects\"' /var/log/effects.jsonl")
            fx = next(
                rec for rec in map(
                    json.loads,
                    machine.succeed("cat /var/log/effects.jsonl").splitlines(),
                )
                if rec["path"] == "/effects"
            )
            assert fx["auth"] == "Bearer effects-secret", fx
            assert fx["body"]["id"] == sim["entry"]["id"], fx
            assert fx["body"]["effect"] == "drop_held_item", fx
            assert fx["body"]["viewer"] == "Nova", fx
            machine.wait_until_succeeds(
                "curl -sf -X POST http://127.0.0.1:8080/api/rewards "
                "-d '{\"action\": \"status\"}' | grep -q '\"resolved\": *1'"
            )
          '';
        };
      };
    };
}

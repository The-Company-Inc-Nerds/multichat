# Package derivation for multichat. Standalone-buildable:
#   nix-build build.nix            (uses the <nixpkgs> default below)
#   nix-build build.nix --arg pkgs 'import <nixpkgs> {}'
# Also imported by flake.nix (packages.default) and module.nix (the package default).
#
# `extraNetHosts` widens the wrapper's --allow-net allow-list. The outbound
# integration bus (settings.integrations.subscribers) fetches arbitrary URLs, and
# Deno denies any host not listed here — so a subscriber on another machine needs
# its host added. module.nix derives this from the configured subscribers
# automatically; pass it by hand only when building the package yourself.
{ pkgs ? import <nixpkgs> { }, extraNetHosts ? [ ] }:
let
  netHosts = pkgs.lib.unique ([
    "irc-ws.chat.twitch.tv"
    "eventsub.wss.twitch.tv"
    "api.twitch.tv"
    "id.twitch.tv"
    "www.googleapis.com"
    "127.0.0.1"
    "0.0.0.0"
  ] ++ extraNetHosts);

  # Env allow-list. MULTICHAT_INTEGRATION_TOKEN_* is a prefix wildcard (Deno
  # supports a trailing "*"): the names are derived from subscriber names, so
  # they can't be enumerated at build time. See subscriberTokenEnvVar in
  # src/integrations.ts.
  envNames = [
    "YOUTUBE_API_KEY"
    "TWITCH_CLIENT_ID"
    "TWITCH_CLIENT_SECRET"
    "PORT"
    "HOST"
    "STATE_DIRECTORY"
    "MULTICHAT_CALLBACK_TOKEN"
    "MULTICHAT_INTEGRATION_TOKEN_*"
  ];
in
pkgs.stdenv.mkDerivation {
  pname = "multichat";
  version = "0.1.0";
  src = pkgs.lib.cleanSource ./.;
  nativeBuildInputs = [ pkgs.makeWrapper ];
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/multichat/src
    cp main.ts deno.json $out/share/multichat/
    # Ship every source module (glob, not an explicit list, so a newly added
    # module can't be silently omitted from the package). Tests live in tests/,
    # so src/*.ts is exactly the runtime set.
    cp src/*.ts $out/share/multichat/src/
    makeWrapper ${pkgs.deno}/bin/deno $out/bin/multichat \
      --add-flags "run --allow-net=${pkgs.lib.concatStringsSep "," netHosts} --allow-read --allow-write=/var/lib/multichat,/var/lib/private/multichat --allow-env=${pkgs.lib.concatStringsSep "," envNames} $out/share/multichat/main.ts"
    runHook postInstall
  '';
}

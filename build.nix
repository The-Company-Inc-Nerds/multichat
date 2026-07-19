# Package derivation for multichat. Standalone-buildable:
#   nix-build build.nix            (uses the <nixpkgs> default below)
#   nix-build build.nix --arg pkgs 'import <nixpkgs> {}'
# Also imported by flake.nix (packages.default) and module.nix (the package default).
{ pkgs ? import <nixpkgs> { } }:
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
      --add-flags "run --allow-net=irc-ws.chat.twitch.tv,eventsub.wss.twitch.tv,api.twitch.tv,id.twitch.tv,www.googleapis.com,127.0.0.1,0.0.0.0 --allow-read --allow-write=/var/lib/multichat,/var/lib/private/multichat --allow-env=YOUTUBE_API_KEY,TWITCH_CLIENT_ID,TWITCH_CLIENT_SECRET,PORT,HOST,STATE_DIRECTORY $out/share/multichat/main.ts"
    runHook postInstall
  '';
}

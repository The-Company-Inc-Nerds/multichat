# Package derivation for multichat. Standalone-buildable:
#   nix-build build.nix --arg pkgs 'import <nixpkgs> {}'
# Also imported by flake.nix (packages.default) and module.nix (the package default).
{ pkgs }:
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
    cp src/types.ts src/twitch.ts src/youtube.ts src/server.ts $out/share/multichat/src/
    makeWrapper ${pkgs.deno}/bin/deno $out/bin/multichat \
      --add-flags "run --allow-net=irc-ws.chat.twitch.tv,www.googleapis.com,127.0.0.1,0.0.0.0 --allow-read --allow-env=YOUTUBE_API_KEY,PORT,HOST $out/share/multichat/main.ts"
    runHook postInstall
  '';
}

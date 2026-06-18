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
    };
}

{pkgs}:
pkgs.mkShell {
  packages = [
    pkgs.deno
    pkgs.claude-code
  ];

  shellHook = ''
    echo "multichat dev shell"
    echo "  deno task start   — run the server"
    echo "  deno task dev     — run with --watch"
    echo "  deno task compile — build a standalone binary"
  '';
}

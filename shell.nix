{ pkgs }:
let
  # Run the server with the local settings.json.
  runserver = pkgs.writeShellScriptBin "runserver" ''
    exec deno task start "$@"
  '';

  # Format-check, lint, type-check and test — the same gate to run before committing.
  runchecks = pkgs.writeShellScriptBin "runchecks" ''
    set -e
    deno fmt --check
    deno lint
    deno check main.ts src/*.ts tests/*.ts
    deno test
  '';

  # A throwaway alerts-overlay demo: a second server instance on its own port
  # (loopback, no platforms) with the fake showcase playing on a loop — preview
  # alert themes in a browser without touching a running server. Reuses the
  # `alerts` block from ./settings.json when it has one, so you see YOUR theme.
  demoalerts = pkgs.writeShellScriptBin "demoalerts" ''
    set -e
    port="''${1:-8090}"
    case "$port" in
      "" | *[!0-9]*)
        echo "usage: demoalerts [PORT]   (default 8090)" >&2
        exit 2
        ;;
    esac
    if ! deno eval "try { Deno.listen({ hostname: '127.0.0.1', port: $port }).close(); } catch { Deno.exit(1); }" 2>/dev/null; then
      echo "Port $port is already in use — pass another one: demoalerts 8091" >&2
      exit 1
    fi

    tmp=$(mktemp -d)
    server_pid=""
    cleanup() {
      [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
      rm -rf "$tmp"
    }
    trap cleanup EXIT INT TERM

    deno eval "
      let alerts = {
        activeTheme: 'The Company, Inc',
        themes: [{ name: 'The Company, Inc', style: 'company-memo', events: ['follow', 'sub', 'raid', 'cheer'] }],
      };
      try {
        const own = JSON.parse(Deno.readTextFileSync('settings.json')).alerts;
        if (own && own.activeTheme) alerts = own;
      } catch { /* no local settings.json — demo the flagship theme */ }
      Deno.writeTextFileSync('$tmp/settings.json', JSON.stringify({
        server: { port: $port, host: '127.0.0.1' },
        alerts,
      }));
    "

    # PORT/HOST env would override the demo settings — shed them.
    env -u PORT -u HOST deno task start "$tmp/settings.json" &
    server_pid=$!
    deno eval "
      for (let i = 0; i < 50; i++) {
        try { await fetch('http://127.0.0.1:$port/'); Deno.exit(0); } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      console.error('server did not come up'); Deno.exit(1);
    "

    url="http://127.0.0.1:$port/alerts"
    echo ""
    echo "Alerts demo: $url   (Ctrl-C to stop; ?theme=NAME to try another theme)"
    command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 || true

    # Replay the showcase forever; ~3s between events keeps pace with the
    # ~6s a card stays up, without the queue piling up.
    while kill -0 "$server_pid" 2>/dev/null; do
      deno task fake --port "$port" --gap 3000 >/dev/null 2>&1 || true
      sleep 2
    done
  '';

  # Review the staged commit message in GIT_COMMIT_MSG, then sign-commit it.
  # Write the message to ./GIT_COMMIT_MSG first; this prints it, confirms, and signs.
  gcommit = pkgs.writeShellScriptBin "gcommit" ''
    set -e
    if [ ! -f GIT_COMMIT_MSG ]; then
      echo "No GIT_COMMIT_MSG file found. Write your commit message there first." >&2
      exit 1
    fi
    echo "----- GIT_COMMIT_MSG -----"
    cat GIT_COMMIT_MSG
    echo "--------------------------"
    printf "Commit (signed)? [y/N] "
    read -r reply
    case "$reply" in
      y | Y) git commit -S -F GIT_COMMIT_MSG ;;
      *) echo "Aborted." >&2; exit 1 ;;
    esac
  '';
in
pkgs.mkShell {
  packages = [
    pkgs.deno
    pkgs.claude-code
    runserver
    runchecks
    demoalerts
    gcommit
  ];

  shellHook = ''
    echo "multichat dev shell"
    echo "  deno task start    — run the server (alias: runserver)"
    echo "  deno task dev      — run with --watch"
    echo "  deno task test     — run the test suite"
    echo "  deno task compile  — build a standalone binary"
    echo "  runchecks          — fmt-check + lint + type-check + test"
    echo "  demoalerts [PORT]  — looping /alerts demo server (default :8090)"
    echo "  gcommit            — review GIT_COMMIT_MSG and sign-commit it"
  '';
}

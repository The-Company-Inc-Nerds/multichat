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
    gcommit
  ];

  shellHook = ''
    echo "multichat dev shell"
    echo "  deno task start    — run the server (alias: runserver)"
    echo "  deno task dev      — run with --watch"
    echo "  deno task test     — run the test suite"
    echo "  deno task compile  — build a standalone binary"
    echo "  runchecks          — fmt-check + lint + type-check + test"
    echo "  gcommit            — review GIT_COMMIT_MSG and sign-commit it"
  '';
}

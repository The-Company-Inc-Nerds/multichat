# Testing

## Running the checks

```bash
deno task test     # run the test suite
deno task check    # type-check main.ts, src/, and tests/
deno task lint      # lint
deno task fmt       # format (use `deno fmt --check` to verify only)
```

In the dev shell, `runchecks` runs all four (fmt-check + lint + check + test) —
the same gate to run before committing.

## Test layout

Tests live in `tests/`, one file per source module. They are pure unit tests and
need no permissions or network. To keep the project dependency-free, assertions
come from a small local shim (`tests/_assert.ts`) rather than `@std/assert`; a
shared fake `Emitter` (`tests/_fake.ts`) captures emitted events for assertions.

| Test file               | Covers           | Notable cases                                                                                                                                            |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/twitch_test.ts`  | `src/twitch.ts`  | IRC parsing, badge/emote-tag parsing, codepoint emote offsets, `handleCommand` for chat / action / cheer / sub / raid / CLEARMSG / CLEARCHAT / ROOMSTATE |
| `tests/youtube_test.ts` | `src/youtube.ts` | `tierColor`, `buildBadges`, `emitItem` for each `snippet.type` (text, superchat, supersticker, membership, deletion, unknown)                            |
| `tests/server_test.ts`  | `src/server.ts`  | `colorFor` determinism and format                                                                                                                        |

Pure helpers are `export`ed from the source modules for testing; the HTTP server
itself is only started by `createServer`, which the tests never call.

## Manual smoke test

Twitch works anonymously, so the live path is easy to exercise:

```bash
deno task start    # against a settings.json pointing at a busy, live Twitch channel
```

Open the UI and confirm: the channel turns `live` in the sidebar, messages show
badges / author colors / emote images, and `/me` actions render in italic.
Killing the network should flip the dot to `error`, then back to `live` on
reconnect.

## Commit workflow

Commits are GPG-signed via the `gcommit` helper:

```bash
# 1. write the commit message to ./GIT_COMMIT_MSG
# 2. review and sign-commit it:
gcommit
```

`gcommit` prints `GIT_COMMIT_MSG`, prompts for confirmation, then runs
`git commit -S -F GIT_COMMIT_MSG`. `GIT_COMMIT_MSG` and the local `gcommit`
artifact are gitignored.

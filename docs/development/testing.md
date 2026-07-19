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

| Test file                  | Covers              | Notable cases                                                                                                                                                                                      |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/twitch_test.ts`     | `src/twitch.ts`     | IRC parsing, badge/emote-tag parsing, codepoint emote offsets, `handleCommand` for chat / action / cheer / sub / raid / CLEARMSG / CLEARCHAT / ROOMSTATE, and the EventSub `isCovered` suppression |
| `tests/eventsub_test.ts`   | `src/eventsub.ts`   | notification→`ChatMessage` mappers (follow/cheer/sub/gift/resub/raid, incl. anonymous + gifted-sub skip), `classifyFrame`, session-field extractors, `handleNotification`                          |
| `tests/twitchauth_test.ts` | `src/twitchauth.ts` | OAuth/refresh/auth-code request builders, `parseTokenResponse` (incl. rotated token + errors), `/users` + create-subscription builders/parsers, the `SUBSCRIPTIONS` table                          |
| `tests/youtube_test.ts`    | `src/youtube.ts`    | `tierColor`, `buildBadges`, `emitItem` for each `snippet.type` (text, superchat, supersticker, membership, deletion, unknown)                                                                      |
| `tests/control_test.ts`    | `src/control.ts`    | loopback check, key-body parse, startup-key precedence, and the YouTube/Twitch state-path helpers                                                                                                  |
| `tests/server_test.ts`     | `src/server.ts`     | `colorFor` determinism and format                                                                                                                                                                  |
| `tests/alerts_test.ts`     | `src/alerts.ts`     | `normalizeAlertsConfig` (valid registry, dropped/invalid themes, filtered event kinds, options coercion, junk → default) + `ALERT_EVENT_KINDS`                                                     |
| `tests/fake_test.ts`       | `src/fake.ts`       | `demoActions` coverage, serialize/parse round-trip, `parseFakeAction` validation (rejects bad platform/kind/state/JSON), `describeFakeAction`                                                      |

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

## Previewing message rendering with `fake`

You don't need a live stream to see how each message kind renders. With the
server running, `multichat fake` plays a fixed, curated showcase — a plain chat
message, a colored name, role badges, an image emote, a `/me` action, a follow,
a cheer, a sub, a raid, a Super Chat, a Super Sticker, a membership, a system
row, and a live deletion — into the SSE feed, one event at a time:

```bash
deno task start                 # (terminal 1) against any settings.json
# then, in terminal 2:
deno task fake                  # play the demo into the running server
# or the standalone binary:
multichat fake
multichat fake --port 8080      # non-default port / host, like set-youtube-key
multichat fake --gap 0          # fire the events back-to-back (default gap: 450ms)
```

Open the viewer (`/`), the OBS chat overlay (`/overlay`), or the alerts overlay
(`/alerts`) first so you can watch the events arrive — `/alerts` plays the
shoutout kinds (including the follow) as animated pop-ups. The demo also flips
two throwaway channels (`demo_twitch`, `@demo_yt`) to `live` in the sidebar and,
partway through (after the Twitch events, before the YouTube ones), deletes one
of the earlier messages so you can see the moderation path.

Under the hood this POSTs each event to the loopback-only `POST /api/fake`
endpoint (see [HTTP & SSE API](../api.md#post-apifake)), which injects it
through the very same `Emitter` a real message takes — so what you see is
exactly what a real event would look like. The sequence and validation live in
`src/fake.ts`.

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

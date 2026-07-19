# Chat Features

multichat merges Twitch and YouTube chat into one feed while preserving the
things each platform supports. This page describes what the browser renders.

## Channel panel

A left sidebar lists every configured channel, grouped by platform, each with a
status dot:

| State        | Color | Meaning                                                |
| ------------ | ----- | ------------------------------------------------------ |
| `live`       | green | Twitch channel joined / YouTube live chat being polled |
| `connecting` | amber | Resolving the channel or (re)connecting                |
| `offline`    | grey  | YouTube channel has no active live stream              |
| `error`      | red   | Connection failed; a retry is scheduled                |

Status is driven by the server's real connection state. Twitch flips to `live`
on the per-channel `ROOMSTATE` line Twitch sends after a join; YouTube reflects
resolving → live → offline as the poller finds (or fails to find) an active live
chat. The panel collapses behind a ☰ toggle on narrow screens.

## Platform identity

Every message carries a colored left border and a `T` / `YT` badge (purple for
Twitch, red for YouTube), plus the channel name, so a merged feed stays
readable.

## Role badges

| Platform | Badges                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| Twitch   | broadcaster, moderator, VIP, subscriber, founder, staff, turbo, prime/partner |
| YouTube  | owner, moderator, member, verified                                            |

Badges render as small colored chips before the author name.

## Author colors

Twitch-provided colors are used as-is. Anyone without a color — including all
YouTube authors — gets a stable color derived by hashing their name, so the same
person is always the same color.

## Emotes

Twitch emotes render as images, parsed from Twitch's `emotes` tag (positions are
codepoint-based, so emoji in the message don't shift the offsets). Images come
from `static-cdn.jtvnw.net`.

> **YouTube emotes are text, not images.** The YouTube Data API v3 returns chat
> messages as plain text (`displayMessage`) only — it does not expose
> custom-emoji image URLs or text runs. So YouTube custom emoji show as
> `:shortcodes:` and standard emoji render as native unicode. Image emotes are
> therefore Twitch-only.

## `/me` actions

Twitch `/me` action messages (the `\x01ACTION …\x01` wrapper) render in italic,
tinted with the author's color, with no separating colon.

## Highlighted event rows

Monetary and milestone events render as full-width highlighted banners (accent
border + tinted background) showing an event line, an amount, and any attached
user message:

| Kind           | Platform | Source                                                    |
| -------------- | -------- | --------------------------------------------------------- |
| `follow`       | Twitch   | EventSub `channel.follow`                                 |
| `cheer`        | Twitch   | EventSub `channel.cheer`, else IRC PRIVMSG `bits` tag     |
| `sub`          | Twitch   | EventSub subscribe / gift / resub, else IRC `USERNOTICE`  |
| `raid`         | Twitch   | EventSub `channel.raid`, else IRC `USERNOTICE` raid       |
| `system`       | Twitch   | other `USERNOTICE` (e.g. announcements, with their color) |
| `superchat`    | YouTube  | `superChatEvent` (accent color by Super Chat tier)        |
| `supersticker` | YouTube  | `superStickerEvent` (shows the sticker alt text)          |
| `membership`   | YouTube  | `newSponsorEvent` / `memberMilestoneChatEvent`            |

Twitch `follow`/`cheer`/`sub`/`raid` come from
[Twitch EventSub](configuration.md#twitch-eventsub-alerts) when a channel is
configured for it (follows need EventSub — they're not in anonymous chat). For a
channel without EventSub creds, cheers/subs/raids fall back to the IRC tags as
before, and follows are unavailable. When EventSub covers a channel the IRC copy
of those events is suppressed so nothing appears twice (a cheer's chat text
still shows as a normal message).

## Alerts overlay

The [`/alerts`](api.md#alerts-mode-alerts) browser source turns these highlight
events into big animated shoutout cards — one at a time, centered,
auto-dismissing — for use as a dedicated OBS source alongside (or instead of)
the chat `/overlay`. It shows `follow`, `cheer`, `sub`, `raid`, `superchat`,
`supersticker`, and `membership`; plain chat and `system` notices are skipped.
Preview it without a live stream with `multichat fake`.

### Themes

The alerts overlay is themeable: `settings.json`'s `alerts` block (and the NixOS
module) defines a registry of **named themes** and selects an `activeTheme`.
With no active theme the overlay uses its default card. A theme can limit which
shoutout kinds it restyles (others fall back to the default), and `?theme=NAME`
on the overlay URL overrides the selection per OBS source.

The built-in **`company-memo`** style ("The Company, Inc") renders the alert as
an office memo — `THE COMPANY, INC` over `"[Name] just followed!"` — then, right
before it vanishes, **redacts one of those three words** with a black bar (a
"confidential document" gag). It's typically scoped to Twitch `follow` events.
See [Configuration → Alert themes](configuration.md#alert-themes).

## Deletions

Moderation removes messages live:

| Source                         | Effect                                             |
| ------------------------------ | -------------------------------------------------- |
| Twitch `CLEARMSG`              | Removes the one targeted message                   |
| Twitch `CLEARCHAT` (with user) | Removes all of that user's messages in the channel |
| Twitch `CLEARCHAT` (no user)   | Clears the whole channel's messages                |
| YouTube `messageDeletedEvent`  | Removes the one targeted message                   |

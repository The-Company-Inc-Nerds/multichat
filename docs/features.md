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
resolving → live → offline as the poller finds an active live chat and sees it
end; a YouTube `error` means the API refused the key or the day's quota is spent
(see [Quota and long streams](configuration.md#quota-and-long-streams) — the
log line says which). The panel collapses behind a ☰ toggle on narrow screens.

## Platform identity

Every message carries a colored left border and a `T` / `YT` badge (purple for
Twitch, red for YouTube), plus the channel name, so a merged feed stays
readable.

## Role badges

| Platform | Badges                                                              |
| -------- | ------------------------------------------------------------------- |
| Twitch   | every badge Twitch sends: broadcaster, moderator, VIP, sub, bits, … |
| YouTube  | owner, moderator, member, verified                                  |

Twitch badges render as Twitch's own badge images, before the author name and
in the head of highlighted event rows that carry them (cheers, subs, raids and
announcements arriving over IRC; EventSub events have no badges). Hovering a
badge shows its Twitch title, and a subscriber badge also shows the exact months
from Twitch's `badge-info` (e.g. "1-Year Subscriber (14 months)"). Images come
from `static-cdn.jtvnw.net` at 1x/2x/4x, so they stay sharp in the larger
`/overlay`.

- **Global badges** (moderator, VIP, broadcaster, verified, Prime, Turbo, the
  standard bits and subscriber badges, …) work out of the box, from a built-in
  copy of Twitch's global badge list.
- **The channel's own subscriber and bits badges** need Twitch app credentials,
  since Twitch only hands them out to an authenticated app. See
  [Badge images](configuration.md#badge-images).

A badge with no image (an unknown one, or art that fails to load) falls back to
a small colored text chip: `Mod`, `VIP`, `T2 Sub · 14 mo`, `Bits 1000`, and so
on. YouTube badges are always chips, because the YouTube API reports only
yes/no flags with no badge art.

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
the chat [`/overlay`](api.md#overlay-mode-overlay), which stacks its messages
downward or upward as that source's `?direction` asks. It shows `follow`,
`cheer`, `sub`, `raid`, `superchat`, `supersticker`, and `membership`; plain
chat and `system` notices are skipped. Preview it without a live stream with
`multichat fake`.

### Themes

The alerts overlay is themeable: `settings.json`'s `alerts` block (and the NixOS
module) defines a registry of **named themes** and selects an `activeTheme`.
With no active theme the overlay uses its default card. A theme can limit which
shoutout kinds it restyles (others fall back to the default), and `?theme=NAME`
on the `/alerts` URL overrides the selection per OBS source.

The built-in **`company-memo`** style ("The Company, Inc") renders the alert as
an office memo — `THE COMPANY, INC` over `"[Name] just followed!"` — then, right
before it vanishes, **redacts one of those three words** with a black bar (a
"confidential document" gag). Three kinds get their own stamped documents
instead of the memo: a **sub** is **hiring paperwork** — Tier 1/2/3 map to the
job titles `INTERN`/`ASSOCIATE`/`EXECUTIVE` (a resub is a `CONTRACT RENEWAL`,
a gift a `REFERRAL PROGRAM` crediting the gifter with N referrals); a **raid**
is an **FBI search warrant** (`"[Name] stormed the premises with 250
agents!"`) under a strobing red/blue police-light glow; a **cheer** is a
**petty-cash receipt** stamped `OFF THE BOOKS`. Each card's red verdict stamp
slams onto the paper shortly after it lands. The style is typically scoped to
Twitch `follow`, `sub`, `raid` and `cheer` events. See
[Configuration → Alert themes](configuration.md#alert-themes).

## Deletions

Moderation removes messages live:

| Source                         | Effect                                             |
| ------------------------------ | -------------------------------------------------- |
| Twitch `CLEARMSG`              | Removes the one targeted message                   |
| Twitch `CLEARCHAT` (with user) | Removes all of that user's messages in the channel |
| Twitch `CLEARCHAT` (no user)   | Clears the whole channel's messages                |
| YouTube `messageDeletedEvent`  | Removes the one targeted message                   |

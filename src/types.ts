export type Platform = "twitch" | "youtube";

export type ChannelState = "connecting" | "live" | "offline" | "error";

export interface ChannelStatus {
  platform: Platform;
  name: string;
  state: ChannelState;
}

export interface Badge {
  id: string;
  label: string;
}

export type Segment =
  | { type: "text"; text: string }
  | { type: "emote"; url: string; alt: string };

export type MessageKind =
  | "chat"
  | "action"
  | "cheer"
  | "sub"
  | "raid"
  | "follow"
  | "superchat"
  | "supersticker"
  | "membership"
  | "system";

/** Structured detail for `kind: "sub"` events — how the sub arrived and at
 *  what tier — so alert themes can render tier-specific looks (e.g. the
 *  company-memo hiring paperwork) without parsing `eventText`. */
export interface SubDetail {
  /** Twitch tier as a small number: 1 | 2 | 3 (Prime counts as 1). Absent =
   *  honestly unknown — e.g. an IRC gift-continuation notice, which carries no
   *  sub-plan tag — so renderers should hedge rather than assume Tier 1. */
  tier?: number;
  /** A first-time sub, a resub, or a gift (attributed to the gifter). */
  variant: "new" | "resub" | "gift";
  /** How many subs were gifted (variant "gift"; defaults to 1). */
  count?: number;
}

export interface ChatMessage {
  id: string;
  platform: Platform;
  channel: string;
  author: string;
  authorColor?: string;
  content: string;
  /** Pre-tokenized body (text + emote images). Falls back to `content` when absent. */
  segments?: Segment[];
  badges?: Badge[];
  /** Defaults to "chat" when omitted. */
  kind?: MessageKind;
  /** Monetary/quantity label, e.g. "500 bits" or "$5.00". */
  amount?: string;
  /** Numeric twin of `amount` for kinds whose themed alert cards need the
   *  number (cheer bits, raid viewers) without parsing the label. */
  quantity?: number;
  /** Highlight color for event rows / Super Chat tiers / cheer tiers. */
  accentColor?: string;
  /** Notice line for event rows, e.g. "X subscribed for 3 months". */
  eventText?: string;
  /** Structured sub detail (tier + new/resub/gift) for `kind: "sub"` rows. */
  sub?: SubDetail;
  timestamp: number;
}

/** Frames pushed over SSE. The client switches on `type`. */
export type ServerEvent =
  | { type: "message"; data: ChatMessage }
  | {
    type: "delete";
    platform: Platform;
    channel: string;
    messageId?: string;
    author?: string;
  }
  | { type: "status"; data: ChannelStatus[] }
  | { type: "giveaway"; data: GiveawayState; draw?: GiveawayDraw };

export interface DeleteEvent {
  platform: Platform;
  channel: string;
  messageId?: string;
  author?: string;
}

/** Sink handed to the platform clients by `createServer`. */
export interface Emitter {
  message(msg: ChatMessage): void;
  delete(ev: DeleteEvent): void;
  status(platform: Platform, name: string, state: ChannelState): void;
}

/** One channel to monitor over EventSub. Supply `login` (resolved to an id at
 *  startup) or `broadcasterId` directly; `refreshToken` is the seed used to mint
 *  user access tokens (a rotated one persisted to the state dir wins over it). */
export interface TwitchEventSubChannelConfig {
  login?: string;
  broadcasterId?: string;
  refreshToken?: string;
}

/** Optional Twitch EventSub config. When present, EventSub becomes the source of
 *  truth for that channel's follow/cheer/sub/raid events and IRC only carries its
 *  chat text (see the coverage predicate in twitch.ts). Requires a Twitch app
 *  (clientId + clientSecret) and a per-channel user token authorized by the
 *  broadcaster (scopes: moderator:read:followers, channel:read:subscriptions,
 *  bits:read; plus channel:manage:redemptions on the channel-points channel).
 *  Channels without EventSub creds keep full anonymous IRC behavior. */
export interface TwitchEventSubConfig {
  clientId: string;
  clientSecret: string;
  channels: TwitchEventSubChannelConfig[];
}

export interface TwitchConfig {
  channels: string[];
  eventsub?: TwitchEventSubConfig;
}

// ---- Twitch EventSub WebSocket frames (only the fields we read) ----------

export interface EventSubSession {
  id: string;
  keepalive_timeout_seconds?: number;
  reconnect_url?: string;
  status?: string;
}

export interface EventSubFrame {
  metadata?: {
    message_type?: string;
    message_id?: string;
    subscription_type?: string;
  };
  payload?: {
    session?: EventSubSession;
    subscription?: { id?: string; type?: string; status?: string };
    // The event body varies per subscription type; the mappers read it loosely.
    event?: Record<string, unknown>;
  };
}

/** The frame kinds we act on; anything else is ignored. */
export type EventSubFrameKind =
  | "welcome"
  | "keepalive"
  | "notification"
  | "reconnect"
  | "revocation"
  | "unknown";

export interface YouTubeChannelConfig {
  channelId?: string;
  handle?: string;
  videoId?: string;
}

export interface YouTubeConfig {
  apiKey: string;
  channels: YouTubeChannelConfig[];
}

/**
 * Who may drive the operator control endpoints (`POST /api/giveaway`).
 *
 * - `loopback` (default) — only the machine running the server. Safe anywhere.
 * - `lan`      — loopback plus private/link-local addresses (RFC1918, CGNAT,
 *                169.254/16, fc00::/7, fe80::/10), so a phone or a second PC on
 *                the same home network can press Draw. A public IP is still
 *                refused, which is what makes this safe to leave on for a box
 *                that is only reachable from the LAN.
 * - `any`      — no address check at all. Only sane behind a `controlToken`
 *                (or an authenticating reverse proxy).
 */
export type ControlAccess = "loopback" | "lan" | "any";

export interface ServerConfig {
  port: number;
  host: string;
  /** Who may drive `POST /api/giveaway` (open/close/draw/…). "loopback" (the
   *  default) is the host machine only; "lan" also accepts private/link-local
   *  peers so anyone in the room can press Draw; "any" drops the address check
   *  entirely and should be paired with `controlToken`. See src/control.ts. */
  controlAccess?: ControlAccess;
  /** Optional shared secret required of non-loopback control requests. The
   *  /giveaway page picks it up from `?token=` and remembers it in a cookie. */
  controlToken?: string;
}

/** A named look for the /alerts overlay. `style` selects a built-in visual engine
 *  (e.g. "default" — the standard card — or "company-memo"); `events` limits which
 *  shoutout kinds it restyles (default: all); `options` is a style-specific bag
 *  (e.g. paper/ink colors) passed through to the engine. */
export interface AlertTheme {
  name: string;
  style: string;
  events?: MessageKind[];
  options?: Record<string, string | number | boolean>;
}

/** Alerts overlay theming. `activeTheme` names the theme in effect (unset = the
 *  default look). Configured in settings.json / the NixOS module. */
export interface AlertsConfig {
  activeTheme?: string;
  themes?: AlertTheme[];
}

// ---- Giveaway (prize draw) -----------------------------------------------

/** One eligible entrant in the giveaway pool. Keyed by the stable Twitch
 *  `userId` (numeric) so a display-name change or a repeat `!enter` can't add
 *  someone twice. `number` is the permanent entry number (#1, #2, …), assigned
 *  once at entry and never reused — it decides the guaranteed tier (≤ firstN). */
export interface GiveawayEntrant {
  userId: string;
  login: string;
  displayName: string;
  enteredAt: number;
  number: number;
}

/** Rolling campaign bookkeeping, persisted separately from the pool (a pool
 *  reset must not lose follower progress or milestone credits). */
export interface GiveawayCampaignState {
  /** New followers counted since the campaign started (deduped by user id). */
  followerCount: number;
  /** The user ids already counted, so a re-follow can't double count. */
  countedFollowerIds: string[];
  /** floor(followerCount / followerStep) — recomputed, robust to config edits. */
  milestonesReached: number;
  /** Advisory draw credits armed by milestones (displayed, never a hard gate). */
  creditsRemaining: number;
}

/** One recorded winner (the durable mailing list): who, their entry number,
 *  when they entered, when they were drawn, and under which tier
 *  ("guaranteed" | "milestone-K" | "manual"). */
export interface GiveawayWinner {
  userId: string;
  login: string;
  displayName: string;
  number: number;
  enteredAt: number;
  wonAt: number;
  tier: string;
}

/** Derived, broadcast-sized campaign snapshot attached to each GiveawayState
 *  frame — counts + the last few winners, never the full winners list. */
export interface GiveawayCampaignSummary {
  followerCount: number;
  milestonesReached: number;
  creditsRemaining: number;
  /** Un-drawn entrants with number ≤ firstN (the "next pack" queue). */
  guaranteedRemaining: number;
  /** Un-drawn entrants beyond firstN (the milestone draw pool). */
  poolSize: number;
  winnersTotal: number;
  recentWinners: GiveawayWinner[];
  /** False when followerStep > 0 but follow events can't be received. */
  followTracking: boolean;
}

/** What a drawn winner chose to do with their pack (winner-only chat commands).
 *  `pass` forfeits the pull to the next person's turn and advances the draw. */
export type GiveawayDisposition = "mail" | "donate" | "destroy" | "pass";

/** One giveaway "turn": a drawn winner's slot from draw → disposition. Links to
 *  the chat-cards pack(s) opened for them via `ref === turn.id` on PackReport.
 *  `startedAt` is UTC ms (rendered in the configured timezone in the report). */
export interface GiveawayTurn {
  id: string;
  userId: string;
  login: string;
  displayName: string;
  number: number;
  tier: string;
  startedAt: number;
  endedAt?: number;
  disposition?: GiveawayDisposition;
  dispositionAt?: number;
  /** The turn that passed its cards into this one (a `pass` chain), if any. */
  carriedFromTurnId?: string;
}

/** One recorded terms acceptance (so `!enter` can gate on it). `version` lets a
 *  changed T&C force re-acceptance. */
export interface TermsAcceptance {
  userId: string;
  login: string;
  displayName: string;
  acceptedAt: number;
  version: string;
}

/** A running total for one disposition across the campaign: how many turns chose
 *  it, and the cards/value that flowed through (carry chains fold into the final
 *  non-pass disposition). */
export interface DispositionTotal {
  turns: number;
  cards: number;
  value: number;
}

/** Campaign-wide disposition totals — what the stream mailed / donated / destroyed
 *  / passed, by count and value. Derived from the turn ledger + pack reports. */
export interface TurnAggregates {
  mailed: DispositionTotal;
  donated: DispositionTotal;
  destroyed: DispositionTotal;
  passed: DispositionTotal;
}

/** One entry in a committed draw plan — the pre-seeded order the next winners
 *  will be drawn in (for off-stream prep). */
export interface GiveawayPlanEntry {
  userId: string;
  login: string;
  displayName: string;
  number: number;
}

/** A committed, seeded draw order: the next winners in the order they'll be
 *  drawn. `seed` makes it reproducible; draws consume it in order (skipping
 *  anyone who left the pool). Kept operator-side (CLI) — never broadcast, so the
 *  on-stream reel still looks random. */
export interface GiveawayPlan {
  seed: number;
  createdAt: number;
  order: GiveawayPlanEntry[];
}

/** The live giveaway state pushed to the `/giveaway` page over SSE. */
export interface GiveawayState {
  /** Whether `!enter` is currently accepted. */
  open: boolean;
  entrants: GiveawayEntrant[];
  /** The next entry number to assign (persists across removals/resets). */
  nextNumber: number;
  /** The most recently drawn winner (kept so a reloaded page can show it). */
  lastWinner?: GiveawayEntrant;
  /** Derived campaign snapshot (attached by the engine, not persisted). */
  campaign?: GiveawayCampaignSummary;
  /** The current in-progress turn (drawn, awaiting a disposition), if any. */
  activeTurn?: GiveawayTurn;
  /** Derived disposition totals (attached by the engine, not persisted). */
  aggregates?: TurnAggregates;
}

/** Attached to a `giveaway` SSE frame only when a draw just happened, so every
 *  connected page (incl. the transparent OBS overlay) can play the case-opening
 *  reel: `reel` is the pre-removal entrant list to animate over, landing on
 *  `winner`. `segment` says which tier was drawn from ("guaranteed" = the
 *  first-N queue, "pool" = everyone after). Absent on ordinary state updates. */
export interface GiveawayDraw {
  winner: GiveawayEntrant;
  reel: GiveawayEntrant[];
  segment?: "guaranteed" | "pool";
}

/** Optional chat-reply templates. `{user}` is replaced with the entrant's display
 *  name; other placeholders ({number}, {remaining}, {count}, {milestone},
 *  {draws}) are filled where documented. An empty/omitted field falls back to a
 *  built-in default. */
export interface GiveawayMessages {
  entered?: string;
  notFollowing?: string;
  alreadyEntered?: string;
  winner?: string;
  /** Reply for entrants beyond firstN (they join the milestone pool). */
  enteredPool?: string;
  /** Announcement posted when a follower milestone is crossed. */
  milestone?: string;
  /** Reply to the terms command (e.g. `!terms`): points viewers at the published
   *  T&C. Fills `{terms}` (the T&C url) and `{enter}` (the entry command). */
  terms?: string;
  /** Winner-only disposition confirmations. `{cards}`/`{value}` are filled with
   *  the pack tally where known. `passed` also fills `{next}` if a next winner
   *  was drawn. */
  mailed?: string;
  donated?: string;
  destroyed?: string;
  passed?: string;
}

/** Terms & conditions for the giveaway. Not an acceptance gate: entry is never
 *  blocked on it. Viewers type `${prefix}${command}` (e.g. `!terms`) and the bot
 *  replies with a link to the published terms at `url`. `required`/`version` are
 *  retained for config compatibility but no longer affect entry. */
export interface GiveawayTermsConfig {
  required: boolean;
  command: string;
  version: string;
  url: string;
}

/** Winner-turn disposition commands (Twitch chat words the current winner can
 *  say to decide their pull's fate). `pass` carries the cards to the next
 *  person's turn and advances the draw; the others record + tally. The words are
 *  matched with or without the giveaway prefix. */
export interface GiveawayDispositionConfig {
  enabled: boolean;
  mail: string;
  donate: string;
  destroy: string;
  pass: string;
}

/** Giveaway / prize-draw config (Twitch-only). Watch one channel's chat for
 *  `${prefix}${command}` (e.g. "!enter"), optionally gate on a live Helix follow
 *  check, collect eligible viewers, and draw a winner from the `/giveaway` page.
 *  `replies` posts confirmation/denial/winner messages back to chat as the
 *  broadcaster (needs the `user:write:chat` scope — re-run `multichat login`).
 *  Campaign mode: `firstN` > 0 makes entrants #1..N a guaranteed-winner queue
 *  (each draw picks who's next); `followerStep` > 0 counts new follows via
 *  EventSub and arms `milestoneDraws` advisory draw credits per step. */
export interface GiveawayConfig {
  enabled: boolean;
  /** The single Twitch channel (login, lowercase) the giveaway runs on. */
  channel: string;
  /** Command prefix, e.g. "!". */
  prefix: string;
  /** Command word after the prefix, e.g. "enter". */
  command: string;
  /** Require the entrant to follow the channel (verified via Helix). */
  requireFollow: boolean;
  /** Post confirmation/denial/winner messages back to Twitch chat. */
  replies: boolean;
  /** Entrants #1..firstN are all guaranteed winners (0 = off). */
  firstN: number;
  /** Arm draw credits every this many new followers (0 = no tracking). */
  followerStep: number;
  /** Draw credits armed per milestone crossed. */
  milestoneDraws: number;
  /** IANA timezone the compiled report renders turn-start times in (default
   *  "America/Denver" — Mountain Time). */
  timezone: string;
  /** Optional terms-acceptance gate on `!enter`. */
  terms?: GiveawayTermsConfig;
  /** Optional winner-turn disposition commands (mail/donate/destroy/pass). */
  disposition?: GiveawayDispositionConfig;
  messages?: GiveawayMessages;
}

// ---- Integrations (outbound event bus + inbound pack reports) ------------

/** One external tool multichat pushes giveaway-lifecycle events to. `adapter`
 *  selects delivery: "webhook" POSTs a generic `{event, ts, data}` envelope to
 *  `baseUrl`; "chat-cards" maps events to the chat-cards HTTP API (e.g. opening a
 *  pack under the drawn winner). `events` filters which event types are sent
 *  (`"*"` = all). `token` is the bearer the target requires; `packSize` (chat-
 *  cards only) is the pack size to open (0/unset = chat-cards' own default). */
export interface IntegrationSubscriber {
  name: string;
  adapter: "webhook" | "chat-cards";
  baseUrl: string;
  events: string[];
  enabled: boolean;
  token?: string;
  packSize?: number;
}

/** Outbound-integration config (optional). `callbackToken`, when set, is the
 *  bearer an external tool must present to POST results back to
 *  `/api/turn-report`; without it that endpoint is loopback-only. */
export interface IntegrationsConfig {
  callbackToken?: string;
  subscribers: IntegrationSubscriber[];
}

/** One card in a pack report pushed back by chat-cards — a trimmed view of its
 *  richer card record (just what the giveaway ledger needs). */
export interface PackCardSummary {
  name: string;
  number?: string;
  set?: string;
  rarity?: string;
  value: number;
  image?: string;
}

/** A pack-opening summary reported back to multichat by an integration
 *  (chat-cards): whose pack, the cards pulled, and the running total value.
 *  Keyed by `packId` (last write wins) and correlated to a giveaway turn by
 *  `ref` (the winner's userId / a turn id). Timestamps are epoch ms. */
export interface PackReport {
  packId: string;
  ref?: string;
  winner?: string;
  label?: string;
  index?: number;
  size?: number;
  openedAt: number;
  closedAt?: number;
  totalValue: number;
  cardCount: number;
  cards: PackCardSummary[];
  receivedAt: number;
}

// ---- Channel points (Twitch custom rewards → cobblemon-overlay effects) --

/** Effect parameters handed through to the game unchanged. Flat JSON scalars —
 *  the mod is the authority on what each effect accepts (it refuses bad ones,
 *  which refunds the viewer). */
export type RewardParams = Record<string, string | number | boolean>;

/** One managed Twitch custom reward: the catalogue entry multichat creates via
 *  Helix (so it — and only it — may fulfil or refund the redemptions) and the
 *  game effect a redemption asks for. `key` is the stable identity (persisted
 *  key → reward id); `title` is what viewers see (≤45 chars, unique on the
 *  channel). `cooldownSec` is ≥60 on every reward: Twitch only allows offline
 *  redemptions of rewards without a cooldown, so this keeps them all live-only.
 *  `maxPerStream`/`maxPerUserPerStream` 0 = no limit. Rewards are always created
 *  without user input and never skip the request queue (only UNFULFILLED
 *  redemptions can be refunded). */
export interface RewardSpec {
  key: string;
  title: string;
  cost: number;
  prompt: string;
  effect: string;
  params: RewardParams;
  cooldownSec: number;
  maxPerStream: number;
  maxPerUserPerStream: number;
  /** "#RRGGBB" background on the reward tile. */
  color: string;
  enabled: boolean;
}

/** Channel-point chaos: viewers redeem managed custom rewards on `channel`, and
 *  each redemption becomes a game effect queued on the cobblemon-overlay at
 *  `overlayUrl` (loopback on the broadcast host), which the mod pulls and runs.
 *  The outcome fulfils the redemption or refunds it. `ttlSec` is how long an
 *  effect may wait to run before it is given up on (and refunded); `autoPause`
 *  pauses the rewards on Twitch while the overlay reports the game isn't
 *  accepting; `announce` adds a system row to chat per redemption. `rewards` is
 *  always concrete here: settings `null`/absent means DEFAULT_CATALOG. */
export interface ChannelPointsConfig {
  enabled: boolean;
  /** Twitch login the rewards live on (must be in twitch.eventsub.channels). */
  channel: string;
  overlayUrl: string;
  /** Bearer for the overlay's effect routes ("" = none). */
  overlayToken: string;
  ttlSec: number;
  autoPause: boolean;
  announce: boolean;
  rewards: RewardSpec[];
}

/** Where a redemption is in the pipeline: `received` (in the ledger, not yet
 *  accepted by the overlay), `queued` (the overlay holds it), `resolved` (final
 *  outcome known — independent of whether Twitch has been told yet). */
export type RedemptionState = "received" | "queued" | "resolved";

/** How a redemption ends on Twitch: FULFILLED (the effect ran / is armed) or
 *  CANCELED (refunded — the effect was refused, expired or never delivered). */
export type RedemptionOutcome = "fulfilled" | "canceled";

/** One redemption in the channel-points ledger, keyed by the Twitch redemption
 *  id (`sim-<uuid>` for a simulated one) — the idempotency key on every hop.
 *  Times are epoch ms. `twitchSynced` means Twitch has the final status (our
 *  PATCH landed, or it was resolved in the rewards queue); simulated entries
 *  never touch Twitch. `attempts` counts overlay deliveries (answered or not —
 *  a timed-out POST may still have landed); `syncAttempts` /
 *  `nextSyncAt` back off a failing Twitch PATCH. */
export interface RedemptionEntry {
  id: string;
  rewardId: string;
  key: string;
  effect: string;
  params: RewardParams;
  title: string;
  cost: number;
  viewer: string;
  login: string;
  redeemedAt: number;
  receivedAt: number;
  expiresAt: number;
  state: RedemptionState;
  outcome?: RedemptionOutcome;
  /** Why it resolved the way it did (the overlay/mod reason, or ours:
   *  "timeout", "overlay_unreachable", "stale", "manual", "external", …). */
  reason?: string;
  /** Free-text detail from the mod ("3 Pokémon filed to the PC"). */
  detail?: string;
  resolvedAt?: number;
  twitchSynced: boolean;
  simulated: boolean;
  attempts: number;
  syncAttempts?: number;
  nextSyncAt?: number;
  /** Resolved by multichat (refund, rewards-queue resolution, deadline) after a
   *  POST /effects was attempted, so the overlay may still hold the effect: the
   *  pump re-sends POST /effects/<id>/cancel until the overlay answers 200 or
   *  404, then clears this. Never pruned while set. `cancelAttempts` /
   *  `nextCancelAt` back off a failing withdrawal. */
  cancelOwed?: boolean;
  cancelAttempts?: number;
  nextCancelAt?: number;
}

export interface Settings {
  server: ServerConfig;
  twitch: TwitchConfig;
  youtube: YouTubeConfig;
  alerts?: AlertsConfig;
  giveaway?: GiveawayConfig;
  integrations?: IntegrationsConfig;
  channelPoints?: ChannelPointsConfig;
}

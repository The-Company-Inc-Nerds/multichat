// Pure Twitch chat-badge helpers: which image to show for a `badges` tag entry,
// and the short text to show when there is none.
//
// Badge art comes from three places, best first: the channel's own custom
// badges (Helix GET /chat/badges?broadcaster_id=<room-id> — subscriber and bits
// art), Twitch's global badges (Helix GET /chat/badges/global), and the
// built-in snapshot of that global list (twitchbadges.ts), which is what makes
// mod/VIP/broadcaster/Prime render as images with zero configuration. The two
// Helix lists need a Twitch app token; the fetching and caching live in the
// badge manager in main.ts, which hands twitch.ts a BadgeSource. Everything
// here is side-effect-free so the test suite can drive it directly.

import type { Badge } from "./types.ts";
import { GLOBAL_BADGES } from "./twitchbadges.ts";

/** One badge version's image set + Twitch's title for it. */
export interface BadgeArt {
  title: string;
  /** 18px. */
  url: string;
  /** 36px. */
  url2x: string;
  /** 72px. */
  url4x: string;
}

/** Badge art keyed "set/version" (e.g. "subscriber/3012"). */
export type BadgeArtMap = ReadonlyMap<string, BadgeArt>;

const CDN = "https://static-cdn.jtvnw.net/badges/v1";

/** Art for a badge image uuid on Twitch's CDN (sizes /1, /2, /3). */
export function cdnBadgeArt(uuid: string, title: string): BadgeArt {
  const base = `${CDN}/${uuid}`;
  return { title, url: `${base}/1`, url2x: `${base}/2`, url4x: `${base}/3` };
}

/** The built-in snapshot's art for one global badge version, if it has it. */
export function snapshotArt(
  set: string,
  version: string,
): BadgeArt | undefined {
  const key = `${set}/${version}`;
  if (!Object.hasOwn(GLOBAL_BADGES, key)) return undefined;
  const [uuid, title] = GLOBAL_BADGES[key];
  return cdnBadgeArt(uuid, title);
}

/** Numeric badge version, or null for a non-numeric one ("blue-1"). */
function numericVersion(version: string): number | null {
  return /^\d+$/.test(version) ? Number(version) : null;
}

/** The channel's art for the largest `set` version at or below `version` with
 *  the same tier prefix (floor(v/1000): Tier 2 subscriber badges are 2000+,
 *  Tier 3 are 3000+), so a 14-month sub still gets the channel's 12-month art
 *  when the exact version is missing. */
function nearestLower(
  map: BadgeArtMap | undefined,
  set: string,
  version: string,
): BadgeArt | undefined {
  const want = numericVersion(version);
  if (!map || want === null) return undefined;
  const tier = Math.floor(want / 1000);
  const prefix = `${set}/`;
  let best: { v: number; art: BadgeArt } | undefined;
  for (const [key, art] of map) {
    if (!key.startsWith(prefix)) continue;
    const v = numericVersion(key.slice(prefix.length));
    if (v === null || v > want || Math.floor(v / 1000) !== tier) continue;
    if (!best || v > best.v) best = { v, art };
  }
  return best?.art;
}

/**
 * The art to show for one badge, or undefined (render the text chip). Order:
 * the channel's exact version; for subscriber only, the channel's nearest
 * lower version in the same tier (a channel's own sub art beats Twitch's
 * generic star); the global exact version, live Helix data before the
 * snapshot; for bits, the channel's nearest lower version only after that,
 * since Twitch shows its global gem for any tier the channel didn't customise;
 * then, for subscriber/founder, the generic global version 0.
 */
export function resolveBadgeArt(
  set: string,
  version: string,
  channel?: BadgeArtMap,
  global?: BadgeArtMap,
): BadgeArt | undefined {
  const key = `${set}/${version}`;
  const exact = channel?.get(key);
  if (exact) return exact;
  if (set === "subscriber") {
    const lower = nearestLower(channel, set, version);
    if (lower) return lower;
  }
  const g = global?.get(key) ?? snapshotArt(set, version);
  if (g) return g;
  if (set === "bits") return nearestLower(channel, set, version);
  if (set === "subscriber" || set === "founder") {
    return global?.get(`${set}/0`) ?? snapshotArt(set, "0");
  }
  return undefined;
}

// Short chip text for the sets people actually see. Kept terse (and identical
// to the labels shipped before badge images) so a chip never crowds the name.
const LABELS: Record<string, string> = {
  broadcaster: "Broadcaster",
  moderator: "Mod",
  lead_moderator: "Lead Mod",
  vip: "VIP",
  partner: "Verified",
  staff: "Staff",
  admin: "Admin",
  global_mod: "Global Mod",
  turbo: "Turbo",
  premium: "Prime",
  "artist-badge": "Artist",
  no_audio: "No Audio",
  no_video: "No Video",
};

/** A positive whole month count from a badge-info value, else 0. */
function monthCount(info: string | undefined): number {
  return info && /^\d+$/.test(info) ? Number(info) : 0;
}

/** "glhf-pledge" → "Glhf Pledge", "60-seconds_1" → "60 Seconds". */
function prettifyBadgeId(id: string): string {
  const words = id.split(/[-_]+/).filter((w) => w);
  if (words.length > 1 && words[words.length - 1] === "1") words.pop();
  if (!words.length) return id;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Short human text for a badge chip / tooltip. Subscriber badges carry their
 * tier ("T2 Sub", "T3 Sub" for 2000+/3000+ versions) and, with badge-info, the
 * exact months ("Sub · 14 mo"); bits and gift badges carry their count;
 * unknown sets get a prettified id rather than the raw one.
 */
export function badgeLabel(set: string, version = "", info?: string): string {
  if (set === "subscriber" || set === "founder") {
    let label = set === "founder" ? "Founder" : "Sub";
    const v = set === "subscriber" ? numericVersion(version) ?? 0 : 0;
    if (v >= 3000) label = `T3 ${label}`;
    else if (v >= 2000) label = `T2 ${label}`;
    const months = monthCount(info);
    if (months) label += ` · ${months} mo`;
    return label;
  }
  if (set === "bits") return version ? `Bits ${version}` : "Bits";
  if (set === "sub-gifter") return version ? `Gifter ${version}` : "Gifter";
  return Object.hasOwn(LABELS, set) ? LABELS[set] : prettifyBadgeId(set);
}

/**
 * Attach resolved art to a parsed badge: the image URLs, and Twitch's own
 * title as the label (the image's alt/tooltip), with the exact months for a
 * subscriber/founder badge — "3-Month Subscriber (14 months)". No art = the
 * badge unchanged (it renders as its text chip).
 */
export function decorateBadge(b: Badge, art?: BadgeArt): Badge {
  if (!art) return b;
  let label = art.title || b.label;
  const months = b.id === "subscriber" || b.id === "founder"
    ? monthCount(b.info)
    : 0;
  if (months) label += ` (${months} month${months === 1 ? "" : "s"})`;
  return { ...b, label, url: art.url, url2x: art.url2x, url4x: art.url4x };
}

/** Where twitch.ts looks badge art up. `resolve` must be synchronous and must
 *  not throw (it runs on the IRC path); `roomId` is the channel's broadcaster
 *  id from the message's `room-id` tag. `noteRoom` hears every ROOMSTATE's
 *  room id, so a source can start loading that channel's badges early. */
export interface BadgeSource {
  resolve(
    roomId: string | undefined,
    set: string,
    version: string,
  ): BadgeArt | undefined;
  noteRoom?(roomId: string): void;
}

/** The zero-config source: global badges from the built-in snapshot only. */
export const SNAPSHOT_BADGES: BadgeSource = {
  resolve: (_roomId, set, version) => resolveBadgeArt(set, version),
};

// Pure helpers for channel-point chaos: viewers spend Twitch channel points on
// custom rewards that make the streamer's Cobblemon run harder, and each
// redemption becomes a game effect the cobblemon-overlay queues for the mod.
//
// Everything here is side-effect-free so the test suite can drive it directly:
// config normalization (from settings.json) + the DEFAULT_CATALOG, the reward
// sync diff (catalogue ↔ what Twitch holds), the redemption-ledger reducers, the
// overlay effect-API wire format and outcome mapping, and the loopback
// POST /api/rewards wire. The stateful engine (Helix calls, the pump / reconcile
// / auto-pause loops, persistence) lives in main.ts, matching the project's
// "pure logic in src/, wiring in main.ts" split (see giveaway.ts / control.ts).
//
// The idempotency key end to end is the Twitch redemption id (`sim-<uuid>` for a
// simulated one): EventSub is at-least-once, so every reducer is a no-op on an
// id it has already seen.

import type {
  ChannelPointsConfig,
  ChatMessage,
  RedemptionEntry,
  RedemptionOutcome,
  RedemptionState,
  RewardParams,
  RewardSpec,
} from "./types.ts";
import {
  type CustomRewardFields,
  type HelixResult,
  MAX_REDEMPTION_IDS,
  REDEMPTIONS_MANAGE_SCOPE,
  type TwitchCustomReward,
} from "./twitchauth.ts";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Coerce to a non-negative integer; garbage/negatives fall back. */
function nonneg(x: unknown, fallback: number): number {
  const n = Math.floor(Number(x));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** Twitch's limits on a custom reward (Create Custom Rewards). */
const MAX_TITLE = 45;
const MAX_PROMPT = 200;
/** Every reward gets a cooldown ≥ 60s: Twitch lets viewers redeem a reward
 *  while the channel is offline only when it has NO cooldown, and 60s is also
 *  the least the Twitch UI shows. */
export const MIN_COOLDOWN_SEC = 60;
const MAX_COOLDOWN_SEC = 604_800; // 7 days, Twitch's ceiling
/** Twitch caps a channel at 50 custom rewards, dashboard-made ones included. */
const MAX_REWARDS = 50;

export const DEFAULT_OVERLAY_URL = "http://127.0.0.1:8082";
export const DEFAULT_TTL_SEC = 600;
/** The overlay clamps an effect's ttlSec to this range, so ours matches. */
const MIN_TTL_SEC = 30;
const MAX_TTL_SEC = 3600;

/** Env var that overrides channelPoints.overlayToken (the NixOS module stages it
 *  from a LoadCredential file so the token never sits in the Nix store). */
export const EFFECTS_TOKEN_ENV = "MULTICHAT_EFFECTS_TOKEN";

/** Prefix of a simulated redemption's id (`multichat rewards simulate`). */
export const SIMULATED_ID_PREFIX = "sim-";
/** Viewer name a simulated redemption carries when none is given. */
export const DEFAULT_SIMULATED_VIEWER = "The Board";

// ---- Effect vocabulary --------------------------------------------------

/** The effect ids the mod implements (wire ids, contract §1). The mod is the
 *  authority — it refuses an unknown id or bad params, which refunds the viewer
 *  — so multichat passes any well-formed id through and only warns at startup
 *  about ones outside this list. */
export const KNOWN_EFFECTS: readonly string[] = [
  "drop_held_item",
  "force_jump",
  "about_face",
  "hotbar_shuffle",
  "potion",
  "sprint_lock",
  "spawn_mob",
  "pokemon_status",
  "magikarp_mandate",
  "forfeit_turns",
];

// ---- The default catalogue ----------------------------------------------

/** Reward tile colors by tier: T1 nuisances, T2 debuffs, T3 real threats,
 *  T4/T5 run-altering. */
export const TIER_COLORS = {
  1: "#9AA5B1",
  2: "#E0A526",
  3: "#D9534F",
  4: "#7A1F1F",
  5: "#7A1F1F",
} as const;

function reward(
  key: string,
  title: string,
  effect: string,
  params: RewardParams,
  cost: number,
  cooldownSec: number,
  maxPerStream: number,
  tier: keyof typeof TIER_COLORS,
  prompt: string,
): RewardSpec {
  return {
    key,
    title,
    cost,
    prompt,
    effect,
    params,
    cooldownSec,
    maxPerStream,
    maxPerUserPerStream: 0,
    color: TIER_COLORS[tier],
    enabled: true,
  };
}

/**
 * The catalogue used when settings leave `channelPoints.rewards` null/absent.
 * Prompts are The Company, Inc.'s corporate-villain voice. Every effect makes the
 * run harder, never easier; the physical ones never land a killing blow (the mod
 * enforces that), and the two Pokémon-battle ones follow the streamer's rulings:
 * Magikarp Mandate is literal and full-risk, Mandatory Meeting skips turns in the
 * next trainer battle with no mercy.
 */
export const DEFAULT_CATALOG: readonly RewardSpec[] = [
  reward(
    "butterfingers",
    "Butterfingers",
    "drop_held_item",
    {},
    250,
    60,
    0,
    1,
    "Per Policy 4.2, whatever the streamer is holding is hereby confiscated and relocated to the floor. Productivity is its own reward.",
  ),
  reward(
    "hop_to_it",
    "Hop To It",
    "force_jump",
    {},
    150,
    60,
    0,
    1,
    "Management has observed insufficient enthusiasm. The streamer will hop to it, immediately. The jump is mandatory and non-negotiable.",
  ),
  reward(
    "about_face",
    "About Face",
    "about_face",
    {},
    150,
    60,
    0,
    1,
    "Strategic pivot approved. The streamer will face the opposite direction, effective immediately, per the latest restructuring memo.",
  ),
  reward(
    "hotbar_reorg",
    "Hotbar Reorg",
    "hotbar_shuffle",
    {},
    400,
    120,
    0,
    1,
    "Our efficiency consultants have reorganized the streamer's hotbar for maximum synergy. Nothing is where it was. This is growth.",
  ),
  reward(
    "budget_cuts",
    "Budget Cuts",
    "potion",
    { effect: "slowness", amplifier: 1, seconds: 45 },
    750,
    180,
    0,
    2,
    "Due to budget cuts, the streamer's movement allowance is reduced for 45 seconds. Please walk slower to conserve company resources.",
  ),
  reward(
    "mandatory_overtime",
    "Mandatory Overtime",
    "potion",
    { effect: "mining_fatigue", amplifier: 1, seconds: 90 },
    750,
    180,
    0,
    2,
    "Mandatory overtime is in effect. The streamer's mining output is throttled for 90 seconds while HR reviews the timesheets.",
  ),
  reward(
    "performance_review",
    "Performance Review",
    "potion",
    { effect: "weakness", amplifier: 1, seconds: 60 },
    750,
    180,
    0,
    2,
    "The streamer's performance review is in. Strength has been downgraded for 60 seconds pending improvement. No appeals.",
  ),
  reward(
    "team_building_cruise",
    "Team-Building Cruise",
    "potion",
    { effect: "nausea", amplifier: 0, seconds: 15 },
    750,
    180,
    0,
    2,
    "Congratulations! The streamer is enrolled in a Team-Building Cruise. The seas are rough. Attendance is mandatory for 15 seconds.",
  ),
  reward(
    "lights_out",
    "Lights Out",
    "potion",
    { effect: "darkness", amplifier: 0, seconds: 20 },
    1000,
    180,
    0,
    2,
    "Facilities is cutting power to save costs. The streamer works in the dark for 20 seconds. Complaints may be filed with nobody.",
  ),
  reward(
    "hiring_freeze",
    "Hiring Freeze",
    "sprint_lock",
    { seconds: 60 },
    1000,
    300,
    0,
    2,
    "A company-wide hiring freeze now covers the streamer's stamina. No sprinting for 60 seconds, by order of Finance.",
  ),
  reward(
    "uninvited_contractor",
    "Uninvited Contractor",
    "spawn_mob",
    {},
    2500,
    300,
    0,
    3,
    "An outside contractor has been retained to motivate the streamer. They were not vetted. They are hostile. They bill by the hour.",
  ),
  reward(
    "workplace_incident",
    "Workplace Incident",
    "pokemon_status",
    {},
    5000,
    600,
    5,
    3,
    "A workplace incident involving one of the streamer's Pokémon has been logged. HR has applied a status condition. There is no appeals process.",
  ),
  reward(
    "magikarp_mandate",
    "Magikarp Mandate",
    "magikarp_mandate",
    {},
    15000,
    3600,
    1,
    4,
    "Restructuring! The streamer's entire party is filed to the PC and a level 1 Magikarp is the new team lead. Staff return only by PC withdrawal.",
  ),
  reward(
    "mandatory_meeting",
    "Mandatory Meeting",
    "forfeit_turns",
    { turns: 3 },
    25000,
    3600,
    1,
    5,
    "The streamer's team is summoned to a Mandatory Meeting: their next trainer battle opens with 3 skipped turns. Attendance is not optional.",
  ),
];

function cloneSpec(s: RewardSpec): RewardSpec {
  return { ...s, params: { ...s.params } };
}

// ---- Config normalization -------------------------------------------------

export type RewardSpecResult =
  | { ok: true; spec: RewardSpec; notes: string[] }
  | { ok: false; message: string };

/**
 * Validate one catalogue entry from settings.json. Fatal problems (no usable key/
 * title/effect/cost, a title or prompt over Twitch's limit, non-object params)
 * reject the reward — creating it would 400 on Twitch or misfire in the game.
 * Recoverable ones are fixed and noted: a missing or too-short cooldown is raised
 * to 60s (every reward must have one, so none is redeemable offline), a bad color
 * falls back to the T1 grey, and non-scalar params are dropped.
 */
export function normalizeRewardSpec(raw: unknown): RewardSpecResult {
  if (!isObj(raw)) return { ok: false, message: "reward must be an object" };
  const key = str(raw.key).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) {
    return {
      ok: false,
      message: `key "${
        str(raw.key)
      }" must be 1-64 of a-z 0-9 _ - (starting a-z0-9)`,
    };
  }
  const title = str(raw.title).trim();
  if (!title) return { ok: false, message: `${key}: title is required` };
  // UTF-16 length ≥ code points, so passing here is within Twitch's 45 however
  // it counts.
  if (title.length > MAX_TITLE) {
    return {
      ok: false,
      message: `${key}: title is longer than ${MAX_TITLE} characters`,
    };
  }
  const cost = Math.floor(Number(raw.cost));
  if (!Number.isFinite(cost) || cost < 1) {
    return { ok: false, message: `${key}: cost must be a whole number ≥ 1` };
  }
  const prompt = str(raw.prompt).trim();
  if (prompt.length > MAX_PROMPT) {
    return {
      ok: false,
      message: `${key}: prompt is longer than ${MAX_PROMPT} characters`,
    };
  }
  // The overlay's wire shape for an effect id (it 400s anything else).
  const effect = str(raw.effect).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(effect)) {
    return {
      ok: false,
      message: `${key}: effect id is required (e.g. potion)`,
    };
  }
  const notes: string[] = [];
  const params: RewardParams = {};
  if (raw.params !== undefined && raw.params !== null) {
    if (!isObj(raw.params)) {
      return { ok: false, message: `${key}: params must be an object` };
    }
    for (const [k, v] of Object.entries(raw.params)) {
      if (
        typeof v === "string" || typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v))
      ) {
        params[k] = v;
      } else {
        notes.push(`${key}: dropped non-scalar param "${k}"`);
      }
    }
  }
  let cooldownSec = Math.floor(Number(raw.cooldownSec));
  if (!Number.isFinite(cooldownSec) || cooldownSec < MIN_COOLDOWN_SEC) {
    notes.push(
      `${key}: cooldownSec raised to ${MIN_COOLDOWN_SEC} (every reward needs one, ` +
        `so none can be redeemed while offline)`,
    );
    cooldownSec = MIN_COOLDOWN_SEC;
  } else if (cooldownSec > MAX_COOLDOWN_SEC) {
    notes.push(`${key}: cooldownSec capped at ${MAX_COOLDOWN_SEC} (7 days)`);
    cooldownSec = MAX_COOLDOWN_SEC;
  }
  let color = str(raw.color).trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    color = color.toUpperCase();
  } else {
    if (color) {
      notes.push(
        `${key}: color "${color}" is not #RRGGBB — using ${TIER_COLORS[1]}`,
      );
    }
    color = TIER_COLORS[1];
  }
  return {
    ok: true,
    spec: {
      key,
      title,
      cost,
      prompt,
      effect,
      params,
      cooldownSec,
      maxPerStream: nonneg(raw.maxPerStream, 0),
      maxPerUserPerStream: nonneg(raw.maxPerUserPerStream, 0),
      color,
      enabled: raw.enabled !== false,
    },
    notes,
  };
}

function normalizeRewards(
  raw: unknown,
  issue: (m: string) => void,
): RewardSpec[] {
  // null/absent = the built-in catalogue; a list replaces it wholesale.
  if (raw === undefined || raw === null) return DEFAULT_CATALOG.map(cloneSpec);
  if (!Array.isArray(raw)) {
    issue(
      "channelPoints.rewards must be a list (or null for the default catalogue) — no rewards",
    );
    return [];
  }
  const out: RewardSpec[] = [];
  const keys = new Set<string>();
  const titles = new Set<string>();
  for (const r of raw) {
    const res = normalizeRewardSpec(r);
    if (!res.ok) {
      issue(`reward dropped — ${res.message}`);
      continue;
    }
    res.notes.forEach(issue);
    const s = res.spec;
    if (keys.has(s.key)) {
      issue(`reward dropped — duplicate key "${s.key}"`);
      continue;
    }
    // Twitch requires unique titles per channel; compare case-insensitively to
    // be safe rather than learn it from a 400 mid-sync.
    if (titles.has(s.title.toLowerCase())) {
      issue(`reward dropped — duplicate title "${s.title}"`);
      continue;
    }
    keys.add(s.key);
    titles.add(s.title.toLowerCase());
    out.push(s);
  }
  if (out.length > MAX_REWARDS) {
    issue(
      `${out.length} rewards configured — Twitch allows ${MAX_REWARDS} per channel ` +
        `(dashboard ones included); keeping the first ${MAX_REWARDS}`,
    );
    return out.slice(0, MAX_REWARDS);
  }
  return out;
}

/**
 * Validate/normalize the raw `channelPoints` block from settings.json. Never
 * throws: garbage degrades to a disabled default. `rewards` null/absent means the
 * DEFAULT_CATALOG; a list is a full replacement. `onIssue` hears about every entry
 * dropped or adjusted (main.ts logs them), so a bad catalogue line is visible
 * instead of silently missing from Twitch.
 */
export function normalizeChannelPointsConfig(
  raw: unknown,
  onIssue: (message: string) => void = () => {},
): ChannelPointsConfig {
  const o = isObj(raw) ? raw : {};
  let overlayUrl = str(o.overlayUrl).trim().replace(/\/+$/, "");
  if (!overlayUrl) {
    overlayUrl = DEFAULT_OVERLAY_URL;
  } else if (!/^https?:\/\/[^/\s]+/i.test(overlayUrl)) {
    onIssue(
      `channelPoints.overlayUrl "${overlayUrl}" is not an http(s) URL — using ${DEFAULT_OVERLAY_URL}`,
    );
    overlayUrl = DEFAULT_OVERLAY_URL;
  }
  let ttlSec = Math.floor(Number(o.ttlSec ?? DEFAULT_TTL_SEC));
  if (!Number.isFinite(ttlSec)) ttlSec = DEFAULT_TTL_SEC;
  if (ttlSec < MIN_TTL_SEC || ttlSec > MAX_TTL_SEC) {
    const clamped = Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, ttlSec));
    onIssue(
      `channelPoints.ttlSec ${ttlSec} is outside ${MIN_TTL_SEC}..${MAX_TTL_SEC} — using ${clamped}`,
    );
    ttlSec = clamped;
  }
  return {
    enabled: o.enabled === true,
    channel: str(o.channel).trim().toLowerCase(),
    overlayUrl,
    overlayToken: str(o.overlayToken).trim(),
    ttlSec,
    autoPause: o.autoPause !== false,
    announce: o.announce !== false,
    rewards: normalizeRewards(o.rewards, onIssue),
  };
}

/** Overlay the effects token from the environment (MULTICHAT_EFFECTS_TOKEN) so
 *  it need not sit in settings.json — env wins, mirroring applyIntegrationEnv.
 *  Pure: the caller supplies the lookup. Returns a new config. */
export function applyChannelPointsEnv(
  cfg: ChannelPointsConfig,
  getEnv: (name: string) => string | undefined,
): ChannelPointsConfig {
  const token = (getEnv(EFFECTS_TOKEN_ENV) ?? "").trim();
  return token ? { ...cfg, overlayToken: token } : { ...cfg };
}

/**
 * Startup sanity checks for an enabled block, as log lines (empty = fine). The
 * rewards live on the channel's broadcaster token, so without that channel in
 * EventSub nothing reaches Twitch (only `rewards simulate` works); an effect id
 * the mod doesn't know is refused — and refunded — on every redemption.
 */
export function channelPointsSetupProblems(
  cfg: ChannelPointsConfig,
  eventsubLogins: readonly string[],
  hasEventSubApp: boolean,
): string[] {
  const out: string[] = [];
  if (!cfg.channel) {
    out.push(
      "channelPoints.channel is not set — no Twitch rewards will be managed " +
        "(only `multichat rewards simulate` works).",
    );
  } else if (!eventsubLogins.includes(cfg.channel) || !hasEventSubApp) {
    out.push(
      `"${cfg.channel}" has no EventSub connection (it must be in ` +
        `twitch.eventsub.channels, with the app's clientId/clientSecret) — multichat ` +
        `can't create the rewards, receive redemptions or fulfil/refund them; only ` +
        "`multichat rewards simulate` works.",
    );
  }
  if (cfg.rewards.length === 0) {
    out.push("channelPoints has no rewards configured — nothing to redeem.");
  }
  for (const r of cfg.rewards) {
    if (!KNOWN_EFFECTS.includes(r.effect)) {
      out.push(
        `reward "${r.key}" uses effect "${r.effect}", which the mod doesn't ` +
          `implement — every redemption of it will be refused and refunded.`,
      );
    }
  }
  return out;
}

/**
 * The loud startup warning for a channel-points token minted before
 * channel:manage:redemptions was requested — or null when the scope is there (or
 * the token response didn't say, `scopes` null). The persisted rotated refresh
 * token beats every seed, so a fresh `multichat login` alone changes nothing:
 * the state file has to go too, and the seed has to be replaced wherever it
 * lives (the Proton Pass item behind LoadCredential on NixOS).
 */
export function channelPointsScopeWarning(
  login: string,
  scopes: readonly string[] | null,
  tokenPath: string | null,
): string | null {
  if (!scopes || scopes.includes(REDEMPTIONS_MANAGE_SCOPE)) return null;
  return [
    `[ChannelPoints] ${login}'s Twitch token lacks ${REDEMPTIONS_MANAGE_SCOPE} — ` +
    `rewards can't be created, redemptions won't arrive, and nothing can be ` +
    `fulfilled or refunded. To fix:`,
    `  1. run 'multichat login' signed in as ${login};`,
    "  2. put the new refresh token where the seed lives (settings.json " +
    "refreshToken, or the refreshTokenFile secret — e.g. the Proton Pass item " +
    "behind LoadCredential);",
    tokenPath
      ? `  3. delete ${tokenPath} — the persisted rotated token wins over any ` +
        "seed, so the old scopes stay until it is gone;"
      : "  3. (no state directory — the seed is re-read at every start);",
    "  4. restart multichat.",
  ].join("\n");
}

// ---- Reward sync (catalogue ↔ Twitch) ------------------------------------

/** The Helix fields a catalogue entry should have on Twitch. Always a cooldown,
 *  never user input, never skip-the-queue (only UNFULFILLED redemptions can be
 *  refunded). A limit that is off is sent as just its `is_*_enabled:false` flag —
 *  Twitch rejects a 0 value. */
export function rewardFields(spec: RewardSpec): CustomRewardFields {
  return {
    title: spec.title,
    cost: spec.cost,
    prompt: spec.prompt,
    background_color: spec.color.toUpperCase(),
    is_enabled: spec.enabled,
    is_user_input_required: false,
    should_redemptions_skip_request_queue: false,
    is_global_cooldown_enabled: true,
    global_cooldown_seconds: spec.cooldownSec,
    is_max_per_stream_enabled: spec.maxPerStream > 0,
    ...(spec.maxPerStream > 0 ? { max_per_stream: spec.maxPerStream } : {}),
    is_max_per_user_per_stream_enabled: spec.maxPerUserPerStream > 0,
    ...(spec.maxPerUserPerStream > 0
      ? { max_per_user_per_stream: spec.maxPerUserPerStream }
      : {}),
  };
}

/** The same field set read off a reward Twitch holds, for comparison. */
function currentFields(r: TwitchCustomReward): CustomRewardFields {
  return {
    title: r.title,
    cost: r.cost,
    prompt: r.prompt,
    background_color: r.backgroundColor.toUpperCase(),
    is_enabled: r.isEnabled,
    is_user_input_required: r.isUserInputRequired,
    should_redemptions_skip_request_queue: r.skipRequestQueue,
    is_global_cooldown_enabled: r.globalCooldown.enabled,
    ...(r.globalCooldown.enabled
      ? { global_cooldown_seconds: r.globalCooldown.seconds }
      : {}),
    is_max_per_stream_enabled: r.maxPerStream.enabled,
    ...(r.maxPerStream.enabled ? { max_per_stream: r.maxPerStream.value } : {}),
    is_max_per_user_per_stream_enabled: r.maxPerUserPerStream.enabled,
    ...(r.maxPerUserPerStream.enabled
      ? { max_per_user_per_stream: r.maxPerUserPerStream.value }
      : {}),
  };
}

/** The fields of `want` that differ from `have` — the drift PATCH body. */
export function diffRewardFields(
  want: CustomRewardFields,
  have: CustomRewardFields,
): CustomRewardFields {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(want)) {
    if ((have as Record<string, unknown>)[k] !== v) out[k] = v;
  }
  return out as CustomRewardFields;
}

/** The persisted key → Twitch reward id map (channelpoints-rewards.json). It
 *  outlives catalogue edits: a key removed from the catalogue stays mapped, so
 *  its reward is kept disabled and its stragglers are still recognised. */
export interface ManagedRewards {
  byKey: Record<string, string>;
  syncedAt: number;
}

export function emptyManagedRewards(): ManagedRewards {
  return { byKey: {}, syncedAt: 0 };
}

/** Validate a persisted map; garbage yields an empty one. */
export function normalizeManagedRewards(raw: unknown): ManagedRewards {
  const out = emptyManagedRewards();
  if (!isObj(raw)) return out;
  if (isObj(raw.byKey)) {
    for (const [k, v] of Object.entries(raw.byKey)) {
      if (k && typeof v === "string" && v) out.byKey[k] = v;
    }
  }
  out.syncedAt = nonneg(raw.syncedAt, 0);
  return out;
}

/** reward id → catalogue key, for routing a redemption to its effect. */
export function rewardKeyById(
  byKey: Record<string, string>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, id] of Object.entries(byKey)) m.set(id, k);
  return m;
}

/** What a sync must do. `matched` is the new key → id map minus whatever
 *  `create` adds; `forget` lists retired keys whose reward is gone from Twitch. */
export interface RewardSyncPlan {
  create: RewardSpec[];
  update: { key: string; rewardId: string; fields: CustomRewardFields }[];
  disable: { key: string; rewardId: string }[];
  matched: Record<string, string>;
  forget: string[];
}

/**
 * Diff the desired catalogue against the rewards this Client ID manages on
 * Twitch. A catalogue entry is matched by its persisted reward id first, then by
 * an exact title (adopting a reward this app created but whose id was lost) —
 * never stealing one that is mapped to another catalogue key. Unmatched entries
 * are created; matched ones get a PATCH of just the drifted fields. A key that
 * left the catalogue but is still mapped is disabled, never deleted: a DELETE
 * marks its pending redemptions FULFILLED with no refund.
 */
export function planRewardSync(
  desired: readonly RewardSpec[],
  existing: readonly TwitchCustomReward[],
  byKey: Record<string, string>,
): RewardSyncPlan {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const desiredKeys = new Set(desired.map((s) => s.key));
  // Ids already persisted for a catalogue key are off-limits to another key's
  // title fallback.
  const reserved = new Map<string, string>();
  for (const s of desired) {
    const id = byKey[s.key];
    if (id && byId.has(id)) reserved.set(id, s.key);
  }
  const claimed = new Set<string>();
  const plan: RewardSyncPlan = {
    create: [],
    update: [],
    disable: [],
    matched: {},
    forget: [],
  };
  for (const s of desired) {
    let r: TwitchCustomReward | undefined;
    const persisted = byKey[s.key];
    if (persisted && byId.has(persisted) && !claimed.has(persisted)) {
      r = byId.get(persisted);
    } else {
      r = existing.find((x) =>
        x.title === s.title && !claimed.has(x.id) &&
        (reserved.get(x.id) ?? s.key) === s.key
      );
    }
    if (!r) {
      plan.create.push(s);
      continue;
    }
    claimed.add(r.id);
    plan.matched[s.key] = r.id;
    const fields = diffRewardFields(rewardFields(s), currentFields(r));
    if (Object.keys(fields).length > 0) {
      plan.update.push({ key: s.key, rewardId: r.id, fields });
    }
  }
  for (const [key, id] of Object.entries(byKey)) {
    if (desiredKeys.has(key)) continue;
    const r = byId.get(id);
    if (!r || claimed.has(id)) {
      plan.forget.push(key);
      continue;
    }
    claimed.add(id);
    plan.matched[key] = id;
    if (r.isEnabled) plan.disable.push({ key, rewardId: id });
  }
  return plan;
}

/** One catalogue row for `rewards status`. */
export interface RewardStatusRow {
  key: string;
  title: string;
  cost: number;
  effect: string;
  enabled: boolean;
  /** The Twitch reward id, or null when it hasn't been synced yet. */
  rewardId: string | null;
}

/** The catalogue joined with the managed map, plus the retired keys still
 *  mapped (kept disabled on Twitch). */
export function rewardStatusRows(
  rewards: readonly RewardSpec[],
  byKey: Record<string, string>,
): { rows: RewardStatusRow[]; retired: { key: string; rewardId: string }[] } {
  const keys = new Set(rewards.map((r) => r.key));
  return {
    rows: rewards.map((r) => ({
      key: r.key,
      title: r.title,
      cost: r.cost,
      effect: r.effect,
      enabled: r.enabled,
      rewardId: byKey[r.key] ?? null,
    })),
    retired: Object.entries(byKey)
      .filter(([k]) => !keys.has(k))
      .map(([key, rewardId]) => ({ key, rewardId })),
  };
}

/** Persisted operator control (channelpoints-control.json). A manual pause wins
 *  over auto-pause in both directions. */
export interface ChannelPointsControl {
  manualPause: boolean;
}

export function normalizeChannelPointsControl(
  raw: unknown,
): ChannelPointsControl {
  return { manualPause: isObj(raw) && raw.manualPause === true };
}

// ---- Redemption ledger (pure reducers) ------------------------------------

/** Resolved entries Twitch already knows about are kept this long for the
 *  `pending`/status views, then pruned. */
export const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on ledger size; the oldest finished entries go first. */
export const LEDGER_CAP = 2000;
/** How long past its deadline a queued effect may stay non-final before we give
 *  up on it (and refund) — the overlay's own expiry sweep gets 60s of that. */
export const QUEUE_GRACE_MS = 120_000;

/** A redemption as it enters the ledger, from EventSub, the reconcile pass, or
 *  a simulation. `key` is the catalogue key its reward id maps to. */
export interface RedemptionInput {
  id: string;
  rewardId: string;
  key: string;
  /** The reward title/cost Twitch reported at redemption time. */
  title: string;
  cost: number;
  viewer: string;
  login: string;
  /** Epoch ms of redeemed_at (0 = unknown → now). */
  redeemedAt: number;
  simulated: boolean;
}

/**
 * Admit a redemption, deduped by id (EventSub is at-least-once, and the reconcile
 * pass re-lists what EventSub already delivered). Its deadline is redeemedAt +
 * ttl. It lands `received` — or resolved CANCELED straight away when it can
 * never run: its reward left the catalogue (`retired`), was disabled
 * (`disabled`), or the deadline already passed (`stale`, e.g. found by reconcile
 * after an outage). A canceled entry still needs its refund PATCH, so it is left
 * un-synced.
 */
export function admitRedemption(
  ledger: readonly RedemptionEntry[],
  input: RedemptionInput,
  spec: RewardSpec | undefined,
  now: number,
  ttlSec: number,
): { ledger: RedemptionEntry[]; entry: RedemptionEntry; added: boolean } {
  const existing = ledger.find((e) => e.id === input.id);
  if (existing) {
    return { ledger: ledger.slice(), entry: existing, added: false };
  }
  // A clock-skewed redeemed_at in the future must not stretch the deadline.
  const redeemedAt = input.redeemedAt > 0
    ? Math.min(input.redeemedAt, now)
    : now;
  const entry: RedemptionEntry = {
    id: input.id,
    rewardId: input.rewardId,
    key: input.key,
    effect: spec?.effect ?? "",
    params: spec ? { ...spec.params } : {},
    title: input.title || spec?.title || input.key,
    cost: input.cost || spec?.cost || 0,
    viewer: input.viewer || input.login || "Someone",
    login: input.login,
    redeemedAt,
    receivedAt: now,
    expiresAt: redeemedAt + ttlSec * 1000,
    state: "received",
    twitchSynced: false,
    simulated: input.simulated,
    attempts: 0,
  };
  const cancel = (reason: string) => {
    entry.state = "resolved";
    entry.outcome = "canceled";
    entry.reason = reason;
    entry.resolvedAt = now;
  };
  if (!spec) cancel("retired");
  else if (!spec.enabled && !input.simulated) cancel("disabled");
  else if (now >= entry.expiresAt) cancel("stale");
  return { ledger: [...ledger, entry], entry, added: true };
}

function replaceEntry(
  ledger: readonly RedemptionEntry[],
  id: string,
  fn: (e: RedemptionEntry) => RedemptionEntry | null,
): {
  ledger: RedemptionEntry[];
  entry: RedemptionEntry | null;
  changed: boolean;
} {
  let found: RedemptionEntry | null = null;
  let changed = false;
  const out = ledger.map((e) => {
    if (e.id !== id) return e;
    const next = fn(e);
    if (!next) {
      found = e;
      return e;
    }
    found = next;
    changed = true;
    return next;
  });
  return { ledger: out, entry: found, changed };
}

/** received → queued: the overlay accepted it (202 new / 200 duplicate). */
export function markQueued(
  ledger: readonly RedemptionEntry[],
  id: string,
): { ledger: RedemptionEntry[]; changed: boolean } {
  const r = replaceEntry(
    ledger,
    id,
    (e) =>
      e.state === "received"
        ? { ...e, state: "queued", attempts: e.attempts + 1 }
        : null,
  );
  return { ledger: r.ledger, changed: r.changed };
}

/** A delivery to the overlay failed transiently (network / 5xx): count it and
 *  stay `received` for the next pump, until the deadline. */
export function markAttempt(
  ledger: readonly RedemptionEntry[],
  id: string,
): { ledger: RedemptionEntry[]; changed: boolean } {
  const r = replaceEntry(
    ledger,
    id,
    (e) => e.state === "received" ? { ...e, attempts: e.attempts + 1 } : null,
  );
  return { ledger: r.ledger, changed: r.changed };
}

/** queued → received: the overlay no longer knows the effect (it lost its
 *  queue), so deliver it again — safe, every hop dedupes on the id. */
export function requeueEntry(
  ledger: readonly RedemptionEntry[],
  id: string,
): { ledger: RedemptionEntry[]; changed: boolean } {
  const r = replaceEntry(
    ledger,
    id,
    (e) => e.state === "queued" ? { ...e, state: "received" } : null,
  );
  return { ledger: r.ledger, changed: r.changed };
}

/**
 * Resolve an open entry. A resolved entry is final and never changes again (the
 * first outcome wins — a late overlay result can't flip a manual refund).
 * `twitchSynced` is set only when Twitch already has the status (a fulfil/refund
 * done in the rewards queue); otherwise the sync loop PATCHes it.
 *
 * `withdraw` marks a resolution multichat decided on its own (a refund, the
 * rewards queue, a deadline) rather than one the overlay reported: when a POST
 * /effects was ever attempted for the entry (`attempts > 0` — it is `queued`, or
 * `received` after a POST that failed or timed out and may still have landed),
 * the overlay may hold the effect, so a withdrawal is owed (contract §5.2).
 */
export function resolveEntry(
  ledger: readonly RedemptionEntry[],
  id: string,
  outcome: RedemptionOutcome,
  reason: string,
  now: number,
  opts: { detail?: string; twitchSynced?: boolean; withdraw?: boolean } = {},
): {
  ledger: RedemptionEntry[];
  entry: RedemptionEntry | null;
  previous: RedemptionState | null;
  changed: boolean;
} {
  const before = ledger.find((e) => e.id === id);
  const r = replaceEntry(ledger, id, (e) => {
    if (e.state === "resolved") return null;
    let next: RedemptionEntry = {
      ...e,
      state: "resolved",
      outcome,
      reason: reason.slice(0, 64),
      resolvedAt: now,
      twitchSynced: opts.twitchSynced === true,
    };
    if (opts.detail) next.detail = opts.detail.slice(0, 160);
    if (opts.withdraw && e.attempts > 0) next = withCancelOwed(next, now);
    return next;
  });
  return { ...r, previous: before?.state ?? null };
}

// ---- Overlay withdrawals (durable cancel, contract §5.2) --------------------

/** Why multichat withdraws an effect, as POST /effects/<id>/cancel reports it
 *  to the overlay (contract §5.1): the memo card shows `fulfilled_externally`
 *  as "CLOSED — no action" and every other reason as "DENIED — REFUNDED". */
export type EffectCancelReason =
  | "refunded"
  | "fulfilled_externally"
  | "manual"
  | "timeout";

function withCancelOwed(e: RedemptionEntry, now: number): RedemptionEntry {
  return { ...e, cancelOwed: true, cancelAttempts: 0, nextCancelAt: now };
}

/**
 * Owe a withdrawal for an already-resolved entry — the one the resolution
 * itself couldn't know about: a POST /effects that was in flight when the entry
 * was refunded (or resolved in the rewards queue) and was accepted or went
 * unanswered, so the overlay may now hold an effect nobody paid for. A no-op
 * for an open entry or one already owed.
 */
export function oweCancel(
  ledger: readonly RedemptionEntry[],
  id: string,
  now: number,
): { ledger: RedemptionEntry[]; changed: boolean } {
  const r = replaceEntry(
    ledger,
    id,
    (e) =>
      e.state === "resolved" && !e.cancelOwed ? withCancelOwed(e, now) : null,
  );
  return { ledger: r.ledger, changed: r.changed };
}

/** The reason sent with an entry's withdrawal, from how it was resolved. */
export function overlayCancelReason(e: RedemptionEntry): EffectCancelReason {
  switch (e.reason) {
    case "external":
      // Completed or rejected in the Twitch rewards queue.
      return e.outcome === "fulfilled" ? "fulfilled_externally" : "refunded";
    case "manual":
      return "manual";
    case "timeout":
    case "overlay_unreachable":
      return "timeout"; // multichat's own deadline
    default:
      return "refunded";
  }
}

/** The overlay settled a withdrawal: 2xx (withdrawn, flagged for the mod to
 *  abandon, or already final) or 404 (it never held the effect / pruned it).
 *  Anything else — no answer, 5xx, an auth error — is retried. */
export function cancelAcknowledged(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404;
}

/** Back-off for a withdrawal the overlay didn't settle. No answer at all is
 *  retried on the very next pump: the overlay is most likely restarting, and
 *  it restores its queue on boot and hands it to the mod within seconds, so the
 *  withdrawal has to be there the moment it's back (an unreachable overlay
 *  refuses the connection instantly, and the pump stops at the first one). An
 *  HTTP error backs off. */
export function cancelBackoffMs(attempts: number, status: number): number {
  if (status === 0) return 0;
  const steps = [5_000, 15_000, 60_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1];
}

/** The overlay acknowledged the withdrawal: nothing is owed any more. */
export function markCancelDone(
  ledger: readonly RedemptionEntry[],
  id: string,
): { ledger: RedemptionEntry[]; changed: boolean } {
  const r = replaceEntry(ledger, id, (e) => {
    if (!e.cancelOwed) return null;
    const {
      cancelOwed: _o,
      cancelAttempts: _a,
      nextCancelAt: _n,
      ...rest
    } = e;
    return rest;
  });
  return { ledger: r.ledger, changed: r.changed };
}

/** A withdrawal went unacknowledged (`status` 0 = no answer): count it and
 *  back off before the next try. */
export function markCancelFailed(
  ledger: readonly RedemptionEntry[],
  id: string,
  now: number,
  status: number,
): { ledger: RedemptionEntry[]; changed: boolean } {
  const r = replaceEntry(ledger, id, (e) => {
    if (!e.cancelOwed) return null;
    const cancelAttempts = (e.cancelAttempts ?? 0) + 1;
    return {
      ...e,
      cancelAttempts,
      nextCancelAt: now + cancelBackoffMs(cancelAttempts, status),
    };
  });
  return { ledger: r.ledger, changed: r.changed };
}

/** The withdrawals due now, oldest resolution first. */
export function dueCancels(
  ledger: readonly RedemptionEntry[],
  now: number,
): RedemptionEntry[] {
  return ledger
    .filter((e) => e.cancelOwed && (e.nextCancelAt ?? 0) <= now)
    .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
}

/** Twitch has the final status for these ids (our PATCH landed, or 404'd
 *  because they were already resolved). */
export function markSynced(
  ledger: readonly RedemptionEntry[],
  ids: readonly string[],
): RedemptionEntry[] {
  const set = new Set(ids);
  return ledger.map((e) => {
    if (!set.has(e.id) || e.state !== "resolved" || e.twitchSynced) return e;
    const { nextSyncAt: _n, ...rest } = e;
    return { ...rest, twitchSynced: true };
  });
}

/** Back-off schedule for a failing redemption PATCH. */
export function syncBackoffMs(attempts: number): number {
  const steps = [5_000, 15_000, 60_000, 300_000, 900_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1];
}

/** A PATCH for these ids failed: count it and back off before the next try. */
export function markSyncFailed(
  ledger: readonly RedemptionEntry[],
  ids: readonly string[],
  now: number,
): RedemptionEntry[] {
  const set = new Set(ids);
  return ledger.map((e) => {
    if (!set.has(e.id) || e.state !== "resolved" || e.twitchSynced) return e;
    const syncAttempts = (e.syncAttempts ?? 0) + 1;
    return {
      ...e,
      syncAttempts,
      nextSyncAt: now + syncBackoffMs(syncAttempts),
    };
  });
}

/** Map a ledger outcome to the Helix redemption status. */
export function twitchStatusFor(
  outcome: RedemptionOutcome,
): "FULFILLED" | "CANCELED" {
  return outcome === "fulfilled" ? "FULFILLED" : "CANCELED";
}

/** One Update Redemption Status call: ≤50 ids of ONE reward, one status. */
export interface SyncBatch {
  rewardId: string;
  status: "FULFILLED" | "CANCELED";
  ids: string[];
}

/** The redemption ids an Update Redemption Status answer echoes back in `data`
 *  (the ones Twitch actually updated), or null when the body has no `data`
 *  list at all. */
export function parseUpdatedRedemptionIds(json: unknown): string[] | null {
  if (!isObj(json) || !Array.isArray(json.data)) return null;
  const out: string[] = [];
  for (const x of json.data) {
    if (isObj(x) && str(x.id)) out.push(str(x.id));
  }
  return out;
}

/** What an Update Redemption Status answer means for each id of its batch:
 *  `synced` — Twitch has the final status; `failed` — back off and retry the
 *  id; `split` — re-PATCH the id on its own now. */
export interface SyncBatchVerdict {
  synced: string[];
  failed: string[];
  split: string[];
}

/**
 * Judge one Update Redemption Status call for the `ids` it carried, so one id
 * that is no longer UNFULFILLED can't poison the rest of its batch:
 * - 2xx: only the ids Twitch echoed back in `data` are settled; the rest are
 *   re-PATCHed singly (and a single-id 2xx is settled outright);
 * - 404 or 400 on a multi-id batch: Twitch may refuse the whole call over one
 *   stale id (404 "not found or not UNFULFILLED", or a 400 at the first bad id),
 *   so every id is re-PATCHed singly;
 * - 404 on a single id: that redemption is no longer UNFULFILLED — terminal,
 *   counted as settled;
 * - anything else (no answer, 401/403, 429, 5xx, a single-id 400): back off.
 */
export function judgeSyncBatch(
  ids: readonly string[],
  res: HelixResult,
): SyncBatchVerdict {
  const all = [...ids];
  const verdict = (
    synced: string[],
    failed: string[],
    split: string[],
  ): SyncBatchVerdict => ({ synced, failed, split });
  if (res.ok) {
    if (all.length <= 1) return verdict(all, [], []);
    const echoed = parseUpdatedRedemptionIds(res.json);
    if (!echoed) return verdict([], [], all); // can't tell which landed
    const got = new Set(echoed);
    return verdict(
      all.filter((id) => got.has(id)),
      [],
      all.filter((id) => !got.has(id)),
    );
  }
  if (all.length > 1 && (res.status === 404 || res.status === 400)) {
    return verdict([], [], all);
  }
  if (res.kind === "not_found") return verdict(all, [], []);
  return verdict([], all, []);
}

/** The PATCHes due now: resolved, not yet on Twitch, not simulated, past any
 *  back-off — grouped per reward + status and chunked to Twitch's 50-id limit. */
export function dueSyncBatches(
  ledger: readonly RedemptionEntry[],
  now: number,
): SyncBatch[] {
  const groups = new Map<string, SyncBatch>();
  const order: string[] = [];
  for (const e of ledger) {
    if (e.state !== "resolved" || e.twitchSynced || e.simulated) continue;
    if (!e.rewardId || !e.outcome || (e.nextSyncAt ?? 0) > now) continue;
    const status = twitchStatusFor(e.outcome);
    const k = `${e.rewardId}\n${status}`;
    let g = groups.get(k);
    if (!g) {
      g = { rewardId: e.rewardId, status, ids: [] };
      groups.set(k, g);
      order.push(k);
    }
    g.ids.push(e.id);
  }
  const out: SyncBatch[] = [];
  for (const k of order) {
    const g = groups.get(k)!;
    for (let i = 0; i < g.ids.length; i += MAX_REDEMPTION_IDS) {
      out.push({ ...g, ids: g.ids.slice(i, i + MAX_REDEMPTION_IDS) });
    }
  }
  return out;
}

/** True when a queued effect has been given every chance: past its deadline
 *  plus QUEUE_GRACE_MS without a final result. */
export function queuedTimedOut(e: RedemptionEntry, now: number): boolean {
  return e.state === "queued" && now > e.expiresAt + QUEUE_GRACE_MS;
}

/** Done with, as far as anyone is concerned: resolved, Twitch told (or
 *  simulated, which never touches Twitch), and no overlay withdrawal owed. */
function finished(e: RedemptionEntry): boolean {
  return e.state === "resolved" && (e.twitchSynced || e.simulated) &&
    !e.cancelOwed;
}

/** Entries still in flight: not yet resolved, resolved but Twitch not yet
 *  told (the viewer's points are still held), or still being withdrawn from
 *  the overlay. */
export function openEntries(
  ledger: readonly RedemptionEntry[],
): RedemptionEntry[] {
  return ledger.filter((e) => !finished(e));
}

export interface LedgerCounts {
  received: number;
  queued: number;
  /** Resolved but Twitch not yet told. */
  unsynced: number;
  /** Resolved, but the overlay hasn't confirmed the effect's withdrawal. */
  withdrawing: number;
  resolved: number;
}

export function ledgerCounts(ledger: readonly RedemptionEntry[]): LedgerCounts {
  const c: LedgerCounts = {
    received: 0,
    queued: 0,
    unsynced: 0,
    withdrawing: 0,
    resolved: 0,
  };
  for (const e of ledger) {
    if (e.state === "received") c.received++;
    else if (e.state === "queued") c.queued++;
    else {
      c.resolved++;
      if (!e.twitchSynced && !e.simulated) c.unsynced++;
      if (e.cancelOwed) c.withdrawing++;
    }
  }
  return c;
}

/** Drop finished entries older than LEDGER_RETENTION_MS, then — if still over
 *  LEDGER_CAP — the oldest finished ones. An open entry is never pruned: it is
 *  the only record of points still held, or of an effect the overlay may still
 *  run. */
export function pruneLedger(
  ledger: readonly RedemptionEntry[],
  now: number,
): RedemptionEntry[] {
  const age = (e: RedemptionEntry) => e.resolvedAt ?? e.receivedAt;
  let out = ledger.filter((e) =>
    !(finished(e) && age(e) < now - LEDGER_RETENTION_MS)
  );
  if (out.length > LEDGER_CAP) {
    const drop = new Set(
      out.filter(finished)
        .sort((a, b) => age(a) - age(b))
        .slice(0, out.length - LEDGER_CAP)
        .map((e) => e.id),
    );
    out = out.filter((e) => !drop.has(e.id));
  }
  return out;
}

const STATES: readonly string[] = ["received", "queued", "resolved"];

function normalizeParams(raw: unknown): RewardParams {
  const out: RewardParams = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (
      typeof v === "string" || typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    ) {
      out[k] = v;
    }
  }
  return out;
}

/** Validate a persisted ledger read back from the state dir. Non-fatal: bad
 *  entries are dropped, garbage yields an empty ledger. */
export function normalizeLedger(raw: unknown): RedemptionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RedemptionEntry[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (!isObj(x)) continue;
    const id = str(x.id);
    const state = str(x.state);
    if (!id || seen.has(id) || !STATES.includes(state)) continue;
    const e: RedemptionEntry = {
      id,
      rewardId: str(x.rewardId),
      key: str(x.key),
      effect: str(x.effect),
      params: normalizeParams(x.params),
      title: str(x.title),
      cost: nonneg(x.cost, 0),
      viewer: str(x.viewer),
      login: str(x.login),
      redeemedAt: nonneg(x.redeemedAt, 0),
      receivedAt: nonneg(x.receivedAt, 0),
      expiresAt: nonneg(x.expiresAt, 0),
      state: state as RedemptionState,
      twitchSynced: x.twitchSynced === true,
      simulated: x.simulated === true,
      attempts: nonneg(x.attempts, 0),
    };
    if (x.outcome === "fulfilled" || x.outcome === "canceled") {
      e.outcome = x.outcome;
    }
    // A resolved entry without an outcome can't be synced — refund it.
    if (e.state === "resolved" && !e.outcome) e.outcome = "canceled";
    if (str(x.reason)) e.reason = str(x.reason);
    if (nonneg(x.resolvedAt, 0)) e.resolvedAt = nonneg(x.resolvedAt, 0);
    if (str(x.detail)) e.detail = str(x.detail);
    if (nonneg(x.syncAttempts, 0)) e.syncAttempts = nonneg(x.syncAttempts, 0);
    if (nonneg(x.nextSyncAt, 0)) e.nextSyncAt = nonneg(x.nextSyncAt, 0);
    // Only a resolved entry can owe a withdrawal.
    if (x.cancelOwed === true && e.state === "resolved") {
      e.cancelOwed = true;
      e.cancelAttempts = nonneg(x.cancelAttempts, 0);
      e.nextCancelAt = nonneg(x.nextCancelAt, 0);
    }
    seen.add(id);
    out.push(e);
  }
  return out;
}

export function serializeLedger(ledger: readonly RedemptionEntry[]): string {
  return JSON.stringify(ledger);
}

/** Build the ledger input for `multichat rewards simulate`: a synthetic
 *  `sim-<uuid>` redemption of `spec` that runs the whole overlay → mod pipeline
 *  but never PATCHes Twitch. `uuid` is injected so this stays pure. */
export function simulatedRedemption(
  spec: RewardSpec,
  rewardId: string,
  viewer: string,
  uuid: string,
  now: number,
): RedemptionInput {
  return {
    id: `${SIMULATED_ID_PREFIX}${uuid}`,
    rewardId,
    key: spec.key,
    title: spec.title,
    cost: spec.cost,
    viewer: viewer || DEFAULT_SIMULATED_VIEWER,
    login: "",
    redeemedAt: now,
    simulated: true,
  };
}

// ---- cobblemon-overlay effect API (loopback wire) --------------------------

/** One request to the overlay's effect API (the caller performs the fetch). */
export interface OverlayRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** The overlay answers `GET /effects?ids=` for at most this many ids. */
export const MAX_LOOKUP_IDS = 50;

function overlayHeaders(
  cfg: ChannelPointsConfig,
  json: boolean,
): Record<string, string> {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(cfg.overlayToken
      ? { authorization: `Bearer ${cfg.overlayToken}` }
      : {}),
  };
}

/** POST /effects — hand the overlay one effect. `ttlSec` is the time left until
 *  the entry's own deadline, so a re-delivery never extends it. */
export function buildEffectEnqueueRequest(
  cfg: ChannelPointsConfig,
  e: RedemptionEntry,
  now: number,
): OverlayRequest {
  return {
    url: `${cfg.overlayUrl}/effects`,
    method: "POST",
    headers: overlayHeaders(cfg, true),
    body: JSON.stringify({
      id: e.id,
      effect: e.effect,
      params: e.params,
      viewer: e.viewer,
      ...(e.login ? { viewerLogin: e.login } : {}),
      reward: e.title,
      cost: e.cost,
      simulated: e.simulated,
      ttlSec: Math.max(1, Math.ceil((e.expiresAt - now) / 1000)),
    }),
  };
}

/** GET /effects?ids=a,b,… — the current status of up to 50 effects. */
export function buildEffectsLookupRequest(
  cfg: ChannelPointsConfig,
  ids: readonly string[],
): OverlayRequest {
  if (ids.length === 0 || ids.length > MAX_LOOKUP_IDS) {
    throw new RangeError(
      `GET /effects takes 1..${MAX_LOOKUP_IDS} ids, got ${ids.length}`,
    );
  }
  // Literal commas between individually-encoded ids, so the list reads the
  // same whether the overlay splits the raw query or uses searchParams.
  return {
    url: `${cfg.overlayUrl}/effects?ids=${
      ids.map(encodeURIComponent).join(",")
    }`,
    method: "GET",
    headers: overlayHeaders(cfg, false),
  };
}

/** POST /effects/<id>/cancel — withdraw an effect (pending ones are dropped;
 *  one the mod already holds is flagged for it to abandon), saying why so the
 *  on-stream memo can tell a refund from a close-out (contract §5.1). */
export function buildEffectCancelRequest(
  cfg: ChannelPointsConfig,
  id: string,
  reason: EffectCancelReason,
): OverlayRequest {
  return {
    url: `${cfg.overlayUrl}/effects/${encodeURIComponent(id)}/cancel`,
    method: "POST",
    headers: overlayHeaders(cfg, true),
    body: JSON.stringify({ reason }),
  };
}

/** GET /effects/health — is the game polling for effects right now? */
export function buildEffectsHealthRequest(
  cfg: ChannelPointsConfig,
): OverlayRequest {
  return {
    url: `${cfg.overlayUrl}/effects/health`,
    method: "GET",
    headers: overlayHeaders(cfg, false),
  };
}

/** What to do after a POST /effects: `queued` (the overlay holds it), `refused`
 *  (it never will — refund now with its reason), or `retry` (transient; try the
 *  next pump until the deadline). */
export type EnqueueOutcome =
  | { kind: "queued"; status: string }
  | { kind: "refused"; reason: string }
  | { kind: "retry"; reason: string };

/**
 * Judge a POST /effects response (status 0 = no answer at all). 202 new and 200
 * duplicate both mean queued. Every 4xx and 503 is a refusal — disabled,
 * game_offline, queue_full, bad_request, forbidden, or an overlay too old to have
 * the route — so the viewer is refunded at once rather than after the deadline.
 * Other 5xx and network failures are retried.
 */
export function interpretEnqueueResponse(
  status: number,
  json: unknown,
): EnqueueOutcome {
  const o = isObj(json) ? json : {};
  const reason = str(o.reason) ||
    (status ? `http_${status}` : "overlay_unreachable");
  if (status >= 200 && status < 300) {
    return o.ok === true
      ? { kind: "queued", status: str(o.status) || "pending" }
      : { kind: "retry", reason: "bad_response" };
  }
  if ((status >= 400 && status < 500) || status === 503) {
    return { kind: "refused", reason };
  }
  return { kind: "retry", reason };
}

/** One effect's status as the overlay reports it. */
export interface OverlayEffectStatus {
  id: string;
  status: string;
  reason?: string;
  detail?: string;
}

/** Parse a GET /effects response into id → status (unknown ids are simply
 *  absent; a malformed body is an empty map). */
export function parseEffectsLookup(
  json: unknown,
): Map<string, OverlayEffectStatus> {
  const out = new Map<string, OverlayEffectStatus>();
  if (!isObj(json) || !Array.isArray(json.effects)) return out;
  for (const x of json.effects) {
    if (!isObj(x) || !str(x.id) || !str(x.status)) continue;
    const s: OverlayEffectStatus = { id: str(x.id), status: str(x.status) };
    if (str(x.reason)) s.reason = str(x.reason);
    if (str(x.detail)) s.detail = str(x.detail);
    out.set(s.id, s);
  }
  return out;
}

/** An overlay effect status → the Twitch outcome: applied/armed FULFILL,
 *  rejected/expired/canceled REFUND; null while it is still in flight
 *  (pending/leased/accepted) or unrecognised. */
export function effectOutcome(status: string): RedemptionOutcome | null {
  switch (status) {
    case "applied":
    case "armed":
      return "fulfilled";
    case "rejected":
    case "expired":
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

/** GET /effects/health, trimmed to what auto-pause needs. `accepting` = the
 *  mod is polling; `ready` = on its last poll the mod said it can run effects
 *  now (not ESC-paused, not `/chaos pause`d, the target online and alive). */
export interface OverlayHealth {
  enabled: boolean;
  accepting: boolean;
  ready: boolean;
  lastPollAgoMs: number | null;
}

/** Parse a health body, or null when it isn't one (treated as not accepting).
 *  A missing `ready` reads as not ready — fail closed. */
export function parseEffectsHealth(json: unknown): OverlayHealth | null {
  if (!isObj(json) || json.ok !== true || typeof json.accepting !== "boolean") {
    return null;
  }
  const ago = json.lastPollAgoMs;
  return {
    enabled: json.enabled !== false,
    accepting: json.accepting,
    ready: json.ready === true,
    lastPollAgoMs: typeof ago === "number" && Number.isFinite(ago) ? ago : null,
  };
}

/** A health answer the rewards may stay live on: the overlay answered, the mod
 *  is polling, and it is ready to run effects. */
export function healthGood(h: OverlayHealth | null): boolean {
  return h !== null && h.enabled && h.accepting && h.ready;
}

/** Consecutive bad health checks before auto-pause pauses the rewards (≈30s
 *  at the 15s cadence), so a single missed poll or tick hiccup can't flap them. */
export const AUTO_PAUSE_BAD_CHECKS = 2;

/** Auto-pause's hysteresis state: the run of consecutive bad checks and what
 *  it currently wants. */
export interface AutoPauseGate {
  bad: number;
  paused: boolean;
}

/** Before any check auto-pause wants the rewards paused (fail closed): the
 *  first good check releases them. */
export function initialAutoPauseGate(): AutoPauseGate {
  return { bad: 0, paused: true };
}

/** Feed one health check through the hysteresis: a good check resumes at once;
 *  a bad one pauses only once AUTO_PAUSE_BAD_CHECKS have come in a row. */
export function stepAutoPause(
  gate: AutoPauseGate,
  good: boolean,
): AutoPauseGate {
  if (good) return { bad: 0, paused: false };
  const bad = gate.bad + 1;
  return { bad, paused: gate.paused || bad >= AUTO_PAUSE_BAD_CHECKS };
}

// ---- Chat row ---------------------------------------------------------------

/** The optional `announce` row: a highlighted system line in the chat views
 *  ("X redeemed Budget Cuts"). System rows never pop on /alerts. */
export function redemptionChatMessage(
  e: RedemptionEntry,
  channel: string,
  color: string,
): ChatMessage {
  return {
    id: `cp-${e.id}`,
    platform: "twitch",
    channel,
    author: e.viewer,
    content: "",
    kind: "system",
    accentColor: color,
    amount: `${e.cost} points`,
    eventText: `${e.viewer} redeemed ${e.title}` +
      (e.simulated ? " (simulated)" : ""),
    timestamp: e.receivedAt,
  };
}

// ---- Control-wire format (loopback POST /api/rewards) ----------------------

/** One operator action against the channel-points engine, in wire form. */
export type RewardsAction =
  | { action: "status" }
  | { action: "sync" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "pending" }
  | { action: "refund"; id: string }
  | { action: "simulate"; key: string; user?: string };

export type RewardsParseResult =
  | { ok: true; action: RewardsAction }
  | { ok: false; message: string };

/** Serialize an action to the JSON body `/api/rewards` expects. */
export function serializeRewardsAction(action: RewardsAction): string {
  return JSON.stringify(action);
}

const SIMPLE_REWARDS_ACTIONS: readonly string[] = [
  "status",
  "sync",
  "pause",
  "resume",
  "pending",
];

/** A viewer name for a simulation: control characters stripped, trimmed, and
 *  capped at Twitch's 25-character display-name length. */
export function cleanViewerName(raw: unknown): string {
  // deno-lint-ignore no-control-regex
  return str(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 25);
}

/**
 * Parse and validate a JSON `/api/rewards` body. The server-side trust boundary:
 * loopback is trusted, but a hand-crafted request still shouldn't push a
 * malformed action through.
 */
export function parseRewardsAction(raw: string): RewardsParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, message: "body is not valid JSON" };
  }
  if (!isObj(body)) return { ok: false, message: "body must be a JSON object" };
  const action = body.action;
  if (action === "refund") {
    const id = str(body.id).trim();
    if (!id || id.length > 100) {
      return { ok: false, message: "refund requires a redemption id" };
    }
    return { ok: true, action: { action: "refund", id } };
  }
  if (action === "simulate") {
    const key = str(body.key).trim().toLowerCase();
    if (!key) {
      return { ok: false, message: "simulate requires a reward key" };
    }
    const user = cleanViewerName(body.user);
    return {
      ok: true,
      action: user
        ? { action: "simulate", key, user }
        : { action: "simulate", key },
    };
  }
  if (typeof action === "string" && SIMPLE_REWARDS_ACTIONS.includes(action)) {
    return { ok: true, action: { action } as RewardsAction };
  }
  return {
    ok: false,
    message: `unknown action "${String(action)}" (use ${
      SIMPLE_REWARDS_ACTIONS.join(", ")
    }, refund or simulate)`,
  };
}

// ---- Engine read models (returned over /api/rewards) -------------------------

/** `rewards status`: the catalogue ↔ reward ids, pause state, overlay health
 *  and ledger counts. */
export interface ChannelPointsStatus {
  channel: string;
  overlayUrl: string;
  /** The channel's broadcaster token is resolved (EventSub up). */
  authReady: boolean;
  /** The token carries channel:manage:redemptions (null = unknown). */
  scopeOk: boolean | null;
  /** Last overlay health answer (null = not checked yet). */
  accepting: boolean | null;
  /** Whether the mod said it was ready on its last poll (null = not checked). */
  ready: boolean | null;
  lastHealthAt: number | null;
  autoPause: boolean;
  manualPause: boolean;
  /** What multichat last applied on Twitch (null = not yet). */
  twitchPaused: boolean | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  rewards: RewardStatusRow[];
  retired: { key: string; rewardId: string }[];
  counts: LedgerCounts;
}

/** The result of a reward sync (keys per action taken). */
export interface RewardSyncReport {
  ok: boolean;
  message: string;
  created: string[];
  updated: string[];
  disabled: string[];
  unchanged: number;
  errors: string[];
}

/** The result of a refund / simulate. */
export interface RewardsResult {
  ok: boolean;
  message: string;
  entry?: RedemptionEntry;
}

/** The result of pause / resume. */
export interface RewardsPauseResult {
  ok: boolean;
  message: string;
  status: ChannelPointsStatus;
}

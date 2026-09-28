import {
  admitRedemption,
  applyChannelPointsEnv,
  AUTO_PAUSE_BAD_CHECKS,
  buildEffectCancelRequest,
  buildEffectEnqueueRequest,
  buildEffectsHealthRequest,
  buildEffectsLookupRequest,
  cancelAcknowledged,
  cancelBackoffMs,
  channelPointsScopeWarning,
  channelPointsSetupProblems,
  cleanViewerName,
  DEFAULT_CATALOG,
  DEFAULT_OVERLAY_URL,
  DEFAULT_SIMULATED_VIEWER,
  DEFAULT_TTL_SEC,
  diffRewardFields,
  dueCancels,
  dueSyncBatches,
  effectOutcome,
  healthGood,
  initialAutoPauseGate,
  interpretEnqueueResponse,
  judgeSyncBatch,
  KNOWN_EFFECTS,
  LEDGER_CAP,
  LEDGER_RETENTION_MS,
  ledgerCounts,
  markAttempt,
  markCancelDone,
  markCancelFailed,
  markQueued,
  markSynced,
  markSyncFailed,
  normalizeChannelPointsConfig,
  normalizeChannelPointsControl,
  normalizeLedger,
  normalizeManagedRewards,
  normalizeRewardSpec,
  openEntries,
  overlayCancelReason,
  oweCancel,
  parseEffectsHealth,
  parseEffectsLookup,
  parseRewardsAction,
  parseUpdatedRedemptionIds,
  planRewardSync,
  pruneLedger,
  QUEUE_GRACE_MS,
  queuedTimedOut,
  redemptionChatMessage,
  type RedemptionInput,
  requeueEntry,
  resolveEntry,
  rewardFields,
  rewardKeyById,
  type RewardsAction,
  rewardStatusRows,
  serializeLedger,
  serializeRewardsAction,
  simulatedRedemption,
  stepAutoPause,
  syncBackoffMs,
  TIER_COLORS,
  twitchStatusFor,
} from "../src/channelpoints.ts";
import {
  parseHelixResponse,
  type TwitchCustomReward,
} from "../src/twitchauth.ts";
import type {
  ChannelPointsConfig,
  RedemptionEntry,
  RewardSpec,
} from "../src/types.ts";
import { assert, assertEquals, assertThrows } from "./_assert.ts";

const T0 = Date.parse("2026-09-25T20:00:00Z");

const spec = (over: Partial<RewardSpec> = {}): RewardSpec => ({
  key: "budget_cuts",
  title: "Budget Cuts",
  cost: 750,
  prompt: "Walk slower.",
  effect: "potion",
  params: { effect: "slowness", amplifier: 1, seconds: 45 },
  cooldownSec: 180,
  maxPerStream: 0,
  maxPerUserPerStream: 0,
  color: "#E0A526",
  enabled: true,
  ...over,
});

const input = (over: Partial<RedemptionInput> = {}): RedemptionInput => ({
  id: "red-1",
  rewardId: "rw-1",
  key: "budget_cuts",
  title: "Budget Cuts",
  cost: 750,
  viewer: "Ann",
  login: "ann",
  redeemedAt: T0,
  simulated: false,
  ...over,
});

const cfg = (over: Partial<ChannelPointsConfig> = {}): ChannelPointsConfig => ({
  enabled: true,
  channel: "thecompanyinc",
  overlayUrl: "http://127.0.0.1:8082",
  overlayToken: "",
  ttlSec: 600,
  autoPause: true,
  announce: true,
  rewards: [spec()],
  ...over,
});

/** A reward as Twitch would hold it after a clean create of `s`. */
const onTwitch = (
  s: RewardSpec,
  id: string,
  over: Partial<TwitchCustomReward> = {},
): TwitchCustomReward => ({
  id,
  title: s.title,
  prompt: s.prompt,
  cost: s.cost,
  backgroundColor: s.color,
  isEnabled: s.enabled,
  isPaused: false,
  isUserInputRequired: false,
  skipRequestQueue: false,
  maxPerStream: { enabled: s.maxPerStream > 0, value: s.maxPerStream },
  maxPerUserPerStream: {
    enabled: s.maxPerUserPerStream > 0,
    value: s.maxPerUserPerStream,
  },
  globalCooldown: { enabled: true, seconds: s.cooldownSec },
  ...over,
});

/** Admit one redemption into an empty ledger. */
const admitted = (
  over: Partial<RedemptionInput> = {},
  now = T0,
): RedemptionEntry[] =>
  admitRedemption([], input(over), spec(), now, DEFAULT_TTL_SEC).ledger;

// ---- DEFAULT_CATALOG --------------------------------------------------------

Deno.test("DEFAULT_CATALOG: exactly the contracted rewards, effects and limits", () => {
  const rows = DEFAULT_CATALOG.map((r) => [
    r.key,
    r.title,
    r.effect,
    r.params,
    r.cost,
    r.cooldownSec,
    r.maxPerStream,
  ]);
  assertEquals(rows, [
    ["butterfingers", "Butterfingers", "drop_held_item", {}, 250, 60, 0],
    ["hop_to_it", "Hop To It", "force_jump", {}, 150, 60, 0],
    ["about_face", "About Face", "about_face", {}, 150, 60, 0],
    ["hotbar_reorg", "Hotbar Reorg", "hotbar_shuffle", {}, 400, 120, 0],
    [
      "budget_cuts",
      "Budget Cuts",
      "potion",
      {
        effect: "slowness",
        amplifier: 1,
        seconds: 45,
      },
      750,
      180,
      0,
    ],
    [
      "mandatory_overtime",
      "Mandatory Overtime",
      "potion",
      {
        effect: "mining_fatigue",
        amplifier: 1,
        seconds: 90,
      },
      750,
      180,
      0,
    ],
    [
      "performance_review",
      "Performance Review",
      "potion",
      {
        effect: "weakness",
        amplifier: 1,
        seconds: 60,
      },
      750,
      180,
      0,
    ],
    [
      "team_building_cruise",
      "Team-Building Cruise",
      "potion",
      {
        effect: "nausea",
        amplifier: 0,
        seconds: 15,
      },
      750,
      180,
      0,
    ],
    [
      "lights_out",
      "Lights Out",
      "potion",
      {
        effect: "darkness",
        amplifier: 0,
        seconds: 20,
      },
      1000,
      180,
      0,
    ],
    [
      "hiring_freeze",
      "Hiring Freeze",
      "sprint_lock",
      { seconds: 60 },
      1000,
      300,
      0,
    ],
    [
      "uninvited_contractor",
      "Uninvited Contractor",
      "spawn_mob",
      {},
      2500,
      300,
      0,
    ],
    [
      "workplace_incident",
      "Workplace Incident",
      "pokemon_status",
      {},
      5000,
      600,
      5,
    ],
    [
      "magikarp_mandate",
      "Magikarp Mandate",
      "magikarp_mandate",
      {},
      15000,
      3600,
      1,
    ],
    [
      "mandatory_meeting",
      "Mandatory Meeting",
      "forfeit_turns",
      { turns: 3 },
      25000,
      3600,
      1,
    ],
  ]);
});

Deno.test("DEFAULT_CATALOG: every entry clears Twitch's limits and our invariants", () => {
  const keys = new Set<string>();
  const titles = new Set<string>();
  for (const r of DEFAULT_CATALOG) {
    assert(r.title.length > 0 && r.title.length <= 45, `${r.key}: title`);
    assert(r.prompt.length > 0 && r.prompt.length <= 200, `${r.key}: prompt`);
    assert(r.cooldownSec >= 60, `${r.key}: cooldown`);
    assert(r.cost >= 1, `${r.key}: cost`);
    assert(KNOWN_EFFECTS.includes(r.effect), `${r.key}: effect`);
    assert(/^#[0-9A-F]{6}$/.test(r.color), `${r.key}: color`);
    assertEquals(r.maxPerUserPerStream, 0);
    assert(r.enabled);
    assert(!keys.has(r.key), `duplicate key ${r.key}`);
    assert(!titles.has(r.title.toLowerCase()), `duplicate title ${r.title}`);
    keys.add(r.key);
    titles.add(r.title.toLowerCase());
    // A catalogue entry is itself a valid settings.json reward.
    const round = normalizeRewardSpec(r);
    assert(round.ok);
    if (round.ok) {
      assertEquals(round.spec, r);
      assertEquals(round.notes, []);
    }
  }
});

Deno.test("DEFAULT_CATALOG: tile colors follow the tiers", () => {
  const color = (k: string) => DEFAULT_CATALOG.find((r) => r.key === k)!.color;
  for (
    const k of ["butterfingers", "hop_to_it", "about_face", "hotbar_reorg"]
  ) {
    assertEquals(color(k), TIER_COLORS[1]);
  }
  for (
    const k of [
      "budget_cuts",
      "mandatory_overtime",
      "performance_review",
      "team_building_cruise",
      "lights_out",
      "hiring_freeze",
    ]
  ) assertEquals(color(k), TIER_COLORS[2]);
  assertEquals(color("uninvited_contractor"), TIER_COLORS[3]);
  assertEquals(color("workplace_incident"), TIER_COLORS[3]);
  assertEquals(color("magikarp_mandate"), "#7A1F1F");
  assertEquals(color("mandatory_meeting"), "#7A1F1F");
  assertEquals(
    [TIER_COLORS[1], TIER_COLORS[2], TIER_COLORS[3], TIER_COLORS[4]],
    ["#9AA5B1", "#E0A526", "#D9534F", "#7A1F1F"],
  );
});

// ---- config normalization -----------------------------------------------------

Deno.test("normalizeChannelPointsConfig: garbage → disabled, default catalogue", () => {
  for (const raw of [undefined, null, "yes", 42, []]) {
    const c = normalizeChannelPointsConfig(raw);
    assertEquals(c.enabled, false);
    assertEquals(c.channel, "");
    assertEquals(c.overlayUrl, DEFAULT_OVERLAY_URL);
    assertEquals(c.overlayToken, "");
    assertEquals(c.ttlSec, DEFAULT_TTL_SEC);
    assertEquals(c.autoPause, true);
    assertEquals(c.announce, true);
    assertEquals(c.rewards, DEFAULT_CATALOG);
  }
});

Deno.test("normalizeChannelPointsConfig: normalizes every field", () => {
  const issues: string[] = [];
  const c = normalizeChannelPointsConfig({
    enabled: true,
    channel: "  TheCompanyInc ",
    overlayUrl: "http://127.0.0.1:8082///",
    overlayToken: " tok ",
    ttlSec: 300,
    autoPause: false,
    announce: false,
    rewards: [spec({ key: "Budget_Cuts" })],
  }, (m) => issues.push(m));
  assertEquals(c.enabled, true);
  assertEquals(c.channel, "thecompanyinc");
  assertEquals(c.overlayUrl, "http://127.0.0.1:8082");
  assertEquals(c.overlayToken, "tok");
  assertEquals(c.ttlSec, 300);
  assertEquals(c.autoPause, false);
  assertEquals(c.announce, false);
  assertEquals(c.rewards, [spec()]); // key lowercased
  assertEquals(issues, []);
  // Only an explicit true enables it.
  assertEquals(
    normalizeChannelPointsConfig({ enabled: "true" }).enabled,
    false,
  );
});

Deno.test("normalizeChannelPointsConfig: a bad url / ttl is fixed and reported", () => {
  const issues: string[] = [];
  const c = normalizeChannelPointsConfig(
    { overlayUrl: "127.0.0.1:8082", ttlSec: 99999 },
    (m) => issues.push(m),
  );
  assertEquals(c.overlayUrl, DEFAULT_OVERLAY_URL);
  assertEquals(c.ttlSec, 3600);
  assertEquals(issues.length, 2);
  assertEquals(normalizeChannelPointsConfig({ ttlSec: 5 }).ttlSec, 30);
  assertEquals(normalizeChannelPointsConfig({ ttlSec: "junk" }).ttlSec, 600);
  assertEquals(
    normalizeChannelPointsConfig({ overlayUrl: "https://overlay.lan/" })
      .overlayUrl,
    "https://overlay.lan",
  );
});

Deno.test("normalizeChannelPointsConfig: rewards null = defaults (a copy), list replaces", () => {
  const c = normalizeChannelPointsConfig({ rewards: null });
  assertEquals(c.rewards, DEFAULT_CATALOG);
  // A copy: mutating the config can't poison the shared catalogue.
  c.rewards[0].params.x = 1;
  c.rewards[0].title = "changed";
  assertEquals(DEFAULT_CATALOG[0].title, "Butterfingers");
  assertEquals(DEFAULT_CATALOG[0].params, {});

  assertEquals(normalizeChannelPointsConfig({ rewards: [] }).rewards, []);

  const issues: string[] = [];
  assertEquals(
    normalizeChannelPointsConfig({ rewards: "all" }, (m) => issues.push(m))
      .rewards,
    [],
  );
  assertEquals(issues.length, 1);
});

Deno.test("normalizeChannelPointsConfig: bad and duplicate rewards are dropped, loudly", () => {
  const issues: string[] = [];
  const c = normalizeChannelPointsConfig({
    rewards: [
      spec(),
      spec({ title: "Other" }), // duplicate key
      spec({ key: "b2", title: "budget cuts" }), // duplicate title (any case)
      { key: "x", title: "X", effect: "potion" }, // no cost
      spec({ key: "ok2", title: "Fine", cooldownSec: 10 }), // kept, raised
    ],
  }, (m) => issues.push(m));
  assertEquals(c.rewards.map((r) => r.key), ["budget_cuts", "ok2"]);
  assertEquals(c.rewards[1].cooldownSec, 60);
  assertEquals(issues.length, 4);
  assert(issues.some((m) => m.includes("duplicate key")));
  assert(issues.some((m) => m.includes("duplicate title")));
  assert(issues.some((m) => m.includes("cost")));
  assert(issues.some((m) => m.includes("cooldownSec raised")));
});

Deno.test("normalizeChannelPointsConfig: more than 50 rewards are cut to Twitch's cap", () => {
  const issues: string[] = [];
  const many = Array.from(
    { length: 55 },
    (_, i) => spec({ key: `r${i}`, title: `Reward ${i}` }),
  );
  const c = normalizeChannelPointsConfig(
    { rewards: many },
    (m) => issues.push(m),
  );
  assertEquals(c.rewards.length, 50);
  assertEquals(issues.length, 1);
});

Deno.test("normalizeRewardSpec: rejects what Twitch or the game would refuse", () => {
  const bad = (over: Record<string, unknown>) => {
    const r = normalizeRewardSpec({ ...spec(), ...over });
    return r.ok ? "" : r.message;
  };
  assert(bad({ key: "" }).includes("key"));
  assert(bad({ key: "has space" }).includes("key"));
  assert(bad({ key: "-leading" }).includes("key"));
  assert(bad({ title: "   " }).includes("title"));
  assert(bad({ title: "x".repeat(46) }).includes("45"));
  assertEquals(bad({ title: "x".repeat(45) }), "");
  assert(bad({ cost: 0 }).includes("cost"));
  assert(bad({ cost: "abc" }).includes("cost"));
  assert(bad({ prompt: "p".repeat(201) }).includes("200"));
  assertEquals(bad({ prompt: "p".repeat(200) }), "");
  assert(bad({ effect: "" }).includes("effect"));
  assert(bad({ effect: "drop held" }).includes("effect"));
  assert(bad({ effect: "9lives" }).includes("effect")); // the overlay's shape
  assert(bad({ effect: "x".repeat(65) }).includes("effect"));
  assert(bad({ params: [1, 2] }).includes("params"));
  assert(bad({ params: "slowness" }).includes("params"));
  assertEquals(normalizeRewardSpec("nope").ok, false);
});

Deno.test("normalizeRewardSpec: fixes what it safely can, with notes", () => {
  const r = normalizeRewardSpec({
    key: " Lights_Out ",
    title: " Lights Out ",
    cost: 1000.9,
    effect: " POTION ",
    params: { effect: "darkness", nested: { no: 1 }, amp: 0, on: true },
    color: "#e0a526",
    maxPerStream: -3,
    maxPerUserPerStream: "2",
  });
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.spec, {
    key: "lights_out",
    title: "Lights Out",
    cost: 1000,
    prompt: "",
    effect: "potion",
    params: { effect: "darkness", amp: 0, on: true },
    cooldownSec: 60, // missing → the floor: none may be redeemable offline
    maxPerStream: 0,
    maxPerUserPerStream: 2,
    color: "#E0A526",
    enabled: true,
  });
  assertEquals(r.notes.length, 2); // dropped param + raised cooldown

  const capped = normalizeRewardSpec({ ...spec(), cooldownSec: 10_000_000 });
  assert(capped.ok);
  if (capped.ok) assertEquals(capped.spec.cooldownSec, 604_800);

  const badColor = normalizeRewardSpec({ ...spec(), color: "red" });
  assert(badColor.ok);
  if (badColor.ok) {
    assertEquals(badColor.spec.color, TIER_COLORS[1]);
    assertEquals(badColor.notes.length, 1);
  }
  const off = normalizeRewardSpec({ ...spec(), enabled: false });
  assert(off.ok);
  if (off.ok) assertEquals(off.spec.enabled, false);
});

Deno.test("applyChannelPointsEnv: MULTICHAT_EFFECTS_TOKEN wins over the file", () => {
  const base = cfg({ overlayToken: "from-file" });
  const env = (m: Record<string, string>) => (n: string) => m[n];
  assertEquals(
    applyChannelPointsEnv(base, env({ MULTICHAT_EFFECTS_TOKEN: " env-tok " }))
      .overlayToken,
    "env-tok",
  );
  assertEquals(applyChannelPointsEnv(base, env({})).overlayToken, "from-file");
  assertEquals(
    applyChannelPointsEnv(base, env({ MULTICHAT_EFFECTS_TOKEN: "  " }))
      .overlayToken,
    "from-file",
  );
  assertEquals(base.overlayToken, "from-file"); // input not mutated
});

Deno.test("channelPointsSetupProblems: channel, EventSub coverage, unknown effects", () => {
  assertEquals(channelPointsSetupProblems(cfg(), ["thecompanyinc"], true), []);
  const unset = channelPointsSetupProblems(cfg({ channel: "" }), [], true);
  assertEquals(unset.length, 1);
  assert(unset[0].includes("not set"));
  const noEs = channelPointsSetupProblems(cfg(), ["someoneelse"], true);
  assertEquals(noEs.length, 1);
  assert(noEs[0].includes("twitch.eventsub.channels"));
  assertEquals(
    channelPointsSetupProblems(cfg(), ["thecompanyinc"], false).length,
    1,
  );
  const unknown = channelPointsSetupProblems(
    cfg({ rewards: [spec({ effect: "creeper_hug" })] }),
    ["thecompanyinc"],
    true,
  );
  assertEquals(unknown.length, 1);
  assert(unknown[0].includes("creeper_hug"));
  assertEquals(
    channelPointsSetupProblems(cfg({ rewards: [] }), ["thecompanyinc"], true)
      .length,
    1,
  );
});

Deno.test("channelPointsScopeWarning: names the state file to delete and the re-login", () => {
  assertEquals(
    channelPointsScopeWarning("tci", ["channel:manage:redemptions"], "/x"),
    null,
  );
  // The response didn't list scopes: unknown, stay quiet.
  assertEquals(channelPointsScopeWarning("tci", null, "/x"), null);
  const w = channelPointsScopeWarning(
    "tci",
    ["bits:read"],
    "/var/lib/multichat/twitch-refresh-1477084215",
  )!;
  assert(w.includes("channel:manage:redemptions"));
  assert(w.includes("multichat login"));
  assert(w.includes("delete /var/lib/multichat/twitch-refresh-1477084215"));
  assert(w.includes("LoadCredential"));
  const noDir = channelPointsScopeWarning("tci", [], null)!;
  assert(noDir.includes("no state directory"));
});

// ---- reward sync ----------------------------------------------------------------

Deno.test("rewardFields: cooldown always on, never input/skip-queue, off limits omitted", () => {
  assertEquals(rewardFields(spec({ color: "#e0a526" })), {
    title: "Budget Cuts",
    cost: 750,
    prompt: "Walk slower.",
    background_color: "#E0A526",
    is_enabled: true,
    is_user_input_required: false,
    should_redemptions_skip_request_queue: false,
    is_global_cooldown_enabled: true,
    global_cooldown_seconds: 180,
    is_max_per_stream_enabled: false,
    is_max_per_user_per_stream_enabled: false,
  });
  const capped = rewardFields(
    spec({ maxPerStream: 1, maxPerUserPerStream: 2 }),
  );
  assertEquals(capped.is_max_per_stream_enabled, true);
  assertEquals(capped.max_per_stream, 1);
  assertEquals(capped.is_max_per_user_per_stream_enabled, true);
  assertEquals(capped.max_per_user_per_stream, 2);
});

Deno.test("diffRewardFields: only the fields that differ", () => {
  assertEquals(
    diffRewardFields({ cost: 1, title: "A", is_enabled: true }, {
      cost: 2,
      title: "A",
      is_enabled: true,
    }),
    { cost: 1 },
  );
  assertEquals(diffRewardFields({ cost: 1 }, { cost: 1 }), {});
});

Deno.test("planRewardSync: nothing on Twitch yet → create the whole catalogue", () => {
  const p = planRewardSync(DEFAULT_CATALOG, [], {});
  assertEquals(p.create.map((s) => s.key), DEFAULT_CATALOG.map((s) => s.key));
  assertEquals(p.update, []);
  assertEquals(p.disable, []);
  assertEquals(p.matched, {});
  assertEquals(p.forget, []);
});

Deno.test("planRewardSync: matched by persisted id, in sync → no calls", () => {
  const s = spec();
  const p = planRewardSync([s], [onTwitch(s, "rw-1")], { budget_cuts: "rw-1" });
  assertEquals(p.matched, { budget_cuts: "rw-1" });
  assertEquals(p.create, []);
  assertEquals(p.update, []);
  // Color casing and a paused state are not drift.
  const q = planRewardSync(
    [s],
    [onTwitch(s, "rw-1", { backgroundColor: "#e0a526", isPaused: true })],
    { budget_cuts: "rw-1" },
  );
  assertEquals(q.update, []);
});

Deno.test("planRewardSync: drift PATCHes just the changed fields", () => {
  const s = spec({ maxPerStream: 5 });
  const p = planRewardSync(
    [s],
    [
      onTwitch(s, "rw-1", {
        cost: 500,
        title: "Old Title",
        isUserInputRequired: true,
        maxPerStream: { enabled: false, value: 0 },
        globalCooldown: { enabled: false, seconds: 0 },
      }),
    ],
    { budget_cuts: "rw-1" },
  );
  assertEquals(p.update, [{
    key: "budget_cuts",
    rewardId: "rw-1",
    fields: {
      title: "Budget Cuts",
      cost: 750,
      is_user_input_required: false,
      is_global_cooldown_enabled: true,
      global_cooldown_seconds: 180,
      is_max_per_stream_enabled: true,
      max_per_stream: 5,
    },
  }]);
  // A catalogue entry switched off is disabled on Twitch the same way.
  const off = spec({ enabled: false });
  const q = planRewardSync([off], [onTwitch(spec(), "rw-1")], {
    budget_cuts: "rw-1",
  });
  assertEquals(q.update[0].fields, { is_enabled: false });
});

Deno.test("planRewardSync: a lost map is re-adopted by exact title", () => {
  const s = spec();
  const p = planRewardSync([s], [onTwitch(s, "rw-9")], {});
  assertEquals(p.matched, { budget_cuts: "rw-9" });
  assertEquals(p.create, []);
  // A stale persisted id (deleted in the dashboard) falls back the same way.
  const q = planRewardSync([s], [onTwitch(s, "rw-9")], { budget_cuts: "gone" });
  assertEquals(q.matched, { budget_cuts: "rw-9" });
  // Title matching is exact.
  const r = planRewardSync(
    [s],
    [onTwitch(s, "rw-9", { title: "budget cuts" })],
    {},
  );
  assertEquals(r.create.map((x) => x.key), ["budget_cuts"]);
});

Deno.test("planRewardSync: title fallback never steals another key's reward", () => {
  // "a" is renamed to the title "b" currently holds; "b" keeps its own reward.
  const a = spec({ key: "a", title: "Bee" });
  const b = spec({ key: "b", title: "Brand New" });
  const p = planRewardSync(
    [a, b],
    [onTwitch(spec({ title: "Bee" }), "rw-b")],
    { b: "rw-b" },
  );
  assertEquals(p.matched, { b: "rw-b" });
  assertEquals(p.create.map((s) => s.key), ["a"]);
  assertEquals(p.update.map((u) => [u.key, u.fields.title]), [[
    "b",
    "Brand New",
  ]]);
});

Deno.test("planRewardSync: retired keys are disabled (never deleted) or forgotten", () => {
  const s = spec();
  const old = spec({ key: "old", title: "Old Reward" });
  const p = planRewardSync(
    [s],
    [onTwitch(s, "rw-1"), onTwitch(old, "rw-old")],
    { budget_cuts: "rw-1", old: "rw-old", gone: "rw-gone" },
  );
  assertEquals(p.disable, [{ key: "old", rewardId: "rw-old" }]);
  // Still mapped, so its stragglers are recognised (and refunded).
  assertEquals(p.matched, { budget_cuts: "rw-1", old: "rw-old" });
  assertEquals(p.forget, ["gone"]);
  // Already disabled → nothing to do, still tracked.
  const q = planRewardSync(
    [s],
    [onTwitch(s, "rw-1"), onTwitch(old, "rw-old", { isEnabled: false })],
    { budget_cuts: "rw-1", old: "rw-old" },
  );
  assertEquals(q.disable, []);
  assertEquals(q.matched.old, "rw-old");
});

Deno.test("reward map helpers: normalize, reverse lookup, status rows", () => {
  assertEquals(
    normalizeManagedRewards({
      byKey: { a: "rw-a", b: 7, "": "x" },
      syncedAt: 5,
    }),
    { byKey: { a: "rw-a" }, syncedAt: 5 },
  );
  assertEquals(normalizeManagedRewards("junk"), { byKey: {}, syncedAt: 0 });
  assertEquals(rewardKeyById({ a: "rw-a", b: "rw-b" }).get("rw-b"), "b");

  const { rows, retired } = rewardStatusRows([spec()], {
    budget_cuts: "rw-1",
    old: "rw-old",
  });
  assertEquals(rows, [{
    key: "budget_cuts",
    title: "Budget Cuts",
    cost: 750,
    effect: "potion",
    enabled: true,
    rewardId: "rw-1",
  }]);
  assertEquals(retired, [{ key: "old", rewardId: "rw-old" }]);
  assertEquals(rewardStatusRows([spec()], {}).rows[0].rewardId, null);

  assertEquals(normalizeChannelPointsControl({ manualPause: true }), {
    manualPause: true,
  });
  assertEquals(normalizeChannelPointsControl(null), { manualPause: false });
});

// ---- ledger reducers ---------------------------------------------------------------

Deno.test("admitRedemption: lands received with a deadline of redeemedAt + ttl", () => {
  const r = admitRedemption([], input(), spec(), T0 + 2_000, 600);
  assert(r.added);
  assertEquals(r.entry, {
    id: "red-1",
    rewardId: "rw-1",
    key: "budget_cuts",
    effect: "potion",
    params: { effect: "slowness", amplifier: 1, seconds: 45 },
    title: "Budget Cuts",
    cost: 750,
    viewer: "Ann",
    login: "ann",
    redeemedAt: T0,
    receivedAt: T0 + 2_000,
    expiresAt: T0 + 600_000,
    state: "received",
    twitchSynced: false,
    simulated: false,
    attempts: 0,
  });
  assertEquals(r.ledger.length, 1);
});

Deno.test("admitRedemption: dedupes by id (EventSub is at-least-once)", () => {
  const first = admitRedemption([], input(), spec(), T0, 600);
  const again = admitRedemption(
    first.ledger,
    input({ viewer: "Someone Else" }),
    spec(),
    T0 + 5,
    600,
  );
  assertEquals(again.added, false);
  assertEquals(again.ledger.length, 1);
  assertEquals(again.entry.viewer, "Ann");
});

Deno.test("admitRedemption: clock skew and missing timestamps can't stretch the deadline", () => {
  const future = admitRedemption(
    [],
    input({ redeemedAt: T0 + 60_000 }),
    spec(),
    T0,
    600,
  );
  assertEquals(future.entry.redeemedAt, T0);
  assertEquals(future.entry.expiresAt, T0 + 600_000);
  const unknown = admitRedemption(
    [],
    input({ redeemedAt: 0 }),
    spec(),
    T0,
    600,
  );
  assertEquals(unknown.entry.redeemedAt, T0);
});

Deno.test("admitRedemption: stale / retired / disabled are refunded on arrival", () => {
  // Found by reconcile long after the deadline.
  const stale = admitRedemption(
    [],
    input({ redeemedAt: T0 }),
    spec(),
    T0 + 600_000,
    600,
  );
  assertEquals(
    [stale.entry.state, stale.entry.outcome, stale.entry.reason],
    ["resolved", "canceled", "stale"],
  );
  assertEquals(stale.entry.twitchSynced, false); // the refund PATCH is still owed
  assertEquals(stale.entry.resolvedAt, T0 + 600_000);

  const retired = admitRedemption(
    [],
    input({ key: "gone" }),
    undefined,
    T0,
    600,
  );
  assertEquals([retired.entry.state, retired.entry.reason], [
    "resolved",
    "retired",
  ]);
  assertEquals(retired.entry.effect, "");
  assertEquals(retired.entry.title, "Budget Cuts"); // what Twitch said

  const disabled = admitRedemption(
    [],
    input(),
    spec({ enabled: false }),
    T0,
    600,
  );
  assertEquals(disabled.entry.reason, "disabled");
  // A simulation of a disabled reward still runs — it's the streamer's test.
  const sim = admitRedemption(
    [],
    input({ simulated: true }),
    spec({ enabled: false }),
    T0,
    600,
  );
  assertEquals(sim.entry.state, "received");
});

Deno.test("admitRedemption: falls back to the catalogue for title/cost/viewer", () => {
  const r = admitRedemption(
    [],
    input({ title: "", cost: 0, viewer: "", login: "lurker" }),
    spec(),
    T0,
    600,
  );
  assertEquals([r.entry.title, r.entry.cost, r.entry.viewer], [
    "Budget Cuts",
    750,
    "lurker",
  ]);
});

Deno.test("markQueued / markAttempt / requeueEntry: only from the right state", () => {
  let l = admitted();
  l = markAttempt(l, "red-1").ledger;
  assertEquals([l[0].state, l[0].attempts], ["received", 1]);
  const q = markQueued(l, "red-1");
  assert(q.changed);
  l = q.ledger;
  assertEquals([l[0].state, l[0].attempts], ["queued", 2]);
  // Not received any more: neither applies again.
  assertEquals(markQueued(l, "red-1").changed, false);
  assertEquals(markAttempt(l, "red-1").changed, false);
  const back = requeueEntry(l, "red-1");
  assert(back.changed);
  assertEquals(back.ledger[0].state, "received");
  assertEquals(requeueEntry(back.ledger, "red-1").changed, false);
  assertEquals(markQueued(l, "nope").changed, false);
});

Deno.test("resolveEntry: open → resolved once; a final never changes", () => {
  const l = markQueued(admitted(), "red-1").ledger;
  const r = resolveEntry(l, "red-1", "fulfilled", "applied", T0 + 9, {
    detail: "Slowness II for 45s",
  });
  assert(r.changed);
  assertEquals(r.previous, "queued");
  assertEquals(r.entry, {
    ...l[0],
    state: "resolved",
    outcome: "fulfilled",
    reason: "applied",
    resolvedAt: T0 + 9,
    twitchSynced: false,
    detail: "Slowness II for 45s",
  });
  // A late overlay result can't flip it (e.g. after a manual refund).
  const again = resolveEntry(r.ledger, "red-1", "canceled", "manual", T0 + 10);
  assertEquals(again.changed, false);
  assertEquals(again.previous, "resolved");
  assertEquals(again.ledger[0].outcome, "fulfilled");
  // Unknown id: nothing.
  const none = resolveEntry(l, "nope", "canceled", "manual", T0);
  assertEquals([none.changed, none.entry, none.previous], [false, null, null]);
});

Deno.test("resolveEntry: an external resolution is already on Twitch; long text capped", () => {
  const r = resolveEntry(admitted(), "red-1", "canceled", "external", T0, {
    twitchSynced: true,
  });
  assertEquals(r.previous, "received");
  assertEquals(r.ledger[0].twitchSynced, true);
  const long = resolveEntry(
    admitted(),
    "red-1",
    "canceled",
    "r".repeat(99),
    T0,
    {
      detail: "d".repeat(999),
    },
  );
  assertEquals(long.ledger[0].reason?.length, 64);
  assertEquals(long.ledger[0].detail?.length, 160);
});

// ---- Durable overlay withdrawal (contract §5.1 / §5.2) ----------------------

Deno.test("resolveEntry withdraw: owed once a POST /effects was ever attempted", () => {
  // Queued (the overlay holds it) → a refund owes the withdrawal, due now.
  const q = markQueued(admitted(), "red-1").ledger;
  const refund = resolveEntry(q, "red-1", "canceled", "manual", T0 + 5, {
    withdraw: true,
  });
  assertEquals(
    [
      refund.entry?.cancelOwed,
      refund.entry?.cancelAttempts,
      refund.entry?.nextCancelAt,
    ],
    [true, 0, T0 + 5],
  );
  // Received after a POST that timed out (it may have landed) → owed too.
  const tried = markAttempt(admitted(), "red-1").ledger;
  const late = resolveEntry(
    tried,
    "red-1",
    "canceled",
    "overlay_unreachable",
    T0,
    { withdraw: true },
  );
  assertEquals(late.entry?.cancelOwed, true);
  // Never sent anywhere → nothing to withdraw.
  const fresh = resolveEntry(admitted(), "red-1", "canceled", "manual", T0, {
    withdraw: true,
  });
  assertEquals(fresh.entry?.cancelOwed, undefined);
  // The overlay's own final result (no `withdraw`) owes nothing.
  const final = resolveEntry(q, "red-1", "canceled", "rejected", T0);
  assertEquals(final.entry?.cancelOwed, undefined);
  // An external fulfil of a queued effect is withdrawn as well.
  const ext = resolveEntry(q, "red-1", "fulfilled", "external", T0, {
    twitchSynced: true,
    withdraw: true,
  });
  assertEquals([ext.entry?.cancelOwed, ext.entry?.twitchSynced], [true, true]);
});

Deno.test("oweCancel: a POST that was in flight when the entry was resolved", () => {
  // Refunded while its first POST was in flight (attempts still 0).
  const l = resolveEntry(admitted(), "red-1", "canceled", "manual", T0).ledger;
  assertEquals(l[0].cancelOwed, undefined);
  const r = oweCancel(l, "red-1", T0 + 1);
  assert(r.changed);
  assertEquals(
    [r.ledger[0].cancelOwed, r.ledger[0].nextCancelAt],
    [true, T0 + 1],
  );
  // Already owed, open, or unknown: no-op.
  assertEquals(oweCancel(r.ledger, "red-1", T0 + 2).changed, false);
  assertEquals(oweCancel(admitted(), "red-1", T0).changed, false);
  assertEquals(oweCancel(l, "nope", T0).changed, false);
});

Deno.test("overlayCancelReason: how the entry was resolved → the wire reason", () => {
  const q = markQueued(admitted(), "red-1").ledger;
  const reasonFor = (outcome: "fulfilled" | "canceled", reason: string) =>
    overlayCancelReason(
      resolveEntry(q, "red-1", outcome, reason, T0, { withdraw: true })
        .entry!,
    );
  assertEquals(reasonFor("fulfilled", "external"), "fulfilled_externally");
  assertEquals(reasonFor("canceled", "external"), "refunded");
  assertEquals(reasonFor("canceled", "manual"), "manual");
  assertEquals(reasonFor("canceled", "timeout"), "timeout");
  assertEquals(reasonFor("canceled", "overlay_unreachable"), "timeout");
  assertEquals(reasonFor("canceled", "game_offline"), "refunded");
});

Deno.test("withdrawal settle / back-off / due: 200 or 404 only; no answer retries next pump", () => {
  for (const s of [200, 202, 404]) assert(cancelAcknowledged(s), `${s}`);
  for (const s of [0, 400, 401, 403, 409, 500, 503]) {
    assert(!cancelAcknowledged(s), `${s}`);
  }
  // No answer (overlay restarting): straight back on the next pump.
  assertEquals([1, 5, 50].map((n) => cancelBackoffMs(n, 0)), [0, 0, 0]);
  assertEquals(
    [1, 2, 3, 9].map((n) => cancelBackoffMs(n, 500)),
    [5_000, 15_000, 60_000, 60_000],
  );

  const q = markQueued(admitted(), "red-1").ledger;
  let l = resolveEntry(q, "red-1", "canceled", "manual", T0, {
    withdraw: true,
  }).ledger;
  assertEquals(dueCancels(l, T0).map((e) => e.id), ["red-1"]);
  l = markCancelFailed(l, "red-1", T0, 503).ledger;
  assertEquals([l[0].cancelAttempts, l[0].nextCancelAt], [1, T0 + 5_000]);
  assertEquals(dueCancels(l, T0 + 4_999).length, 0);
  assertEquals(dueCancels(l, T0 + 5_000).length, 1);
  l = markCancelFailed(l, "red-1", T0 + 5_000, 0).ledger;
  assertEquals([l[0].cancelAttempts, l[0].nextCancelAt], [2, T0 + 5_000]);
  // Settled: the flag and its bookkeeping are gone; nothing is due.
  const done = markCancelDone(l, "red-1");
  assert(done.changed);
  assertEquals(
    [
      done.ledger[0].cancelOwed,
      done.ledger[0].cancelAttempts,
      done.ledger[0].nextCancelAt,
    ],
    [undefined, undefined, undefined],
  );
  assertEquals(dueCancels(done.ledger, T0 + 99_999).length, 0);
  // Nothing owed: both are no-ops.
  assertEquals(markCancelDone(done.ledger, "red-1").changed, false);
  assertEquals(markCancelFailed(done.ledger, "red-1", T0, 0).changed, false);
});

Deno.test("dueCancels: oldest resolution first", () => {
  let l: RedemptionEntry[] = [];
  for (const id of ["a", "b", "c"]) {
    l = admitRedemption(l, input({ id }), spec(), T0, 600).ledger;
    l = markQueued(l, id).ledger;
  }
  l = resolveEntry(l, "b", "canceled", "manual", T0 + 1, { withdraw: true })
    .ledger;
  l = resolveEntry(l, "a", "canceled", "manual", T0 + 2, { withdraw: true })
    .ledger;
  l = resolveEntry(l, "c", "fulfilled", "applied", T0 + 3).ledger;
  assertEquals(dueCancels(l, T0 + 10).map((e) => e.id), ["b", "a"]);
});

Deno.test("markSynced / markSyncFailed: only resolved, un-synced entries; back-off grows", () => {
  let l = resolveEntry(admitted(), "red-1", "canceled", "timeout", T0).ledger;
  l = markSyncFailed(l, ["red-1"], T0);
  assertEquals([l[0].syncAttempts, l[0].nextSyncAt], [
    1,
    T0 + syncBackoffMs(1),
  ]);
  l = markSyncFailed(l, ["red-1"], T0 + 10_000);
  assertEquals(l[0].syncAttempts, 2);
  assertEquals(l[0].nextSyncAt, T0 + 10_000 + syncBackoffMs(2));
  l = markSynced(l, ["red-1"]);
  assertEquals(l[0].twitchSynced, true);
  assertEquals(l[0].nextSyncAt, undefined);
  // An open entry is never marked synced.
  assertEquals(markSynced(admitted(), ["red-1"])[0].twitchSynced, false);
  assertEquals(
    markSyncFailed(admitted(), ["red-1"], T0)[0].syncAttempts,
    undefined,
  );

  assertEquals(
    [1, 2, 3, 4, 5, 9].map(syncBackoffMs),
    [5_000, 15_000, 60_000, 300_000, 900_000, 900_000],
  );
});

Deno.test("dueSyncBatches: per reward + status, ≤50, skipping what isn't due", () => {
  let l: RedemptionEntry[] = [];
  const add = (
    id: string,
    rewardId: string,
    over: Partial<RedemptionInput> = {},
  ) => {
    l = admitRedemption(l, input({ id, rewardId, ...over }), spec(), T0, 600)
      .ledger;
  };
  for (let i = 0; i < 52; i++) add(`a${i}`, "rw-a");
  add("b1", "rw-b");
  add("b2", "rw-b");
  add("sim", "rw-a", { simulated: true });
  add("open", "rw-a");
  for (let i = 0; i < 52; i++) {
    l = resolveEntry(l, `a${i}`, "fulfilled", "applied", T0).ledger;
  }
  l = resolveEntry(l, "b1", "canceled", "rejected", T0).ledger;
  l = resolveEntry(l, "b2", "fulfilled", "armed", T0).ledger;
  l = resolveEntry(l, "sim", "fulfilled", "applied", T0).ledger;

  const batches = dueSyncBatches(l, T0);
  assertEquals(
    batches.map((b) => [b.rewardId, b.status, b.ids.length]),
    [
      ["rw-a", "FULFILLED", 50],
      ["rw-a", "FULFILLED", 2],
      ["rw-b", "CANCELED", 1],
      ["rw-b", "FULFILLED", 1],
    ],
  );
  // Simulated never touches Twitch; unresolved isn't final yet.
  assert(!batches.some((b) => b.ids.includes("sim") || b.ids.includes("open")));

  // Backed off → not due until nextSyncAt; synced → never again.
  l = markSyncFailed(l, ["b1"], T0);
  assert(!dueSyncBatches(l, T0 + 1).some((b) => b.ids.includes("b1")));
  assert(
    dueSyncBatches(l, T0 + syncBackoffMs(1)).some((b) => b.ids.includes("b1")),
  );
  l = markSynced(l, ["b2"]);
  assert(!dueSyncBatches(l, T0).some((b) => b.ids.includes("b2")));

  assertEquals(twitchStatusFor("fulfilled"), "FULFILLED");
  assertEquals(twitchStatusFor("canceled"), "CANCELED");
});

Deno.test("parseUpdatedRedemptionIds: the ids echoed in data", () => {
  assertEquals(
    parseUpdatedRedemptionIds({
      data: [{ id: "a", status: "FULFILLED" }, { id: "" }, "junk", { id: "b" }],
    }),
    ["a", "b"],
  );
  assertEquals(parseUpdatedRedemptionIds({ data: [] }), []);
  assertEquals(parseUpdatedRedemptionIds({}), null);
  assertEquals(parseUpdatedRedemptionIds(null), null);
});

Deno.test("judgeSyncBatch: one stale id can't poison its batch", () => {
  const ok = (ids: string[]) =>
    parseHelixResponse(200, { data: ids.map((id) => ({ id })) });
  const fail = (status: number) =>
    parseHelixResponse(status, { message: "nope" });
  // 2xx: only what Twitch echoed is settled; the rest go singly.
  assertEquals(judgeSyncBatch(["a", "b", "c"], ok(["a", "c"])), {
    synced: ["a", "c"],
    failed: [],
    split: ["b"],
  });
  assertEquals(judgeSyncBatch(["a", "b"], ok(["a", "b"])), {
    synced: ["a", "b"],
    failed: [],
    split: [],
  });
  // A 2xx without a data list: can't tell which landed → singly.
  assertEquals(
    judgeSyncBatch(["a", "b"], parseHelixResponse(200, null)),
    { synced: [], failed: [], split: ["a", "b"] },
  );
  // A single id's 2xx is settled outright.
  assertEquals(judgeSyncBatch(["a"], parseHelixResponse(200, null)), {
    synced: ["a"],
    failed: [],
    split: [],
  });
  // 404 / 400 on a multi-id batch: re-PATCH each id on its own.
  for (const status of [404, 400]) {
    assertEquals(judgeSyncBatch(["a", "b"], fail(status)), {
      synced: [],
      failed: [],
      split: ["a", "b"],
    });
  }
  // A single id's 404 is terminal (no longer UNFULFILLED) → settled.
  assertEquals(judgeSyncBatch(["a"], fail(404)), {
    synced: ["a"],
    failed: [],
    split: [],
  });
  // Everything else backs off, batch or single.
  for (const status of [0, 401, 403, 429, 500]) {
    assertEquals(judgeSyncBatch(["a", "b"], fail(status)), {
      synced: [],
      failed: ["a", "b"],
      split: [],
    });
  }
  assertEquals(judgeSyncBatch(["a"], fail(400)), {
    synced: [],
    failed: ["a"],
    split: [],
  });
});

Deno.test("queuedTimedOut: only a queued entry past deadline + grace", () => {
  const l = markQueued(admitted(), "red-1").ledger;
  const e = l[0];
  assert(!queuedTimedOut(e, e.expiresAt + QUEUE_GRACE_MS));
  assert(queuedTimedOut(e, e.expiresAt + QUEUE_GRACE_MS + 1));
  assert(!queuedTimedOut(admitted()[0], e.expiresAt + QUEUE_GRACE_MS + 1));
});

Deno.test("openEntries / ledgerCounts: points still held count as open", () => {
  let l: RedemptionEntry[] = [];
  for (const id of ["r", "q", "done", "unsynced", "sim"]) {
    l = admitRedemption(
      l,
      input({ id, simulated: id === "sim" }),
      spec(),
      T0,
      600,
    ).ledger;
  }
  l = markQueued(l, "q").ledger;
  l = resolveEntry(l, "done", "fulfilled", "applied", T0).ledger;
  l = markSynced(l, ["done"]);
  l = resolveEntry(l, "unsynced", "canceled", "rejected", T0).ledger;
  l = resolveEntry(l, "sim", "fulfilled", "applied", T0).ledger;
  assertEquals(openEntries(l).map((e) => e.id), ["r", "q", "unsynced"]);
  assertEquals(ledgerCounts(l), {
    received: 1,
    queued: 1,
    unsynced: 1,
    withdrawing: 0,
    resolved: 3,
  });

  // Settled on Twitch but the overlay hasn't confirmed the withdrawal: open.
  let w = markQueued(admitted(), "red-1").ledger;
  w = resolveEntry(w, "red-1", "canceled", "external", T0, {
    twitchSynced: true,
    withdraw: true,
  }).ledger;
  assertEquals(openEntries(w).map((e) => e.id), ["red-1"]);
  assertEquals(ledgerCounts(w).withdrawing, 1);
  w = markCancelDone(w, "red-1").ledger;
  assertEquals(openEntries(w).length, 0);
  assertEquals(ledgerCounts(w).withdrawing, 0);
});

Deno.test("pruneLedger: finished entries age out; open ones never do; hard cap", () => {
  const old = T0 - LEDGER_RETENTION_MS - 1;
  let l: RedemptionEntry[] = [];
  for (const id of ["oldDone", "oldOpen", "oldUnsynced", "fresh"]) {
    l = admitRedemption(l, input({ id }), spec(), old, 600).ledger;
  }
  l = resolveEntry(l, "oldDone", "fulfilled", "applied", old).ledger;
  l = markSynced(l, ["oldDone"]);
  l = resolveEntry(l, "oldUnsynced", "canceled", "rejected", old).ledger;
  l = resolveEntry(l, "fresh", "fulfilled", "applied", T0).ledger;
  l = markSynced(l, ["fresh"]);
  assertEquals(pruneLedger(l, T0).map((e) => e.id), [
    "oldOpen",
    "oldUnsynced",
    "fresh",
  ]);

  // Over the cap: the oldest finished go first, open entries stay.
  let big: RedemptionEntry[] = [];
  for (let i = 0; i < LEDGER_CAP + 5; i++) {
    big = admitRedemption(big, input({ id: `e${i}` }), spec(), T0 + i, 600)
      .ledger;
    if (i >= 10) {
      big = resolveEntry(big, `e${i}`, "fulfilled", "applied", T0 + i).ledger;
      big = markSynced(big, [`e${i}`]);
    }
  }
  const pruned = pruneLedger(big, T0 + LEDGER_CAP + 10);
  assertEquals(pruned.length, LEDGER_CAP);
  for (let i = 0; i < 10; i++) {
    assert(pruned.some((e) => e.id === `e${i}`), `open e${i} was pruned`);
  }
  assert(!pruned.some((e) => e.id === "e10"));

  // A withdrawal still owed is never pruned, however old (the overlay may
  // still run the effect) — not by age, not by the cap.
  let owed = markQueued(
    admitRedemption([], input({ id: "owed" }), spec(), old, 600).ledger,
    "owed",
  ).ledger;
  owed = resolveEntry(owed, "owed", "canceled", "external", old, {
    twitchSynced: true,
    withdraw: true,
  }).ledger;
  assertEquals(pruneLedger(owed, T0).map((e) => e.id), ["owed"]);
  const capped = pruneLedger([...owed, ...big], T0 + LEDGER_CAP + 10);
  assert(capped.some((e) => e.id === "owed"));
  assertEquals(
    pruneLedger(markCancelDone(owed, "owed").ledger, T0).length,
    0,
  );
});

Deno.test("normalizeLedger: round-trips, drops junk, dedupes, settles outcome-less finals", () => {
  let l = admitted();
  l = markQueued(l, "red-1").ledger;
  l = admitRedemption(l, input({ id: "red-2" }), spec(), T0, 600).ledger;
  l = resolveEntry(l, "red-2", "canceled", "rejected", T0, {
    detail: "empty_hand",
  }).ledger;
  l = markSyncFailed(l, ["red-2"], T0);
  assertEquals(normalizeLedger(JSON.parse(serializeLedger(l))), l);

  // An owed withdrawal survives a restart (that is the point of it).
  let w = resolveEntry(l, "red-1", "canceled", "manual", T0, {
    withdraw: true,
  }).ledger;
  w = markCancelFailed(w, "red-1", T0, 500).ledger;
  assertEquals(w[0].cancelOwed, true);
  assertEquals(normalizeLedger(JSON.parse(serializeLedger(w))), w);
  // Only a resolved entry can owe one.
  assertEquals(
    normalizeLedger([{ id: "x", state: "queued", cancelOwed: true }])[0]
      .cancelOwed,
    undefined,
  );

  assertEquals(normalizeLedger("junk"), []);
  const cleaned = normalizeLedger([
    { id: "", state: "received" },
    { id: "a", state: "bogus" },
    { id: "b", state: "resolved" }, // no outcome → refund it
    { id: "b", state: "received" }, // duplicate id
    { id: "c", state: "received", params: { ok: 1, bad: {} } },
    7,
  ]);
  assertEquals(cleaned.map((e) => [e.id, e.state, e.outcome ?? null]), [
    ["b", "resolved", "canceled"],
    ["c", "received", null],
  ]);
  assertEquals(cleaned[1].params, { ok: 1 });
});

Deno.test("simulatedRedemption: sim-<uuid>, flagged, default viewer", () => {
  const s = simulatedRedemption(spec(), "rw-1", "", "u-u-i-d", T0);
  assertEquals(s, {
    id: "sim-u-u-i-d",
    rewardId: "rw-1",
    key: "budget_cuts",
    title: "Budget Cuts",
    cost: 750,
    viewer: DEFAULT_SIMULATED_VIEWER,
    login: "",
    redeemedAt: T0,
    simulated: true,
  });
  assertEquals(
    simulatedRedemption(spec(), "", "Nova", "x", T0).viewer,
    "Nova",
  );
});

// ---- overlay wire -------------------------------------------------------------------

Deno.test("buildEffectEnqueueRequest: POST /effects with the time left as ttlSec", () => {
  const e = admitted()[0];
  const req = buildEffectEnqueueRequest(cfg(), e, T0 + 100_500);
  assertEquals(req.url, "http://127.0.0.1:8082/effects");
  assertEquals(req.method, "POST");
  assertEquals(req.headers, { "content-type": "application/json" });
  assertEquals(JSON.parse(req.body!), {
    id: "red-1",
    effect: "potion",
    params: { effect: "slowness", amplifier: 1, seconds: 45 },
    viewer: "Ann",
    viewerLogin: "ann",
    reward: "Budget Cuts",
    cost: 750,
    simulated: false,
    ttlSec: 500, // 600s deadline, 100.5s already gone → rounds up
  });
  // Never below 1, and the bearer rides along when a token is set.
  const late = buildEffectEnqueueRequest(
    cfg({ overlayToken: "sekrit" }),
    e,
    e.expiresAt + 5,
  );
  assertEquals(JSON.parse(late.body!).ttlSec, 1);
  assertEquals(late.headers.authorization, "Bearer sekrit");
  // A simulated redemption has no login: the optional field is left out.
  const sim = admitRedemption(
    [],
    input({ login: "", simulated: true }),
    spec(),
    T0,
    600,
  ).entry;
  const simBody = JSON.parse(buildEffectEnqueueRequest(cfg(), sim, T0).body!);
  assert(!("viewerLogin" in simBody));
  assertEquals(simBody.simulated, true);
});

Deno.test("buildEffectsLookupRequest / cancel / health: routes, auth, limits", () => {
  const look = buildEffectsLookupRequest(cfg({ overlayToken: "t" }), [
    "a",
    "b",
  ]);
  const u = new URL(look.url);
  assertEquals(u.origin + u.pathname, "http://127.0.0.1:8082/effects");
  assertEquals(u.searchParams.get("ids"), "a,b");
  // Literal commas: a raw split of the query sees the same list.
  assertEquals(u.search, "?ids=a,b");
  assertEquals(look.method, "GET");
  assertEquals(look.headers, { authorization: "Bearer t" });
  assertThrows(() => buildEffectsLookupRequest(cfg(), []));
  assertThrows(() =>
    buildEffectsLookupRequest(
      cfg(),
      Array.from({ length: 51 }, (_, i) => `id${i}`),
    )
  );

  const cancel = buildEffectCancelRequest(cfg(), "sim-a/b", "manual");
  assertEquals(cancel.url, "http://127.0.0.1:8082/effects/sim-a%2Fb/cancel");
  assertEquals(cancel.method, "POST");
  // The reason rides along so the memo can tell a refund from a close-out.
  assertEquals(JSON.parse(cancel.body!), { reason: "manual" });
  assertEquals(
    JSON.parse(
      buildEffectCancelRequest(cfg(), "x", "fulfilled_externally").body!,
    ),
    { reason: "fulfilled_externally" },
  );
  assertEquals(
    buildEffectCancelRequest(cfg({ overlayToken: "t" }), "x", "timeout")
      .headers,
    { "content-type": "application/json", authorization: "Bearer t" },
  );

  const health = buildEffectsHealthRequest(cfg());
  assertEquals(health.url, "http://127.0.0.1:8082/effects/health");
  assertEquals(health.method, "GET");
  assertEquals(health.headers, {});
});

Deno.test("interpretEnqueueResponse: queued / refused-with-reason / retried", () => {
  assertEquals(
    interpretEnqueueResponse(202, { ok: true, status: "pending" }),
    { kind: "queued", status: "pending" },
  );
  assertEquals(
    interpretEnqueueResponse(200, { ok: true, dup: true, status: "applied" }),
    { kind: "queued", status: "applied" },
  );
  assertEquals(interpretEnqueueResponse(200, null), {
    kind: "retry",
    reason: "bad_response",
  });
  // Refusals refund at once, carrying the overlay's reason.
  for (
    const [status, reason] of [
      [503, "game_offline"],
      [503, "disabled"],
      [429, "queue_full"],
      [400, "bad_request"],
      [403, "forbidden"],
    ] as const
  ) {
    assertEquals(interpretEnqueueResponse(status, { ok: false, reason }), {
      kind: "refused",
      reason,
    });
  }
  // An overlay too old to have the route: refused, not retried forever.
  assertEquals(interpretEnqueueResponse(404, "Not Found"), {
    kind: "refused",
    reason: "http_404",
  });
  assertEquals(interpretEnqueueResponse(500, null), {
    kind: "retry",
    reason: "http_500",
  });
  assertEquals(interpretEnqueueResponse(0, null), {
    kind: "retry",
    reason: "overlay_unreachable",
  });
});

Deno.test("parseEffectsLookup / effectOutcome: finals map to fulfil or refund", () => {
  const m = parseEffectsLookup({
    ok: true,
    effects: [
      { id: "a", status: "applied", detail: "Slowness II", updatedAt: 1 },
      { id: "b", status: "rejected", reason: "empty_hand", updatedAt: 1 },
      { id: "c", status: "leased", updatedAt: 1 },
      { status: "applied" },
      "junk",
    ],
  });
  assertEquals([...m.keys()], ["a", "b", "c"]);
  assertEquals(m.get("a"), {
    id: "a",
    status: "applied",
    detail: "Slowness II",
  });
  assertEquals(m.get("b"), {
    id: "b",
    status: "rejected",
    reason: "empty_hand",
  });
  assertEquals(parseEffectsLookup(null).size, 0);

  const cases: [string, string | null][] = [
    ["applied", "fulfilled"],
    ["armed", "fulfilled"],
    ["rejected", "canceled"],
    ["expired", "canceled"],
    ["canceled", "canceled"],
    ["pending", null],
    ["leased", null],
    ["accepted", null],
    ["weird", null],
  ];
  for (const [status, want] of cases) assertEquals(effectOutcome(status), want);
});

Deno.test("parseEffectsHealth: accepting or not; junk is null", () => {
  assertEquals(
    parseEffectsHealth({
      ok: true,
      enabled: true,
      accepting: true,
      lastPollAgoMs: 1200,
      ready: true,
      open: 0,
      pending: 0,
    }),
    { enabled: true, accepting: true, ready: true, lastPollAgoMs: 1200 },
  );
  // No `ready` reads as not ready (fail closed).
  assertEquals(
    parseEffectsHealth({
      ok: true,
      enabled: false,
      accepting: false,
      lastPollAgoMs: null,
    }),
    { enabled: false, accepting: false, ready: false, lastPollAgoMs: null },
  );
  assertEquals(parseEffectsHealth({ ok: false, reason: "forbidden" }), null);
  assertEquals(parseEffectsHealth({ ok: true, accepting: "yes" }), null);
  assertEquals(parseEffectsHealth("down"), null);
});

Deno.test("healthGood: polling AND ready (ESC-paused / /chaos pause is bad)", () => {
  const h = (accepting: boolean, ready: boolean, enabled = true) => ({
    enabled,
    accepting,
    ready,
    lastPollAgoMs: 100,
  });
  assert(healthGood(h(true, true)));
  assert(!healthGood(h(true, false))); // polling, but the game can't run it
  assert(!healthGood(h(false, true)));
  assert(!healthGood(h(true, true, false)));
  assert(!healthGood(null)); // overlay down
});

Deno.test("stepAutoPause: pause after 2 bad checks in a row, resume on the first good", () => {
  assertEquals(AUTO_PAUSE_BAD_CHECKS, 2);
  // Fail closed before the first check; the first good one releases.
  let g = initialAutoPauseGate();
  assertEquals(g.paused, true);
  g = stepAutoPause(g, false);
  assertEquals(g, { bad: 1, paused: true });
  g = stepAutoPause(g, true);
  assertEquals(g, { bad: 0, paused: false });
  // Live: one bad check (a missed poll) doesn't flap the rewards...
  g = stepAutoPause(g, false);
  assertEquals(g, { bad: 1, paused: false });
  g = stepAutoPause(g, true);
  assertEquals(g, { bad: 0, paused: false });
  // ...two in a row pause them, and they stay paused while it stays bad.
  g = stepAutoPause(stepAutoPause(g, false), false);
  assertEquals(g, { bad: 2, paused: true });
  g = stepAutoPause(g, false);
  assertEquals(g.paused, true);
  // The first good check resumes.
  assertEquals(stepAutoPause(g, true), { bad: 0, paused: false });
});

Deno.test("redemptionChatMessage: a system row in the reward's tier color", () => {
  const e = admitted()[0];
  assertEquals(redemptionChatMessage(e, "thecompanyinc", "#E0A526"), {
    id: "cp-red-1",
    platform: "twitch",
    channel: "thecompanyinc",
    author: "Ann",
    content: "",
    kind: "system",
    accentColor: "#E0A526",
    amount: "750 points",
    eventText: "Ann redeemed Budget Cuts",
    timestamp: T0,
  });
  const sim = admitRedemption([], input({ simulated: true }), spec(), T0, 600)
    .entry;
  assertEquals(
    redemptionChatMessage(sim, "c", "#000000").eventText,
    "Ann redeemed Budget Cuts (simulated)",
  );
});

// ---- control wire ----------------------------------------------------------------

Deno.test("parseRewardsAction: every verb, validated", () => {
  for (const action of ["status", "sync", "pause", "resume", "pending"]) {
    assertEquals(parseRewardsAction(JSON.stringify({ action })), {
      ok: true,
      action: { action } as RewardsAction,
    });
  }
  assertEquals(parseRewardsAction('{"action":"refund","id":" red-1 "}'), {
    ok: true,
    action: { action: "refund", id: "red-1" },
  });
  assertEquals(
    parseRewardsAction(
      '{"action":"simulate","key":"Budget_Cuts","user":"Nova"}',
    ),
    {
      ok: true,
      action: { action: "simulate", key: "budget_cuts", user: "Nova" },
    },
  );
  assertEquals(parseRewardsAction('{"action":"simulate","key":"k"}'), {
    ok: true,
    action: { action: "simulate", key: "k" },
  });

  const bad = (raw: string) => !parseRewardsAction(raw).ok;
  assert(bad("not json"));
  assert(bad("[]"));
  assert(bad('{"action":"refund"}'));
  assert(bad(`{"action":"refund","id":"${"x".repeat(101)}"}`));
  assert(bad('{"action":"simulate"}'));
  assert(bad('{"action":"delete-everything"}'));
});

Deno.test("serializeRewardsAction round-trips through parse", () => {
  const actions: RewardsAction[] = [
    { action: "status" },
    { action: "sync" },
    { action: "pause" },
    { action: "resume" },
    { action: "pending" },
    { action: "refund", id: "red-1" },
    { action: "simulate", key: "budget_cuts" },
    { action: "simulate", key: "budget_cuts", user: "Nova" },
  ];
  for (const a of actions) {
    assertEquals(parseRewardsAction(serializeRewardsAction(a)), {
      ok: true,
      action: a,
    });
  }
});

Deno.test("cleanViewerName: control chars stripped, trimmed, 25 max", () => {
  assertEquals(cleanViewerName("  Nova\u0007Byte \n"), "NovaByte");
  assertEquals(cleanViewerName("x".repeat(40)).length, 25);
  assertEquals(cleanViewerName(42), "");
});

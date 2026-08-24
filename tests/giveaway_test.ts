import {
  addEntrant,
  campaignSummary,
  closePool,
  decideEligibility,
  DEFAULT_MESSAGES,
  demoEntrants,
  demoFollowerIds,
  drawSegmented,
  drawWinner,
  emptyCampaign,
  emptyPool,
  type GiveawayAction,
  type GiveawayEntry,
  giveawayMessage,
  hasEntrant,
  matchGiveawayCommand,
  normalizeCampaignState,
  normalizeGiveawayConfig,
  normalizePoolState,
  openPool,
  parseGiveawayAction,
  parseWinnersLog,
  recordFollower,
  removeEntrant,
  resetPool,
  serializeGiveawayAction,
  serializeWinnerLine,
  winnersToCsv,
  winnerTier,
} from "../src/giveaway.ts";
import type { GiveawayConfig, GiveawayWinner } from "../src/types.ts";
import { assert, assertEquals } from "./_assert.ts";

const entrant = (userId: string, name = userId): GiveawayEntry => ({
  userId,
  login: name.toLowerCase(),
  displayName: name,
  enteredAt: 0,
});

const baseConfig = (over: Partial<GiveawayConfig> = {}): GiveawayConfig => ({
  enabled: true,
  channel: "c",
  prefix: "!",
  command: "enter",
  requireFollow: true,
  replies: true,
  firstN: 0,
  followerStep: 0,
  milestoneDraws: 1,
  ...over,
});

Deno.test("normalizeGiveawayConfig: defaults for missing/garbage input", () => {
  const c = normalizeGiveawayConfig(undefined);
  assertEquals(c.enabled, false);
  assertEquals(c.prefix, "!");
  assertEquals(c.command, "enter");
  assertEquals(c.requireFollow, true); // default-on unless explicitly false
  assertEquals(c.replies, true);
  assertEquals(c.channel, "");
  assertEquals(c.messages, undefined);
  // Campaign knobs default off / neutral.
  assertEquals(c.firstN, 0);
  assertEquals(c.followerStep, 0);
  assertEquals(c.milestoneDraws, 1);

  // A non-object is treated as absent, not a crash.
  assertEquals(normalizeGiveawayConfig("nope").enabled, false);
});

Deno.test("normalizeGiveawayConfig: reads explicit values, lowercases channel", () => {
  const c = normalizeGiveawayConfig({
    enabled: true,
    channel: "StreamerOne",
    prefix: "?",
    command: "join",
    requireFollow: false,
    replies: false,
    firstN: 500,
    followerStep: 100,
    milestoneDraws: 10,
    messages: { entered: "hi {user}", bogus: 5, winner: "  " },
  });
  assertEquals(c.enabled, true);
  assertEquals(c.channel, "streamerone");
  assertEquals(c.prefix, "?");
  assertEquals(c.command, "join");
  assertEquals(c.requireFollow, false);
  assertEquals(c.replies, false);
  assertEquals(c.firstN, 500);
  assertEquals(c.followerStep, 100);
  assertEquals(c.milestoneDraws, 10);
  // Only known, non-blank string templates survive.
  assertEquals(c.messages, { entered: "hi {user}" });
});

Deno.test("normalizeGiveawayConfig: campaign knobs coerce garbage/negatives", () => {
  const c = normalizeGiveawayConfig({
    firstN: -5,
    followerStep: "wat",
    milestoneDraws: 0, // clamped to at least 1
  });
  assertEquals(c.firstN, 0);
  assertEquals(c.followerStep, 0);
  assertEquals(c.milestoneDraws, 1);
  assertEquals(normalizeGiveawayConfig({ firstN: 12.9 }).firstN, 12); // floored
});

Deno.test("matchGiveawayCommand: whole-token, case-insensitive", () => {
  const m = (t: string) => matchGiveawayCommand(t, "!", "enter");
  assert(m("!enter"));
  assert(m("  !enter  "));
  assert(m("!enter please"));
  assert(m("!ENTER"));
  assert(!m("!enterprise")); // must not prefix-match
  assert(!m("hello !enter")); // must be the first token
  assert(!m("?enter")); // wrong prefix
  assert(matchGiveawayCommand("?JOIN", "?", "join")); // custom prefix/command
});

Deno.test("addEntrant: adds once, dedupes by userId, no-op when closed", () => {
  let pool = emptyPool(true);
  const a = addEntrant(pool, entrant("1", "Ann"));
  assert(a.added);
  pool = a.state;
  assertEquals(pool.entrants.length, 1);
  assert(hasEntrant(pool, "1"));

  // Same userId (even different display name) does not duplicate.
  const dup = addEntrant(pool, entrant("1", "AnnRenamed"));
  assert(!dup.added);
  assertEquals(dup.state.entrants.length, 1);

  // Closed pool rejects new entrants.
  const closed = addEntrant(closePool(pool), entrant("2", "Bo"));
  assert(!closed.added);
  assertEquals(closed.state.entrants.length, 1);
});

Deno.test("addEntrant: assigns permanent sequential entry numbers", () => {
  let pool = emptyPool(true);
  pool = addEntrant(pool, entrant("a")).state;
  pool = addEntrant(pool, entrant("b")).state;
  pool = addEntrant(pool, entrant("c")).state;
  assertEquals(pool.entrants.map((e) => e.number), [1, 2, 3]);
  assertEquals(pool.nextNumber, 4);

  // Removal never frees a number; the next entrant continues the sequence.
  pool = removeEntrant(pool, "b");
  pool = addEntrant(pool, entrant("d")).state;
  assertEquals(pool.entrants.map((e) => e.number), [1, 3, 4]);
  assertEquals(pool.nextNumber, 5);

  // resetPool clears entrants but keeps the counter — numbers are permanent.
  const reset = resetPool(pool);
  assertEquals(reset.entrants.length, 0);
  assertEquals(reset.nextNumber, 5);
  const after = addEntrant(reset, entrant("e")).state;
  assertEquals(after.entrants[0].number, 5);
});

Deno.test("removeEntrant / reset / open / close", () => {
  let pool = emptyPool(true);
  pool = addEntrant(pool, entrant("1")).state;
  pool = addEntrant(pool, entrant("2")).state;

  pool = removeEntrant(pool, "1");
  assertEquals(pool.entrants.map((e) => e.userId), ["2"]);

  assertEquals(closePool(pool).open, false);
  assertEquals(openPool(closePool(pool)).open, true);

  const reset = resetPool(pool);
  assertEquals(reset.entrants.length, 0);
  assertEquals(reset.open, pool.open); // reset keeps the open flag
});

Deno.test("drawWinner: deterministic with injected rng, removes winner", () => {
  let pool = emptyPool(true);
  for (const id of ["a", "b", "c"]) pool = addEntrant(pool, entrant(id)).state;

  const first = drawWinner(pool, () => 0); // idx 0
  assertEquals(first.winner?.userId, "a");
  assertEquals(first.state.entrants.map((e) => e.userId), ["b", "c"]);
  assertEquals(first.state.lastWinner?.userId, "a");
  assertEquals(first.state.nextNumber, pool.nextNumber); // draw never touches numbering

  const last = drawWinner(pool, () => 0.999); // clamps to last idx
  assertEquals(last.winner?.userId, "c");
});

Deno.test("drawWinner: empty pool returns null, never throws", () => {
  const r = drawWinner(emptyPool(true), () => 0.5);
  assertEquals(r.winner, null);
  assertEquals(r.state.entrants.length, 0);
});

Deno.test("drawSegmented: guaranteed queue first, then the pool", () => {
  let pool = emptyPool(true);
  for (const id of ["a", "b", "c", "d", "e"]) {
    pool = addEntrant(pool, entrant(id)).state; // numbers 1..5
  }
  const firstN = 3; // a,b,c guaranteed; d,e pool

  // While guaranteed entrants remain, only they can win, and the reel is them.
  const g1 = drawSegmented(pool, firstN, () => 0.999);
  assertEquals(g1.segment, "guaranteed");
  assertEquals(g1.winner?.userId, "c"); // last of the guaranteed candidates
  assertEquals(g1.reel.map((e) => e.userId), ["a", "b", "c"]);

  let s = g1.state;
  s = drawSegmented(s, firstN, () => 0).state; // draws "a"
  const g3 = drawSegmented(s, firstN, () => 0);
  assertEquals(g3.segment, "guaranteed");
  assertEquals(g3.winner?.userId, "b"); // the only guaranteed one left

  // Queue exhausted → draws come from the pool (numbers > firstN).
  const p1 = drawSegmented(g3.state, firstN, () => 0);
  assertEquals(p1.segment, "pool");
  assertEquals(p1.winner?.userId, "d");
  assertEquals(p1.reel.map((e) => e.userId), ["d", "e"]);

  // Empty → null, segment reported, never throws.
  const empty = drawSegmented(emptyPool(true), firstN, () => 0.5);
  assertEquals(empty.winner, null);
  assertEquals(empty.reel, []);
});

Deno.test("drawSegmented: firstN=0 behaves like drawWinner over everyone", () => {
  let pool = emptyPool(true);
  for (const id of ["a", "b"]) pool = addEntrant(pool, entrant(id)).state;
  const r = drawSegmented(pool, 0, () => 0);
  assertEquals(r.segment, "pool");
  assertEquals(r.winner?.userId, "a");
  assertEquals(r.reel.map((e) => e.userId), ["a", "b"]);
});

Deno.test("recordFollower: dedupes, crosses milestones, arms credits", () => {
  const cfg = { followerStep: 3, milestoneDraws: 2 };
  let c = emptyCampaign();

  // Count up to just below the milestone.
  for (const id of ["f1", "f2"]) c = recordFollower(c, id, cfg).campaign;
  assertEquals(c.followerCount, 2);
  assertEquals(c.milestonesReached, 0);
  assertEquals(c.creditsRemaining, 0);

  // A repeat follow (same id) is not counted.
  const dup = recordFollower(c, "f1", cfg);
  assert(!dup.counted);
  assertEquals(dup.campaign.followerCount, 2);

  // The 3rd unique follower crosses milestone 1 and arms 2 credits.
  const cross = recordFollower(c, "f3", cfg);
  assert(cross.counted);
  assertEquals(cross.milestoneCrossed, 1);
  assertEquals(cross.campaign.milestonesReached, 1);
  assertEquals(cross.campaign.creditsRemaining, 2);

  // No milestone between steps.
  const mid = recordFollower(cross.campaign, "f4", cfg);
  assertEquals(mid.milestoneCrossed, null);

  // followerStep 0 = tracking off: counts, never crosses.
  const off = recordFollower(emptyCampaign(), "x", {
    followerStep: 0,
    milestoneDraws: 5,
  });
  assert(off.counted);
  assertEquals(off.milestoneCrossed, null);
  assertEquals(off.campaign.creditsRemaining, 0);

  // Empty id can't be deduped → not counted.
  assert(!recordFollower(emptyCampaign(), "", cfg).counted);
});

Deno.test("recordFollower: a lowered step arms multiple milestones at once", () => {
  // 5 followers counted at step 10 (no milestones), then the step drops to 2:
  // the next follower recomputes floor(6/2)=3 milestones and arms 3*draws.
  let c = emptyCampaign();
  const wide = { followerStep: 10, milestoneDraws: 1 };
  for (const id of ["a", "b", "c", "d", "e"]) {
    c = recordFollower(c, id, wide).campaign;
  }
  const narrowed = recordFollower(c, "f", { followerStep: 2, milestoneDraws: 1 });
  assertEquals(narrowed.campaign.milestonesReached, 3);
  assertEquals(narrowed.campaign.creditsRemaining, 3);
  assertEquals(narrowed.milestoneCrossed, 3);
});

Deno.test("winnerTier: guaranteed / milestone-era / manual boundaries", () => {
  assertEquals(winnerTier(3, 5, 0, 0), "guaranteed"); // number ≤ firstN
  assertEquals(winnerTier(5, 5, 9, 2), "guaranteed"); // boundary inclusive
  assertEquals(winnerTier(6, 5, 4, 2), "milestone-2"); // pool + credits
  assertEquals(winnerTier(6, 5, 0, 2), "manual"); // pool, no credits
  assertEquals(winnerTier(1, 0, 0, 0), "manual"); // no campaign at all
  assertEquals(winnerTier(9, 0, 1, 0), "milestone-1"); // credits without firstN
});

Deno.test("campaignSummary: queue/pool split, counts, recent winners", () => {
  let pool = emptyPool(true);
  for (const id of ["a", "b", "c", "d"]) {
    pool = addEntrant(pool, entrant(id)).state; // numbers 1..4
  }
  const winners: GiveawayWinner[] = Array.from({ length: 12 }, (_, i) => ({
    userId: `w${i}`,
    login: `w${i}`,
    displayName: `W${i}`,
    number: i + 1,
    enteredAt: 0,
    wonAt: i,
    tier: "guaranteed",
  }));
  const campaign = { ...emptyCampaign(), followerCount: 7, creditsRemaining: 3 };
  const s = campaignSummary(pool, campaign, { firstN: 2 }, winners, true);
  assertEquals(s.guaranteedRemaining, 2); // #1,#2
  assertEquals(s.poolSize, 2); // #3,#4
  assertEquals(s.followerCount, 7);
  assertEquals(s.creditsRemaining, 3);
  assertEquals(s.winnersTotal, 12);
  assertEquals(s.recentWinners.length, 10); // capped at the last 10
  assertEquals(s.recentWinners[9].userId, "w11");
  assertEquals(s.followTracking, true);

  // With firstN off, everyone is "pool".
  const flat = campaignSummary(pool, campaign, { firstN: 0 }, [], false);
  assertEquals(flat.guaranteedRemaining, 0);
  assertEquals(flat.poolSize, 4);
  assertEquals(flat.followTracking, false);
});

Deno.test("decideEligibility: follow gate with fail-closed on unverifiable", () => {
  assertEquals(decideEligibility(false, {}), { eligible: true, reason: "ok" });
  assertEquals(decideEligibility(true, { following: true }), {
    eligible: true,
    reason: "ok",
  });
  assertEquals(decideEligibility(true, { following: false }), {
    eligible: false,
    reason: "not-following",
  });
  // Follow required but couldn't be verified → not eligible (fail closed).
  assertEquals(decideEligibility(true, {}), {
    eligible: false,
    reason: "unverifiable",
  });
});

Deno.test("giveawayMessage: default + custom template substitution", () => {
  const base = baseConfig();
  assert(giveawayMessage(base, "entered", "Bob").includes("Bob"));
  assert(
    giveawayMessage(base, "winner", "Bob").includes(
      DEFAULT_MESSAGES.winner.split("{user}")[1].trim().slice(0, 3),
    ),
  );
  const custom = { ...base, messages: { entered: "hi {user} & {user}!" } };
  assertEquals(giveawayMessage(custom, "entered", "Zed"), "hi Zed & Zed!");
});

Deno.test("giveawayMessage: vars substitution, 3-arg back-compat, new keys", () => {
  const cfg = baseConfig({
    messages: { entered: "#{number} of {goal}, {user}!" },
  });
  assertEquals(
    giveawayMessage(cfg, "entered", "Ann", { number: 42, goal: 500 }),
    "#42 of 500, Ann!",
  );
  // Placeholders with no var pass through untouched; 3-arg calls still work.
  assertEquals(giveawayMessage(cfg, "entered", "Ann"), "#{number} of {goal}, Ann!");
  // The new keys have defaults.
  assert(DEFAULT_MESSAGES.enteredPool.includes("{user}"));
  assert(DEFAULT_MESSAGES.milestone.includes("{draws}"));
  assert(
    giveawayMessage(baseConfig(), "milestone", "X", { count: 100, draws: 10 })
      .includes("10"),
  );
});

Deno.test("demoEntrants: fixed, unique-id batch for reel preview", () => {
  const es = demoEntrants(100);
  assertEquals(es.length, 16); // enough to preview a firstN split
  const ids = new Set(es.map((e) => e.userId));
  assertEquals(ids.size, es.length); // ids are unique (so re-injecting dedupes)
  assert(es.every((e) => e.userId.startsWith("demo-") && e.displayName));
  assertEquals(es[0].enteredAt, 100); // now stamps enteredAt

  // Injecting them into an open pool adds each once; a second inject is a no-op.
  let pool = emptyPool(true);
  for (const e of demoEntrants(0)) pool = addEntrant(pool, e).state;
  const n = pool.entrants.length;
  for (const e of demoEntrants(0)) pool = addEntrant(pool, e).state;
  assertEquals(pool.entrants.length, n);

  // Demo follower ids are stable too (recordFollower dedupes re-runs).
  assertEquals(demoFollowerIds(3), demoFollowerIds(3));
  assertEquals(demoFollowerIds(0), []);
});

Deno.test("parseGiveawayAction: valid actions, remove userId, rejects junk", () => {
  for (
    const action of [
      "open",
      "close",
      "draw",
      "reset",
      "status",
      "demo",
      "winners",
      "campaign-reset",
    ]
  ) {
    const r = parseGiveawayAction(JSON.stringify({ action }));
    assert(r.ok);
    if (r.ok) assertEquals(r.action.action, action);
  }
  const rem = parseGiveawayAction('{"action":"remove","userId":"  42 "}');
  assert(rem.ok);
  if (rem.ok && rem.action.action === "remove") {
    assertEquals(rem.action.userId, "42");
  }

  assert(!parseGiveawayAction('{"action":"remove"}').ok); // missing userId
  assert(!parseGiveawayAction('{"action":"bogus"}').ok);
  assert(!parseGiveawayAction("not json").ok);
  assert(!parseGiveawayAction("[]").ok);
});

Deno.test("serializeGiveawayAction round-trips through parse", () => {
  const actions: GiveawayAction[] = [
    { action: "draw" },
    { action: "winners" },
    { action: "campaign-reset" },
    { action: "remove", userId: "99" },
  ];
  for (const a of actions) {
    const r = parseGiveawayAction(serializeGiveawayAction(a));
    assert(r.ok);
    if (r.ok) assertEquals(r.action, a);
  }
});

Deno.test("normalizePoolState: validates, drops bad entrants, defaults open", () => {
  const good = normalizePoolState({
    open: false,
    nextNumber: 7,
    entrants: [
      { userId: "1", login: "ann", displayName: "Ann", enteredAt: 5, number: 3 },
      { login: "no-id" }, // dropped (no userId)
    ],
    lastWinner: {
      userId: "9",
      login: "z",
      displayName: "Zed",
      enteredAt: 1,
      number: 2,
    },
  });
  // NB: the assert shim compares JSON — keys in construction order.
  assertEquals(good, {
    open: false,
    entrants: [
      { userId: "1", login: "ann", displayName: "Ann", enteredAt: 5, number: 3 },
    ],
    nextNumber: 7,
    lastWinner: {
      userId: "9",
      login: "z",
      displayName: "Zed",
      enteredAt: 1,
      number: 2,
    },
  });

  // Missing displayName falls back to login (then userId).
  const fb = normalizePoolState({ entrants: [{ userId: "7", login: "lg" }] });
  assertEquals(fb?.open, true); // open defaults to true
  assertEquals(fb?.entrants[0].displayName, "lg");

  assertEquals(normalizePoolState({}), null); // no entrants array
  assertEquals(normalizePoolState("nope"), null);
});

Deno.test("normalizePoolState: migrates pre-campaign files (no numbers)", () => {
  // An old giveaway-pool file: no `number` on entrants, no `nextNumber`.
  const s = normalizePoolState({
    open: true,
    entrants: [
      { userId: "a", login: "a", displayName: "A", enteredAt: 1 },
      { userId: "b", login: "b", displayName: "B", enteredAt: 2 },
    ],
  });
  // Append order = entry order → numbered 1, 2; counter continues after.
  assertEquals(s?.entrants.map((e) => e.number), [1, 2]);
  assertEquals(s?.nextNumber, 3);

  // Mixed: real numbers are kept, missing ones are appended after the max.
  const mixed = normalizePoolState({
    entrants: [
      { userId: "x", number: 5 },
      { userId: "y" },
    ],
  });
  assertEquals(mixed?.entrants.map((e) => e.number), [5, 6]);
  assertEquals(mixed?.nextNumber, 7);
});

Deno.test("normalizeCampaignState: defensive on garbage", () => {
  assertEquals(normalizeCampaignState(null), null);
  assertEquals(normalizeCampaignState("x"), null);
  const c = normalizeCampaignState({
    followerCount: 5,
    countedFollowerIds: ["a", "", 3, "b"],
    milestonesReached: -2,
    creditsRemaining: "many",
  });
  assertEquals(c, {
    followerCount: 5,
    countedFollowerIds: ["a", "b"], // empties/non-strings dropped
    milestonesReached: 0, // negative → fallback
    creditsRemaining: 0, // garbage → fallback
  });
});

Deno.test("winners log: JSONL round-trip, corrupt lines skipped, CSV quoting", () => {
  const w1: GiveawayWinner = {
    userId: "1001",
    login: "ann",
    displayName: 'Ann "The Ace", PhD',
    number: 3,
    enteredAt: 1700000000000,
    wonAt: 1700000100000,
    tier: "guaranteed",
  };
  const w2: GiveawayWinner = {
    userId: "1002",
    login: "bo",
    displayName: "Bo",
    number: 7,
    enteredAt: 0,
    wonAt: 0,
    tier: "milestone-1",
  };
  const log = serializeWinnerLine(w1) + "\n" +
    "{ this line is corrupt\n" + // e.g. a crash mid-append
    serializeWinnerLine(w2) + "\n" +
    '{"noUserId":true}\n'; // valid JSON, invalid winner → dropped
  const parsed = parseWinnersLog(log);
  assertEquals(parsed, [w1, w2]);

  const csv = winnersToCsv(parsed);
  const lines = csv.trimEnd().split("\n");
  assertEquals(lines.length, 3); // header + 2 rows
  assertEquals(lines[0], "number,displayName,login,userId,tier,enteredAt,wonAt");
  // Comma+quote display name is RFC-4180 quoted with doubled quotes.
  assert(lines[1].includes('"Ann ""The Ace"", PhD"'));
  assert(lines[1].includes("2023-")); // ISO timestamp
  assert(lines[2].endsWith(",,")); // zero timestamps render empty
});

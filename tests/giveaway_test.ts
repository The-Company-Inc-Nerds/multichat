import {
  addEntrant,
  closePool,
  decideEligibility,
  DEFAULT_MESSAGES,
  demoEntrants,
  drawWinner,
  emptyPool,
  type GiveawayAction,
  giveawayMessage,
  hasEntrant,
  matchGiveawayCommand,
  normalizeGiveawayConfig,
  normalizePoolState,
  openPool,
  parseGiveawayAction,
  removeEntrant,
  resetPool,
  serializeGiveawayAction,
} from "../src/giveaway.ts";
import type { GiveawayConfig, GiveawayEntrant } from "../src/types.ts";
import { assert, assertEquals } from "./_assert.ts";

const entrant = (userId: string, name = userId): GiveawayEntrant => ({
  userId,
  login: name.toLowerCase(),
  displayName: name,
  enteredAt: 0,
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
    messages: { entered: "hi {user}", bogus: 5, winner: "  " },
  });
  assertEquals(c.enabled, true);
  assertEquals(c.channel, "streamerone");
  assertEquals(c.prefix, "?");
  assertEquals(c.command, "join");
  assertEquals(c.requireFollow, false);
  assertEquals(c.replies, false);
  // Only known, non-blank string templates survive.
  assertEquals(c.messages, { entered: "hi {user}" });
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

  const last = drawWinner(pool, () => 0.999); // clamps to last idx
  assertEquals(last.winner?.userId, "c");
});

Deno.test("drawWinner: empty pool returns null, never throws", () => {
  const r = drawWinner(emptyPool(true), () => 0.5);
  assertEquals(r.winner, null);
  assertEquals(r.state.entrants.length, 0);
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
  const base: GiveawayConfig = {
    enabled: true,
    channel: "c",
    prefix: "!",
    command: "enter",
    requireFollow: true,
    replies: true,
  };
  assert(giveawayMessage(base, "entered", "Bob").includes("Bob"));
  assert(
    giveawayMessage(base, "winner", "Bob").includes(
      DEFAULT_MESSAGES.winner.split("{user}")[1].trim().slice(0, 3),
    ),
  );
  const custom = { ...base, messages: { entered: "hi {user} & {user}!" } };
  assertEquals(giveawayMessage(custom, "entered", "Zed"), "hi Zed & Zed!");
});

Deno.test("demoEntrants: fixed, unique-id batch for wheel preview", () => {
  const es = demoEntrants(100);
  assert(es.length >= 4);
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
});

Deno.test("parseGiveawayAction: valid actions, remove userId, rejects junk", () => {
  for (const action of ["open", "close", "draw", "reset", "status", "demo"]) {
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
    entrants: [
      { userId: "1", login: "ann", displayName: "Ann", enteredAt: 5 },
      { login: "no-id" }, // dropped (no userId)
    ],
    lastWinner: { userId: "9", login: "z", displayName: "Zed", enteredAt: 1 },
  });
  assertEquals(good, {
    open: false,
    entrants: [{ userId: "1", login: "ann", displayName: "Ann", enteredAt: 5 }],
    lastWinner: { userId: "9", login: "z", displayName: "Zed", enteredAt: 1 },
  });

  // Missing displayName falls back to login (then userId).
  const fb = normalizePoolState({ entrants: [{ userId: "7", login: "lg" }] });
  assertEquals(fb?.open, true); // open defaults to true
  assertEquals(fb?.entrants[0].displayName, "lg");

  assertEquals(normalizePoolState({}), null); // no entrants array
  assertEquals(normalizePoolState("nope"), null);
});

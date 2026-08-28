import {
  activeTurn,
  buildTurnReport,
  computeAggregates,
  findTurn,
  formatInZone,
  hasAccepted,
  matchDisposition,
  newTurn,
  normalizeTermsLedger,
  normalizeTurns,
  recordAcceptance,
  recordTurnDisposition,
  reportToCsv,
  serializeTermsLedger,
  serializeTurns,
  turnPacks,
  turnTotals,
} from "../src/turns.ts";
import type {
  GiveawayDispositionConfig,
  GiveawayEntrant,
  GiveawayTurn,
  PackReport,
  TermsAcceptance,
} from "../src/types.ts";
import { assert, assertEquals } from "./_assert.ts";

const dispCfg = (
  over: Partial<GiveawayDispositionConfig> = {},
): GiveawayDispositionConfig => ({
  enabled: true,
  mail: "mail",
  donate: "donate",
  destroy: "destroy",
  pass: "pass",
  ...over,
});

const entrant = (
  userId: string,
  name = userId,
  number = 1,
): GiveawayEntrant => ({
  userId,
  login: name.toLowerCase(),
  displayName: name,
  enteredAt: 0,
  number,
});

const pack = (
  packId: string,
  ref: string,
  cardCount: number,
  totalValue: number,
): PackReport => ({
  packId,
  ref,
  openedAt: 1,
  totalValue,
  cardCount,
  cards: [],
  receivedAt: 1,
});

// ---- matchDisposition ----------------------------------------------------

Deno.test("matchDisposition: bare word, prefixed, first-token only", () => {
  const cfg = dispCfg();
  assertEquals(matchDisposition("mail", "!", cfg), "mail");
  assertEquals(matchDisposition("!mail", "!", cfg), "mail"); // prefix stripped
  assertEquals(matchDisposition("MAIL it", "!", cfg), "mail"); // case + first token
  assertEquals(matchDisposition("pass it on", "!", cfg), "pass"); // multi-word
  assertEquals(matchDisposition("donate", "!", cfg), "donate");
  assertEquals(matchDisposition("destroy", "!", cfg), "destroy");
  assertEquals(matchDisposition("hello", "!", cfg), null);
  assertEquals(matchDisposition("mailbox", "!", cfg), null); // whole token only
});

Deno.test("matchDisposition: disabled config matches nothing, custom words", () => {
  assertEquals(
    matchDisposition("mail", "!", dispCfg({ enabled: false })),
    null,
  );
  const custom = dispCfg({ mail: "keep", pass: "next" });
  assertEquals(matchDisposition("keep", "!", custom), "mail");
  assertEquals(matchDisposition("next please", "!", custom), "pass");
  assertEquals(matchDisposition("mail", "!", custom), null); // old word no longer maps
});

// ---- terms ledger --------------------------------------------------------

Deno.test("terms ledger: accept, version gating, dedup, persistence", () => {
  let ledger: Record<string, TermsAcceptance> = {};
  const who = { userId: "1", login: "ann", displayName: "Ann" };

  assert(!hasAccepted(ledger, "1", "1"));
  const r1 = recordAcceptance(ledger, who, "1", 100);
  assert(r1.changed);
  ledger = r1.ledger;
  assert(hasAccepted(ledger, "1", "1"));
  assertEquals(ledger["1"].acceptedAt, 100);

  // Re-accepting the same version is a no-op (changed:false).
  const r2 = recordAcceptance(ledger, who, "1", 200);
  assert(!r2.changed);
  assertEquals(r2.ledger["1"].acceptedAt, 100); // unchanged

  // A bumped version invalidates the old acceptance and re-accepts.
  assert(!hasAccepted(ledger, "1", "2"));
  const r3 = recordAcceptance(ledger, who, "2", 300);
  assert(r3.changed);
  assert(hasAccepted(r3.ledger, "1", "2"));

  // Round-trips through serialize/normalize; junk entries dropped.
  const restored = normalizeTermsLedger(
    JSON.parse(serializeTermsLedger(r3.ledger)),
  );
  assert(hasAccepted(restored, "1", "2"));
  assertEquals(normalizeTermsLedger("garbage"), {});
  assertEquals(normalizeTermsLedger({ x: { login: "no-id" } }), {}); // no userId → dropped
});

// ---- turn records --------------------------------------------------------

Deno.test("newTurn / recordTurnDisposition / activeTurn / findTurn", () => {
  let turns: GiveawayTurn[] = [];
  turns = [
    ...turns,
    newTurn({
      id: "A",
      winner: entrant("1", "Ann", 3),
      tier: "guaranteed",
      now: 10,
    }),
  ];
  assertEquals(turns[0].displayName, "Ann");
  assertEquals(turns[0].number, 3);
  assertEquals(activeTurn(turns)?.id, "A"); // not yet ended

  const res = recordTurnDisposition(turns, "A", "mail", 20);
  turns = res.turns;
  assertEquals(res.turn?.disposition, "mail");
  assertEquals(turns[0].endedAt, 20);
  assertEquals(activeTurn(turns), undefined); // ended → no active turn

  // A carried turn links back; the newer un-ended turn is active.
  turns = [
    ...turns,
    newTurn({
      id: "B",
      winner: entrant("2", "Bo", 4),
      tier: "manual",
      now: 30,
      carriedFromTurnId: "A",
    }),
  ];
  assertEquals(activeTurn(turns)?.id, "B");
  assertEquals(findTurn(turns, "B")?.carriedFromTurnId, "A");
  assertEquals(findTurn(turns, "nope"), undefined);

  // Disposition on a missing id is a no-op (turn:null).
  assertEquals(recordTurnDisposition(turns, "zzz", "mail", 40).turn, null);
});

Deno.test("normalizeTurns: validates, drops junk, keeps only valid dispositions", () => {
  const turns = normalizeTurns([
    {
      id: "A",
      userId: "1",
      login: "ann",
      displayName: "Ann",
      number: 1,
      tier: "guaranteed",
      startedAt: 5,
      disposition: "mail",
      dispositionAt: 6,
      endedAt: 6,
    },
    { id: "B", userId: "2", disposition: "bogus" }, // invalid disposition dropped, rest defaulted
    { login: "no-id" }, // dropped (no id/userId)
  ]);
  assertEquals(turns.length, 2);
  assertEquals(turns[0].disposition, "mail");
  assertEquals(turns[1].disposition, undefined); // "bogus" not a valid disposition
  assertEquals(turns[1].displayName, "2"); // falls back to userId
  const round = normalizeTurns(JSON.parse(serializeTurns(turns)));
  assertEquals(round, turns);
  assertEquals(normalizeTurns("nope"), []);
});

// ---- aggregates + carry chain --------------------------------------------

Deno.test("computeAggregates: mail/donate/destroy totals, pass carry chain", () => {
  // A passes (2 cards, $10) → B; B mails (own 3 cards, $5). C donates (1, $4).
  const turns: GiveawayTurn[] = [
    {
      id: "A",
      userId: "1",
      login: "a",
      displayName: "A",
      number: 1,
      tier: "g",
      startedAt: 1,
      disposition: "pass",
      dispositionAt: 2,
      endedAt: 2,
    },
    {
      id: "B",
      userId: "2",
      login: "b",
      displayName: "B",
      number: 2,
      tier: "g",
      startedAt: 3,
      disposition: "mail",
      dispositionAt: 4,
      endedAt: 4,
      carriedFromTurnId: "A",
    },
    {
      id: "C",
      userId: "3",
      login: "c",
      displayName: "C",
      number: 3,
      tier: "g",
      startedAt: 5,
      disposition: "donate",
      dispositionAt: 6,
      endedAt: 6,
    },
  ];
  const packs: Record<string, PackReport> = {
    pA: pack("pA", "A", 2, 10),
    pB: pack("pB", "B", 3, 5),
    pC: pack("pC", "C", 1, 4),
  };

  // turnPacks(B) folds in A's passed pack.
  const byRef: Record<string, PackReport[]> = { A: [packs.pA], B: [packs.pB] };
  const bPacks = turnPacks("B", { A: turns[0], B: turns[1] }, byRef);
  assertEquals(bPacks.map((p) => p.packId), ["pB", "pA"]);

  const totals = turnTotals("B", turns, packs);
  assertEquals(totals.cards, 5); // 3 own + 2 carried
  assertEquals(totals.value, 15);

  const agg = computeAggregates(turns, packs);
  // B mailed the whole haul (its own + A's carried).
  assertEquals(agg.mailed, { turns: 1, cards: 5, value: 15 });
  assertEquals(agg.donated, { turns: 1, cards: 1, value: 4 });
  assertEquals(agg.destroyed, { turns: 0, cards: 0, value: 0 });
  // The pass itself is tallied (its own forfeited cards) — informational.
  assertEquals(agg.passed, { turns: 1, cards: 2, value: 10 });
});

Deno.test("formatInZone: renders in-zone, DST-aware, ISO fallback", () => {
  const jan = Date.UTC(2026, 0, 15, 19, 0, 0);
  const aug = Date.UTC(2026, 7, 15, 18, 0, 0);
  const j = formatInZone(jan, "America/Denver");
  const a = formatInZone(aug, "America/Denver");
  assert(j.includes("2026"));
  assert(j.includes("MST")); // winter → Mountain Standard
  assert(a.includes("MDT")); // summer → Mountain Daylight
  assertEquals(formatInZone(0, "America/Denver"), ""); // no timestamp
  assert(formatInZone(jan, "Not/AZone").includes("2026-01")); // bad zone → ISO
});

Deno.test("buildTurnReport / reportToCsv: own cards, carry links, MST", () => {
  const cardPack = (
    packId: string,
    ref: string,
    cards: { name: string; value: number }[],
  ): PackReport => ({
    packId,
    ref,
    openedAt: 1,
    totalValue: Math.round(cards.reduce((s, c) => s + c.value, 0) * 100) / 100,
    cardCount: cards.length,
    cards,
    receivedAt: 1,
  });
  const turns: GiveawayTurn[] = [
    {
      id: "A",
      userId: "1",
      login: "ann",
      displayName: "Ann",
      number: 1,
      tier: "guaranteed",
      startedAt: Date.UTC(2026, 7, 15, 18, 0, 0),
      disposition: "pass",
      dispositionAt: 1,
      endedAt: 1,
    },
    {
      id: "B",
      userId: "2",
      login: "bo",
      displayName: "Bo",
      number: 2,
      tier: "guaranteed",
      startedAt: Date.UTC(2026, 7, 15, 18, 5, 0),
      disposition: "mail",
      dispositionAt: 2,
      endedAt: 2,
      carriedFromTurnId: "A",
    },
  ];
  const packs: Record<string, PackReport> = {
    pA: cardPack("pA", "A", [{ name: "Charizard", value: 8 }, {
      name: "Pikachu",
      value: 2,
    }]),
    pB: cardPack("pB", "B", [{ name: "Bulbasaur", value: 5 }]),
  };
  const rows = buildTurnReport(turns, packs, "America/Denver");
  assertEquals(rows.length, 2);
  // Row A: its own pack; it passed to Bo.
  assertEquals(rows[0].displayName, "Ann");
  assertEquals(rows[0].disposition, "pass");
  assertEquals(rows[0].cardCount, 2);
  assertEquals(rows[0].totalValue, 10);
  assertEquals(rows[0].cardNames, ["Charizard", "Pikachu"]);
  assertEquals(rows[0].passedTo, "Bo");
  assertEquals(rows[0].carriedFrom, undefined);
  assert(rows[0].startedLocal.includes("MDT"));
  // Row B: report rows show OWN cards only (carry folds into aggregates), and it
  // received a pass from Ann.
  assertEquals(rows[1].cardCount, 1);
  assertEquals(rows[1].totalValue, 5);
  assertEquals(rows[1].carriedFrom, "Ann");
  assertEquals(rows[1].passedTo, undefined);

  const lines = reportToCsv(rows).trimEnd().split("\n");
  assertEquals(lines.length, 3); // header + 2 rows
  assert(lines[0].startsWith("number,displayName,login,userId,tier,startedAt"));
  assert(lines[0].includes("passedTo"));
  assert(lines[1].includes("Charizard; Pikachu")); // cards joined
});

Deno.test("computeAggregates: value rounding, no-disposition turns ignored", () => {
  const turns: GiveawayTurn[] = [
    {
      id: "A",
      userId: "1",
      login: "a",
      displayName: "A",
      number: 1,
      tier: "g",
      startedAt: 1,
      disposition: "mail",
      dispositionAt: 2,
      endedAt: 2,
    },
    {
      id: "B",
      userId: "2",
      login: "b",
      displayName: "B",
      number: 2,
      tier: "g",
      startedAt: 3,
    }, // in progress → ignored
  ];
  const packs: Record<string, PackReport> = {
    pA: pack("pA", "A", 1, 3.333),
    pB: pack("pB", "B", 1, 99), // belongs to the in-progress turn → not counted
  };
  const agg = computeAggregates(turns, packs);
  assertEquals(agg.mailed, { turns: 1, cards: 1, value: 3.33 }); // rounded
});

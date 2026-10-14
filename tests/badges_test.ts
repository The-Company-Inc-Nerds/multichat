import {
  type BadgeArt,
  badgeLabel,
  cdnBadgeArt,
  decorateBadge,
  resolveBadgeArt,
  SNAPSHOT_BADGES,
  snapshotArt,
} from "../src/badges.ts";
import { GLOBAL_BADGES } from "../src/twitchbadges.ts";
import { assert, assertEquals } from "./_assert.ts";

const art = (title: string): BadgeArt => ({
  title,
  url: `https://example.test/${title}/1`,
  url2x: `https://example.test/${title}/2`,
  url4x: `https://example.test/${title}/3`,
});

const SNAP_CDN = "https://static-cdn.jtvnw.net/badges/v1/";

Deno.test("GLOBAL_BADGES: the full snapshot, well-formed set/version keys + uuids", () => {
  const keys = Object.keys(GLOBAL_BADGES);
  assertEquals(keys.length, 317);
  for (const k of keys) {
    assert(/^[^/]+\/[^/]+$/.test(k), `bad key: ${k}`);
    const [uuid, title] = GLOBAL_BADGES[k];
    assert(/^[0-9a-f-]{36}$/.test(uuid), `bad uuid for ${k}: ${uuid}`);
    assertEquals(typeof title, "string");
  }
});

Deno.test("snapshotArt: spot-checks against Twitch's global badge art", () => {
  assertEquals(
    snapshotArt("moderator", "1")?.url,
    `${SNAP_CDN}3267646d-33f0-4b17-b3df-f923a41db1d0/1`,
  );
  assertEquals(
    snapshotArt("broadcaster", "1")?.url2x,
    `${SNAP_CDN}5527c58c-fb7d-422d-b71b-f309dcb85cc1/2`,
  );
  assertEquals(
    snapshotArt("vip", "1")?.url4x,
    `${SNAP_CDN}b817aba4-fad8-49e2-b88a-7cc744dfa6ec/3`,
  );
  assertEquals(snapshotArt("partner", "1")?.title, "Verified");
  // Misses, including names that only exist on Object.prototype.
  assertEquals(snapshotArt("moderator", "2"), undefined);
  assertEquals(snapshotArt("nosuchset", "1"), undefined);
  assertEquals(snapshotArt("constructor", ""), undefined);
});

Deno.test("cdnBadgeArt: the 1x/2x/4x sizes are the CDN's /1 /2 /3", () => {
  assertEquals(cdnBadgeArt("abc", "T"), {
    title: "T",
    url: `${SNAP_CDN}abc/1`,
    url2x: `${SNAP_CDN}abc/2`,
    url4x: `${SNAP_CDN}abc/3`,
  });
});

Deno.test("resolveBadgeArt: channel exact, then Helix global, then snapshot", () => {
  const channel = new Map([["subscriber/12", art("chan-12")]]);
  const helix = new Map([["moderator/1", art("helix-mod")]]);
  assertEquals(
    resolveBadgeArt("subscriber", "12", channel, helix)?.title,
    "chan-12",
  );
  // Live Helix data wins over the built-in snapshot…
  assertEquals(
    resolveBadgeArt("moderator", "1", channel, helix)?.title,
    "helix-mod",
  );
  // …and the snapshot covers what Helix hasn't supplied (or with no Helix).
  assertEquals(resolveBadgeArt("vip", "1", channel, helix)?.title, "VIP");
  assertEquals(resolveBadgeArt("vip", "1")?.title, "VIP");
  // A channel badge beats a global one for the same key.
  const both = new Map([["vip/1", art("chan-vip")]]);
  assertEquals(resolveBadgeArt("vip", "1", both, helix)?.title, "chan-vip");
});

Deno.test("resolveBadgeArt: subscriber falls to the channel's nearest lower version in the same tier", () => {
  const channel = new Map([
    ["subscriber/0", art("t1-0")],
    ["subscriber/3", art("t1-3")],
    ["subscriber/12", art("t1-12")],
    ["subscriber/2000", art("t2-0")],
    ["subscriber/2006", art("t2-6")],
    ["subscriber/3024", art("t3-24")],
  ]);
  assertEquals(resolveBadgeArt("subscriber", "14", channel)?.title, "t1-12");
  assertEquals(resolveBadgeArt("subscriber", "5", channel)?.title, "t1-3");
  // Tier 2 never borrows Tier 1 art, even when Tier 1 has a closer version.
  assertEquals(resolveBadgeArt("subscriber", "2012", channel)?.title, "t2-6");
  // Nothing at or below 3012 in Tier 3 (only 3024): the same months in the
  // channel's Tier 1 art, as Twitch shows it.
  assertEquals(resolveBadgeArt("subscriber", "3012", channel)?.title, "t1-12");
});

Deno.test("resolveBadgeArt: Tier 2/3 subs fall back to the channel's Tier 1 art", () => {
  // A channel that uploaded only Tier 1 badges: Twitch shows them to Tier 2/3.
  const tier1 = new Map([
    ["subscriber/0", art("t1-0")],
    ["subscriber/6", art("t1-6")],
    ["subscriber/12", art("t1-12")],
  ]);
  assertEquals(resolveBadgeArt("subscriber", "2014", tier1)?.title, "t1-12");
  assertEquals(resolveBadgeArt("subscriber", "3003", tier1)?.title, "t1-0");
  assertEquals(resolveBadgeArt("subscriber", "3000", tier1)?.title, "t1-0");
  // Tier-specific art still wins, even over a closer Tier 1 version.
  const withT2 = new Map([...tier1, ["subscriber/2000", art("t2-0")]]);
  assertEquals(resolveBadgeArt("subscriber", "2012", withT2)?.title, "t2-0");
  assertEquals(resolveBadgeArt("subscriber", "3012", withT2)?.title, "t1-12");
  // No Tier 1 art at or below the months either: the generic badge.
  const late = new Map([["subscriber/6", art("t1-6")]]);
  assertEquals(
    resolveBadgeArt("subscriber", "2003", late)?.url,
    snapshotArt("subscriber", "0")?.url,
  );
  // A Tier 1 badge with nothing at or below in the channel: the generic one.
  assertEquals(
    resolveBadgeArt("subscriber", "3", late)?.url,
    snapshotArt("subscriber", "0")?.url,
  );
});

Deno.test("resolveBadgeArt: generic subscriber/founder fallback, Helix before snapshot", () => {
  const helix = new Map([["subscriber/0", art("helix-sub")]]);
  assertEquals(
    resolveBadgeArt("subscriber", "3012", undefined, helix)?.title,
    "helix-sub",
  );
  const generic = resolveBadgeArt("subscriber", "3012");
  assertEquals(generic?.url, snapshotArt("subscriber", "0")?.url);
  assertEquals(
    resolveBadgeArt("founder", "7")?.url,
    snapshotArt("founder", "0")?.url,
  );
  // Global sub versions number Twitch's default art in sequence, not by
  // months ("subscriber/4" is the 6-month badge), so an IRC month version is
  // never looked up there: with no channel art every sub gets the generic one.
  for (const months of ["3", "4", "6", "12", "24"]) {
    assertEquals(
      resolveBadgeArt("subscriber", months)?.url,
      snapshotArt("subscriber", "0")?.url,
    );
  }
  // The same holds for Helix's live global list.
  const helixSeq = new Map([["subscriber/4", art("helix-6mo")]]);
  assertEquals(
    resolveBadgeArt("subscriber", "4", undefined, helixSeq)?.url,
    snapshotArt("subscriber", "0")?.url,
  );
});

Deno.test("resolveBadgeArt: bits prefer the global gem over a lower custom tier", () => {
  const channel = new Map([
    ["bits/1", art("chan-1")],
    ["bits/100", art("chan-100")],
  ]);
  assertEquals(resolveBadgeArt("bits", "100", channel)?.title, "chan-100");
  // The channel customised only bits/1: Twitch shows its global bits/1000.
  const onlyOne = new Map([["bits/1", art("chan-1")]]);
  assertEquals(
    resolveBadgeArt("bits", "1000", onlyOne)?.url,
    snapshotArt("bits", "1000")?.url,
  );
  // A tier no global list knows: the channel's nearest lower one.
  assertEquals(resolveBadgeArt("bits", "150", channel)?.title, "chan-100");
});

Deno.test("resolveBadgeArt: unknown sets and versions are a text chip (undefined)", () => {
  assertEquals(resolveBadgeArt("nosuchset", "1"), undefined);
  assertEquals(resolveBadgeArt("moderator", "9"), undefined);
  // Non-numeric versions resolve exactly, and never by nearest-lower.
  assertEquals(
    resolveBadgeArt("predictions", "blue-1")?.url.startsWith(SNAP_CDN),
    true,
  );
  assertEquals(resolveBadgeArt("predictions", "blue-99"), undefined);
});

Deno.test("SNAPSHOT_BADGES: snapshot-only, whatever the room", () => {
  assertEquals(
    SNAPSHOT_BADGES.resolve("12345", "moderator", "1")?.url,
    snapshotArt("moderator", "1")?.url,
  );
  assertEquals(SNAPSHOT_BADGES.resolve(undefined, "nosuchset", "1"), undefined);
  assertEquals(SNAPSHOT_BADGES.noteRoom, undefined);
});

Deno.test("badgeLabel: short labels for the common sets (unchanged ones kept)", () => {
  const cases: Array<[string, string]> = [
    ["broadcaster", "Broadcaster"],
    ["moderator", "Mod"],
    ["lead_moderator", "Lead Mod"],
    ["vip", "VIP"],
    ["partner", "Verified"],
    ["staff", "Staff"],
    ["admin", "Admin"],
    ["global_mod", "Global Mod"],
    ["turbo", "Turbo"],
    ["premium", "Prime"],
    ["founder", "Founder"],
    ["artist-badge", "Artist"],
    ["no_audio", "No Audio"],
    ["no_video", "No Video"],
    ["subscriber", "Sub"],
  ];
  for (const [set, label] of cases) assertEquals(badgeLabel(set, "1"), label);
});

Deno.test("badgeLabel: sub tier + months, bits and gift counts", () => {
  assertEquals(badgeLabel("subscriber", "12"), "Sub");
  assertEquals(badgeLabel("subscriber", "12", "14"), "Sub · 14 mo");
  assertEquals(badgeLabel("subscriber", "2003"), "T2 Sub");
  assertEquals(badgeLabel("subscriber", "3012", "14"), "T3 Sub · 14 mo");
  assertEquals(badgeLabel("founder", "0", "9"), "Founder · 9 mo");
  assertEquals(badgeLabel("subscriber", "0", "not-a-number"), "Sub");
  assertEquals(badgeLabel("bits", "1000"), "Bits 1000");
  assertEquals(badgeLabel("bits"), "Bits");
  assertEquals(badgeLabel("sub-gifter", "50"), "Gifter 50");
});

Deno.test("badgeLabel: unknown sets get a prettified id, not the raw one", () => {
  assertEquals(badgeLabel("someunknown", "1"), "Someunknown");
  assertEquals(badgeLabel("glhf-pledge", "1"), "Glhf Pledge");
  assertEquals(badgeLabel("hype-train", "2"), "Hype Train");
  assertEquals(badgeLabel("60-seconds_1", "1"), "60 Seconds"); // trailing "1" dropped
  assertEquals(badgeLabel("bits-leader", "1"), "Bits Leader");
  assertEquals(badgeLabel("_", "1"), "_");
  // An Object.prototype name is an unknown set, not a lookup hit.
  assertEquals(badgeLabel("constructor"), "Constructor");
});

Deno.test("decorateBadge: art supplies the urls and Twitch's title; the short label stays", () => {
  const mod = decorateBadge(
    { id: "moderator", label: "Mod", version: "1" },
    art("Moderator"),
  );
  assertEquals(mod, {
    id: "moderator", // the bare set id survives: the page keys colours on it
    label: "Mod", // the chip text if the art fails to load
    version: "1",
    url: "https://example.test/Moderator/1",
    url2x: "https://example.test/Moderator/2",
    url4x: "https://example.test/Moderator/3",
    title: "Moderator",
  });
});

Deno.test("decorateBadge: sub/founder titles gain the exact months", () => {
  const sub = decorateBadge(
    { id: "subscriber", label: "T3 Sub · 14 mo", version: "3012", info: "14" },
    art("Subscriber"),
  );
  assertEquals(sub.title, "Subscriber (14 months)");
  assertEquals(sub.label, "T3 Sub · 14 mo"); // the chip keeps the tier
  const year = decorateBadge(
    { id: "subscriber", label: "Sub · 14 mo", version: "12", info: "14" },
    art("1-Year Subscriber"),
  );
  assertEquals(year.title, "1-Year Subscriber (14 months)");
  const one = decorateBadge(
    { id: "founder", label: "Founder · 1 mo", version: "0", info: "1" },
    art("Founder"),
  );
  assertEquals(one.title, "Founder (1 month)");
  // Prediction info isn't a month count.
  const pred = decorateBadge(
    { id: "predictions", label: "Predictions", info: "Blue" },
    art("Blue 1"),
  );
  assertEquals(pred.title, "Blue 1");
  assertEquals(pred.label, "Predictions");
});

Deno.test("decorateBadge: no art leaves the badge as is; an untitled art adds no title", () => {
  const b = { id: "x", label: "X" };
  assertEquals(decorateBadge(b, undefined), b);
  const untitled = decorateBadge(b, { ...art("ignored"), title: "" });
  assertEquals(untitled.label, "X");
  assertEquals(untitled.title, undefined);
  assertEquals(untitled.url, "https://example.test/ignored/1");
});

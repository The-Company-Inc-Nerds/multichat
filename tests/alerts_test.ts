import { ALERT_EVENT_KINDS, normalizeAlertsConfig } from "../src/alerts.ts";
import { assert, assertEquals } from "./_assert.ts";

Deno.test("normalizeAlertsConfig: a valid registry round-trips", () => {
  const cfg = normalizeAlertsConfig({
    activeTheme: "The Company, Inc",
    themes: [
      {
        name: "The Company, Inc",
        style: "company-memo",
        events: ["follow"],
        options: { paper: "#f6f1e0", redact: true, hold: 5000 },
      },
    ],
  });
  assertEquals(cfg.activeTheme, "The Company, Inc");
  assertEquals(cfg.themes?.length, 1);
  const t = cfg.themes![0];
  assertEquals(t.name, "The Company, Inc");
  assertEquals(t.style, "company-memo");
  assertEquals(t.events, ["follow"]);
  assertEquals(t.options, { paper: "#f6f1e0", redact: true, hold: 5000 });
});

Deno.test("normalizeAlertsConfig: themes without a name are dropped", () => {
  const cfg = normalizeAlertsConfig({
    themes: [{ style: "company-memo" }, { name: "  " }, { name: "Ok" }],
  });
  assertEquals(cfg.themes?.length, 1);
  assertEquals(cfg.themes![0].name, "Ok");
});

Deno.test("normalizeAlertsConfig: style defaults to 'default'", () => {
  const cfg = normalizeAlertsConfig({ themes: [{ name: "Plain" }] });
  assertEquals(cfg.themes![0].style, "default");
});

Deno.test("normalizeAlertsConfig: unknown event kinds are filtered out", () => {
  const cfg = normalizeAlertsConfig({
    themes: [{ name: "T", style: "x", events: ["follow", "chat", "nope"] }],
  });
  // 'chat'/'nope' aren't shoutout kinds → dropped; only 'follow' survives.
  assertEquals(cfg.themes![0].events, ["follow"]);
});

Deno.test("normalizeAlertsConfig: an all-invalid events list is omitted (theme covers all)", () => {
  const cfg = normalizeAlertsConfig({
    themes: [{ name: "T", events: ["chat", "system"] }],
  });
  assertEquals(cfg.themes![0].events, undefined);
});

Deno.test("normalizeAlertsConfig: options keep only string/number/bool values", () => {
  const cfg = normalizeAlertsConfig({
    themes: [{
      name: "T",
      options: { a: "x", b: 2, c: true, d: { nested: 1 }, e: [1], f: null },
    }],
  });
  assertEquals(cfg.themes![0].options, { a: "x", b: 2, c: true });
});

Deno.test("normalizeAlertsConfig: junk input yields an empty (default) config", () => {
  assertEquals(normalizeAlertsConfig(undefined), {});
  assertEquals(normalizeAlertsConfig(null), {});
  assertEquals(normalizeAlertsConfig("nope"), {});
  assertEquals(normalizeAlertsConfig({ themes: "no" }), {});
  // activeTheme with no themes is still carried (overlay falls back to default look).
  assertEquals(normalizeAlertsConfig({ activeTheme: "X" }), {
    activeTheme: "X",
  });
});

Deno.test("ALERT_EVENT_KINDS: the shoutout set, excluding chat/action/system", () => {
  assert(ALERT_EVENT_KINDS.includes("follow"));
  assert(ALERT_EVENT_KINDS.includes("cheer"));
  assert(!(ALERT_EVENT_KINDS as readonly string[]).includes("chat"));
  assert(!(ALERT_EVENT_KINDS as readonly string[]).includes("system"));
});

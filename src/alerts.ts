// Pure helpers for the /alerts overlay theming. The registry comes from
// settings.json (operator-controlled) and is injected into the served page as
// `window.MULTICHAT_ALERTS`; the overlay's JS switches its rendering on the active
// theme. Everything here is side-effect-free so the test suite can drive it, and
// so the server can normalize once at startup — matching the project's "pure logic
// in src/, wiring elsewhere" split (see control.ts / fake.ts).

import type { AlertsConfig, AlertTheme, MessageKind } from "./types.ts";

/** The shoutout kinds the /alerts overlay pops up. Also the default `events` set
 *  for a theme, and the overlay's ALERT_KINDS. Kept here so server and config
 *  agree on one list. `chat`/`action`/`system` are intentionally excluded. */
export const ALERT_EVENT_KINDS: readonly MessageKind[] = [
  "cheer",
  "sub",
  "raid",
  "follow",
  "superchat",
  "supersticker",
  "membership",
];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function normalizeOptions(
  x: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!isObj(x)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(x)) {
    if (
      typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ) {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeTheme(x: unknown): AlertTheme | null {
  if (!isObj(x)) return null;
  const name = typeof x.name === "string" ? x.name.trim() : "";
  if (!name) return null; // a theme must be selectable by name
  const theme: AlertTheme = {
    name,
    style: typeof x.style === "string" && x.style.trim()
      ? x.style.trim()
      : "default",
  };
  if (Array.isArray(x.events)) {
    const events = x.events.filter(
      (e): e is MessageKind =>
        typeof e === "string" &&
        (ALERT_EVENT_KINDS as readonly string[]).includes(e),
    );
    if (events.length) theme.events = events;
  }
  const options = normalizeOptions(x.options);
  if (options) theme.options = options;
  return theme;
}

/**
 * Validate/normalize the raw `alerts` config from settings.json into a clean
 * `AlertsConfig`. Unparseable input yields an empty config (the default look).
 * Themes without a `name` are dropped; unknown event kinds are filtered out;
 * `style` defaults to "default".
 */
export function normalizeAlertsConfig(raw: unknown): AlertsConfig {
  if (!isObj(raw)) return {};
  const themes: AlertTheme[] = [];
  if (Array.isArray(raw.themes)) {
    for (const t of raw.themes) {
      const norm = normalizeTheme(t);
      if (norm) themes.push(norm);
    }
  }
  const config: AlertsConfig = {};
  if (typeof raw.activeTheme === "string" && raw.activeTheme.trim()) {
    config.activeTheme = raw.activeTheme.trim();
  }
  if (themes.length) config.themes = themes;
  return config;
}

// GET /api/status: one place that says what the server is doing right now —
// which YouTube key it runs on, where the day's quota stands and why detection
// is held back if it is, what each channel's poller last did, and whether
// Twitch EventSub has a token and its subscriptions. Everything an operator
// otherwise has to piece together from the journal.
//
// Pure, like the rest of src/: the shapes, the assembly of the response from
// its sources, and the text `multichat status` prints. The route is in
// server.ts; the live sources (key manager, EventSub manager) are in main.ts.
// Nothing here may carry key material: a key appears only as its one-way
// fingerprint (keyFingerprint in youtube.ts).

import type { ChannelState, ChannelStatus } from "./types.ts";
import {
  type ChannelReport,
  formatDuration,
  type YouTubeRuntimeStatus,
} from "./youtube.ts";

/** The package version (build.nix reads it from this line — keep its form). */
export const VERSION = "0.1.0";

/** Where the YouTube key in use came from: the runtime key persisted in the
 *  state dir, YOUTUBE_API_KEY, settings.json, or `set-youtube-key` during
 *  this run. */
export type YouTubeKeySource =
  | "persisted"
  | "environment"
  | "settings"
  | "runtime";

export interface YouTubeStatus {
  /** YouTube channels in settings. */
  configured: number;
  key: {
    present: boolean;
    source: YouTubeKeySource | null;
    fingerprint: string | null;
    /** Set after the server left a refused runtime key for the declared one. */
    note: string | null;
  };
  /** A poller generation is running. */
  polling: boolean;
  /** Today's ledger; null until a poller has run (it loads the ledger). */
  quota: YouTubeRuntimeStatus["quota"] | null;
  /** Why live detection is held back, or null when it isn't: no key at all,
   *  the pool spent until `until`, the key refused, or (detection continuing)
   *  the search fallback blocked. */
  parked: {
    reason: "keyless" | "exhausted" | "denied" | "search-blocked";
    until: number | null;
    detail: string;
  } | null;
  boost: YouTubeRuntimeStatus["boost"] | null;
  channels: (ChannelReport & { name: string })[];
}

export interface EventSubChannelStatus {
  login: string;
  broadcasterId: string | null;
  /**
   * none: no refresh token to start from, so nothing happens until one is
   * supplied; pending: the first refresh hasn't succeeded yet; ok; rejected:
   * Twitch refused the refresh token; error: the refresh failed some other
   * way (network, a bad response).
   */
  token: "none" | "pending" | "ok" | "rejected" | "error";
  /** Which refresh token is in use: the persisted (rotated) one or the seed. */
  tokenSource: "persisted" | "seed" | null;
  tokenError: string | null;
  tokenRefreshedAt: number | null;
  scopes: string[] | null;
  /** The WebSocket: not started (no token yet), connecting, connected (its
   *  welcome arrived), or waiting to reconnect after `sessionError`. */
  session: "idle" | "connecting" | "connected" | "retrying";
  sessionError: string | null;
  /** How the last subscribe round went; null before the first one. */
  subscriptions: { active: number; wanted: number; failed: string[] } | null;
  /** The last stream.online / stream.offline Twitch sent, if any. */
  stream: "online" | "offline" | null;
  streamAt: number | null;
}

export interface EventSubStatus {
  /** off: no channels configured; no-credentials: channels, but the app's
   *  clientId / clientSecret is missing, so none was started; on. */
  state: "off" | "no-credentials" | "on";
  channels: EventSubChannelStatus[];
}

/** What main.ts contributes to the response (see ServerHooks.status). */
export interface StatusSources {
  youtube: YouTubeStatus;
  eventsub: EventSubStatus;
}

/** A roster entry as the server tracks it: the sidebar's state plus when it
 *  last changed. */
export interface RosterEntry extends ChannelStatus {
  since: number;
}

export interface ServerStatus {
  version: string;
  startedAt: number;
  /** The server's clock, so a reader can turn the timestamps into ages
   *  without trusting its own. */
  now: number;
  uptimeSec: number;
  /** null when the server was started without the hook (no live sources). */
  youtube: YouTubeStatus | null;
  twitch: {
    /** The chat connection, per joined channel ("live" = joined). */
    irc: { name: string; state: ChannelState; since: number }[];
    eventsub: EventSubStatus | null;
  };
}

/** Assemble the GET /api/status body. */
export function buildServerStatus(o: {
  startedAt: number;
  now: number;
  roster: RosterEntry[];
  sources?: StatusSources;
}): ServerStatus {
  return {
    version: VERSION,
    startedAt: o.startedAt,
    now: o.now,
    uptimeSec: Math.max(0, Math.round((o.now - o.startedAt) / 1000)),
    youtube: o.sources?.youtube ?? null,
    twitch: {
      irc: o.roster
        .filter((r) => r.platform === "twitch")
        .map(({ name, state, since }) => ({ name, state, since })),
      eventsub: o.sources?.eventsub ?? null,
    },
  };
}

const KEY_SOURCE_TEXT: Record<YouTubeKeySource, string> = {
  persisted: "the persisted runtime key (state directory)",
  environment: "the environment (YOUTUBE_API_KEY)",
  settings: "settings.json (youtube.apiKey)",
  runtime: "set-youtube-key (this run)",
};

/** A YouTube key source in words, for log lines and `multichat status`. */
export function keySourceText(source: YouTubeKeySource): string {
  return KEY_SOURCE_TEXT[source];
}

/** "42s" / "12m" / "3h5m" — an age or a wait, for the status text. */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m`;
  return formatDuration(ms);
}

const pad = (name: string) => name.padEnd(20);

/** The status as `multichat status` prints it, one line per entry. Problems
 *  are spelled in capitals so they stand out in a terminal and in a grep. */
export function formatStatus(s: ServerStatus): string[] {
  const now = s.now;
  const out = [`multichat ${s.version} — up ${span(s.uptimeSec * 1000)}`];

  const yt = s.youtube;
  if (!yt) {
    out.push("YouTube: (no status source)");
  } else if (yt.configured === 0) {
    out.push("YouTube: no channels configured");
  } else {
    const key = yt.key.present && yt.key.source
      ? `key from ${
        keySourceText(yt.key.source)
      }, fingerprint ${yt.key.fingerprint}`
      : "KEYLESS";
    out.push(
      `YouTube: ${key} · ${
        yt.polling ? "polling" : "NOT polling"
      } ${yt.configured} channel(s)`,
    );
    if (yt.key.note) out.push(`  key: ${yt.key.note}`);
    if (yt.parked) {
      const p = yt.parked;
      const until = p.until !== null
        ? ` (for another ${span(p.until - now)})`
        : "";
      out.push(
        p.reason === "keyless"
          ? `  KEYLESS — ${p.detail}`
          : p.reason === "search-blocked"
          ? `  search blocked until 00:00 PT${until} — ${p.detail}`
          : p.reason === "exhausted"
          ? `  PARKED until 00:00 PT${until} — ${p.detail}`
          : `  KEY REFUSED — ${p.detail}`,
      );
    }
    if (yt.quota) {
      const q = yt.quota;
      out.push(
        `  quota ${q.day} PT: ${Math.round(q.units)}/${q.dailyQuota} units · ` +
          `${q.searches} search(es) · live ${formatDuration(q.liveMs)} of a ` +
          `${q.budgetHours}h budget · resets in ${span(q.resetsAt - now)}`,
      );
    }
    if (yt.boost) {
      const b = yt.boost;
      out.push(
        `  go-live boost: ${
          b.active && b.until !== null
            ? `ACTIVE for another ${span(b.until - now)}` +
              (b.earlySearch ? ` (early search ${b.earlySearch})` : "")
            : "idle"
        } · ${b.usedToday}/${b.dailyCap} used today`,
      );
    }
    for (const c of yt.channels) {
      out.push(
        `  ${pad(c.name)} ${c.state} — ${c.reason} (for ${
          span(now - c.since)
        })` +
          (c.videoId ? ` · video ${c.videoId}` : "") +
          (c.nextCheckAt !== null && c.nextCheckAt > now
            ? ` · next check in ${span(c.nextCheckAt - now)}`
            : ""),
      );
    }
  }

  out.push(
    s.twitch.irc.length ? "Twitch chat (IRC):" : "Twitch chat: no channels",
  );
  for (const c of s.twitch.irc) {
    out.push(
      `  ${pad(c.name)} ${c.state === "live" ? "joined" : c.state} (for ${
        span(now - c.since)
      })`,
    );
  }

  const es = s.twitch.eventsub;
  if (!es || es.state === "off") {
    out.push("Twitch EventSub: not configured");
  } else if (es.state === "no-credentials") {
    out.push(
      "Twitch EventSub: NOT RUNNING — clientId / clientSecret is missing",
    );
  } else {
    out.push("Twitch EventSub:");
    for (const c of es.channels) {
      const token = c.token === "ok"
        ? `token ok (${c.tokenSource ?? "?"}` +
          (c.tokenRefreshedAt !== null
            ? `, refreshed ${span(now - c.tokenRefreshedAt)} ago)`
            : ")")
        : c.token === "none"
        ? "NO TOKEN — run `multichat login`"
        : c.token === "pending"
        ? "token pending (first refresh not done yet)"
        : `TOKEN ${c.token.toUpperCase()}` +
          (c.tokenError ? ` — ${c.tokenError}` : "");
      const subs = c.subscriptions
        ? ` · ${c.subscriptions.active}/${c.subscriptions.wanted} subscriptions` +
          (c.subscriptions.failed.length
            ? ` (FAILED: ${c.subscriptions.failed.join(", ")})`
            : "")
        : "";
      const session = c.session === "retrying"
        ? `RECONNECTING${c.sessionError ? ` (${c.sessionError})` : ""}`
        : c.session;
      out.push(
        `  ${pad(c.login || c.broadcasterId || "?")} ${token} · ${session}` +
          subs +
          (c.stream && c.streamAt !== null
            ? ` · stream ${c.stream} ${span(now - c.streamAt)} ago`
            : ""),
      );
    }
  }
  return out;
}

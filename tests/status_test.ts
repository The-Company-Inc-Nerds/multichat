import {
  buildServerStatus,
  type EventSubChannelStatus,
  formatStatus,
  keySourceText,
  type RosterEntry,
  type ServerStatus,
  type StatusSources,
  VERSION,
  type YouTubeStatus,
} from "../src/status.ts";
import { assert, assertEquals } from "./_assert.ts";

const NOW = Date.parse("2026-10-08T20:00:00Z");
const MIN = 60_000;

const roster: RosterEntry[] = [
  {
    platform: "twitch",
    name: "thecompanyinc",
    state: "live",
    since: NOW - 3_600_000,
  },
  { platform: "twitch", name: "guest", state: "connecting", since: NOW - 5000 },
  { platform: "youtube", name: "@thecompany", state: "offline", since: NOW },
];

function youtube(over: Partial<YouTubeStatus> = {}): YouTubeStatus {
  return {
    configured: 1,
    key: {
      present: true,
      source: "environment",
      fingerprint: "1a2b3c4d",
      note: null,
    },
    polling: true,
    quota: {
      day: "2026-10-08",
      units: 412,
      searches: 3,
      searchBlocked: false,
      exhausted: false,
      liveMs: 90 * MIN,
      lastSearchAt: NOW - 30 * MIN,
      keyFp: "1a2b3c4d",
      boosts: 1,
      boostAt: NOW - 2 * MIN,
      dailyQuota: 10_000,
      budgetHours: 4,
      resetsAt: Date.parse("2026-10-09T07:00:00Z"),
    },
    parked: null,
    boost: {
      active: true,
      until: NOW + 3 * MIN,
      usedToday: 1,
      dailyCap: 12,
      earlySearch: "done",
    },
    channels: [{
      name: "@thecompany",
      state: "live",
      reason: "polling live chat (video abc123, found via uploads playlist)",
      since: NOW - 90 * MIN,
      parked: null,
      videoId: "abc123",
      checkedAt: NOW - 90 * MIN,
      nextCheckAt: null,
    }],
    ...over,
  };
}

function esChannel(
  over: Partial<EventSubChannelStatus> = {},
): EventSubChannelStatus {
  return {
    login: "thecompanyinc",
    broadcasterId: "1477084215",
    token: "ok",
    tokenSource: "persisted",
    tokenError: null,
    tokenRefreshedAt: NOW - 20 * MIN,
    scopes: ["moderator:read:followers"],
    session: "connected",
    sessionError: null,
    subscriptions: { active: 8, wanted: 8, failed: [] },
    stream: "online",
    streamAt: NOW - 91 * MIN,
    ...over,
  };
}

function status(sources?: StatusSources): ServerStatus {
  return buildServerStatus({
    startedAt: NOW - 2 * 3_600_000,
    now: NOW,
    roster,
    sources,
  });
}

Deno.test("VERSION has the form build.nix reads the package version from", () => {
  assert(/^\d+\.\d+\.\d+$/.test(VERSION), VERSION);
});

Deno.test("buildServerStatus: version, uptime, the IRC roster, and the live sources as given", () => {
  const sources = {
    youtube: youtube(),
    eventsub: { state: "on" as const, channels: [esChannel()] },
  };
  const s = status(sources);
  assertEquals(s.version, VERSION);
  assertEquals(s.now, NOW);
  assertEquals(s.startedAt, NOW - 2 * 3_600_000);
  assertEquals(s.uptimeSec, 7200);
  // Twitch chat comes from the roster; YouTube's entry there is superseded by
  // the poller's own, richer report.
  assertEquals(s.twitch.irc, [
    { name: "thecompanyinc", state: "live", since: NOW - 3_600_000 },
    { name: "guest", state: "connecting", since: NOW - 5000 },
  ]);
  assertEquals(s.youtube, sources.youtube);
  assertEquals(s.twitch.eventsub, sources.eventsub);
  // Round-trips as JSON (it is the HTTP body).
  assertEquals(JSON.parse(JSON.stringify(s)), s);
});

Deno.test("buildServerStatus: no live sources (a server started without the hook)", () => {
  const s = status();
  assertEquals(s.youtube, null);
  assertEquals(s.twitch.eventsub, null);
  assertEquals(
    buildServerStatus({ startedAt: NOW, now: NOW - 5, roster: [] }).uptimeSec,
    0,
  );
  const text = formatStatus(s).join("\n");
  assert(text.includes("YouTube: (no status source)"), text);
  assert(text.includes("Twitch EventSub: not configured"), text);
});

Deno.test("formatStatus: a healthy server, one line per thing", () => {
  const lines = formatStatus(status({
    youtube: youtube(),
    eventsub: { state: "on", channels: [esChannel()] },
  }));
  assertEquals(lines, [
    `multichat ${VERSION} — up 2h0m`,
    "YouTube: key from the environment (YOUTUBE_API_KEY), fingerprint 1a2b3c4d · polling 1 channel(s)",
    "  quota 2026-10-08 PT: 412/10000 units · 3 search(es) · live 1h30m of a 4h budget · resets in 11h0m",
    "  go-live boost: ACTIVE for another 3m (early search done) · 1/12 used today",
    "  @thecompany          live — polling live chat (video abc123, found via uploads playlist) (for 1h30m) · video abc123",
    "Twitch chat (IRC):",
    "  thecompanyinc        joined (for 60m)",
    "  guest                connecting (for 5s)",
    "Twitch EventSub:",
    "  thecompanyinc        token ok (persisted, refreshed 20m ago) · connected · 8/8 subscriptions · stream online 1h31m ago",
  ]);
});

Deno.test("formatStatus: keyless, parked and refused stand out", () => {
  const text = (yt: YouTubeStatus) =>
    formatStatus(status({
      youtube: yt,
      eventsub: { state: "off", channels: [] },
    })).join("\n");

  const keyless = text(youtube({
    key: { present: false, source: null, fingerprint: null, note: null },
    polling: false,
    quota: null,
    boost: null,
    parked: {
      reason: "keyless",
      until: null,
      detail: "no YouTube API key — set one with `multichat set-youtube-key`",
    },
    channels: [{
      name: "@thecompany",
      state: "connecting",
      reason: "waiting for an API key",
      since: NOW - MIN,
      parked: null,
      videoId: null,
      checkedAt: null,
      nextCheckAt: null,
    }],
  }));
  assert(
    keyless.includes("YouTube: KEYLESS · NOT polling 1 channel(s)"),
    keyless,
  );
  assert(keyless.includes("  KEYLESS — no YouTube API key"), keyless);
  assert(keyless.includes("connecting — waiting for an API key"), keyless);

  const parked = text(youtube({
    parked: {
      reason: "exhausted",
      until: Date.parse("2026-10-09T07:00:00Z"),
      detail: "daily YouTube API quota exhausted — resuming at 00:00 PT",
    },
    boost: {
      active: false,
      until: null,
      usedToday: 12,
      dailyCap: 12,
      earlySearch: null,
    },
  }));
  assert(
    parked.includes(
      "  PARKED until 00:00 PT (for another 11h0m) — daily YouTube API quota exhausted",
    ),
    parked,
  );
  assert(parked.includes("go-live boost: idle · 12/12 used today"), parked);

  const blocked = text(youtube({
    parked: {
      reason: "search-blocked",
      until: Date.parse("2026-10-09T07:00:00Z"),
      detail: "search.list's daily bucket is spent — live detection " +
        "continues via uploads playlists",
    },
  }));
  assert(
    blocked.includes("  search blocked until 00:00 PT (for another 11h0m)"),
    blocked,
  );

  const refused = text(youtube({
    key: {
      present: true,
      source: "environment",
      fingerprint: "1a2b3c4d",
      note: "the persisted runtime key (fingerprint deadbeef) was refused " +
        "(badRequest); running on the key from the environment " +
        "(YOUTUBE_API_KEY) instead",
    },
    parked: {
      reason: "denied",
      until: NOW + 8 * MIN,
      detail:
        "channels.list failed (badRequest: API key not valid) — retrying in 10m",
    },
    channels: [{
      name: "@thecompany",
      state: "error",
      reason:
        "channels.list failed (badRequest: API key not valid) — retrying in 10m",
      since: NOW - 2 * MIN,
      parked: "denied",
      videoId: null,
      checkedAt: NOW - 2 * MIN,
      nextCheckAt: NOW + 8 * MIN,
    }],
  }));
  assert(
    refused.includes(
      "  key: the persisted runtime key (fingerprint deadbeef) was refused",
    ),
    refused,
  );
  assert(refused.includes("  KEY REFUSED — channels.list failed"), refused);
  assert(refused.includes("(for 2m) · next check in 8m"), refused);

  assert(
    text(youtube({ configured: 0, channels: [] })).includes(
      "YouTube: no channels configured",
    ),
  );
});

Deno.test("formatStatus: what is wrong with EventSub, per channel", () => {
  const text = (eventsub: StatusSources["eventsub"]) =>
    formatStatus(status({ youtube: youtube(), eventsub })).join("\n");

  assert(
    text({ state: "no-credentials", channels: [] }).includes(
      "Twitch EventSub: NOT RUNNING — clientId / clientSecret is missing",
    ),
  );
  const t = text({
    state: "on",
    channels: [
      esChannel({
        login: "notoken",
        token: "none",
        tokenSource: null,
        tokenRefreshedAt: null,
        session: "idle",
        subscriptions: null,
        stream: null,
        streamAt: null,
      }),
      esChannel({
        login: "revoked",
        token: "rejected",
        tokenSource: "seed",
        tokenError: "Invalid refresh token",
        session: "idle",
        subscriptions: null,
        stream: null,
      }),
      esChannel({
        login: "starting",
        token: "pending",
        session: "idle",
        subscriptions: null,
      }),
      esChannel({
        login: "flaky",
        session: "retrying",
        sessionError: "Error: socket closed (1006)",
        subscriptions: { active: 7, wanted: 8, failed: ["channel.cheer"] },
        stream: "offline",
        streamAt: NOW - 30_000,
      }),
      esChannel({ login: "", broadcasterId: "42", tokenRefreshedAt: null }),
    ],
  });
  assert(
    t.includes(
      "  notoken              NO TOKEN — run `multichat login` · idle",
    ),
    t,
  );
  assert(
    t.includes(
      "  revoked              TOKEN REJECTED — Invalid refresh token · idle",
    ),
    t,
  );
  assert(
    t.includes(
      "  starting             token pending (first refresh not done yet) · idle",
    ),
    t,
  );
  assert(
    t.includes(
      "  flaky                token ok (persisted, refreshed 20m ago) · " +
        "RECONNECTING (Error: socket closed (1006)) · 7/8 subscriptions " +
        "(FAILED: channel.cheer) · stream offline 30s ago",
    ),
    t,
  );
  assert(
    t.includes("  42                   token ok (persisted) · connected"),
    t,
  );
});

Deno.test("keySourceText names every source", () => {
  assertEquals(
    keySourceText("persisted"),
    "the persisted runtime key (state directory)",
  );
  assertEquals(
    keySourceText("environment"),
    "the environment (YOUTUBE_API_KEY)",
  );
  assertEquals(keySourceText("settings"), "settings.json (youtube.apiKey)");
  assertEquals(keySourceText("runtime"), "set-youtube-key (this run)");
});

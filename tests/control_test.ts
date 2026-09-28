import {
  browserRequestDenied,
  channelPointsControlPath,
  channelPointsLedgerPath,
  channelPointsRewardsPath,
  checkControlAccess,
  isLoopbackAddr,
  isPrivateAddr,
  isStaleStateTmp,
  keyStatePath,
  normalizeControlAccess,
  parseYouTubeKeyBody,
  quarantinePath,
  resolveStartupKey,
  resolveStateDir,
  stateTmpPath,
  twitchBroadcasterStatePath,
  twitchTokenStatePath,
} from "../src/control.ts";
import { assert, assertEquals, assertExists } from "./_assert.ts";

Deno.test("isLoopbackAddr: loopback IPv4/IPv6 and unix peers are local", () => {
  assert(
    isLoopbackAddr({ transport: "tcp", hostname: "127.0.0.1", port: 8080 }),
  );
  assert(isLoopbackAddr({ transport: "tcp", hostname: "127.0.0.5", port: 1 }));
  assert(isLoopbackAddr({ transport: "tcp", hostname: "::1", port: 1 }));
  assert(
    isLoopbackAddr({ transport: "tcp", hostname: "::ffff:127.0.0.1", port: 1 }),
  );
  assert(isLoopbackAddr({ transport: "unix", path: "/run/multichat.sock" }));
});

Deno.test("isLoopbackAddr: LAN/public addresses are rejected", () => {
  assert(
    !isLoopbackAddr({ transport: "tcp", hostname: "10.10.10.5", port: 1 }),
  );
  assert(
    !isLoopbackAddr({ transport: "tcp", hostname: "192.168.1.20", port: 1 }),
  );
  assert(!isLoopbackAddr({ transport: "tcp", hostname: "0.0.0.0", port: 1 }));
  assert(!isLoopbackAddr({ transport: "tcp", hostname: "1.2.3.4", port: 1 }));
});

Deno.test("parseYouTubeKeyBody: plain-text body is the trimmed key", () => {
  assertEquals(parseYouTubeKeyBody("  AIzaKEY  \n", "text/plain"), "AIzaKEY");
  assertEquals(parseYouTubeKeyBody("AIzaKEY", null), "AIzaKEY");
  assertEquals(parseYouTubeKeyBody("   ", "text/plain"), "");
});

Deno.test("parseYouTubeKeyBody: JSON body reads the trimmed key field", () => {
  assertEquals(
    parseYouTubeKeyBody('{"key":"AIzaKEY"}', "application/json"),
    "AIzaKEY",
  );
  assertEquals(
    parseYouTubeKeyBody(
      '{"key":"  AIzaKEY "}',
      "application/json; charset=utf-8",
    ),
    "AIzaKEY",
  );
  assertEquals(parseYouTubeKeyBody("not json", "application/json"), "");
  assertEquals(parseYouTubeKeyBody('{"nope":1}', "application/json"), "");
});

Deno.test("resolveStartupKey: precedence is persisted > env > settings", () => {
  assertEquals(
    resolveStartupKey({ persisted: "P", env: "E", settings: "S" }),
    "P",
  );
  assertEquals(
    resolveStartupKey({ persisted: " ", env: "E", settings: "S" }),
    "E",
  );
  assertEquals(
    resolveStartupKey({ persisted: null, env: null, settings: "S" }),
    "S",
  );
  assertEquals(resolveStartupKey({ persisted: "  P  " }), "P");
  assertEquals(resolveStartupKey({}), "");
});

Deno.test("keyStatePath: builds a path under the state dir, else null", () => {
  assertEquals(
    keyStatePath("/var/lib/multichat"),
    "/var/lib/multichat/youtube-api-key",
  );
  assertEquals(
    keyStatePath("/var/lib/multichat/"),
    "/var/lib/multichat/youtube-api-key",
  );
  assertEquals(keyStatePath(null), null);
  assertEquals(keyStatePath(undefined), null);
  assertEquals(keyStatePath(""), null);
});

Deno.test("twitchTokenStatePath: refresh token file keyed by broadcaster id", () => {
  assertEquals(
    twitchTokenStatePath("/var/lib/multichat", "12345"),
    "/var/lib/multichat/twitch-refresh-12345",
  );
  assertEquals(
    twitchTokenStatePath("/var/lib/multichat/", "12345"),
    "/var/lib/multichat/twitch-refresh-12345",
  );
  assertEquals(twitchTokenStatePath(null, "12345"), null);
  assertEquals(twitchTokenStatePath("/var/lib/multichat", ""), null);
});

Deno.test("twitchBroadcasterStatePath: id cache keyed by lowercased login", () => {
  assertEquals(
    twitchBroadcasterStatePath("/var/lib/multichat", "Streamer"),
    "/var/lib/multichat/twitch-broadcaster-streamer",
  );
  assertEquals(twitchBroadcasterStatePath(null, "streamer"), null);
  assertEquals(twitchBroadcasterStatePath("/var/lib/multichat", ""), null);
});

Deno.test("channel-points state paths: ledger, reward map, control under the dir", () => {
  assertEquals(
    channelPointsLedgerPath("/var/lib/multichat/"),
    "/var/lib/multichat/channelpoints-ledger.json",
  );
  assertEquals(
    channelPointsRewardsPath("/var/lib/multichat"),
    "/var/lib/multichat/channelpoints-rewards.json",
  );
  assertEquals(
    channelPointsControlPath("/var/lib/multichat"),
    "/var/lib/multichat/channelpoints-control.json",
  );
  // No state dir → in-memory only, like the rest.
  assertEquals(channelPointsLedgerPath(null), null);
  assertEquals(channelPointsRewardsPath(undefined), null);
  assertEquals(channelPointsControlPath(""), null);
});

// ---- Control-plane access policy -----------------------------------------

const tcp = (hostname: string): Deno.Addr => ({
  transport: "tcp",
  hostname,
  port: 1,
});

Deno.test("isPrivateAddr: loopback and the private/link-local ranges pass", () => {
  for (
    const h of [
      "127.0.0.1",
      "::1",
      "10.0.0.7",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
      "169.254.10.1",
      "100.64.0.1",
      "::ffff:192.168.1.7",
      "fd00::1",
      "fe80::1",
    ]
  ) {
    assert(isPrivateAddr(tcp(h)), `${h} should be private`);
  }
});

Deno.test("isPrivateAddr: public and near-miss addresses are rejected", () => {
  for (
    const h of [
      "1.2.3.4",
      "8.8.8.8",
      "172.15.0.1", // just below 172.16/12
      "172.32.0.1", // just above 172.16/12
      "192.169.1.1", // not 192.168/16
      "100.63.0.1", // just below 100.64/10
      "100.128.0.1", // just above 100.64/10
      "2001:db8::1",
      "999.1.1.1", // not a v4 address at all
    ]
  ) {
    assert(!isPrivateAddr(tcp(h)), `${h} should not be private`);
  }
});

Deno.test("normalizeControlAccess: unknown values fall back to loopback", () => {
  assertEquals(normalizeControlAccess("lan"), "lan");
  assertEquals(normalizeControlAccess("  ANY "), "any");
  assertEquals(normalizeControlAccess("loopback"), "loopback");
  assertEquals(normalizeControlAccess("open"), "loopback");
  assertEquals(normalizeControlAccess(undefined), "loopback");
  assertEquals(normalizeControlAccess(true), "loopback");
});

Deno.test("checkControlAccess: loopback is allowed in every mode, token or not", () => {
  for (const access of ["loopback", "lan", "any"] as const) {
    assertEquals(
      checkControlAccess({
        addr: tcp("127.0.0.1"),
        access,
        token: "s3cret",
        presented: "",
        endpoint: "giveaway",
      }),
      null,
    );
  }
});

Deno.test("checkControlAccess: loopback mode refuses a LAN peer", () => {
  const denial = checkControlAccess({
    addr: tcp("192.168.1.20"),
    access: "loopback",
    token: "",
    presented: "",
    endpoint: "giveaway",
  });
  assertExists(denial);
  assertEquals(denial.status, 403);
  assert(denial.message.includes("loopback-only"));
});

Deno.test("checkControlAccess: lan mode admits the LAN and refuses the internet", () => {
  assertEquals(
    checkControlAccess({
      addr: tcp("192.168.1.20"),
      access: "lan",
      token: "",
      presented: "",
      endpoint: "giveaway",
    }),
    null,
  );
  const denial = checkControlAccess({
    addr: tcp("203.0.113.9"),
    access: "lan",
    token: "",
    presented: "",
    endpoint: "giveaway",
  });
  assertExists(denial);
  assertEquals(denial.status, 403);
});

Deno.test("checkControlAccess: any mode drops the address check", () => {
  assertEquals(
    checkControlAccess({
      addr: tcp("203.0.113.9"),
      access: "any",
      token: "",
      presented: "",
      endpoint: "giveaway",
    }),
    null,
  );
});

Deno.test("checkControlAccess: a configured token gates non-loopback callers", () => {
  const base = {
    addr: tcp("192.168.1.20"),
    access: "lan" as const,
    token: "s3cret",
    endpoint: "giveaway",
  };
  assertEquals(checkControlAccess({ ...base, presented: "s3cret" }), null);
  for (const presented of ["", "wrong", "s3cre", "s3crett"]) {
    const denial = checkControlAccess({ ...base, presented });
    assertExists(denial);
    assertEquals(denial.status, 403);
    assert(denial.message.includes("control token"));
  }
});

// ---- State directory ------------------------------------------------------

const envFrom = (vars: Record<string, string>) => (n: string) => vars[n];

Deno.test("resolveStateDir: systemd's StateDirectory wins", () => {
  assertEquals(
    resolveStateDir(envFrom({
      STATE_DIRECTORY: "/var/lib/multichat/",
      MULTICHAT_STATE_DIR: "/elsewhere",
      XDG_STATE_HOME: "/home/u/.local/state",
      HOME: "/home/u",
    })),
    "/var/lib/multichat",
  );
});

Deno.test("resolveStateDir: falls through explicit → XDG → HOME", () => {
  assertEquals(
    resolveStateDir(
      envFrom({ MULTICHAT_STATE_DIR: "/srv/mc/", HOME: "/home/u" }),
    ),
    "/srv/mc",
  );
  assertEquals(
    resolveStateDir(
      envFrom({ XDG_STATE_HOME: "/home/u/.local/state", HOME: "/home/u" }),
    ),
    "/home/u/.local/state/multichat",
  );
  assertEquals(
    resolveStateDir(envFrom({ HOME: "/home/u" })),
    "/home/u/.local/state/multichat",
  );
});

Deno.test("resolveStateDir: blank/absent env means in-memory only", () => {
  assertEquals(resolveStateDir(envFrom({})), null);
  assertEquals(
    resolveStateDir(envFrom({ STATE_DIRECTORY: "  ", HOME: "" })),
    null,
  );
});

Deno.test("stateTmpPath / isStaleStateTmp: unique temp files beside the target", () => {
  const p = "/var/lib/multichat/channelpoints-ledger.json";
  const a = stateTmpPath(p, "123-1-abcd1234");
  const b = stateTmpPath(p, "123-2-abcd1234");
  assertEquals(a, `${p}.123-1-abcd1234.tmp`);
  assert(a !== b, "two writes must never share a temp file");
  // Nothing path-like can leak out of the unique part.
  assertEquals(stateTmpPath(p, "../x/y"), `${p}.xy.tmp`);

  const base = "channelpoints-ledger.json";
  assert(isStaleStateTmp("channelpoints-ledger.json.123-1-ab.tmp", base));
  assert(!isStaleStateTmp("channelpoints-ledger.json", base));
  assert(!isStaleStateTmp("channelpoints-ledger.json..tmp", base));
  assert(!isStaleStateTmp("channelpoints-rewards.json.1.tmp", base));
  assert(!isStaleStateTmp("channelpoints-ledger.json.corrupt-x", base));
});

Deno.test("quarantinePath: a timestamped sibling, no colons", () => {
  assertEquals(
    quarantinePath(
      "/s/channelpoints-ledger.json",
      Date.parse("2026-09-25T20:01:02.345Z"),
    ),
    "/s/channelpoints-ledger.json.corrupt-2026-09-25T20-01-02-345Z",
  );
});

Deno.test("browserRequestDenied: the CLI passes; any web page is refused", () => {
  // Deno fetch / curl / the CLI: no Origin, no Sec-Fetch-*.
  assertEquals(browserRequestDenied(new Headers()), null);
  assertEquals(
    browserRequestDenied(new Headers({ "content-type": "application/json" })),
    null,
  );
  // Typed into the address bar / same-origin fetch without Origin: allowed.
  assertEquals(
    browserRequestDenied(new Headers({ "sec-fetch-site": "none" })),
    null,
  );
  assertEquals(
    browserRequestDenied(new Headers({ "sec-fetch-site": "same-origin" })),
    null,
  );
  // Any Origin at all (a cross-site "simple" POST always carries one).
  assertExists(
    browserRequestDenied(new Headers({ origin: "https://evil.example" })),
  );
  assertExists(browserRequestDenied(new Headers({ origin: "null" })));
  assertExists(
    browserRequestDenied(
      new Headers({
        origin: "http://127.0.0.1:8080",
        "sec-fetch-site": "same-origin",
      }),
    ),
  );
  // Cross-site / same-site fetch metadata, whatever the case.
  for (const v of ["cross-site", "same-site", "Cross-Site", "bogus"]) {
    assertExists(browserRequestDenied(new Headers({ "sec-fetch-site": v })));
  }
});

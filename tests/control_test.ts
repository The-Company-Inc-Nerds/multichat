import {
  isLoopbackAddr,
  keyStatePath,
  parseYouTubeKeyBody,
  resolveStartupKey,
} from "../src/control.ts";
import { assert, assertEquals } from "./_assert.ts";

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

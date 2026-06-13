import { colorFor } from "../src/server.ts";
import { assert, assertEquals } from "./_assert.ts";

Deno.test("colorFor is deterministic for the same name", () => {
  assertEquals(colorFor("streamerfan"), colorFor("streamerfan"));
});

Deno.test("colorFor returns an hsl() string", () => {
  const c = colorFor("someone");
  assert(/^hsl\(\d{1,3}, 65%, 60%\)$/.test(c), `unexpected color format: ${c}`);
});

Deno.test("colorFor varies across different names", () => {
  // Not a guarantee for arbitrary inputs, but these three should not collide.
  const a = colorFor("alice");
  const b = colorFor("bob");
  const c = colorFor("carol");
  assert(
    a !== b || b !== c,
    "expected at least some hue variation across names",
  );
});

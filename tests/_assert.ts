// Minimal assertion helpers — keeps the test suite dependency-free (no JSR/std imports),
// matching the project's "Deno built-ins only" rule. Deno.test provides the runner;
// these provide the checks.

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(msg ?? `expected ${e} but got ${a}`);
  }
}

export function assertExists<T>(
  value: T,
  msg?: string,
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(msg ?? "expected value to exist");
  }
}

export function assertThrows(fn: () => unknown, msg?: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(msg ?? "expected function to throw");
}

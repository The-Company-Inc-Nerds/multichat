// Runtime control plane: the small, pure pieces behind setting the YouTube API
// key on a *running* server. The transport (the POST /api/youtube-key route) lives
// in server.ts and the stateful manager (poller restart + persistence) lives in
// main.ts; everything here is side-effect-free so the test suite can drive it
// directly, matching the project's "logic in src/, wiring in main.ts" split.

/** Result of an attempt to set the runtime YouTube key (returned to the CLI client). */
export interface KeyUpdateResult {
  ok: boolean;
  message: string;
}

/** Hooks createServer calls back into. Kept optional so tests can omit them. */
export interface ServerHooks {
  /** Invoked with a validated key when a loopback POST /api/youtube-key arrives. */
  setYouTubeKey?: (key: string) => Promise<KeyUpdateResult>;
}

/**
 * True when a connection originated locally. The control endpoint is exposed on
 * the same listener as the (unauthenticated) viewer, so when the viewer binds
 * 0.0.0.0 the endpoint must refuse anything that isn't loopback — otherwise the
 * whole LAN could set the API key. Unix-domain peers are inherently local.
 */
export function isLoopbackAddr(addr: Deno.Addr): boolean {
  // Non-IP transports (unix-domain, vsock, …) only carry local peers; narrowing
  // positively on tcp/udp also lets TS see `hostname` below.
  if (addr.transport !== "tcp" && addr.transport !== "udp") return true;
  const host = addr.hostname;
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host.startsWith("127.")
  );
}

/**
 * Extract the API key from a control-request body. Accepts a raw `text/plain`
 * body (the key itself) or a JSON object `{ "key": "..." }`. Returns the trimmed
 * key, or "" when the body is empty / unparseable / missing the field.
 */
export function parseYouTubeKeyBody(
  raw: string,
  contentType: string | null,
): string {
  if ((contentType ?? "").toLowerCase().includes("application/json")) {
    try {
      const obj = JSON.parse(raw) as { key?: unknown };
      return typeof obj?.key === "string" ? obj.key.trim() : "";
    } catch {
      return "";
    }
  }
  return raw.trim();
}

/**
 * Pick the API key to use at startup. A key the operator set at runtime
 * (persisted to disk) is the most recent intent, so it wins over a deploy-time
 * env var, which in turn wins over a static settings.json value. Returns "" when
 * none is set (the server then waits for a runtime key).
 */
export function resolveStartupKey(sources: {
  persisted?: string | null;
  env?: string | null;
  settings?: string | null;
}): string {
  for (const v of [sources.persisted, sources.env, sources.settings]) {
    if (v && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Where the runtime key is persisted: a file inside systemd's StateDirectory
 * ($STATE_DIRECTORY). Returns null when no state dir is provided (e.g. a plain
 * `deno task start`), in which case the key is held in memory only.
 */
export function keyStatePath(
  stateDir: string | null | undefined,
): string | null {
  const dir = (stateDir ?? "").replace(/\/+$/, "");
  return dir ? `${dir}/youtube-api-key` : null;
}

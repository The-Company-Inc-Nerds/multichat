// Dependency-free CDP screenshot driver for visually verifying overlay changes.
//
// Why this exists: the server pushes messages over SSE and keeps NO history, so
// `chromium --screenshot URL` (which loads, snaps, exits) can never see a faked
// event. This script keeps a page open, runs the injector while it is open, then
// captures. Deno built-ins only (WebSocket + fetch), same as the rest of the repo.
//
// Usage:
//   deno run --allow-net=127.0.0.1 --allow-write --allow-run \
//     tools/shot.ts --url http://127.0.0.1:8199/alerts --out /tmp/alerts.png \
//     [--cdp 9222] [--width 1280] [--height 720] [--transparent] \
//     [--settle 2500] [--wait 1200] [-- <inject cmd ...>]

type Params = Record<string, unknown>;

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<
    number,
    { resolve: (v: Params) => void; reject: (e: Error) => void }
  >();
  #listeners: Array<(method: string, params: Params) => void> = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (typeof msg.id === "number") {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of this.#listeners) l(msg.method, msg.params ?? {});
      }
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error(`CDP connect failed: ${url}`));
    });
  }

  send(method: string, params: Params = {}): Promise<Params> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(fn: (method: string, params: Params) => void): void {
    this.#listeners.push(fn);
  }

  once(method: string, timeoutMs = 15000): Promise<Params> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        timeoutMs,
      );
      this.on((m, p) => {
        if (m === method) {
          clearTimeout(t);
          resolve(p);
        }
      });
    });
  }

  close(): void {
    this.#ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string, dflt?: string): string | undefined {
  const argv = Deno.args;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}
const has = (name: string) => Deno.args.includes(`--${name}`);

const url = arg("url") ?? "http://127.0.0.1:8199/overlay";
const out = arg("out") ?? "/tmp/multichat-shot.png";
const cdpPort = arg("cdp", "9222")!;
const width = Number(arg("width", "1280"));
const height = Number(arg("height", "720"));
const settle = Number(arg("settle", "1500")); // after load, before injecting
const wait = Number(arg("wait", "1200")); // after injecting, before capture
const dashdash = Deno.args.indexOf("--");
const injectCmd = dashdash >= 0 ? Deno.args.slice(dashdash + 1) : [];

// Find the browser-level websocket.
const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`))
  .json();
const browser = await Cdp.connect(version.webSocketDebuggerUrl);

// Open a fresh tab for the page under test.
// Note: no width/height here — headless Chrome rejects window sizing on
// createTarget ("Target position can only be set for new windows"); the viewport
// is set below with Emulation.setDeviceMetricsOverride instead.
const { targetId } = await browser.send("Target.createTarget", {
  url: "about:blank",
}) as { targetId: string };

const page = await Cdp.connect(
  `ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`,
);
await page.send("Page.enable");
await page.send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
if (has("transparent")) {
  // The /overlay page is meant to be transparent in OBS; keep alpha so the
  // screenshot shows what OBS would composite.
  await page.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
}

const loaded = page.once("Page.loadEventFired");
await page.send("Page.navigate", { url });
await loaded;
console.log(`loaded ${url}`);

// Let the page open its EventSource before anything is injected.
await sleep(settle);

if (injectCmd.length) {
  console.log(`injecting: ${injectCmd.join(" ")}`);
  const cmd = new Deno.Command(injectCmd[0], {
    args: injectCmd.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await cmd.output();
  if (!status.success) console.error("inject command failed");
}

await sleep(wait);

const shot = await page.send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
}) as { data: string };
const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
await Deno.writeFile(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes)`);

// Report what the page actually rendered, so a failure is legible in the log
// even before you look at the PNG.
const evalRes = await page.send("Runtime.evaluate", {
  expression: "document.body.innerText.slice(0, 400)",
  returnByValue: true,
}) as { result: { value: string } };
console.log("--- body text ---");
console.log(evalRes.result.value);

page.close();
await browser.send("Target.closeTarget", { targetId });
browser.close();
Deno.exit(0);

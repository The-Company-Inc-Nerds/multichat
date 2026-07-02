import type {
  Badge,
  Emitter,
  MessageKind,
  Segment,
  TwitchConfig,
} from "./types.ts";

export function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    tags[eq === -1 ? part : part.slice(0, eq)] = eq === -1
      ? ""
      : part.slice(eq + 1);
  }
  return tags;
}

// IRCv3 tag values escape spaces and a few other chars.
export function unescapeTag(v: string): string {
  return v
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

interface IRCLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

export function parseIRC(line: string): IRCLine | null {
  let s = line.trimEnd();
  if (!s) return null;

  let tags: Record<string, string> = {};
  if (s[0] === "@") {
    const sp = s.indexOf(" ");
    if (sp === -1) return null;
    tags = parseTags(s.slice(1, sp));
    s = s.slice(sp + 1);
  }

  let prefix = "";
  if (s[0] === ":") {
    const sp = s.indexOf(" ");
    if (sp === -1) return null;
    prefix = s.slice(1, sp);
    s = s.slice(sp + 1);
  }

  const parts = s.split(" ");
  const command = parts[0];
  const params: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i][0] === ":") {
      params.push(parts.slice(i).join(" ").slice(1));
      break;
    }
    if (parts[i]) params.push(parts[i]);
  }

  return { tags, prefix, command, params };
}

const BADGE_LABELS: Record<string, string> = {
  broadcaster: "Broadcaster",
  moderator: "Mod",
  vip: "VIP",
  subscriber: "Sub",
  founder: "Founder",
  staff: "Staff",
  admin: "Admin",
  global_mod: "Global Mod",
  turbo: "Turbo",
  premium: "Prime",
  partner: "Verified",
};

export function parseBadges(tag: string): Badge[] {
  if (!tag) return [];
  const out: Badge[] = [];
  for (const part of tag.split(",")) {
    const id = part.split("/")[0];
    if (!id) continue;
    out.push({ id, label: BADGE_LABELS[id] ?? id });
  }
  return out;
}

interface EmoteSpan {
  start: number;
  end: number; // inclusive, codepoint index
  id: string;
}

// Parse Twitch's `emotes` tag: "id:start-end,start-end/id2:start-end".
export function parseEmoteTag(tag: string): EmoteSpan[] {
  if (!tag) return [];
  const spans: EmoteSpan[] = [];
  for (const group of tag.split("/")) {
    const colon = group.indexOf(":");
    if (colon === -1) continue;
    const id = group.slice(0, colon);
    for (const range of group.slice(colon + 1).split(",")) {
      const [a, b] = range.split("-");
      const start = Number(a);
      const end = Number(b);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        spans.push({ start, end, id });
      }
    }
  }
  return spans.sort((x, y) => x.start - y.start);
}

const emoteUrl = (id: string) =>
  `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`;

// Tokenize a message into text + emote segments. Indices are codepoint-based.
export function buildSegments(
  text: string,
  emotesTag: string,
): Segment[] | undefined {
  const spans = parseEmoteTag(emotesTag);
  if (!spans.length) return undefined;

  const cp = [...text]; // codepoint array — Twitch positions index this, not UTF-16 units
  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({
        type: "text",
        text: cp.slice(cursor, span.start).join(""),
      });
    }
    const alt = cp.slice(span.start, span.end + 1).join("");
    segments.push({ type: "emote", url: emoteUrl(span.id), alt });
    cursor = span.end + 1;
  }
  if (cursor < cp.length) {
    segments.push({ type: "text", text: cp.slice(cursor).join("") });
  }
  return segments;
}

const CHEER_TIERS: Array<{ min: number; color: string }> = [
  { min: 10000, color: "#eb0400" },
  { min: 5000, color: "#1d8df0" },
  { min: 1000, color: "#00b173" },
  { min: 100, color: "#9147ff" },
  { min: 1, color: "#9c9c9c" },
];

export function cheerColor(bits: number): string {
  for (const t of CHEER_TIERS) if (bits >= t.min) return t.color;
  return "#9c9c9c";
}

const ANNOUNCE_COLORS: Record<string, string> = {
  PRIMARY: "#9147ff",
  BLUE: "#1d8df0",
  GREEN: "#00b173",
  ORANGE: "#e0993f",
  PURPLE: "#9147ff",
};

// No data for this long means the connection is silently dead — force a reconnect.
const IDLE_MS = 90_000;
const IDLE_CHECK_MS = 15_000;
// Discard a partial line that never terminates, so a misbehaving peer can't grow memory.
const MAX_BUF = 64 * 1024;

async function connectOnce(
  channels: string[],
  emitter: Emitter,
): Promise<void> {
  const nick = `justinfan${10000 + Math.floor(Math.random() * 89999)}`;
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv");

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("connect failed"));
  });

  ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
  ws.send(`PASS oauth:anonymous\r\n`);
  ws.send(`NICK ${nick}\r\n`);
  for (const ch of channels) {
    ws.send(`JOIN #${ch.toLowerCase()}\r\n`);
  }

  let buf = "";
  await new Promise<void>((_, rej) => {
    // Watchdog for silent half-open connections: a NAT/proxy can drop the TCP path
    // without a close frame, leaving the socket "open" but permanently silent. Twitch
    // sends a PING at least every ~5 min, so no traffic for IDLE_MS means it's dead —
    // force a close to trigger the reconnect loop. This is the main long-stream failure.
    let lastData = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastData > IDLE_MS) fail(new Error("idle timeout"));
    }, IDLE_CHECK_MS);
    const fail = (err: Error) => {
      clearInterval(timer);
      try {
        ws.close();
      } catch { /* already closing */ }
      rej(err);
    };

    ws.onmessage = ({ data }) => {
      lastData = Date.now();
      buf += typeof data === "string" ? data : "";
      const lines = buf.split("\r\n");
      buf = lines.pop() ?? "";
      // Defensive: a peer streaming bytes without CRLF must not grow buf unboundedly.
      if (buf.length > MAX_BUF) buf = "";
      for (const line of lines) {
        const msg = parseIRC(line);
        if (!msg) continue;

        if (msg.command === "PING") {
          ws.send(`PONG :${msg.params[0] ?? "tmi.twitch.tv"}\r\n`);
          continue;
        }

        if (msg.command === "RECONNECT") {
          fail(new Error("RECONNECT requested"));
          return;
        }

        // PING/RECONNECT need the socket; everything else is emitter-only and unit-testable.
        if (handleCommand(msg, emitter)) continue;
      }
    };
    ws.onclose = () => fail(new Error("closed"));
    ws.onerror = () => fail(new Error("socket error"));
  });
}

// Route an IRC line to the emitter. Returns true if the command was handled here.
// PING/RECONNECT are deliberately excluded — they need the socket and stay in connectOnce.
export function handleCommand(msg: IRCLine, emitter: Emitter): boolean {
  const channel = (msg.params[0] ?? "").replace(/^#/, "");
  switch (msg.command) {
    // Twitch emits one ROOMSTATE per channel right after we join — use it as "joined".
    case "ROOMSTATE":
      if (channel) emitter.status("twitch", channel, "live");
      return true;
    case "PRIVMSG":
      handlePrivmsg(msg, emitter);
      return true;
    case "USERNOTICE":
      handleUsernotice(msg, emitter);
      return true;
    case "CLEARMSG": {
      const messageId = msg.tags["target-msg-id"];
      if (messageId) emitter.delete({ platform: "twitch", channel, messageId });
      return true;
    }
    case "CLEARCHAT": {
      const author = msg.params[1]; // present => single-user ban/timeout
      if (author) emitter.delete({ platform: "twitch", channel, author });
      else emitter.delete({ platform: "twitch", channel });
      return true;
    }
    default:
      return false;
  }
}

export function handlePrivmsg(msg: IRCLine, emitter: Emitter): void {
  const channel = (msg.params[0] ?? "").replace(/^#/, "");
  let content = msg.params[1] ?? "";
  const author = msg.tags["display-name"] || msg.prefix.split("!")[0] || "anon";
  const badges = parseBadges(msg.tags["badges"] ?? "");

  let kind: MessageKind = "chat";

  // /me actions arrive wrapped as \x01ACTION ...\x01. Emote indices count the inner text.
  if (content.startsWith("ACTION ") && content.endsWith("")) {
    content = content.slice(8, -1);
    kind = "action";
  }

  const segments = buildSegments(content, msg.tags["emotes"] ?? "");

  const bits = Number(msg.tags["bits"]);
  let amount: string | undefined;
  let accentColor: string | undefined;
  let eventText: string | undefined;
  if (Number.isFinite(bits) && bits > 0) {
    kind = "cheer";
    amount = `${bits} bits`;
    accentColor = cheerColor(bits);
    eventText = `${author} cheered ${bits} bits`;
  }

  emitter.message({
    id: msg.tags["id"] || `twitch-${Date.now()}-${Math.random()}`,
    platform: "twitch",
    channel,
    author,
    authorColor: msg.tags["color"] || undefined,
    content,
    segments,
    badges: badges.length ? badges : undefined,
    kind,
    amount,
    accentColor,
    eventText,
    timestamp: Date.now(),
  });
}

export function handleUsernotice(msg: IRCLine, emitter: Emitter): void {
  const channel = (msg.params[0] ?? "").replace(/^#/, "");
  const author = msg.tags["display-name"] || msg.tags["login"] || "anon";
  const msgId = msg.tags["msg-id"] ?? "";
  const systemMsg = unescapeTag(msg.tags["system-msg"] ?? "");
  const userComment = msg.params[1] ?? "";

  let kind: MessageKind = "system";
  let accentColor = "#9147ff";
  let amount: string | undefined;

  if (
    msgId === "sub" || msgId === "resub" || msgId === "subgift" ||
    msgId === "anonsubgift" || msgId === "submysterygift" ||
    msgId === "giftpaidupgrade" || msgId === "anongiftpaidupgrade"
  ) {
    kind = "sub";
    accentColor = "#9147ff";
  } else if (msgId === "raid") {
    kind = "raid";
    accentColor = "#00b173";
    const viewers = msg.tags["msg-param-viewerCount"];
    if (viewers) amount = `${viewers} viewers`;
  } else if (msgId === "announcement") {
    const c = msg.tags["msg-param-color"];
    accentColor = ANNOUNCE_COLORS[c] ?? "#9147ff";
  }

  const segments = userComment
    ? buildSegments(userComment, msg.tags["emotes"] ?? "")
    : undefined;
  const badges = parseBadges(msg.tags["badges"] ?? "");

  emitter.message({
    id: msg.tags["id"] || `twitch-un-${Date.now()}-${Math.random()}`,
    platform: "twitch",
    channel,
    author,
    authorColor: msg.tags["color"] || undefined,
    content: userComment,
    segments,
    badges: badges.length ? badges : undefined,
    kind,
    amount,
    accentColor,
    eventText: systemMsg || author,
    timestamp: Date.now(),
  });
}

export function startTwitchClient(
  config: TwitchConfig,
  emitter: Emitter,
): void {
  const delays = [2_000, 4_000, 8_000, 16_000, 30_000];
  let attempt = 0;

  (async () => {
    while (true) {
      const start = Date.now();
      try {
        console.log(`[Twitch] Connecting to: ${config.channels.join(", ")}`);
        for (const ch of config.channels) {
          emitter.status("twitch", ch, "connecting");
        }
        await connectOnce(config.channels, emitter);
      } catch (err) {
        for (const ch of config.channels) emitter.status("twitch", ch, "error");
        // A connection that stayed up a while is a fresh failure, not a flaky endpoint —
        // reset the backoff so a mid-stream blip reconnects in 2s, not 30s.
        if (Date.now() - start > 60_000) attempt = 0;
        const delay = delays[Math.min(attempt++, delays.length - 1)];
        console.error(`[Twitch] ${err} — retry in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();
}

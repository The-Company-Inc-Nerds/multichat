import type { Broadcaster, TwitchConfig } from "./types.ts";

function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    tags[eq === -1 ? part : part.slice(0, eq)] = eq === -1 ? "" : part.slice(eq + 1);
  }
  return tags;
}

interface IRCLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

function parseIRC(line: string): IRCLine | null {
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

async function connectOnce(channels: string[], onMessage: Broadcaster): Promise<void> {
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
    ws.onmessage = ({ data }) => {
      buf += typeof data === "string" ? data : "";
      const lines = buf.split("\r\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const msg = parseIRC(line);
        if (!msg) continue;

        if (msg.command === "PING") {
          ws.send(`PONG :${msg.params[0] ?? "tmi.twitch.tv"}\r\n`);
          continue;
        }

        if (msg.command === "RECONNECT") {
          ws.close();
          rej(new Error("RECONNECT requested"));
          return;
        }

        if (msg.command === "PRIVMSG") {
          const channel = (msg.params[0] ?? "").replace(/^#/, "");
          const content = msg.params[1] ?? "";
          const author =
            msg.tags["display-name"] || msg.prefix.split("!")[0] || "anon";
          onMessage({
            id: msg.tags["id"] || `twitch-${Date.now()}-${Math.random()}`,
            platform: "twitch",
            channel,
            author,
            authorColor: msg.tags["color"] || undefined,
            content,
            timestamp: Date.now(),
          });
        }
      }
    };
    ws.onclose = () => rej(new Error("closed"));
    ws.onerror = () => rej(new Error("socket error"));
  });
}

export function startTwitchClient(config: TwitchConfig, onMessage: Broadcaster): void {
  const delays = [2_000, 4_000, 8_000, 16_000, 30_000];
  let attempt = 0;

  (async () => {
    while (true) {
      try {
        console.log(`[Twitch] Connecting to: ${config.channels.join(", ")}`);
        await connectOnce(config.channels, onMessage);
      } catch (err) {
        const delay = delays[Math.min(attempt++, delays.length - 1)];
        console.error(`[Twitch] ${err} — retry in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();
}

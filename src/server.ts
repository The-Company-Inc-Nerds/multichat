import type { Broadcaster, ChatMessage, Settings } from "./types.ts";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Multichat</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0e0e10;
      color: #efeff1;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    header {
      padding: 9px 14px;
      background: #18181b;
      border-bottom: 1px solid #26262c;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    h1 {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: #efeff1;
    }

    #status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #8e8e9a;
    }

    #dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #444;
      flex-shrink: 0;
      transition: background 0.4s;
    }

    #dot.live { background: #00b173; }
    #dot.err  { background: #eb0400; }

    #chat {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 0 8px;
    }

    #chat::-webkit-scrollbar { width: 4px; }
    #chat::-webkit-scrollbar-track { background: transparent; }
    #chat::-webkit-scrollbar-thumb { background: #2a2a2d; border-radius: 2px; }

    .msg {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 0 4px;
      padding: 2px 14px 2px 10px;
      border-left: 3px solid transparent;
    }

    .msg:hover { background: rgba(255,255,255,0.03); }
    .msg.twitch  { border-color: #9147ff; }
    .msg.youtube { border-color: #eb0400; }

    .badge {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 1px 4px;
      border-radius: 2px;
      line-height: 1.6;
      flex-shrink: 0;
    }

    .badge.twitch  { background: #9147ff; color: #fff; }
    .badge.youtube { background: #eb0400; color: #fff; }

    .chan {
      font-size: 10px;
      color: #606068;
      flex-shrink: 0;
      max-width: 90px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .user {
      font-weight: 700;
      flex-shrink: 0;
      color: #efeff1;
    }

    .colon { color: #4a4a55; flex-shrink: 0; }

    .text {
      color: #d8d8e0;
      flex: 1;
      min-width: 0;
      line-height: 1.55;
      word-break: break-word;
    }

    #jump {
      position: fixed;
      bottom: 12px;
      right: 12px;
      background: #26262c;
      border: 1px solid #3a3a44;
      border-radius: 14px;
      color: #adadb8;
      padding: 5px 13px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      display: none;
    }

    #jump:hover { color: #efeff1; }
    #jump.show  { display: block; }
  </style>
</head>
<body>
  <header>
    <h1>MULTICHAT</h1>
    <div id="status">
      <div id="dot"></div>
      <span id="stxt">Connecting</span>
    </div>
  </header>
  <div id="chat"></div>
  <button id="jump" onclick="jumpBottom()">&#9660; Latest</button>
  <script>
    var chat = document.getElementById('chat');
    var dot  = document.getElementById('dot');
    var stxt = document.getElementById('stxt');
    var jump = document.getElementById('jump');
    var pinned = true;
    var count  = 0;
    var MAX    = 500;

    chat.addEventListener('scroll', function() {
      var atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60;
      if (atBottom) {
        pinned = true;
        jump.classList.remove('show');
      } else if (pinned) {
        pinned = false;
        jump.classList.add('show');
      }
    });

    function jumpBottom() {
      chat.scrollTop = chat.scrollHeight;
      pinned = true;
      jump.classList.remove('show');
    }

    function make(tag, cls, txt) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (txt !== undefined) e.textContent = txt;
      return e;
    }

    function addMsg(m) {
      var row    = make('div', 'msg ' + m.platform);
      var badge  = make('span', 'badge ' + m.platform, m.platform === 'twitch' ? 'T' : 'YT');
      var chan   = make('span', 'chan', m.channel);
      chan.title = m.channel;
      var user   = make('span', 'user', m.author);
      if (m.authorColor) user.style.color = m.authorColor;
      var colon  = make('span', 'colon', ':');
      var text   = make('span', 'text', m.content);

      row.appendChild(badge);
      row.appendChild(chan);
      row.appendChild(user);
      row.appendChild(colon);
      row.appendChild(text);
      chat.appendChild(row);
      count++;

      if (count > MAX) {
        var old = chat.querySelector('.msg');
        if (old) { old.remove(); count--; }
      }

      if (pinned) chat.scrollTop = chat.scrollHeight;
    }

    function connect() {
      var es = new EventSource('/events');
      es.onopen   = function() { dot.className = 'live'; stxt.textContent = 'Live'; };
      es.onerror  = function() { dot.className = 'err';  stxt.textContent = 'Reconnecting'; };
      es.onmessage = function(e) {
        try { addMsg(JSON.parse(e.data)); } catch(_) {}
      };
    }

    connect();
  </script>
</body>
</html>`;

export function createServer(settings: Settings): Broadcaster {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  function broadcast(msg: ChatMessage): void {
    const frame = enc.encode("data: " + JSON.stringify(msg) + "\n\n");
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(frame);
      } catch {
        clients.delete(ctrl);
      }
    }
  }

  // Keep SSE connections alive through proxies
  setInterval(() => {
    const ping = enc.encode(": ping\n\n");
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(ping);
      } catch {
        clients.delete(ctrl);
      }
    }
  }, 25_000);

  Deno.serve(
    {
      port: settings.server.port,
      hostname: settings.server.host,
      onListen({ hostname, port }) {
        console.log(`Listening on http://${hostname}:${port}`);
      },
    },
    (req: Request): Response => {
      const { pathname } = new URL(req.url);

      if (pathname === "/events") {
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            clients.add(ctrl);
            ctrl.enqueue(enc.encode(": connected\n\n"));
          },
          cancel() {
            clients.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  );

  return broadcast;
}

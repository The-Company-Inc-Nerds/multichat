import type {
  ChannelState,
  ChannelStatus,
  ChatMessage,
  DeleteEvent,
  Emitter,
  Platform,
  ServerEvent,
  Settings,
} from "./types.ts";

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
      gap: 12px;
      flex-shrink: 0;
    }

    #menu {
      background: none;
      border: none;
      color: #adadb8;
      font-size: 16px;
      cursor: pointer;
      line-height: 1;
      padding: 0;
      display: none;
    }
    #menu:hover { color: #efeff1; }

    h1 {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: #efeff1;
    }

    #status {
      margin-left: auto;
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

    #main { flex: 1; display: flex; min-height: 0; }

    #side {
      width: 190px;
      flex-shrink: 0;
      background: #161618;
      border-right: 1px solid #26262c;
      overflow-y: auto;
      padding: 10px 0;
    }

    .grp {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #6c6c78;
      padding: 8px 14px 4px;
    }
    .grp.twitch  { color: #a877ff; }
    .grp.youtube { color: #ff5b56; }

    .ch {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 4px 14px;
      font-size: 12px;
      color: #c8c8d0;
    }
    .ch .cdot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: #555;
    }
    .ch .cdot.live       { background: #00b173; box-shadow: 0 0 5px #00b17388; }
    .ch .cdot.connecting { background: #d9a441; }
    .ch .cdot.offline    { background: #555; }
    .ch .cdot.error      { background: #eb0400; }
    .ch .cname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 2px 14px; font-size: 11px; color: #5a5a64; font-style: italic; }

    #chat {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 0 8px;
    }

    #chat::-webkit-scrollbar, #side::-webkit-scrollbar { width: 4px; }
    #chat::-webkit-scrollbar-track, #side::-webkit-scrollbar-track { background: transparent; }
    #chat::-webkit-scrollbar-thumb, #side::-webkit-scrollbar-thumb { background: #2a2a2d; border-radius: 2px; }

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

    .role {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      line-height: 1.6;
      flex-shrink: 0;
      background: #3a3a44;
      color: #d8d8e0;
    }
    .role.broadcaster, .role.owner { background: #eb0400; color: #fff; }
    .role.moderator { background: #00ad03; color: #fff; }
    .role.vip       { background: #e005b9; color: #fff; }
    .role.subscriber, .role.founder, .role.member { background: #6441a5; color: #fff; }
    .role.verified  { background: #1d9bf0; color: #fff; }

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

    .emote {
      height: 19px;
      vertical-align: middle;
      margin: -2px 0;
    }

    .msg.action .text { font-style: italic; }

    /* Highlighted event rows (cheer / sub / raid / superchat / membership) */
    .event {
      margin: 3px 8px;
      padding: 5px 10px;
      border-left: 3px solid #9147ff;
      border-radius: 3px;
      background: rgba(145,71,255,0.12);
    }
    .event .ehead {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 0 6px;
    }
    .event .etitle { font-weight: 700; color: #efeff1; }
    .event .amount {
      margin-left: auto;
      font-weight: 700;
      font-size: 11px;
      background: rgba(0,0,0,0.3);
      padding: 1px 7px;
      border-radius: 9px;
    }
    .event .ebody {
      margin-top: 3px;
      color: #e6e6ee;
      word-break: break-word;
      line-height: 1.5;
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

    @media (max-width: 560px) {
      #menu { display: block; }
      #side {
        position: absolute;
        top: 0; bottom: 0; left: 0;
        z-index: 5;
        transform: translateX(-100%);
        transition: transform 0.2s;
      }
      body.nav #side { transform: translateX(0); }
    }
  </style>
</head>
<body>
  <header>
    <button id="menu" onclick="document.body.classList.toggle('nav')" aria-label="Toggle channels">&#9776;</button>
    <h1>MULTICHAT</h1>
    <div id="status">
      <div id="dot"></div>
      <span id="stxt">Connecting</span>
    </div>
  </header>
  <div id="main">
    <aside id="side"></aside>
    <div id="chat"></div>
  </div>
  <button id="jump" onclick="jumpBottom()">&#9660; Latest</button>
  <script>
    var chat = document.getElementById('chat');
    var side = document.getElementById('side');
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

    // Render a message body from segments (text + emote images) or plain content.
    function renderBody(el, m) {
      if (m.segments && m.segments.length) {
        for (var i = 0; i < m.segments.length; i++) {
          var s = m.segments[i];
          if (s.type === 'emote') {
            var img = document.createElement('img');
            img.className = 'emote';
            img.src = s.url;
            img.alt = s.alt;
            img.title = s.alt;
            img.loading = 'lazy';
            el.appendChild(img);
          } else {
            el.appendChild(document.createTextNode(s.text));
          }
        }
      } else {
        el.textContent = m.content || '';
      }
    }

    function badges(row, m) {
      if (!m.badges) return;
      for (var i = 0; i < m.badges.length; i++) {
        var b = m.badges[i];
        var known = ['broadcaster','owner','moderator','vip','subscriber','founder','member','verified'];
        var cls = known.indexOf(b.id) !== -1 ? 'role ' + b.id : 'role';
        var chip = make('span', cls, b.label);
        chip.title = b.label;
        row.appendChild(chip);
      }
    }

    var EVENT_KINDS = { cheer:1, sub:1, raid:1, superchat:1, supersticker:1, membership:1, system:1 };

    function addEventRow(m) {
      var row = make('div', 'event');
      row.setAttribute('data-id', m.id);
      row.setAttribute('data-author', m.author);
      row.setAttribute('data-channel', m.channel);
      if (m.accentColor) {
        row.style.borderLeftColor = m.accentColor;
        row.style.background = hexFade(m.accentColor);
      }

      var head = make('div', 'ehead');
      var badge = make('span', 'badge ' + m.platform, m.platform === 'twitch' ? 'T' : 'YT');
      head.appendChild(badge);
      head.appendChild(make('span', 'etitle', m.eventText || m.author));
      if (m.amount) head.appendChild(make('span', 'amount', m.amount));
      row.appendChild(head);

      if ((m.segments && m.segments.length) || m.content) {
        var body = make('div', 'ebody');
        renderBody(body, m);
        row.appendChild(body);
      }
      return row;
    }

    function hexFade(hex) {
      var h = hex.replace('#','');
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      var n = parseInt(h, 16);
      if (isNaN(n)) return 'rgba(145,71,255,0.12)';
      var r = (n>>16)&255, g = (n>>8)&255, b = n&255;
      return 'rgba(' + r + ',' + g + ',' + b + ',0.14)';
    }

    function addMsg(m) {
      var row;
      if (EVENT_KINDS[m.kind] && m.kind !== 'chat') {
        row = addEventRow(m);
      } else {
        row = make('div', 'msg ' + m.platform + (m.kind === 'action' ? ' action' : ''));
        row.setAttribute('data-id', m.id);
        row.setAttribute('data-author', m.author);
        row.setAttribute('data-channel', m.channel);

        var badge = make('span', 'badge ' + m.platform, m.platform === 'twitch' ? 'T' : 'YT');
        var chan  = make('span', 'chan', m.channel);
        chan.title = m.channel;
        row.appendChild(badge);
        row.appendChild(chan);
        badges(row, m);

        var user = make('span', 'user', m.author);
        if (m.authorColor) user.style.color = m.authorColor;
        row.appendChild(user);

        if (m.kind === 'action') {
          var atext = make('span', 'text');
          if (m.authorColor) atext.style.color = m.authorColor;
          renderBody(atext, m);
          row.appendChild(atext);
        } else {
          row.appendChild(make('span', 'colon', ':'));
          var text = make('span', 'text');
          renderBody(text, m);
          row.appendChild(text);
        }
      }

      chat.appendChild(row);
      count++;

      if (count > MAX) {
        var old = chat.firstElementChild;
        if (old) { old.remove(); count--; }
      }

      if (pinned) chat.scrollTop = chat.scrollHeight;
    }

    function removeMatching(pred) {
      var rows = chat.children;
      for (var i = rows.length - 1; i >= 0; i--) {
        if (pred(rows[i])) { rows[i].remove(); count--; }
      }
    }

    function onDelete(ev) {
      if (ev.messageId) {
        removeMatching(function(r) { return r.getAttribute('data-id') === ev.messageId; });
      } else if (ev.author) {
        removeMatching(function(r) {
          return r.getAttribute('data-channel') === ev.channel &&
                 r.getAttribute('data-author') === ev.author;
        });
      } else {
        removeMatching(function(r) { return r.getAttribute('data-channel') === ev.channel; });
      }
    }

    function renderStatus(list) {
      side.textContent = '';
      var groups = [
        { platform: 'twitch',  title: 'TWITCH' },
        { platform: 'youtube', title: 'YOUTUBE' }
      ];
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        var items = list.filter(function(c) { return c.platform === grp.platform; });
        side.appendChild(make('div', 'grp ' + grp.platform, grp.title));
        if (!items.length) {
          side.appendChild(make('div', 'empty', 'none configured'));
          continue;
        }
        for (var i = 0; i < items.length; i++) {
          var c = items[i];
          var ch = make('div', 'ch');
          ch.appendChild(make('span', 'cdot ' + c.state));
          var name = make('span', 'cname', c.name);
          name.title = c.name + ' — ' + c.state;
          ch.appendChild(name);
          side.appendChild(ch);
        }
      }
    }

    function handle(ev) {
      if (ev.type === 'message') addMsg(ev.data);
      else if (ev.type === 'status') renderStatus(ev.data);
      else if (ev.type === 'delete') onDelete(ev);
    }

    function connect() {
      var es = new EventSource('/events');
      es.onopen   = function() { dot.className = 'live'; stxt.textContent = 'Live'; };
      es.onerror  = function() { dot.className = 'err';  stxt.textContent = 'Reconnecting'; };
      es.onmessage = function(e) {
        try { handle(JSON.parse(e.data)); } catch(_) {}
      };
    }

    connect();
  </script>
</body>
</html>`;

/** Stable derived color for an author name (used when the platform gives none). */
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 65%, 60%)`;
}

export function createServer(settings: Settings): Emitter {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  // Seed one status entry per configured channel, all "connecting" until a client reports in.
  const statuses = new Map<string, ChannelStatus>();
  const key = (platform: Platform, name: string) => `${platform}:${name}`;
  for (const name of settings.twitch.channels) {
    statuses.set(key("twitch", name), { platform: "twitch", name, state: "connecting" });
  }
  for (const ch of settings.youtube.channels) {
    const name = ch.handle ?? ch.channelId ?? ch.videoId ?? "unknown";
    statuses.set(key("youtube", name), { platform: "youtube", name, state: "connecting" });
  }

  function broadcast(event: ServerEvent): void {
    const frame = enc.encode("data: " + JSON.stringify(event) + "\n\n");
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
            // Push the current channel roster so the panel populates immediately.
            const snapshot: ServerEvent = { type: "status", data: [...statuses.values()] };
            ctrl.enqueue(enc.encode("data: " + JSON.stringify(snapshot) + "\n\n"));
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

  return {
    message(msg: ChatMessage): void {
      if (!msg.authorColor) msg.authorColor = colorFor(msg.author);
      broadcast({ type: "message", data: msg });
    },
    delete(ev: DeleteEvent): void {
      broadcast({ type: "delete", ...ev });
    },
    status(platform: Platform, name: string, state: ChannelState): void {
      const k = key(platform, name);
      const existing = statuses.get(k);
      if (existing && existing.state === state) return;
      statuses.set(k, { platform, name, state });
      broadcast({ type: "status", data: [...statuses.values()] });
    },
  };
}

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
import {
  isLoopbackAddr,
  parseYouTubeKeyBody,
  type ServerHooks,
} from "./control.ts";
import { describeFakeAction, parseFakeAction } from "./fake.ts";

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

    /* ---- OBS overlay mode (visit /overlay or add ?overlay) ----
       Transparent page, messages only, anchored to the bottom; older messages
       slide up and clip off the top (a soft top fade smooths the exit). Drop it
       into an OBS browser source — no chroma key needed, the page is see-through. */
    body.overlay {
      background: transparent;
      font-size: 15px;
    }
    body.overlay header,
    body.overlay #side,
    body.overlay #jump { display: none; }
    body.overlay #main { background: transparent; }
    body.overlay #chat {
      background: transparent;
      overflow: hidden;            /* no scrollbar; oldest rows clip off the top */
      padding: 6px 12px 10px;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 56px);
      mask-image: linear-gradient(to bottom, transparent 0, #000 56px);
    }
    body.overlay .chan { display: none; }   /* the T/YT badge already shows source */
    /* Each row gets its own translucent dark pill so the near-white text stays
       legible over any video — or a plain browser tab — while the page itself
       stays see-through for OBS. text-shadow adds extra bite at the glyph edges. */
    body.overlay #chat .msg,
    body.overlay #chat .event {
      background: rgba(0,0,0,0.55);
      border-radius: 6px;
      margin: 0 0 4px;
      padding: 3px 10px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.95), 0 0 5px rgba(0,0,0,0.8);
    }
    /* Enhancement: each new overlay row pops in (event rows also glow their accent,
       set inline in JS). Purely cosmetic; the default viewer is left untouched. */
    @keyframes popIn {
      from { opacity: 0; transform: translateY(8px) scale(0.98); }
      to   { opacity: 1; transform: none; }
    }
    body.overlay #chat .msg,
    body.overlay #chat .event { animation: popIn 0.28s ease-out; }

    /* ---- OBS alerts mode (visit /alerts or add ?alerts) ----
       A dedicated shoutout box: one big animated card at a time, centered,
       auto-dismissing (a queue plays them in order). Transparent for OBS. */
    body.alerts { background: transparent; }
    body.alerts header,
    body.alerts #side,
    body.alerts #chat,
    body.alerts #jump { display: none; }
    body.alerts #main { background: transparent; }

    #alert-stage {
      display: none;
      position: fixed;
      inset: 0;
      align-items: center;
      justify-content: center;
      padding: 24px;
      pointer-events: none;
    }
    body.alerts #alert-stage { display: flex; }

    /* The card is a normal .event row (built by addEventRow) scaled way up. */
    .alert-card {
      min-width: 320px;
      max-width: 82vw;
      margin: 0;
      border-left-width: 7px;
      border-radius: 14px;
      background: rgba(0,0,0,0.74);
      padding: 20px 30px;
      font-size: 30px;
      text-shadow: 0 2px 6px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.8);
      opacity: 0;
      transform: scale(0.82);
      transition: transform 0.4s cubic-bezier(.2,1.3,.35,1), opacity 0.4s ease;
    }
    .alert-card.show { opacity: 1; transform: scale(1); }
    .alert-card.exit { opacity: 0; transform: scale(1) translateY(-18px); }
    .alert-card .ehead { gap: 0 10px; }
    .alert-card .amount { font-size: 0.62em; }
    .alert-card .ebody { font-size: 0.66em; margin-top: 10px; }
    .alert-card .badge { font-size: 0.4em; }

    /* ---- Theme: "company-memo" ("The Company, Inc") ----
       An opaque office-memo note on paper. Overrides the dark card look; the
       three-class selectors beat the base .alert-card.show/.exit so the slight
       paper rotation is preserved through enter/exit. */
    .alert-card.memo {
      background: #f4efdc;
      color: #1b1b1b;
      border-left: none;
      border-top: 14px solid #c8bf9c;
      border-radius: 3px;
      padding: 26px 34px 22px;
      font-family: "Courier New", Courier, monospace;
      text-shadow: none;
      box-shadow: 0 14px 34px rgba(0,0,0,0.55);
      transform: scale(0.82) rotate(-1.6deg);
    }
    .alert-card.memo.show { opacity: 1; transform: scale(1) rotate(-1.6deg); }
    .alert-card.memo.exit { opacity: 0; transform: scale(1) rotate(-1.6deg) translateY(-20px); }
    .memo-head { font-weight: 700; letter-spacing: 0.14em; font-size: 0.6em; color: #6a5b2e; }
    .memo-sub {
      font-size: 0.32em; letter-spacing: 0.34em; color: #9a8f68;
      margin: 2px 0 16px; padding-bottom: 9px; border-bottom: 1px solid #d8cfae;
    }
    .memo-line { font-size: 1em; font-weight: 700; line-height: 1.3; }
    .memo-w { position: relative; display: inline-block; }
    /* The redaction bar: a black rectangle that wipes across a word before exit. */
    .memo-w.redacted::after {
      content: ""; position: absolute; left: -3px; top: -1px; bottom: -1px;
      width: 0; background: #111; animation: redact 0.5s ease-out forwards;
    }
    @keyframes redact { from { width: 0; } to { width: calc(100% + 6px); } }
    .memo-stamp {
      margin-top: 16px; display: inline-block; color: #b5322b;
      border: 2px solid #b5322b; border-radius: 4px; padding: 2px 9px;
      font-size: 0.3em; letter-spacing: 0.2em; transform: rotate(-6deg); opacity: 0.85;
    }
  </style>
  <!--ALERTS-->
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
  <div id="alert-stage"></div>
  <button id="jump" onclick="jumpBottom()">&#9660; Latest</button>
  <script>
    var chat = document.getElementById('chat');
    var side = document.getElementById('side');
    var dot  = document.getElementById('dot');
    var stxt = document.getElementById('stxt');
    var jump = document.getElementById('jump');
    var stage = document.getElementById('alert-stage');
    var pinned = true;
    var count  = 0;
    var MAX    = 500;

    var params = new URLSearchParams(location.search);
    // OBS overlay mode: /overlay or ?overlay → transparent, messages-only, bottom-anchored.
    var overlayMode = location.pathname === '/overlay' || params.has('overlay');
    if (overlayMode) document.body.classList.add('overlay');
    // OBS alerts mode: /alerts or ?alerts → transparent, one animated shoutout at a time.
    var alertsMode = location.pathname === '/alerts' || params.has('alerts');
    if (alertsMode) document.body.classList.add('alerts');

    // Alert theme: the active theme is injected as window.MULTICHAT_ALERTS (from
    // settings.json); ?theme=NAME overrides it for testing / per-source setups.
    var alertsCfg = window.MULTICHAT_ALERTS || {};
    var themeOverride = params.get('theme');
    var activeThemeName = themeOverride !== null ? themeOverride : (alertsCfg.activeTheme || '');
    var activeTheme = null;
    if (activeThemeName && alertsCfg.themes) {
      for (var ti = 0; ti < alertsCfg.themes.length; ti++) {
        if (alertsCfg.themes[ti].name === activeThemeName) { activeTheme = alertsCfg.themes[ti]; break; }
      }
    }
    // The theme that should render an event of this kind, or null for the default
    // card. A theme with no explicit events list covers all shoutout kinds.
    function themeForKind(kind) {
      if (!activeTheme) return null;
      var evs = activeTheme.events;
      if (evs && evs.length && evs.indexOf(kind) === -1) return null;
      return activeTheme;
    }

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

    var EVENT_KINDS = { cheer:1, sub:1, raid:1, follow:1, superchat:1, supersticker:1, membership:1, system:1 };
    // Shoutout kinds the /alerts overlay pops up (everything highlighted except plain
    // system notices like sub-only-mode / announcements, which aren't shoutouts).
    var ALERT_KINDS = { cheer:1, sub:1, raid:1, follow:1, superchat:1, supersticker:1, membership:1 };

    function addEventRow(m) {
      var row = make('div', 'event');
      row.setAttribute('data-id', m.id);
      row.setAttribute('data-author', m.author);
      row.setAttribute('data-channel', m.channel);
      if (m.accentColor) {
        row.style.borderLeftColor = m.accentColor;
        // In overlay/alerts mode the CSS gives each row a dark pill; the faint accent
        // tint would sit on top of it and hurt legibility, so keep just the border,
        // plus an accent-colored glow for a bit of pop.
        if (!overlayMode && !alertsMode) row.style.background = hexFade(m.accentColor);
        else row.style.boxShadow = '0 0 14px ' + m.accentColor;
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

    // ---- /alerts overlay: a queue that plays one shoutout card at a time ----
    var alertQ = [];
    var alertBusy = false;
    var ALERT_HOLD_MS = 6000;   // time a card stays fully visible
    var ALERT_ANIM_MS = 450;    // enter/exit transition (matches CSS .alert-card)
    var ALERT_QMAX = 50;        // drop oldest beyond this so a burst can't pile up

    function enqueueAlert(m) {
      alertQ.push(m);
      if (alertQ.length > ALERT_QMAX) alertQ.shift();
      if (!alertBusy) playNextAlert();
    }

    // Word used in the memo line, per event kind. Kept to a single word so the
    // "three words" redaction gag ([name] / just / [action]) stays intact.
    var COMPANY_ACTION = {
      follow: 'followed', sub: 'subscribed', membership: 'joined',
      cheer: 'cheered', raid: 'raided', superchat: 'donated', supersticker: 'donated'
    };

    // "The Company, Inc" — an office memo that redacts one of its three words
    // right before it leaves. Returns the alert-lifecycle shape buildAlert uses.
    function buildCompanyMemo(m, theme) {
      var opts = theme.options || {};
      var card = make('div', 'alert-card memo');
      if (opts.paper) card.style.background = opts.paper;
      if (opts.ink) card.style.color = opts.ink;
      card.appendChild(make('div', 'memo-head', 'THE COMPANY, INC'));
      card.appendChild(make('div', 'memo-sub', 'INTERNAL MEMO'));

      var line = make('div', 'memo-line');
      var wName = make('span', 'memo-w', m.author);
      var wJust = make('span', 'memo-w', 'just');
      var wAct  = make('span', 'memo-w', COMPANY_ACTION[m.kind] || 'subscribed');
      line.appendChild(wName);
      line.appendChild(document.createTextNode(' '));
      line.appendChild(wJust);
      line.appendChild(document.createTextNode(' '));
      line.appendChild(wAct);
      line.appendChild(document.createTextNode('!'));
      card.appendChild(line);
      card.appendChild(make('div', 'memo-stamp', 'CONFIDENTIAL'));

      var words = [wName, wJust, wAct];
      function beforeExit(el, done) {
        if (opts.redact === false) { setTimeout(done, 250); return; }
        // Redact one of the three words (black bar wipes across), hold, then exit.
        words[Math.floor(Math.random() * words.length)].classList.add('redacted');
        setTimeout(done, 1100);
      }
      var hold = typeof opts.hold === 'number' ? opts.hold : 4500;
      return { el: card, holdMs: hold, exitMs: ALERT_ANIM_MS, beforeExit: beforeExit };
    }

    function buildDefaultAlert(m) {
      var card = addEventRow(m);        // reuse the event-row builder
      card.classList.add('alert-card');
      return { el: card, holdMs: ALERT_HOLD_MS, exitMs: ALERT_ANIM_MS };
    }

    // Pick the renderer for this event: a theme's style if one covers the kind,
    // else the default card. New styles slot in here.
    function buildAlert(m) {
      var theme = themeForKind(m.kind);
      if (theme && theme.style === 'company-memo') return buildCompanyMemo(m, theme);
      return buildDefaultAlert(m);
    }

    function playNextAlert() {
      var m = alertQ.shift();
      if (!m) { alertBusy = false; return; }
      alertBusy = true;
      var a = buildAlert(m);
      var holdMs = a.holdMs != null ? a.holdMs : ALERT_HOLD_MS;
      var exitMs = a.exitMs != null ? a.exitMs : ALERT_ANIM_MS;
      stage.textContent = '';
      stage.appendChild(a.el);
      // Two frames so the browser paints the initial (hidden) state before we
      // add .show, otherwise the enter transition doesn't run.
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { a.el.classList.add('show'); });
      });
      setTimeout(function() {
        function exit() {
          a.el.classList.remove('show');
          a.el.classList.add('exit');
          setTimeout(playNextAlert, exitMs);
        }
        if (a.beforeExit) a.beforeExit(a.el, exit); else exit();
      }, holdMs);
    }

    function handle(ev) {
      if (ev.type === 'message') {
        // In alerts mode only shoutout kinds are shown, one at a time; everything
        // else (plain chat, system notices) is ignored. Other modes render inline.
        if (alertsMode) { if (ALERT_KINDS[ev.data.kind]) enqueueAlert(ev.data); }
        else addMsg(ev.data);
      }
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
export function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 65%, 60%)`;
}

// Upper bound on concurrent SSE viewers. A multichat overlay needs a handful (OBS sources,
// a monitor or two); the cap stops an exposed port from being flooded with open streams.
const MAX_SSE_CLIENTS = 50;

export function createServer(
  settings: Settings,
  hooks: ServerHooks = {},
): Emitter {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  // Bake the alerts theme registry into the page as window.MULTICHAT_ALERTS so the
  // overlay picks up the configured theme with no extra request. Escape "<" so a
  // theme name can't break out of the <script> tag.
  const alertsJson = JSON.stringify(settings.alerts ?? {}).replace(
    /</g,
    "\\u003c",
  );
  const pageHtml = HTML.replace(
    "<!--ALERTS-->",
    `<script>window.MULTICHAT_ALERTS=${alertsJson}</script>`,
  );

  // Seed one status entry per configured channel, all "connecting" until a client reports in.
  const statuses = new Map<string, ChannelStatus>();
  const key = (platform: Platform, name: string) => `${platform}:${name}`;
  for (const name of settings.twitch.channels) {
    statuses.set(key("twitch", name), {
      platform: "twitch",
      name,
      state: "connecting",
    });
  }
  for (const ch of settings.youtube.channels) {
    const name = ch.handle ?? ch.channelId ?? ch.videoId ?? "unknown";
    statuses.set(key("youtube", name), {
      platform: "youtube",
      name,
      state: "connecting",
    });
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

  // The live sink. Defined before Deno.serve so the /api/fake route can inject
  // through the very same path a real platform message takes (colorFor fill,
  // status registry, broadcast) — a faked event is indistinguishable downstream.
  const emitter: Emitter = {
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

  Deno.serve(
    {
      port: settings.server.port,
      hostname: settings.server.host,
      onListen({ hostname, port }) {
        console.log(`Listening on http://${hostname}:${port}`);
      },
    },
    async (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
      const { pathname } = new URL(req.url);

      // Runtime control: set the YouTube API key on the live server. Loopback-only
      // because the viewer is unauthenticated and may bind 0.0.0.0 — without this
      // guard the whole LAN could set the key. See control.ts.
      if (pathname === "/api/youtube-key") {
        // Tag every control response so the CLI can tell multichat apart from
        // some *other* server it reached on a mistaken port (which would 401/404
        // without this header) and give a "wrong --port?" hint instead.
        const ctl = (body: string, status: number) =>
          new Response(body, { status, headers: { "x-multichat": "control" } });
        if (req.method !== "POST") return ctl("Method Not Allowed\n", 405);
        if (!isLoopbackAddr(info.remoteAddr)) {
          return ctl("Forbidden: the control endpoint is loopback-only\n", 403);
        }
        if (!hooks.setYouTubeKey) {
          return ctl("Runtime key control is not available\n", 501);
        }
        const key = parseYouTubeKeyBody(
          await req.text(),
          req.headers.get("content-type"),
        );
        if (!key) return ctl("Bad Request: empty or unparseable key\n", 400);
        const result = await hooks.setYouTubeKey(key);
        return ctl(result.message + "\n", result.ok ? 200 : 500);
      }

      // Runtime testing aid: inject a fake chat event straight into the SSE feed
      // so you can preview how each message kind renders without a live stream.
      // Loopback-only for the same reason as the key endpoint — the viewer is
      // unauthenticated and may bind 0.0.0.0. Driven by `multichat fake`. See fake.ts.
      if (pathname === "/api/fake") {
        const ctl = (body: string, status: number) =>
          new Response(body, { status, headers: { "x-multichat": "control" } });
        if (req.method !== "POST") return ctl("Method Not Allowed\n", 405);
        if (!isLoopbackAddr(info.remoteAddr)) {
          return ctl(
            "Forbidden: the fake-event endpoint is loopback-only\n",
            403,
          );
        }
        const parsed = parseFakeAction(await req.text());
        if (!parsed.ok) {
          return ctl("Bad Request: " + parsed.message + "\n", 400);
        }
        const a = parsed.action;
        if (a.action === "message") emitter.message(a.data);
        else if (a.action === "delete") emitter.delete(a.data);
        else emitter.status(a.data.platform, a.data.name, a.data.state);
        return ctl("Injected: " + describeFakeAction(a) + "\n", 200);
      }

      if (pathname === "/events") {
        if (clients.size >= MAX_SSE_CLIENTS) {
          return new Response("Too many connections", { status: 503 });
        }
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            clients.add(ctrl);
            ctrl.enqueue(enc.encode(": connected\n\n"));
            // Push the current channel roster so the panel populates immediately.
            const snapshot: ServerEvent = {
              type: "status",
              data: [...statuses.values()],
            };
            ctrl.enqueue(
              enc.encode("data: " + JSON.stringify(snapshot) + "\n\n"),
            );
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

      if (
        pathname === "/" || pathname === "/index.html" ||
        pathname === "/overlay" || pathname === "/alerts"
      ) {
        return new Response(pageHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  );

  return emitter;
}

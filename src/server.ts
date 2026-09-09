import type {
  ChannelState,
  ChannelStatus,
  ChatMessage,
  DeleteEvent,
  Emitter,
  GiveawayDraw,
  GiveawayState,
  Platform,
  ServerEvent,
  Settings,
} from "./types.ts";
import {
  checkControlAccess,
  isLoopbackAddr,
  normalizeControlAccess,
  parseYouTubeKeyBody,
  type ServerHooks,
} from "./control.ts";
import { describeFakeAction, parseFakeAction } from "./fake.ts";
import { parseGiveawayAction } from "./giveaway.ts";
import { parseTurnReport } from "./integrations.ts";

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
      /* flex-basis 60% (not the 0 that a bare "flex: 1" implies) so the message
         drops onto its own full-width line once the badges + username take past
         ~40% of the row, instead of being crushed into the leftover sliver and
         wrapping one letter per line — the failure a narrow, large-font OBS
         overlay hits. When there's room it still sits inline after the name and
         grows to fill the rest; min-width:0 stays so a long token can still
         break once the text is on its own line. */
      flex: 1 1 60%;
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
       Transparent page, messages only: new ones land at the bottom and older
       ones slide up and clip off the top (a soft fade smooths the exit edge).
       Drop it into an OBS browser source — no chroma key needed, the page is
       see-through. ?direction=up mirrors the flow; see body.up below. */
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
    /* The base .user is flex-shrink:0 with no width cap, so a long single-token
       name at a large overlay font would spill past the pill (clipped by #chat's
       overflow:hidden). In overlay, let it shrink and — only when a single token
       is still wider than the row — break, instead of overflowing: flex-shrink:1
       + min-width:0 let the box shrink below the name's intrinsic width, and
       overflow-wrap:anywhere then supplies the in-word break so the glyphs
       reflow inside the narrowed box. Shrink only fires when the line actually
       overflows, so ordinary names render untouched. */
    body.overlay .user {
      flex-shrink: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
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

    /* ---- Newest-first flow (add ?direction=up) ----
       The mirror image of the default: addMsg inserts each row at the top
       instead of appending, so everything anchored to an edge flips with it —
       the breathing room at the newest end, the gap between rows, the overlay's
       exit fade, and the direction the row pops in from. No layout change is
       needed: #chat is a plain block, so content already starts at the top and
       grows down. (If the default flow is ever made a true bottom-anchored flex
       column, scope it to body.overlay:not(.up) — it would break this.) */
    body.up #chat { padding: 8px 0 4px; }
    /* The pill means "jump to newest", so it belongs at the newest end — clear of
       the header rather than pinned to the now-oldest bottom edge. Viewer only:
       #jump is hidden in both OBS modes. */
    body.up #jump { top: 44px; bottom: auto; }
    body.overlay.up #chat {
      padding: 10px 12px 6px;
      /* Belt and braces: inserting rows above the scroll offset is exactly what
         scroll anchoring compensates for, but here scrollTop never leaves 0 (no
         scrollbar, and scrollToNewest pins it) and browsers skip anchoring while a
         scroller sits at the block start — so today this changes nothing. It only
         bites if that stops being true, and then the pin should still win.
         Deliberately not applied to the scrollable viewer, where anchoring is
         what keeps a scrolled-back reader from being shoved along. */
      overflow-anchor: none;
      -webkit-mask-image: linear-gradient(to top, transparent 0, #000 56px);
      mask-image: linear-gradient(to top, transparent 0, #000 56px);
    }
    @keyframes popInUp {
      from { opacity: 0; transform: translateY(-8px) scale(0.98); }
      to   { opacity: 1; transform: none; }
    }
    /* Outranks the two base body.overlay #chat rules above (one more class), so
       the margin moves to the top edge and only the keyframes name is swapped —
       duration and easing still come from the base animation shorthand. */
    body.overlay.up #chat .msg,
    body.overlay.up #chat .event { margin: 4px 0 0; animation-name: popInUp; }

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
  <button id="jump" onclick="jumpNewest()">&#9660; Latest</button>
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
    // OBS overlay mode: /overlay or ?overlay → transparent, messages-only.
    var overlayMode = location.pathname === '/overlay' || params.has('overlay');
    if (overlayMode) document.body.classList.add('overlay');
    // OBS alerts mode: /alerts or ?alerts → transparent, one animated shoutout at a time.
    var alertsMode = location.pathname === '/alerts' || params.has('alerts');
    if (alertsMode) document.body.classList.add('alerts');

    // Message direction: ?direction=up grows the feed upward — new messages at the
    // top, older ones pushed down and off the bottom. Anything else (including a
    // typo) keeps the default ?direction=down flow, so a bad URL degrades to
    // today's behavior rather than an empty source.
    var upMode = params.get('direction') === 'up';
    if (upMode) {
      document.body.classList.add('up');
      // The page HTML is static, so the jump button's ▼ is re-pointed here.
      jump.textContent = '▲ Latest';
    }

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

    // The "newest end" of the feed is the bottom by default and the top in up mode.
    // Everything that scrolls goes through these two so that sign convention is
    // stated once instead of being spelled out at each call site.
    function atNewest() {
      if (upMode) return chat.scrollTop <= 60;
      return chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60;
    }

    function scrollToNewest() {
      chat.scrollTop = upMode ? 0 : chat.scrollHeight;
    }

    chat.addEventListener('scroll', function() {
      if (atNewest()) {
        pinned = true;
        jump.classList.remove('show');
      } else if (pinned) {
        pinned = false;
        jump.classList.add('show');
      }
    });

    function jumpNewest() {
      scrollToNewest();
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

      // Up mode puts the new row at the top, which also moves the oldest row to
      // the other end — both halves read off upMode so the cap can never trim the
      // row that was just added (that would silently freeze the feed at MAX).
      if (upMode) chat.insertBefore(row, chat.firstChild);
      else chat.appendChild(row);
      count++;

      if (count > MAX) {
        var old = upMode ? chat.lastElementChild : chat.firstElementChild;
        if (old) { old.remove(); count--; }
      }

      if (pinned) scrollToNewest();
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

// The operator-facing giveaway page + transparent OBS overlay. A standalone page
// (not the chat renderer): it reads the same /events SSE stream but only acts on
// `giveaway` frames, driving the giveaway via the loopback POST /api/giveaway
// endpoint. The reveal is a CS2-style horizontal "case" reel that eases onto the
// winner. `?overlay` = transparent, controls hidden, auto-hides between draws —
// drop it into OBS as a browser source. Open the control view on the same machine
// as the server (the control endpoint is loopback-only).
const GIVEAWAY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Multichat — Giveaway</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0e0e10; color: #efeff1; font-size: 14px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100dvh; display: flex; flex-direction: column;
    }
    header {
      padding: 10px 16px; background: #18181b; border-bottom: 1px solid #26262c;
      display: flex; align-items: center; gap: 12px; flex-shrink: 0;
    }
    h1 { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; }
    #conn { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8e8e9a; }
    #dot { width: 7px; height: 7px; border-radius: 50%; background: #555; }
    #dot.live { background: #00b173; } #dot.err { background: #eb0400; }

    #stage { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 26px 14px 10px; }
    #reel { position: relative; width: 100%; max-width: 940px; height: 172px; overflow: hidden; border-radius: 10px; }
    body:not(.overlay) #reel { background: #131316; border: 1px solid #26262c; }
    #strip { position: absolute; left: 0; top: 0; height: 100%; display: flex; align-items: center; will-change: transform; }
    /* Center ticker the winning card settles under. */
    #marker { position: absolute; left: 50%; top: 0; bottom: 0; width: 0; transform: translateX(-50%); z-index: 3;
      border-left: 2px solid #ffcf3f; box-shadow: 0 0 12px #ffcf3f; }
    #marker::before, #marker::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%);
      border-left: 9px solid transparent; border-right: 9px solid transparent; }
    #marker::before { top: -1px; border-top: 11px solid #ffcf3f; }
    #marker::after  { bottom: -1px; border-bottom: 11px solid #ffcf3f; }
    /* Edge fades — control view only; the overlay is transparent already. */
    .fade { position: absolute; top: 0; bottom: 0; width: 96px; z-index: 2; pointer-events: none; }
    .fade.l { left: 0; } .fade.r { right: 0; }
    body:not(.overlay) .fade.l { background: linear-gradient(90deg, #131316, #13131600); }
    body:not(.overlay) .fade.r { background: linear-gradient(270deg, #131316, #13131600); }
    #idle { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: #5a5a64; font-style: italic; z-index: 1; }

    .card { width: 108px; height: 140px; flex: 0 0 auto; margin-right: 8px; position: relative;
      background: linear-gradient(180deg, #1c1c22, #141417); border: 1px solid #2c2c34; border-radius: 8px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
      box-shadow: 0 2px 6px #0006; }
    .card .bar { position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--c); border-radius: 8px 8px 0 0; }
    .card .av { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 22px; color: #0e0e10; }
    .card .nm { font-size: 12px; font-weight: 600; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card.win { border-color: #ffcf3f; box-shadow: 0 0 0 2px #ffcf3f, 0 0 26px #ffcf3f99; transform: translateY(-2px); }

    .card .num { position: absolute; top: 7px; right: 6px; font-size: 10px; font-weight: 700; color: #8e8e9a; }

    #winner { min-height: 30px; font-size: 22px; font-weight: 800; text-align: center; }
    #winner .name { color: #ffcf3f; text-shadow: 0 0 18px #ffcf3f66; }
    #winner .tier {
      display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 9px;
      font-size: 11px; font-weight: 700; vertical-align: middle;
      background: #2b2b31; color: #adadb8; border: 1px solid #3a3a42;
    }
    #winner .tier.guaranteed { background: #06331f; color: #00e29a; border-color: #0a4f30; }

    /* Follower-milestone progress (only rendered when followerStep > 0). */
    #progWrap { width: 100%; max-width: 560px; display: none; }
    #progWrap.on { display: block; }
    #progLabel { display: flex; justify-content: space-between; font-size: 11px; color: #8e8e9a; margin-bottom: 4px; }
    #progLabel b { color: #efeff1; }
    #progBar { height: 10px; border-radius: 5px; background: #1c1c22; border: 1px solid #2c2c34; overflow: hidden; }
    #progFill { height: 100%; width: 0%; border-radius: 5px; background: linear-gradient(90deg, #9147ff, #ffcf3f); transition: width 0.5s ease; }
    #progNote { font-size: 11px; color: #6c6c78; margin-top: 3px; text-align: center; }
    #progNote .cred { color: #ffcf3f; font-weight: 700; }
    #progNote.unavail { color: #ff8a84; }

    /* Milestone-crossed flourish. */
    #milestone {
      display: none; padding: 8px 18px; border-radius: 8px; text-align: center;
      font-weight: 800; font-size: 16px; color: #0e0e10;
      background: linear-gradient(90deg, #ffcf3f, #ffa63f);
      box-shadow: 0 0 26px #ffcf3f88; animation: mspop 0.45s ease;
    }
    #milestone.show { display: block; }
    @keyframes mspop { from { transform: scale(0.7); opacity: 0; } to { transform: scale(1); opacity: 1; } }

    /* Winners panel (fetched on demand — the mailing list). */
    #winsWrap { width: 100%; max-width: 640px; display: none; }
    #winsWrap.on { display: block; }
    #winsList { list-style: none; display: flex; flex-direction: column; gap: 3px; max-height: 40vh; overflow-y: auto; }
    #winsList li { display: flex; align-items: baseline; gap: 8px; padding: 4px 9px; background: #161618; border-radius: 5px; font-size: 12px; }
    #winsList li .wnum { color: #ffcf3f; font-weight: 700; flex-shrink: 0; min-width: 40px; }
    #winsList li .wtier { color: #8e8e9a; font-size: 11px; }
    #winsList li .wwhen { margin-left: auto; color: #6c6c78; font-size: 11px; white-space: nowrap; }
    button.danger { border-color: #5a2a2a; color: #ff8a84; }
    button.danger:hover { background: #3a2323; }

    #panel { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 4px 16px 26px; }
    #hint { font-size: 12px; color: #adadb8; text-align: center; }
    #hint b { color: #efeff1; }
    #controls { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    button {
      background: #2b2b31; color: #efeff1; border: 1px solid #3a3a42;
      border-radius: 6px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #35353c; }
    button:disabled { opacity: 0.4; cursor: default; }
    button.spin { background: #9147ff; border-color: #9147ff; }
    button.spin:hover:not(:disabled) { background: #a06bff; }
    #state { font-size: 12px; color: #8e8e9a; text-align: center; }
    .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-weight: 700; }
    .pill.open { background: #06331f; color: #00e29a; }
    .pill.closed { background: #3a2323; color: #ff8a84; }
    #listWrap { width: 100%; max-width: 560px; }
    #listWrap h2 { font-size: 11px; letter-spacing: 0.08em; color: #6c6c78; margin-bottom: 8px; text-align: center; }
    #list { list-style: none; display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; }
    #list li { display: flex; align-items: center; gap: 7px; padding: 4px 8px; background: #161618; border-radius: 5px; font-size: 12px; }
    #list li .sw { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }
    #list li button { padding: 2px 7px; font-size: 12px; font-weight: 500; }
    #filter {
      display: block; width: 100%; margin-bottom: 8px; padding: 7px 10px;
      background: #0e0e10; color: #efeff1; border: 1px solid #2a2a31;
      border-radius: 5px; font-size: 12px; font-family: inherit;
    }
    #filter:focus { outline: none; border-color: #4b4b57; }
    #fnote { font-size: 11px; color: #6c6c78; text-align: center; margin-bottom: 8px; min-height: 14px; }
    #empty { color: #5a5a64; font-style: italic; font-size: 12px; }
    #disabled { display: none; padding: 20px; text-align: center; color: #ff8a84; }
    body.off #stage, body.off #panel { display: none; } body.off #disabled { display: block; }

    /* ---- transparent OBS overlay (visit /giveaway?overlay) ---- */
    body.overlay { background: transparent; }
    body.overlay header, body.overlay #panel, body.overlay #disabled { display: none; }
    body.overlay #stage { min-height: 100dvh; justify-content: center; opacity: 1; transition: opacity 0.6s ease; }
    body.overlay #stage.hidden { opacity: 0; }
    body.overlay #winner { font-size: 30px; text-shadow: 0 2px 10px #000; }
    /* ?overlay&progress: a small always-on corner pill with follower progress. */
    #progPill {
      display: none; position: fixed; right: 14px; bottom: 14px; z-index: 5;
      padding: 7px 14px; border-radius: 16px; font-size: 13px; font-weight: 700;
      background: #18181bee; border: 1px solid #3a3a42; color: #efeff1;
      text-shadow: none;
    }
    #progPill .cred { color: #ffcf3f; }
    body.overlay.progress #progPill { display: block; }
  </style>
  <!--GIVEAWAY-->
</head>
<body>
  <header>
    <h1>GIVEAWAY</h1>
    <div id="conn"><div id="dot"></div><span id="ctxt">Connecting</span></div>
  </header>
  <div id="disabled">Giveaway mode is disabled. Enable it in settings.json / the NixOS module.</div>
  <div id="stage">
    <div id="milestone"></div>
    <div id="reel">
      <div id="idle">No entrants yet</div>
      <div id="strip"></div>
      <div class="fade l"></div><div class="fade r"></div>
      <div id="marker"></div>
    </div>
    <div id="winner"></div>
  </div>
  <div id="progPill"></div>
  <div id="panel">
    <div id="hint"></div>
    <div id="progWrap">
      <div id="progLabel"><span>Follower milestone</span><b id="progText"></b></div>
      <div id="progBar"><div id="progFill"></div></div>
      <div id="progNote"></div>
    </div>
    <div id="controls">
      <button class="spin" id="spinBtn" onclick="spin()">Draw winner</button>
      <button id="openBtn" onclick="act('open')">Open entries</button>
      <button id="closeBtn" onclick="act('close')">Close entries</button>
      <button id="resetBtn" onclick="resetPool()">Reset</button>
      <button id="demoBtn" onclick="demo()" title="Add sample entrants to preview the reel">Demo</button>
      <button id="winsBtn" onclick="toggleWinners()">Winners</button>
      <button id="cresetBtn" class="danger" onclick="campaignReset()"
        title="Zero follower progress + entry numbers; archives the winners log">Campaign reset</button>
    </div>
    <div id="state"></div>
    <div id="winsWrap"><h2>WINNERS</h2><ul id="winsList"></ul></div>
    <div id="listWrap">
      <h2 id="rtitle">ENTRANTS</h2>
      <input id="filter" type="search" placeholder="Filter entrants — name or #number"
        autocomplete="off" oninput="renderList()">
      <div id="fnote"></div>
      <ul id="list"></ul>
    </div>
  </div>
  <script>
    var cfg = window.MULTICHAT_GIVEAWAY || {};
    var params = new URLSearchParams(location.search);
    // OBS overlay mode: /giveaway?overlay → transparent, controls hidden, auto-hide.
    // ?overlay&progress adds a small always-on follower-progress pill.
    var overlayMode = params.has('overlay');
    if (overlayMode) document.body.classList.add('overlay');
    if (overlayMode && params.has('progress')) document.body.classList.add('progress');
    if (cfg.enabled === false) document.body.classList.add('off');

    var CARD_W = 108, GAP = 8, STRIDE = CARD_W + GAP;
    var REEL_MS = 6500, HOLD_MS = 6000, MILESTONE_MS = 6000;

    var reelEl = document.getElementById('reel');
    var strip = document.getElementById('strip');
    var idleEl = document.getElementById('idle');
    var stage = document.getElementById('stage');
    var winnerEl = document.getElementById('winner');
    var dot = document.getElementById('dot');
    var ctxt = document.getElementById('ctxt');
    var stateEl = document.getElementById('state');
    var listEl = document.getElementById('list');
    var filterEl = document.getElementById('filter');
    var fnote = document.getElementById('fnote');
    var rtitle = document.getElementById('rtitle');
    var spinBtn = document.getElementById('spinBtn');
    var hintEl = document.getElementById('hint');
    var msEl = document.getElementById('milestone');
    var pillEl = document.getElementById('progPill');
    var winsWrap = document.getElementById('winsWrap');
    var winsList = document.getElementById('winsList');
    var hideTimer = null;
    var msTimer = null;

    var pool = { open: true, entrants: [], lastWinner: null, campaign: null };
    var reelBusy = false;     // a reel animation is playing
    var awaiting = false;     // a draw was requested; awaiting the broadcast frame
    var pendingState = null;  // post-draw pool, applied once the animation ends
    // Milestone flourish: seeded from the FIRST frame (incl. the SSE replay) so a
    // reconnect never re-fires it; deferred while the reel is busy.
    var prevMilestones = null;
    var flourishPending = false;

    if (hintEl) hintEl.innerHTML = cfg.command
      ? 'Viewers type <b>' + (cfg.prefix || '!') + cfg.command + '</b>' +
        (cfg.channel ? ' in <b>#' + cfg.channel + '</b>' : '') + ' to enter.'
      : '';

    function color(seed, i) {
      var h = 0, s = String(seed || i);
      for (var k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
      return 'hsl(' + (h % 360) + ', 62%, 55%)';
    }
    function nameOf(e) { return e.displayName || e.login || e.userId || '?'; }

    function makeCard(e, key) {
      var c = document.createElement('div'); c.className = 'card';
      var col = color(e.userId, key); c.style.setProperty('--c', col);
      var bar = document.createElement('div'); bar.className = 'bar'; c.appendChild(bar);
      var av = document.createElement('div'); av.className = 'av'; av.style.background = col;
      av.textContent = nameOf(e).slice(0, 1).toUpperCase(); c.appendChild(av);
      var nm = document.createElement('div'); nm.className = 'nm';
      var n = nameOf(e); nm.textContent = n.length > 14 ? n.slice(0, 13) + '…' : n; c.appendChild(nm);
      if (e.number) {
        var num = document.createElement('div'); num.className = 'num';
        num.textContent = '#' + e.number; c.appendChild(num);
      }
      return c;
    }

    function normPool(p) {
      return {
        open: !!p.open, entrants: p.entrants || [],
        lastWinner: p.lastWinner || null, campaign: p.campaign || null,
      };
    }

    // The static "who's in" strip shown between draws (control view only; the
    // overlay stays blank/transparent until a draw).
    function renderIdle() {
      if (reelBusy) return;
      strip.style.transition = 'none';
      strip.innerHTML = '';
      var es = pool.entrants;
      if (!es.length) { idleEl.style.display = 'flex'; strip.style.transform = 'translateX(0)'; return; }
      idleEl.style.display = 'none';
      if (overlayMode) { strip.style.transform = 'translateX(0)'; return; }
      var frag = document.createDocumentFragment();
      for (var i = 0; i < es.length; i++) frag.appendChild(makeCard(es[i], i));
      strip.appendChild(frag);
      var stripW = es.length * STRIDE - GAP;
      strip.style.transform = 'translateX(' + (reelEl.clientWidth / 2 - stripW / 2) + 'px)';
    }

    function renderPanel() {
      var n = pool.entrants.length;
      var c = pool.campaign;
      if (rtitle) rtitle.textContent = 'ENTRANTS (' + n + ')';
      if (stateEl) {
        var line = 'Entries are ' +
          (pool.open ? '<span class="pill open">OPEN</span>' : '<span class="pill closed">CLOSED</span>');
        if (c && cfg.firstN > 0) {
          line += ' · ' + c.guaranteedRemaining + ' guaranteed in queue · ' +
            c.poolSize + ' in bonus pool';
        } else {
          line += ' · ' + n + ' in the pool';
        }
        if (c && c.winnersTotal > 0) line += ' · ' + c.winnersTotal + ' won';
        stateEl.innerHTML = line;
      }
      if (spinBtn) {
        spinBtn.disabled = reelBusy || awaiting || n === 0;
        // During the guaranteed phase the button reads as "next pack".
        spinBtn.textContent = (c && cfg.firstN > 0 && c.guaranteedRemaining > 0)
          ? 'Draw next pack' : 'Draw winner';
      }
      var ob = document.getElementById('openBtn'), cb = document.getElementById('closeBtn');
      if (ob) ob.disabled = pool.open;
      if (cb) cb.disabled = !pool.open;
      var wb = document.getElementById('winsBtn');
      if (wb && c) wb.textContent = 'Winners (' + c.winnersTotal + ')';
      renderProgress(c);
      renderList();
    }

    // The entrant list, narrowed by the filter box. Kept separate from
    // renderPanel so typing re-renders only the list — a pool of a few hundred
    // names is a wall to scan otherwise, and the ✕ next to the wrong one is not
    // an undoable mistake.
    function renderList() {
      if (!listEl) return;
      var q = (filterEl && filterEl.value || '').trim().toLowerCase();
      var num = q.replace(/^#/, '');
      var shown = pool.entrants.filter(function (e) {
        if (!q) return true;
        if ((e.login || '').toLowerCase().indexOf(q) >= 0) return true;
        if ((e.displayName || '').toLowerCase().indexOf(q) >= 0) return true;
        // "#12"/"12" matches the entry number exactly — a substring match there
        // would surface 12, 120 and 512 for the same keystroke.
        return num !== '' && String(e.number || '') === num;
      });
      if (fnote) {
        fnote.textContent = q
          ? shown.length + ' of ' + pool.entrants.length + ' shown'
          : '';
      }
      listEl.textContent = '';
      if (!pool.entrants.length) {
        var li = document.createElement('li'); li.id = 'empty';
        li.textContent = 'No one has entered yet.'; listEl.appendChild(li); return;
      }
      if (!shown.length) {
        var none = document.createElement('li'); none.id = 'empty';
        none.textContent = 'No entrant matches "' + q + '".'; listEl.appendChild(none); return;
      }
      shown.forEach(function (e, i) {
        var el = document.createElement('li');
        var sw = document.createElement('span'); sw.className = 'sw';
        sw.style.background = color(e.userId, i); el.appendChild(sw);
        var nm = document.createElement('span');
        nm.textContent = (e.number ? '#' + e.number + ' ' : '') + nameOf(e);
        el.appendChild(nm);
        var rm = document.createElement('button'); rm.textContent = '✕';
        rm.title = 'Remove ' + nameOf(e) + ' from the pool';
        rm.onclick = function () { confirmRemove(e); }; el.appendChild(rm);
        listEl.appendChild(el);
      });
    }

    // Confirm before dropping someone: the pool is the whole giveaway, and there
    // is no undo — a re-entry needs the viewer to type the command again, and in
    // campaign mode they would come back with a new entry number.
    function confirmRemove(e) {
      if (!confirm('Remove ' + nameOf(e) + ' from the pool?')) return;
      act('remove', { target: e.userId });
    }

    // Follower-milestone progress: the control-view bar and the overlay pill.
    function renderProgress(c) {
      var wrap = document.getElementById('progWrap');
      if (!wrap) return;
      if (!c || cfg.followerStep <= 0) { wrap.classList.remove('on'); return; }
      wrap.classList.add('on');
      var note = document.getElementById('progNote');
      if (!c.followTracking) {
        document.getElementById('progText').textContent = 'unavailable';
        document.getElementById('progFill').style.width = '0%';
        note.className = 'unavail';
        note.textContent = 'Follower tracking unavailable — the giveaway channel has no EventSub connection.';
      } else {
        var into = c.followerCount % cfg.followerStep;
        document.getElementById('progText').textContent =
          into + ' / ' + cfg.followerStep + ' (milestone ' + (c.milestonesReached + 1) + ')';
        document.getElementById('progFill').style.width =
          Math.min(100, Math.round(into / cfg.followerStep * 100)) + '%';
        note.className = '';
        note.innerHTML = c.followerCount + ' new follower(s) · ' +
          '<span class="cred">' + c.creditsRemaining + ' draw credit(s) armed</span>';
      }
      if (pillEl && c.followTracking) {
        var pInto = c.followerCount % cfg.followerStep;
        pillEl.innerHTML = 'Followers ' + pInto + '/' + cfg.followerStep +
          ' · <span class="cred">' + c.creditsRemaining + ' draws armed</span>';
      }
    }

    // Milestone-crossed flourish: seeded on the first frame, deferred mid-reel.
    function checkMilestone(c) {
      if (!c || cfg.followerStep <= 0) return;
      if (prevMilestones !== null && c.milestonesReached > prevMilestones) {
        flourishPending = true;
      }
      prevMilestones = c.milestonesReached;
    }
    function maybeFlourish() {
      if (!flourishPending || reelBusy || !msEl) return;
      flourishPending = false;
      msEl.textContent = '🎉 MILESTONE! ' + (cfg.milestoneDraws || 1) + ' bonus draw(s) unlocked!';
      msEl.classList.add('show');
      if (overlayMode) showStage();
      clearTimeout(msTimer);
      msTimer = setTimeout(function () {
        msEl.classList.remove('show');
        if (overlayMode && !reelBusy) hideTimer = setTimeout(hideStage, 800);
      }, MILESTONE_MS);
    }

    function tierTag(w) {
      var c = pool.campaign;
      if (!c || !cfg.firstN) return '';
      var t = (w.number && w.number <= cfg.firstN) ? 'guaranteed' : 'bonus';
      return ' <span class="tier ' + (t === 'guaranteed' ? 'guaranteed' : '') + '">' + t + '</span>';
    }
    function showWinner(w) {
      winnerEl.innerHTML = '🎉 Winner: <span class="name">' +
        (w.number ? '#' + w.number + ' ' : '') + nameOf(w) + '</span>' + tierTag(w);
    }
    function showStage() { clearTimeout(hideTimer); stage.classList.remove('hidden'); }
    function hideStage() { if (overlayMode) stage.classList.add('hidden'); }

    function applyPool(p) {
      if (reelBusy) { pendingState = normPool(p); return; }
      pool = normPool(p);
      checkMilestone(pool.campaign);
      renderIdle(); renderPanel();
      maybeFlourish();
      if (!overlayMode && pool.lastWinner && !winnerEl.textContent) showWinner(pool.lastWinner);
    }

    // CS2-style case reel: a long strip that eases to a stop with the winning
    // card settled under the center ticker.
    function playReel(reel, winner) {
      if (!reel || !reel.length) return;
      reelBusy = true; awaiting = false; showStage();
      idleEl.style.display = 'none'; winnerEl.textContent = ''; renderPanel();
      var RW = reel.length, reelW = reelEl.clientWidth || 900;
      var winPos = 0;
      for (var i = 0; i < RW; i++) { if (reel[i].userId === winner.userId) { winPos = i; break; } }
      // Enough repeats for a long, fast runway before the deceleration.
      var repeats = Math.max(6, Math.ceil((reelW * 3 + 1400) / (RW * STRIDE)) + 3);
      var targetIdx = (repeats - 2) * RW + winPos; // a full copy still trails it, so the right side stays filled
      strip.innerHTML = '';
      var frag = document.createDocumentFragment();
      for (var r = 0; r < repeats; r++) {
        for (var j = 0; j < RW; j++) frag.appendChild(makeCard(reel[j], r * RW + j));
      }
      strip.appendChild(frag);
      // A little off-center jitter so it doesn't always stop dead-center.
      var jitter = (Math.random() * 2 - 1) * (CARD_W * 0.30);
      var T = reelW / 2 - (targetIdx * STRIDE + CARD_W / 2) + jitter;
      strip.style.transition = 'none';
      strip.style.transform = 'translateX(0px)';
      void strip.offsetWidth; // reflow so the transition runs from 0
      strip.style.transition = 'transform ' + REEL_MS + 'ms cubic-bezier(0.05, 0.7, 0.1, 1)';
      strip.style.transform = 'translateX(' + T + 'px)';
      var winCard = strip.children[targetIdx];
      setTimeout(function () {
        if (winCard) winCard.classList.add('win');
        showWinner(winner);
        reelBusy = false;
        if (pendingState) {
          pool = pendingState; pendingState = null;
          checkMilestone(pool.campaign);
        }
        renderPanel();
        maybeFlourish();
        if (overlayMode) hideTimer = setTimeout(hideStage, HOLD_MS);
      }, REEL_MS + 80);
    }

    function post(action, extra) {
      var body = { action: action };
      if (extra) for (var k in extra) body[k] = extra[k];
      return fetch('/api/giveaway', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t); }); })
        .catch(function (e) { if (stateEl) stateEl.textContent = 'Error: ' + e.message; return null; });
    }
    function act(action, extra) {
      post(action, extra).then(function (res) { if (res && res.state) applyPool(res.state); });
    }
    function resetPool() { if (!confirm('Clear all entrants? (Campaign progress and winners are kept.)')) return; winnerEl.textContent = ''; act('reset'); }
    // Inject sample entrants so you can run the reel without a live stream.
    function demo() { winnerEl.textContent = ''; act('demo'); }

    // The full winners list (mailing list) — fetched on demand, never broadcast.
    function toggleWinners() {
      if (winsWrap.classList.contains('on')) { winsWrap.classList.remove('on'); return; }
      post('winners').then(function (res) {
        if (!res || !res.winners) return;
        winsList.textContent = '';
        if (!res.winners.length) {
          var li = document.createElement('li');
          li.textContent = 'No winners recorded yet.'; winsList.appendChild(li);
        }
        res.winners.forEach(function (w) {
          var li = document.createElement('li');
          var num = document.createElement('span'); num.className = 'wnum';
          num.textContent = '#' + w.number; li.appendChild(num);
          var nm = document.createElement('span'); nm.textContent = nameOf(w); li.appendChild(nm);
          var t = document.createElement('span'); t.className = 'wtier';
          t.textContent = '[' + w.tier + ']'; li.appendChild(t);
          var when = document.createElement('span'); when.className = 'wwhen';
          when.textContent = w.wonAt ? new Date(w.wonAt).toLocaleString() : '';
          li.appendChild(when);
          winsList.appendChild(li);
        });
        winsWrap.classList.add('on');
      });
    }

    // Zero the whole campaign (double confirm — this is the season reset).
    function campaignReset() {
      if (!confirm('Campaign reset: zero follower progress, milestone credits and entry numbers, clear the pool, and archive the winners log. Continue?')) return;
      if (!confirm('Really reset the whole campaign? The winners log is archived to a .bak file, not deleted.')) return;
      winnerEl.textContent = '';
      winsWrap.classList.remove('on');
      prevMilestones = null; flourishPending = false;
      act('campaign-reset');
    }

    // Trigger a draw; the broadcast frame drives the reel here AND on the overlay.
    function spin() {
      if (reelBusy || awaiting || pool.entrants.length === 0) return;
      winnerEl.textContent = ''; awaiting = true; renderPanel();
      post('draw').then(function (res) { if (!res) { awaiting = false; renderPanel(); } });
    }

    function handle(ev) {
      if (ev.type !== 'giveaway') return;
      awaiting = false;
      if (ev.draw && ev.draw.winner) {
        pendingState = normPool(ev.data);
        playReel(ev.draw.reel || [], ev.draw.winner);
      } else {
        applyPool(ev.data);
      }
    }

    function connect() {
      var es = new EventSource('/events');
      es.onopen = function () { dot.className = 'live'; ctxt.textContent = 'Live'; };
      es.onerror = function () { dot.className = 'err'; ctxt.textContent = 'Reconnecting'; };
      es.onmessage = function (e) { try { handle(JSON.parse(e.data)); } catch (_) {} };
    }

    if (overlayMode) stage.classList.add('hidden');
    renderIdle(); renderPanel();
    if (cfg.enabled !== false) connect();
  </script>
</body>
</html>`;

/** Constant-time string compare for the turn-report bearer token, so a mismatch
 *  can't be probed byte-by-byte via response timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extract a bearer token from an `Authorization: Bearer …` header or `?token=`. */
function requestToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return new URL(req.url).searchParams.get("token") ?? "";
}

/** Cookie the /giveaway page remembers `?token=` in, so the operator pastes the
 *  URL once on their phone and every later Draw carries the secret. HttpOnly, so
 *  the page never has to touch it — same-origin fetch sends it automatically. */
const CONTROL_COOKIE = "mc_control";

/** Read one cookie off a request. Returns "" when absent. */
function cookieValue(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

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
): {
  emitter: Emitter;
  broadcastGiveaway: (state: GiveawayState, draw?: GiveawayDraw) => void;
} {
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

  // The /giveaway page needs to know the command + channel to prompt with and
  // the campaign shape (never any secret). Same <-escaping as the alerts
  // injection above.
  const g = settings.giveaway;
  const giveawayJson = JSON.stringify({
    enabled: g?.enabled ?? false,
    channel: g?.channel ?? "",
    prefix: g?.prefix ?? "!",
    command: g?.command ?? "enter",
    firstN: g?.firstN ?? 0,
    followerStep: g?.followerStep ?? 0,
    milestoneDraws: g?.milestoneDraws ?? 1,
  }).replace(/</g, "\\u003c");
  const giveawayHtml = GIVEAWAY_HTML.replace(
    "<!--GIVEAWAY-->",
    `<script>window.MULTICHAT_GIVEAWAY=${giveawayJson}</script>`,
  );

  // Bearer required on POST /api/turn-report (else that endpoint is loopback-only).
  const callbackToken = settings.integrations?.callbackToken ?? "";
  // Who may drive POST /api/giveaway, and the optional shared secret non-loopback
  // callers must present. See src/control.ts.
  const controlAccess = normalizeControlAccess(settings.server.controlAccess);
  const controlToken = (settings.server.controlToken ?? "").trim();

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

  // Last giveaway state broadcast, cached like `statuses` so a newly-connected
  // /giveaway page gets the current pool on connect (see the /events replay below).
  let lastGiveaway: GiveawayState | null = null;

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

  // Push giveaway pool state to every connected client. The `/giveaway` page acts
  // on this frame; the public chat pages have no case for it and ignore it. A
  // `draw` payload (winner + reel) rides along only on a draw, so every page —
  // including the transparent OBS overlay — plays the same case-opening reel. The
  // cached snapshot (replayed on connect) never carries `draw`, so a fresh page
  // doesn't re-play an old animation.
  function broadcastGiveaway(state: GiveawayState, draw?: GiveawayDraw): void {
    lastGiveaway = state;
    broadcast(
      draw
        ? { type: "giveaway", data: state, draw }
        : { type: "giveaway", data: state },
    );
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

      // Operator control-plane for the giveaway (open/close/draw/reset/remove/
      // status). Unlike the two endpoints above this one is *shareable*: running
      // a giveaway means whoever is at the desk (or holding a phone) presses
      // Draw, so server.controlAccess can widen it from loopback to the local
      // network, optionally behind server.controlToken. The /giveaway page and
      // `multichat giveaway` both drive it. Mutating actions broadcast the new
      // pool to every connected page from inside the engine (see main.ts).
      if (pathname === "/api/giveaway") {
        const ctl = (body: string, status: number, json = false) =>
          new Response(body, {
            status,
            headers: {
              "x-multichat": "control",
              ...(json ? { "content-type": "application/json" } : {}),
            },
          });
        if (req.method !== "POST") return ctl("Method Not Allowed\n", 405);
        const denied = checkControlAccess({
          addr: info.remoteAddr,
          access: controlAccess,
          token: controlToken,
          presented: requestToken(req) || cookieValue(req, CONTROL_COOKIE),
          endpoint: "giveaway",
        });
        if (denied) return ctl(denied.message + "\n", denied.status);
        if (!hooks.giveaway) {
          return ctl("Giveaway is not enabled\n", 501);
        }
        const parsed = parseGiveawayAction(await req.text());
        if (!parsed.ok) {
          return ctl("Bad Request: " + parsed.message + "\n", 400);
        }
        const gh = hooks.giveaway;
        const a = parsed.action;
        let payload: unknown;
        switch (a.action) {
          case "open":
            payload = { state: gh.open() };
            break;
          case "close":
            payload = { state: gh.close() };
            break;
          case "reset":
            payload = { state: gh.reset() };
            break;
          case "demo":
            payload = { state: gh.demo() };
            break;
          case "remove": {
            const r = gh.remove(a.target);
            payload = {
              state: r.state,
              removed: r.removed,
              matches: r.matches,
            };
            break;
          }
          case "draw": {
            const r = gh.draw();
            payload = { state: r.state, winner: r.winner, segment: r.segment };
            break;
          }
          case "status":
            payload = { state: gh.getState() };
            break;
          case "winners":
            payload = { winners: gh.winners() };
            break;
          case "packs":
            payload = { packs: gh.packs() };
            break;
          case "turns":
            payload = gh.turns();
            break;
          case "report":
            payload = gh.report();
            break;
          case "plan":
            payload = { plan: gh.plan(a.count, a.reseed) };
            break;
          case "plan-clear":
            payload = { plan: gh.planClear() };
            break;
          case "campaign-reset":
            payload = { state: gh.campaignReset() };
            break;
        }
        return ctl(JSON.stringify(payload) + "\n", 200, true);
      }

      // Inbound integration callback: an external tool (chat-cards) pushes back a
      // pack-opening summary — the cards pulled + their values — so the giveaway
      // ledger is complete. Authenticated by the configured callbackToken (bearer
      // or ?token=); with no token set it falls back to loopback-only, matching
      // the other control endpoints. See integrations.ts / control.ts.
      if (pathname === "/api/turn-report") {
        const ctl = (body: string, status: number, json = false) =>
          new Response(body, {
            status,
            headers: {
              "x-multichat": "control",
              ...(json ? { "content-type": "application/json" } : {}),
            },
          });
        if (req.method !== "POST") return ctl("Method Not Allowed\n", 405);
        if (callbackToken) {
          const token = requestToken(req);
          if (!token || !safeEqual(token, callbackToken)) {
            return ctl("Forbidden: bad or missing callback token\n", 403);
          }
        } else if (!isLoopbackAddr(info.remoteAddr)) {
          return ctl(
            "Forbidden: set integrations.callbackToken to allow non-loopback reports\n",
            403,
          );
        }
        if (!hooks.giveaway) return ctl("Giveaway is not enabled\n", 501);
        const parsed = parseTurnReport(await req.text(), Date.now());
        if (!parsed.ok) {
          return ctl("Bad Request: " + parsed.message + "\n", 400);
        }
        const stored = hooks.giveaway.turnReport(parsed.report);
        return ctl(
          JSON.stringify({ ok: true, report: stored }) + "\n",
          200,
          true,
        );
      }

      if (pathname === "/giveaway") {
        const headers = new Headers({
          "Content-Type": "text/html; charset=utf-8",
        });
        // Opening the page with a matching ?token= mints the cookie the control
        // POSTs ride on. The page itself stays readable without one — it is a
        // display surface (and an OBS overlay); only the buttons are gated.
        const supplied = new URL(req.url).searchParams.get("token") ?? "";
        if (controlToken && safeEqual(supplied, controlToken)) {
          headers.append(
            "Set-Cookie",
            `${CONTROL_COOKIE}=${encodeURIComponent(controlToken)}; Path=/; ` +
              `HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
          );
        }
        return new Response(giveawayHtml, { headers });
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
            // Replay the current giveaway pool so a freshly-opened (or reconnected)
            // /giveaway page renders the entrants without waiting for the next change.
            if (lastGiveaway) {
              const gv: ServerEvent = { type: "giveaway", data: lastGiveaway };
              ctrl.enqueue(enc.encode("data: " + JSON.stringify(gv) + "\n\n"));
            }
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

  return { emitter, broadcastGiveaway };
}

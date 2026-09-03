/* Convoy — convoy chat past the hundredth message. `npm test` (test/run.js)

   Why this exists (BUGS.md ui-002 re-filed, cycle 61, 2026-09-03): the convoy
   panel's chat log rendered incrementally — "draw entries n..length, remember
   the length" — and its only resync guard was `if (n > chat.length)`. The
   chat is a ring: js/net.js pushed each inbound line and shifted the oldest
   once the array passed 100. A full ring keeps its length constant, so from
   message #101 on every line was delivered, stored in S.party.chat and never
   drawn. The log silently froze at message 100 — the exact symptom of the
   server outage cycle 55 fixed — until a roster change rebuilt the panel and
   the backlog reappeared all at once. Only the inbound site trimmed, too:
   your own lines and system lines grew the array without bound.

   The fix: the renderer keys on ENTRY IDENTITY (log._last, the object it drew
   last — entries are pushed once and never rebuilt), so a rotated ring drops
   exactly the shifted lines from the top and appends the new ones — O(shifted),
   not a repaint — and a replaced array (the resume snapshot) rebuilds. Every
   push site goes through js/party.js pushChat() with the one ceiling,
   A.party.CHAT_MAX.

   Four groups:
     L0  the lift: renderChatInto is sliced VERBATIM out of js/ui.js and run
         over a jsdom node — no re-implementation; fails loudly if the anchor
         moves. The ST.on('chat') listener body (two lines inside init()) is
         pinned by source, because init() cannot run without a live map.
     C   the renderer's contract against every shape the array takes: the
         full ring rotating (the bug), the ordinary incremental append (the
         same node objects survive — no rebuild), a wholesale replacement of
         the same length (the snapshot), no convoy, a fresh log node.
     P   the REAL js/party.js through the harness: pushChat trims to CHAT_MAX
         and emits 'chat' once per line; sendChat and systemMsg in solo mode
         land in the same ring; no convoy is a no-op; end to end through the
         'chat' bus into the lifted renderer.
     S   source pins that outlive this cycle: one named ceiling, one push and
         one trim site, js/net.js delegating to it, no hardcoded ceiling left
         in js/, and the server's own backlog cap fitting inside the client ring.

   When this fails: read the check label. "frozen" means the renderer stopped
   drawing while state kept moving; "rebuilt" means it threw the DOM away on
   an ordinary append (the smoothness half — this log repaints on every line
   in exactly the convoys people talk in). Never fix a red line here by
   rebuilding the log on every event. */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, ROOT } = H;
const { JSDOM } = require('jsdom');

const UI_SRC = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
const NET_SRC = fs.readFileSync(path.join(ROOT, 'js', 'net.js'), 'utf8');
const PARTY_SRC = fs.readFileSync(path.join(ROOT, 'js', 'party.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const JS_FILES = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).sort();

/* The one ceiling, read out of the source — never hardcoded twice. The 100
   fallback is what js/net.js hardcoded before cycle 61; S1 fails loudly when
   the constant is missing, so the fallback can only ever drive a red run. */
const CAP_M = PARTY_SRC.match(/^\s*var CHAT_MAX = (\d+);/m);
const CHAT_MAX = CAP_M ? parseInt(CAP_M[1], 10) : 100;

/* ================= L0 — the lift ================= */
group('L0 — renderChatInto is lifted verbatim out of js/ui.js; the chat listener still hands it #chat-log');
const START = UI_SRC.indexOf('  function renderChatInto(log) {');
const END = START >= 0 ? UI_SRC.indexOf('\n  }\n', START) + 4 : -1;
ok('could locate renderChatInto in js/ui.js (anchor "  function renderChatInto(log) {" … first "\\n  }\\n")',
  START >= 0 && END > START, 'could not locate renderChatInto in js/ui.js — the anchor moved; update START/END here, never skip');
if (START < 0 || END <= START) process.exit(H.report());
const LIFTED = UI_SRC.slice(START, END);
ok('init() still wires ST.on(\'chat\') to "var log = document.getElementById(\'chat-log\'); if (log) renderChatInto(log);"',
  /ST\.on\('chat',\s*function\s*\(\)\s*\{\s*var log = document\.getElementById\('chat-log'\);\s*if \(log\) renderChatInto\(log\);\s*\}\);/.test(UI_SRC));

const dom = new JSDOM('<div id="chat-log"></div>', { url: 'http://localhost/' });
const win = dom.window;
// U.el / U.esc exactly as js/util.js defines them, over the jsdom document.
const U = {
  el: function (tag, cls, html) { const n = win.document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; },
  esc: function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
};
const reports = [];                       // addChatReport(el, m) spy — reached only for entries carrying fromId
const S = { party: { chat: [] } };        // the lifted function reads S.party.chat; P1 points this at the real state
// eslint-disable-next-line no-new-func
const renderChatInto = new Function('S', 'U', 'addChatReport', LIFTED + '\n  return renderChatInto;')(S, U, function (el, m) { reports.push(m); });
ok('the lifted function runs: an empty chat renders an empty node with _n 0',
  (() => { const l = U.el('div'); renderChatInto(l); return l.childNodes.length === 0 && l._n === 0; })());

const lines = (log) => Array.from(log.querySelectorAll('.msg')).map((e) => e.textContent);
const last = (log) => (log.lastChild ? log.lastChild.textContent : '(empty)');
const expected = (m) => (m.sys || m.from === 'me' ? '' : m.from) + m.text;     // what each entry's DOM line reads as
const inOrder = (log, chat) => lines(log).length === chat.length && lines(log).every((t, i) => t === expected(chat[i]));
const msg = (i, from) => ({ from: from || 'Ann', text: 'msg ' + i, t: i });
// The shape the array takes after js/party.js pushChat(): push, trim to the ceiling. P1 proves the real one.
function ring(chat, entry) { chat.push(entry); while (chat.length > CHAT_MAX) chat.shift(); }

/* ================= C — the renderer's contract ================= */
group('C1 — the bug: a full ring rotating (every inbound line past message ' + CHAT_MAX + ')');
{
  const log = U.el('div'); log.id = 'chat-log';
  S.party = { chat: [] };
  for (let i = 1; i <= CHAT_MAX; i++) { ring(S.party.chat, msg(i)); renderChatInto(log); }
  ok('after ' + CHAT_MAX + ' messages the log shows all ' + CHAT_MAX + ', last line "msg ' + CHAT_MAX + '"',
    lines(log).length === CHAT_MAX && last(log).indexOf('msg ' + CHAT_MAX) >= 0, 'lines=' + lines(log).length + ' last=' + last(log));
  for (let i = CHAT_MAX + 1; i <= CHAT_MAX + 5; i++) { ring(S.party.chat, msg(i)); renderChatInto(log); }
  ok('five more, one render each: the newest is drawn — last DOM line is "msg ' + (CHAT_MAX + 5) + '" (frozen at "msg ' + CHAT_MAX + '" before the fix)',
    last(log).indexOf('msg ' + (CHAT_MAX + 5)) >= 0, 'last=' + last(log));
  ok('the DOM holds exactly chat.length lines (' + S.party.chat.length + '), oldest first ("msg 6"), each matching its state entry — no duplicate, no gap',
    inOrder(log, S.party.chat) && lines(log)[0] === expected(S.party.chat[0]) && S.party.chat[0].text === 'msg 6',
    'lines=' + lines(log).length + ' first=' + (lines(log)[0] || '(none)') + ' last=' + last(log));
  for (let i = CHAT_MAX + 6; i <= CHAT_MAX + 8; i++) ring(S.party.chat, msg(i));   // a burst between two renders (panel re-opened, event coalesced)
  renderChatInto(log);
  ok('a burst of 3 pushes before one render drops 3 from the top and appends 3 (first "msg 9", last "msg ' + (CHAT_MAX + 8) + '")',
    inOrder(log, S.party.chat) && S.party.chat[0].text === 'msg 9' && last(log).indexOf('msg ' + (CHAT_MAX + 8)) >= 0,
    'lines=' + lines(log).length + ' first=' + (lines(log)[0] || '(none)') + ' last=' + last(log));
}

group('C2 — the ordinary path appends only the new lines: the node objects survive (no rebuild, before or after the cap)');
{
  const log = U.el('div');
  S.party = { chat: [] };
  ring(S.party.chat, msg(1)); renderChatInto(log);
  const first = log.firstChild;
  for (let i = 2; i <= 50; i++) { ring(S.party.chat, msg(i)); renderChatInto(log); }
  ok('50 one-at-a-time renders: the first .msg node is the SAME object and there are 50 lines (appended, never rebuilt)',
    log.firstChild === first && lines(log).length === 50, 'lines=' + lines(log).length + ' sameFirst=' + (log.firstChild === first));
  for (let i = 51; i <= CHAT_MAX; i++) { ring(S.party.chat, msg(i)); renderChatInto(log); }
  const second = log.childNodes[1], tail = log.lastChild;
  ring(S.party.chat, msg(CHAT_MAX + 1)); renderChatInto(log);
  ok('one rotation past the cap: the old second node is now first and the old last node is still in place — one removal, one append (O(shifted), not a repaint)',
    log.firstChild === second && log.childNodes[CHAT_MAX - 2] === tail && lines(log).length === CHAT_MAX,
    'firstIsOldSecond=' + (log.firstChild === second) + ' tailKept=' + (log.childNodes[CHAT_MAX - 2] === tail) + ' lines=' + lines(log).length);
  ok('… and the new line is last ("msg ' + (CHAT_MAX + 1) + '")', last(log).indexOf('msg ' + (CHAT_MAX + 1)) >= 0, 'last=' + last(log));
}

group('C3 — a wholesale replacement (the party / resumed snapshot js/net.js maps into a fresh array) rebuilds — same length, shorter, longer');
{
  const log = U.el('div');
  S.party = { chat: [] };
  for (let i = 1; i <= 10; i++) ring(S.party.chat, msg(i));
  renderChatInto(log);
  const snap = (n, tag) => Array.from({ length: n }, (_, i) => ({ from: 'Bob', text: tag + ' ' + (i + 1), t: 500 + i }));
  S.party = { chat: snap(10, 'snap') };          // same length, NEW objects, different text — length alone cannot see this
  renderChatInto(log);
  ok('same-length snapshot (10): the DOM shows the 10 new lines and none of the old', inOrder(log, S.party.chat),
    'lines=' + lines(log).length + ' first=' + (lines(log)[0] || '(none)'));
  S.party = { chat: snap(3, 'short') }; renderChatInto(log);
  ok('shorter snapshot (3): 3 lines, no leftovers', inOrder(log, S.party.chat), 'lines=' + lines(log).length);
  S.party = { chat: snap(12, 'long') }; renderChatInto(log);
  ok('longer snapshot (12): 12 lines, all new, no duplicates', inOrder(log, S.party.chat),
    'lines=' + lines(log).length + ' first=' + (lines(log)[0] || '(none)'));
  const keep = log.firstChild;
  renderChatInto(log);
  ok('the same array rendered twice adds nothing and rebuilds nothing', inOrder(log, S.party.chat) && log.firstChild === keep);
  S.party = { chat: [] }; renderChatInto(log);
  ok('an empty snapshot empties the log', log.childNodes.length === 0 && log._n === 0, 'children=' + log.childNodes.length);
}

group('C4 — no convoy: the log empties, and a new convoy starts from scratch');
{
  const log = U.el('div');
  S.party = { chat: [msg(1), msg(2)] }; renderChatInto(log);
  S.party = null; renderChatInto(log);
  ok('S.party = null → innerHTML "" and _n 0', log.innerHTML === '' && log._n === 0, 'innerHTML=' + JSON.stringify(log.innerHTML) + ' _n=' + log._n);
  S.party = { chat: [msg(3)] }; renderChatInto(log);
  ok('the next convoy renders from scratch: 1 line, "msg 3"', inOrder(log, S.party.chat) && last(log).indexOf('msg 3') >= 0, 'lines=' + lines(log).length);
}

group('C5 — a fresh #chat-log node (renderConvoy rebuilds the panel on every party event) draws the whole backlog once');
{
  S.party = { chat: [] };
  for (let i = 1; i <= CHAT_MAX + 3; i++) ring(S.party.chat, msg(i));   // a ring that has already rotated
  const log = U.el('div'); renderChatInto(log);
  ok('fresh node over a rotated ring: ' + CHAT_MAX + ' lines, oldest "msg 4", newest "msg ' + (CHAT_MAX + 3) + '"',
    inOrder(log, S.party.chat) && S.party.chat[0].text === 'msg 4' && last(log).indexOf('msg ' + (CHAT_MAX + 3)) >= 0,
    'lines=' + lines(log).length + ' first=' + (lines(log)[0] || '(none)') + ' last=' + last(log));
  const keep = log.firstChild;
  renderChatInto(log);
  ok('rendering again with nothing new changes nothing (same ' + CHAT_MAX + ' lines, first node identical)',
    inOrder(log, S.party.chat) && log.firstChild === keep);
  reports.length = 0;
  ring(S.party.chat, { from: 'Cid', fromId: 'r9', text: 'flag me', t: 1 }); renderChatInto(log);
  ok('an entry carrying fromId reaches addChatReport exactly once (the report flag on remote lines survives the lift)',
    reports.length === 1 && reports[0].text === 'flag me' && last(log) === 'Cidflag me', 'reports=' + reports.length + ' last=' + last(log));
}

/* ================= P — the real js/party.js ================= */
group('P1 — the real js/party.js: one ring for every push site, CHAT_MAX entries, one \'chat\' event per line');
H.installBrowser();
H.loadModule('js/util.js');
H.loadModule('js/state.js');
const A = global.window.App;
const RS = A.state, ST = A.store;
A.net = { isLive: () => false, isResuming: () => false };   // solo mode: sendChat / systemMsg land locally
A.sim = { getNpc: () => null };
A.mapview = { setLinksData() {}, setNpcMember() {}, setRallyPoint() {} };
A.ui = { toast() {} };
A.data = { CONVOY_NAMES: ['Night Run'], CHAT_REPLIES: ['copy that'] };
try { H.loadModule('js/party.js'); ok('js/party.js loads through the harness', true); }
catch (e) { ok('js/party.js loads through the harness', false, e.message); }
const P = A.party || {};
ok('A.party.CHAT_MAX is exported and equals the source constant (' + CHAT_MAX + ')',
  CAP_M !== null && typeof P.CHAT_MAX === 'number' && P.CHAT_MAX === CHAT_MAX, 'A.party.CHAT_MAX=' + P.CHAT_MAX + ' source=' + (CAP_M ? CAP_M[1] : 'missing'));
ok('A.party.pushChat is a function (the one push site js/net.js delegates to)', typeof P.pushChat === 'function');
const pushChat = typeof P.pushChat === 'function' ? P.pushChat : function () { throw new Error('A.party.pushChat is missing'); };
let emits = 0;
ST.on('chat', () => { emits++; });
RS.party = { id: 'p1', name: 'Night Run', emoji: 0, isLeader: true, members: [], chat: [] };
function attempt(label, fn) { try { const r = fn(); ok(label, !!r.pass, r.detail); } catch (e) { ok(label, false, e.message); } }
const lastOf = () => RS.party.chat[RS.party.chat.length - 1];

attempt('pushChat × ' + (CHAT_MAX + 7) + ': chat.length === CHAT_MAX, the oldest 7 dropped (chat[0] is "m 8"), one \'chat\' emit per push', () => {
  emits = 0;
  for (let i = 1; i <= CHAT_MAX + 7; i++) pushChat({ from: 'Ann', text: 'm ' + i, t: i });
  return { pass: RS.party.chat.length === CHAT_MAX && RS.party.chat[0].text === 'm 8' && lastOf().text === 'm ' + (CHAT_MAX + 7) && emits === CHAT_MAX + 7,
    detail: 'len=' + RS.party.chat.length + ' first=' + (RS.party.chat[0] && RS.party.chat[0].text) + ' emits=' + emits };
});
attempt('sendChat (solo) lands in the same ring: length stays CHAT_MAX, the last line is from "me", one emit', () => {
  emits = 0; P.sendChat('  hello  ');
  const l = lastOf();
  return { pass: RS.party.chat.length === CHAT_MAX && l.from === 'me' && l.text === 'hello' && emits === 1,
    detail: 'len=' + RS.party.chat.length + ' last=' + JSON.stringify(l) + ' emits=' + emits };
});
attempt('systemMsg (solo) lands in the same ring: length stays CHAT_MAX, the last line is sys, one emit', () => {
  emits = 0; P.systemMsg('Bob joined');
  const l = lastOf();
  return { pass: RS.party.chat.length === CHAT_MAX && l.sys === true && l.text === 'Bob joined' && emits === 1,
    detail: 'len=' + RS.party.chat.length + ' last=' + JSON.stringify(l) + ' emits=' + emits };
});
attempt('pushChat with no convoy is a no-op: nothing emitted, no throw', () => {
  const saved = RS.party; RS.party = null; emits = 0;
  pushChat({ from: 'x', text: 'y', t: 1 });
  const pass = emits === 0; RS.party = saved;
  return { pass, detail: 'emits=' + emits };
});
attempt('end to end: the real pushChat feeding the lifted renderer through the \'chat\' bus draws every line past the cap, in order', () => {
  const log = U.el('div');
  S.party = RS.party;                                    // the lifted renderer now reads the real state
  const off = ST.on('chat', () => renderChatInto(log));
  renderChatInto(log);
  for (let i = 1; i <= 5; i++) pushChat({ from: 'Ann', text: 'late ' + i, t: 900 + i });
  off();
  return { pass: inOrder(log, RS.party.chat) && lines(log).length === CHAT_MAX && last(log).indexOf('late 5') >= 0,
    detail: 'lines=' + lines(log).length + ' last=' + last(log) };
});

/* ================= S — source pins ================= */
group('S1 — one ceiling, one push site, one trim site: js/party.js owns the ring and js/net.js delegates to it');
const decls = (PARTY_SRC.match(/^\s*var CHAT_MAX = \d+;/gm) || []).length;
ok('js/party.js declares exactly one `var CHAT_MAX = N;` (found ' + decls + ')', decls === 1);
const count = (src, re) => (src.match(re) || []).length;
const pushSites = JS_FILES.map((f) => [f, count(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), /\bchat\.push\(/g)]).filter((x) => x[1] > 0);
const trimSites = JS_FILES.map((f) => [f, count(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), /\bchat\.shift\(\)/g)]).filter((x) => x[1] > 0);
ok('across js/*.js the only `chat.push(` is the one inside js/party.js pushChat (found: ' + (pushSites.map((x) => x[0] + '×' + x[1]).join(', ') || 'none') + ')',
  pushSites.length === 1 && pushSites[0][0] === 'party.js' && pushSites[0][1] === 1);
ok('across js/*.js the only `chat.shift()` is the one inside js/party.js pushChat (found: ' + (trimSites.map((x) => x[0] + '×' + x[1]).join(', ') || 'none') + ')',
  trimSites.length === 1 && trimSites[0][0] === 'party.js' && trimSites[0][1] === 1);
ok('js/party.js trims against CHAT_MAX by name (`chat.length > CHAT_MAX`) and exports pushChat + CHAT_MAX on A.party',
  /chat\.length > CHAT_MAX/.test(PARTY_SRC) && /pushChat: pushChat/.test(PARTY_SRC) && /CHAT_MAX: CHAT_MAX/.test(PARTY_SRC));
ok('js/net.js\'s chat handler hands the mapped entry to A.party.pushChat(…) and keeps no trim of its own',
  /chat: function \(m\) \{[\s\S]*?A\.party\.pushChat\(mapChatEntry\(\{[\s\S]*?\}\)\);[\s\S]*?\},/.test(NET_SRC) && !/chat\.length >/.test(NET_SRC));
const hardcoded = JS_FILES.map((f) => [f, count(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), /chat\.length > \d+/g)]).filter((x) => x[1] > 0);
ok('no hardcoded chat ceiling is left anywhere in js/ (`chat.length > <number>`: ' + (hardcoded.map((x) => x[0]).join(', ') || 'none') + ')', hardcoded.length === 0);
const serverCaps = Array.from(SERVER_SRC.matchAll(/party\.chat\.length > (\d+)/g)).map((m) => parseInt(m[1], 10));
ok('server/server.js keeps one backlog cap (' + Array.from(new Set(serverCaps)).join('/') + ' at ' + serverCaps.length + ' sites) and it fits inside the client ring (<= CHAT_MAX ' + CHAT_MAX + '): a resumed snapshot never needs trimming on arrival',
  serverCaps.length >= 1 && new Set(serverCaps).size === 1 && serverCaps[0] <= CHAT_MAX);

process.exit(H.report());

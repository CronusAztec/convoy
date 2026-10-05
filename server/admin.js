/* Convoy — admin control panel (server-rendered, at /admin).

   Everything an operator can do to a running Convoy without SSH: change any
   parameter of any account, flip every kill switch, move the OTA channel,
   work the moderation queue. It exists because the alternative — SSH, a
   psql console, and editing a unit file — is exactly what you don't want to
   be learning during an incident.

   Shape (deliberately unglamorous):

     · ZERO client-side script. The boot CSP allows no inline JS, and a panel
       that can't run JavaScript can't be turned into an XSS pivot either —
       every page is a plain HTML form that POSTs and gets redirected (PRG).
       Inline <style> is allowed by the CSP and is all the styling there is.

     · SERVER-ONLY. Nothing here is part of the web bundle or the APK; the
       panel lives in this file and is rendered per request. It rides the
       same Node process, so its writes go through the same store mutators
       as everything else — the in-memory cache can never disagree.

     · Auth = ADMIN_TOKEN (the master switch: unset ⇒ this whole module 404s
       and doesn't exist) plus optional ADMIN_UIDS deputies who sign in with
       their rider password. Sessions are stateless HMAC-signed cookies
       scoped to /admin: HttpOnly, SameSite=Strict, 8h, Secure on https.
       Every action is Origin-checked, rate-limited where guessable, and
       written to the audit log (audit.js) with actor + ip.

   Routes (all under /admin, all no-store + noindex):

     GET  /                login (or redirect to /home)
     POST /login /logout
     GET  /home            dashboard: live snapshot, flags, OTA, audit tail
     GET  /map             live presence map — everyone connected, plotted on a
                           server-rendered SVG basemap, colour-coded by state
                           (cruising / parked / racing / no fix / stale), with
                           ghosted riders ringed, plus a roster of who is
                           registered but offline
     GET  /accounts?q=     search accounts
     GET  /account/:id     one account: every parameter + every action form
     POST /account/:id/(profile|rename|email|password|recovery|
                        friend-remove|unblock|ban|delete)
     GET  /reports?status= moderation queue;  POST /report/:id/status
     GET  /flags           kill-switch board; POST /flags/set
                           POST /flags/panic  — THE BIG RED BUTTON: master
                           switch + every feature off in one atomic write
                           POST /flags/restore — clear every override
     GET  /ota             channel status;    POST /ota/rollback
     GET  /play            Play Store releases; POST /play/(upload|promote|
                           rollout|halt|resume) — ship a build, move it
                           between tracks, turn the staged-rollout knob, or
                           stop a rollout dead
     GET  /telemetry?days= stats render

   The three kill switches are deliberately different tools, and the panel
   labels them as such, because reaching for the wrong one during an incident
   costs hours:

     Flags → app     stops THIS SERVER serving. Instant, reversible, total.
     Flags → ota     stops handing out web-layer hotfixes.
     Play  → halt    stops Google handing the APK to anyone NEW. It does not
                     touch the installs already out there — for those, the
                     flags and the OTA channel are the only live levers.

   The panel must be resilient: any action failure renders as an error flash
   and NEVER a stack trace — the operator is already having a bad day. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const store = require('./store');
const flags = require('./flags');
const packs = require('./packs');
const audit = require('./audit');
const ota = require('./ota');
const play = require('./play');
const amap = require('./adminmap');
const telemetry = require('./telemetry');
const sb = require('./supabase');

/* ---------------- state ---------------- */

let CTX = null;          // injected by server.js (see init)
let ADMIN_TOKEN = '';
let ADMIN_UIDS = [];
let SECURE = false;
const SESSION_MS = 8 * 3600 * 1000;

// One-shot result messages: actions redirect with ?f=<nonce>, the next page
// render consumes the entry. Keeps results out of URLs (a recovery code or a
// rename confirmation has no business living in browser history).
const FLASH = new Map();
function flash(kind, msg) {
  const n = crypto.randomBytes(8).toString('hex');
  FLASH.set(n, { kind, msg: String(msg).slice(0, 400), at: Date.now() });
  for (const [k, v] of FLASH) if (Date.now() - v.at > 60 * 1000) FLASH.delete(k);
  return n;
}
function takeFlash(n) {
  const v = FLASH.get(String(n || ''));
  if (v) FLASH.delete(String(n));
  return v || null;
}

// Advisory ban mirror (GoTrue is the enforcer; this is so the panel can SHOW
// who is banned without an admin read API that GoTrue doesn't offer stably).
const BANS_FILE = path.join(store.DATA_DIR, 'admin-bans.json');
function readBans() {
  try { return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function writeBan(id, on) {
  const bans = readBans();
  if (on) bans[id] = Date.now();
  else delete bans[id];
  try {
    const tmp = BANS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(bans, null, 2));
    fs.renameSync(tmp, BANS_FILE);
  } catch (e) { /* advisory only */ }
}

/* ---------------- session ---------------- */

function sessionKey() {
  return crypto.createHash('sha256').update(ADMIN_TOKEN + ':cvad-session').digest();
}

function signSession(actor) {
  const exp = Date.now() + SESSION_MS;
  const payload = Buffer.from(JSON.stringify({ a: actor, e: exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function cookieFromReq(req) {
  return ((req.headers.cookie || '').match(/(?:^|;\s*)cvad=([^;]+)/) || [])[1] || null;
}

function sessionActor(req) {
  const raw = cookieFromReq(req);
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const payload = raw.slice(0, i), sig = raw.slice(i + 1);
  const want = crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj || typeof obj.a !== 'string' || typeof obj.e !== 'number') return null;
    if (obj.e < Date.now()) return null;   // expired → re-login
    return obj.a;
  } catch (e) { return null; }
}

function setSessionCookie(res, value) {
  res.setHeader('Set-Cookie', 'cvad=' + value +
    '; Max-Age=' + Math.floor(SESSION_MS / 1000) +
    '; Path=/admin; HttpOnly; SameSite=Strict' + (SECURE ? '; Secure' : ''));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'cvad=; Max-Age=0; Path=/admin; HttpOnly; SameSite=Strict' + (SECURE ? '; Secure' : ''));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Same-origin enforcement for every action POST. SameSite=Strict already
   stops the browser from sending the cookie cross-site; this catches a
   present-but-foreign Origin header anyway (defense in depth is cheap here). */
function originOk(req) {
  const origin = req.headers.origin;
  /* Two ways a request can decline to name an origin, and neither is an
     attack. Absent = a non-browser client (curl, a probe, the deploy script).
     The literal string "null" = a browser that HAS an origin but serialized it
     away: an opaque/sandboxed context, or a referrer policy that suppressed it
     (see handle(), which is why this panel overrides the app-wide one).
     Neither case can carry the cvad cookie in from another site — SameSite=
     Strict is what actually stops CSRF here — so refusing "null" never blocks
     an attacker, it only ever locks the operator out of their own panel. */
  if (!origin || origin === 'null') return true;
  const host = req.headers.host || '';
  return origin === 'https://' + host || origin === 'http://' + host;
}

/* ---------------- tiny HTML kit ---------------- */

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(actor, title, body, flashEntry, headExtra) {
  const flashHtml = flashEntry
    ? '<div class="flash ' + (flashEntry.kind === 'err' ? 'err' : '') + '">' + esc(flashEntry.msg) + '</div>'
    : '';
  const nav = actor
    ? '<nav><a href="/admin/home">Home</a><a href="/admin/map">Map</a>' +
      '<a href="/admin/accounts">Accounts</a>' +
      '<a href="/admin/reports">Reports</a><a href="/admin/packs">Packs</a><a href="/admin/flags">Flags</a>' +
      '<a href="/admin/ota">OTA</a><a href="/admin/play">Play</a>' +
      '<a href="/admin/telemetry">Telemetry</a>' +
      '<form method="post" action="/admin/logout" class="inline"><button>Sign out ' +
      esc(actor) + '</button></form></nav>'
    : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>' + esc(title) + ' · Convoy admin</title>' +
    // Pages opt in to extra <head> content — today only the live map, which
    // uses <meta http-equiv="refresh"> to update itself without any script.
    (headExtra || '') +
    '<style>' +
    'body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#101418;color:#e6e9ec}' +
    'main{max-width:980px;margin:0 auto;padding:16px}' +
    'nav{display:flex;gap:14px;align-items:center;background:#181f26;padding:10px 16px;border-bottom:1px solid #2a333d}' +
    'nav a{color:#8ab4f8;text-decoration:none}nav .inline{margin-left:auto}' +
    'h1{font-size:19px;margin:18px 0 8px}h2{font-size:15px;margin:20px 0 6px;color:#9aa4ad}' +
    'table{border-collapse:collapse;width:100%;margin:8px 0}' +
    'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #232b33;font-size:13px}' +
    'th{color:#9aa4ad;font-weight:600}' +
    'form.g{display:inline}input,select,textarea{background:#0b0e11;color:#e6e9ec;border:1px solid #2a333d;border-radius:4px;padding:5px 7px;font:inherit;max-width:340px}' +
    'textarea{width:100%;max-width:640px}' +
    'button{background:#2563eb;color:#fff;border:0;border-radius:4px;padding:6px 12px;font:inherit;cursor:pointer}' +
    'button.danger{background:#b91c1c}button.warn{background:#92400e}' +
    '.flash{background:#123524;border:1px solid #1c5c3a;padding:8px 12px;border-radius:4px;margin:10px 0}' +
    '.flash.err{background:#3b1212;border-color:#7f1d1d}' +
    '.card{background:#151b21;border:1px solid #232b33;border-radius:6px;padding:12px 14px;margin:10px 0}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}' +
    '.muted{color:#7d8791}.mono{font-family:ui-monospace,monospace;font-size:12px}' +
    '.on{color:#4ade80}.off{color:#f87171}' +
    'label{display:block;margin:6px 0 2px;color:#9aa4ad;font-size:12px}' +
    '</style></head><body>' + nav + '<main>' + flashHtml + body + '</main></body></html>';
}

/* Pages render through this so a ?f=<nonce> flash (from a PRG redirect) is
   consumed exactly once. Nonce-keyed, not the message itself — results never
   appear in a URL. */
function renderPage(req, actor, title, body, headExtra) {
  const f = ((req.url || '').split('?')[1] || '').match(/f=([0-9a-f]+)/);
  return page(actor, title, body, f ? takeFlash(f[1]) : null, headExtra);
}

function send(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow'
  });
  res.end(html);
}

function redirect(res, to) {
  res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

/* Form body parsing — the panel only ever receives
   application/x-www-form-urlencoded, so this is a dozen lines, not a body
   parser library. */
function readForm(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      const out = {};
      for (const pair of raw.split('&')) {
        const i = pair.indexOf('=');
        if (i < 0) continue;
        try {
          out[decodeURIComponent(pair.slice(0, i))] =
            decodeURIComponent((pair.slice(i + 1) || '').replace(/\+/g, ' '));
        } catch (e) { /* skip malformed pair */ }
      }
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });
}

/* ---------------- route table ---------------- */

const ROUTES = [
  ['GET', /^\/admin\/?$/, loginPage],
  ['GET', /^\/admin\/home$/, homePage],
  ['GET', /^\/admin\/map$/, mapPage],
  ['GET', /^\/admin\/map\.js$/, mapJs],
  ['GET', /^\/admin\/riders\.json$/, ridersJson],
  ['GET', /^\/admin\/accounts$/, accountsPage],
  ['GET', /^\/admin\/account\/([0-9a-f-]{36})$/, accountPage],
  ['GET', /^\/admin\/reports$/, reportsPage],
  ['GET', /^\/admin\/packs$/, packsPage],
  ['GET', /^\/admin\/flags$/, flagsPage],
  ['GET', /^\/admin\/ota$/, otaPage],
  ['GET', /^\/admin\/play$/, playPage],
  ['GET', /^\/admin\/telemetry$/, telemetryPage],
  ['POST', /^\/admin\/login$/, loginAction],
  ['POST', /^\/admin\/logout$/, logoutAction],
  ['POST', /^\/admin\/packs\/mint$/, packMintAction],
  ['POST', /^\/admin\/packs\/revoke$/, packRevokeAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/pack-grant$/, packGrantAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/pack-revoke$/, packRevokeGrantAction],
  ['POST', /^\/admin\/flags\/set$/, flagsSetAction],
  ['POST', /^\/admin\/flags\/panic$/, flagsPanicAction],
  ['POST', /^\/admin\/flags\/restore$/, flagsRestoreAction],
  ['POST', /^\/admin\/ota\/rollback$/, otaRollbackAction],
  ['POST', /^\/admin\/play\/upload$/, playUploadAction],
  ['POST', /^\/admin\/play\/promote$/, playPromoteAction],
  ['POST', /^\/admin\/play\/rollout$/, playRolloutAction],
  ['POST', /^\/admin\/play\/halt$/, playHaltAction],
  ['POST', /^\/admin\/play\/resume$/, playResumeAction],
  ['POST', /^\/admin\/report\/(\d+)\/status$/, reportStatusAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/profile$/, profileAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/rename$/, renameAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/email$/, emailAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/password$/, passwordAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/recovery$/, recoveryAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/friend-remove$/, friendRemoveAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/unblock$/, unblockAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/ban$/, banAction],
  ['POST', /^\/admin\/account\/([0-9a-f-]{36})\/delete$/, deleteAction]
];

/* ---------------- dispatch ---------------- */

function handles(urlPath) {
  return !!ADMIN_TOKEN && (urlPath === '/admin' || urlPath.indexOf('/admin/') === 0);
}

async function handle(req, res, urlPath, ip) {
  /* The app-wide default is Referrer-Policy: no-referrer, and that policy does
     more than drop Referer: per Fetch, a request that is not CORS-mode — which
     is exactly what an HTML form POST is — serializes its Origin header as the
     literal "null" under it. That made every action form on this panel look
     like a cross-origin POST against its own page, so the panel refused
     everything except login and logout (the two routes that skip originOk).
     "same-origin" still leaks nothing outward — no referrer, Origin: null, on
     any cross-origin request — while letting our own forms name themselves,
     which is the only way originOk() can do real work. Must be set before the
     first send(): writeHead() flushes the header block. */
  res.setHeader('Referrer-Policy', 'same-origin');

  // Unknown /admin paths 404 as HTML, not JSON — this tree is for humans.
  try {
    for (const [method, re, fn] of ROUTES) {
      const m = urlPath.match(re);
      if (!m || req.method !== method) continue;
      /* The three routes that manage their own auth; everything else needs a
         session. loginPage MUST be in this list: the no-session branch below
         redirects to /admin, which IS loginPage — leaving it out makes the
         sign-in page redirect to itself forever, i.e. nobody can ever reach
         the panel from a browser. (It takes `actor` and redirects a
         signed-in operator on to /home itself.) */
      let actor = null;
      if (fn !== loginPage && fn !== loginAction && fn !== logoutAction) {
        actor = sessionActor(req);
        if (!actor) {
          if (req.method === 'GET') return redirect(res, '/admin');
          return send(res, 403, renderPage(req, null, 'Signed out',
            '<h1>Session expired</h1><p><a href="/admin">Sign in again</a></p>'));
        }
        if (req.method === 'POST' && !originOk(req)) {
          return send(res, 403, renderPage(req, actor, 'Blocked',
            '<h1>Refused</h1><p class="flash err">Cross-origin form post blocked.</p>'));
        }
      }
      await fn(req, res, m, actor, ip);
      return true;
    }
    send(res, 404, renderPage(req, sessionActor(req), 'Not found', '<h1>Not found</h1>'));
  } catch (e) {
    console.error('[admin] handler:', e && e.message);
    send(res, 500, renderPage(req, sessionActor(req), 'Error',
      '<h1>Something broke</h1><p class="flash err">' +
      esc((e && e.message) || 'unknown error') + '</p>'));
  }
  return true;
}

/* ---------------- pages ---------------- */

function loginPage(req, res, m, actor) {
  // Reads the session itself: the dispatcher deliberately does NOT resolve one
  // for this route (see handle()), so an operator who is already signed in
  // still gets bounced on to the dashboard instead of a pointless login form.
  if (actor || sessionActor(req)) return redirect(res, '/admin/home');
  // Deputy sign-in is only offered when ADMIN_UIDS is configured — one form,
  // two meanings: blank identifier = the admin secret; filled = that rider
  // account's password. Both go through constant-time / throttled checks.
  const deputy = ADMIN_UIDS.length
    ? '<label>…or deputy account username</label>' +
      '<input name="identifier" autocomplete="off" placeholder="deputy username (leave blank for the secret)">'
    : '';
  send(res, 200, renderPage(req, null, 'Sign in',
    '<h1>Convoy control panel</h1>' +
    '<div class="card"><form method="post" action="/admin/login">' +
    '<label>Admin secret / account password</label>' +
    '<input type="password" name="token" autocomplete="off">' + deputy +
    '<p><button>Sign in</button></p></form></div>'));
}

/* What each flag would be with no panel override — i.e. what the server
   booted with. flags.board() layers the forced overrides on top of this, so
   the board can show "off because there's no API key" separately from "off
   because an operator turned it off", which are very different problems.

   `app` defaults ON: the server serving is not a feature you configure. */
function envDefaults() {
  const d = {
    app: true,
    routing: CTX.tomtomKeyed(),
    telemetry: CTX.telemetryOn(), registration: true, login: true, ota: true
  };
  // One switch per feature pack on disk; the env default is simply "on".
  packs.packIds().forEach((id) => { d['pack:' + id] = true; });
  return d;
}

/* ---------------- feature packs ----------------
   Codes are minted here and shown ONCE (the plaintext is never stored — see
   server/packcodes.js). The account page carries the grant/revoke controls;
   the kill switch per pack lives on the Flags board as pack:<id>. */
function packLabel(id) {
  const p = packs.get(id);
  return p ? p.title : id;
}
async function packsPage(req, res, m, actor) {
  const all = packs.list();
  let codes = [];
  let codesErr = '';
  try { codes = await store.listPackCodes(); } catch (e) { codesErr = e.message; }
  const fmtDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
  let h = '<h1>Feature packs</h1>' +
    '<p class="muted">Packs are the features withdrawn from the store build. They live under ' +
    '<span class="mono">packs/</span> on this server and are served only to accounts that redeemed a code; ' +
    'nothing in a pack is inside the app binary. Kill a pack for everyone from the ' +
    '<a href="/admin/flags">Flags</a> board (<span class="mono">pack:&lt;id&gt;</span>).</p>' +
    '<h2>On disk</h2><div class="card"><table><tr><th>Pack</th><th>Title</th><th>Legal notice</th><th>Switch</th><th>Accounts holding it</th></tr>';
  if (!all.length) h += '<tr><td colspan="5" class="muted">No packs on disk — nothing under packs/ has a pack.json</td></tr>';
  for (const p of all) {
    h += '<tr><td class="mono">' + esc(p.id) + '</td><td>' + esc(p.title) + '</td>' +
      '<td>' + (p.legal ? '<span class="mono">' + esc(p.legal) + '</span>' : '<span class="muted">none</span>') + '</td>' +
      '<td>' + (packs.enabled(p.id) ? '<span class="on">ON</span>' : '<span class="off">KILLED</span>') + '</td>' +
      '<td>' + packs.holders(p.id) + '</td></tr>';
  }
  h += '</table></div>' +
    '<h2>Mint a code</h2><div class="card"><form method="post" action="/admin/packs/mint">' +
    '<label>Label (who it is for — "App Review", "Club night", …)</label><input name="label" maxlength="80" placeholder="App Review 2026-10">' +
    '<label>Unlocks</label>' +
    all.map((p) => '<label class="inline"><input type="checkbox" name="pack:' + esc(p.id) + '" value="1"> ' + esc(p.title) + ' <span class="mono muted">' + esc(p.id) + '</span></label>').join('<br>') +
    (all.length ? '' : '<span class="muted">no packs to unlock</span>') +
    '<label>Max uses (accounts)</label><input name="maxUses" value="1" style="max-width:120px">' +
    '<label>Expires in days (blank = never)</label><input name="days" placeholder="30" style="max-width:120px">' +
    '<p><button>Mint code</button></p>' +
    '<p class="muted">The code is shown once, on the next page. A reviewer code should be single-use and expire; ' +
    'put the plaintext in the App Review notes (STORE-RELEASE.md).</p></form></div>' +
    '<h2>Codes</h2><div class="card">' +
    (codesErr ? '<p class="flash err">could not list codes: ' + esc(codesErr) + '</p>' : '') +
    '<table><tr><th>#</th><th>Label</th><th>Unlocks</th><th>Uses</th><th>Expires</th><th>Made</th><th>State</th><th></th></tr>';
  if (!codes.length) h += '<tr><td colspan="8" class="muted">none yet</td></tr>';
  for (const c of codes) {
    const dead = c.revoked || (c.expiresAt && c.expiresAt <= Date.now()) || c.uses >= c.maxUses;
    h += '<tr><td class="mono">' + c.id + '</td><td>' + esc(c.label || '') + '</td>' +
      '<td>' + c.packs.map((id) => esc(packLabel(id))).join(', ') + '</td>' +
      '<td>' + c.uses + ' / ' + c.maxUses + '</td><td>' + fmtDate(c.expiresAt) + '</td>' +
      '<td>' + fmtDate(c.createdAt) + (c.createdBy ? ' <span class="muted">by ' + esc(c.createdBy) + '</span>' : '') + '</td>' +
      '<td>' + (c.revoked ? '<span class="off">revoked</span>' : dead ? '<span class="muted">spent</span>' : '<span class="on">live</span>') + '</td>' +
      '<td>' + (c.revoked ? '' : '<form class="g" method="post" action="/admin/packs/revoke"><input type="hidden" name="id" value="' + c.id + '"><button class="danger">revoke</button></form>') + '</td></tr>';
  }
  h += '</table><p class="muted">Revoking a code stops further redemptions; accounts that already redeemed it keep their packs ' +
    '(take those away on the account page).</p></div>';
  send(res, 200, renderPage(req, actor, 'Feature packs', h));
}

function packMintAction(req, res, m, actor, ip) {
  return (async () => {
    const form = await readForm(req);
    // readForm keeps one value per key, so each checkbox has its own: pack:<id>.
    const want = Object.keys(form).filter((k) => k.indexOf('pack:') === 0 && form[k]).map((k) => k.slice(5)).filter((id) => packs.has(id));
    if (!want.length) return redirect(res, '/admin/packs?f=' + flash('err', 'pick at least one pack'));
    const days = String(form.days || '').trim();
    const expiresAt = days ? Date.now() + Math.max(1, Math.min(3650, Number(days) || 0)) * 86400000 : null;
    if (days && !(Number(days) > 0)) return redirect(res, '/admin/packs?f=' + flash('err', 'expiry must be a number of days'));
    let r;
    try {
      r = await store.mintPackCode({ label: form.label, packs: want, maxUses: form.maxUses, expiresAt, createdBy: actor });
    } catch (e) { return redirect(res, '/admin/packs?f=' + flash('err', e.message)); }
    if (r.error) return redirect(res, '/admin/packs?f=' + flash('err', r.error));
    audit.log(actor, ip, 'pack-code', String(r.id), want.join(',') + ' ×' + r.maxUses + (expiresAt ? ' until ' + new Date(expiresAt).toISOString().slice(0, 10) : ''));
    send(res, 200, renderPage(req, actor, 'Code minted',
      '<h1>Code minted</h1><div class="card"><p>Copy it now — it is not stored and cannot be shown again.</p>' +
      '<p class="mono" style="font-size:22px;letter-spacing:.08em">' + esc(r.code) + '</p>' +
      '<p>Unlocks ' + want.map((id) => esc(packLabel(id))).join(', ') + ' · ' + r.maxUses + ' use' + (r.maxUses === 1 ? '' : 's') +
      (expiresAt ? ' · expires ' + new Date(expiresAt).toISOString().slice(0, 10) : ' · never expires') + '</p>' +
      '<p><a href="/admin/packs">Back to packs</a></p></div>'));
  })();
}

function packRevokeAction(req, res, m, actor, ip) {
  return (async () => {
    const form = await readForm(req);
    const id = Math.floor(Number(form.id));
    if (!(id > 0)) return redirect(res, '/admin/packs?f=' + flash('err', 'bad code id'));
    let ok = false;
    try { ok = await store.revokePackCode(id); } catch (e) { return redirect(res, '/admin/packs?f=' + flash('err', e.message)); }
    audit.log(actor, ip, 'pack-code-revoke', String(id), ok ? 'revoked' : 'already revoked / unknown');
    redirect(res, '/admin/packs?f=' + flash(ok ? 'ok' : 'err', ok ? 'code #' + id + ' revoked' : 'code #' + id + ' was not live'));
  })();
}

function packGrantAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    const form = await readForm(req);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const id = String(form.pack || '');
    if (!packs.has(id)) return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', 'no such pack'));
    try { await store.grantPack(u.id, id, 'admin:' + actor); }
    catch (e) { return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', e.message)); }
    const live = CTX.kickPacks ? CTX.kickPacks(u.id) : 0;
    audit.log(actor, ip, 'pack-grant', u.username, id);
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok', 'granted ' + packLabel(id) + (live ? ' (live socket told)' : '')));
  })();
}

function packRevokeGrantAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    const form = await readForm(req);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const id = String(form.pack || '');
    try { await store.revokePack(u.id, id); }
    catch (e) { return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', e.message)); }
    if (CTX.kickPacks) CTX.kickPacks(u.id);
    audit.log(actor, ip, 'pack-revoke', u.username, id);
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok', 'revoked ' + packLabel(id) + ' — their next load will not get it'));
  })();
}

async function homePage(req, res, m, actor) {
  const snap = CTX.snapshot();
  const stats = telemetry.stats(1);
  const board = flags.board(envDefaults());
  const otaSum = ota.summary();
  const bad = board.filter((f) => !f.effective);
  send(res, 200, renderPage(req, actor, 'Home',
    '<h1>Dashboard</h1>' +
    '<div class="grid">' +
    card('Live riders', String(snap.clients)) +
    card('Parties', String(snap.parties)) +
    card('Accounts', String(store.count())) +
    card('Crash-free (24h)', stats.crashFreePct == null ? '—' : stats.crashFreePct + '%') +
    card('Auth deletions pending', String(store.pendingAuthDeletions())) +
    '</div>' +
    '<p class="muted">See where everyone is on the <a href="/admin/map">live map</a>.</p>' +
    '<h2>Kill switches</h2>' +
    // Maintenance gets its own line above the feature list. When the master
    // switch is off, "routing is OFF" is noise — the whole server is refusing.
    (flags.pick('app', true)
      ? (bad.length
        ? '<p class="flash err">' + bad.map((f) => esc(f.name) + ' is OFF').join(', ') +
          ' · <a href="/admin/flags">manage</a></p>'
        : '<p class="muted">All features on · <a href="/admin/flags">manage</a></p>')
      : '<p class="flash err"><b>MAINTENANCE MODE — the app is killed.</b> Every /api call is ' +
        'answering 503 and new sockets are refused. <a href="/admin/flags">Restore</a></p>') +
    '<h2>OTA channel</h2><p>' + (otaSum.current
      ? 'Serving <b>v' + esc(otaSum.current.version) + '</b>' +
        (flags.pick('ota', true) ? '' : ' <span class="off">(HALTED)</span>')
      : 'No bundle published') +
      ' · <a href="/admin/ota">manage</a></p>' +
    '<h2>Recent panel actions</h2>' + auditTable(audit.tail(15))));
}

function card(label, value) {
  return '<div class="card"><div class="muted">' + esc(label) + '</div>' +
    '<div style="font-size:22px;margin-top:4px">' + esc(value) + '</div></div>';
}

function auditTable(rows) {
  if (!rows.length) return '<p class="muted">Nothing yet.</p>';
  let h = '<table><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr>';
  for (const r of rows) {
    h += '<tr><td>' + esc(new Date(r.t).toISOString().replace('T', ' ').slice(0, 19)) + '</td>' +
      '<td>' + esc(r.actor) + '</td><td class="mono">' + esc(r.action) + '</td>' +
      '<td>' + esc(r.target) + '</td><td class="muted">' + esc(r.detail) + '</td></tr>';
  }
  return h + '</table>';
}

async function accountsPage(req, res, m, actor) {
  const q = ((req.url || '').split('?')[1] || '').match(/q=([^&]*)/);
  const needle = q ? decodeURIComponent(q[1].replace(/\+/g, ' ')) : '';
  const results = needle ? store.adminSearch(needle, 50) : [];
  let rows = '';
  for (const u of results) {
    rows += '<tr><td><a href="/admin/account/' + u.id + '">' + esc(u.username) + '</a></td>' +
      '<td>' + esc(u.email || '—') + '</td>' +
      '<td>' + (u.emailVerified ? '<span class="on">verified</span>' : '<span class="off">unverified</span>') + '</td>' +
      '<td>' + esc(u.provider) + '</td><td>' + u.runs + '/' + u.wins + '</td></tr>';
  }
  send(res, 200, renderPage(req, actor, 'Accounts',
    '<h1>Accounts</h1>' +
    '<form method="get" action="/admin/accounts"><label>Search</label>' +
    '<input name="q" value="' + esc(needle) + '" placeholder="username, email or id"> <button>Search</button></form>' +
    (needle ? (results.length
      ? '<table><tr><th>Username</th><th>Email</th><th>Verified</th><th>Provider</th><th>Runs/Wins</th></tr>' + rows + '</table>'
      : '<p class="muted">No matches.</p>')
      : '<p class="muted">Search by username prefix, email substring, or exact account id.</p>')));
}

async function accountPage(req, res, m, actor) {
  const u = store.getById(m[1]);
  if (!u) return send(res, 404, renderPage(req, actor, 'Not found', '<h1>No such account</h1>'));
  const p = u.profile || {};
  const car = p.car || {};
  const bans = readBans();
  const banned = !!bans[u.id];
  const f = (label, name, val, ph) =>
    '<label>' + esc(label) + '</label><input name="' + name + '" value="' + esc(val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';

  // Friends + blocks with names (the id lists in the record are opaque).
  const nameOf = (id) => { const o = store.getById(id); return o ? o.username : id; };
  const friends = (u.friends || []).map((id) =>
    '<li>' + esc(nameOf(id)) + ' <form class="g" method="post" action="/admin/account/' + u.id + '/friend-remove">' +
    '<input type="hidden" name="other" value="' + esc(id) + '"><button class="danger">remove</button></form></li>').join('') || '<li class="muted">none</li>';
  const held = store.packsOf ? store.packsOf(u.id) : [];
  const heldPacks = held.map((id) =>
    '<li>' + esc(packLabel(id)) + ' <span class="mono muted">' + esc(id) + '</span>' +
    (packs.has(id) ? '' : ' <span class="off">(not on disk)</span>') +
    ' <form class="g" method="post" action="/admin/account/' + u.id + '/pack-revoke">' +
    '<input type="hidden" name="pack" value="' + esc(id) + '"><button class="warn">revoke</button></form></li>').join('') || '<li class="muted">none</li>';
  const grantable = packs.list().filter((p) => held.indexOf(p.id) < 0);
  const blocks = store.blockList(u.id).map((o) =>
    '<li>' + esc(o.username || o.id) + ' <form class="g" method="post" action="/admin/account/' + u.id + '/unblock">' +
    '<input type="hidden" name="other" value="' + esc(o.id) + '"><button class="warn">unblock</button></form></li>').join('') || '<li class="muted">none</li>';

  send(res, 200, renderPage(req, actor, u.username,
    '<h1>' + esc(u.username) +
    (banned ? ' <span class="off">[BANNED]</span>' : '') + '</h1>' +
    '<p class="muted mono">' + esc(u.id) + ' · provider ' + esc(u.provider) +
    ' · created ' + esc(new Date(u.createdAt || 0).toISOString().slice(0, 10)) + '</p>' +

    '<h2>Identity</h2><div class="card"><form method="post" action="/admin/account/' + u.id + '/rename">' +
    '<label>Rename (changes login name everywhere — type the new name to confirm)</label>' +
    '<input name="username" placeholder="new username"> ' +
    '<button class="warn">Rename</button></form></div>' +

    '<div class="card"><form method="post" action="/admin/account/' + u.id + '/email">' +
    '<label>Email</label><input name="email" value="' + esc(u.email || '') + '" placeholder="address or blank">' +
    '<label><input type="checkbox" name="verified"' + (u.emailVerified ? ' checked' : '') + '> verified</label> ' +
    '<button>Save email</button></form></div>' +

    '<div class="card"><form method="post" action="/admin/account/' + u.id + '/password">' +
    '<label>Set new password (signs the rider out everywhere)</label>' +
    '<input type="password" name="password" autocomplete="new-password"> <button class="warn">Set</button></form></div>' +

    '<div class="card"><form method="post" action="/admin/account/' + u.id + '/recovery">' +
    '<label>Recovery code</label><button>Regenerate (shown once)</button></form></div></div>' +

    '<h2>Profile</h2><div class="card"><form method="post" action="/admin/account/' + u.id + '/profile">' +
    f('Display name', 'name', p.name || '') + f('Vibe', 'vibe', p.vibe || '') + f('Emoji', 'emoji', p.emoji || '') +
    '<label>Avatar (data:image/… URL, ≤24KB)</label><textarea name="avatar" rows="2">' + esc(p.avatar || '') + '</textarea>' +
    f('Year', 'c_year', car.year || '') + f('Make', 'c_make', car.make || '') + f('Model', 'c_model', car.model || '') +
    f('Trim', 'c_trim', car.trim || '') + f('Paint (#rrggbb)', 'c_paint', car.paint || '') + f('Paint name', 'c_paintName', car.paintName || '') +
    f('Finish (Gloss/Matte/Metallic/Satin)', 'c_finish', car.finish || '') +
    f('Body', 'c_body', car.body || '') + f('Engine', 'c_engine', car.engine || '') +
    f('Trans (AT/MT/DCT)', 'c_trans', car.trans || '') + f('Drive (FWD/RWD/AWD)', 'c_drive', car.drive || '') +
    f('HP', 'c_hp', car.hp || '') + f('Mods', 'c_mods', car.mods || '') + f('Exhaust', 'c_exhaust', car.exhaust || '') +
    '<p><button>Save profile</button></p></form></div>' +

    '<h2>Social</h2><div class="card"><b>Friends</b><ul>' + friends + '</ul>' +
    '<b>Blocking</b><ul>' + blocks + '</ul></div>' +

    '<h2>Feature packs</h2><div class="card"><ul>' + heldPacks + '</ul>' +
    (grantable.length
      ? '<form class="g" method="post" action="/admin/account/' + u.id + '/pack-grant"><select name="pack">' +
        grantable.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.title) + '</option>').join('') +
        '</select> <button>Grant without a code</button></form>'
      : '<span class="muted">' + (packs.list().length ? 'holds every pack' : 'no packs on disk') + '</span>') +
    '</div>' +

    '<h2>Danger</h2><div class="card"><form class="g" method="post" action="/admin/account/' + u.id + '/ban">' +
    (banned
      ? '<button>Unban (restore sign-in)</button>'
      : '<button class="danger">Ban (blocks sign-in, keeps all data)</button>') +
    '<input type="hidden" name="on" value="' + (banned ? '0' : '1') + '"></form> ' +
    '<form class="g" method="post" action="/admin/account/' + u.id + '/delete">' +
    '<label>Delete forever — type ' + esc(u.username) + ' to confirm</label>' +
    '<input name="confirm" placeholder="' + esc(u.username) + '"> <button class="danger">Delete account</button></form></div>'));
}

async function reportsPage(req, res, m, actor) {
  const st = ((req.url || '').split('?')[1] || '').match(/status=([^&]*)/);
  const status = st ? decodeURIComponent(st[1]) : 'open';
  const rows = await store.listReports(status, 150);
  let h = '<h1>Reports</h1><p>' + ['all', 'open', 'reviewing', 'actioned', 'dismissed'].map((s) =>
    '<a href="/admin/reports?status=' + s + '">' + (s === status ? '<b>' + s + '</b>' : s) + '</a>').join(' · ') + '</p>';
  if (!rows.length) return send(res, 200, renderPage(req, actor, 'Reports', h + '<p class="muted">No reports.</p>'));
  h += '<table><tr><th>When</th><th>Reporter</th><th>Subject</th><th>Reason</th><th>Status</th><th>Set</th></tr>';
  for (const r of rows) {
    const subj = r.subject_id
      ? '<a href="/admin/account/' + esc(r.subject_id) + '">' + esc(r.subject_username || 'account') + '</a>'
      : esc(r.subject_label || 'guest');
    h += '<tr><td>' + esc(String(r.created_at || '').slice(0, 19)) + '</td>' +
      '<td>' + esc(r.reporter_username || '—') + '</td><td>' + subj + '</td>' +
      '<td>' + esc(r.reason) + (r.detail ? ' <span class="muted">(' + esc(String(r.detail).slice(0, 80)) + ')</span>' : '') + '</td>' +
      '<td class="mono">' + esc(r.status) + '</td>' +
      '<td><form class="g" method="post" action="/admin/report/' + r.id + '/status">' +
      '<select name="status"><option>reviewing</option><option>actioned</option><option>dismissed</option><option>open</option></select> ' +
      '<button>Set</button></form></td></tr>';
  }
  send(res, 200, renderPage(req, actor, 'Reports', h + '</table>'));
}

async function flagsPage(req, res, m, actor) {
  const board = flags.board(envDefaults());
  const live = flags.pick('app', true);
  let h = '<h1>Kill switches</h1>' +

    /* The master switch, above the table and styled to look like what it is.
       Typing KILL to arm it is not theatre: every other control on this page
       is a single click, and this one takes the entire app down for everyone
       — the confirmation is the only thing standing between a misclick and an
       outage. Restore needs no confirmation, because nobody ever regretted
       turning the app back on too easily. */
    '<div class="card" style="border-color:' + (live ? '#7f1d1d' : '#b91c1c') + '">' +
    '<h2 style="margin-top:0">Master switch — the whole app</h2>' +
    (live
      ? '<p>Convoy is <span class="on">SERVING</span>. Killing it makes every ' +
        '<span class="mono">/api/*</span> call answer 503 and refuses new WebSockets, ' +
        'instantly and for everyone. Riders mid-drive lose live features; the app shell ' +
        'still loads. <span class="mono">/api/health</span> keeps answering (so your monitor ' +
        'can tell this apart from a dead box) and so does the OTA channel, which is how ' +
        'you ship the fix that ends the outage.</p>' +
        '<form method="post" action="/admin/flags/panic">' +
        '<label>Type KILL to confirm — this also forces every feature flag off</label>' +
        '<input name="confirm" autocomplete="off" placeholder="KILL" style="max-width:140px"> ' +
        '<button class="danger">Kill the app</button></form>'
      : '<p class="flash err" style="margin-top:0"><b>THE APP IS KILLED.</b> ' +
        'Every <span class="mono">/api/*</span> call is answering 503 and sockets are refused.</p>' +
        '<p class="muted">Restoring clears every forced override on this page — each flag falls ' +
        'back to what the server booted with. Features whose API key is missing stay off, ' +
        'because forcing those on just produces a rider-visible feature that errors.</p>' +
        '<form method="post" action="/admin/flags/restore">' +
        '<button>Restore service (clear all overrides)</button></form>') +
    '</div>' +

    '<p class="muted">Riders pick changes up on their next app open (caps are cached per session). ' +
    'Env/key default is what the server booted with; a forced override wins until cleared.</p>' +
    '<table><tr><th>Flag</th><th>Env default</th><th>Panel override</th><th>Effective</th><th>Set</th></tr>';
  for (const f of board) {
    h += '<tr><td class="mono">' + esc(f.name) + '</td>' +
      '<td>' + (f.env ? '<span class="on">on</span>' : '<span class="off">off</span>') + '</td>' +
      '<td>' + (f.forced === null ? '<span class="muted">—</span>' : (f.forced ? 'forced ON' : 'forced OFF')) + '</td>' +
      '<td>' + (f.effective ? '<span class="on">ON</span>' : '<span class="off">OFF</span>') + '</td>' +
      '<td>' + ['on', 'off', 'clear'].map((v) =>
        '<form class="g" method="post" action="/admin/flags/set">' +
        '<input type="hidden" name="name" value="' + esc(f.name) + '">' +
        '<input type="hidden" name="value" value="' + v + '">' +
        '<button' + (v === 'off' ? ' class="danger"' : v === 'clear' ? ' class="warn"' : '') + '>' + v + '</button></form>').join(' ') +
      '</td></tr>';
  }
  send(res, 200, renderPage(req, actor, 'Flags', h + '</table>'));
}

async function otaPage(req, res, m, actor) {
  const sum = ota.summary();
  const stats = telemetry.stats(7);
  const uptake = sum.current && stats.releases ? (stats.releases['convoy@' + sum.current.version.replace(/^1\.0\./, 'cy')] || 0) : 0;
  let h = '<h1>OTA channel</h1>';
  if (flags.pick('ota', true) === false) {
    h += '<p class="flash err">Channel is HALTED — checks succeed but no update is offered.</p>';
  }
  if (!sum.current) {
    h += '<p class="muted">No bundle published. Push one with <span class="mono">node release.js --ota</span>.</p>';
  } else {
    h += '<div class="card"><b>Serving v' + esc(sum.current.version) + '</b> · ' + sum.current.size + ' bytes' +
      (sum.current.force ? ' · <b>forced</b>' : '') +
      (sum.current.note ? '<br><span class="muted">' + esc(sum.current.note) + '</span>' : '') +
      '<br><span class="muted">uptake (7d): ' + uptake + ' sessions on this stamp</span></div>';
    if (sum.history.length) {
      h += '<h2>History (rollback targets)</h2><table><tr><th>Version</th><th>Note</th><th></th></tr>';
      for (const e of sum.history) {
        h += '<tr><td>v' + esc(e.version) + '</td><td class="muted">' + esc(e.note || '') + '</td>' +
          '<td><form class="g" method="post" action="/admin/ota/rollback">' +
          '<input type="hidden" name="version" value="' + esc(e.version) + '">' +
          '<button class="warn">Roll back here</button></form></td></tr>';
      }
      h += '</table>';
    }
  }
  h += '<p class="muted">New bundles are built from the repo and pushed with ' +
    '<span class="mono">node release.js --ota</span> — the panel handles the emergency moves only. ' +
    'Halting/resuming lives on the <a href="/admin/flags">flags</a> board (ota).</p>';
  send(res, 200, renderPage(req, actor, 'OTA', h));
}

/* ---------------- presence map ----------------

   The map itself lives in server/adminmap.js — it is the app's MapLibre map,
   the same build, style, globe projection and marker DOM, so the panel and the
   app show a rider the same way. This file keeps the parts that must be
   server-rendered: the roster table, the counts, and the privacy notice.

   The table is not decoration. It is what the page degrades to when script is
   blocked or the CDN is unreachable, and it is the only place an OFFLINE
   rider can appear at all — a map can only draw people who have a position. */

const riderStatus = amap.riderStatus;
const ago = amap.ago;
const GHOST_COLOR = amap.GHOST_COLOR;
const MAP_STALE_MS = amap.MAP_STALE_MS;

/* The snapshot the map polls, behind the same session as every other route. */
function ridersJson(req, res) {
  const body = JSON.stringify({ t: Date.now(), riders: amap.payload(CTX.riders ? CTX.riders() : []) });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow'
  });
  res.end(body);
}

/* The map bootstrap, served from this module so it never enters the web
   bundle or the APK — riders have no reason to download operator tooling. */
function mapJs(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow'
  });
  res.end(amap.MAP_JS);
}

async function mapPage(req, res, m, actor) {
  const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
  const riders = CTX.riders ? CTX.riders() : [];
  const positioned = riders.filter((r) => r.pos);

  // Poll cadence for the live map. 0 = hold still.
  const allowed = [0, 5, 15, 60];
  let refresh = parseInt(qs.get('refresh') || '15', 10);
  if (allowed.indexOf(refresh) < 0) refresh = 15;

  const counts = {
    total: riders.length,
    ghost: riders.filter((r) => r.ghost).length,
    nofix: riders.filter((r) => !r.pos).length,
    stale: riders.filter((r) => r.pos && r.ageMs != null && r.ageMs > MAP_STALE_MS).length,
    racing: riders.filter((r) => r.racing).length,
    bots: riders.filter((r) => r.bot).length
  };

  let h = '<h1>Live map</h1>';

  h += amap.container(refresh);

  h += '<p style="margin:8px 0">' + [0, 5, 15, 60].map((n) =>
    '<a href="/admin/map?refresh=' + n + '">' +
    (n === refresh ? '<b>' + (n ? n + 's' : 'hold') + '</b>' : (n ? n + 's' : 'hold')) + '</a>'
  ).join(' \u00b7 ') + ' <span class="muted">\u00b7 live refresh</span></p>';

  if (!positioned.length) {
    h += '<p class="muted">' + (riders.length
      ? riders.length + ' rider' + (riders.length > 1 ? 's' : '') + ' connected, but none has sent a ' +
        'position yet \u2014 the map is empty until a GPS fix arrives. They are listed below.'
      : 'Nobody is connected right now. The map is showing the globe.') + '</p>';
  }

  /* Legend. Worth the space: the colours are the whole point of the map, and
     an operator reading it for the first time is usually mid-incident. */
  const swatch = (color, label, kind) =>
    '<span style="display:inline-block;margin-right:14px;white-space:nowrap">' +
    '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;' +
    (kind === 'hollow' ? 'border:2px solid ' + color
      : kind === 'dashed' ? 'border:2px dashed ' + color
      : 'background:' + color) +
    ';margin-right:5px;vertical-align:middle"></span>' + esc(label) + '</span>';
  h += '<div class="card" style="padding:10px 14px">' +
    swatch('#4ade80', 'cruising') + swatch('#60a5fa', 'parked') + swatch('#ef4444', 'racing') +
    swatch('#f59e0b', 'no GPS fix') + swatch('#6b7280', 'stale (>60s)') +
    swatch(GHOST_COLOR, 'ghost mode', 'dashed') +
    swatch('#9aa4ad', 'simulated bot', 'hollow') + '</div>';

  h += '<div class="grid">' +
    card('Connected', String(counts.total)) +
    card('Ghosted', String(counts.ghost)) +
    card('Racing', String(counts.racing)) +
    card('No fix', String(counts.nofix)) +
    card('Stale', String(counts.stale)) +
    card('Simulated', String(counts.bots)) + '</div>';

  /* ---- the roster: connected first, then everyone who isn't ---- */
  h += '<h2>Connected</h2>';
  if (!riders.length) {
    h += '<p class="muted">Nobody is connected.</p>';
  } else {
    const rows = riders.slice().sort((a, b) => {
      if (a.bot !== b.bot) return a.bot ? 1 : -1;             // real people first
      return a.username.toLowerCase() < b.username.toLowerCase() ? -1 : 1;
    });
    h += '<table><tr><th>Rider</th><th>Status</th><th>Ghost</th><th>Convoy</th>' +
      '<th>Position</th><th>Last fix</th><th>Account</th></tr>';
    for (const r of rows) {
      const st = riderStatus(r);
      h += '<tr>' +
        '<td>' + esc(r.username) +
        (r.bot ? ' <span class="muted">(bot)</span>' : r.guest ? ' <span class="muted">(guest)</span>' : '') + '</td>' +
        '<td><span style="color:' + st.color + '">' + esc(st.label) + '</span>' +
        (r.mic ? ' <span class="muted">\u00b7 mic</span>' : '') + '</td>' +
        '<td>' + (r.ghost
          ? '<span style="color:' + GHOST_COLOR + '">GHOST</span>'
          : '<span class="muted">\u2014</span>') + '</td>' +
        '<td>' + (r.party ? '<span class="mono">' + esc(String(r.party).slice(0, 8)) + '</span>' : '<span class="muted">\u2014</span>') + '</td>' +
        '<td class="mono">' + (r.pos
          ? esc(r.pos[1].toFixed(4)) + ', ' + esc(r.pos[0].toFixed(4))
          : '<span class="muted">\u2014</span>') + '</td>' +
        '<td>' + esc(ago(r.ageMs)) + '</td>' +
        '<td>' + (r.userId
          ? '<a href="/admin/account/' + esc(r.userId) + '">open</a>'
          : '<span class="muted">' + (r.bot ? 'simulated' : 'no account') + '</span>') + '</td></tr>';
    }
    h += '</table>';
  }

  // Offline = registered but not connected. This is the half a live-socket
  // view can never show, and usually the half being asked about.
  const online = new Set(riders.map((r) => r.userId).filter(Boolean));
  const roster = store.adminRoster ? store.adminRoster(500) : [];
  const offline = roster.filter((u) => !online.has(u.id));
  h += '<h2>Offline <span class="muted" style="font-weight:400">\u2014 registered, not connected (' +
    offline.length + ')</span></h2>';
  if (!offline.length) {
    h += '<p class="muted">' + (roster.length ? 'Everyone with an account is online.' : 'No accounts yet.') + '</p>';
  } else {
    h += '<table><tr><th>Rider</th><th>Status</th><th>Provider</th><th>Joined</th><th></th></tr>';
    for (const u of offline.slice(0, 200)) {
      h += '<tr><td>' + esc(u.username) + '</td>' +
        '<td class="muted">offline</td>' +
        '<td>' + esc(u.provider || '\u2014') + '</td>' +
        '<td class="muted">' + esc(new Date(u.createdAt || 0).toISOString().slice(0, 10)) + '</td>' +
        '<td><a href="/admin/account/' + esc(u.id) + '">open</a></td></tr>';
    }
    h += '</table>';
    if (offline.length > 200) {
      h += '<p class="muted">\u2026and ' + (offline.length - 200) + ' more. ' +
        'Use <a href="/admin/accounts">account search</a> for a specific rider.</p>';
    }
  }

  /* Said out loud rather than buried: ghost mode is a promise to other RIDERS,
     and this page is the one place it does not hold. */
  h += '<div class="card" style="border-color:#3b2f12"><p style="margin:0" class="muted">' +
    '<b>Ghosted riders are shown here.</b> Ghost mode hides a rider from other riders, not from ' +
    'the operator of the service \u2014 it has to work that way for reports about a ghosted rider to be ' +
    'actionable. Treat positions on this page as what they are: precise, live location data about ' +
    'real people. Look when you have a reason to.</p></div>';

  h += amap.scripts();

  send(res, 200, renderPage(req, actor, 'Live map', h, amap.head()));
}


/* ---------------- Play Store ----------------

   Artifacts are picked from a directory on the server, NOT uploaded through
   this form. Two reasons, and the second is the one that matters:

     · A .aab is tens of megabytes. Multipart parsing that in a panel whose
       whole security story is "no client script, tiny hand-written form
       reader" would be the largest and least-tested attack surface in the
       file, for a convenience nobody needs at 2am.
     · The build already lands on this disk. release.js builds the artifact and
       deploy.js ships it to the VPS — exactly like the OTA bundle. The panel's
       job is to decide WHICH build goes live and to HOW MANY people, not to be
       a file transfer. */
const ARTIFACT_DIR = process.env.PLAY_ARTIFACT_DIR || path.join(store.DATA_DIR, 'releases');

function listArtifacts() {
  let names;
  try { names = fs.readdirSync(ARTIFACT_DIR); }
  catch (e) { return []; }
  return names
    .filter((n) => /^[A-Za-z0-9._-]+\.(aab|apk)$/i.test(n))
    .map((n) => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(ARTIFACT_DIR, n)); size = st.size; mtime = st.mtimeMs; }
      catch (e) { /* vanished between readdir and stat */ }
      return { name: n, size: size, mtime: mtime };
    })
    .filter((a) => a.size > 0)
    .sort((a, b) => b.mtime - a.mtime)     // freshest build first: it's the one you want
    .slice(0, 50);
}

/* Resolve a chosen filename back to a path. The regex above already excludes
   separators, so traversal is impossible by construction — this re-checks the
   resolved parent anyway, the same belt-and-suspenders as ota.bundlePath(). */
function artifactPath(name) {
  if (!/^[A-Za-z0-9._-]+\.(aab|apk)$/i.test(String(name || ''))) return null;
  const p = path.resolve(ARTIFACT_DIR, name);
  if (path.dirname(p) !== path.resolve(ARTIFACT_DIR)) return null;
  return p;
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function playPage(req, res, m, actor) {
  let h = '<h1>Google Play</h1>';

  if (!play.configured()) {
    return send(res, 200, renderPage(req, actor, 'Play',
      h + '<p class="flash err">Play publishing is not configured: ' + esc(play.configError()) + '</p>' +
      '<div class="card"><p>To turn this page on:</p><ol>' +
      '<li>Google Cloud → the project behind your Play account → create a <b>service account</b> and download its JSON key.</li>' +
      '<li>Play Console → Users and permissions → invite that service account\'s email, ' +
      'granting <b>Release apps to testing tracks</b> and <b>Release to production</b>.</li>' +
      '<li>Put the JSON key on this server and set <span class="mono">PLAY_SERVICE_ACCOUNT_JSON</span> ' +
      'to its path (plus <span class="mono">PLAY_PACKAGE</span> if it is not ' +
      esc(play.PKG) + '), then restart.</li></ol>' +
      '<p class="muted">The invitation is the step people miss — a key that is valid in Cloud but ' +
      'unknown to the Console fails with a flat "unauthorized_client".</p></div>'));
  }

  let tracks = null, readErr = '';
  try { tracks = await play.status(); }
  catch (e) { readErr = e.message; }

  h += '<p class="muted mono">' + esc(play.PKG) + '</p>';
  if (readErr) h += '<p class="flash err">Could not read the tracks: ' + esc(readErr) + '</p>';

  if (tracks) {
    h += '<table><tr><th>Track</th><th>Version codes</th><th>Status</th><th>Rollout</th><th>Notes</th><th>Actions</th></tr>';
    for (const t of tracks) {
      const rel = play.liveRelease(t);
      const acts = [];
      if (rel && rel.status === 'inProgress') {
        acts.push('<form class="g" method="post" action="/admin/play/halt">' +
          '<input type="hidden" name="track" value="' + esc(t.track) + '">' +
          '<button class="danger">Halt rollout</button></form>');
      }
      if (rel && rel.status === 'halted') {
        acts.push('<form class="g" method="post" action="/admin/play/resume">' +
          '<input type="hidden" name="track" value="' + esc(t.track) + '">' +
          '<input name="percent" placeholder="%" style="max-width:60px"> ' +
          '<button class="warn">Resume</button></form>');
      }
      if (rel && (rel.status === 'inProgress' || rel.status === 'completed')) {
        acts.push('<form class="g" method="post" action="/admin/play/rollout">' +
          '<input type="hidden" name="track" value="' + esc(t.track) + '">' +
          '<input name="percent" placeholder="%" style="max-width:60px"> ' +
          '<button>Set %</button></form>');
      }
      h += '<tr><td class="mono">' + esc(t.track) + '</td>' +
        '<td>' + (rel ? esc(rel.versionCodes.join(', ')) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (rel
          ? (rel.status === 'halted'
            ? '<span class="off">halted</span>'
            : rel.status === 'completed' ? '<span class="on">live</span>' : esc(rel.status))
          : '<span class="muted">nothing released</span>') + '</td>' +
        '<td>' + (rel && rel.percent != null ? esc(rel.percent) + '%'
          : rel && rel.status === 'completed' ? '100%' : '<span class="muted">—</span>') + '</td>' +
        '<td class="muted">' + esc(String((rel && rel.notes) || '').slice(0, 60)) + '</td>' +
        '<td>' + (acts.join(' ') || '<span class="muted">—</span>') + '</td></tr>';
    }
    h += '</table>';
    h += '<p class="muted">A <b>halt</b> stops Google handing this build to anyone new. It does ' +
      'nothing to the installs already out there — for those the <a href="/admin/flags">flags</a> ' +
      'and the <a href="/admin/ota">OTA channel</a> are the only live levers. A rollout that has ' +
      'reached 100% (<i>live</i>) has nothing left to halt; roll forward with a fixed build.</p>';
  }

  /* ---- upload ---- */
  const arts = listArtifacts();
  h += '<h2>Ship a build</h2><div class="card">';
  if (!arts.length) {
    h += '<p class="muted">No artifacts in <span class="mono">' + esc(ARTIFACT_DIR) + '</span>. ' +
      'Build one with <span class="mono">node release.js</span> and put the .aab there ' +
      '(override the directory with <span class="mono">PLAY_ARTIFACT_DIR</span>).</p>';
  } else {
    h += '<form method="post" action="/admin/play/upload">' +
      '<label>Artifact (newest first)</label><select name="artifact">' +
      arts.map((a) => '<option value="' + esc(a.name) + '">' + esc(a.name) + ' — ' + mb(a.size) +
        ' — ' + esc(new Date(a.mtime).toISOString().slice(0, 16).replace('T', ' ')) + '</option>').join('') +
      '</select>' +
      '<label>Track</label><select name="track">' +
      play.TRACKS.map((t) => '<option' + (t === 'internal' ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select>' +
      '<label>Release as</label><select name="status">' +
      '<option value="inProgress">staged rollout (set % below)</option>' +
      '<option value="completed">full release (100%)</option>' +
      '<option value="draft">draft (uploaded, not released)</option></select>' +
      '<label>Rollout % (staged only — above 0, below 100)</label>' +
      '<input name="percent" value="5" style="max-width:80px">' +
      '<label>Release notes (en-US, optional)</label><textarea name="notes" rows="2"></textarea>' +
      '<label>Type SHIP to confirm — this publishes to Google</label>' +
      '<input name="confirm" autocomplete="off" placeholder="SHIP" style="max-width:140px">' +
      '<p><button class="warn">Upload &amp; release</button></p></form>' +
      '<p class="muted">Play assigns the version code from the artifact itself, so you never type ' +
      'one. It refuses a code it has already seen — bump <span class="mono">versionCode</span> in ' +
      'android/app/build.gradle and rebuild if that happens.</p>';
  }
  h += '</div>';

  /* ---- promote ---- */
  h += '<h2>Promote between tracks</h2><div class="card">' +
    '<form method="post" action="/admin/play/promote">' +
    '<label>From</label><select name="from">' +
    play.TRACKS.map((t) => '<option' + (t === 'internal' ? ' selected' : '') + '>' + t + '</option>').join('') +
    '</select>' +
    '<label>To</label><select name="to">' +
    play.TRACKS.map((t) => '<option' + (t === 'production' ? ' selected' : '') + '>' + t + '</option>').join('') +
    '</select>' +
    '<label>Release as</label><select name="status">' +
    '<option value="inProgress">staged rollout (set % below)</option>' +
    '<option value="completed">full release (100%)</option></select>' +
    '<label>Rollout %</label><input name="percent" value="5" style="max-width:80px">' +
    '<label>Type SHIP to confirm</label>' +
    '<input name="confirm" autocomplete="off" placeholder="SHIP" style="max-width:140px">' +
    '<p><button class="warn">Promote</button></p></form>' +
    '<p class="muted">Promotion copies whatever is live on the source track, so it can never ' +
    'publish a build that was not tested. Promoting production → internal is a rollback and is ' +
    'allowed, but Play will not un-ship an install: the fix still has to roll forward.</p></div>';

  send(res, 200, renderPage(req, actor, 'Play', h));
}

async function telemetryPage(req, res, m, actor) {
  const d = ((req.url || '').split('?')[1] || '').match(/days=(\d+)/);
  const days = Math.min(30, Math.max(1, d ? parseInt(d[1], 10) : 7));
  const s = telemetry.stats(days);
  s.pendingAuthDeletions = store.pendingAuthDeletions();
  const bar = (pct) => '<div class="card"><div class="muted">Crash-free (' + days + 'd)</div>' +
    '<div style="font-size:22px">' + (s.crashFreePct == null ? '—' : s.crashFreePct + '%') + '</div></div>';
  let h = '<h1>Telemetry</h1><p>' + [1, 7, 14, 30].map((n) =>
    '<a href="/admin/telemetry?days=' + n + '">' + (n === days ? '<b>' + n + 'd</b>' : n + 'd') + '</a>').join(' · ') + '</p>' +
    '<div class="grid">' + bar() +
    card('Sessions', String(s.sessions)) + card('Client errors', String(s.errors)) +
    card('Server errors', String(s.serverErrors)) + card('Pending auth deletions', String(s.pendingAuthDeletions)) + '</div>';
  if (s.funnel && s.funnel.length) {
    h += '<h2>Funnel</h2><table><tr><th>Step</th><th>Sessions</th><th>%</th></tr>';
    for (const r of s.funnel) h += '<tr><td class="mono">' + esc(r.step) + '</td><td>' + r.sessions + '</td><td>' + (r.pct == null ? '—' : r.pct + '%') + '</td></tr>';
    h += '</table>';
  }
  if (s.topErrors && s.topErrors.length) {
    h += '<h2>Top client errors</h2><table><tr><th>Count</th><th>Type</th><th>Message</th><th>Last release</th></tr>';
    for (const e of s.topErrors.slice(0, 10)) {
      h += '<tr><td>' + e.count + '</td><td class="mono">' + esc(e.type) + '</td>' +
        '<td>' + esc(String(e.msg || '').slice(0, 90)) + '</td><td class="muted">' + esc(e.release || '') + '</td></tr>';
    }
    h += '</table>';
  }
  if (s.releases && Object.keys(s.releases).length) {
    h += '<h2>Sessions by release</h2><table><tr><th>Release</th><th>Sessions</th></tr>';
    for (const [rel, n] of Object.entries(s.releases)) h += '<tr><td class="mono">' + esc(rel) + '</td><td>' + n + '</td></tr>';
    h += '</table>';
  }
  send(res, 200, renderPage(req, actor, 'Telemetry', h));
}

/* ---------------- actions ---------------- */

async function loginAction(req, res, m, actor, ip) {
  if (!rateLimit(ip)) return send(res, 429, renderPage(req, null, 'Slow down',
    '<h1>Too many attempts</h1><p class="flash err">Wait a few minutes.</p>'));
  const form = await readForm(req);
  const ident = String(form.identifier || '').trim();

  if (!ident) {
    // Path 1: the admin secret.
    if (form.token && safeEqual(form.token, ADMIN_TOKEN)) {
      setSessionCookie(res, signSession('admin'));
      audit.log('admin', ip, 'login', '', 'via admin secret');
      return redirect(res, '/admin/home');
    }
  } else if (ADMIN_UIDS.length && form.token) {
    // Path 2: an allowlisted rider account signing in with their password.
    // Deliberately NOT gated by the login kill switch — the panel is exactly
    // how you get in while sign-in is frozen.
    const r = await store.signIn(ident, String(form.token), ip);
    if (!r.error && r.user && ADMIN_UIDS.includes(r.user.id)) {
      setSessionCookie(res, signSession(r.user.username));
      audit.log(r.user.username, ip, 'login', r.user.id, 'via account');
      return redirect(res, '/admin/home');
    }
  }
  audit.log('?', ip, 'login-failed', '', ident ? 'account path' : 'secret path');
  send(res, 401, page(null, 'Sign in',
    '<h1>Convoy control panel</h1><p class="flash err">Wrong secret.</p>' +
    '<div class="card"><form method="post" action="/admin/login">' +
    '<label>Admin secret / account password</label>' +
    '<input type="password" name="token" autocomplete="off">' +
    (ADMIN_UIDS.length ? '<label>…or deputy account username</label><input name="identifier" autocomplete="off">' : '') +
    '<p><button>Sign in</button></p></form></div>'));
}

function logoutAction(req, res) {
  clearSessionCookie(res);
  redirect(res, '/admin');
}

function flagsSetAction(req, res, m, actor, ip) {
  return (async () => {
    const form = await readForm(req);
    const name = String(form.name || '');
    const value = form.value === 'on' ? true : form.value === 'off' ? false : null;
    try { flags.setOverride(name, value); }
    catch (e) {
      return redirect(res, '/admin/flags?f=' + flash('err', e.message));
    }
    audit.log(actor, ip, 'flag', name, value === null ? 'cleared → env default' : value ? 'forced ON' : 'forced OFF');
    redirect(res, '/admin/flags?f=' + flash('ok',
      name + ' ' + (value === null ? 'back to env default' : value ? 'forced ON' : 'forced OFF')));
  })();
}

// Repoint the channel at a history bundle — the same semantics as
// `release.js --ota --rollback`, written here as a manifest with force:true
// (a rollback is by definition not "newer"). The abandoned bundle drops out
// of history so it can't be rolled onto again by accident.
function otaRollbackAction(req, res, m, actor, ip) {
  return (async () => {
    const form = await readForm(req);
    const want = String(form.version || '');
    const sum = ota.summary();
    const target = (sum.history || []).find((e) => e.version === want);
    if (!sum.current || !target) {
      return redirect(res, '/admin/ota?f=' + flash('err', 'no such rollback target'));
    }
    const manifest = {
      version: target.version, file: target.file, checksum: target.checksum,
      size: target.size, note: 'rollback from ' + sum.current.version + ' (panel)',
      force: true,
      history: sum.history.filter((e) => e.version !== want && e.version !== sum.current.version).slice(0, 10)
    };
    try {
      const file = path.join(ota._OTA_DIR, 'manifest.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      return redirect(res, '/admin/ota?f=' + flash('err', 'manifest write failed: ' + e.message));
    }
    audit.log(actor, ip, 'ota-rollback', sum.current.version + '→' + target.version, 'forced');
    redirect(res, '/admin/ota?f=' + flash('ok', 'rolled back to v' + target.version));
  })();
}

/* THE BIG RED BUTTON. Forces the master switch and every feature off in one
   atomic write (flags.panic), so no half-killed state can exist even if the
   process dies mid-action. Guarded by a typed confirmation because it is the
   only control on the panel whose blast radius is "everyone, now". */
function flagsPanicAction(req, res, m, actor, ip) {
  return (async () => {
    const form = await readForm(req);
    if (String(form.confirm || '').trim().toUpperCase() !== 'KILL') {
      return redirect(res, '/admin/flags?f=' +
        flash('err', 'type KILL to confirm — nothing was changed'));
    }
    let changed;
    try { changed = flags.panic(); }
    catch (e) { return redirect(res, '/admin/flags?f=' + flash('err', 'could not write the flag file: ' + e.message)); }
    // Log BEFORE the redirect and with the full list: the audit tail is how
    // the next operator finds out the app is off on purpose.
    audit.log(actor, ip, 'PANIC', 'app', 'forced off: ' + (changed.join(', ') || 'already off'));
    console.warn('[admin] MASTER KILL SWITCH engaged by ' + actor + ' from ' + ip);
    redirect(res, '/admin/flags?f=' + flash('ok',
      'App killed. /api/* is answering 503 and sockets are refused. ' +
      '/api/health and the OTA channel stay up.'));
  })();
}

/* Clear every override — each flag falls back to what the server booted with.
   Not "force everything on": see flags.restore(). */
function flagsRestoreAction(req, res, m, actor, ip) {
  return (async () => {
    let changed;
    try { changed = flags.restore(); }
    catch (e) { return redirect(res, '/admin/flags?f=' + flash('err', 'could not write the flag file: ' + e.message)); }
    audit.log(actor, ip, 'restore', 'all', 'cleared: ' + (changed.join(', ') || 'nothing was overridden'));
    console.warn('[admin] service restored by ' + actor + ' from ' + ip);
    redirect(res, '/admin/flags?f=' + flash('ok',
      changed.length
        ? 'Restored — cleared ' + changed.length + ' override' + (changed.length > 1 ? 's' : '') +
          '. Riders reconnect on their next app open.'
        : 'Nothing was overridden; every flag was already at its boot default.'));
  })();
}

/* ---------------- Play actions ----------------

   All five share a shape: refuse if unconfigured, validate locally, then let
   play.js talk to Google. A thrown error becomes an error flash — play.js
   already phrases its failures as sentences an operator can act on, so there
   is nothing to translate here.

   The two that publish (upload, promote) require a typed SHIP. Everything
   Google publishes reaches real installs and cannot be recalled, which puts
   these in a different class from the panel's other one-click actions. */
function playGuard(res, backTo) {
  if (play.configured()) return false;
  redirect(res, backTo + '?f=' + flash('err', 'Play publishing is not configured: ' + play.configError()));
  return true;
}

function playUploadAction(req, res, m, actor, ip) {
  return (async () => {
    if (playGuard(res, '/admin/play')) return;
    const form = await readForm(req);
    if (String(form.confirm || '').trim().toUpperCase() !== 'SHIP') {
      return redirect(res, '/admin/play?f=' + flash('err', 'type SHIP to confirm — nothing was uploaded'));
    }
    const file = artifactPath(form.artifact);
    if (!file) return redirect(res, '/admin/play?f=' + flash('err', 'pick an artifact from the list'));
    let r;
    try {
      r = await play.upload(file, {
        track: form.track, status: form.status, percent: form.percent, notes: form.notes
      });
    } catch (e) {
      audit.log(actor, ip, 'play-upload-failed', String(form.artifact || ''), e.message);
      return redirect(res, '/admin/play?f=' + flash('err', e.message));
    }
    audit.log(actor, ip, 'play-upload', r.track + ' v' + r.versionCode,
      r.status + (r.percent != null ? ' @ ' + r.percent + '%' : ''));
    redirect(res, '/admin/play?f=' + flash('ok',
      'Published version code ' + r.versionCode + ' to ' + r.track + ' as ' + r.status +
      (r.percent != null ? ' at ' + r.percent + '%' : '') +
      '. Google review can hold it for hours before anyone sees it.'));
  })();
}

function playPromoteAction(req, res, m, actor, ip) {
  return (async () => {
    if (playGuard(res, '/admin/play')) return;
    const form = await readForm(req);
    if (String(form.confirm || '').trim().toUpperCase() !== 'SHIP') {
      return redirect(res, '/admin/play?f=' + flash('err', 'type SHIP to confirm — nothing was promoted'));
    }
    let r;
    try {
      r = await play.promote({
        from: form.from, to: form.to, status: form.status, percent: form.percent
      });
    } catch (e) {
      audit.log(actor, ip, 'play-promote-failed', String(form.from) + '→' + String(form.to), e.message);
      return redirect(res, '/admin/play?f=' + flash('err', e.message));
    }
    audit.log(actor, ip, 'play-promote', r.from + '→' + r.to,
      'v' + r.versionCodes.join(',') + ' ' + r.status + (r.percent != null ? ' @ ' + r.percent + '%' : ''));
    redirect(res, '/admin/play?f=' + flash('ok',
      'Promoted version ' + r.versionCodes.join(', ') + ' from ' + r.from + ' to ' + r.to +
      ' as ' + r.status + (r.percent != null ? ' at ' + r.percent + '%' : '') + '.'));
  })();
}

function playRolloutAction(req, res, m, actor, ip) {
  return (async () => {
    if (playGuard(res, '/admin/play')) return;
    const form = await readForm(req);
    let r;
    try { r = await play.setRollout(form.track, form.percent); }
    catch (e) {
      audit.log(actor, ip, 'play-rollout-failed', String(form.track || ''), e.message);
      return redirect(res, '/admin/play?f=' + flash('err', e.message));
    }
    audit.log(actor, ip, 'play-rollout', r.track, r.percent + '% (' + r.status + ')');
    redirect(res, '/admin/play?f=' + flash('ok',
      r.track + ' rollout set to ' + r.percent + '%' +
      (r.status === 'completed' ? ' — fully live, there is no rollout left to halt.' : '.')));
  })();
}

/* The store kill switch. No typed confirmation on purpose: halting is the
   SAFE direction — it only ever stops new installs — and every second spent
   typing during a bad rollout is another cohort of riders getting the bad
   build. Publishing is what needs a speed bump, not stopping. */
function playHaltAction(req, res, m, actor, ip) {
  return (async () => {
    if (playGuard(res, '/admin/play')) return;
    const form = await readForm(req);
    let r;
    try { r = await play.halt(form.track); }
    catch (e) {
      audit.log(actor, ip, 'play-halt-failed', String(form.track || ''), e.message);
      return redirect(res, '/admin/play?f=' + flash('err', e.message));
    }
    audit.log(actor, ip, 'play-halt', r.track, 'v' + r.versionCodes.join(',') + ' at ' + r.percent + '%');
    console.warn('[admin] Play rollout HALTED on ' + r.track + ' by ' + actor + ' from ' + ip);
    redirect(res, '/admin/play?f=' + flash('ok',
      'Halted the ' + r.track + ' rollout at ' + r.percent + '%. No new installs. ' +
      'Riders who already updated still have it — use the flags or an OTA hotfix for them.'));
  })();
}

function playResumeAction(req, res, m, actor, ip) {
  return (async () => {
    if (playGuard(res, '/admin/play')) return;
    const form = await readForm(req);
    let r;
    try { r = await play.resume(form.track, form.percent); }
    catch (e) {
      audit.log(actor, ip, 'play-resume-failed', String(form.track || ''), e.message);
      return redirect(res, '/admin/play?f=' + flash('err', e.message));
    }
    audit.log(actor, ip, 'play-resume', r.track, r.percent + '%');
    redirect(res, '/admin/play?f=' + flash('ok',
      'Resumed the ' + r.track + ' rollout at ' + r.percent + '%.'));
  })();
}

async function reportStatusAction(req, res, m, actor, ip) {
  const form = await readForm(req);
  const r = await store.setReportStatus(m[1], String(form.status || ''));
  audit.log(actor, ip, 'report-status', '#' + m[1], String(form.status));
  redirect(res, '/admin/reports?f=' + (r.error
    ? flash('err', r.error)
    : flash('ok', 'report #' + m[1] + ' → ' + form.status)));
}

function profileAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const form = await readForm(req);
    const profile = CTX.sanitizeProfile({
      name: form.name, vibe: form.vibe, emoji: form.emoji, avatar: form.avatar,
      car: {
        year: form.c_year, make: form.c_make, model: form.c_model, trim: form.c_trim,
        paint: form.c_paint, paintName: form.c_paintName, finish: form.c_finish,
        body: form.c_body, engine: form.c_engine, trans: form.c_trans,
        drive: form.c_drive, hp: form.c_hp, mods: form.c_mods, exhaust: form.c_exhaust
      }
    });
    profile.handle = u.username.toLowerCase();
    store.updateProfile(u.id, profile);
    audit.log(actor, ip, 'profile', u.username, '');
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok', 'profile saved'));
  })();
}

function renameAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const form = await readForm(req);
    const next = String(form.username || '').trim();
    if (CTX.validUsername(next)) {
      return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', CTX.validUsername(next)));
    }
    const r = await store.renameUser(u.id, next);
    if (r.error) {
      return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err',
        r.error === 'taken' ? 'That username is taken' : r.error));
    }
    audit.log(actor, ip, 'rename', u.username + '→' + next, r.warn || '');
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok',
      'renamed to ' + next + (r.warn ? ' — WARNING: ' + r.warn : '')));
  })();
}

function emailAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const form = await readForm(req);
    const raw = String(form.email || '').trim().toLowerCase();
    if (!raw) {
      // Removing an address is not a supported admin op: GoTrue still holds
      // one, and a profiles/GoTrue disagreement is how accounts get locked
      // out. Say so instead of half-doing it.
      return redirect(res, '/admin/account/' + u.id + '?f=' +
        flash('err', 'blank email not supported — set a real address instead'));
    }
    const ee = CTX.validEmail(raw);
    if (ee) return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', ee));
    const verified = form.verified === 'on';
    const r = await store.setEmailFor(u, raw, verified, ip);
    if (r && r.error) {
      return redirect(res, '/admin/account/' + u.id + '?f=' +
        flash('err', r.error === 'taken' ? 'That email already belongs to an account' : r.error));
    }
    audit.log(actor, ip, 'email', u.username, raw + (verified ? ' (verified)' : ' (unverified)'));
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok', 'email saved'));
  })();
}

function passwordAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const form = await readForm(req);
    const pe = CTX.validPassword(form.password);
    if (pe) return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', pe));
    const r = await store.resetPasswordFor(u, form.password, ip);
    if (r && r.error) {
      return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', r.error));
    }
    audit.log(actor, ip, 'password-set', u.username, 'sessions revoked');
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok',
      'password set — the rider was signed out everywhere'));
  })();
}

function recoveryAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const code = await store.regenRecovery(u.id);
    audit.log(actor, ip, 'recovery-regen', u.username, '');
    // Rendered directly, NOT a redirect: the code appears exactly once and
    // must never land in a URL, a history entry, or the audit log.
    send(res, 200, renderPage(req, actor, 'Recovery code',
      '<h1>New recovery code</h1>' +
      '<div class="card"><p>Give this to the rider — it is shown once:</p>' +
      '<p class="mono" style="font-size:20px">' + esc(code) + '</p>' +
      '<p><a href="/admin/account/' + u.id + '">Back to ' + esc(u.username) + '</a></p></div>'));
  })();
}

function friendRemoveAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    const form = await readForm(req);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    store.removeFriend(u.id, String(form.other || ''));
    audit.log(actor, ip, 'friend-remove', u.username, String(form.other));
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok', 'friendship removed'));
  })();
}

function unblockAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    const form = await readForm(req);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    store.unblockUser(u.id, String(form.other || ''));
    audit.log(actor, ip, 'unblock', u.username, String(form.other));
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok', 'unblocked'));
  })();
}

function banAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const form = await readForm(req);
    const on = form.on === '1';
    const r = await sb.setBanned(u.id, on, ip);
    if (r.error) {
      return redirect(res, '/admin/account/' + u.id + '?f=' + flash('err', 'GoTrue: ' + r.error));
    }
    writeBan(u.id, on);
    if (on && CTX.kick) CTX.kick(u.id);   // live sockets die now; re-auth then fails
    audit.log(actor, ip, on ? 'ban' : 'unban', u.username, on ? 'sign-in blocked' : 'restored');
    redirect(res, '/admin/account/' + u.id + '?f=' + flash('ok',
      on ? 'banned — data kept, sign-in blocked, live sessions closed'
         : 'unbanned — the rider can sign in again'));
  })();
}

function deleteAction(req, res, m, actor, ip) {
  return (async () => {
    const u = store.getById(m[1]);
    if (!u) return redirect(res, '/admin/accounts?f=' + flash('err', 'no such account'));
    const form = await readForm(req);
    if (String(form.confirm || '').trim() !== u.username) {
      return redirect(res, '/admin/account/' + u.id + '?f=' +
        flash('err', 'confirmation did not match the username — nothing deleted'));
    }
    if (CTX.kick) CTX.kick(u.id);
    const r = await store.deleteAccount(u.id);
    audit.log(actor, ip, 'account-delete', u.username, (r && r.authResidue) ? 'auth residue pending' : '');
    redirect(res, '/admin/accounts?f=' + flash('ok', 'account ' + u.username + ' deleted'));
  })();
}

/* ---------------- login throttle ----------------
   The house rate limiter lives in server.js scope; rather than export it, the
   panel keeps its own tiny sliding window — the panel is the one place an
   attacker gets to hammer a password/secret check from the open internet. */
const loginHits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const arr = (loginHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (arr.length >= 8) { loginHits.set(ip, arr); return false; }
  arr.push(now);
  loginHits.set(ip, arr);
  if (loginHits.size > 1000) loginHits.clear();   // memory ceiling, never a leak
  return true;
}

/* ---------------- boot ---------------- */

/* ctx (from server.js):
     snapshot()          live counts {clients, parties, races}
     kick(id)            close a rider's live sockets
     sanitizeProfile(p)  server.js's profile sanitizer (same rules as the app)
     validUsername/validPassword/validEmail — server.js's validators
     tomtomKeyed()/telemetryOn() — env defaults
     secure              set Secure on cookies (https site)                     */
function init(ctx) {
  CTX = ctx;
  ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
  ADMIN_UIDS = String(process.env.ADMIN_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  SECURE = !!ctx.secure;
  audit.init();
  // A short secret is worse than no panel: this URL is reachable from the open
  // internet and the reward for guessing it is every account on the service.
  // 8 attempts per 15 minutes makes brute force slow, not impossible.
  if (ADMIN_TOKEN && ADMIN_TOKEN.length < 24) {
    console.warn('[boot] ⚠  ADMIN_TOKEN is under 24 characters. The panel can change any account');
    console.warn('[boot]    and kill the app — use a long random secret.');
  }
  if (ADMIN_TOKEN && !SECURE) {
    console.warn('[boot] ⚠  admin panel session cookies are NOT Secure (APP_URL is not https).');
    console.warn('[boot]    Fine for localhost; on a public host the session can be sniffed.');
  }
  console.log('[boot] admin panel: ' + (ADMIN_TOKEN
    ? 'enabled at /admin' + (ADMIN_UIDS.length ? ' (+ ' + ADMIN_UIDS.length + ' deputy account' + (ADMIN_UIDS.length > 1 ? 's' : '') + ')' : '')
    : 'DISABLED (set ADMIN_TOKEN)'));
}

module.exports = { init, handles, handle,
  // test surface
  _signSession: signSession, _sessionActor: sessionActor, _esc: esc,
  _readForm: readForm, _routes: ROUTES, _originOk: originOk,
  _listArtifacts: listArtifacts, _artifactPath: artifactPath,
  _riderStatus: riderStatus, _ago: ago, _amap: amap,
  _setEnvForTest: (token, uids) => { ADMIN_TOKEN = token || ''; ADMIN_UIDS = uids || []; } };

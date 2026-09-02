/* Convoy — admin action audit log.

   The control panel (admin.js) can change anything about any account, flip
   every kill switch, and move the OTA channel. That power needs a paper
   trail: "what happened, when, from where, as whom". This is that trail —
   one append-only JSONL file in DATA_DIR, capped so it can't grow forever.

   Design notes:
     · Append-mostly; when the file passes CAP lines it is rewritten keeping
       the newest CAP (the telemetry-error-log pattern, minus rotation —
       2000 admin actions is months at this project's scale, and losing the
       tail of an audit log beats silently filling a disk).
     · Each line is self-contained JSON so a truncated final line (crash
       mid-write) never corrupts the lines before it, and tail() skips it.
     · This records panel actions only — rider-facing events have their own
       trails (reports table, telemetry), and this log is deliberately NOT
       exposed anywhere public: admin.js renders its tail on the dashboard
       for the operator. */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const DIR = store.DATA_DIR;
const FILE = path.join(DIR, 'admin-audit.jsonl');
const CAP = 2000;

let appendPending = false;

function log(actor, ip, action, target, detail) {
  const line = JSON.stringify({
    t: Date.now(),
    actor: String(actor || '').slice(0, 64),
    ip: String(ip || '').slice(0, 45),
    action: String(action || '').slice(0, 64),
    target: String(target || '').slice(0, 128),
    detail: detail === undefined ? '' : String(detail).slice(0, 300)
  });
  try {
    fs.appendFileSync(FILE, line + '\n');
    appendPending = true;
  } catch (e) {
    // The audit log must never take the action itself down — but say so.
    console.error('[audit] write failed:', e.message);
  }
  // Cheap opportunistic trim: check only when the file has grown since last.
  if (appendPending) {
    try {
      const st = fs.statSync(FILE);
      if (st.size > 512 * 1024) trim();
    } catch (e) { /* raced with our own write */ }
  }
}

function trim() {
  let lines;
  try { lines = fs.readFileSync(FILE, 'utf8').split('\n'); }
  catch (e) { return; }
  const kept = lines.slice(-CAP - 1).filter((l) => l.trim());
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''));
  fs.renameSync(tmp, FILE);
  appendPending = false;
}

/* Newest-first tail for the dashboard. Skips a truncated final line. */
function tail(n) {
  let lines;
  try { lines = fs.readFileSync(FILE, 'utf8').split('\n'); }
  catch (e) { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < (n || 20); i--) {
    const l = lines[i];
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (e) { /* torn tail line */ }
  }
  return out;
}

function init() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* exists */ }
}

module.exports = { init, log, tail, _FILE: FILE };

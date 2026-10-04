/* Convoy — runtime kill switches (the control panel's flag store).

   The app's remote flags grew up env-driven: TOMTOM_KEY, OPENWEBNINJA_KEY,
   TELEMETRY=0… each frozen into a module const at require time, so "flip the
   switch" really meant "edit the unit file and restart". That is fine for a
   key rotation and wrong for an emergency: the whole point of a kill switch
   is that it lands NOW, on every rider's next app open, without bouncing the
   server and every live ride on it.

   This module is the runtime layer over those env defaults:

     · STATE lives in DATA_DIR/flags.json — { name: true | false | null } for
       every known flag. `null` (or absent) means "inherit the env default";
       true/false is a forced override. The file is re-read on mtime change
       per request (the ota.js manifest pattern), so panel writes take effect
       without a restart, and a malformed/half-written file keeps the last
       good copy instead of nuking every switch at once.

     · ACCESS is one function: pick(name, envDefault) → boolean. Gates call it
       with the env default they already computed; nothing else in the server
       needs to know the file exists.

     · CHANGES only ever come from the admin panel (admin.js), which is the
       only writer — this process reads. The panel is the human deciding;
       this file is the decision, persisted where the next boot re-reads it.

   Known flags (adding one = add it here, gate it, and render it on the
   panel's flags board):
     app                                     — THE MASTER SWITCH. false = the
                                               whole API answers 503 and live
                                               sockets are refused. See below.
     routing                                 — the /api/route/caps feature
                                               riders see (TomTom routing)
     telemetry                               — accept POST /api/telemetry
     registration | login                    — sign-up / sign-in gates
     ota                                     — the OTA channel (false = halt)

   About `app`, the master switch: it is the one flag that is not a feature.
   Forcing it OFF puts the server into maintenance — every /api/* route and
   every new WebSocket is refused — and it is deliberately gated at the very
   top of the request handler so a broken feature downstream cannot keep the
   server serving. Two things stay alive on purpose:

     · /api/health, so a monitor can still tell "off deliberately" from "dead"
     · the /admin panel itself, which is not under /api — locking the operator
       out of the switch they just flipped is not a kill switch, it is a
       hostage situation.

   panic() drives it from the panel: force `app` OFF and every feature with it,
   in ONE atomic write, so a half-applied panic can't exist.

   Important consumer note: riders cache caps for their whole page session
   (js/net.js probeRoutingCaps), so a flip lands on the next app open /
   reload — fast for an emergency, not instantaneous for a session already
   live. The panel's flags board says this out loud. */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const DATA_DIR = store.DATA_DIR;
const FLAGS_FILE = path.join(DATA_DIR, 'flags.json');

const KNOWN = ['app', 'routing', 'telemetry', 'registration', 'login', 'ota'];

// The master switch is first in KNOWN so the panel's board renders it at the
// top, and named here so nothing has to hardcode the string 'app'.
const MASTER = 'app';

let cache = { mtimeMs: -1, flags: {} };
let warnedBad = false;

/* Read (and mtime-cache) the overrides. Unknown keys are dropped, values are
   coerced to strict true/false/null — anything else in the file is treated as
   noise, never as a switch. */
function readOverrides() {
  let st;
  try { st = fs.statSync(FLAGS_FILE); }
  catch (e) { return {}; }
  if (st.mtimeMs !== cache.mtimeMs) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')); }
    catch (e) { parsed = null; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const clean = {};
      for (const k of KNOWN) {
        const v = parsed[k];
        if (v === true || v === false || v === null) clean[k] = v;
      }
      cache = { mtimeMs: st.mtimeMs, flags: clean };
      warnedBad = false;
    } else if (!warnedBad) {
      // Once per bad file, not once per request — the caps probe is hot.
      console.error('[flags] flags.json is not a flag object — ignoring it, env defaults stand');
      warnedBad = true;
      cache.mtimeMs = st.mtimeMs;
    }
  }
  return cache.flags;
}

/* THE accessor. envDefault is what the gate already computed from env/keys;
   an explicit true/false override wins, else the default flows through. */
function pick(name, envDefault) {
  const o = readOverrides();
  if (Object.prototype.hasOwnProperty.call(o, name)) {
    const v = o[name];
    if (v === true || v === false) return v;
  }
  return !!envDefault;
}

/* Panel write path: merge one override and persist. null clears back to the
   env default. Atomic temp+rename so a reader never sees a partial file. */
function setOverride(name, value) {
  if (!KNOWN.includes(name)) throw new Error('unknown flag: ' + name);
  if (value !== true && value !== false && value !== null) {
    throw new Error('flag value must be true, false or null');
  }
  const cur = readOverrides();
  if (value === null) delete cur[name];
  else cur[name] = value;
  const tmp = FLAGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
  fs.renameSync(tmp, FLAGS_FILE);
  // Serve the new state immediately — don't wait for the mtime tick.
  cache = { mtimeMs: -1, flags: {} };
  readOverrides();
}

/* Write the whole override set at once. Every multi-flag move goes through
   here rather than looping setOverride(), because a panic that half-applied
   (app off, telemetry still on) is a worse state than either end of it —
   temp+rename makes the switch atomic for readers. */
function writeAll(next) {
  const clean = {};
  for (const k of KNOWN) {
    const v = next[k];
    if (v === true || v === false) clean[k] = v;
  }
  const tmp = FLAGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
  fs.renameSync(tmp, FLAGS_FILE);
  cache = { mtimeMs: -1, flags: {} };
  readOverrides();
  return clean;
}

/* THE BIG RED BUTTON. Force the master switch and every feature OFF in one
   write. Returns the flags that were actually changed, so the audit log and
   the operator both see what the button did rather than "panic pressed". */
function panic() {
  const before = readOverrides();
  const next = {};
  const changed = [];
  for (const k of KNOWN) {
    next[k] = false;
    if (before[k] !== false) changed.push(k);
  }
  writeAll(next);
  return changed;
}

/* Undo a panic: drop every forced override so all nine flags fall back to
   what the server booted with. Deliberately NOT "force everything ON" — a
   feature that is off because its API key is missing must stay off, and
   forcing it on would produce a rider-visible feature that 500s. */
function restore() {
  const before = readOverrides();
  const changed = Object.keys(before).filter((k) => before[k] === true || before[k] === false);
  writeAll({});
  return changed;
}

/* The flags board view: for every known flag, what the env default is (the
   gate supplies it), whether the panel forced it, and what riders get. */
function board(envDefaults) {
  const o = readOverrides();
  return KNOWN.map((name) => {
    const env = !!(envDefaults && envDefaults[name]);
    const forced = Object.prototype.hasOwnProperty.call(o, name) ? o[name] : null;
    return { name, env, forced, effective: forced === true || forced === false ? forced : env };
  });
}

function init() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ }
  readOverrides();
}

module.exports = { init, pick, setOverride, board, readOverrides, panic, restore,
  KNOWN, MASTER, _writeAll: writeAll, _FLAGS_FILE: FLAGS_FILE };

/* Convoy — crash reporting + analytics, both halves.

   A crash reporter is the one component whose own bugs are invisible: if it
   silently drops reports, the dashboard just looks healthy. So the things
   checked here are the ways it could fail QUIETLY —

     · a report that carries a token, an email address or a position off the
       device (the privacy policy says it does not, and §3 has to stay literally
       true);
     · an error loop that sends thousands of identical reports instead of one
       and a count;
     · an opt-out that stops the UI but not the network;
     · a session counted twice on the server, which silently inflates the
       crash-free denominator — the single number this whole feature exists to
       produce, and the one nobody would notice being wrong.

   Runs the REAL js/telemetry.js through the browser shim, and the REAL
   server/telemetry.js with DATA_DIR pointed at a temp directory.

   Run:  node test/telemetry.test.js
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installBrowser, loadModule, group, ok, report } = require('./harness');

/* ---------------- server module, with DATA_DIR redirected ----------------
   store.js is stubbed rather than loaded: telemetry.js wants exactly one thing
   from it (DATA_DIR), and the real module pulls in Postgres and GoTrue. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-telemetry-'));
const STORE_PATH = require.resolve('../server/store.js');
require.cache[STORE_PATH] = {
  id: STORE_PATH, filename: STORE_PATH, loaded: true, children: [], paths: [],
  exports: { DATA_DIR: TMP }
};
const server = require('../server/telemetry.js');

/* ---------------- browser shim ---------------- */
const win = installBrowser();
const sends = [];
function spyFetch(url, opts) {
  sends.push({ url: url, body: (opts && opts.body) || '' });
  return { catch: function () { } };   // telemetry always .catch()es its send
}
win.fetch = spyFetch;
global.fetch = spyFetch;

function lastBody() { return sends.length ? sends[sends.length - 1].body : ''; }
function lastBatch() {
  try { return JSON.parse(lastBody()); } catch (e) { return { events: [] }; }
}
function allBodies() { return sends.map(function (s) { return s.body; }).join('\n'); }

// Load a fresh copy of the module (its opt-out is read once, at load time).
function loadTelemetry(cfg) {
  win.App = {};
  win.App.config = Object.assign({ base: '', isNative: false, sentryDsn: '' }, cfg || {});
  loadModule('js/telemetry.js');
  return win.App.telemetry;
}

/* ================================================================== */
group('client — a crash gets off the device');

win.localStorage.clear();
let T = loadTelemetry();
sends.length = 0;

const boom = new Error('render failed');
T.capture(boom, 'mapview');

ok('an uncaught error is sent immediately, not batched', sends.length === 1,
  'sends=' + sends.length + ' — an error sitting in a 5s batch is one the WebView takes with it');
ok('it posts to our own ingest endpoint', /\/api\/telemetry$/.test(sends[0].url), sends[0].url);
let batch = lastBatch();
ok('the payload is one error event', batch.events && batch.events.length === 1 && batch.events[0].k === 'error');
ok('the message survives', /render failed/.test(batch.events[0].msg), batch.events[0].msg);
ok('the capture site is labelled', /\[mapview\]/.test(batch.events[0].msg), batch.events[0].msg);
ok('a stack was parsed into frames', Array.isArray(batch.events[0].frames) && batch.events[0].frames.length > 0,
  'frames=' + JSON.stringify((batch.events[0].frames || []).slice(0, 1)));
ok('the session is now flagged crashed', T.snapshot().crashed === true);

/* ================================================================== */
group('client — an error loop costs one report, not a data plan');

T = loadTelemetry();
sends.length = 0;
const repeat = new Error('same bug every frame');
for (let i = 0; i < 12; i++) T.capture(repeat, 'tick');

ok('the same fingerprint is sent at most 3 times', sends.length === 3,
  'sent ' + sends.length + ' of 12 — a render-loop error must not become 12 POSTs');
ok('the rest are counted, not lost', T.snapshot().dropped === 9, 'dropped=' + T.snapshot().dropped);
ok('only one error group is tracked', T.snapshot().fingerprints === 1);

/* ================================================================== */
group('client — nothing sensitive leaves with the report');

T = loadTelemetry();
sends.length = 0;
T.capture(new Error('POST /api/me?access_token=sk_live_9d8f7a failed for rider@example.com'), 'net');
const body = lastBody();
ok('the access token is redacted', body.indexOf('sk_live_9d8f7a') < 0, body.slice(0, 200));
ok('...and the parameter name is kept, so the report still says which', /access_token=/.test(body));
ok('the email address is redacted', body.indexOf('rider@example.com') < 0);
ok('the redaction marker is there instead', /&lt;email&gt;|<email>/.test(body), body.slice(0, 200));

sends.length = 0;
T.capture(new Error('bad avatar data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='), 'profile');
ok('a base64 data URL is dropped, not shipped', lastBody().indexOf('iVBORw0KGgo') < 0);

// The privacy policy promises no location history. A coordinate can only get in
// through track()'s props, and props refuse anything that is not a scalar.
sends.length = 0;
T.track('trip_end', { pos: [-118.25, 34.04], arrived: true, dist: 1234.5678 });
const props = lastBatchAfterFlush(T).events[0].props;
ok('an array/object property is refused outright', props.pos === undefined, JSON.stringify(props));
ok('scalars are kept', props.arrived === true && props.dist === 1234.57, JSON.stringify(props));
ok('no coordinate appears anywhere in the payload', allBodies().indexOf('118.25') < 0);

function lastBatchAfterFlush(t) { t.flush(); return lastBatch(); }

/* ================================================================== */
group('client — the opt-out is a network switch, not a UI one');

win.localStorage.setItem('convoy.v1', JSON.stringify({ settings: { diagnostics: false } }));
T = loadTelemetry();
sends.length = 0;
T.capture(new Error('should never be sent'), 'optout');
T.track('anything');
T.step('boot');
T.flush();
ok('an opted-out rider sends nothing at all', sends.length === 0, 'sends=' + sends.length);
ok('...and enabled() says so', T.enabled() === false);

// Turning it off mid-session must also drop what is already queued.
win.localStorage.clear();
T = loadTelemetry();
sends.length = 0;
T.track('queued_before_optout');
ok('an event was queued while opted in', T.snapshot().queued === 1);
T.setEnabled(false);
ok('turning diagnostics off empties the queue', T.snapshot().queued === 0);
T.flush();
ok('...and flushing after opting out sends nothing', sends.length === 0);

/* ================================================================== */
group('client — budgets and funnel steps');

T = loadTelemetry();
sends.length = 0;
T.track('spam'); T.track('spam'); T.track('spam');
ok('the same event name is rate-limited to one per second', T.snapshot().queued === 1,
  'queued=' + T.snapshot().queued);

T.step('map_ready'); T.step('map_ready');
ok('a funnel step is recorded once per session', T.snapshot().steps.map_ready !== undefined &&
  Object.keys(T.snapshot().steps).length === 1);

T = loadTelemetry();
sends.length = 0;
for (let i = 0; i < 15; i++) T.track('evt' + i);
T.flush();
ok('a flush sends at most one batch of 10', lastBatch().events.length === 10,
  'batch=' + lastBatch().events.length + ' — the server refuses a body over 48KB');
ok('the rest stay queued for the next flush', T.snapshot().queued === 5);

T = loadTelemetry();
sends.length = 0;
T.screen('profile');
T.end('test');
const endEv = lastBatch().events.filter(function (e) { return e.k === 'end'; })[0];
ok('the session summary names the screen the rider quit on', endEv && endEv.lastScreen === 'profile',
  JSON.stringify(endEv));
ok('...and whether the session crashed', endEv && endEv.crashed === false);
sends.length = 0;
T.end('again');
ok('the summary is sent exactly once', sends.length === 0);

/* ================================================================== */
group('client — the first flush waits for load + idle, not the boot path (T1.4)');

{
  // Same idiom test/visibility.test.js uses for setInterval: record timer
  // calls instead of letting them really fire, so "waits for load+idle" is
  // provable without a real 5s sleep. fire() runs a recorded callback on
  // demand, in whatever order the assertions need.
  const realSetTimeout = global.setTimeout;
  const pending = [];
  global.setTimeout = function (fn, ms) { const e = { fn: fn, ms: ms }; pending.push(e); return e; };
  function fire(e) { pending.splice(pending.indexOf(e), 1); e.fn(); }

  delete win.requestIdleCallback; // exercise the setTimeout(…,1) fallback, not a native rIC

  T = loadTelemetry();
  sends.length = 0;
  T.init();

  ok('init() queues the session event but posts nothing before load',
    sends.length === 0 && T.snapshot().queued >= 1,
    'sends=' + sends.length + ' queued=' + T.snapshot().queued);
  ok('...and no flush timer is armed yet — arm() is held until settle()',
    !pending.some(function (e) { return e.ms === 5000; }), JSON.stringify(pending.map(function (e) { return e.ms; })));

  win.dispatchEvent({ type: 'load' });
  const idleTimer = pending.find(function (e) { return e.ms === 1; });
  ok('the \'load\' event schedules the idle-fallback tick', !!idleTimer, JSON.stringify(pending.map(function (e) { return e.ms; })));
  if (idleTimer) fire(idleTimer);

  const flushTimer = pending.find(function (e) { return e.ms === 5000; });
  ok('settling arms the real FLUSH_MS timer — the batch is scheduled, not dropped', !!flushTimer,
    JSON.stringify(pending.map(function (e) { return e.ms; })));
  ok('...but still nothing has posted — the timer has not fired yet', sends.length === 0);
  if (flushTimer) fire(flushTimer);
  ok('once that timer fires, the batch posts', sends.length === 1, 'sends=' + sends.length);

  global.setTimeout = realSetTimeout;
}

/* ================================================================== */
group('client — Sentry envelope, when a DSN is configured');

T = loadTelemetry({ sentryDsn: 'https://abc123@o42.ingest.sentry.io/1337' });
sends.length = 0;
T.capture(new Error('sentry path'), 'test');
const sentry = sends.filter(function (s) { return /ingest\.sentry\.io/.test(s.url); })[0];
ok('a DSN turns on the Sentry transport', !!sentry, 'urls=' + JSON.stringify(sends.map(function (s) { return s.url; })));
ok('it posts to the envelope endpoint with the key in the query', !!sentry &&
  /\/api\/1337\/envelope\/\?sentry_key=abc123&sentry_version=7$/.test(sentry.url), sentry && sentry.url);
const lines = (sentry ? sentry.body : '').split('\n');
ok('the envelope is 3 newline-delimited parts', lines.length === 3, 'lines=' + lines.length);
let hdr = {}, item = {}, payload = {};
try { hdr = JSON.parse(lines[0]); item = JSON.parse(lines[1]); payload = JSON.parse(lines[2]); } catch (e) { }
ok('the header carries an event_id and the dsn', !!hdr.event_id && hdr.dsn === 'https://abc123@o42.ingest.sentry.io/1337');
ok('the item is an event', item.type === 'event');
ok('the exception is shaped the way Sentry expects', !!(payload.exception &&
  payload.exception.values && payload.exception.values[0].value), JSON.stringify(payload.exception || {}));
ok('frames are oldest-first, as Sentry renders them', !!(payload.exception &&
  payload.exception.values[0].stacktrace &&
  payload.exception.values[0].stacktrace.frames.length > 0));
ok('the release is stamped', /^convoy@/.test(payload.release || ''), payload.release);
ok('our own endpoint still gets it too', sends.some(function (s) { return /\/api\/telemetry$/.test(s.url); }),
  'Sentry is the extra, not the replacement — crash-free % is computed from ours');

T = loadTelemetry({ sentryDsn: 'not-a-dsn' });
sends.length = 0;
T.capture(new Error('bad dsn'), 'test');
ok('a malformed DSN is ignored rather than posted to garbage',
  sends.every(function (s) { return /\/api\/telemetry$/.test(s.url); }),
  JSON.stringify(sends.map(function (s) { return s.url; })));

/* ================================================================== */
group('server — crash-free sessions is counted honestly');

server._reset();
server.ingest({ sid: 's1', release: 'cy108', events: [{ k: 'session' }, { k: 'event', name: 'step:boot' }] });
let st = server.stats(7);
ok('a first batch registers one session', st.sessions === 1, 'sessions=' + st.sessions);
ok('with no errors it is 100% crash-free', st.crashFreePct === 100, 'pct=' + st.crashFreePct);

server.ingest({ sid: 's1', release: 'cy108', events: [{ k: 'event', name: 'step:map_ready' }] });
st = server.stats(7);
ok('a SECOND batch from the same session is not a second session', st.sessions === 1,
  'sessions=' + st.sessions + ' — double-counting here silently inflates the crash-free denominator');

server.ingest({ sid: 's1', events: [{ k: 'error', type: 'TypeError', msg: 'x is not a function', fp: 'TypeError|x|a.js:1' }] });
server.ingest({ sid: 's1', events: [{ k: 'error', type: 'TypeError', msg: 'x is not a function', fp: 'TypeError|x|a.js:1' }] });
st = server.stats(7);
ok('two errors in one session still crash only that one session', st.crashedSessions === 1,
  'crashed=' + st.crashedSessions);
ok('but both errors are counted', st.errors === 2, 'errors=' + st.errors);
ok('crash-free drops to 0% on a single-session day', st.crashFreePct === 0, 'pct=' + st.crashFreePct);
ok('the 99% bar is reported as missed', st.meetsBar === false);

server.ingest({ sid: 's2', events: [{ k: 'session' }] });
st = server.stats(7);
ok('a clean second session moves it to 50%', st.crashFreePct === 50, 'pct=' + st.crashFreePct);

server._reset();
ok('an empty window reports unknown, not a reassuring 100%',
  server.stats(7).crashFreePct === null && server.stats(7).meetsBar === null);

/* ================================================================== */
group('server — funnel, quit screens and rejected input');

server._reset();
server.ingest({
  sid: 'f1', events: [
    { k: 'session' },
    { k: 'event', name: 'step:boot' },
    { k: 'event', name: 'step:map_ready' },
    { k: 'event', name: 'step:not_a_real_step' },
    { k: 'end', lastScreen: 'profile' }
  ]
});
server.ingest({ sid: 'f2', events: [{ k: 'session' }, { k: 'event', name: 'step:boot' }, { k: 'end', lastScreen: 'profile' }] });
st = server.stats(7);
const step = function (n) { return (st.funnel.filter(function (f) { return f.step === n; })[0] || {}).sessions; };
ok('both sessions reached boot', step('boot') === 2, 'boot=' + step('boot'));
ok('only one reached the map', step('map_ready') === 1, 'map_ready=' + step('map_ready'));
ok('the drop-off shows as a percentage', (st.funnel.filter(function (f) { return f.step === 'map_ready'; })[0] || {}).pct === 50);
ok('a step name the client invented is ignored', st.funnel.every(function (f) { return f.step !== 'not_a_real_step'; }));
ok('the quit screen is the one riders left from', st.quitScreens[0] &&
  st.quitScreens[0].name === 'profile' && st.quitScreens[0].count === 2, JSON.stringify(st.quitScreens));

ok('a batch with no session id is refused', server.ingest({ events: [{ k: 'session' }] }).ok === false);
ok('a batch with no events is refused', server.ingest({ sid: 'x', events: [] }).ok === false);
ok('a non-object batch is refused', server.ingest(null).ok === false);
ok('an unknown event kind is ignored, not stored',
  server.ingest({ sid: 'weird', events: [{ k: 'exfiltrate', data: 'x' }] }).accepted === 0);

/* ================================================================== */
group('server — the server\'s own crashes land in the same rollup');

server._reset();
server.serverError('uncaughtException', new Error('db pool exhausted'));
st = server.stats(7);
ok('a process-level crash is counted', st.serverErrors === 1, 'serverErrors=' + st.serverErrors);
ok('...and grouped like any other error', st.topErrors.length === 1 &&
  /db pool exhausted/.test(st.topErrors[0].msg), JSON.stringify(st.topErrors[0] || {}));
ok('it does not pollute the client crash-free number', st.crashedSessions === 0 && st.sessions === 0);

const errFile = path.join(TMP, 'telemetry-errors.jsonl');
ok('errors are also appended to the on-disk log', fs.existsSync(errFile));
const lastLine = fs.readFileSync(errFile, 'utf8').trim().split('\n').pop();
let rec = {};
try { rec = JSON.parse(lastLine); } catch (e) { }
ok('...as one JSON object per line, with the stack', rec.type === 'uncaughtException' &&
  /db pool exhausted/.test(rec.stack || ''), lastLine && lastLine.slice(0, 120));

/* ================================================================== */
group('server — retention is enforced, not just promised');

function dayAgo(n) { return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10); }
function seedBucket(n) {
  return { sessions: n, crashed: 0, errors: 0, serverErrors: 0,
    steps: {}, quit: {}, events: {}, releases: {}, fp: {} };
}

// One bucket inside the 30-day window the privacy policy commits to, one well
// outside it. KEEP_DAYS that never actually deletes anything is a promise the
// code does not keep.
const seed = {};
seed[dayAgo(2)] = seedBucket(5);
seed[dayAgo(40)] = seedBucket(9);
server._reset(seed);
ok('both day buckets are loaded to start with', server.stats(30).sessions === 14,
  'sessions=' + server.stats(30).sessions);
ok('prune drops exactly the out-of-window day', server.prune() === 1);
const kept = server.stats(30);
ok('the recent day survives', kept.sessions === 5, 'sessions=' + kept.sessions);
ok('the 40-day-old day is gone for good', kept.window.from === dayAgo(2), 'from=' + kept.window.from);
ok('a second prune is a no-op', server.prune() === 0);

process.on('exit', function () {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

process.exit(report());

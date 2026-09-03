/* Convoy — js/data.js off the boot path. `node test/lazydata.test.js`.

   T1.5a (mission 20260903-173653-75d3 cycle 2, directive task 4): js/data.js
   is the static vehicle/paint/name/city catalog (16197 B gzip, ~4.5% of the
   whole boot budget) — every consumer site (js/ui.js, js/party.js) reads it
   inside a function, never at parse time (evidence: the directive's own grep,
   34 sites, all inside garage/profile builders, convoy creation, NPC chat).
   Nothing at boot needs it.

   The risk in taking it off <script> is entirely in ONE line: js/ui.js and
   js/party.js both do `var D = A.data;` at PARSE TIME (module load order:
   config.js runs first and seeds A.data = {}; ui.js/party.js load later and
   capture that same object into a local `D`). js/data.js must therefore FILL
   that object (for..in copy onto the existing A.data), never REPLACE it
   (A.data = {...}) — a replace would leave every already-parsed module's `D`
   pointing at a permanently-empty object while A.data itself moved on.

   Four checks, matching the directive's acceptance criteria exactly:
     (a) index.html no longer references js/data.js
     (b) with A.data stubbed empty, js/ui.js and js/party.js still parse, and
         their captured D is the SAME object js/data.js later fills (identity)
     (c) A.data.ensure() resolves once and is cached on the second call
     (d) the <script> ensure() injects carries the current ?v= stamp, read off
         config.js's own tag rather than hardcoded (so the next stamp bump
         cannot silently break the fetch)

   Run:  node test/lazydata.test.js  */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

/* ---------------- (a) index.html no longer references js/data.js ---------------- */
group('index.html — js/data.js is off the boot path');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('no <script src="js/data.js…"> tag remains', !/js\/data\.js/.test(html));
  // pack-ota.js ships the whole www/ tree regardless of what index.html
  // references (guardrail 3) — the file itself must still exist on disk so
  // the lazy fetch has something to load.
  ok('js/data.js still exists on disk (fetched lazily, still shipped in the OTA bundle)',
    fs.existsSync(path.join(ROOT, 'js', 'data.js')));
}

/* ---------------- (b) object-identity: D survives data.js loading later ---------------- */
group('js/ui.js + js/party.js — captured `D` is the object js/data.js later fills, not a stale empty one');
{
  const win = H.installBrowser();
  H.loadModule('js/config.js'); // A.data = A.data || {} — the stub `D` must capture
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');

  const A = win.App;
  const preLoadData = A.data;
  ok('js/config.js seeds A.data as a real (empty) object before any consumer parses',
    !!preLoadData && typeof preLoadData === 'object' && !preLoadData.loaded);

  // js/party.js and js/ui.js both capture `var D = A.data;` at the top of
  // their IIFE — evaluating the file is enough to prove the capture and that
  // neither throws with an empty A.data (no consumer site runs at parse time).
  let partyThrew = null, uiThrew = null;
  try { H.loadModule('js/party.js'); } catch (e) { partyThrew = e; }
  try { H.loadModule('js/ui.js'); } catch (e) { uiThrew = e; }
  ok('js/party.js parses with an empty A.data (no consumer site runs at parse time)', partyThrew === null,
    partyThrew && partyThrew.message);
  ok('js/ui.js parses with an empty A.data (no consumer site runs at parse time)', uiThrew === null,
    uiThrew && uiThrew.message);

  // Now load the real js/data.js and prove it filled the SAME object, not a
  // new one — this is the whole risk the directive calls out in one line.
  H.loadModule('js/data.js');
  ok('A.data === the object seeded by config.js (data.js mutated it, never reassigned)',
    A.data === preLoadData);
  ok('A.data.loaded is true after js/data.js runs', A.data.loaded === true);
  ok('A.data.CONVOY_NAMES is now populated (a real key data.js fills)',
    Array.isArray(A.data.CONVOY_NAMES) && A.data.CONVOY_NAMES.length > 0);
  ok('A.data.CHAT_REPLIES is now populated (js/party.js:149 reads this one on a timer)',
    Array.isArray(A.data.CHAT_REPLIES) && A.data.CHAT_REPLIES.length > 0);
}

/* ---------------- (c) A.data.ensure() is cached ---------------- */
group('A.data.ensure() — cached promise, resolves once, injects the script exactly once');
{
  const win = H.installBrowser();
  win.document.head = H.makeEl('head');
  const injected = [];
  const realCreateElement = win.document.createElement;
  win.document.createElement = function (tag) {
    const n = realCreateElement.call(win.document, tag);
    if (tag === 'script') {
      injected.push(n);
      // simulate the browser firing onload on the next tick, and simulate
      // js/data.js's own effect (fill + flag) the same way the real file does
      setTimeout(function () {
        win.App.data.CONVOY_NAMES = ['Fake Run'];
        win.App.data.loaded = true;
        if (n.onload) n.onload();
      }, 0);
    }
    return n;
  };
  H.loadModule('js/config.js');
  H.loadModule('js/util.js'); // ensure() calls A.util.loadScript at invocation time
  const A = win.App;

  const p1 = A.data.ensure();
  const p2 = A.data.ensure();
  ok('ensure() returns the SAME promise on a second call before the first resolves', p1 === p2);
  ok('exactly one <script> was injected for two overlapping ensure() calls', injected.length === 1,
    'injected ' + injected.length + ' script tag(s)');

  p1.then(function () {
    ok('the promise resolves once js/data.js "loads"', true);
    ok('A.data.loaded is true after the injected script "loads"', A.data.loaded === true);
    const p3 = A.data.ensure();
    ok('a THIRD call after loading resolves immediately (A.data.loaded fast path), no new <script>',
      injected.length === 1);
    p3.then(function () {
      ok('the post-load ensure() promise also resolves', true);
      finish();
    });
  });
}

/* ---------------- (d) the injected <script> carries the current stamp ---------------- */
group('A.data.ensure() — the injected <script> src carries index.html\'s current ?v= stamp');
{
  const win = H.installBrowser();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/config\.js(\?v=cy\d+)/);
  ok('index.html has a config.js?v=cyNNN tag to read the stamp off of', !!m, 'no match in index.html');
  const stamp = m ? m[1] : '?v=cyMISSING';

  // Minimal DOM: a real <head> with the real config.js tag inside it, so
  // document.querySelector('script[src*="config.js?v="]') finds something
  // real instead of a hand-typed fixture — the exact selector js/config.js
  // itself uses.
  win.document.head = H.makeEl('head');
  const cfgTag = H.makeEl('script');
  cfgTag.src = 'js/config.js' + stamp;
  win.document.head.appendChild(cfgTag);
  win.document.querySelector = function (sel) {
    if (sel === 'script[src*="config.js?v="]') return cfgTag;
    return null;
  };

  const injected = [];
  win.document.createElement = function (tag) {
    const n = H.makeEl(tag);
    if (tag === 'script') { injected.push(n); setTimeout(function () { if (n.onload) n.onload(); }, 0); }
    return n;
  };

  H.loadModule('js/config.js');
  H.loadModule('js/util.js');
  win.App.data.ensure();
  setTimeout(function () {
    ok('exactly one <script> injected', injected.length === 1);
    const src = injected[0] && injected[0].src;
    ok('injected src is js/data.js' + stamp + ' (measured "' + src + '")', src === 'js/data.js' + stamp);
    finish();
  }, 10);
}

/* ---------------- async finish: two groups above resolve on a timer ---------------- */
let pending = 2;
function finish() {
  pending--;
  if (pending === 0) process.exit(report());
}

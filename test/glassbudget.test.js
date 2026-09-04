/* Convoy — glass blur budget mode (T2.4a, mission 20260903-173653-75d3 cycle 20).
   `node test/glassbudget.test.js`.

   backdrop-filter is the most expensive rendering feature the driving screen
   draws — it is recomputed every frame over the repainting map, on every
   surface that declares it (css/styles.css's new `:root[data-glass="off"]`
   block, gated by test/frontend.test.js's testGlassBudget()). This file
   proves the JS half: js/state.js's glassOn()/applyGlass() decide, from the
   `glass` setting (auto | on | off), whether `<html data-glass>` is "on" or
   "off" — auto | on | off, an explicit prefers-reduced-transparency match, or
   navigator.deviceMemory on a low-end device. "unknown" (deviceMemory
   undefined — true on iOS Safari and in this harness by default) must mean
   KEEP the glass; never degrade a device the app cannot measure. */
'use strict';
const H = require('./harness');
const { group, ok, report } = H;

function bootState() {
  const win = H.installBrowser();
  H.loadModule('js/config.js');
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  return { win: win, A: win.App, S: win.App.state, ST: win.App.store };
}

// harness.js's installBrowser() gives `win.matchMedia`, but every client
// module is executed via `new Function(src).call(win)` — that changes `this`,
// not the scope chain, so a bare `matchMedia`/`navigator` reference inside
// js/state.js resolves against the real Node global, not `win`. This mirrors
// the fix the harness already applies for `navigator`/`document` (installBrowser's
// own `put()`), just done per-test instead of once globally, since only some
// of these checks want a match.
function setGlobalMatchMedia(fn) {
  try { global.matchMedia = fn; }
  catch (e) { Object.defineProperty(global, 'matchMedia', { value: fn, writable: true, configurable: true }); }
}
function clearGlobalMatchMedia() { setGlobalMatchMedia(undefined); }
function matchMediaThatMatches(query) {
  return function (q) { return { matches: q === query, addEventListener() {} }; };
}

/* ======================================================================== */
group('js/state.js glassOn()/applyGlass() — explicit on/off always wins');
{
  const { S, ST, win } = bootState();
  clearGlobalMatchMedia();
  win.navigator.deviceMemory = 16;
  S.settings.glass = 'off';
  ST.applyGlass();
  ok('glass:\'off\' sets data-glass="off" even on a 16 GB device with no media match',
    win.document.documentElement.getAttribute('data-glass') === 'off',
    'data-glass=' + win.document.documentElement.getAttribute('data-glass'));

  win.navigator.deviceMemory = 2;
  S.settings.glass = 'on';
  ST.applyGlass();
  ok('glass:\'on\' sets data-glass="on" even on a 2 GB device',
    win.document.documentElement.getAttribute('data-glass') === 'on',
    'data-glass=' + win.document.documentElement.getAttribute('data-glass'));
}

/* ======================================================================== */
group('js/state.js glassOn() — auto mode keys off navigator.deviceMemory');
{
  const { S, ST, win } = bootState();
  clearGlobalMatchMedia();

  win.navigator.deviceMemory = 2;
  S.settings.glass = 'auto';
  ST.applyGlass();
  ok('glass:\'auto\' + deviceMemory:2 → off (low-end device, drop the blur)',
    win.document.documentElement.getAttribute('data-glass') === 'off',
    'data-glass=' + win.document.documentElement.getAttribute('data-glass'));

  win.navigator.deviceMemory = 8;
  ST.applyGlass();
  ok('glass:\'auto\' + deviceMemory:8 → on (capable device, keep the glass)',
    win.document.documentElement.getAttribute('data-glass') === 'on',
    'data-glass=' + win.document.documentElement.getAttribute('data-glass'));

  delete win.navigator.deviceMemory;
  ST.applyGlass();
  ok('glass:\'auto\' + deviceMemory undefined → on ("unknown" must mean keep it, never degrade an unmeasured device)',
    win.document.documentElement.getAttribute('data-glass') === 'on',
    'data-glass=' + win.document.documentElement.getAttribute('data-glass'));
}

/* ======================================================================== */
group('js/state.js glassOn() — prefers-reduced-transparency overrides auto, independently of deviceMemory');
{
  const { S, ST, win } = bootState();
  win.navigator.deviceMemory = 16; // capable device — only the media query should flip this off
  S.settings.glass = 'auto';
  setGlobalMatchMedia(matchMediaThatMatches('(prefers-reduced-transparency: reduce)'));
  ST.applyGlass();
  ok('glass:\'auto\' + prefers-reduced-transparency:reduce matching → off, even on a capable device',
    win.document.documentElement.getAttribute('data-glass') === 'off',
    'data-glass=' + win.document.documentElement.getAttribute('data-glass'));
  clearGlobalMatchMedia();
}

/* ======================================================================== */
group('js/state.js — [data-anim="off"] is not a trigger for glass (blur is not motion, guardrail 6)');
{
  const { S, ST, win } = bootState();
  clearGlobalMatchMedia();
  win.navigator.deviceMemory = 16;
  S.settings.anim = false;
  S.settings.glass = 'auto';
  ST.applyGlass();
  ok('reduced-motion (anim:false) alone does not turn the glass off',
    win.document.documentElement.getAttribute('data-glass') === 'on',
    'data-glass=' + win.document.documentElement.getAttribute('data-glass'));
}

/* ======================================================================== */
group('js/store.setSetting(\'glass\', ...) — persists and survives a reload of the stored settings');
{
  const { S, ST } = bootState();
  clearGlobalMatchMedia();
  ok('DEFAULT_SETTINGS seeds glass:\'auto\' before any explicit choice',
    S.settings.glass === 'auto', 'settings.glass=' + S.settings.glass);

  ST.setSetting('glass', 'off');
  ok('setSetting(\'glass\', \'off\') refuses nothing (glass is a real DEFAULT_SETTINGS key) and updates state immediately',
    S.settings.glass === 'off', 'settings.glass=' + S.settings.glass);

  // Simulate a fresh boot: wipe in-memory state back to defaults, then load()
  // from the same localStorage the setSetting() call above wrote to.
  S.settings.glass = 'auto';
  ST.load();
  ok('a reload (ST.load()) restores \'off\' from localStorage — the setting survives a real page reload',
    S.settings.glass === 'off', 'settings.glass after reload=' + S.settings.glass);
}

process.exit(report());

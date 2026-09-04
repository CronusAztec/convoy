/* Convoy — minimal browser shim + module loader for Node tests.

   The client modules are plain IIFEs that hang themselves off window.App, so
   they load fine in Node once `window`, `document` and a couple of timers exist.
   Nothing here fakes app behaviour: the real js/*.js source is executed, and the
   tests drive it through its real public API. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* Module boot list, derived from index.html's own <script src="js/*.js">
   tags rather than hardcoded — so it can never drift from what production
   actually boots. Moved here (cycle 9, task 3) from test/frontend.test.js
   (which cannot be require()'d for just these two functions — it's a
   runnable script that calls process.exit() at the end) so
   test/lazydata.test.js can share it instead of writing a third copy of the
   regex, per this cycle's directive. frontend.test.js now reads these off H. */
const BOOT_SCRIPT_TAG_RE = /<script\b[^>]*src="js\/([^"?]+)\.js(?:\?[^"]*)?"[^>]*>/g;
function bootScriptTags(html) { return Array.from(html.matchAll(BOOT_SCRIPT_TAG_RE)); }
function bootModuleNames(html) { return bootScriptTags(html).map((m) => m[1]); }

/* ---------------- tiny DOM shim ----------------
   Only what the modules under test touch at load time. Anything unexpected
   throws loudly rather than silently returning undefined. */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', id: '', title: '', innerHTML: '', textContent: '',
    hidden: false, disabled: false, value: '',
    // style needs the CSS-custom-property methods, not just plain assignment:
    // several modules set their accent through --paint, and a bare object makes
    // that a TypeError rather than a no-op.
    style: {
      _vars: {},
      setProperty(k, v) { this._vars[k] = String(v); },
      getPropertyValue(k) { return this._vars[k] || ''; },
      removeProperty(k) { delete this._vars[k]; }
    },
    dataset: {}, children: [], parentNode: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { const want = on === undefined ? !this._s.has(c) : !!on; want ? this._s.add(c) : this._s.delete(c); return want; },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    insertBefore(c) { this.children.unshift(c); c.parentNode = this; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this['attr_' + k] = v; },
    getAttribute(k) { return this['attr_' + k]; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    querySelector() { return null },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  };
  return el;
}

/* A real listener registry for window and document, so a test can fire a DOM
   event (visibilitychange, resize …) and prove the module's handler ran. These
   were no-op stubs until cycle 59: a test of a visibilitychange listener passed
   before the listener existed. `_listeners(type)` is the assertion surface. */
function eventTarget(obj) {
  const listeners = new Map();
  obj.addEventListener = function (type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); };
  obj.removeEventListener = function (type, fn) { const a = listeners.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  obj.dispatchEvent = function (ev) { (listeners.get(ev && ev.type) || []).slice().forEach((fn) => fn.call(obj, ev)); return true; };
  obj._listeners = (type) => (listeners.get(type) || []).slice();
  return obj;
}

function installBrowser() {
  const store = new Map();
  const win = {
    App: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setInterval, clearInterval,
    speechSynthesis: null,
    AudioContext: null,
    navigator: { geolocation: null, userAgent: 'node' },
    performance: { now: () => Date.now() }
  };
  const doc = {
    documentElement: makeEl('html'),
    head: makeEl('head'),
    body: makeEl('body'),
    hidden: false,
    createElement: makeEl,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  eventTarget(win);
  eventTarget(doc);
  win.document = doc;

  // Node ≥21 defines `navigator` and `performance` as getter-only globals, so
  // plain assignment throws — define them instead.
  function put(name, value) {
    try { global[name] = value; }
    catch (e) { Object.defineProperty(global, name, { value: value, writable: true, configurable: true }); }
  }
  put('window', win);
  put('document', doc);
  put('localStorage', win.localStorage);
  put('navigator', win.navigator);
  put('requestAnimationFrame', win.requestAnimationFrame);
  put('cancelAnimationFrame', win.cancelAnimationFrame);
  put('fetch', undefined);
  win.performance = global.performance || win.performance;
  return win;
}

// Execute a client module in the current (shimmed) global scope.
function loadModule(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src).call(global.window);
}

/* ---------------- audio / WebRTC fakes ----------------
   js/voice.js is pure Web Audio plus WebRTC, and Node has neither. These fakes
   do not simulate sound — they record the GRAPH. Every node keeps its outgoing
   connect() edges, so a test can assert *where* audio goes, which is the only
   question behind per-peer mute: a gain node the audio never passes through is
   a control that does nothing.

   Every capability is individually removable through `opts`, because the
   Android WebView is not the desktop browser this was written against and the
   degradation paths have to be provable without a phone. */

const ALL_CONSTRAINTS = ['deviceId', 'echoCancellation', 'noiseSuppression',
  'autoGainControl', 'channelCount', 'sampleRate', 'voiceIsolation'];

let seq = 0;

function installAudio(win, opts) {
  opts = opts || {};
  const on = (k) => (opts[k] === undefined ? true : !!opts[k]);
  const caps = {
    ctxSetSinkId: on('ctxSetSinkId'),
    elSetSinkId: on('elSetSinkId'),
    enumerateDevices: on('enumerateDevices'),
    replaceTrack: on('replaceTrack'),
    deviceLabels: on('deviceLabels'),
    constraints: opts.constraints || ALL_CONSTRAINTS.slice()
  };

  const rec = {
    caps,
    contexts: [], peers: [], elements: [], nodes: [],
    gumCalls: [], sinkCalls: [], replaceCalls: [],
    lastConstraints: null, lastStream: null,
    gumFail: null,
    devices: opts.devices || [
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Microphone' },
      { kind: 'audioinput', deviceId: 'usb-mic', label: 'USB Podcast Mic' },
      { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers' },
      { kind: 'audiooutput', deviceId: 'bt-headset', label: 'Bluetooth Headset' }
    ]
  };

  /* --- graph primitives. `outputs` is the assertion surface. --- */
  function node(type, ctx, extra) {
    const n = Object.assign({
      nodeType: type, ctx: ctx, outputs: [], inputs: [],
      connect(dst) {
        this.outputs.push(dst);
        if (dst && dst.inputs) dst.inputs.push(this);
        return dst;
      },
      disconnect() {
        this.outputs.forEach((d) => { if (d && d.inputs) d.inputs = d.inputs.filter((x) => x !== this); });
        this.outputs = [];
      }
    }, extra || {});
    rec.nodes.push(n);
    return n;
  }
  function param(v) {
    return { value: v, setValueAtTime(x) { this.value = x; }, linearRampToValueAtTime(x) { this.value = x; } };
  }
  function mkTrack(deviceId, label) {
    return {
      kind: 'audio', id: 'trk' + (++seq), enabled: false, readyState: 'live',
      label: label || 'fake mic', deviceId: deviceId || 'default',
      appliedConstraints: null,
      stop() { this.readyState = 'ended'; },
      getSettings() { return { deviceId: this.deviceId }; },
      applyConstraints(c) {
        if (opts.applyConstraintsFails) return Promise.reject(new Error('OverconstrainedError'));
        this.appliedConstraints = c;
        rec.lastApplied = c;
        return Promise.resolve();
      }
    };
  }
  function mkStream(track) {
    return {
      id: 'str' + (++seq), active: true,
      getTracks() { return [track]; },
      getAudioTracks() { return [track]; }
    };
  }

  /* --- AudioContext.
     Factory methods live on the PROTOTYPE, as they do on the real
     BaseAudioContext. Feature detection runs before any context exists, so a
     fake that hangs them on the instance would make correct detection look
     broken and tempt someone into loosening the check. --- */
  function FakeAudioContext() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = node('destination', this);
    rec.contexts.push(this);
  }
  FakeAudioContext.prototype.createGain = function () { return node('gain', this, { gain: param(1) }); };
  FakeAudioContext.prototype.createAnalyser = function () {
    const an = node('analyser', this, {
      _fft: 2048,
      getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 128; }
    });
    Object.defineProperty(an, 'fftSize', { get() { return this._fft; }, set(v) { this._fft = v; }, configurable: true });
    Object.defineProperty(an, 'frequencyBinCount', { get() { return this._fft / 2; }, configurable: true });
    return an;
  };
  FakeAudioContext.prototype.createBufferSource = function () {
    return node('bufferSource', this, { buffer: null, started: false, start() { this.started = true; }, stop() {} });
  };
  FakeAudioContext.prototype.createBuffer = function (ch, len, rate) {
    const data = new Float32Array(len);
    return { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData() { return data; } };
  };
  FakeAudioContext.prototype.createMediaStreamSource = function (s) {
    return node('mediaStreamSource', this, { stream: s });
  };
  FakeAudioContext.prototype.createMediaStreamDestination = function () {
    return node('mediaStreamDestination', this, { stream: mkStream(mkTrack('bus', 'bus out')) });
  };
  FakeAudioContext.prototype.createDynamicsCompressor = function () {
    return node('compressor', this, {
      threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25)
    });
  };
  FakeAudioContext.prototype.createScriptProcessor = function (size) {
    return node('scriptProcessor', this, { bufferSize: size, onaudioprocess: null });
  };
  FakeAudioContext.prototype.resume = function () { this.state = 'running'; return Promise.resolve(); };
  FakeAudioContext.prototype.close = function () { this.state = 'closed'; return Promise.resolve(); };
  // On the prototype, not the instance: feature detection looks at
  // AudioContext.prototype.setSinkId before any context has been built.
  if (caps.ctxSetSinkId) {
    FakeAudioContext.prototype.setSinkId = function (id) {
      rec.sinkCalls.push({ target: 'ctx', id: id });
      this.sinkId = id;
      return Promise.resolve();
    };
  }

  /* --- RTCPeerConnection --- */
  function FakeRTC(cfg) {
    this.config = cfg;
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    this._senders = [];
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    rec.peers.push(this);
  }
  FakeRTC.prototype.addTrack = function (t) {
    const pc = this;
    const sender = { track: t };
    if (caps.replaceTrack) {
      sender.replaceTrack = function (nt) { this.track = nt; rec.replaceCalls.push({ pc: pc, track: nt }); return Promise.resolve(); };
    }
    this._senders.push(sender);
    return sender;
  };
  FakeRTC.prototype.getSenders = function () { return this._senders.slice(); };
  FakeRTC.prototype.setLocalDescription = function (d) { this.localDescription = d || { type: 'offer', sdp: 'fake-sdp' }; return Promise.resolve(); };
  FakeRTC.prototype.setRemoteDescription = function (d) { this.remoteDescription = d; return Promise.resolve(); };
  FakeRTC.prototype.addIceCandidate = function () { return Promise.resolve(); };
  FakeRTC.prototype.createOffer = function () { return Promise.resolve({ type: 'offer', sdp: 'fake-sdp' }); };
  FakeRTC.prototype.createAnswer = function () { return Promise.resolve({ type: 'answer', sdp: 'fake-sdp' }); };
  FakeRTC.prototype.close = function () { this.closed = true; this.connectionState = 'closed'; };

  /* --- HTMLAudioElement --- */
  function FakeAudio() {
    this.muted = false; this.srcObject = null; this.paused = true; this.volume = 1;
    rec.elements.push(this);
  }
  FakeAudio.prototype.play = function () { this.paused = false; return Promise.resolve(); };
  FakeAudio.prototype.pause = function () { this.paused = true; };
  if (caps.elSetSinkId) {
    FakeAudio.prototype.setSinkId = function (id) { rec.sinkCalls.push({ target: 'el', id: id }); this.sinkId = id; return Promise.resolve(); };
  }

  /* --- navigator.mediaDevices --- */
  const mediaDevices = {
    getUserMedia(c) {
      rec.gumCalls.push(c);
      rec.lastConstraints = c && c.audio;
      if (rec.gumFail) { const msg = rec.gumFail; rec.gumFail = null; return Promise.reject(new Error(msg)); }
      const want = c && c.audio && c.audio.deviceId;
      const id = typeof want === 'string' ? want : (want && (want.exact || want.ideal)) || 'default';
      const s = mkStream(mkTrack(id, 'fake mic ' + id));
      rec.lastStream = s;
      return Promise.resolve(s);
    },
    getSupportedConstraints() {
      const o = {};
      caps.constraints.forEach((k) => { o[k] = true; });
      return o;
    },
    addEventListener() {}, removeEventListener() {}
  };
  if (caps.enumerateDevices) {
    mediaDevices.enumerateDevices = function () {
      return Promise.resolve(rec.devices.map((d) => ({
        kind: d.kind, deviceId: d.deviceId, groupId: 'grp',
        label: caps.deviceLabels ? d.label : ''
      })));
    };
  }

  function put(name, value) {
    win[name] = value;
    try { global[name] = value; }
    catch (e) { Object.defineProperty(global, name, { value: value, writable: true, configurable: true }); }
  }
  win.navigator.mediaDevices = mediaDevices;
  put('AudioContext', FakeAudioContext);
  put('webkitAudioContext', undefined);
  put('RTCPeerConnection', FakeRTC);
  put('RTCSessionDescription', function (d) { return d; });
  put('RTCIceCandidate', function (d) { return d; });
  put('Audio', FakeAudio);

  /* Walk the graph from `from`, returning true when `to` is reachable. */
  rec.reaches = function (from, to) {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen.has(n)) continue;
      if (n === to) return true;
      seen.add(n);
      (n.outputs || []).forEach((o) => stack.push(o));
    }
    return false;
  };
  /* The chain of node types from `from` outward, for readable failures. */
  rec.chain = function (from) {
    const out = [];
    let n = from;
    const seen = new Set();
    while (n && !seen.has(n)) { seen.add(n); out.push(n.nodeType); n = (n.outputs || [])[0]; }
    return out.join(' -> ');
  };
  return rec;
}

/* ---------------- assertions ---------------- */
let passed = 0;
const failures = [];
let suite = '';

function group(name) { suite = name; console.log('\n\x1b[1m' + name + '\x1b[0m'); }

function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else {
    failures.push(suite + ' › ' + label + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31m✗ ' + label + '\x1b[0m' + (detail ? '\n      ' + detail : ''));
  }
}

function near(label, actual, expected, tol, unit) {
  const d = Math.abs(actual - expected);
  ok(label + '  (' + fmt(actual) + ' vs ' + fmt(expected) + (unit ? ' ' + unit : '') + ', |Δ|=' + fmt(d) + ' ≤ ' + tol + ')',
    d <= tol, d <= tol ? null
    : 'expected within ' + tol + (unit ? ' ' + unit : '') + ', off by ' + fmt(d));
  return d;
}

function fmt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4);
}

function report() {
  console.log('\n' + '─'.repeat(60));
  if (!failures.length) {
    console.log('\x1b[32m\x1b[1mAll ' + passed + ' checks passed.\x1b[0m');
    return 0;
  }
  console.log('\x1b[31m\x1b[1m' + failures.length + ' failed\x1b[0m, ' + passed + ' passed:');
  failures.forEach((f) => console.log('  \x1b[31m•\x1b[0m ' + f));
  return 1;
}

/* ---------------- real-UI jsdom boot (moved here cycle 7 from
   test/lazydata.test.js so test/leaks.test.js can share the exact same
   boot path — "what a WebView actually renders", not a second hand-written
   fixture that can drift from it). Behaviour is unchanged from the original;
   only the require site moved. ---------------- */

// Execute the real index.html + js/*.js in a real jsdom window, with dynamic
// <script src="..."> injection intercepted so A.data.ensure()-style lazy
// loaders resolve deterministically under test control (see scriptOutcomes).
function bootRealUi(opts) {
  const scriptDelayMs = (opts && opts.scriptDelayMs) || 0;
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  win.matchMedia = win.matchMedia || function () {
    return { matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
  };
  win.Capacitor = undefined;
  win.fetch = function () { return Promise.reject(new Error('network disabled in test harness')); };

  // jsdom's runScripts:'outside-only' never fetches or executes a dynamically
  // injected <script src>, so A.data.ensure()'s real loadScript() would hang
  // forever without this. Intercept just the `src` setter on <script>
  // elements: queue an outcome per injection, and on "success" actually eval
  // the real file's source in this window (the same effect a browser's own
  // fetch+execute-then-fire-onload would have) so D.MAKE_LIST etc. are real,
  // not empty. Every other tag goes through the unmodified real jsdom path.
  const scriptOutcomes = [];
  const realCreateElement = win.document.createElement.bind(win.document);
  win.document.createElement = function (tag) {
    const el = realCreateElement(tag);
    if (String(tag).toLowerCase() === 'script') {
      Object.defineProperty(el, 'src', {
        get() { return el.getAttribute('src') || ''; },
        set(v) {
          el.setAttribute('src', v);
          const outcome = scriptOutcomes.length ? scriptOutcomes.shift() : 'ok';
          setTimeout(function () {
            if (outcome === 'fail') { if (el.onerror) el.onerror(new win.Event('error')); return; }
            try { win.eval(fs.readFileSync(path.join(ROOT, String(v).split('?')[0]), 'utf8')); }
            catch (e) { if (el.onerror) el.onerror(new win.Event('error')); return; }
            if (el.onload) el.onload(new win.Event('load'));
          }, scriptDelayMs);
        }
      });
    }
    return el;
  };

  function put(name, value) {
    try { global[name] = value; }
    catch (e) { Object.defineProperty(global, name, { value, writable: true, configurable: true }); }
  }
  put('window', win);
  put('document', win.document);
  put('localStorage', win.localStorage);
  put('navigator', win.navigator);
  put('requestAnimationFrame', win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(() => fn(Date.now()), 0));
  put('cancelAnimationFrame', win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : clearTimeout);
  put('fetch', win.fetch);

  // test/frontend.test.js's own MODULE_ORDER (for jsdom UI-rendering
  // completeness) still evals js/data.js and js/voice.js unconditionally at
  // boot — deliberately, per STATE.md: that list is the app's module SET for
  // jsdom, not a mirror of what index.html currently <script>-tags. Loading
  // it here too would set A.data.loaded/A.voice before a single test ran,
  // permanently taking the fast path and making the lazy/failure branch this
  // file exists to test unreachable. So: everything else index.html loads,
  // MINUS 'data', 'voice', 'radar', 'scanners', 'race' and 'dragy' — those six
  // are loaded lazily, on demand, by the real A.data.ensure() /
  // A.voiceLoader.ensure() / A.lazy.radar() / A.lazy.scanners() /
  // A.lazy.race() / A.lazy.dragy() calls under test.
  const MODULE_ORDER = ['config', 'telemetry', 'util', 'state', 'themes', 'detectors', 'space',
    'mapview', 'sim', 'net', 'routing', 'ghost', 'overlays',
    'racetimer', 'wake', 'places', 'triplog', 'speedo', 'hud', 'compass',
    'clock', 'tripmeter', 'gmeter', 'quest', 'weathernow', 'battery', 'coords',
    'destarrow', 'riderarrows', 'speedalert', 'dimmer', 'tripextras', 'party',
    'ui', 'auth', 'native', 'ota'];
  MODULE_ORDER.forEach(function (name) {
    win.eval(fs.readFileSync(path.join(ROOT, 'js', name + '.js'), 'utf8'));
  });
  return { win, doc: win.document, A: win.App, scriptOutcomes };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A.lazy.race() chains TWO sequential "script load" macrotasks (dragy, then
// race — Trap A's dependency order), so a fixed sleep long enough on a quiet
// box can still be too short on this one (a persistent, unrelated Chromium
// session — see STATE.md §8 — makes Node's own timer scheduling jittery
// under load). Poll instead of guessing a constant.
async function waitFor(predicate, timeoutMs) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(15);
  }
  return true;
}

module.exports = {
  installBrowser, installAudio, loadModule, makeEl, group, ok, near, report, fmt, ROOT,
  bootRealUi, sleep, waitFor, bootScriptTags, bootModuleNames
};

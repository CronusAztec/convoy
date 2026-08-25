/* Convoy — minimal browser shim + module loader for Node tests.

   The client modules are plain IIFEs that hang themselves off window.App, so
   they load fine in Node once `window`, `document` and a couple of timers exist.
   Nothing here fakes app behaviour: the real js/*.js source is executed, and the
   tests drive it through its real public API. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ---------------- tiny DOM shim ----------------
   Only what the modules under test touch at load time. Anything unexpected
   throws loudly rather than silently returning undefined. */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', id: '', title: '', innerHTML: '', textContent: '',
    hidden: false, disabled: false, value: '',
    style: {}, dataset: {}, children: [], parentNode: null,
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
    addEventListener() {}, removeEventListener() {},
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
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}
  };
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

module.exports = { installBrowser, loadModule, makeEl, group, ok, near, report, fmt, ROOT };

/* Convoy — field Web Vitals: LCP, CLS, INP (approximated), long tasks and
   navigation timing, collected on a real rider's device and shipped once per
   session through the existing js/telemetry.js pipe.

   Everything the lab bench (test/perf-bench.js) cannot see lives here: the
   box's own headless-Chromium recipe is noise-dominated by a persistent
   fixture (STATE.md §8 item 8), so this is the only place any of P-A's
   remaining criteria, P-B's mobile LCP, or P-C's INP/dropped-frame rows can
   ever get a real number. See STATE.md §6 "Field Web Vitals".

   Deliberately zero boot cost: not <script>-tagged in index.html at all,
   loaded only via A.lazy.vitals() from js/app.js's load+idle warm, same shape
   as A.data/A.voice. A rider who never gets a chance to load+idle (killed
   before 'load' fires) simply never reports — no report is honest here, a
   fabricated one is not.

   Each PerformanceObserver is registered in its own try/catch: a WebView
   missing one entry type (e.g. no 'event' timing) must not cost the others. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  var lcp = null;      // ms, startTime of the LAST largest-contentful-paint entry
  // Running sum of layout-shift values for entries with no recent input. This
  // is the simple, honest version (not the max 5s/1s "session window" the
  // official web-vitals library computes) — shipped first on purpose; see the
  // module comment above and the cycle-15 report for why.
  var cls = 0;
  // Conservative approximation of INP: the single longest 'event' entry
  // duration seen all session, not the true 98th-percentile-of-interactions.
  // Never reported to a human as "INP" without this qualification.
  var inp = null;
  var lt = 0;           // count of long tasks (field twin of the lab metric)
  var reported = false;

  function safeObserve(type, extra, onEntries) {
    try {
      var po = new PerformanceObserver(function (list) { onEntries(list.getEntries()); });
      var opts = { type: type, buffered: true };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) opts[k] = extra[k]; } }
      po.observe(opts);
    } catch (e) { /* this entry type isn't supported here — the others still are */ }
  }

  function init() {
    safeObserve('largest-contentful-paint', null, function (entries) {
      if (entries.length) lcp = entries[entries.length - 1].startTime;
    });
    safeObserve('layout-shift', null, function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].hadRecentInput) cls += entries[i].value;
      }
    });
    safeObserve('event', { durationThreshold: 40 }, function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (inp === null || entries[i].duration > inp) inp = entries[i].duration;
      }
    });
    safeObserve('longtask', null, function (entries) { lt += entries.length; });

    // report() runs right before the session's own 'end' event, whichever
    // fires first (backgrounded, or pagehide) — never on a timer of its own.
    if (A.telemetry && A.telemetry.beforeEnd) A.telemetry.beforeEnd(report);
  }

  function nav() {
    var out = {};
    try {
      var n = performance.getEntriesByType('navigation')[0];
      if (!n) return out;
      out.dcl = Math.round(n.domContentLoadedEventEnd);
      out.load = Math.round(n.loadEventEnd);
      out.ttfb = Math.round(n.responseStart);
    } catch (e) { /* navigation timing not available here */ }
    return out;
  }

  function report() {
    if (reported) return;
    reported = true;
    var o = nav();
    if (lcp != null) o.lcp = Math.round(lcp);
    o.cls = Math.round(cls * 1000);   // 0.083 -> 83; server divides back for display
    if (inp != null) o.inp = Math.round(inp);
    if (lt) o.lt = lt;
    if (A.telemetry && A.telemetry.vitals) A.telemetry.vitals(o);
  }

  A.vitals = {
    init: init,
    // Inspection hook for tests; never sent anywhere as-is.
    snapshot: function () { return { lcp: lcp, cls: cls, inp: inp, lt: lt, reported: reported }; }
  };
})();

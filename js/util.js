/* Convoy — geo math, formatting, DOM helpers */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var R = 6371000; // earth radius, meters
  var D2R = Math.PI / 180;
  var R2D = 180 / Math.PI;

  function haversine(a, b) {
    var dLat = (b[1] - a[1]) * D2R;
    var dLng = (b[0] - a[0]) * D2R;
    var la1 = a[1] * D2R, la2 = b[1] * D2R;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(a, b) {
    var la1 = a[1] * D2R, la2 = b[1] * D2R;
    var dLng = (b[0] - a[0]) * D2R;
    var y = Math.sin(dLng) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * R2D + 360) % 360;
  }

  // Move [lng,lat] by dist meters along bearing brg (degrees)
  function destPoint(pos, brg, dist) {
    var d = dist / R, t = brg * D2R;
    var la1 = pos[1] * D2R, ln1 = pos[0] * D2R;
    var sinLa2 = Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(t);
    var la2 = Math.asin(sinLa2);
    var ln2 = ln1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * sinLa2);
    return [ln2 * R2D, la2 * R2D];
  }

  // Signed angle (deg, -180..180) of point `to` relative to facing `heading` from `from`.
  // 0 = dead ahead, ±180 = directly behind.
  function relBearing(from, heading, to) {
    return ((bearing(from, to) - heading + 540) % 360) - 180;
  }

  // Perpendicular distance (m) from `to` to the line through `from` along `heading`.
  // Small value ⇒ on the same street/corridor the driver is travelling.
  function crossTrack(from, heading, to) {
    var d13 = haversine(from, to) / R;
    var th13 = bearing(from, to) * D2R;
    var th12 = heading * D2R;
    return Math.abs(Math.asin(clamp(Math.sin(d13) * Math.sin(th13 - th12), -1, 1)) * R);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpPos(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]; }
  function lerpAngle(a, b, t) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function randInt(lo, hi) { return Math.floor(rand(lo, hi + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function chance(p) { return Math.random() < p; }
  function uid() { return 'id' + Math.random().toString(36).slice(2, 10); }

  // The 10-unit floor keeps a small non-zero distance from collapsing to "0",
  // but a real zero has to read as zero: the tripmeter renders through this and
  // opened (and reset) to "10 ft" of travel that never happened.
  //
  // The metres->km handover is at 1000, not 950. At 950 the last metre reading
  // was "950 m" and the first km reading was (0.95).toFixed(1) === "0.9 km", so
  // the display counted BACKWARDS across the boundary. At 1000 the two sides
  // meet at 1000 m / "1.0 km".
  function fmtDist(m, units) {
    if (!(m > 0)) return units === 'km' ? '0 m' : '0 ft';
    if (units === 'km') {
      if (m < 1000) return Math.max(10, Math.round(m / 10) * 10) + ' m';
      var km = m / 1000;
      return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
    }
    var mi = m * 0.000621371;
    if (mi < 0.095) return Math.max(10, Math.round(m * 3.28084 / 10) * 10) + ' ft';
    return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
  }

  function fmtDur(sec) {
    var m = Math.round(sec / 60);
    if (m < 1) return '<1 min';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ' hr' + (mm ? ' ' + mm + ' min' : '');
  }

  function fmtClock(date) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Perceived brightness 0..255 — used to pick readable strokes on paint chips
  // Rough brightness sort over gamma-encoded channels. Good enough to classify a
  // palette as light or dark; do NOT use it to choose ink — see bestInk below.
  function luma(hex) {
    var c = hexToRgb(hex);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // WCAG relative luminance: channels linearized before weighting. This is what
  // actually predicts contrast, and it is why luma() cannot: on gamma-encoded
  // values a mid-bright hue like #ff2bd6 reads as "dark" and gets white ink at
  // 3.2:1, when near-black would have given 6.0:1.
  function relLuma(hex) {
    var c = hexToRgb(hex);
    var f = c.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  }

  // WCAG 2.1 contrast ratio, 1..21.
  function contrast(a, b) {
    var l1 = relLuma(a), l2 = relLuma(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  // Pick the ink that actually reads better on `bg`. With two candidates a direct
  // ratio comparison is optimal and has no threshold to mis-tune — a luma cutoff
  // got 5 of the 9 pickable accent swatches wrong, each landing under 4.5:1.
  function bestInk(bg, darkInk, lightInk) {
    darkInk = darkInk || '#02101a';
    lightInk = lightInk || '#ffffff';
    return contrast(darkInk, bg) >= contrast(lightInk, bg) ? darkInk : lightInk;
  }

  // Own-property probe for the object literals used as allowlists/lookup
  // tables below. A bare `TABLE[k]` also finds inherited Object.prototype
  // members, so 'constructor' / 'toString' / '__proto__' pass allowlists they
  // were never on and defeat the `|| fallback` beside them.
  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Paint colors land raw inside style="--paint:…"/background:…/value="…"
  // attributes. The server already rejects anything but #hex (sanitizeProfile),
  // but the client renders records it didn't necessarily get from this server
  // version — mirror that regex at every sink so attribute breakout stays
  // impossible even if one inbound path ever misses validation.
  function safePaint(v, dflt) {
    return (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : (dflt || '#4f8cff');
  }
  // Same idea for the car finish enum, which renders raw next to the paint.
  var FINISHES = { Gloss: 1, Matte: 1, Metallic: 1, Satin: 1 };
  function safeFinish(v) {
    return own(FINISHES, v) ? v : 'Gloss';
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // Inject a <script> and resolve/reject on load/error. Shared by every
  // lazy-loaded module (CDN feature scripts, js/data.js) so there is exactly
  // one script-injection implementation in the app.
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = function () { s.remove(); reject(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Cache-by-key wrapper around any promise-returning factory (loadScript, but
  // the shape is generic). Concurrent callers for the same key share one
  // in-flight promise/injected <script>; once it settles successfully the
  // cached resolved promise keeps answering instantly with no further calls.
  // On REJECTION the cache entry is cleared so the next call retries the
  // factory instead of replaying the same failure forever — a lazy loader that
  // caches a rejected promise for the rest of the session (the shape
  // A.data.ensure() used to have) turns one flaky idle-warm fetch into a
  // permanently broken panel. Not bounded: the default path always retries on
  // the next call; callers that want a ceiling can count their own attempts.
  var onceCache = {};
  function loadOnce(key, factory) {
    var cached = onceCache[key];
    if (cached) return cached;
    var p = factory().catch(function (e) {
      delete onceCache[key];
      throw e;
    });
    onceCache[key] = p;
    return p;
  }

  /* ---------- rider identity icons ----------
     Flat-color geometric SVG insignias (solid fills, no stroke). A "key" is a
     small integer (0..7); we coerce anything legacy (an emoji char, undefined)
     to a stable key by hashing, so old saved profiles keep a deterministic
     glyph. All glyphs fill currentColor, so they tint with the surrounding
     --paint / accent. */
  var ICON_PATHS = [
    // 0 — solid circle
    '<circle cx="12" cy="12" r="7"/>',
    // 1 — solid square
    '<rect x="5.5" y="5.5" width="13" height="13" rx="1"/>',
    // 2 — solid triangle
    '<path d="M12 5 20 19 4 19Z"/>',
    // 3 — rounded square (squircle-ish)
    '<rect x="5" y="5" width="14" height="14" rx="4"/>',
    // 4 — horizontal bar (rounded)
    '<rect x="4" y="10" width="16" height="4" rx="2"/>',
    // 5 — ring (donut): white core over the fill via even-odd
    '<path fill-rule="evenodd" d="M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 3.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6Z"/>',
    // 6 — chevron up
    '<path d="M4 15 12 7 20 15" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    // 7 — plus / cross
    '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6Z"/>'
  ];

  // Stable key (0..ICONS-1) from any value. Handles legacy emoji + undefined.
  function iconKey(v) {
    var n = ICON_PATHS.length;
    if (v == null) return 0;
    if (typeof v === 'number') return ((v % n) + n) % n;
    var s = String(v);
    if (/^[0-9]+$/.test(s)) return ((parseInt(s, 10) % n) + n) % n;
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % n;
  }

  // Inline rider insignia. opts.size = px (default 22). Flat fill = currentColor.
  function riderIcon(v, opts) {
    opts = opts || {};
    var size = opts.size || 22;
    return '<svg class="rider-icon"' + (opts.cls ? ' style="' + opts.cls + '"' : '') +
      ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" ' +
      'aria-hidden="true">' + ICON_PATHS[iconKey(v)] + '</svg>';
  }

  // Convoy flag glyph — a solid banner/pennant, also keyed.
  function convoyFlag(v) {
    var variants = [
      '<path d="M5 3H19L15.5 8.5 19 14H5Z"/><path d="M4 3H6.5V21H4Z"/>',
      '<path d="M6 3 16 9 6 15Z"/><path d="M4 3H6.5V21H4Z"/>',
      '<path d="M5 3H18L14.5 8.5 18 14H5Z"/><circle cx="10.5" cy="8.5" r="1.6" fill="#0a1120"/><path d="M4 3H6.5V21H4Z"/>'
    ];
    return '<svg class="rider-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" ' +
      'aria-hidden="true">' +
      variants[iconKey(v) % variants.length] + '</svg>';
  }


  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  /* Sunrise/sunset for a lat/lng via the classic NOAA/almanac approximation
     (accurate to a couple of minutes — plenty for theming). Returns {rise, set}
     as Dates for today, or null in polar day/night when the sun never crosses
     the horizon. */
  function sunTimes(lat, lng, date) {
    var d = date || new Date();
    var rad = Math.PI / 180;
    var n = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
      Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
    function calc(rising) {
      var lngHour = lng / 15;
      var t = n + ((rising ? 6 : 18) - lngHour) / 24;
      var M = (0.9856 * t) - 3.289;
      var L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634;
      L = (L % 360 + 360) % 360;
      var RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
      RA = (RA % 360 + 360) % 360;
      RA += (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90);
      RA /= 15;
      var sinDec = 0.39782 * Math.sin(L * rad);
      var cosDec = Math.cos(Math.asin(sinDec));
      var cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
      if (cosH > 1 || cosH < -1) return null; // polar: no rise/set today
      var H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
      var T = H + RA - (0.06571 * t) - 6.622;
      var UT = ((T - lngHour) % 24 + 24) % 24;
      var res = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      res.setUTCMinutes(Math.round(UT * 60));
      return res;
    }
    var rise = calc(true), set = calc(false);
    return (rise && set) ? { rise: rise, set: set } : null;
  }

  // Is the sun up at this location right now? Polar day/night (no rise/set)
  // falls back to the hemisphere's season.
  function isDaylight(lat, lng, now) {
    now = now || new Date();
    var st = sunTimes(lat, lng, now);
    if (!st) {
      var summer = now.getUTCMonth() >= 3 && now.getUTCMonth() <= 8; // Apr–Sep
      return lat >= 0 ? summer : !summer;
    }
    // rise/set are both stamped onto TODAY'S UTC calendar day. Wherever local
    // sunset falls after UTC midnight — everything west of roughly 60°W, plus
    // East Asia — `set` lands EARLIER in the day than `rise`, so the naive
    // `now >= rise && now < set` window is empty and this returned false at
    // local noon. (Europe/Africa happened to work, which is why it survived.)
    // When the window wraps midnight, daylight is the UNION of the two ends.
    var t = now.getTime(), r = st.rise.getTime(), s = st.set.getTime();
    return (r <= s) ? (t >= r && t < s) : (t >= r || t < s);
  }

  /* ---------------- every client fetch gets a deadline ----------------
     A fetch with no signal never rejects when the socket stalls (a tunnel, a
     captive portal — a phone on a motorcycle), and five map layers set a bbox
     latch BEFORE their fetch that only .catch() clears, so one stalled response
     killed the layer for the rest of the ride, silently (BUGS.md frontend-020).
     Every fetch in js/ goes through fetchT(); test/fetchtimeout.test.js fails
     the build on a bare fetch(). A caller's own signal is honoured (combined
     with the deadline through AbortSignal.any where the engine has it).

     The table is load-bearing: server/overpass.js tries MIRRORS.length (2)
     mirrors at TIMEOUT_MS (30 s) each before it answers, so a client deadline
     below 60 s aborts WORKING enforcement lookups. test/fetchtimeout.test.js
     group C pins overpass >= MIRRORS × TIMEOUT_MS and aircraft >
     UPSTREAM_TIMEOUT_MS (server/aircraft.js) — change the server first. */
  var FETCH_TIMEOUT = {
    overpass: 75000,  // /api/overpass: 2 mirrors × 30 s, plus 15 s for the proxy and the pipe
    aircraft: 20000,  // /api/aircraft: server UPSTREAM_TIMEOUT_MS 12 s, plus slack
    api: 15000        // every other same-origin /api/* and every direct third-party call
  };
  function deadlineSignal(ms) {
    if (typeof AbortSignal === 'function' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    if (typeof AbortController === 'function') {
      var c = new AbortController();
      setTimeout(function () { c.abort(); }, ms);
      return c.signal;
    }
    return null; // no abort on this engine: a plain fetch, as before
  }
  function fetchT(url, opts, ms) {
    var o = {}, k;
    if (opts) for (k in opts) if (own(opts, k)) o[k] = opts[k]; // never mutate the caller's object
    var t = (typeof ms === 'number' && ms > 0) ? ms : FETCH_TIMEOUT.api;
    if (!o.signal) {
      var d = deadlineSignal(t);
      if (d) o.signal = d;
    } else if (typeof AbortSignal === 'function' && typeof AbortSignal.any === 'function') {
      var d2 = deadlineSignal(t);
      if (d2) o.signal = AbortSignal.any([o.signal, d2]);
    }
    return fetch(url, o);
  }

  /* Visual-only pollers (BUGS.md frontend-021): a hidden page paints nothing,
     so the tick is skipped (document.hidden read at tick time) and no request
     is made; on the way back ONE coalesced refresh runs per poller, only if it
     is due — no storm when flicking between apps. Timers that alert, speak or
     transmit stay plain setInterval: test/visibility.test.js lists each with
     its reason. Returns the interval id; unpoll(id) clears it, returns null. */
  var polls = [];
  function poll(fn, ms) {
    var e = { fn: fn, ms: ms, at: Date.now() };
    e.id = setInterval(function () {
      if (document.hidden) return;
      e.at = Date.now();
      fn();
    }, ms);
    polls.push(e);
    return e.id;
  }
  function unpoll(id) {
    clearInterval(id);
    for (var i = 0; i < polls.length; i++) if (polls[i].id === id) { polls.splice(i, 1); break; }
    return null;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    var now = Date.now();
    for (var i = 0; i < polls.length; i++) if (now - polls[i].at >= polls[i].ms) { polls[i].at = now; polls[i].fn(); }
  });

  A.util = {
    haversine: haversine, bearing: bearing, destPoint: destPoint,
    relBearing: relBearing, crossTrack: crossTrack,
    lerp: lerp, lerpPos: lerpPos, lerpAngle: lerpAngle,
    clamp: clamp, rand: rand, randInt: randInt, pick: pick, chance: chance, uid: uid, own: own,
    fmtDist: fmtDist, fmtDur: fmtDur, fmtClock: fmtClock,
    hexToRgb: hexToRgb, luma: luma, relLuma: relLuma, contrast: contrast, bestInk: bestInk, esc: esc, safePaint: safePaint, safeFinish: safeFinish, el: el, loadScript: loadScript, loadOnce: loadOnce, debounce: debounce, deepClone: deepClone,
    sunTimes: sunTimes, isDaylight: isDaylight,
    fetchT: fetchT, FETCH_TIMEOUT: FETCH_TIMEOUT, poll: poll, unpoll: unpoll,
    iconKey: iconKey, riderIcon: riderIcon, convoyFlag: convoyFlag, ICON_COUNT: ICON_PATHS.length
  };
})();

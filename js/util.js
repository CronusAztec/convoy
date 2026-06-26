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

  function fmtDist(m, units) {
    if (units === 'km') {
      if (m < 950) return Math.max(10, Math.round(m / 10) * 10) + ' m';
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
  function luma(hex) {
    var c = hexToRgb(hex);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
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

  A.util = {
    haversine: haversine, bearing: bearing, destPoint: destPoint,
    relBearing: relBearing, crossTrack: crossTrack,
    lerp: lerp, lerpPos: lerpPos, lerpAngle: lerpAngle,
    clamp: clamp, rand: rand, randInt: randInt, pick: pick, chance: chance, uid: uid,
    fmtDist: fmtDist, fmtDur: fmtDur, fmtClock: fmtClock,
    hexToRgb: hexToRgb, luma: luma, esc: esc, el: el, debounce: debounce, deepClone: deepClone,
    iconKey: iconKey, riderIcon: riderIcon, convoyFlag: convoyFlag, ICON_COUNT: ICON_PATHS.length
  };
})();

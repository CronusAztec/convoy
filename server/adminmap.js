/* Convoy — the control panel's live map: the app's map, not a lookalike.

   The panel used to draw its own map server-side as an SVG (Web Mercator tiles,
   then an orthographic globe) to keep the whole page script-free. It worked and
   it looked nothing like Convoy. An operator switching between the app and the
   panel had to re-learn what they were looking at, which is the opposite of
   what an operator console is for.

   So this is the real thing: the same MapLibre build from the same CDN, the
   same CARTO dark-matter style, the same globe projection and sky, and the same
   marker DOM (.m-car > .m-dot) the app builds for a rider blip.

   ── On running script in the panel ────────────────────────────────────────

   The rest of admin.js is deliberately script-free, and this does not undo
   that. It is allowed, not smuggled: the boot CSP already says
   `script-src 'self' https://cdn.jsdelivr.net` — exactly what the app itself
   needs to load MapLibre. What stays forbidden is INLINE script, so nothing
   here is inlined; it is two same-origin endpoints behind the panel's session:

     GET /admin/map.js       this bootstrap
     GET /admin/riders.json  the live snapshot

   Serving the bootstrap from here rather than from js/ keeps it out of the web
   bundle and the APK — it is operator tooling and riders should never download
   it.

   ── Degradation ──────────────────────────────────────────────────────────

   If script is blocked, MapLibre fails to load, or the CDN is down, the map
   element says so and the server-rendered roster underneath still lists every
   rider with status and coordinates. The page degrades to the table, never to
   nothing.

   ── One source of truth for status ───────────────────────────────────────

   riderStatus() runs HERE, on the server, and the browser only ever renders
   what it is told. The map dots and the table are the same data, so they
   cannot disagree about who is stale, parked or ghosted. */
'use strict';

const MAP_STALE_MS = 60 * 1000;      // no position update this long ⇒ "stale"
const GHOST_COLOR = '#a78bfa';

// Pinned to the exact build index.html loads. When the app upgrades MapLibre
// this moves with it — a version skew between the two maps is how "it looks
// different in the panel" bugs start.
const MAPLIBRE_VER = '5.24.0';
const MAPLIBRE_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@' + MAPLIBRE_VER + '/dist/maplibre-gl.min.js';
const MAPLIBRE_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@' + MAPLIBRE_VER + '/dist/maplibre-gl.min.css';

// The app's dark default (js/mapview.js → STYLES.dark), which is what the
// panel's own chrome is built around.
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/* One rider's presence state. Ghost is deliberately NOT one of these: it is a
   modifier, not a state — a ghosted rider is still cruising or parked or
   racing, and an operator needs both facts at once. */
function riderStatus(r) {
  if (!r.pos) return { key: 'nofix', label: 'no GPS fix', color: '#f59e0b' };
  if (r.ageMs != null && r.ageMs > MAP_STALE_MS) return { key: 'stale', label: 'stale', color: '#6b7280' };
  if (r.racing) return { key: 'racing', label: 'racing', color: '#ef4444' };
  if (r.mode === 'parked') return { key: 'parked', label: 'parked', color: '#60a5fa' };
  return { key: 'cruise', label: 'cruising', color: '#4ade80' };
}

function ago(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  return Math.round(m / 60) + 'h';
}

/* The snapshot the map polls — the same rows the table renders, with status
   already resolved. Note what is NOT here: no IP, no profile, no socket id
   beyond the marker key. The map needs to draw riders, not to mirror the
   account store. */
function payload(riders) {
  return (riders || []).map((r) => {
    const st = riderStatus(r);
    return {
      id: r.id, userId: r.userId || null, name: r.username, guest: !!r.guest, bot: !!r.bot,
      pos: r.pos || null, heading: r.heading || 0, ghost: !!r.ghost,
      party: r.party || null, mic: !!r.mic,
      status: st.key, label: st.label, color: st.color, age: ago(r.ageMs)
    };
  });
}

/* The marker CSS. Copied from css/styles.css (.m-car / .m-dot — "neon radar
   blips") rather than linked, because the panel does not load the app's
   stylesheet and should not start: it is 2600 lines of rider UI. Only the
   blip rules are needed, plus a name tag and the ghost ring the panel adds. */
const MAP_CSS =
  '#adminmap{height:560px;border-radius:6px;overflow:hidden;background:#0b0e11}' +
  '.mapfail{display:flex;align-items:center;justify-content:center;height:100%;' +
    'color:#9aa4ad;font-size:13px;text-align:center;padding:0 24px}' +
  /* NOTE, copied from css/styles.css along with the rules: NEVER set `position`
     on the marker ROOT. MapLibre owns it (.maplibregl-marker{position:absolute}
     plus a per-frame transform); overriding it makes every rider render at the
     wrong place — they pile into a corner. The ring and the name tag hang off
     .m-dot, which IS positioned, exactly as the app does it. */
  '.m-car{cursor:pointer}' +
  // The app's flat blip: solid fill, thin dark separator ring, soft drop shadow.
  '.m-dot{position:relative;border-radius:50%;border:none;' +
    'box-shadow:0 0 0 1.5px rgba(0,0,0,.4),0 2px 5px rgba(0,0,0,.5);' +
    'transition:transform 160ms ease}' +
  '.m-car:hover .m-dot{transform:scale(1.3)}' +
  // A simulated rider reads hollow, so nobody mistakes one for a person.
  '.m-bot .m-dot{background:#0b0e11!important;box-shadow:0 0 0 2px currentColor,0 2px 5px rgba(0,0,0,.5)}' +
  '.m-ghostring{position:absolute;inset:-9px;border-radius:50%;pointer-events:none;' +
    'border:2px dashed ' + GHOST_COLOR + ';opacity:.9}' +
  '.m-tag{position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);' +
    'white-space:nowrap;font:11px/1 system-ui,sans-serif;color:#e6e9ec;' +
    'text-shadow:0 0 3px #000,0 0 3px #000,0 0 3px #000;pointer-events:none}' +
  '.mpop{font:12px/1.5 system-ui,sans-serif;color:#0b0e11}' +
  '.mpop .mono{font-family:ui-monospace,monospace;font-size:11px}' +
  '.maplibregl-popup-content{border-radius:6px;padding:9px 12px}';

/* Everything the <head> needs. Kept next to MAP_CSS so the version pin and the
   stylesheet can never drift apart. */
function head() {
  return '<link rel="stylesheet" href="' + MAPLIBRE_CSS + '">' +
    '<style>' + MAP_CSS + '</style>';
}

/* The two <script> tags. MapLibre first (its global must exist before the
   bootstrap runs), both deferred so neither blocks the roster rendering. */
function scripts() {
  return '<script src="' + MAPLIBRE_JS + '" defer></script>' +
    '<script src="/admin/map.js" defer></script>';
}

/* The map container. data-refresh drives the poll interval; 0 means "hold
   still", for when the operator is reading rather than watching. */
function container(refresh) {
  return '<div id="adminmap" data-refresh="' + (parseInt(refresh, 10) || 0) + '">' +
    '<div class="mapfail">Loading the map…</div></div>';
}

/* The bootstrap itself. A template literal so the style URL and ghost colour
   above are the single source of truth; everything else is plain ES5 so it
   runs in whatever the operator has open. */
const MAP_JS = `(function () {
  'use strict';
  var el = document.getElementById('adminmap');
  if (!el) return;
  if (typeof maplibregl === 'undefined') {
    el.innerHTML = '<div class="mapfail">The map library did not load (blocked, or the CDN is ' +
      'unreachable). The roster below still lists everyone.</div>';
    return;
  }
  el.innerHTML = '';

  var REFRESH = parseInt(el.getAttribute('data-refresh') || '0', 10);
  var markers = {};
  var fitted = false;

  var map = new maplibregl.Map({
    container: 'adminmap',
    style: ${JSON.stringify(MAP_STYLE)},
    center: [0, 20],
    zoom: 1.3,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  /* The app's globe boot, verbatim (js/mapview.js applyGlobe): a 3D globe with
     a thin atmosphere that fades out by city zoom. setStyle wipes the
     projection, so re-apply on every style load exactly as the app does. */
  function applyGlobe() {
    try { map.setProjection({ type: 'globe' }); } catch (e) {}
    try { map.setSky({ 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 7, 0] }); } catch (e) {}
  }
  map.on('style.load', applyGlobe);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* The same element the app builds for a rider blip, so the copied .m-car /
     .m-dot rules style it identically. */
  function elFor(r) {
    var root = document.createElement('div');
    root.className = 'm-car' + (r.ghost ? ' m-ghost' : '') + (r.bot ? ' m-bot' : '');
    if (r.bot) root.style.color = r.color;          // hollow ring picks this up
    var dot = document.createElement('div');
    dot.className = 'm-dot';
    var size = r.bot ? 12 : 15;
    dot.style.width = dot.style.height = size + 'px';
    dot.style.backgroundColor = r.color;
    root.appendChild(dot);
    /* Ring and tag hang off the DOT, never the root: the root's position
       belongs to MapLibre, so anything absolutely positioned against it
       resolves against the map container instead — which turns a 30px ghost
       ring into a dashed box across the whole map. */
    if (r.ghost) {
      var ring = document.createElement('div');
      ring.className = 'm-ghostring';
      dot.appendChild(ring);
    }
    var tag = document.createElement('div');
    tag.className = 'm-tag';
    tag.textContent = r.name + (r.ghost ? ' \\uD83D\\uDC7B' : '');
    dot.appendChild(tag);
    return root;
  }

  function popupHtml(r) {
    var acct = r.userId
      ? '<a href="/admin/account/' + esc(r.userId) + '">open account</a>'
      : (r.bot ? 'simulated rider' : 'guest \\u2014 no account');
    return '<div class="mpop"><b>' + esc(r.name) + '</b><br>' +
      '<span style="color:' + esc(r.color) + '">' + esc(r.label) + '</span>' +
      (r.ghost ? ' \\u00b7 <span style="color:${GHOST_COLOR}">ghost mode</span>' : '') +
      (r.mic ? ' \\u00b7 mic live' : '') +
      (r.party ? '<br>convoy ' + esc(String(r.party).slice(0, 8)) : '') +
      '<br>last fix ' + esc(r.age) +
      (r.pos ? '<br><span class="mono">' + r.pos[1].toFixed(4) + ', ' + r.pos[0].toFixed(4) + '</span>' : '') +
      '<br>' + acct + '</div>';
  }

  function sync(list) {
    var seen = {}, bounds = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r.pos) continue;                          // no fix ⇒ table only
      seen[r.id] = 1;
      bounds = bounds ? bounds.extend(r.pos) : new maplibregl.LngLatBounds(r.pos, r.pos);

      var m = markers[r.id];
      if (m) {
        m.setLngLat(r.pos);
        // Restyle in place: a rider who parks or ghosts changes colour without
        // the marker being torn down and re-added (which would drop an open
        // popup and flicker).
        var next = elFor(r);
        m.getElement().replaceWith(next);
        m._element = next;
        m.getPopup().setHTML(popupHtml(r));
      } else {
        markers[r.id] = new maplibregl.Marker({ element: elFor(r), anchor: 'center' })
          .setLngLat(r.pos)
          .setPopup(new maplibregl.Popup({ offset: 16, closeButton: false }).setHTML(popupHtml(r)))
          .addTo(map);
      }
    }
    for (var id in markers) {
      if (!seen[id]) { markers[id].remove(); delete markers[id]; }
    }
    /* Frame everyone ONCE. After that the camera is the operator's: someone who
       panned to a rider is looking at something, and yanking the view back on
       every poll would make the page unusable. */
    if (bounds && !fitted) {
      fitted = true;
      map.fitBounds(bounds, { padding: 90, maxZoom: 14, duration: 0 });
    }
  }

  function poll() {
    fetch('/admin/riders.json', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.riders) sync(d.riders); })
      .catch(function () { /* a dropped poll is not worth a broken page */ });
  }

  map.on('load', poll);
  if (REFRESH > 0) setInterval(poll, REFRESH * 1000);
})();
`;

module.exports = {
  MAP_STALE_MS, GHOST_COLOR, MAP_STYLE, MAPLIBRE_JS, MAPLIBRE_CSS, MAP_JS, MAP_CSS,
  riderStatus, ago, payload, head, scripts, container
};

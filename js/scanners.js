/* Convoy — Police scanners near you (keyless, via OpenMHz).
   Reverse-geocodes the player's position to a US state, lists nearby live scanner
   systems (police / sheriff ranked first), and links out to listen. OpenMHz systems
   carry only city/state (no coords), so "near you" = same state, city-ranked.
   US coverage; degrades to an empty list elsewhere. No API key.
   OpenMHz:   https://api.openmhz.com/systems
   Nominatim: reverse geocode (same service the search box already uses). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util;

  var NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
  var OPENMHZ = 'https://api.openmhz.com/systems';
  var LISTEN = 'https://openmhz.com/system/';
  var TTL = 300000; // cache nearby results for 5 min

  var cache = null, cacheAt = 0, loading = null;

  function reverseGeocode(pos) {
    var url = NOMINATIM + '?format=jsonv2&zoom=8&addressdetails=1&lat=' +
      pos[1].toFixed(4) + '&lon=' + pos[0].toFixed(4);
    return fetch(url).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) {
        var a = (j && j.address) || {};
        var iso = a['ISO3166-2-lvl4'] || ''; // e.g. "US-CA"
        return {
          state: iso.indexOf('US-') === 0 ? iso.slice(3) : '',
          stateName: a.state || '',
          city: a.city || a.town || a.village || a.county || '',
          country: (a.country_code || '').toUpperCase()
        };
      }).catch(function () { return null; });
  }

  var POLICE_RE = /police|sheriff|\bp\.?d\.?\b|patrol|constable|trooper|marshal|law enforcement|highway/i;
  function isPolice(s) { return POLICE_RE.test((s.name || '') + ' ' + (s.description || '')); }

  // Reverse-geocode the user + pull OpenMHz systems, then filter/rank to "near you".
  function find(force) {
    var pos = A.sim ? A.sim.playerPos() : null;
    if (!pos) return Promise.resolve({ error: 'no-location' });
    if (!force && cache && Date.now() - cacheAt < TTL) return Promise.resolve(cache);
    if (loading) return loading;
    loading = Promise.all([
      reverseGeocode(pos),
      fetch(OPENMHZ).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      loading = null;
      var loc = res[0], systems = (res[1] && res[1].systems) || [];
      var here = [];
      if (loc && loc.state) {
        var cityL = (loc.city || '').toLowerCase();
        here = systems.filter(function (s) { return (s.state || '').toUpperCase() === loc.state; });
        here.sort(function (a, b) {
          var pa = isPolice(a) ? 0 : 1, pb = isPolice(b) ? 0 : 1;     // law enforcement first
          if (pa !== pb) return pa - pb;
          var ca = (a.city || '').toLowerCase() === cityL ? 0 : 1;    // then same city
          var cb = (b.city || '').toLowerCase() === cityL ? 0 : 1;
          if (ca !== cb) return ca - cb;
          return (b.clientCount || 0) - (a.clientCount || 0);         // then most-listened
        });
      }
      cache = { loc: loc, systems: here };
      cacheAt = Date.now();
      return cache;
    }).catch(function () { loading = null; return { error: 'fetch' }; });
    return loading;
  }

  /* ---------------- overlay UI ---------------- */
  var overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = U.el('div', 'modal-backdrop');
    overlay.id = 'scanners-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="scanner-modal" role="document">' +
      '  <header class="scanner-head">' +
      '    <div><h2>Police scanners</h2><span class="scanner-sub" id="scanner-sub">near you</span></div>' +
      '    <button class="icon-btn" id="scanner-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      '  </header>' +
      '  <div class="scanner-list" id="scanner-list"></div>' +
      '  <div class="scanner-foot">Live feeds via OpenMHz · opens in your browser</div>' +
      '</div>';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Police scanners');
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#scanner-close').addEventListener('click', close);
    // Esc closes (panels already handle their own Esc, but this overlay is separate).
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    return overlay;
  }
  function close() {
    if (!overlay) return;
    overlay.classList.remove('show');           // fade out (matches .modal-backdrop)
    setTimeout(function () { overlay.hidden = true; }, 200);
    if (scanLastFocus) { try { scanLastFocus.focus(); } catch (e) {} scanLastFocus = null; }
  }

  function rowHtml(s) {
    var pol = isPolice(s);
    var meta = [s.city, s.state].filter(Boolean).join(', ');
    return '<a class="scanner-item" href="' + LISTEN + encodeURIComponent(s.shortName) + '" target="_blank" rel="noopener">' +
      '<span class="scanner-ico' + (pol ? ' pol' : '') + '"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>' +
      '<span class="scanner-info"><b>' + U.esc(s.name || s.shortName) + '</b><small>' + U.esc(meta) + (pol ? ' · law enforcement' : '') + '</small></span>' +
      '<span class="scanner-go">Listen ↗</span></a>';
  }

  var scanLastFocus = null; // element focused before the overlay opened
  function open() {
    ensureOverlay();
    scanLastFocus = document.activeElement;
    overlay.hidden = false;
    requestAnimationFrame(function () { overlay.classList.add('show'); }); // .modal-backdrop fades in via .show
    var closeBtn = overlay.querySelector('#scanner-close');
    if (closeBtn) closeBtn.focus(); // move focus into the dialog
    var list = overlay.querySelector('#scanner-list');
    var sub = overlay.querySelector('#scanner-sub');
    sub.textContent = 'near you';
    list.innerHTML = '<div class="scanner-empty">Finding scanners near you…</div>';
    find().then(function (res) {
      if (!res || res.error === 'no-location') {
        list.innerHTML = '<div class="scanner-empty">Tap the locate button (⌖) to set your position, then try again.</div>';
        return;
      }
      if (res.error) {
        list.innerHTML = '<div class="scanner-empty">Couldn’t reach the scanner directory — check your connection and try again.</div>';
        return;
      }
      var loc = res.loc || {}, sys = res.systems || [];
      sub.textContent = [loc.city, loc.state].filter(Boolean).join(', ') || loc.stateName || 'near you';
      if (!sys.length) {
        list.innerHTML = '<div class="scanner-empty">No live scanner feeds found for your area' +
          (loc.country && loc.country !== 'US' ? ' — OpenMHz covers the US.' : '.') + '</div>';
        return;
      }
      list.innerHTML = sys.slice(0, 40).map(rowHtml).join('');
    });
  }

  // Wire the SCANNERS chip (present in the static markup).
  var chip = document.getElementById('chip-scan');
  if (chip) chip.addEventListener('click', open);

  A.scanners = { open: open, close: close, find: find, isPolice: isPolice };
})();

/* Convoy — Police scanners near you (keyless, via OpenMHz).
   Reverse-geocodes the player's position to a US state, lists nearby live scanner
   systems (police / sheriff ranked first), and plays them IN-APP: tapping a system
   streams its calls (m4a) one after another and polls OpenMHz for new ones, so it
   behaves like a live scanner without leaving the app.
   US coverage; degrades to an empty list elsewhere. No API key.
   OpenMHz:   https://api.openmhz.com/systems  ·  /<shortName>/calls  ·  /<shortName>/talkgroups
   Nominatim: reverse geocode (same service the search box already uses). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util;

  var NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
  var API = 'https://api.openmhz.com/';
  var OPENMHZ = API + 'systems';
  var TTL = 300000;       // cache nearby results for 5 min
  var POLL_MS = 6000;     // how often we check OpenMHz for new calls
  var SEED_CALLS = 4;     // how many recent calls to play immediately on connect

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

  /* ===================== in-app live player ===================== */
  // One <audio> element streams calls back-to-back. We poll /calls for anything
  // newer than the last one we've queued and append it, so it stays "live".
  var P = { audio: null, sys: null, queue: [], lastTime: 0, tg: {}, poll: null, paused: false, current: null, unlocked: false, vol: loadVol(), fails: 0 };

  var VOL_KEY = 'convoy.scanner.vol';
  function loadVol() {
    try { var v = parseFloat(localStorage.getItem(VOL_KEY)); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.9; }
    catch (e) { return 0.9; }
  }
  function setVol(v) {
    P.vol = Math.max(0, Math.min(1, v));
    if (P.audio) P.audio.volume = P.vol;
    try { localStorage.setItem(VOL_KEY, String(P.vol)); } catch (e) {}
  }

  function audioEl() {
    if (!P.audio) {
      P.audio = new Audio();
      P.audio.preload = 'auto';
      P.audio.volume = P.vol;
      P.audio.addEventListener('ended', playNext);
      P.audio.addEventListener('error', function () { P.current = null; playNext(); }); // skip a bad clip
    }
    return P.audio;
  }

  function callTime(c) { var t = +new Date(c.time); return isFinite(t) ? t : 0; }
  function tgName(num) {
    var t = P.tg[num];
    return (t && (t.alpha || t.alphaTag || t.description || t.tag)) || ('TG ' + num);
  }

  function startListen(sys) {
    resetPlayback();              // stop whatever's playing, keep the modal + list
    P.sys = sys; P.paused = false;
    markActiveRow();
    showPlayer(true);
    setText('sp-title', sys.name || sys.shortName);
    setNow('Connecting…', false);

    // best-effort talkgroup names (so we show "FIRE DISPATCH" not "TG 1451")
    P.tg = {};
    fetch(API + encodeURIComponent(sys.shortName) + '/talkgroups')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = j && (j.talkgroups || j);
        (Array.isArray(list) ? list : []).forEach(function (t) { if (t && t.num != null) P.tg[t.num] = t; });
      }).catch(function () {});

    pollCalls(true);
    P.poll = setInterval(function () { pollCalls(false); }, POLL_MS);
  }

  function pollCalls(seed) {
    if (!P.sys) return;
    var sn = P.sys.shortName;
    fetch(API + encodeURIComponent(sn) + '/calls')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!P.sys || P.sys.shortName !== sn || !j) return; // switched systems mid-flight
        P.fails = 0; // recovered
        var calls = (j.calls || []).slice().sort(function (a, b) { return callTime(a) - callTime(b); });
        if (seed) {
          calls.slice(-SEED_CALLS).forEach(function (c) { P.queue.push(c); });
          if (calls.length) P.lastTime = callTime(calls[calls.length - 1]);
          updateStatus();
          if (!P.current && !P.paused) playNext();
          else if (!calls.length) setNow('Listening — quiet right now', true);
        } else {
          var added = 0;
          for (var i = 0; i < calls.length; i++) {
            var t = callTime(calls[i]);
            if (t > P.lastTime) { P.queue.push(calls[i]); P.lastTime = t; added++; }
          }
          updateStatus();
          if (added && !P.current && !P.paused) playNext();
        }
      }).catch(function () {
        // OpenMHz hiccup — the interval keeps polling, so this self-heals. Only
        // surface it (and only when nothing is currently playing) after a couple
        // of consecutive misses so a single blip doesn't flash the status.
        if (P.sys && P.sys.shortName === sn && ++P.fails >= 2 && !P.current) setNow('Reconnecting…', false);
      });
  }

  function playNext() {
    if (!P.sys || P.paused) return;
    var c = P.queue.shift();
    if (!c) { P.current = null; setNow('Listening — quiet right now', true); return; }
    P.current = c;
    var a = audioEl();
    a.src = c.url;
    var p = a.play();
    if (p && p.catch) p.catch(function () { needTap(); }); // autoplay blocked → ask for a tap
    P.unlocked = true;
    renderNow(c);
    updateStatus();
  }

  // Autoplay was blocked (no user gesture survived the fetch) — surface a tap target.
  function needTap() {
    setNow('Tap ▶ to start audio', false);
    setToggle(false);
  }

  function togglePause() {
    if (!P.sys) return;
    var a = audioEl();
    P.paused = !P.paused;
    if (P.paused) { a.pause(); }
    else if (P.current && a.src) { var p = a.play(); if (p && p.catch) p.catch(function () {}); }
    else playNext();
    setToggle(!P.paused);
  }

  function resetPlayback() {
    if (P.poll) { clearInterval(P.poll); P.poll = null; }
    if (P.audio) { try { P.audio.pause(); } catch (e) {} P.audio.removeAttribute('src'); try { P.audio.load(); } catch (e) {} }
    P.sys = null; P.queue = []; P.lastTime = 0; P.current = null; P.paused = false; P.fails = 0;
  }

  function stopListen() {
    resetPlayback();
    showPlayer(false);
    markActiveRow();
  }

  /* ---------------- player UI helpers ---------------- */
  function byId(id) { return overlay ? overlay.querySelector('#' + id) : null; }
  function setText(id, t) { var e = byId(id); if (e) e.textContent = t; }
  function showPlayer(on) { var e = byId('scanner-player'); if (e) e.hidden = !on; }
  function setToggle(playing) {
    var b = byId('sp-toggle'); if (!b) return;
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    b.innerHTML = playing
      ? '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7Z" fill="currentColor" stroke="none"/></svg>';
  }
  function setNow(text, live) {
    setText('sp-now', text);
    var l = byId('sp-live'); if (l) l.classList.toggle('on', !!live);
  }
  function renderNow(c) {
    var when = '';
    try { when = U.fmtClock(new Date(c.time)); } catch (e) {}
    var tg = tgName(c.talkgroupNum);
    var em = c.emergency ? '⚠ ' : '';
    setNow(em + tg + (when ? ' · ' + when : '') + (c.len ? ' · ' + c.len + 's' : ''), true);
    setToggle(!P.paused);
  }
  function updateStatus() {
    var q = byId('sp-queue'); if (q) q.textContent = P.queue.length ? ('+' + P.queue.length + ' queued') : '';
  }
  function markActiveRow() {
    if (!overlay) return;
    Array.prototype.forEach.call(overlay.querySelectorAll('.scanner-item'), function (el) {
      el.classList.toggle('playing', !!(P.sys && el.dataset.sn === P.sys.shortName));
    });
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
      '  <div class="scanner-player" id="scanner-player" hidden>' +
      '    <button class="sp-toggle" id="sp-toggle" aria-label="Pause"></button>' +
      '    <div class="sp-info"><b id="sp-title">—</b><small id="sp-now">—</small></div>' +
      '    <span class="sp-queue" id="sp-queue"></span>' +
      '    <span class="sp-live" id="sp-live"><span class="sp-dot"></span>LIVE</span>' +
      '    <input type="range" class="sp-vol" id="sp-vol" min="0" max="1" step="0.05" aria-label="Scanner volume" title="Volume">' +
      '    <button class="sp-stop" id="sp-stop" aria-label="Stop"><svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/></svg></button>' +
      '  </div>' +
      '  <div class="scanner-foot">Live feeds via OpenMHz · plays in-app</div>' +
      '</div>';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Police scanners');
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#scanner-close').addEventListener('click', close);
    overlay.querySelector('#sp-toggle').addEventListener('click', togglePause);
    overlay.querySelector('#sp-stop').addEventListener('click', stopListen);
    var volEl = overlay.querySelector('#sp-vol');
    if (volEl) { volEl.value = P.vol; volEl.addEventListener('input', function () { setVol(parseFloat(volEl.value)); }); }
    setToggle(true);
    // Esc closes (panels already handle their own Esc, but this overlay is separate).
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    return overlay;
  }
  function close() {
    if (!overlay) return;
    resetPlayback();                             // stop audio when the modal closes
    showPlayer(false);
    overlay.classList.remove('show');            // fade out (matches .modal-backdrop)
    setTimeout(function () { overlay.hidden = true; }, 200);
    if (scanLastFocus) { try { scanLastFocus.focus(); } catch (e) {} scanLastFocus = null; }
  }

  function rowHtml(s) {
    var pol = isPolice(s);
    var meta = [s.city, s.state].filter(Boolean).join(', ');
    var listeners = s.clientCount ? (' · ' + s.clientCount + ' listening') : '';
    return '<button type="button" class="scanner-item" data-sn="' + U.esc(s.shortName) + '">' +
      '<span class="scanner-ico' + (pol ? ' pol' : '') + '"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>' +
      '<span class="scanner-info"><b>' + U.esc(s.name || s.shortName) + '</b><small>' + U.esc(meta) + (pol ? ' · law enforcement' : '') + U.esc(listeners) + '</small></span>' +
      '<span class="scanner-go">Listen ▶</span></button>';
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
      var shown = sys.slice(0, 40);
      list.innerHTML = shown.map(rowHtml).join('');
      // wire each row to start in-app playback (was an external link)
      Array.prototype.forEach.call(list.querySelectorAll('.scanner-item'), function (el) {
        var s = shown.filter(function (x) { return x.shortName === el.dataset.sn; })[0];
        if (s) el.addEventListener('click', function () { startListen(s); });
      });
      markActiveRow();
    });
  }

  // Wire the SCANNERS chip (present in the static markup).
  var chip = document.getElementById('chip-scan');
  if (chip) chip.addEventListener('click', open);

  A.scanners = { open: open, close: close, find: find, isPolice: isPolice, stop: stopListen };
})();

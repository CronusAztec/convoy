/* Convoy — enforcement pack: the "RADAR" HUD (the pre-cut js/radar.js).
   A Highway-Radar-style takeover that switches on with the pack's `radar`
   setting. It reads the live aircraft + ground-enforcement layers that
   ghost.js fetches and paints them as a threat board: a top alert stack, left
   stat cluster, range rings around the player, floating map labels, and a
   bottom radar dock.

   All values are derived from data we actually have:
     - aircraft: callsign, origin country, altitude, speed, heading (OpenSky)
     - ground:   station / camera name + position (OSM), live sightings
     - player:   position / heading / live GPS speed (sim)
   The speed-limit box is a fixed reference value (no live limit feed).

   The hardware-detector contact path the old HUD carried is NOT here: the
   native radio plugins stayed out of the store build and no pack may bring
   them back, so there is nothing to feed it. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, U = A.util, ST = A.store;
  var E = (A.enforcement = A.enforcement || {});

  var TICK_MS = 700;
  var MAX_ALERTS = 3;            // rows shown when collapsed
  var MAX_EXPANDED = 8;          // rows shown when expanded
  var MAX_LABELS = 6;            // floating map labels
  var RANGE_M = 14 * 1609.344;   // ignore targets beyond ~14 mi
  var FAR_M = 6 * 1609.344;      // beyond this a target reads as "muted"

  // Range-ring radii, per unit. r is in the unit's base (mi or km).
  var RINGS = {
    mi: [{ r: 0.5, color: '#ffcf2e', w: 1.7, o: 0.85 },
         { r: 1.0, color: '#34c46a', w: 1.6, o: 0.8 },
         { r: 2.0, color: '#34c46a', w: 1.2, o: 0.4 }],
    km: [{ r: 1, color: '#ffcf2e', w: 1.7, o: 0.85 },
         { r: 2, color: '#34c46a', w: 1.6, o: 0.8 },
         { r: 4, color: '#34c46a', w: 1.2, o: 0.4 }]
  };

  var ARROW = '<svg viewBox="0 0 24 24"><path d="M12 3.5 19.5 13H14v7.5h-4V13H4.5Z" fill="currentColor" stroke="none"/></svg>';

  var active = false, expanded = false, muted = false;
  var timer = null, built = false, fxTimer = null;
  var labels = {}; // key -> { mk, el }

  function layers() { return E.map || null; }

  /* ---------------- proximity sonar ----------------
     No asset files — everything is synthesized through the Web Audio API.
     The sonar stays silent when the sky is clear (silence = safe) and pings at
     a STEADY cadence, pitch, and volume while a threat is in range. Each threat
     kind keeps its own timbre so you can ID it by ear, and a ping pans
     left/right by the threat's bearing so you hear WHICH side it's on. Honors
     the mute button and the global animation setting (anim off ⇒ quiet). */
  var snd = {
    ctx: null,       // lazily-created AudioContext (browsers gate audio behind a user gesture)
    nextPing: 0,     // ms timestamp the next ambient ping is due
    lastTopKey: null,// key of the closest threat last tick (to sting on a NEW contact)
    nextBeat: 0      // ms timestamp the next heartbeat is due
  };

  // Read a sonar-related setting with a default (settings may be absent on old saves).
  function s(key, dflt) { return (S.settings && S.settings[key] != null) ? S.settings[key] : dflt; }
  // Master sonar volume (0..1) scales every synthesized sound's gain.
  function volMul() { return s('sonarVol', 0.8); }

  // Heartbeat sensitivity → (gate, full) risk thresholds.
  var HEART_SENSE = {
    off:        { gate: 999, full: 999 },  // effectively never
    low:        { gate: 9,  full: 22 },
    normal:     { gate: 4,  full: 18 },
    aggressive: { gate: 2,  full: 12 }
  };
  // Ambient ping cadence multipliers (slow / normal / fast) on the base timing.
  var PING_RATE = { slow: 2.0, normal: 1.0, fast: 0.55 };
  var PING_BASE_MS = 1200;  // steady ping interval (× the rate setting)
  var BEAT_MS = 900;        // steady heartbeat interval while risk is above the gate
  var PAN_MAX = 0.92;       // clamp stereo pan so a side-on target isn't 100% hard

  // Per-kind sound design: police — hi-lo "yelp"; camera — a crisp shutter
  // "snap"; alpr — a short double click; heli — a low rotor "chop"; air — a
  // smooth jet tone that glides down in pitch as it passes.
  var SND_PROFILE = {
    police:  { type: 'square',   dur: 0.15, lo: 760,  hi: 1180, vol: 0.95, dips: 2 },
    camera:  { type: 'triangle', dur: 0.05, lo: 1820, hi: 1820, vol: 0.70, dips: 1, snap: true },
    alpr:    { type: 'triangle', dur: 0.05, lo: 1480, hi: 1480, vol: 0.65, dips: 2, snap: true },
    heli:    { type: 'sawtooth', dur: 0.34, lo: 158,  hi: 158,  vol: 1.00, dips: 1, chop: 12 },
    air:     { type: 'sine',     dur: 0.18, lo: 540,  hi: 540,  vol: 0.85, dips: 1, glide: -0.07 }
  };

  function audioCtx() {
    if (snd.ctx) {
      if (snd.ctx.state === 'suspended') { try { snd.ctx.resume(); } catch (e) {} }
      return snd.ctx;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { snd.ctx = new AC(); } catch (e) { return null; }
    return snd.ctx;
  }

  // True when sonar should make sound: radar on, not muted, animations on.
  function sonarArmed() {
    return active && !muted && S.settings && S.settings.anim;
  }

  // One synthesized tone. o = { type, freq, dur, gain, pan?, chop?, glide?, snap? }.
  function tone(o) {
    var c = audioCtx();
    if (!c || typeof c.createOscillator !== 'function') return;
    var t0 = c.currentTime, dur = o.dur;
    var osc = c.createOscillator(), gain = c.createGain();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.glide) osc.frequency.linearRampToValueAtTime(o.freq * (1 + o.glide), t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(o.gain * volMul(), t0 + (o.snap ? 0.002 : 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    var tail = gain;
    if (o.chop) {
      var trem = c.createGain();
      trem.gain.setValueAtTime(1, t0);
      var lfo = c.createOscillator(), depth = c.createGain();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(o.chop, t0);
      depth.gain.setValueAtTime(0.7, t0);
      lfo.connect(depth).connect(trem.gain);
      gain.connect(trem); tail = trem;
      lfo.start(t0); lfo.stop(t0 + dur + 0.02);
    }
    if (o.pan != null && Math.abs(o.pan) > 0.001 && c.createStereoPanner) {
      var panner = c.createStereoPanner();
      panner.pan.setValueAtTime(U.clamp(o.pan, -1, 1), t0);
      tail.connect(panner); tail = panner;
    }
    tail.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // Low "lub-dub" heartbeat.
  function heartbeat(intensity) {
    var c = audioCtx();
    if (!c || typeof c.createOscillator !== 'function') return;
    var base = 62; // Hz — a chest thump, felt more than heard
    var vol = (0.10 + 0.16 * intensity) * volMul();
    function thud(when, freq, v) {
      var osc = c.createOscillator(), gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, when);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.5, when + 0.12);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(v, when + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
      osc.connect(gain).connect(c.destination);
      osc.start(when); osc.stop(when + 0.2);
    }
    var t0 = c.currentTime;
    thud(t0, base, vol);              // "lub"
    thud(t0 + 0.16, base * 1.5, vol * 0.6); // "dub"
  }

  // Ambient tick: panned by bearing, otherwise CONSTANT.
  function ping(profile, pan) {
    var vol = 0.10 * (profile.vol || 1);
    tone({ type: profile.type, freq: profile.lo, dur: profile.dur, gain: vol, pan: pan,
           chop: profile.chop, glide: profile.glide, snap: profile.snap });
    if (profile.dips > 1) {
      setTimeout(function () {
        if (sonarArmed()) tone({ type: profile.type, freq: profile.hi, dur: profile.dur, gain: vol * 0.9, pan: pan });
      }, 150);
    }
  }

  /* ---------------- spoken contact callouts ----------------
     On a NEW closest contact we speak kind + side + distance through the nav
     voice pipeline. Throttled: ≥8s between any two callouts, and the same
     contact isn't re-announced within 2 minutes. Gated by sonarSpoken. */
  var spokeAt = 0;
  var spokenKeys = {}; // contact key -> last announced ts
  function spokenDist(m) {
    return U.fmtDist(m, S.settings.units)
      .replace(/\bmi\b/, 'miles').replace(/\bft\b/, 'feet')
      .replace(/\bkm\b/, 'kilometers').replace(/\bm\b/, 'meters');
  }
  function speakContact(t) {
    if (!s('sonarSpoken', true)) return;
    if (!A.routing || !A.routing.say) return;
    var now = Date.now();
    if (now - spokeAt < 8000) return;
    if (spokenKeys[t.key] && now - spokenKeys[t.key] < 120000) return;
    spokeAt = now;
    spokenKeys[t.key] = now;
    for (var k in spokenKeys) { if (now - spokenKeys[k] > 300000) delete spokenKeys[k]; }
    var side = '';
    if (t.rel != null) {
      var a = Math.abs(t.rel);
      side = a <= 45 ? ' ahead' : a >= 135 ? ' behind' : (t.rel > 0 ? ' to your right' : ' to your left');
    }
    A.routing.say(t.type + side + ', ' + spokenDist(t.dist) + '.');
  }

  // Two-tone "new contact" sting when a fresh threat becomes the closest.
  function contactSting(profile, pan) {
    tone({ type: profile.type, freq: profile.lo, dur: 0.16, gain: 0.13, pan: pan, chop: profile.chop, glide: profile.glide });
    setTimeout(function () {
      if (sonarArmed()) tone({ type: profile.type, freq: (profile.hi || profile.lo) * 1.2, dur: 0.13, gain: 0.11, pan: pan });
    }, 140);
  }

  function resetSonar() {
    snd.nextPing = 0;
    snd.lastTopKey = null;
    snd.nextBeat = 0;
  }

  // Drive the sonar from the sorted target list each tick. The heartbeat gates
  // on the overall RISK factor (the same 0..25 score the HUD meter shows).
  function updateSonar(targets) {
    if (!sonarArmed()) { resetSonar(); return; }
    var now = Date.now();
    var wantHeart = s('sonarHeart', true);
    var wantPings = s('sonarPings', true);
    var wantStings = s('sonarStings', true);

    // Own-property lookups: these keys come from persisted settings, so a stored
    // 'constructor' would resolve to an inherited member and blow up on .gate.
    var sense = (U.own(HEART_SENSE, s('heartSense', 'normal')) ? HEART_SENSE[s('heartSense', 'normal')] : null) || HEART_SENSE.normal;
    var risk = computeRisk(targets);
    var heartActive = wantHeart && risk >= sense.gate;

    if (heartActive) {
      if (now >= snd.nextBeat) {
        heartbeat(0.6);
        snd.nextBeat = now + BEAT_MS;
      }
    } else {
      snd.nextBeat = 0;
    }

    // Ambient pings run only while the heartbeat is silent, so the two never layer.
    if (targets.length && !heartActive && wantPings) {
      var top = targets[0];
      var prof = (U.own(SND_PROFILE, top.kind) ? SND_PROFILE[top.kind] : null) || SND_PROFILE.air;
      if (now >= snd.nextPing) {
        ping(prof, panFor(top));
        var rateMul = (U.own(PING_RATE, s('pingRate', 'normal')) ? PING_RATE[s('pingRate', 'normal')] : 0) || 1;
        snd.nextPing = now + Math.round(PING_BASE_MS * rateMul);
      }
      // New closest contact since last tick ⇒ one-shot sting + voice callout.
      if (top.key !== snd.lastTopKey && top.dist < FAR_M) {
        if (wantStings) contactSting(prof, panFor(top));
        speakContact(top);
      }
      snd.lastTopKey = top.key;
    } else {
      snd.lastTopKey = null;   // clear → next appearance always stings
      snd.nextPing = 0;
    }
  }

  // Stereo pan for a target from its relative bearing (-180..180).
  function panFor(t) {
    var rel = t.rel;
    if (rel == null || rel > 180) rel = ((rel + 540) % 360) - 180;
    var pan = Math.sin(rel * Math.PI / 180);
    return Math.abs(rel) > 165 ? 0 : U.clamp(pan * PAN_MAX * 1.1, -PAN_MAX, PAN_MAX);
  }

  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }
  function unit() { return S.settings && S.settings.units === 'km' ? 'km' : 'mi'; }
  function perUnit() { return unit() === 'km' ? 1000 : 1609.344; }
  function byId(id) { return document.getElementById(id); }
  function setText(id, t) { var e = byId(id); if (e) e.textContent = t; }
  function light(id, on) { var e = byId(id); if (e) e.classList.toggle('on', !!on); }

  /* ---------------- targets ---------------- */
  // Aggregate threat score [0..25]: nearer and on-your-heading targets weigh more.
  var RISK_INNER_M = 1.5 * 1609.344;
  var RISK_NEAR_M = 4 * 1609.344;
  var RISK_HEADING_DEG = 55;
  function computeRisk(targets) {
    var risk = 0;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      risk += t.dist < RISK_INNER_M ? 3 : (t.dist < RISK_NEAR_M ? 2 : 1);
      if (Math.abs(t.rel) < RISK_HEADING_DEG) risk += 1;
    }
    return Math.min(25, risk);
  }

  var OWNERS = {
    military: { label: 'Military', badge: '⚑ ' },
    police:   { label: 'Police',   badge: '🚤 ' },
    ems:      { label: 'EMS',      badge: '✦ ' },
    civilian: { label: 'Civilian', badge: '' },
    unknown:  { label: 'Unidentified', badge: '? ' }
  };
  var OWNER_SETTING = {
    military: 'ghostAirMil',
    police: 'ghostAirPolice',
    ems: 'ghostAirEms',
    civilian: 'ghostAirCiv',
    unknown: 'ghostAirUnknown'
  };

  function classifyHeli(p) {
    if (p.category === 'A7') return true; // rotorcraft category — authoritative when a feed carries it
    if (p.alt == null || p.speed == null || p.ground) return false;
    return p.alt < 1200 && p.speed < 35; // OpenSky fallback: low + slow ⇒ likely rotorcraft
  }

  // A disabled kind is neither shown on the board nor counted toward risk.
  function kindAllowed(kind) {
    if (kind === 'police') return s('ghostPolice', true);
    if (kind === 'station') return s('ghostPolice', true); // stations ride with the police toggle
    if (kind === 'camera') return s('ghostCamera', true);
    if (kind === 'alpr')   return s('ghostAlpr', true);
    if (kind === 'heli')   return s('ghostHeli', true);
    if (kind === 'air')    return s('ghostAir', true);
    return true;
  }

  function gatherTargets() {
    var c = A.sim ? A.sim.playerPos() : null;
    if (!c) return [];
    var hd = A.sim ? A.sim.playerHeading() : 0;
    var L = layers();
    var data = L && L.getGhostData ? L.getGhostData() : { aircraft: { features: [] }, police: { features: [] } };
    var out = [];

    var af = (data.aircraft && data.aircraft.features) || [];
    for (var i = 0; i < af.length; i++) {
      var f = af[i], co = f.geometry && f.geometry.coordinates, p = f.properties || {};
      if (!co) continue;
      var d = U.haversine(c, co);
      if (d > RANGE_M) continue;
      var heli = classifyHeli(p);
      if (!kindAllowed(heli ? 'heli' : 'air')) continue;
      // Ownership filter — the SAME five settings the map layer reads.
      var owner = OWNERS[p.owner] ? p.owner : 'unknown';
      if (!s(OWNER_SETTING[owner], true)) continue;
      var badge = OWNERS[owner].badge;
      var ownLabel = p.ownerName || OWNERS[owner].label;
      var detail = p.country || (p.squawk ? 'Squawk ' + p.squawk : 'Aircraft');
      var sub = badge + ownLabel + ' · ' + detail;
      out.push({
        key: 'air:' + (p.key || p.icao || (co[0].toFixed(3) + ',' + co[1].toFixed(3))),
        kind: heli ? 'heli' : 'air',
        owner: owner,
        type: heli ? 'Helicopter' : 'Airplane',
        desc: (p.callsign && p.callsign !== '—') ? p.callsign
          : (p.icao ? String(p.icao).toUpperCase() : 'Unidentified'),
        sub: sub,
        coord: co, dist: d, rel: U.relBearing(c, hd, co), alt: p.alt
      });
    }

    var pf = (data.police && data.police.features) || [];
    for (var j = 0; j < pf.length; j++) {
      var g = pf[j], pc = g.geometry && g.geometry.coordinates, gp = g.properties || {};
      if (!pc) continue;
      var pd = U.haversine(c, pc);
      if (pd > RANGE_M) continue;
      var ekind = gp.kind === 'camera' ? 'camera'
        : gp.kind === 'alpr' ? 'alpr'
        : gp.kind === 'station' ? 'station'
        : 'police';
      if (!kindAllowed(ekind)) continue;
      var eMeta = ekind === 'camera' ? { pre: 'cam', type: 'Speed camera', sub: 'Enforcement', def: 'Speed camera' }
        : ekind === 'alpr' ? { pre: 'alpr', type: 'ALPR camera', sub: 'Surveillance', def: 'ALPR / surveillance camera' }
        : ekind === 'station' ? { pre: 'sta', type: 'Police station', sub: 'Station', def: 'Police station' }
        : { pre: 'pol', type: 'Police', sub: 'Live sighting', def: 'Police sighting' };
      out.push({
        key: eMeta.pre + ':' + (pc[0].toFixed(3) + ',' + pc[1].toFixed(3)),
        kind: ekind,
        type: eMeta.type,
        desc: gp.name || gp.label || eMeta.def,
        sub: eMeta.sub,
        coord: pc, dist: pd, rel: U.relBearing(c, hd, pc), alt: null
      });
    }

    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
  }

  function altStr(alt) {
    if (alt == null) return '';
    if (unit() === 'mi') return '↑' + (alt * 3.28084 / 1000).toFixed(1) + 'kft';
    return '↑' + (alt >= 1000 ? (alt / 1000).toFixed(1) + 'km' : Math.round(alt) + 'm');
  }

  function sigPips(t) {
    var n = U.clamp(Math.round((1 - t.dist / RANGE_M) * 5), 1, 5);
    var hot = Math.abs(t.rel) < 60 && t.dist < FAR_M; // ahead + near ⇒ threat
    var str = '';
    for (var i = 0; i < 5; i++) str += '<i class="' + (i < n ? ('on ' + (hot ? 'hot' : 'cool')) : '') + '"></i>';
    return str;
  }

  /* ---------------- alert stack ---------------- */
  function alertRow(t, idx) {
    var far = t.dist > FAR_M;
    var aerial = (t.kind === 'air' || t.kind === 'heli');
    var stat = aerial
      ? (altStr(t.alt) || (far ? '(muted)' : 'AIRBORNE'))
      : far ? '(muted)'
        : (t.kind === 'police' ? 'POLICE' : t.kind === 'station' ? 'STATION' : t.kind === 'alpr' ? 'ALPR' : 'CAMERA');
    return '<button type="button" class="ralert ralert-' + U.esc(t.kind) + (far ? ' far' : '') + '" data-i="' + idx + '">' +
      '<span class="ralert-sig">' + sigPips(t) + '</span>' +
      '<span class="ralert-arr" style="transform:rotate(' + Math.round(t.rel) + 'deg)">' + ARROW + '</span>' +
      '<span class="ralert-mid">' +
        '<span class="ralert-type">' + U.esc(t.type) + ' <em>' + U.esc(t.desc) + '</em></span>' +
        '<span class="ralert-sub">' + U.esc(t.sub) + '</span>' +
      '</span>' +
      '<span class="ralert-right">' +
        '<span class="ralert-dist">' + U.fmtDist(t.dist, unit()) + '</span>' +
        '<span class="ralert-stat">' + stat + '</span>' +
      '</span>' +
    '</button>';
  }

  function renderAlerts(targets) {
    var box = byId('radar-alerts');
    if (!box) return;
    if (!targets.length) {
      box.innerHTML = '<div class="ralert ralert-empty">' +
        '<span class="ralert-mid"><span class="ralert-type">Scanning…</span>' +
        '<span class="ralert-sub">No aircraft or police in range</span></span></div>';
      return;
    }
    var cap = expanded ? MAX_EXPANDED : MAX_ALERTS;
    var shown = targets.slice(0, cap);
    var hidden = targets.length - shown.length;
    var html = '';
    for (var i = 0; i < shown.length; i++) html += alertRow(shown[i], i);
    if (hidden > 0 || expanded) {
      html += '<button type="button" class="ralert-foot" data-toggle>' +
        (expanded ? 'Hide alerts' : ('Tap to show ' + hidden + ' hidden alert' + (hidden > 1 ? 's' : ''))) +
        '</button>';
    }
    box.innerHTML = html;

    var foot = box.querySelector('[data-toggle]');
    if (foot) foot.onclick = function () { expanded = !expanded; renderAlerts(gatherTargets()); };
    var rows = box.querySelectorAll('.ralert[data-i]');
    for (var k = 0; k < rows.length; k++) {
      (function (row) {
        row.onclick = function () { focusTarget(shown[+row.dataset.i]); };
      })(rows[k]);
    }
  }

  function focusTarget(t) {
    var m = map();
    if (!m || !t) return;
    if (A.sim) A.sim.breakFollow();
    m.easeTo({ center: t.coord, zoom: Math.max(m.getZoom(), 12.5), duration: ST.dur(700) });
  }

  /* ---------------- left stat cluster ---------------- */
  function renderSide(targets) {
    var d = new Date();
    setText('radar-clock', ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2));

    var risk = computeRisk(targets);
    setText('radar-risk', String(risk));
    var bar = byId('radar-risk-bar');
    if (bar) {
      bar.style.transform = 'scaleX(' + (risk / 25) + ')';
      bar.className = 'rrisk-fill ' + (risk <= 8 ? 'lo' : risk <= 16 ? 'mid' : 'hi');
    }

    var gps = byId('gps-dot');
    var g = gps ? gps.className : '';
    light('rst-gps', /gps-(good|ok)/.test(g));
    light('rst-sat', /gps-good/.test(g));
    light('rst-link', S.netMode === 'live' || !!(A.net && A.net.isLive && A.net.isLive()));
    light('rst-voice', !!S.party);
  }

  /* ---------------- bottom radar dock ----------------
     Live speed from the GPS stream — Doppler when the receiver reports it, else
     derived from the position delta. */
  var liveMs = null, liveAt = 0, liveFix = null;
  function noteSpeed(ms) {
    if (ms == null || isNaN(ms) || ms < 0 || ms > 150) return;
    liveMs = ms;
    liveAt = Date.now();
  }
  ST.on('gpsfix', function (f) {
    if (!f) return;
    if (f.speed != null) noteSpeed(f.speed);
    else if (liveFix && f.pos) {
      var dt = ((f.t || Date.now()) - liveFix.t) / 1000;
      if (dt > 0.2 && dt < 6) noteSpeed(U.haversine(liveFix.pos, f.pos) / dt);
    }
    if (f.pos) liveFix = { pos: f.pos.slice(), t: f.t || Date.now() };
  });
  function speedNow() {
    if (liveMs == null || Date.now() - liveAt > 5000) return null; // stale → "--"
    return Math.round(liveMs * (unit() === 'km' ? 3.6 : 2.23694));
  }
  function renderDock() {
    var v = speedNow();
    setText('radar-speed', v == null ? '--' : String(v));
    setText('radar-speed-unit', unit() === 'km' ? 'KM/H' : 'MPH');
    setText('radar-limit', unit() === 'km' ? '100' : '65');
    var mb = byId('radar-mute');
    if (mb) mb.classList.toggle('muted', muted);
  }

  /* ---------------- range rings ---------------- */
  function ringFC() {
    var c = A.sim ? A.sim.playerPos() : null;
    if (!c) return { type: 'FeatureCollection', features: [] };
    var defs = RINGS[unit()], per = perUnit(), feats = [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i], rm = d.r * per, coords = [];
      for (var a = 0; a <= 64; a++) coords.push(U.destPoint(c, a * 360 / 64, rm));
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { color: d.color, width: d.w, opacity: d.o }
      });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  // The rings are a pure function of the player's position and the distance
  // unit, so re-tessellating them at 1.4 Hz while parked would be 195
  // destPoint() calls plus a full source update for a byte-identical result.
  // 5 decimal places (~1.1 m) is below any movement a rider would notice on a
  // 0.5-mile ring and above GPS jitter that would otherwise defeat the guard.
  var lastRingSig = '';
  function ringSig(c) {
    return c ? unit() + '|' + c[1].toFixed(5) + ',' + c[0].toFixed(5) : '';
  }
  function pushRings() {
    var L = layers();
    if (!L || !L.setRingsData) return;
    var sig = ringSig(A.sim ? A.sim.playerPos() : null);
    if (sig === lastRingSig) return;
    lastRingSig = sig;
    L.setRingsData(ringFC());
  }

  /* ---------------- floating map labels ---------------- */
  function renderLabels(targets) {
    var m = map();
    if (!m || typeof maplibregl === 'undefined') return;
    var want = {}, top = targets.slice(0, MAX_LABELS);
    for (var i = 0; i < top.length; i++) {
      var t = top[i];
      want[t.key] = 1;
      var rec = labels[t.key];
      if (!rec) {
        var el = U.el('div', 'rlabel rlabel-' + t.kind);
        el.innerHTML = '<span class="rl-d"></span><span class="rl-t"></span>';
        var mk = new maplibregl.Marker({ element: el, anchor: 'left', offset: [10, 0] })
          .setLngLat(t.coord).addTo(m);
        rec = labels[t.key] = { mk: mk, el: el };
      }
      rec.mk.setLngLat(t.coord);
      rec.el.querySelector('.rl-d').textContent =
        U.fmtDist(t.dist, unit()) + (t.alt != null ? '  ' + altStr(t.alt) : '');
      rec.el.querySelector('.rl-t').textContent = t.type;
    }
    Object.keys(labels).forEach(function (k) {
      if (!want[k]) { labels[k].mk.remove(); delete labels[k]; }
    });
  }
  function clearLabels() {
    Object.keys(labels).forEach(function (k) { labels[k].mk.remove(); delete labels[k]; });
  }

  // Glue the rotating sweep overlay to the driver's on-screen position.
  function positionSweep() {
    var el = byId('radar-sweep'), m = map();
    var c = A.sim ? A.sim.playerPos() : null;
    if (!el || !m || !c) return;
    var pt;
    try { pt = m.project(c); } catch (e) { return; }
    el.style.left = pt.x + 'px';
    el.style.top = pt.y + 'px';
  }

  /* ---------------- loop + wiring ---------------- */
  // Signature of the last-rendered alert stack: skip the DOM writes when the
  // target set (keys + distances + bearings, quantized) is unchanged.
  // null, not '': an empty board signs as '', and the first tick after an
  // engage must still paint the "Scanning…" state — so the sentinel can never
  // equal a real signature.
  var lastUiSig = null;
  function targetSig(targets) {
    var str = '';
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      str += t.key + ':' + t.dist.toFixed(3) + '@' + Math.round(t.rel) + (t.alt != null ? ('a' + Math.round(t.alt)) : '') + '|';
    }
    return str;
  }

  function tick() {
    if (!active) return;
    var targets = gatherTargets();
    var sig = targetSig(targets);
    if (sig !== lastUiSig) {
      lastUiSig = sig;
      renderAlerts(targets);
      renderSide(targets);
      renderLabels(targets);
    } else {
      renderSide(targets);
    }
    renderDock();
    updateSonar(targets);
    pushRings();
    positionSweep(); // 700ms catch-all (covers marker moving under a static camera)
  }

  function wire(id, fn) { var e = byId(id); if (e) e.addEventListener('click', fn); }
  function build() {
    if (built) return;
    built = true;
    wire('radar-locate', function () {
      // Resume the follow camera first — on phones the radar takeover hides the
      // normal ⌖/recenter controls, so this button is the only "back to me".
      if (A.sim && A.sim.resumeFollow) A.sim.resumeFollow();
      var b = byId('ctl-locate'); if (b) b.click();
    });
    wire('radar-mute', function () {
      muted = !muted; renderDock();
      if (muted) {
        resetSonar();
        if (A.ui) A.ui.toast('Radar audio muted', 'info');
      } else {
        audioCtx(); // this click counts as the user gesture that unlocks audio
        if (A.ui) A.ui.toast('Radar audio on · pings by proximity', 'info');
      }
    });
    // The orange STOP leaves the radar through the same funnel the settings
    // toggle and the map control use (ui.js), so every exit does the same work.
    wire('radar-stop', function () { if (E.ui && E.ui.setRadar) E.ui.setRadar(false); });
    wire('radar-mic', function () {
      if (S.party && A.voice && A.voice.talkToggle) A.voice.talkToggle();
      else if (A.ui) A.ui.toast('Join a convoy to use voice', 'info');
    });
    // Report police at the rider's position: the pack's own socket message
    // (ghost.js reportPolice → 'enforcement:report'), fanned out by the server
    // to nearby riders who hold this pack and fed into the hotspot model.
    wire('radar-report', function () { if (E.ghost && E.ghost.reportPolice) E.ghost.reportPolice(); });
  }

  // One-shot "radar power-on" flourish — pure CSS; we toggle .fire and clear it.
  function playActivationFx() {
    var fx = byId('radar-fx');
    if (!fx) return;
    fx.classList.remove('fire');
    void fx.offsetWidth; // reflow so the animation restarts if retriggered
    fx.classList.add('fire');
    clearTimeout(fxTimer);
    fxTimer = setTimeout(function () { fx.classList.remove('fire'); }, 1450);
  }

  function setActive(on) {
    on = !!on;
    var was = active;
    active = on;
    document.body.classList.toggle('radar-on', active);
    var L = layers();
    if (active) {
      build();
      if (!was) playActivationFx(); // only on a real off→on transition
      if (L && L.setRingsVisible) L.setRingsVisible(true);
      lastUiSig = null; // force a full alert-stack render on (re)engage
      tick();
      // The tick drives the sonar (audio), so it stays a plain interval: a
      // hidden page must keep pinging a rider whose phone is in a pocket.
      // hidden-page poller: the tick drives the sonar audio, which must not pause with the screen off
      if (!timer) timer = setInterval(tick, TICK_MS);
      var ms = map();
      if (ms) { ms.on('move', positionSweep); ms.on('render', positionSweep); }
      positionSweep();
    } else {
      if (timer) { clearInterval(timer); timer = null; }
      expanded = false;
      resetSonar();
      clearLabels();
      if (L) {
        if (L.setRingsVisible) L.setRingsVisible(false);
        // lastRingSig must reset here too, or re-engaging the radar from the
        // same spot leaves the map with no rings until the rider moves.
        if (L.setRingsData) L.setRingsData({ type: 'FeatureCollection', features: [] });
        lastRingSig = '';
      }
      var md = map();
      if (md) { md.off('move', positionSweep); md.off('render', positionSweep); }
      var sw = byId('radar-sweep');
      if (sw) { sw.style.left = ''; sw.style.top = ''; }
    }
  }

  E.radar = {
    setActive: setActive, isActive: function () { return active; },
    // test surface
    _gatherTargets: gatherTargets, _computeRisk: computeRisk, _tick: tick
  };
})();

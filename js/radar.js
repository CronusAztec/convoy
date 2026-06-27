/* Convoy — Ghost Mode "RADAR" HUD.
   A Highway-Radar-style takeover that switches on with Ghost Mode. It reads the
   live aircraft (OpenSky) + police (OSM) layers that ghost.js already fetches and
   paints them as a threat board: a top alert stack, left stat cluster, range rings
   around the player, floating map labels, and a bottom radar dock.

   All values are derived from data we actually have:
     - aircraft: callsign, origin country, altitude, speed, heading (OpenSky)
     - police:   station name + position (OpenStreetMap)
     - player:   position / heading / trip speed (sim + routing)
   The speed-limit box is a fixed reference value (no live limit feed). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, U = A.util, ST = A.store;

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

  // Hardware radar-detector contact (from js/native.js → RadarDetector BLE plugin).
  // Stays null on the web, so the HUD is byte-for-byte unchanged unless a real
  // detector pushes a band/strength via setDetectorAlert(). Auto-expires after DET_TTL.
  var detectorAlert = null;
  var DET_TTL = 8000;

  /* ---------------- proximity sonar ----------------
     No asset files — everything is synthesized through the Web Audio API.
     The sonar stays silent when the sky is clear (silence = safe) and pings
     faster + sharper the closer the nearest threat is. Each threat kind gets
     its own timbre so you can ID it by ear. Honors the existing mute button
     and the global animation setting (anim off ⇒ quiet mode).
     Spatial cues: a ping pans left/right by the threat's bearing relative to
     the player's heading (you hear WHICH side it's on), and the pitch bends up
     when a target is closing and down when it's receding (Doppler feel). A low
     heartbeat thump quickens whenever something is inside the inner ring. */
  var snd = {
    ctx: null,       // lazily-created AudioContext (browsers gate audio behind a user gesture)
    nextPing: 0,     // ms timestamp the next ambient ping is due
    lastTopKey: null,// key of the closest threat last tick (to sting on a NEW contact)
    lastSeq: -1,     // ping counter so successive blips walk up a little in pitch
    dist: {},        // key -> last known distance (m), for closing/receding rate
    beat: 0,         // heartbeat counter
    nextBeat: 0      // ms timestamp the next heartbeat is due
  };

  // Read a sonar-related setting with a default (settings may be absent on old saves).
  function s(key, dflt) { return (S.settings && S.settings[key] != null) ? S.settings[key] : dflt; }
  // Master sonar volume (0..1) scales every synthesized sound's gain.
  function volMul() { return s('sonarVol', 0.8); }

  // Heartbeat sensitivity → (gate, full) risk thresholds. Higher sensitivity =
  // the pulse engages at lower risk and races sooner.
  var HEART_SENSE = {
    off:        { gate: 999, full: 999 },  // effectively never
    low:        { gate: 9,  full: 22 },
    normal:     { gate: 4,  full: 18 },
    aggressive: { gate: 2,  full: 12 }
  };
  // Ambient ping cadence multipliers (slow / normal / fast) on the base timing.
  var PING_RATE = { slow: 2.0, normal: 1.0, fast: 0.55 };


  var HEART_RING_M = 1.5 * 1609.344; // inside this the heartbeat quickens
  var PAN_MAX = 0.92;                // clamp stereo pan so a side-on target isn't 100% hard

  // Per-kind sound design. Each threat gets a recognizable, true-to-life timbre so
  // you can ID it with your eyes on the road:
  //   police — electronic hi-lo "yelp" (two alternating tones, like a siren/detector)
  //   camera — a crisp high shutter "snap"
  //   heli   — a low rotor "chop" (amplitude-modulated drone)
  //   air    — a smooth jet tone that glides down in pitch as it passes
  // lo/hi = the two tones (Hz); dur = seconds; type = oscillator; dips = tone count;
  // chop = rotor tremolo LFO (Hz); glide = pitch slide as a fraction; snap = instant attack.
  var SND_PROFILE = {
    police:  { type: 'square',   dur: 0.15, lo: 760,  hi: 1180, vol: 0.95, dips: 2 },
    camera:  { type: 'triangle', dur: 0.05, lo: 1820, hi: 1820, vol: 0.70, dips: 1, snap: true },
    heli:    { type: 'sawtooth', dur: 0.34, lo: 158,  hi: 158,  vol: 1.00, dips: 1, chop: 12 },
    air:     { type: 'sine',     dur: 0.18, lo: 540,  hi: 540,  vol: 0.85, dips: 1, glide: -0.07 }
  };

  // Get an AudioContext lazily; resume() if the browser suspended it.
  // Returns null if Web Audio isn't available — callers no-op on null.
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
  // Gain ramps up fast then decays to avoid clicks. Optional rotor tremolo (chop = LFO
  // Hz) pulses the amplitude for a helicopter feel; glide slides the pitch over the note
  // (a fraction of freq) for a Doppler pass-by; snap gives an instant attack (shutter).
  // pan ∈ [-1..1] (left..right); omit/0 for mono. A fresh graph is built per tone.
  function tone(o) {
    var c = audioCtx();
    if (!c) return;
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
      // Rotor "wokka": an LFO drives a tremolo gain stage so the drone pulses.
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

  // Low "lub-dub" heartbeat. Two thumps; gain/spacing set the heart-race feel.
  function heartbeat(intensity) {
    var c = audioCtx();
    if (!c) return;
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

  // Ambient "proximity tick": panned by bearing, pitch-bent by closing rate.
  // Police plays its hi-lo yelp (two tones); other kinds get one character tone.
  function ping(profile, nearness, pan, closing) {
    var seq = (snd.lastSeq + 1) % 12;
    snd.lastSeq = seq;
    // closing>0 (approaching) raises pitch, <0 (leaving) lowers it. ±8% max.
    var doppler = 1 + U.clamp(closing || 0, -1, 1) * 0.08;
    var mul = (1 + seq * 0.012 + nearness * 0.3) * doppler;
    var vol = (0.05 + 0.07 * nearness) * (profile.vol || 1);
    tone({ type: profile.type, freq: profile.lo * mul, dur: profile.dur, gain: vol, pan: pan,
           chop: profile.chop, glide: profile.glide, snap: profile.snap });
    if (profile.dips > 1) {
      // the contrasting second tone — police: the "hi" half of the hi-lo yelp
      setTimeout(function () {
        if (sonarArmed()) tone({ type: profile.type, freq: profile.hi * mul, dur: profile.dur, gain: vol * 0.9, pan: pan });
      }, 150);
    }
  }

  // Two-tone "new contact" sting when a fresh threat becomes the closest.
  // Keeps the kind's character (heli chops, jet glides) so a new contact is identifiable.
  function contactSting(profile, pan) {
    tone({ type: profile.type, freq: profile.lo, dur: 0.16, gain: 0.13, pan: pan, chop: profile.chop, glide: profile.glide });
    setTimeout(function () {
      if (sonarArmed()) tone({ type: profile.type, freq: (profile.hi || profile.lo) * 1.2, dur: 0.13, gain: 0.11, pan: pan });
    }, 140);
  }

  // Reset all per-session sonar memory (on mute / deactivate).
  function resetSonar() {
    snd.nextPing = 0;
    snd.lastTopKey = null;
    snd.dist = {};
    snd.nextBeat = 0;
    snd.beat = 0;
    snd.lastSeq = -1;
  }

  // Heartbeat gates on the overall RISK factor (the same 0..25 score the HUD
  // meter shows), not just the single nearest target's distance. Below the gate
  // the radar is quiet-of-heart; above it the pulse rises with risk. Threshold
  // Drive the sonar from the sorted target list each tick.
  // Returns the proximity [0..1] of the nearest threat (for the ambient cadence).
  // Honors the radar-audio settings: master volume, per-sound toggles, heartbeat
  // sensitivity, and ping cadence.
  function updateSonar(targets) {
    if (!sonarArmed()) { resetSonar(); return 0; }
    var now = Date.now();
    var wantHeart = s('sonarHeart', true);
    var wantPings = s('sonarPings', true);
    var wantStings = s('sonarStings', true);

    // Heartbeat thresholds come from the sensitivity setting.
    var sense = HEART_SENSE[s('heartSense', 'normal')] || HEART_SENSE.normal;
    var risk = computeRisk(targets);
    // Heartbeat intensity from risk: 0 below the gate, ramping to 1 at "full".
    var beatIntensity = (wantHeart && risk >= sense.gate)
      ? U.clamp((risk - sense.gate) / (sense.full - sense.gate), 0, 1) * 0.6 + 0.4
      : 0;
    var heartActive = beatIntensity > 0;

    if (heartActive) {
      if (now >= snd.nextBeat) {
        heartbeat(beatIntensity);
        // Calm (1.05s) → racing (0.40s) as risk climbs to maximum.
        snd.nextBeat = now + Math.round(1050 - 650 * beatIntensity);
      }
    } else {
      snd.nextBeat = 0;
    }

    // Ambient pings run only while the heartbeat is silent (and the ping toggle
    // is on), so the two never layer. The ping-rate setting scales the cadence.
    if (targets.length && !heartActive && wantPings) {
      var top = targets[0];
      var prof = SND_PROFILE[top.kind] || SND_PROFILE.air;
      var nearness = U.clamp(1 - top.dist / RANGE_M, 0, 1);
      // Closing rate ∈ [-1..1]: how fast distance changed since last tick, normalized.
      var prev = snd.dist[top.key];
      var closing = prev != null ? U.clamp((prev - top.dist) / (0.4 * 1609.344), -1, 1) : 0;
      snd.dist[top.key] = top.dist;
      if (now >= snd.nextPing) {
        ping(prof, nearness, panFor(top), closing);
        // Far ⇒ slow; on top of you ⇒ fast. pingRate multiplies the spread.
        var rateMul = PING_RATE[s('pingRate', 'normal')] || 1;
        snd.nextPing = now + Math.round((260 + (1 - nearness) * (1 - nearness) * 2340) * rateMul);
      }
      // New closest contact since last tick ⇒ one-shot sting (if enabled).
      if (wantStings && top.key !== snd.lastTopKey && top.dist < FAR_M) contactSting(prof, panFor(top));
      snd.lastTopKey = top.key;
      return nearness;
    } else {
      snd.lastTopKey = null;   // clear → next appearance always stings
      snd.dist = {};
      snd.nextPing = 0;
      return 0;
    }
  }

  // Stereo pan for a target from its relative bearing (-180..180) to the player's heading.
  // Directly ahead/behind ⇒ centered; 90° to starboard ⇒ full right; -90° port ⇒ full left.
  function panFor(t) {
    var rel = t.rel;
    if (rel == null || rel > 180) rel = ((rel + 540) % 360) - 180; // normalize to [-180,180]
    var pan = Math.sin(rel * Math.PI / 180); // -1 (180°) .. 1 (90°) .. 0 (0/±180)
    return Math.abs(rel) > 165 ? 0 : U.clamp(pan * PAN_MAX * 1.1, -PAN_MAX, PAN_MAX);
  }

  // First target inside a given radius, or null.
  function nearestWithin(targets, radiusM) {
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].dist <= radiusM) return targets[i];
    }
    return null;
  }

  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }
  function unit() { return S.settings && S.settings.units === 'km' ? 'km' : 'mi'; }
  function perUnit() { return unit() === 'km' ? 1000 : 1609.344; }
  function byId(id) { return document.getElementById(id); }
  function setText(id, t) { var e = byId(id); if (e) e.textContent = t; }
  function light(id, on) { var e = byId(id); if (e) e.classList.toggle('on', !!on); }

  /* ---------------- targets ---------------- */
  // Aggregate threat score [0..25]: nearer and on-your-heading targets weigh more.
  // Shared by the HUD meter (renderSide) and the heartbeat (updateSonar) so the
  // pulse you hear tracks the same risk number you see.
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

  function classifyHeli(p) {
    if (p.category === 'A7') return true; // ADS-B Exchange rotorcraft category — authoritative
    if (p.alt == null || p.speed == null || p.ground) return false;
    return p.alt < 1200 && p.speed < 35; // OpenSky fallback: low + slow ⇒ likely rotorcraft
  }

  // Ghost target filters: a disabled kind is neither shown on the board nor
  // counted toward risk/heartbeat. Reads from settings with safe defaults.
  function kindAllowed(kind) {
    if (kind === 'police') return s('ghostPolice', true);
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
    var data = A.mapview && A.mapview.getGhostData
      ? A.mapview.getGhostData() : { aircraft: { features: [] }, police: { features: [] } };
    var out = [];

    var af = (data.aircraft && data.aircraft.features) || [];
    for (var i = 0; i < af.length; i++) {
      var f = af[i], co = f.geometry && f.geometry.coordinates, p = f.properties || {};
      if (!co) continue;
      var d = U.haversine(c, co);
      if (d > RANGE_M) continue;
      var heli = classifyHeli(p);
      if (!kindAllowed(heli ? 'heli' : 'air')) continue; // ghost filter
      // sub line: prefer ADS-B type/registration; fall back to OpenSky origin country.
      var sub = p.acType ? (p.acType + (p.reg ? ' · ' + p.reg : '')) : (p.country || 'Aircraft');
      if (p.mil) sub = '⚑ ' + sub; // military flag from ADS-B Exchange dbFlags
      out.push({
        key: 'air:' + (p.icao || (co[0].toFixed(3) + ',' + co[1].toFixed(3))),
        kind: heli ? 'heli' : 'air',
        type: heli ? 'Helicopter' : 'Airplane',
        desc: (p.callsign && p.callsign !== '—') ? p.callsign : (p.reg || 'Unknown'),
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
      // Three enforcement kinds now (camera=amber, alpr=red, police=blue).
      var ekind = gp.kind === 'camera' ? 'camera' : (gp.kind === 'alpr' ? 'alpr' : 'police');
      if (!kindAllowed(ekind)) continue; // ghost filter
      var eMeta = ekind === 'camera' ? { pre: 'cam', type: 'Speed camera', sub: 'Enforcement', def: 'Speed camera' }
        : ekind === 'alpr' ? { pre: 'alpr', type: 'ALPR camera', sub: 'Surveillance', def: 'ALPR / surveillance camera' }
        : { pre: 'pol', type: 'Police', sub: 'Station', def: 'Police station' };
      out.push({
        key: eMeta.pre + ':' + (pc[0].toFixed(3) + ',' + pc[1].toFixed(3)),
        kind: ekind,
        type: eMeta.type,
        desc: gp.name || eMeta.def,
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
    var s = '';
    for (var i = 0; i < 5; i++) s += '<i class="' + (i < n ? ('on ' + (hot ? 'hot' : 'cool')) : '') + '"></i>';
    return s;
  }

  /* ---------------- alert stack ---------------- */
  function alertRow(t, idx) {
    var far = t.dist > FAR_M;
    // Only aircraft are aerial (altitude / AIRBORNE). Ground enforcement —
    // police, speed cameras, ALPR — each gets its own ground status label.
    var aerial = (t.kind === 'air' || t.kind === 'heli');
    var stat = aerial
      ? (altStr(t.alt) || (far ? '(muted)' : 'AIRBORNE'))
      : far ? '(muted)'
        : (t.kind === 'police' ? 'STATION' : t.kind === 'alpr' ? 'ALPR' : 'CAMERA');
    return '<button class="ralert ralert-' + t.kind + (far ? ' far' : '') + '" data-i="' + idx + '">' +
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

  // Top banner for a live radar-detector contact (no map position — it's a band/
  // strength reading, not a located target, so it sits above the geo alert rows).
  function detectorBanner() {
    if (!detectorAlert) return '';
    if (Date.now() - detectorAlert.at > DET_TTL) { detectorAlert = null; return ''; }
    var d = detectorAlert;
    var n = U.clamp(Math.round(d.strength / 9 * 5), 1, 5), pips = '';
    for (var i = 0; i < 5; i++) pips += '<i class="' + (i < n ? 'on hot' : '') + '"></i>';
    var pct = Math.round(U.clamp(d.strength / 9, 0, 1) * 100);
    return '<div class="ralert ralert-detector">' +
      '<span class="ralert-sig">' + pips + '</span>' +
      '<span class="ralert-mid"><span class="ralert-type">' + U.esc(d.band) + '-band <em>RADAR</em></span>' +
      '<span class="ralert-sub">Detector contact</span></span>' +
      '<span class="ralert-right"><span class="ralert-dist">' + pct + '%</span><span class="ralert-stat">SIGNAL</span></span>' +
      '</div>';
  }

  function renderAlerts(targets) {
    var box = byId('radar-alerts');
    if (!box) return;
    var det = detectorBanner();   // hardware detector row (native only); '' on the web
    if (!targets.length) {
      box.innerHTML = det + '<div class="ralert ralert-empty">' +
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
      html += '<button class="ralert-foot" data-toggle>' +
        (expanded ? 'Hide alerts' : ('Tap to show ' + hidden + ' hidden alert' + (hidden > 1 ? 's' : ''))) +
        '</button>';
    }
    box.innerHTML = det + html;

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
      bar.style.width = (risk / 25 * 100) + '%';
      bar.className = 'rrisk-fill ' + (risk <= 8 ? 'lo' : risk <= 16 ? 'mid' : 'hi');
    }

    var gps = byId('gps-dot');
    var g = gps ? gps.className : '';
    light('rst-gps', /gps-(good|ok)/.test(g));
    light('rst-sat', /gps-good/.test(g));
    light('rst-link', S.netMode === 'live');
    light('rst-voice', !!S.party);
  }

  /* ---------------- bottom radar dock ---------------- */
  function speedNow() {
    var t = S.trip;
    if (!t || !t.active) return null;
    return Math.round((t.baseSpeed || 0) * (unit() === 'km' ? 3.6 : 2.23694));
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

  // Glue the rotating sweep overlay to the driver's on-screen position. The range
  // rings are a map source centered on the player, so the sweep (a fixed DOM overlay)
  // must be re-pinned to the player's projected pixel to stay attached to the car —
  // otherwise it floats at the viewport centre and drifts off as the map pans.
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
  function tick() {
    if (!active) return;
    var targets = gatherTargets();
    renderAlerts(targets);
    renderSide(targets);
    renderDock();
    renderLabels(targets);
    updateSonar(targets);
    if (A.mapview && A.mapview.setRingsData) A.mapview.setRingsData(ringFC());
    positionSweep(); // 700ms catch-all (covers marker moving under a static camera)
  }

  function wire(id, fn) { var e = byId(id); if (e) e.addEventListener('click', fn); }
  function build() {
    if (built) return;
    built = true;
    wire('radar-locate', function () { var b = byId('ctl-locate'); if (b) b.click(); });
    wire('radar-mute', function () {
      muted = !muted; renderDock();
      if (muted) {
        // Stopping the ambient loop leaves no hanging blips or heartbeat.
        resetSonar();
        if (A.ui) A.ui.toast('Radar audio muted', 'info');
      } else {
        // Touch the AudioContext now so the next ping isn't gated by the
        // first-user-gesture rule (this click already counts, but be explicit).
        audioCtx();
        if (A.ui) A.ui.toast('Radar audio on — pings by proximity', 'info');
      }
    });
    wire('radar-stop', function () { if (A.ui && A.ui.applyGhost) A.ui.applyGhost(false); });
    wire('radar-mic', function () {
      if (S.party && A.voice && A.voice.toggle) A.voice.toggle();
      else if (A.ui) A.ui.toast('Join a convoy to use voice', 'info');
    });
    // Report a road hazard at the player's position. Opens the same icon-button
    // picker the map control uses — prompt() is suppressed in many Android WebViews
    // (the Capacitor target), which left this dead on real devices.
    wire('radar-hazard', function () {
      if (A.overlays && A.overlays.openReport) A.overlays.openReport();
      else if (A.ui) A.ui.toast('Hazards overlay unavailable', 'warn');
    });
  }

  // One-shot "radar power-on" flourish — purple sweep + ring pulses + title.
  // Pure CSS (honors [data-anim=off]); we just toggle .fire and clear it after.
  function playActivationFx() {
    var fx = document.getElementById('radar-fx');
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
    if (active) {
      build();
      if (!was) playActivationFx(); // only on a real off→on transition (dedupes double-calls)
      if (A.mapview && A.mapview.setRingsVisible) A.mapview.setRingsVisible(true);
      tick();
      if (!timer) timer = setInterval(tick, TICK_MS);
      // Keep the sweep glued to the driver every frame the camera/marker moves.
      var ms = map();
      if (ms) { ms.on('move', positionSweep); ms.on('render', positionSweep); }
      positionSweep();
    } else {
      if (timer) { clearInterval(timer); timer = null; }
      expanded = false;
      detectorAlert = null;    // drop any stale hardware-detector contact
      resetSonar();            // stop ambient pings, heartbeat, and per-target tracking
      clearLabels();
      if (A.mapview) {
        if (A.mapview.setRingsVisible) A.mapview.setRingsVisible(false);
        if (A.mapview.setRingsData) A.mapview.setRingsData({ type: 'FeatureCollection', features: [] });
      }
      var md = map();
      if (md) { md.off('move', positionSweep); md.off('render', positionSweep); }
      var sw = byId('radar-sweep');
      if (sw) { sw.style.left = ''; sw.style.top = ''; } // revert to the CSS-centered default
    }
  }

  // Push a hardware radar-detector reading into the HUD (called by js/native.js when
  // a real BLE detector emits a band/strength frame). Band e.g. 'X'|'K'|'Ka'|'Laser'.
  function setDetectorAlert(band, strength) {
    if (!band) return;
    detectorAlert = { band: String(band), strength: U.clamp(strength | 0, 0, 9), at: Date.now() };
    if (active) renderAlerts(gatherTargets());
  }
  function clearDetectorAlert() {
    detectorAlert = null;
    if (active) renderAlerts(gatherTargets());
  }

  A.radar = {
    setActive: setActive, isActive: function () { return active; },
    setDetectorAlert: setDetectorAlert, clearDetectorAlert: clearDetectorAlert
  };
})();

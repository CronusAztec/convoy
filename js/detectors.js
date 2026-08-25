/* Convoy — radar-detector catalog + threat classification.
   Shared reference used by BOTH the web build (to list supported models and
   classify simulated/relayed detections) and the native build (the BLE plugin
   in RadarDetectorPlugin.java carries its own copy of the match signatures;
   this mirror drives the UI compatibility list + the cop-vs-speed-reader logic).

   Nothing here touches Bluetooth — it is pure data + functions, safe on the web. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  /* =============================== families ===============================
     Each family groups models that share a BLE transport + frame protocol.
       proto:   how alerts are decoded natively —
                 'nus'  Nordic-UART serial framing (Escort/Beltronics/Cobra, per esclib)
                 'v1'   Valentine One infDisplayData BLE service
                 'ble'  vendor GATT with a notify characteristic (Genevo/Radenso)
                 'name' recognized by advertised name only — listed + connectable,
                        but alert streaming is best-effort until validated on hardware
       match:   RegExp against the BLE advertised device name
       stream:  true  = we parse live band/strength alerts
                false = recognized/connectable, alerts not yet decoded (shown as such) */
  var FAMILIES = {
    escort: {
      brand: 'Escort', proto: 'nus', stream: true,
      match: /^(escort|max\s?3|max\s?360|maxcam|redline|passport|ix\b)/i,
      note: 'Escort Live BLE (SmartCord Live)'
    },
    beltronics: {
      brand: 'Beltronics', proto: 'nus', stream: true,
      match: /^(bel\b|beltronics|gt-?7|gt-?360|gt-?2)/i,
      note: 'Beltronics BLE (shared Escort protocol)'
    },
    valentine: {
      brand: 'Valentine One', proto: 'v1', stream: true,
      match: /^(v1|valentine|v1c|v1connection)/i,
      note: 'V1connection LE (V1 Gen2 built-in)'
    },
    cobra: {
      brand: 'Cobra', proto: 'nus', stream: true,
      match: /^(cobra|rad\s?\d|iradar|drive\s?smart)/i,
      note: 'Cobra iRadar BLE'
    },
    radenso: {
      brand: 'Radenso', proto: 'ble', stream: true,
      match: /^(radenso|theia|ds1|pro\s?m)/i,
      note: 'Radenso app BLE'
    },
    genevo: {
      brand: 'Genevo', proto: 'ble', stream: true,
      match: /^(genevo)/i,
      note: 'Genevo app BLE'
    },
    uniden: {
      brand: 'Uniden', proto: 'name', stream: false,
      match: /^(uniden|r[3478]\b|dfr\d)/i,
      note: 'Bluetooth firmware link — alert stream best-effort'
    },
    whistler: {
      brand: 'Whistler', proto: 'name', stream: false,
      match: /^(whistler|z-?\d)/i,
      note: 'Recognized — alert stream best-effort'
    },
    escortgen: {
      brand: 'Escort (generic UART)', proto: 'nus', stream: true,
      match: /(nordic|nus|uart)/i,
      note: 'Generic Nordic-UART detector'
    }
  };

  /* =============================== models ===============================
     The compatibility list shown in Settings → Radar detector. `bt` marks
     models with a Bluetooth alert link (the ones this app can actually use);
     a handful of popular non-BT models are listed as "no BLE" so users aren't
     left wondering why their detector never appears in the scan. */
  var MODELS = [
    // Escort
    { brand: 'Escort', name: 'MAX 360', family: 'escort', bt: true },
    { brand: 'Escort', name: 'MAX 360c', family: 'escort', bt: true },
    { brand: 'Escort', name: 'MAX 360 MKII', family: 'escort', bt: true },
    { brand: 'Escort', name: 'MAX 3', family: 'escort', bt: true },
    { brand: 'Escort', name: 'MAX 3i', family: 'escort', bt: true },
    { brand: 'Escort', name: 'MAXcam 360c', family: 'escort', bt: true },
    { brand: 'Escort', name: 'Redline 360c', family: 'escort', bt: true },
    { brand: 'Escort', name: 'Redline EX', family: 'escort', bt: true },
    { brand: 'Escort', name: 'iX', family: 'escort', bt: true },
    { brand: 'Escort', name: 'iXc', family: 'escort', bt: true },
    { brand: 'Escort', name: 'Passport MAX 360', family: 'escort', bt: true },
    { brand: 'Escort', name: 'Passport MAX 2', family: 'escort', bt: true },
    { brand: 'Escort', name: 'Passport 9500ix (SmartCord Live)', family: 'escort', bt: true },
    { brand: 'Escort', name: 'Passport S55', family: 'escort', bt: false },
    // Beltronics
    { brand: 'Beltronics', name: 'GT-7', family: 'beltronics', bt: true },
    { brand: 'Beltronics', name: 'GT-360', family: 'beltronics', bt: true },
    { brand: 'Beltronics', name: 'GT-2', family: 'beltronics', bt: true },
    // Valentine One
    { brand: 'Valentine One', name: 'V1 Gen2', family: 'valentine', bt: true },
    { brand: 'Valentine One', name: 'V1 (V1connection LE)', family: 'valentine', bt: true },
    // Cobra
    { brand: 'Cobra', name: 'RAD 480i', family: 'cobra', bt: true },
    { brand: 'Cobra', name: 'RAD 700i', family: 'cobra', bt: true },
    { brand: 'Cobra', name: 'RAD 380', family: 'cobra', bt: true },
    { brand: 'Cobra', name: 'DualPro (iRadar)', family: 'cobra', bt: true },
    // Radenso
    { brand: 'Radenso', name: 'Theia', family: 'radenso', bt: true },
    { brand: 'Radenso', name: 'DS1', family: 'radenso', bt: true },
    { brand: 'Radenso', name: 'Pro M', family: 'radenso', bt: true },
    // Genevo
    { brand: 'Genevo', name: 'Genevo Pro', family: 'genevo', bt: true },
    { brand: 'Genevo', name: 'Genevo One M', family: 'genevo', bt: true },
    { brand: 'Genevo', name: 'Genevo MAX', family: 'genevo', bt: true },
    { brand: 'Genevo', name: 'Assist HDM+', family: 'genevo', bt: true },
    // Uniden (BT for firmware / limited alert stream)
    { brand: 'Uniden', name: 'R7', family: 'uniden', bt: true },
    { brand: 'Uniden', name: 'R8', family: 'uniden', bt: true },
    { brand: 'Uniden', name: 'R9', family: 'uniden', bt: true },
    { brand: 'Uniden', name: 'DFR9', family: 'uniden', bt: true },
    { brand: 'Uniden', name: 'R3', family: 'uniden', bt: false },
    { brand: 'Uniden', name: 'R4', family: 'uniden', bt: false },
    // Whistler
    { brand: 'Whistler', name: 'Z-35R', family: 'whistler', bt: false },
    { brand: 'Whistler', name: 'CR97', family: 'whistler', bt: false }
  ];

  // Recognize an advertised BLE device name → family key (or null).
  function familyForName(name) {
    if (!name) return null;
    for (var k in FAMILIES) {
      if (FAMILIES.hasOwnProperty(k) && FAMILIES[k].match.test(name)) return k;
    }
    return null;
  }

  /* ======================= threat classification =======================
     The crux of "upload to the map only if it's likely a cop, not a speed
     reader". Radar bands carry very different police-likelihood:

       Ka  (33.8 / 34.7 / 35.5 GHz) — modern US police radar is almost all Ka.
                                       A Ka hit is a cop until proven otherwise.
       Laser (904 nm lidar)         — police lidar; a detector only sees it once
                                       you're already targeted → treat as police.
       Ku  (13.45 GHz)              — European police band.
       K   (24.15 GHz)              — police use it, but SO do blind-spot monitors,
                                       adaptive cruise and automatic door openers.
                                       Only a STRONG, steady K is likely a real cop.
       X   (10.5 GHz)               — largely obsolete for police; door openers,
                                       motion sensors, sign radar. Rarely a cop.
       MRCD / MRCT / Gatso / Multaradar — photo speed-enforcement (a "speed
                                       reader" / camera), NOT a live officer →
                                       classified as a camera, not police.

     Returns { police, camera, confidence 0..1, kind, band }. `strength` is the
     detector's 0..9 signal bars. */
  function classify(band, strength) {
    band = String(band || '').toUpperCase();
    var s = Math.max(0, Math.min(9, strength | 0));
    var norm = s / 9;

    // Photo-enforcement signatures → speed camera, never a live cop.
    if (/MRCD|MRCT|GATSO|MULTA/.test(band)) {
      return { police: false, camera: true, confidence: 0.7, kind: 'camera', band: band };
    }
    if (band === 'LASER' || band === 'LIDAR') {
      return { police: true, camera: false, confidence: 0.9, kind: 'police', band: 'Laser' };
    }
    if (band === 'KA') {
      // Ka is essentially always police; weak Ka can be a distant patrol, so keep
      // confidence high but let signal nudge it.
      return { police: true, camera: false, confidence: 0.8 + 0.19 * norm, kind: 'police', band: 'Ka' };
    }
    if (band === 'KU') {
      return { police: true, camera: false, confidence: 0.7 + 0.2 * norm, kind: 'police', band: 'Ku' };
    }
    if (band === 'K') {
      // Falsable band: only a strong, close signal is worth trusting as a cop.
      var kConf = 0.15 + 0.55 * norm;      // ~0.15 (bar 0) → ~0.7 (bar 9)
      return { police: kConf >= 0.5, camera: false, confidence: kConf, kind: 'police', band: 'K' };
    }
    if (band === 'X') {
      // Almost never a cop in modern traffic — treat as a likely false.
      return { police: false, camera: false, confidence: 0.1 + 0.15 * norm, kind: 'falsable', band: 'X' };
    }
    return { police: false, camera: false, confidence: 0.1, kind: 'unknown', band: band || '?' };
  }

  // Should this detection be UPLOADED to the shared crowd map, and as what kind?
  // Gate on classification confidence so falses (X band, weak K, BSM) don't spam
  // everyone's map. Returns { upload, kind, label, confidence } — kind is a
  // hazard kind the server + map already understand ('police' | 'camera').
  function uploadDecision(band, strength) {
    var c = classify(band, strength);
    if (c.camera && c.confidence >= 0.6) {
      return { upload: true, kind: 'camera', label: c.band + '-band speed camera', confidence: c.confidence };
    }
    if (c.police && c.confidence >= 0.75) {
      return { upload: true, kind: 'police', label: c.band + '-band radar (police)', confidence: c.confidence };
    }
    return { upload: false, kind: c.kind, label: c.band + '-band', confidence: c.confidence };
  }

  A.detectors = {
    FAMILIES: FAMILIES,
    MODELS: MODELS,
    familyForName: familyForName,
    // Supported BLE models grouped by brand, for the settings compatibility list.
    supportedByBrand: function () {
      var out = {};
      MODELS.forEach(function (m) {
        (out[m.brand] = out[m.brand] || []).push(m);
      });
      return out;
    },
    classify: classify,
    uploadDecision: uploadDecision
  };
})();

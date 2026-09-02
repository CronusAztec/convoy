/* Convoy — space environment around the globe.

   Renders the sky behind the MapLibre globe on a 2D canvas (inserted under the
   map canvas, which occludes it where the planet is drawn) and a day/night
   terminator overlay on the globe itself. Everything is computed for the
   CURRENT time from standard low-precision ephemerides (Paul Schlyter's
   algorithms, good to well under 1° — far below a pixel here):

   - Stars: the ~80 brightest real stars (RA/Dec/mag/color) so constellations
     (Orion, the Dipper, Crux, Scorpius…) are correct for the current time and
     view, plus a seeded procedural faint-star field and a Milky Way band along
     the real galactic equator.
   - Planets: Mercury→Saturn from Keplerian elements, geocentric RA/Dec.
   - Sun: subsolar point drives the terminator (astronomical/nautical/civil
     twilight rings) on the globe = "sun hitting the earth"; when the sun
     itself is in frame we draw its glare + rays.
   - Moon: geocentric position + current phase (illuminated fraction, waxing/
     waning, bright limb rotated toward the sun on screen) with a small label.

   Sky-to-screen mapping: the background sky visible around the globe is the
   patch of celestial sphere behind the planet (anti-camera point A = the
   antipode of the map center, converted through GMST so panning the globe
   pans the real sky). Directions and orientation are accurate; the angular
   scale is compressed (a strictly correct FOV would show only a ~25° window
   of sky, i.e. three stars) — same compromise every planetarium-style globe
   makes. Everything redraws on map move + once a minute as the sky evolves. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  var map = null, canvas = null, ctx = null, inited = false;
  var timer = null;

  /* ================= math helpers ================= */
  var DEG = Math.PI / 180;
  function rad(x) { return x * DEG; }
  function deg(x) { return x / DEG; }
  function rev(x) { x = x % 360; return x < 0 ? x + 360 : x; }

  // Days since J2000.0 and Greenwich mean sidereal time (degrees).
  function daysJ2000(t) { return t / 86400000 + 2440587.5 - 2451545.0; }
  function gmst(d) { return rev(280.46061837 + 360.98564736629 * d); }
  function obliquity(d) { return 23.4393 - 3.563e-7 * d; }

  // Destination point on a sphere: from (lat,lng) along bearing b for arc t (all deg).
  function dest(lat, lng, b, t) {
    var f = rad(lat), l = rad(lng), br = rad(b), d = rad(t);
    var f2 = Math.asin(Math.sin(f) * Math.cos(d) + Math.cos(f) * Math.sin(d) * Math.cos(br));
    var l2 = l + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(f),
      Math.cos(d) - Math.sin(f) * Math.sin(f2));
    return [deg(f2), deg(l2)];
  }

  // Angular distance + initial bearing between two (lat,lng) points (deg).
  function arcTo(lat1, lng1, lat2, lng2) {
    var f1 = rad(lat1), f2 = rad(lat2), dl = rad(lng2 - lng1);
    var a = Math.sin((f2 - f1) / 2), b = Math.sin(dl / 2);
    var h = a * a + Math.cos(f1) * Math.cos(f2) * b * b;
    var dist = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    var brg = Math.atan2(Math.sin(dl) * Math.cos(f2),
      Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl));
    return { dist: deg(dist), bearing: rev(deg(brg)) };
  }

  // Kepler's equation (all deg in/out).
  function kepler(M, e) {
    var E = M + deg(e) * Math.sin(rad(M)) * (1 + e * Math.cos(rad(M)));
    for (var i = 0; i < 4; i++) {
      E = E - (E - deg(e) * Math.sin(rad(E)) - M) / (1 - e * Math.cos(rad(E)));
    }
    return E;
  }

  // Ecliptic lon/lat (+ dist) → equatorial RA/Dec (deg).
  function eclToEq(lon, lat, d) {
    var ecl = rad(obliquity(d));
    var x = Math.cos(rad(lon)) * Math.cos(rad(lat));
    var y = Math.sin(rad(lon)) * Math.cos(rad(lat));
    var z = Math.sin(rad(lat));
    var ye = y * Math.cos(ecl) - z * Math.sin(ecl);
    var ze = y * Math.sin(ecl) + z * Math.cos(ecl);
    return { ra: rev(deg(Math.atan2(ye, x))), dec: deg(Math.asin(ze)) };
  }

  /* ================= sun ================= */
  function sunCalc(t) {
    var d = daysJ2000(t);
    var w = rev(282.9404 + 4.70935e-5 * d);
    var e = 0.016709 - 1.151e-9 * d;
    var M = rev(356.0470 + 0.9856002585 * d);
    var E = kepler(M, e);
    var xv = Math.cos(rad(E)) - e;
    var yv = Math.sqrt(1 - e * e) * Math.sin(rad(E));
    var v = deg(Math.atan2(yv, xv));
    var r = Math.sqrt(xv * xv + yv * yv);
    var lon = rev(v + w);                       // geocentric ecliptic longitude
    var eq = eclToEq(lon, 0, d);
    return {
      ra: eq.ra, dec: eq.dec, eclLon: lon, dist: r,
      // Point where the sun is at the zenith right now.
      subLat: eq.dec,
      subLng: rev(eq.ra - gmst(d) + 180) - 180
    };
  }

  /* ================= moon ================= */
  function moonCalc(t) {
    var d = daysJ2000(t);
    var N = rev(125.1228 - 0.0529538083 * d);
    var i = 5.1454;
    var w = rev(318.0634 + 0.1643573223 * d);
    var a = 60.2666;
    var e = 0.054900;
    var M = rev(115.3654 + 13.0649929509 * d);
    var E = kepler(M, e);
    var xv = a * (Math.cos(rad(E)) - e);
    var yv = a * Math.sqrt(1 - e * e) * Math.sin(rad(E));
    var v = deg(Math.atan2(yv, xv));
    var r = Math.sqrt(xv * xv + yv * yv);
    var u = rad(v + w);
    var xh = r * (Math.cos(rad(N)) * Math.cos(u) - Math.sin(rad(N)) * Math.sin(u) * Math.cos(rad(i)));
    var yh = r * (Math.sin(rad(N)) * Math.cos(u) + Math.cos(rad(N)) * Math.sin(u) * Math.cos(rad(i)));
    var zh = r * Math.sin(u) * Math.sin(rad(i));
    var lon = rev(deg(Math.atan2(yh, xh)));
    var lat = deg(Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)));

    // Major perturbations (Schlyter): brings longitude to ~0.2° accuracy.
    var sw = rev(282.9404 + 4.70935e-5 * d);
    var Ms = rev(356.0470 + 0.9856002585 * d);
    var Ls = rev(Ms + sw);
    var Lm = rev(N + w + M);
    var D = rev(Lm - Ls), F = rev(Lm - N);
    function s(x) { return Math.sin(rad(x)); }
    lon += -1.274 * s(M - 2 * D) + 0.658 * s(2 * D) - 0.186 * s(Ms) - 0.059 * s(2 * M - 2 * D)
      - 0.057 * s(M - 2 * D + Ms) + 0.053 * s(M + 2 * D) + 0.046 * s(2 * D - Ms)
      + 0.041 * s(M - Ms) - 0.035 * s(D) - 0.031 * s(M + Ms);
    lat += -0.173 * s(F - 2 * D) - 0.055 * s(M - F - 2 * D) - 0.046 * s(M + F - 2 * D)
      + 0.033 * s(F + 2 * D) + 0.017 * s(2 * M + F);

    var eq = eclToEq(lon, lat, d);
    var sun = sunCalc(t);
    // Phase from sun–moon elongation; waxing while the moon runs ahead of the sun.
    var elong = Math.acos(Math.cos(rad(lon - sun.eclLon)) * Math.cos(rad(lat)));
    var illum = (1 - Math.cos(elong)) / 2;
    var waxing = rev(lon - sun.eclLon) < 180;
    return { ra: eq.ra, dec: eq.dec, illum: illum, waxing: waxing, phaseName: phaseName(illum, waxing) };
  }

  function phaseName(k, waxing) {
    if (k < 0.03) return 'New moon';
    if (k > 0.97) return 'Full moon';
    if (k > 0.47 && k < 0.53) return waxing ? 'First quarter' : 'Last quarter';
    if (k < 0.5) return waxing ? 'Waxing crescent' : 'Waning crescent';
    return waxing ? 'Waxing gibbous' : 'Waning gibbous';
  }

  /* ================= planets ================= */
  // Keplerian elements at day d (Schlyter). [N, i, w, a, e, M] with linear rates.
  var ELEMENTS = {
    Mercury: [48.3313, 3.24587e-5, 7.0047, 5.00e-8, 29.1241, 1.01444e-5, 0.387098, 0, 0.205635, 5.59e-10, 168.6562, 4.0923344368],
    Venus: [76.6799, 2.46590e-5, 3.3946, 2.75e-8, 54.8910, 1.38374e-5, 0.723330, 0, 0.006773, -1.302e-9, 48.0052, 1.6021302244],
    Mars: [49.5574, 2.11081e-5, 1.8497, -1.78e-8, 286.5016, 2.92961e-5, 1.523688, 0, 0.093405, 2.516e-9, 18.6021, 0.5240207766],
    Jupiter: [100.4542, 2.76854e-5, 1.3030, -1.557e-7, 273.8777, 1.64505e-5, 5.20256, 0, 0.048498, 4.469e-9, 19.8950, 0.0830853001],
    Saturn: [113.6634, 2.38980e-5, 2.4886, -1.081e-7, 339.3939, 2.97661e-5, 9.55475, 0, 0.055546, -9.499e-9, 316.9670, 0.0334442282]
  };
  var PLANET_LOOK = {
    Mercury: { c: '#c9c5bc', r: 1.6 },
    Venus: { c: '#f5eddc', r: 2.7 },
    Mars: { c: '#e8896a', r: 2.0 },
    Jupiter: { c: '#eaddc1', r: 2.5 },
    Saturn: { c: '#e4d4a9', r: 2.1 }
  };

  function planetsCalc(t) {
    var d = daysJ2000(t);
    var sun = sunCalc(t);
    // Sun's geocentric ecliptic rectangular coords = -Earth heliocentric.
    var xs = sun.dist * Math.cos(rad(sun.eclLon));
    var ys = sun.dist * Math.sin(rad(sun.eclLon));
    var out = [];
    for (var name in ELEMENTS) {
      var el = ELEMENTS[name];
      var N = rev(el[0] + el[1] * d), inc = el[2] + el[3] * d, w = rev(el[4] + el[5] * d);
      var a = el[6], e = el[8] + el[9] * d, M = rev(el[10] + el[11] * d);
      var E = kepler(M, e);
      var xv = a * (Math.cos(rad(E)) - e);
      var yv = a * Math.sqrt(1 - e * e) * Math.sin(rad(E));
      var v = deg(Math.atan2(yv, xv));
      var r = Math.sqrt(xv * xv + yv * yv);
      var u = rad(v + w);
      // Heliocentric ecliptic
      var xh = r * (Math.cos(rad(N)) * Math.cos(u) - Math.sin(rad(N)) * Math.sin(u) * Math.cos(rad(inc)));
      var yh = r * (Math.sin(rad(N)) * Math.cos(u) + Math.cos(rad(N)) * Math.sin(u) * Math.cos(rad(inc)));
      var zh = r * Math.sin(u) * Math.sin(rad(inc));
      // Geocentric = heliocentric + sun's geocentric
      var xg = xh + xs, yg = yh + ys, zg = zh;
      var lon = rev(deg(Math.atan2(yg, xg)));
      var lat = deg(Math.atan2(zg, Math.sqrt(xg * xg + yg * yg)));
      var eq = eclToEq(lon, lat, d);
      out.push({ name: name, ra: eq.ra, dec: eq.dec });
    }
    return out;
  }

  /* ================= star catalog ================= */
  // The brightest ~80 real stars: [RA°, Dec°, mag, color 0..4]
  // (0 white, 1 blue-white, 2 yellow-white, 3 orange, 4 red)
  var STARS = [
    [101.3, -16.7, -1.46, 0], [96.0, -52.7, -0.74, 2], [219.9, -60.8, -0.27, 2],
    [213.9, 19.2, -0.05, 3], [279.2, 38.8, 0.03, 1], [79.2, 46.0, 0.08, 2],
    [78.6, -8.2, 0.13, 1], [114.8, 5.2, 0.34, 2], [24.4, -57.2, 0.46, 1],
    [88.8, 7.4, 0.50, 4], [211.0, -60.4, 0.61, 1], [297.7, 8.9, 0.76, 0],
    [186.6, -63.1, 0.76, 1], [69.0, 16.5, 0.86, 4], [247.4, -26.4, 0.96, 4],
    [201.3, -11.2, 0.97, 1], [116.3, 28.0, 1.14, 3], [344.4, -29.6, 1.16, 0],
    [310.4, 45.3, 1.25, 0], [191.9, -59.7, 1.25, 1], [152.1, 12.0, 1.35, 1],
    [104.7, -29.0, 1.50, 1], [113.7, 31.9, 1.57, 0], [187.8, -57.1, 1.63, 4],
    [263.4, -37.1, 1.63, 1], [81.3, 6.3, 1.64, 1], [81.6, 28.6, 1.65, 1],
    [138.3, -69.7, 1.69, 0], [84.1, -1.2, 1.69, 1], [332.1, -47.0, 1.74, 1],
    [85.2, -1.9, 1.77, 1], [193.5, 56.0, 1.77, 0], [165.9, 61.8, 1.79, 3],
    [51.1, 49.9, 1.80, 2], [107.1, -26.4, 1.84, 2], [276.0, -34.4, 1.85, 1],
    [125.6, -59.5, 1.86, 3], [206.9, 49.3, 1.86, 1], [264.3, -43.0, 1.87, 2],
    [89.9, 44.9, 1.90, 0], [252.2, -69.0, 1.91, 3], [99.4, 16.4, 1.93, 0],
    [306.4, -56.7, 1.94, 1], [131.2, -54.7, 1.96, 0], [95.7, -18.0, 1.98, 1],
    [141.9, -8.7, 1.98, 3], [38.0, 89.3, 1.98, 2], [31.8, 23.5, 2.00, 3],
    [10.9, -18.0, 2.02, 3], [201.0, 54.9, 2.04, 0], [17.4, 35.6, 2.05, 4],
    [283.8, -26.3, 2.06, 1], [211.7, -36.4, 2.06, 3], [2.1, 29.1, 2.06, 1],
    [263.7, 12.6, 2.07, 0], [222.7, 74.2, 2.08, 3], [86.9, -9.7, 2.09, 1],
    [340.7, -46.9, 2.10, 4], [47.0, 41.0, 2.12, 1], [177.3, 14.6, 2.13, 0],
    [137.0, -43.4, 2.21, 3], [233.7, 26.7, 2.23, 0], [83.0, -0.3, 2.23, 1],
    [305.6, 40.3, 2.23, 2], [269.2, 51.5, 2.23, 3], [10.1, 56.5, 2.24, 3],
    [120.9, -40.0, 2.25, 1], [31.0, 42.3, 2.26, 3], [2.3, 59.1, 2.27, 2],
    [240.1, -22.6, 2.29, 1], [165.5, 56.4, 2.37, 0], [155.0, 19.8, 2.37, 3],
    [326.0, 9.9, 2.38, 3], [345.9, 28.1, 2.42, 4], [178.5, 53.7, 2.44, 0],
    [14.2, 60.7, 2.47, 1], [346.2, 15.2, 2.49, 1], [21.5, 60.2, 2.68, 0],
    [183.8, -58.7, 2.79, 1], [3.3, 15.2, 2.83, 1], [183.9, 57.0, 3.31, 0]
  ];
  var STAR_COLORS = ['#ffffff', '#cdddff', '#fdf3d8', '#ffd9a8', '#ffb08a'];

  // Seeded PRNG for the reproducible faint-star field + Milky Way blobs.
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
  }

  var faintStars = null, twinklers = null, mwBlobs = null, blobSprite = null, starTw = null;
  function buildStatic() {
    var rand = mulberry(20260703);
    var i;
    // Static faint field (painted on the cached background layer)…
    faintStars = [];
    for (i = 0; i < 300; i++) {
      faintStars.push({
        ra: rand() * 360,
        dec: deg(Math.asin(2 * rand() - 1)),   // uniform on the sphere
        r: 0.35 + rand() * 0.6,
        a: 0.18 + rand() * 0.5
      });
    }
    // …plus a smaller set that twinkles on the live layer.
    twinklers = [];
    for (i = 0; i < 90; i++) {
      twinklers.push({
        ra: rand() * 360,
        dec: deg(Math.asin(2 * rand() - 1)),
        r: 0.5 + rand() * 0.7,
        a: 0.3 + rand() * 0.5,
        sp: 1.5 + rand() * 4,       // twinkle speed (rad/s)
        ph: rand() * 6.283
      });
    }
    // Per-bright-star twinkle parameters (parallel to STARS). Planets get none —
    // real planets don't twinkle (they're discs, not point sources).
    starTw = [];
    for (i = 0; i < STARS.length; i++) starTw.push([1.2 + rand() * 3, rand() * 6.283]);
    // Milky Way: soft blobs strung along the real galactic equator
    // (great circle 90° from the north galactic pole, RA 192.86° Dec +27.13°).
    mwBlobs = [];
    for (var b = 0; b < 360; b += 3) {
      var p = dest(27.128, 192.859, b, 90);
      for (var j = 0; j < 2; j++) {
        var off = (rand() - 0.5) * 14;
        var q = dest(p[0], p[1], rand() * 360, Math.abs(off));
        mwBlobs.push({
          ra: q[1], dec: q[0],
          r: 28 + rand() * 36,
          a: 0.022 * Math.exp(-(off * off) / 50)
        });
      }
    }
    // Cached soft-blob sprite (radial gradient) — drawing hundreds of live gradients is slow.
    blobSprite = document.createElement('canvas');
    blobSprite.width = blobSprite.height = 64;
    var g = blobSprite.getContext('2d');
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(210,220,255,1)');
    grad.addColorStop(1, 'rgba(210,220,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }

  /* ================= night terminator overlay ================= */
  // Nested discs around the antisolar point: astronomical night core (sun 18°
  // below the horizon) out to the terminator, each ring adding opacity, giving
  // a soft accurate twilight gradient. Fades out by street zoom.
  var NIGHT_RADII = [72, 78, 84, 90];

  // Circle of angular radius `radius`° around (lat,lng), pole-safe: when the
  // circle encloses a pole, close the ring along that pole's edge.
  function circleRing(lat, lng, radius) {
    var pts = [], prev = null;
    for (var b = 0; b <= 360; b += 3) {
      var p = dest(lat, lng, b, radius);
      var L = p[1];
      if (prev != null) { while (L - prev > 180) L -= 360; while (L - prev < -180) L += 360; }
      prev = L;
      pts.push([L, p[0]]);
    }
    var drift = pts[pts.length - 1][0] - pts[0][0];
    if (Math.abs(drift) > 180) {
      var poleLat = (lat - radius < -90) ? -90 : 90;
      pts.push([pts[pts.length - 1][0], poleLat]);
      pts.push([pts[0][0], poleLat]);
    }
    pts.push(pts[0].slice());
    return pts;
  }

  function nightFC() {
    var sun = sunCalc(Date.now());
    var aLat = -sun.subLat, aLng = rev(sun.subLng + 180 + 180) - 180;
    return {
      type: 'FeatureCollection',
      features: NIGHT_RADII.map(function (r, i) {
        return {
          type: 'Feature',
          properties: { ring: i },
          geometry: { type: 'Polygon', coordinates: [circleRing(aLat, aLng, r)] }
        };
      })
    };
  }

  // Settings kill-switch (Settings → Map & live → "Space scenery").
  function enabled() {
    return !(A.state && A.state.settings && A.state.settings.showSpace === false);
  }

  function setNightVisible(v) {
    if (!map) return;
    for (var i = 0; i < NIGHT_RADII.length; i++) {
      var id = 'space-night-' + i;
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    }
  }

  function addNightLayers() {
    if (!map || map.getSource('space-night')) return;
    try {
      map.addSource('space-night', { type: 'geojson', data: nightFC() });
      for (var i = 0; i < NIGHT_RADII.length; i++) {
        map.addLayer({
          id: 'space-night-' + i,
          type: 'fill',
          source: 'space-night',
          filter: ['==', ['get', 'ring'], i],
          layout: { visibility: enabled() ? 'visible' : 'none' },
          paint: {
            'fill-color': '#020917',
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.16, 7, 0]
          }
        });
      }
    } catch (e) { /* style mid-swap — next style.load retries */ }
  }

  function refreshNight() {
    var src = map && map.getSource('space-night');
    if (src) src.setData(nightFC());
  }

  /* ================= sky projection ================= */
  // Screen position of a celestial (RA,Dec) for the current camera. The sky
  // behind the globe is centred on A = antipode of the map center in
  // earth-fixed coords; GMST converts celestial RA into earth-fixed longitude.
  function skyProjector() {
    var t = Date.now();
    var th = gmst(daysJ2000(t));
    var c = map.getCenter();
    var beta = map.getBearing();
    var aLat = -c.lat, aLng = rev(c.lng + 180 + 180) - 180;
    var ctr = map.project([c.lng, c.lat]);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var minDim = Math.min(w, h) || 1;

    // Globe pixel radius: measure the on-screen distance of a point 60° of arc
    // from the center; orthographic radius = d / sin(60°).
    var G;
    try {
      var q = dest(c.lat, c.lng, 90, 60);
      var p1 = map.project([q[1], q[0]]);
      G = Math.hypot(p1.x - ctr.x, p1.y - ctr.y) / Math.sin(rad(60));
      if (!isFinite(G) || G < 40) G = minDim * 0.33;
    } catch (e) { G = minDim * 0.33; }

    var RHO0 = 11;                       // sky angle hidden behind the globe disc
    var pxPerDeg = (minDim * 0.75) / 99; // ρ 11°..110° spans ~3/4 of the viewport

    return function (ra, dec) {
      var efLng = rev(ra - th + 180) - 180;  // earth-fixed longitude of this star
      var a = arcTo(aLat, aLng, dec, efLng);
      if (a.dist > 150) return null;         // behind the camera
      var s = G + (a.dist - RHO0) * pxPerDeg;
      var ang = rad(a.bearing + beta);
      return {
        x: ctr.x - s * Math.sin(ang),
        y: ctr.y - s * Math.cos(ang),
        rho: a.dist,
        // fade the outermost sky so objects vanish gently, not at a hard edge
        fade: a.dist < 115 ? 1 : Math.max(0, (150 - a.dist) / 35)
      };
    };
  }

  /* ================= painting ================= */
  /* Two layers for smooth 60fps twinkle at low cost:
       static (offscreen): backdrop + Milky Way + faint field — re-rendered at
         most ~14×/s while the camera moves;
       live (visible):     static blit + twinkling stars + planets + moon + sun,
         drawn every animation frame.
     Buffers run at reduced resolution (space needs no retina crispness) and
     are BOTH freed — rAF stopped, minute-timer idled — once the globe fills
     the screen, so street-level driving pays nothing for space. */
  var staticCv = null, staticCtx = null;
  var active = false, rafId = 0, staticDirty = true, lastStatic = 0;
  var eph = null;                       // cached ephemeris {at, sun, moon, planets}
  var SUSPEND_Z = 7.2, RESUME_Z = 6.9;  // hysteresis so the boundary can't thrash

  function resScale() {
    var dpr = window.devicePixelRatio || 1;
    return dpr >= 2 ? dpr / 2 : dpr;    // half-res on retina ⇒ ~4× less buffer memory
  }

  function sizeCanvases() {
    var el = map.getContainer();
    var s = resScale();
    var w = el.clientWidth, h = el.clientHeight;
    var pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; canvas.height = ph;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      staticCv.width = pw; staticCv.height = ph;
      staticDirty = true;
    }
    ctx.setTransform(s, 0, 0, s, 0, 0);
    staticCtx.setTransform(s, 0, 0, s, 0, 0);
  }

  // Sun/moon/planet positions drift arc-minutes per minute — recomputing them
  // per frame is pure waste. Cache for 30 s.
  function ephemeris(t) {
    if (!eph || t - eph.at > 30000) {
      eph = { at: t, sun: sunCalc(t), moon: moonCalc(t), planets: planetsCalc(t) };
    }
    return eph;
  }

  function renderStatic() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var proj = skyProjector();
    var g = staticCtx, p, i;

    var bg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#070b18');
    bg.addColorStop(1, '#01030a');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    for (i = 0; i < mwBlobs.length; i++) {
      var mb = mwBlobs[i];
      p = proj(mb.ra, mb.dec);
      if (!p || p.x < -80 || p.x > w + 80 || p.y < -80 || p.y > h + 80) continue;
      g.globalAlpha = mb.a * p.fade;
      g.drawImage(blobSprite, p.x - mb.r, p.y - mb.r, mb.r * 2, mb.r * 2);
    }

    g.fillStyle = '#dfe6ff';
    for (i = 0; i < faintStars.length; i++) {
      var fs = faintStars[i];
      p = proj(fs.ra, fs.dec);
      if (!p || p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
      g.globalAlpha = fs.a * p.fade;
      g.fillRect(p.x, p.y, fs.r, fs.r);
    }
    g.globalAlpha = 1;
  }

  function renderLive(now) {
    sizeCanvases();
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var proj = skyProjector();
    var e = ephemeris(Date.now());
    var tsec = now / 1000;
    var p, i;

    ctx.drawImage(staticCv, 0, 0, w, h);   // opaque backdrop — doubles as the clear

    // Twinkling faint stars
    ctx.fillStyle = '#dfe6ff';
    for (i = 0; i < twinklers.length; i++) {
      var tw = twinklers[i];
      p = proj(tw.ra, tw.dec);
      if (!p || p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
      ctx.globalAlpha = tw.a * (0.55 + 0.45 * Math.sin(tsec * tw.sp + tw.ph)) * p.fade;
      ctx.fillRect(p.x, p.y, tw.r, tw.r);
    }

    // Real bright stars, each shimmering on its own rhythm
    for (i = 0; i < STARS.length; i++) {
      var st = STARS[i];
      p = proj(st[0], st[1]);
      if (!p || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
      var wob = 0.72 + 0.28 * Math.sin(tsec * starTw[i][0] + starTw[i][1]);
      var r = Math.max(0.7, Math.min(3.2, 2.5 - 0.45 * st[2])) * (0.94 + 0.06 * wob);
      if (st[2] < 0.9) { // glow for first-magnitude stars
        ctx.globalAlpha = 0.35 * wob * p.fade;
        ctx.drawImage(blobSprite, p.x - r * 4, p.y - r * 4, r * 8, r * 8);
      }
      ctx.globalAlpha = wob * p.fade;
      ctx.fillStyle = STAR_COLORS[st[3]];
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Planets — steady light, like the real thing (planets don't twinkle)
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (i = 0; i < e.planets.length; i++) {
      var pl = e.planets[i];
      p = proj(pl.ra, pl.dec);
      if (!p || p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) continue;
      var look = PLANET_LOOK[pl.name];
      ctx.globalAlpha = 0.5 * p.fade;
      ctx.drawImage(blobSprite, p.x - look.r * 3.2, p.y - look.r * 3.2, look.r * 6.4, look.r * 6.4);
      ctx.globalAlpha = p.fade;
      ctx.fillStyle = look.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, look.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.6 * p.fade;
      ctx.fillStyle = '#aeb8cc';
      ctx.fillText(pl.name, p.x, p.y + look.r + 11);
    }

    var sunP = proj(e.sun.ra, e.sun.dec);
    var moonP = proj(e.moon.ra, e.moon.dec);
    if (moonP) drawMoon(moonP, e.moon, sunP, e.sun, proj);
    if (sunP) drawSun(sunP);
    ctx.globalAlpha = 1;
  }

  function drawSun(p) {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (p.x < -150 || p.x > w + 150 || p.y < -150 || p.y > h + 150) return;
    var R = Math.max(60, Math.min(w, h) * 0.16);
    // rays
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 0.10 * p.fade;
    ctx.strokeStyle = '#fff3cf';
    for (var i = 0; i < 12; i++) {
      ctx.rotate(Math.PI / 6);
      ctx.lineWidth = i % 2 ? 1 : 2;
      ctx.beginPath();
      ctx.moveTo(R * 0.25, 0);
      ctx.lineTo(R * (i % 2 ? 1.5 : 2.1), 0);
      ctx.stroke();
    }
    ctx.restore();
    // glare
    var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
    g.addColorStop(0, 'rgba(255,250,235,0.95)');
    g.addColorStop(0.25, 'rgba(255,240,200,0.45)');
    g.addColorStop(1, 'rgba(255,235,190,0)');
    ctx.globalAlpha = p.fade;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fill();
    // core
    ctx.fillStyle = '#fffdf4';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMoon(p, moon, sunP, sun, proj) {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (p.x < -30 || p.x > w + 30 || p.y < -30 || p.y > h + 30) return;
    var r = 9;
    // Bright limb faces the sun on screen. If the sun projects behind the
    // camera (proj null), fall back to a forced projection ignoring the cutoff.
    var sx, sy;
    if (sunP) { sx = sunP.x; sy = sunP.y; }
    else {
      // direction only: project a point 20° from the moon toward the sun's RA/Dec
      var a = arcTo(moon.dec, moon.ra, sun.dec, sun.ra);
      var q = dest(moon.dec, moon.ra, a.bearing, 20);
      var qp = proj(q[1], q[0]);
      sx = qp ? qp.x : p.x + 1; sy = qp ? qp.y : p.y;
    }
    var chi = Math.atan2(sy - p.y, sx - p.x);
    var k = moon.illum;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = p.fade;
    // faint halo
    ctx.globalAlpha = 0.25 * p.fade;
    ctx.drawImage(blobSprite, -r * 3, -r * 3, r * 6, r * 6);
    ctx.globalAlpha = p.fade;
    ctx.rotate(chi); // +x now points at the sun
    // dark disc
    ctx.fillStyle = '#333a48';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // lit portion: sunward half-disc plus/minus the terminator ellipse
    var rx = r * Math.abs(2 * k - 1);
    ctx.fillStyle = '#eae6da';
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);       // sunward half
    if (ctx.ellipse) {
      ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, Math.PI * 1.5, k < 0.5); // terminator
    } else {
      // Legacy WebViews without ellipse(): one quadratic from pole to pole. Its
      // control point sits at 2·rx on the bulge side, which is the quadratic
      // whose midpoint excursion equals the ellipse's semi-axis.
      var cx = 2 * rx * (k < 0.5 ? -1 : 1);
      ctx.quadraticCurveTo(cx, 0, 0, -r);
    }
    ctx.fill();
    ctx.restore();

    // label with the current phase
    ctx.globalAlpha = 0.75 * p.fade;
    ctx.fillStyle = '#cfd6e4';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Moon · ' + moon.phaseName + ' ' + Math.round(moon.illum * 100) + '%', p.x, p.y + r + 16);
    ctx.globalAlpha = 1;
  }

  /* ================= animation loop / lifecycle ================= */
  function frame(now) {
    rafId = 0;
    if (!active) return;
    if (staticDirty && now - lastStatic > 70) {  // ≤ ~14 static rebuilds/s while panning
      renderStatic();
      lastStatic = now;
      staticDirty = false;
    }
    renderLive(now);
    rafId = requestAnimationFrame(frame);
  }

  function resume() {
    if (active) return;
    active = true;
    canvas.style.display = '';
    staticDirty = true;
    eph = null;
    refreshNight();
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  // Zoomed into streets: stop the loop and free BOTH pixel buffers — space
  // costs nothing until the camera pulls back out.
  function suspend() {
    if (!active) return;
    active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    canvas.width = canvas.height = 1;
    staticCv.width = staticCv.height = 1;
    canvas.style.display = 'none';
  }

  function checkZoom() {
    if (!enabled()) { suspend(); return; }
    var z = map.getZoom();
    if (active && z > SUSPEND_Z) suspend();
    else if (!active && z < RESUME_Z) resume();
  }

  function init(m) {
    if (inited) return;
    inited = true;
    map = m;
    var el = map.getContainer();
    canvas = document.createElement('canvas');
    canvas.className = 'space-canvas';
    canvas.style.display = 'none';       // checkZoom() below decides
    el.insertBefore(canvas, el.firstChild);
    ctx = canvas.getContext('2d');
    staticCv = document.createElement('canvas');
    staticCtx = staticCv.getContext('2d');
    buildStatic();

    // Registered before mapview's ensureLayers listener (init order), so the
    // night overlay sits underneath all app data layers.
    map.on('style.load', addNightLayers);
    if (map.isStyleLoaded && map.isStyleLoaded()) addNightLayers();

    map.on('move', function () { staticDirty = true; checkZoom(); });
    map.on('resize', function () { staticDirty = true; });
    // rAF is already paused in hidden tabs; make the stop/restart explicit so
    // the loop can't pile up on visibility flips.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
      else if (active && !rafId) rafId = requestAnimationFrame(frame);
    });
    // Once a minute the terminator + sky rotate on — only while space is visible.
    timer = setInterval(function () {
      if (!active) return;
      refreshNight();
      staticDirty = true;
    }, 60000);

    checkZoom();
  }

  A.space = {
    init: init,
    // Settings toggle: off ⇒ suspend the sky (buffers freed) + hide the
    // day/night overlay; on ⇒ resume whenever the zoom allows it.
    setEnabled: function (v) {
      setNightVisible(v !== false);
      if (v === false) suspend();
      else checkZoom();
    },
    // Force a full synchronous repaint — also the test path, since rAF never
    // fires in hidden tabs.
    refresh: function () {
      if (!map) return;
      checkZoom();
      if (!active) return;
      refreshNight();
      sizeCanvases();
      renderStatic();
      lastStatic = performance.now();
      staticDirty = false;
      renderLive(performance.now());
    },
    // exposed for sanity checks / other consumers
    calc: { sun: sunCalc, moon: moonCalc, planets: planetsCalc }
  };
})();

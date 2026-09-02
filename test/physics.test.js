/* Convoy — physics & measurement tests.

   These drive the REAL js/racetimer.js and js/util.js through their public API
   with synthetic GPS streams whose exact answers are known from closed-form
   kinematics. Nothing is stubbed: if the timing core regresses, these fail.

   A note on what is and isn't provable here
   ----------------------------------------
   Two different error sources live in a GPS drag timer, and they deserve
   different standards:

     1. CROSSING MATH — given a bracketing pair of samples, when exactly did the
        car hit 60 mph / the ¼-mile line? This is fully determined and must be
        near-exact. Tested with ROLLING starts, where the launch instant itself
        is recovered exactly from a genuine acceleration ramp.

     2. LAUNCH DETECTION on a STANDING start — when did the car actually begin
        to move, given it was stationary at one 1 Hz sample and rolling at the
        next? That instant is genuinely unknowable to better than the sample
        interval. It is bounded and asserted as a bound, not pretended exact.

   Run:  node test/physics.test.js
*/
'use strict';
const H = require('./harness');

H.installBrowser();
H.loadModule('js/util.js');
H.loadModule('js/racetimer.js');

const A = global.window.App;
const U = A.util;
const RT = A.racetimer;

const MS_TO_MPH = 2.2369362921;
const MPH = 1 / MS_TO_MPH;      // mph -> m/s
const MILE = 1609.344;
const FOOT = 0.3048;
const START = [-118.2517, 34.0480];   // LA, ~34° N
const T0 = 1700000000000;             // fixed epoch — runs are reproducible

/* ---------------------------------------------------------------------------
   Rolling-start generator: the car is ALREADY moving at v0 and accelerating at
   a constant `a`, sampled at `hz`. Because the whole stream is one uniform
   ramp, the timer's launch back-date (the moment speed crosses mode.from) is
   recoverable exactly — which isolates the crossing math under test.
       v(t) = v0 + a·t        d(t) = v0·t + ½·a·t²
--------------------------------------------------------------------------- */
function rollingRun(timer, opts) {
  const { v0, accel, hz = 1, duration = 30 } = opts;
  const step = 1000 / hz;
  for (let i = 0; i * step <= duration * 1000; i++) {
    const t = (i * step) / 1000;
    const v = v0 + accel * t;
    const d = v0 * t + 0.5 * accel * t * t;
    timer.feed({ pos: U.destPoint(START, 90, d), speed: v, t: T0 + i * step });
  }
}

// Standing-start generator: stationary, then a uniform ramp beginning
// `launchOffset` seconds after a sample boundary (the realistic case).
function standingRun(timer, opts) {
  const { accel, hz = 1, duration = 20, launchOffset = 0.37 } = opts;
  const step = 1000 / hz;
  timer.feed({ pos: START.slice(), speed: 0, t: T0 - 2 * step });
  timer.feed({ pos: START.slice(), speed: 0, t: T0 - step });
  for (let i = 0; ; i++) {
    const tt = (i * step) / 1000 - launchOffset;
    if (tt > duration) break;
    const v = tt <= 0 ? 0 : accel * tt;
    const d = tt <= 0 ? 0 : 0.5 * accel * tt * tt;
    timer.feed({ pos: U.destPoint(START, 90, d), speed: v, t: T0 + i * step });
  }
}

function drive(mode, gen, opts) {
  let finished = null;
  const t = RT.make(mode, { onFinish: (res) => { finished = res; } });
  t.resetArm();
  gen(t, opts);
  return { result: finished, timer: t };
}

// Closed-form: time from v0 to cover distance D at constant a.
const timeForDist = (v0, a, D) => (Math.sqrt(v0 * v0 + 2 * a * D) - v0) / a;
const speedAfterDist = (v0, a, D) => Math.sqrt(v0 * v0 + 2 * a * D);

/* ======================================================================== */
H.group('Speed crossings — must be exact (linear in time under constant a)');
{
  const a = 3.2, v0 = 50 * MPH;
  const { result } = drive(
    { id: '60-130', label: '60–130 mph', type: 'accel', from: 60 * MPH, to: 130 * MPH },
    rollingRun, { v0, accel: a, hz: 1, duration: 40 });

  H.ok('60–130 pull finishes', !!result);
  if (result) H.near('60–130 elapsed', result.time, (130 * MPH - 60 * MPH) / a, 0.005, 's');
}

/* ======================================================================== */
H.group('Distance crossings — the quadratic-solve fix');
{
  // A rolling ¼ mile: launch is exact, so any error here is pure crossing math.
  const a = 3.2, v0 = 20 * MPH, from = 30 * MPH, D = MILE / 4;
  const expT = timeForDist(from, a, D);
  const expTrap = speedAfterDist(from, a, D);

  const { result } = drive(
    { id: 'q-roll', label: 'rolling ¼', type: 'dist', from, meters: D },
    rollingRun, { v0, accel: a, hz: 1, duration: 40 });

  H.ok('rolling ¼ mile finishes', !!result);
  if (result) {
    H.near('¼ mile elapsed', result.time, expT, 0.02, 's');
    H.near('¼ mile trap speed', result.trap * MS_TO_MPH, expTrap * MS_TO_MPH, 0.2, 'mph');
  }

  // What the OLD linear-in-distance interpolation would have produced, so the
  // test documents the size of the defect it replaced. Reconstruct the segment
  // that brackets the finish and interpolate it the old way.
  if (result) {
    const tA = Math.floor(expT);                       // last 1 Hz sample before the line
    const dA = from * tA + 0.5 * a * tA * tA;
    const dB = from * (tA + 1) + 0.5 * a * (tA + 1) * (tA + 1);
    const linear = tA + (D - dA) / (dB - dA);          // old crossDist
    const oldErr = Math.abs(linear - expT);
    const newErr = Math.abs(result.time - expT);
    H.ok('quadratic beats the old linear interpolation  (new |Δ|=' + H.fmt(newErr) +
      's vs old |Δ|=' + H.fmt(oldErr) + 's)', newErr < oldErr / 4,
      'expected at least a 4× improvement');
  }
}

/* ======================================================================== */
H.group('Sample-rate independence — 1 Hz must agree with 10 Hz');
{
  const mode = { id: 'q-roll', label: 'rolling ¼', type: 'dist', from: 30 * MPH, meters: MILE / 4 };
  const base = { v0: 20 * MPH, accel: 3.6, duration: 40 };
  const slow = drive(mode, rollingRun, { ...base, hz: 1 }).result;
  const fast = drive(mode, rollingRun, { ...base, hz: 10 }).result;

  H.ok('both rates finish', !!slow && !!fast);
  if (slow && fast) {
    // If the crossing model were wrong, coarse sampling would drift away from
    // fine sampling. Agreement across a 10× rate change is the real proof.
    H.near('1 Hz vs 10 Hz elapsed', slow.time, fast.time, 0.02, 's');
    H.near('1 Hz vs 10 Hz trap', slow.trap * MS_TO_MPH, fast.trap * MS_TO_MPH, 0.2, 'mph');
  }
}

/* ======================================================================== */
H.group('Distance = ∫speed dt — immune to GPS position noise');
{
  // Why this matters: a real receiver's POSITION wanders a few metres per fix
  // even when its Doppler SPEED is clean. Summing chord lengths between noisy
  // fixes turns that wander into a random walk that inflates the measured
  // distance, which shortens every distance-based time (¼ mile, 60 ft).
  // Integrating speed ignores position entirely.
  const V = 20, SECS = 60, NOISE = 3;      // 20 m/s for 60 s, ±3 m fixes
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const mode = { id: 'far', label: 'far', type: 'dist', from: 10, meters: 1e6 }; // never finishes
  const t = RT.make(mode, {});
  t.resetArm();

  const fixes = [];
  t.feed({ pos: START.slice(), speed: 5, t: T0 });          // below the 10 m/s gate
  for (let i = 0; i <= SECS; i++) {
    const clean = U.destPoint(START, 90, V * i);
    const noisy = U.destPoint(clean, rnd() * 360, rnd() * NOISE);
    fixes.push(noisy);
    t.feed({ pos: noisy, speed: V, t: T0 + 1000 + i * 1000 });
  }

  // The timer starts at the 10 m/s gate crossing, which is interpolated inside
  // the first segment — so the exact expected total is that partial plus the
  // steady cruise. Compute it from the timer's own t0 rather than guessing.
  const t0 = t.state().t0;
  const lastT = T0 + 1000 + SECS * 1000;
  const partial = 0.5 * (10 + V) * ((T0 + 1000) - t0) / 1000;
  const expected = partial + V * ((lastT - (T0 + 1000)) / 1000);

  H.near('integrated distance', t.state().runDist, expected, 0.5, 'm');

  // What naive chord-summing of the SAME fixes would have produced.
  let chord = 0;
  for (let i = 1; i < fixes.length; i++) chord += U.haversine(fixes[i - 1], fixes[i]);
  const chordErr = Math.abs(chord - V * SECS);
  const intErr = Math.abs(t.state().runDist - expected);
  H.ok('integration beats chord-summing under noise  (|Δ|=' + H.fmt(intErr) +
    'm vs chord |Δ|=' + H.fmt(chordErr) + 'm)', intErr < chordErr / 10,
    'expected at least a 10× improvement');
}

/* ======================================================================== */
H.group('Standing start — launch bias is bounded by the sample interval');
{
  // The car is stationary at one sample and rolling at the next. The true
  // launch instant is unknowable to better than one sample period; assert that
  // the error stays inside it (and shrinks with a faster receiver).
  const a = 60 * MPH / 5.2;
  const truth = (60 * MPH) / a;
  const mode = { id: '0-60', label: '0–60 mph', type: 'accel', from: 0, to: 60 * MPH };

  const at1 = drive(mode, standingRun, { accel: a, hz: 1, duration: 12 }).result;
  const at10 = drive(mode, standingRun, { accel: a, hz: 10, duration: 12 }).result;

  H.ok('0–60 finishes at 1 Hz', !!at1);
  H.ok('0–60 finishes at 10 Hz', !!at10);
  if (at1) H.ok('1 Hz error within one sample period  (|Δ|=' + H.fmt(Math.abs(at1.time - truth)) + 's ≤ 1.0s)',
    Math.abs(at1.time - truth) <= 1.0);
  if (at10) H.ok('10 Hz error within one sample period  (|Δ|=' + H.fmt(Math.abs(at10.time - truth)) + 's ≤ 0.1s)',
    Math.abs(at10.time - truth) <= 0.1);
  if (at1 && at10) H.ok('a faster receiver is strictly more accurate',
    Math.abs(at10.time - truth) < Math.abs(at1.time - truth));
}

/* ======================================================================== */
H.group('Standing-start splits stay mutually consistent');
{
  // 60 ft, ⅛ and ¼ must be monotonic and each must satisfy the same
  // kinematics as the others — they all come from one integrated distance.
  const a = 60 * MPH / 5.0;
  const results = {};
  [['60ft', 60 * FOOT], ['eighth', MILE / 8], ['quarter', MILE / 4]].forEach(([id, m]) => {
    const r = drive({ id, label: id, type: 'dist', from: 0, meters: m }, standingRun,
      { accel: a, hz: 10, duration: 25 }).result;
    results[id] = r;
  });
  H.ok('all three splits time', !!(results['60ft'] && results.eighth && results.quarter));
  if (results['60ft'] && results.eighth && results.quarter) {
    H.ok('60 ft < ⅛ mile < ¼ mile',
      results['60ft'].time < results.eighth.time && results.eighth.time < results.quarter.time,
      `${H.fmt(results['60ft'].time)} / ${H.fmt(results.eighth.time)} / ${H.fmt(results.quarter.time)}`);
    // For a standing start at constant a, distance scales with t²: the ratio of
    // times for ¼ vs ⅛ mile must be √2 regardless of the car.
    const ratio = results.quarter.time / results.eighth.time;
    H.near('t(¼)/t(⅛) = √2', ratio, Math.SQRT2, 0.02, '');
    // Trap speeds scale the same way.
    H.near('trap(¼)/trap(⅛) = √2', results.quarter.trap / results.eighth.trap, Math.SQRT2, 0.02, '');
  }
}

/* ======================================================================== */
H.group('Abort — lifting mid-run re-arms instead of logging a bogus time');
{
  let aborted = false, finished = null;
  const t = RT.make({ id: '0-100', label: '0–100 mph', type: 'accel', from: 0, to: 100 * MPH },
    { onAbort: () => { aborted = true; }, onFinish: (r) => { finished = r; } });
  t.resetArm();
  t.feed({ pos: START.slice(), speed: 0, t: T0 - 1000 });
  let dd = 0;
  [0, 5, 10, 15, 0, 0, 0, 0].forEach((v, i) => {
    dd += v;
    t.feed({ pos: U.destPoint(START, 90, dd), speed: v, t: T0 + i * 1000 });
  });
  H.ok('the aborted run never reports a time', finished === null,
    finished ? 'got ' + finished.time + 's' : null);
  H.ok('the abort callback fires', aborted);
  H.ok('the timer re-arms for the next attempt', t.state().phase === 'arm',
    'phase is ' + t.state().phase);
}

/* ======================================================================== */
H.group('Re-arm clears the stale baseline (no cross-session t0)');
{
  // A run armed now must not back-date its launch against a fix from hours ago.
  const t = RT.make({ id: '0-60', label: '0–60', type: 'accel', from: 0, to: 60 * MPH }, {});
  t.resetArm();
  t.feed({ pos: START.slice(), speed: 0, t: T0 - 6 * 3600 * 1000 });  // 6 h ago
  t.resetArm();                                                        // re-arm
  let finished = null;
  const t2 = RT.make({ id: '0-60', label: '0–60', type: 'accel', from: 0, to: 60 * MPH },
    { onFinish: (r) => { finished = r; } });
  t2.resetArm();
  t2.feed({ pos: START.slice(), speed: 0, t: T0 - 6 * 3600 * 1000 });
  t2.resetArm();
  standingRun(t2, { accel: 60 * MPH / 5, hz: 10, duration: 12 });
  H.ok('a fresh run times sanely after a stale fix', !!finished && finished.time > 0 && finished.time < 15,
    finished ? finished.time + 's' : 'no finish');
}

/* ======================================================================== */
H.group('Geo math — util.js');
{
  // LA City Hall → Santa Monica Pier. Great-circle distance ≈ 23.9 km
  // (dLng 0.254° at cos34° ≈ 23.4 km east, dLat 0.045° ≈ 5.0 km south).
  const la = [-118.2437, 34.0537], sm = [-118.4977, 34.0086];
  H.near('haversine LA→Santa Monica', U.haversine(la, sm) / 1000, 23.94, 0.1, 'km');

  const p = U.destPoint(la, 42, 5000);
  H.near('destPoint 5 km round-trip', U.haversine(la, p), 5000, 0.5, 'm');
  H.near('destPoint bearing round-trip', U.bearing(la, p), 42, 0.1, '°');

  // relBearing sign convention: + is to the right of travel.
  const east = U.destPoint(la, 90, 1000);
  const west = U.destPoint(la, 270, 1000);
  H.ok('relBearing: east of a northbound car is +90', Math.abs(U.relBearing(la, 0, east) - 90) < 0.1);
  H.ok('relBearing: west of a northbound car is −90', Math.abs(U.relBearing(la, 0, west) + 90) < 0.1);

  // crossTrack: a point straight ahead has ~zero lateral offset.
  const ahead = U.destPoint(la, 0, 3000);
  H.ok('crossTrack straight ahead ≈ 0', U.crossTrack(la, 0, ahead) < 1);
  H.near('crossTrack 100 m offset', U.crossTrack(la, 0, U.destPoint(ahead, 90, 100)), 100, 2, 'm');

  // lerpAngle must take the short way round the 0/360 seam.
  H.near('lerpAngle 350°→10° midpoint', U.lerpAngle(350, 10, 0.5), 0, 0.01, '°');

  // fmtDist unit boundaries.
  H.ok('fmtDist 50 m in miles reads in feet', /ft$/.test(U.fmtDist(50, 'mi')), U.fmtDist(50, 'mi'));
  H.ok('fmtDist 5000 m in miles reads in miles', /mi$/.test(U.fmtDist(5000, 'mi')), U.fmtDist(5000, 'mi'));
  H.ok('fmtDist 500 m in km reads in metres', /m$/.test(U.fmtDist(500, 'km')), U.fmtDist(500, 'km'));
}

process.exit(H.report());

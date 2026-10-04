/* Convoy — geo-math tests for js/util.js.
   These drive the REAL js/util.js through its public API with inputs whose
   exact answers are known from closed-form geometry. Nothing is stubbed.
   Run:  node test/physics.test.js
*/
'use strict';
const H = require('./harness');

H.installBrowser();
H.loadModule('js/util.js');

const A = global.window.App;
const U = A.util;

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

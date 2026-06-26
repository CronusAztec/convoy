/* Convoy — Waze (via RapidAPI) proxy.
   The RapidAPI key is a server secret: it lives in the RAPIDAPI_KEY env var,
   never in client JS. Clients hit our /api/waze endpoint with a bounding box;
   this module forwards to the OpenWeb Ninja Waze API on RapidAPI with the key
   injected, filters to the alert types we surface, and returns normalized
   GeoJSON the client's police/hazard layers can consume directly.

   Upstream: GET https://waze.p.rapidapi.com/alerts-and-jams
     ?bottom_left=lat,lon&top_right=lat,lon
     headers: X-RapidAPI-Key, X-RapidAPI-Host
   Alert shape (normalized): {type:'POLICE'|'HAZARD'|'ACCIDENT'|..., subtype,
     latitude, longitude, street, city, num_thumbs_up, alert_reliability, ...} */
'use strict';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const HOST = 'waze.p.rapidapi.com';
const URL = 'https://' + HOST + '/alerts-and-jams';

function hasKey() { return !!RAPIDAPI_KEY; }

// Which Waze alert types we surface. POLICE is the headline feature; the road
// hazards complement our own crowd-reporting and the OSM hazard pins.
var WANTED = { POLICE: true, ACCIDENT: true, HAZARD: true, ROAD_CLOSED: true };

// Map a Waze alert to the {kind,label,color} the client hazard layer reads.
// kind 'police' renders blue (and feeds the Ghost radar); others reuse hazard kinds.
function classify(a) {
  if (a.type === 'POLICE') return { kind: 'police', label: 'Police (Waze)', color: '#3b82f6' };
  if (a.type === 'ACCIDENT') return { kind: 'accident', label: a.street ? 'Accident · ' + a.street : 'Accident', color: '#ff3b3b' };
  if (a.type === 'ROAD_CLOSED') return { kind: 'hazard', label: a.street ? 'Road closed · ' + a.street : 'Road closed', color: '#ff5a3c' };
  // HAZARD + anything else
  return { kind: 'hazard', label: a.subtype ? a.subtype.replace(/_/g, ' ').toLowerCase() : 'Hazard', color: '#ff5a3c' };
}

// Fetch Waze alerts for a bbox. cb(err, status, geojson).
// bottomLeft/topRight are [lng,lat] pairs (MapLibre convention); we convert to
// the upstream "lat,lon" strings.
async function alerts(bottomLeft, topRight, cb) {
  if (!RAPIDAPI_KEY) return cb(new Error('no key'));
  var bl = bottomLeft[1] + ',' + bottomLeft[0]; // lat,lon
  var tr = topRight[1] + ',' + topRight[0];
  var u = URL + '?bottom_left=' + encodeURIComponent(bl) + '&top_right=' + encodeURIComponent(tr) + '&max_alerts=80&max_jams=0';
  try {
    var r = await fetch(u, { headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': HOST } });
    var text = await r.text();
    var j;
    try { j = JSON.parse(text); } catch (e) { return cb(new Error('bad upstream'), r.status); }
    if (!j || j.status !== 'OK' || !j.data) return cb(new Error('upstream error'), r.status);
    var list = (j.data.alerts || []).filter(function (a) { return WANTED[a.type] && typeof a.latitude === 'number'; });
    var feats = list.map(function (a) {
      var c = classify(a);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.longitude, a.latitude] },
        properties: {
          kind: c.kind, label: c.label, color: c.color,
          street: a.street || '', city: a.city || '',
          waze: true,               // source marker so popups can credit Waze
          thumbs: a.num_thumbs_up || 0,
          reliability: a.alert_reliability || 0,
          when: a.publish_datetime_utc || ''
        }
      };
    });
    cb(null, 200, { type: 'FeatureCollection', features: feats });
  } catch (e) { cb(e); }
}

module.exports = { hasKey, alerts, WANTED, TOMTOM_KEY: RAPIDAPI_KEY };

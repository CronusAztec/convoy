/* Convoy server — bot riders + shared geo/data helpers.
   Bots anchor near connected humans so the map always feels alive,
   accept convoy invites, trail their leader, and chat back. */
'use strict';

const R = 6371000, D2R = Math.PI / 180, R2D = 180 / Math.PI;

/* ---------------- geo ---------------- */
function haversine(a, b) {
  const dLat = (b[1] - a[1]) * D2R, dLng = (b[0] - a[0]) * D2R;
  const la1 = a[1] * D2R, la2 = b[1] * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearing(a, b) {
  const la1 = a[1] * D2R, la2 = b[1] * D2R, dLng = (b[0] - a[0]) * D2R;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
function destPoint(pos, brg, dist) {
  const d = dist / R, t = brg * D2R, la1 = pos[1] * D2R, ln1 = pos[0] * D2R;
  const sinLa2 = Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(t);
  const la2 = Math.asin(sinLa2);
  const ln2 = ln1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * sinLa2);
  return [ln2 * R2D, la2 * R2D];
}
function lerpAngle(a, b, t) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

/* ---------------- data ---------------- */
const MAKES = {
  Toyota: ['Supra', 'Camry', 'Tacoma', 'GR86'], Honda: ['Civic', 'Accord', 'S2000', 'Prelude'],
  Ford: ['Mustang', 'F-150', 'Bronco'], Chevrolet: ['Corvette', 'Camaro', 'Silverado'],
  Dodge: ['Challenger', 'Charger'], Jeep: ['Wrangler', 'Gladiator'],
  Tesla: ['Model 3', 'Model Y', 'Cybertruck'], BMW: ['M3', 'M4', 'i4'],
  'Mercedes-Benz': ['C63 AMG', 'G-Wagon'], Audi: ['RS5', 'R8', 'e-tron GT'],
  Porsche: ['911', 'Cayman', 'Taycan'], Subaru: ['WRX STI', 'BRZ'],
  Mazda: ['MX-5 Miata', 'RX-7'], Nissan: ['GT-R', '370Z', 'Skyline'],
  Hyundai: ['Elantra N', 'Ioniq 5'], Kia: ['Stinger', 'EV6'],
  Lexus: ['IS350', 'LC500'], Acura: ['Integra', 'NSX'],
  Rivian: ['R1T'], Mini: ['Cooper S'], 'Land Rover': ['Defender']
};
const PAINTS = [
  ['Midnight Black', '#101218'], ['Glacier White', '#e9edf3'], ['Nardo Gray', '#7d8590'],
  ['Racing Red', '#e0342c'], ['Velocity Blue', '#2f6df6'], ['Miami Teal', '#19c2b8'],
  ['British Green', '#1f5d3f'], ['Sunset Orange', '#f0691f'], ['Phantom Purple', '#6d4cc4'],
  ['Champagne Gold', '#c9a96a'], ['Cyber Lime', '#a8e02a'], ['Rose Quartz', '#e8a0b8'],
  ['Arctic Silver', '#c4ccd6'], ['Lava Copper', '#b4552d']
];
const FINISHES = ['Gloss', 'Matte', 'Metallic', 'Satin'];
const BODY_TYPES = ['Sedan', 'SUV', 'Coupe', 'Truck', 'Hatchback', 'Van', 'Convertible', 'Wagon'];
const TRANSMISSIONS = ['Automatic', 'Manual', 'CVT', 'Dual-Clutch'];
const DRIVETRAINS = ['FWD', 'RWD', 'AWD'];
const ENGINE_SIZES = ['1.5L', '1.8L', '2.0L', '2.4L', '2.5L', '3.0L', '3.5L', '3.8L', '4.0L', '4.6L', '5.0L', '5.7L', '6.2L', 'Electric'];
const MODS = ['None', 'Tinted windows', 'Spoiler', 'Lowered', 'Exhaust', 'Aftermarket wheels', 'Widebody', 'Roof rack'];
const EXHAUST_NOTES = ['Stock', 'Deep rumble', 'High-pitched', 'Turbo whistle', 'Straight pipe', 'Quiet'];
const NAMES = ['Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Avery', 'Skyler',
  'Dakota', 'Reese', 'Emerson', 'Rowan', 'Phoenix', 'Sage', 'Kai', 'Nova', 'Luca', 'Mia',
  'Zoe', 'Leo', 'Ivy', 'Finn', 'Aria', 'Max', 'Ruby', 'Jude', 'Wren', 'Ezra', 'Lila',
  'Theo', 'Nina', 'Omar', 'Priya', 'Diego', 'Yuki', 'Amara', 'Mateo', 'Freya', 'Anders',
  'Talia', 'Marcus', 'Elena', 'Dante', 'Suki', 'Niko', 'Carmen', 'Jasper'];
const VIBES = ['Chill cruise', 'Road trip!', 'Night drive', 'Coffee run', 'Commute grind',
  'Scenic route', 'Lost (on purpose)', 'Snack hunt'];
// Rider insignia keys (0..7 → geometric glyphs rendered by the client).
const EMOJIS = [0, 1, 2, 3, 4, 5, 6, 7];
const CHAT_REPLIES = ['On my way', 'Copy that', "Let's roll", 'Right behind you',
  'Anyone need a fuel stop?', 'This route is smooth', 'Confirmed',
  "What's the ETA looking like?", 'Radio is clear', 'Cruise control engaged', 'Scenic mode on',
  'Watch for traffic up ahead', 'Moving out', 'Snack stop vote?'];
const CITIES = [
  ['Los Angeles', -118.2437, 34.0522], ['San Francisco', -122.4194, 37.7749],
  ['New York', -74.006, 40.7128], ['Chicago', -87.6298, 41.8781], ['Miami', -80.1918, 25.7617],
  ['Seattle', -122.3321, 47.6062], ['Austin', -97.7431, 30.2672], ['Denver', -104.9903, 39.7392],
  ['Toronto', -79.3832, 43.6532], ['Mexico City', -99.1332, 19.4326],
  ['São Paulo', -46.6333, -23.5505], ['Buenos Aires', -58.3816, -34.6037],
  ['London', -0.1276, 51.5072], ['Paris', 2.3522, 48.8566], ['Berlin', 13.405, 52.52],
  ['Madrid', -3.7038, 40.4168], ['Rome', 12.4964, 41.9028], ['Amsterdam', 4.9041, 52.3676],
  ['Stockholm', 18.0686, 59.3293], ['Istanbul', 28.9784, 41.0082], ['Dubai', 55.2708, 25.2048],
  ['Mumbai', 72.8777, 19.076], ['Delhi', 77.1025, 28.7041], ['Bangkok', 100.5018, 13.7563],
  ['Singapore', 103.8198, 1.3521], ['Jakarta', 106.8456, -6.2088],
  ['Hong Kong', 114.1694, 22.3193], ['Shanghai', 121.4737, 31.2304], ['Seoul', 126.978, 37.5665],
  ['Tokyo', 139.6917, 35.6895], ['Sydney', 151.2093, -33.8688], ['Melbourne', 144.9631, -37.8136],
  ['Auckland', 174.7633, -36.8485], ['Johannesburg', 28.0473, -26.2041],
  ['Cairo', 31.2357, 30.0444], ['Lagos', 3.3792, 6.5244], ['Nairobi', 36.8219, -1.2921],
  ['Honolulu', -157.8583, 21.3069], ['Reykjavík', -21.8174, 64.1265]
];
const DEFAULT_ANCHOR = [-118.2517, 34.048]; // LA, matches the client demo spawn

/* ---------------- bots ---------------- */
let seq = 0;

function makeBot(anchorPos) {
  const name = pick(NAMES);
  const make = pick(Object.keys(MAKES));
  const paint = pick(PAINTS);
  const engine = pick(ENGINE_SIZES);
  return {
    id: 'bot' + (++seq) + Math.random().toString(36).slice(2, 6),
    bot: true,
    name,
    handle: name.toLowerCase() + randInt(2, 99),
    emoji: pick(EMOJIS),
    vibe: pick(VIBES),
    car: {
      year: randInt(1995, 2026), make, model: pick(MAKES[make]),
      paint: paint[1], paintName: paint[0], finish: pick(FINISHES),
      body: pick(BODY_TYPES), engine,
      trans: pick(TRANSMISSIONS), drive: pick(DRIVETRAINS),
      hp: engine === 'Electric' ? randInt(200, 1000) : randInt(150, 750),
      mods: pick(MODS), exhaust: pick(EXHAUST_NOTES)
    },
    pos: destPoint(anchorPos, rand(0, 360), rand(300, 4200)),
    heading: rand(0, 360),
    speed: rand(7, 19),
    mode: chance(0.22) ? 'parked' : 'cruise',
    anchor: null,   // a human client record, or null → DEFAULT_ANCHOR
    party: null
  };
}

// One simulation step (dt seconds). leaderOf(bot) returns {pos,heading,slot} when convoying.
function stepBot(bot, dt, leaderInfo) {
  if (leaderInfo) {
    const trailBrg = (leaderInfo.heading + 180) % 360;
    let target = destPoint(leaderInfo.pos, trailBrg, 60 + 70 * (leaderInfo.slot + 1));
    target = destPoint(target, (leaderInfo.heading + 90) % 360, leaderInfo.slot % 2 === 0 ? 16 : -16);
    const d = haversine(bot.pos, target);
    if (d < 6) { bot.mode = 'cruise'; return; }
    bot.speed = clamp(d * 0.5, 3, d > 700 ? 60 : 34);
    bot.heading = lerpAngle(bot.heading, bearing(bot.pos, target), 0.55);
    bot.pos = destPoint(bot.pos, bot.heading, Math.min(bot.speed * dt, d));
    bot.mode = 'cruise';
    return;
  }

  const anchorPos = bot.anchor ? bot.anchor.pos : DEFAULT_ANCHOR;
  const d = haversine(bot.pos, anchorPos);
  if (d > 8000) { // human relocated far away — respawn nearby
    bot.pos = destPoint(anchorPos, rand(0, 360), rand(300, 4200));
    return;
  }
  if (bot.mode === 'parked') {
    if (chance(0.05)) bot.mode = 'cruise';
    return;
  }
  if (chance(0.02)) { bot.mode = 'parked'; return; }
  bot.heading = (bot.heading + rand(-22, 22) + 360) % 360;
  if (d > 5200) bot.heading = lerpAngle(bot.heading, bearing(bot.pos, anchorPos) + rand(-25, 25), 0.45);
  bot.speed = clamp(bot.speed + rand(-1.5, 1.5), 6, 21);
  bot.pos = destPoint(bot.pos, bot.heading, bot.speed * dt);
}

function nearestCity(pos) {
  let best = null, bestD = Infinity;
  for (const c of CITIES) {
    const d = haversine(pos, [c[1], c[2]]);
    if (d < bestD) { bestD = d; best = c[0]; }
  }
  return bestD < 300000 ? best : 'Somewhere out there';
}

// Ambient world dots so the global layer feels alive at any user count.
// Each is a persistent moving driver (pos/heading/speed) that wanders near its
// city, plus an `online` flag + `lastSeen` so stale drivers go offline and drop
// from the feed before coming back online after a while.
function makeAmbientGlobal() {
  const items = [];
  for (const c of CITIES) {
    const n = randInt(3, 7);
    for (let i = 0; i < n; i++) {
      const make = pick(Object.keys(MAKES));
      items.push({
        name: pick(NAMES) + ' ' + pick(['R.', 'K.', 'M.', 'T.', 'S.', 'J.']),
        emoji: pick(EMOJIS),
        car: randInt(1995, 2026) + ' ' + make + ' ' + pick(MAKES[make]),
        city: c[0],
        base: [c[1], c[2]],
        pos: destPoint([c[1], c[2]], rand(0, 360), rand(400, 9000)),
        heading: rand(0, 360),
        speed: rand(7, 19),
        online: true,
        lastSeen: Date.now() - randInt(0, 6) * 60000
      });
    }
  }
  return items;
}

// Advance one ambient driver by dt seconds. Wanders near its city; occasionally
// parks (going offline after a while) then comes back online.
function stepAmbient(a, dt) {
  const base = a.base;
  if (!a.online) {
    // offline: small chance per step to come back online near the city
    if (chance(0.04)) {
      a.online = true;
      a.lastSeen = Date.now();
      a.pos = destPoint(base, rand(0, 360), rand(400, 9000));
      a.heading = rand(0, 360);
      a.speed = rand(7, 19);
    }
    return;
  }
  const d = haversine(a.pos, base);
  if (d > 11000) { // drifted too far — respawn near the city, stay online
    a.pos = destPoint(base, rand(0, 360), rand(400, 9000));
    a.heading = rand(0, 360);
    return;
  }
  // a driver who's been live a long time goes offline (ended their session)
  if (Date.now() - a.lastSeen > randInt(8, 22) * 60000 && chance(0.03)) {
    a.online = false;
    return;
  }
  a.heading = (a.heading + rand(-22, 22) + 360) % 360;
  if (d > 9000) a.heading = lerpAngle(a.heading, bearing(a.pos, base) + rand(-25, 25), 0.45);
  a.speed = clamp(a.speed + rand(-1.5, 1.5), 6, 21);
  a.pos = destPoint(a.pos, a.heading, a.speed * dt);
  a.lastSeen = Date.now();
}

module.exports = {
  haversine, bearing, destPoint, lerpAngle, clamp, rand, randInt, pick, chance,
  CHAT_REPLIES, DEFAULT_ANCHOR,
  makeBot, stepBot, nearestCity, makeAmbientGlobal, stepAmbient
};

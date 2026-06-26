/* Convoy — static datasets (cars, paints, names, cities, chatter) */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  var MAKES = {
    'Toyota': ['Supra', 'Camry', 'Corolla', 'Tacoma', '4Runner', 'GR86'],
    'Honda': ['Civic', 'Accord', 'S2000', 'CR-V', 'Prelude'],
    'Ford': ['Mustang', 'F-150', 'Bronco', 'Focus RS', 'GT'],
    'Chevrolet': ['Corvette', 'Camaro', 'Silverado', 'Tahoe'],
    'Dodge': ['Challenger', 'Charger', 'Durango', 'Viper'],
    'Jeep': ['Wrangler', 'Grand Cherokee', 'Gladiator'],
    'Tesla': ['Model 3', 'Model Y', 'Model S', 'Cybertruck'],
    'BMW': ['M3', 'M4', '335i', 'X5', 'i4'],
    'Mercedes-Benz': ['C63 AMG', 'E350', 'G-Wagon', 'GLA'],
    'Audi': ['RS5', 'A4', 'Q5', 'R8', 'e-tron GT'],
    'Porsche': ['911', 'Cayman', 'Taycan', 'Macan'],
    'Volkswagen': ['Golf GTI', 'Jetta', 'ID.4', 'Beetle'],
    'Subaru': ['WRX STI', 'BRZ', 'Outback', 'Forester'],
    'Mazda': ['MX-5 Miata', 'Mazda3', 'RX-7', 'CX-5'],
    'Nissan': ['GT-R', '370Z', 'Altima', 'Frontier', 'Skyline'],
    'Hyundai': ['Elantra N', 'Ioniq 5', 'Santa Fe'],
    'Kia': ['Stinger', 'EV6', 'Telluride'],
    'Lexus': ['IS350', 'RX', 'LC500'],
    'Acura': ['Integra', 'NSX', 'TLX'],
    'Rivian': ['R1T', 'R1S'],
    'Lucid': ['Air'],
    'Mini': ['Cooper S', 'Countryman'],
    'Land Rover': ['Defender', 'Range Rover']
  };

  var PAINTS = [
    { name: 'Midnight Black', hex: '#101218' },
    { name: 'Glacier White', hex: '#e9edf3' },
    { name: 'Nardo Gray', hex: '#7d8590' },
    { name: 'Racing Red', hex: '#e0342c' },
    { name: 'Velocity Blue', hex: '#2f6df6' },
    { name: 'Miami Teal', hex: '#19c2b8' },
    { name: 'British Green', hex: '#1f5d3f' },
    { name: 'Sunset Orange', hex: '#f0691f' },
    { name: 'Phantom Purple', hex: '#6d4cc4' },
    { name: 'Champagne Gold', hex: '#c9a96a' },
    { name: 'Cyber Lime', hex: '#a8e02a' },
    { name: 'Rose Quartz', hex: '#e8a0b8' },
    { name: 'Arctic Silver', hex: '#c4ccd6' },
    { name: 'Lava Copper', hex: '#b4552d' }
  ];

  var FINISHES = ['Gloss', 'Matte', 'Metallic', 'Satin'];

  var BODY_TYPES = ['Sedan', 'SUV', 'Coupe', 'Truck', 'Hatchback', 'Van', 'Convertible', 'Wagon'];
  var TRANSMISSIONS = ['Automatic', 'Manual', 'CVT', 'Dual-Clutch'];
  var DRIVETRAINS = ['FWD', 'RWD', 'AWD'];
  var ENGINE_SIZES = ['1.5L', '1.8L', '2.0L', '2.4L', '2.5L', '3.0L', '3.5L', '3.8L', '4.0L', '4.6L', '5.0L', '5.7L', '6.2L', 'Electric'];
  var MODS = ['None', 'Tinted windows', 'Spoiler', 'Lowered', 'Exhaust', 'Aftermarket wheels', 'Widebody', 'Roof rack'];
  var EXHAUST_NOTES = ['Stock', 'Deep rumble', 'High-pitched', 'Turbo whistle', 'Straight pipe', 'Quiet'];

  var NAMES = ['Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Avery', 'Skyler',
    'Dakota', 'Reese', 'Emerson', 'Rowan', 'Phoenix', 'Sage', 'Kai', 'Nova', 'Luca', 'Mia',
    'Zoe', 'Leo', 'Ivy', 'Finn', 'Aria', 'Max', 'Ruby', 'Jude', 'Wren', 'Ezra', 'Lila',
    'Theo', 'Nina', 'Omar', 'Priya', 'Diego', 'Yuki', 'Amara', 'Mateo', 'Freya', 'Anders',
    'Talia', 'Marcus', 'Elena', 'Dante', 'Suki', 'Niko', 'Carmen', 'Jasper'];

  var VIBES = ['Chill cruise', 'Road trip', 'Night drive', 'Coffee run', 'Commute grind',
    'Scenic route', 'Cruise control', 'Snack hunt'];

  // Rider insignia keys (0..7 → geometric glyphs, see util.riderIcon).
  var EMOJIS = [0, 1, 2, 3, 4, 5, 6, 7];

  // [name, lng, lat]
  var CITIES = [
    ['Los Angeles', -118.2437, 34.0522], ['San Francisco', -122.4194, 37.7749],
    ['New York', -74.006, 40.7128], ['Chicago', -87.6298, 41.8781],
    ['Miami', -80.1918, 25.7617], ['Seattle', -122.3321, 47.6062],
    ['Austin', -97.7431, 30.2672], ['Denver', -104.9903, 39.7392],
    ['Toronto', -79.3832, 43.6532], ['Mexico City', -99.1332, 19.4326],
    ['São Paulo', -46.6333, -23.5505], ['Buenos Aires', -58.3816, -34.6037],
    ['London', -0.1276, 51.5072], ['Paris', 2.3522, 48.8566],
    ['Berlin', 13.405, 52.52], ['Madrid', -3.7038, 40.4168],
    ['Rome', 12.4964, 41.9028], ['Amsterdam', 4.9041, 52.3676],
    ['Stockholm', 18.0686, 59.3293], ['Istanbul', 28.9784, 41.0082],
    ['Dubai', 55.2708, 25.2048], ['Mumbai', 72.8777, 19.076],
    ['Delhi', 77.1025, 28.7041], ['Bangkok', 100.5018, 13.7563],
    ['Singapore', 103.8198, 1.3521], ['Jakarta', 106.8456, -6.2088],
    ['Hong Kong', 114.1694, 22.3193], ['Shanghai', 121.4737, 31.2304],
    ['Seoul', 126.978, 37.5665], ['Tokyo', 139.6917, 35.6895],
    ['Sydney', 151.2093, -33.8688], ['Melbourne', 144.9631, -37.8136],
    ['Auckland', 174.7633, -36.8485], ['Johannesburg', 28.0473, -26.2041],
    ['Cairo', 31.2357, 30.0444], ['Lagos', 3.3792, 6.5244],
    ['Nairobi', 36.8219, -1.2921], ['Honolulu', -157.8583, 21.3069],
    ['Reykjavík', -21.8174, 64.1265]
  ];

  var CHAT_REPLIES = ['On my way', 'Copy that', "Let's roll", 'Right behind you',
    'Anyone need a fuel stop?', 'This route is smooth', 'Confirmed',
    "What's the ETA looking like?", 'Radio is clear', 'Cruise control engaged', 'Scenic mode on',
    'Watch for traffic up ahead', 'Moving out', 'Snack stop vote?',
    'Good driving weather today', 'My passenger is navigating, all good'];

  var CONVOY_NAMES = ['Midnight Run', 'Coastal Cruise', 'Taco Quest', 'Sunset Squad',
    'Highway Homies', 'The Long Way', 'Zero Chill Caravan', 'Gas Station Gourmets'];

  A.data = {
    MAKES: MAKES,
    MAKE_LIST: Object.keys(MAKES),
    PAINTS: PAINTS,
    FINISHES: FINISHES,
    BODY_TYPES: BODY_TYPES,
    TRANSMISSIONS: TRANSMISSIONS,
    DRIVETRAINS: DRIVETRAINS,
    ENGINE_SIZES: ENGINE_SIZES,
    MODS: MODS,
    EXHAUST_NOTES: EXHAUST_NOTES,
    NAMES: NAMES,
    VIBES: VIBES,
    EMOJIS: EMOJIS,
    CITIES: CITIES,
    CHAT_REPLIES: CHAT_REPLIES,
    CONVOY_NAMES: CONVOY_NAMES
  };
})();

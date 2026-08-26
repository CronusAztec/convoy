/* Convoy — theme engine + registry.

   Adding a theme is one registration call. Everything is optional except id/name;
   anything you leave out inherits the default dark design system in styles.css.

     A.themes.register({
       id: 'sunset',                   // saved into settings.theme, used as [data-theme="sunset"]
       name: 'Sunset',                 // label in Settings → Theme
       dark: true,                     // false for light-based themes (map/route contrast)
       accent: '#ff2bd6',              // picking the theme snaps the accent color to this
       fontsUrl: 'https://fonts.googleapis.com/css2?family=Monoton&display=swap',
       vars: { '--bg': '#12030f', '--font-disp': "'Monoton', sans-serif" },
       css: '[data-theme="sunset"] #hud-grid { display:none; }',  // extra rules — keep them scoped!
       map: {                          // basemap skin, used while Map style = Auto
         base: 'positron',             // which STYLES key in mapview.js to load
         colors: { land: '#f6e6f2', water: '#7ad', road: '#fff', ... } // see applyMapTheme
       }
     });

   The engine writes vars into an injected `[data-theme="<id>"] { ... }` block, so the
   normal CSS cascade does the theming — no per-element JS. Map recoloring walks the
   loaded basemap style and repaints its layers by category (water/park/road/labels/…),
   so one small palette skins any of the base styles. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  var REG = {};       // id -> theme def
  var ORDER = [];     // registration order — drives the Settings control
  var current = 'dark';

  function register(def) {
    if (!def || !def.id || own(REG, def.id)) return;
    REG[def.id] = def;
    ORDER.push(def.id);
  }

  // Own properties only. REG is a plain object, so a bare REG[id] also finds
  // inherited Object.prototype members ('constructor', 'toString', …), which
  // are truthy and would sail past the `|| REG.dark` fallback in apply().
  // themes.js binds no util alias, so the probe is local.
  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function get(id) { return own(REG, id) ? REG[id] : null; }
  function list() { return ORDER.map(function (id) { return REG[id]; }); }
  function isDark(id) {
    var def = get(id);
    if (def) return def.dark !== false;
    return id !== 'light';
  }

  /* ---------- CSS + font injection (once per theme) ---------- */
  function ensureCss(def) {
    if (!def.vars && !def.css) return; // built-ins live in styles.css
    var tagId = 'theme-css-' + def.id;
    if (document.getElementById(tagId)) return;
    var rules = '';
    if (def.vars) {
      var body = Object.keys(def.vars).map(function (k) {
        return '  ' + k + ': ' + def.vars[k] + ';';
      }).join('\n');
      rules += '[data-theme="' + def.id + '"] {\n' + body + '\n}\n';
    }
    if (def.css) rules += def.css + '\n';
    var tag = document.createElement('style');
    tag.id = tagId;
    tag.textContent = rules;
    document.head.appendChild(tag);
  }

  function ensureFonts(def) {
    if (!def.fontsUrl) return;
    var tagId = 'theme-fonts-' + def.id;
    if (document.getElementById(tagId)) return;
    var link = document.createElement('link');
    link.id = tagId;
    link.rel = 'stylesheet';
    link.href = def.fontsUrl;
    document.head.appendChild(link);
  }

  /* Called by store.applyTheme with the resolved theme id. The data-theme attribute
     itself is set by the store; this just makes sure the theme's CSS/fonts exist. */
  function apply(id) {
    var def = get(id) || REG.dark;
    current = def ? def.id : 'dark';
    if (!def) return;
    ensureCss(def);
    ensureFonts(def);
  }

  /* ---------- basemap recolor engine ---------- */
  // Layers Convoy adds on top of the basemap — never repaint these.
  var SKIP = /^(route|convoy|global|radar|aircraft|police|space|hazard|wx|traffic)[-_]/;

  /* Repaint the loaded basemap with the current theme's map.colors palette.
     Runs on every style.load (mapview.ensureLayers) so it survives style switches.
     Only active while Map style = Auto — an explicit basemap pick wins.

     Palette keys (all optional except land/water/road):
       land, landAlt   — background + generic landuse fills
       park, wood      — greens (parks/grass vs forest)
       water, waterDark— water fills (waterDark: shadow/deep variants)
       building        — building fills / extrusions
       road, roadCasing— road fill + casing/outline lines
       roadMajor       — motorway/trunk fill (falls back to road)
       rail, boundary  — rail lines, admin boundaries
       text, halo      — label color + halo
       route           — the navigation line (theme GPS color; overrides the accent) */
  function applyMapTheme(map) {
    var def = REG[current];
    if (!map || !def || !def.map || !def.map.colors) return;
    if (A.state && A.state.settings.mapStyle !== 'auto') return;
    var c = def.map.colors;
    var style;
    try { style = map.getStyle(); } catch (e) { return; }
    var layers = (style && style.layers) || [];

    function paint(ly, prop, val) {
      if (val == null) return;
      try { map.setPaintProperty(ly.id, prop, val); } catch (e) { /* prop not valid for this layer — fine */ }
    }

    layers.forEach(function (ly) {
      if (SKIP.test(ly.id)) return;
      var id = ly.id.toLowerCase();
      if (ly.type === 'background') {
        paint(ly, 'background-color', c.land);
      } else if (ly.type === 'fill') {
        if (/water|ocean|river|lake/.test(id)) {
          paint(ly, 'fill-color', /shadow|deep/.test(id) ? (c.waterDark || c.water) : c.water);
        } else if (/park|grass|green|wood|forest|landcover|cemet|golf|pitch|garden|zoo/.test(id)) {
          paint(ly, 'fill-color', /wood|forest/.test(id) ? (c.wood || c.park) : c.park);
        } else if (/building/.test(id)) {
          paint(ly, 'fill-color', c.building);
          paint(ly, 'fill-outline-color', c.roadCasing);
        } else {
          paint(ly, 'fill-color', c.landAlt || c.land); // residential/aeroway/other landuse
        }
      } else if (ly.type === 'fill-extrusion') {
        paint(ly, 'fill-extrusion-color', c.building);
      } else if (ly.type === 'line') {
        if (/water|river|stream|canal/.test(id)) paint(ly, 'line-color', c.water);
        else if (/boundary|admin/.test(id)) paint(ly, 'line-color', c.boundary || c.roadCasing);
        else if (/rail|transit|ferry/.test(id)) paint(ly, 'line-color', c.rail || c.roadCasing);
        else if (/case|casing|outline/.test(id)) paint(ly, 'line-color', c.roadCasing);
        else if (/mot|trunk/.test(id)) paint(ly, 'line-color', c.roadMajor || c.road);
        else paint(ly, 'line-color', c.road); // road/bridge/tunnel/path bodies
      } else if (ly.type === 'symbol') {
        paint(ly, 'text-color', c.text);
        paint(ly, 'text-halo-color', c.halo);
      }
    });
  }

  /* Component reshape for transformative themes: strips the cyberpunk cut-corner
     clip-paths from every core component and re-rounds them, kills the scanline/
     grid overlays, and rounds toggles/chips into pills. Prepend the result to a
     theme's `css` and the whole app changes shape, not just color.
       reshapeCss('mytheme', 18)  → CSS scoped to [data-theme="mytheme"] */
  function reshapeCss(id, r) {
    var s = '[data-theme="' + id + '"] ';
    return [
      s + '.chip, ' + s + '.dock-btn, ' + s + '.btn, ' + s + '.toast, ' + s + '#dock, ' +
      s + '.panel, ' + s + '.eta-card, ' + s + '.modal-card { clip-path: none; }',
      s + '.chip { border-radius: 999px; }',
      s + '.btn, ' + s + '.dock-btn, ' + s + '.toast { border-radius: ' + Math.round(r * 0.7) + 'px; }',
      s + '#dock, ' + s + '.panel, ' + s + '.eta-card, ' + s + '.modal-card, ' + s + '.glass, ' +
      s + '.speedo { border-radius: ' + r + 'px; }',
      s + '.ctl { border-radius: ' + Math.round(r * 0.6) + 'px; }',
      s + '.toggle { border-radius: 999px; }',
      s + '.toggle .knob { border-radius: 50%; }',
      s + '#hud-scan, ' + s + '#hud-grid { display: none; }'
    ].join('\n');
  }

  /* ============================== built-in themes ============================== */

  // The default design system — all vars live in styles.css :root.
  register({ id: 'dark', name: 'Dark', dark: true });

  // Bright variant — vars live in styles.css [data-theme="light"].
  register({ id: 'light', name: 'Light', dark: false });

  /* GTA V — Los Santos.
     UI: the pause-menu look — near-black panels, sharp rectangles, no neon glow,
     condensed grotesque type (Oswald ≈ Chalet Comprimé, Archivo Narrow ≈ Chalet).
     Status colors are the game's HUD palette (green 114,204,114 · gold 240,200,80 ·
     red 194,80,80); the accent is the money/Franklin green.
     Map: the in-game GPS/pause map — charcoal land, gray streets, near-white
     freeways, near-black water, and the waypoint route in Rockstar's purple. */
  register({
    id: 'gta5',
    name: 'GTA V',
    dark: true,
    accent: '#72cc72',
    fontsUrl: 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Archivo+Narrow:wght@400;500;600;700&display=swap',
    vars: {
      '--bg': '#0d0d0d',
      '--bg-2': '#161616',
      '--surface': 'rgba(13, 13, 13, .82)',
      '--surface-2': 'rgba(28, 28, 28, .7)',
      '--surface-solid': '#161616',
      '--text': '#f2f2f2',
      '--text-dim': '#9c9c9c',
      '--line': 'rgba(255, 255, 255, .14)',
      '--line-strong': 'rgba(255, 255, 255, .3)',
      '--shadow': '0 10px 34px rgba(0, 0, 0, .7)',
      '--shadow-sm': '0 4px 14px rgba(0, 0, 0, .55)',
      '--good': '#72cc72',
      '--warn': '#f0c850',
      '--bad': '#c25050',
      /* Rockstar UI is hard rectangles — kill the rounding + corner cuts */
      '--radius': '3px',
      '--radius-sm': '2px',
      '--cut': '5px',
      '--font-body': "'Archivo Narrow', 'Chakra Petch', system-ui, sans-serif",
      '--font-disp': "'Oswald', 'Chakra Petch', system-ui, sans-serif",
      /* no neon bloom — flat shadows only (zero-size keeps composed box-shadows valid) */
      '--glow': '0 0 0 rgba(0, 0, 0, 0)',
      '--glow-sm': '0 0 0 rgba(0, 0, 0, 0)'
    },
    // GTA's HUD is clean — drop the cyberpunk scanlines + tech grid.
    css: '[data-theme="gta5"] #hud-scan, [data-theme="gta5"] #hud-grid { display: none; }',
    map: {
      // Voyager carries the most detail (buildings, parks, full road hierarchy) —
      // repainted below into the GTA GPS grays.
      base: 'voyager',
      colors: {
        land: '#191919',
        landAlt: '#1e1e1e',
        park: '#212420',
        wood: '#1e211d',
        water: '#101113',
        waterDark: '#0c0d0f',
        building: '#232323',
        road: '#8b8b8b',
        roadMajor: '#cfcfcf',
        roadCasing: '#0f0f0f',
        rail: '#2f2f2f',
        boundary: '#333333',
        text: '#c2c2c2',
        halo: 'rgba(10, 10, 10, .85)',
        route: '#a44cf2'   // HUD_COLOUR_WAYPOINT (164, 76, 242)
      }
    }
  });

  /* Cyberpunk — Night City. Black-on-yellow UI with hard angular cuts and
     Rajdhani type. Map: the in-game minimap — desaturated navy city, cool-gray
     streets, and the quest GPS in the signature #fcee0a yellow. */
  register({
    id: 'cyberpunk',
    name: 'Cyberpunk',
    dark: true,
    accent: '#fcee0a',
    fontsUrl: 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap',
    vars: {
      '--bg': '#0b0c10',
      '--bg-2': '#101218',
      '--surface': 'rgba(13, 15, 20, .8)',
      '--surface-2': 'rgba(22, 25, 33, .7)',
      '--surface-solid': '#12141b',
      '--text': '#dff3f7',
      '--text-dim': '#7f95a3',
      '--line': 'rgba(252, 238, 10, .16)',
      '--line-strong': 'rgba(252, 238, 10, .38)',
      '--good': '#02d7f2',
      '--warn': '#fcee0a',
      '--bad': '#ff003c',
      '--radius': '2px',
      '--radius-sm': '2px',
      '--cut': '12px',
      '--font-body': "'Rajdhani', 'Chakra Petch', system-ui, sans-serif",
      '--font-disp': "'Rajdhani', 'Chakra Petch', system-ui, sans-serif"
    },
    map: {
      base: 'voyager',
      colors: {
        land: '#0d0f14', landAlt: '#12151c',
        park: '#131d18', wood: '#101a14',
        water: '#0a2129', waterDark: '#071820',
        building: '#191d26',
        road: '#565e6e', roadMajor: '#9aa6b8', roadCasing: '#05070b',
        rail: '#2a2f3a', boundary: '#2e3442',
        text: '#9fb3c8', halo: 'rgba(5, 8, 12, .9)',
        route: '#fcee0a'
      }
    }
  });

  /* Vice — synthwave Miami. Deep-purple night, hot-magenta neon, teal ocean,
     Audiowide display type. The GPS line burns hot pink over the outrun grid. */
  register({
    id: 'vice',
    name: 'Vice',
    dark: true,
    accent: '#ff2bd6',
    fontsUrl: 'https://fonts.googleapis.com/css2?family=Audiowide&display=swap',
    vars: {
      '--bg': '#120b22',
      '--bg-2': '#1a1130',
      '--surface': 'rgba(24, 15, 44, .78)',
      '--surface-2': 'rgba(36, 23, 62, .66)',
      '--surface-solid': '#1c1233',
      '--text': '#f3e9ff',
      '--text-dim': '#9c8fc0',
      '--line': 'rgba(255, 43, 214, .18)',
      '--line-strong': 'rgba(255, 43, 214, .4)',
      '--good': '#2de2e6',
      '--warn': '#ff9f1c',
      '--bad': '#ff2b5e',
      '--font-disp': "'Audiowide', 'Chakra Petch', system-ui, sans-serif"
    },
    map: {
      base: 'voyager',
      colors: {
        land: '#150e28', landAlt: '#1a1230',
        park: '#142832', wood: '#101f28',
        water: '#0d2b3a', waterDark: '#092230',
        building: '#201636',
        road: '#6b5a9e', roadMajor: '#b06be0', roadCasing: '#0a0618',
        rail: '#2c2044', boundary: '#3a2b55',
        text: '#d9c8f0', halo: 'rgba(10, 5, 20, .9)',
        route: '#ff2bd6'
      }
    }
  });

  /* Tron — the Grid. Pure black world where every street is a dim light-line,
     freeways burn cyan, and the route is a white-hot light-cycle trail.
     Orbitron headers, hairline cyan borders. */
  register({
    id: 'tron',
    name: 'Tron',
    dark: true,
    accent: '#5fd8e8',
    fontsUrl: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&display=swap',
    vars: {
      '--bg': '#010409',
      '--bg-2': '#04090f',
      '--surface': 'rgba(2, 6, 10, .82)',
      '--surface-2': 'rgba(6, 14, 20, .7)',
      '--surface-solid': '#050b11',
      '--text': '#d8f7fd',
      '--text-dim': '#5f8f9c',
      '--line': 'rgba(95, 216, 232, .24)',
      '--line-strong': 'rgba(95, 216, 232, .5)',
      '--good': '#7df9ff',
      '--warn': '#ffa94d',
      '--bad': '#ff5a3c',
      '--radius': '2px',
      '--radius-sm': '1px',
      '--cut': '4px',
      '--font-disp': "'Orbitron', 'Chakra Petch', system-ui, sans-serif"
    },
    map: {
      base: 'voyager',
      colors: {
        land: '#02060a', landAlt: '#04090e',
        park: '#04120e', wood: '#030d0a',
        water: '#051d26', waterDark: '#03141b',
        building: '#071019',
        road: '#0f4a56', roadMajor: '#46cfe4', roadCasing: '#010204',
        rail: '#0a2c34', boundary: '#0e3742',
        text: '#9fe8f5', halo: 'rgba(0, 4, 8, .9)',
        route: '#dff9ff'
      }
    }
  });

  /* Pip-Boy — monochrome phosphor CRT. Everything green-on-black in mono type,
     scanlines cranked for the tube glass feel. Hazard red stays red so danger
     still reads as danger. No fontsUrl — Share Tech Mono ships with the app. */
  register({
    id: 'pipboy',
    name: 'Pip-Boy',
    dark: true,
    accent: '#2bff6f',
    vars: {
      '--bg': '#020a04',
      '--bg-2': '#04140a',
      '--surface': 'rgba(2, 12, 5, .84)',
      '--surface-2': 'rgba(5, 22, 11, .72)',
      '--surface-solid': '#04140a',
      '--text': '#9fffb3',
      '--text-dim': '#3f9f5f',
      '--line': 'rgba(51, 255, 102, .22)',
      '--line-strong': 'rgba(51, 255, 102, .45)',
      '--good': '#2bff6f',
      '--warn': '#ffcf40',
      '--bad': '#ff5a3c',
      '--radius': '2px',
      '--radius-sm': '1px',
      '--font-body': "'Share Tech Mono', ui-monospace, monospace",
      '--font-disp': "'Share Tech Mono', ui-monospace, monospace"
    },
    css: '[data-theme="pipboy"] #hud-scan { opacity: .95; }',
    map: {
      base: 'voyager',
      colors: {
        land: '#031407', landAlt: '#041a0a',
        park: '#0a2e14', wood: '#082611',
        water: '#06301c', waterDark: '#042415',
        building: '#0a2c16',
        road: '#1e7a3c', roadMajor: '#35d668', roadCasing: '#010803',
        rail: '#12522a', boundary: '#175f31',
        text: '#7dff9e', halo: 'rgba(0, 10, 4, .9)',
        route: '#66ffa1'
      }
    }
  });

  /* Zelda — Breath of the Wild / Sheikah Slate. Dark slate panels with glowing
     Sheikah-cyan tech lines, gold accents, Cinzel (Trajan-like, very Hyrule)
     headers over soft Quicksand body text, diamond bullets, everything softly
     rounded. Map: the parchment BotW world map — warm paper, brown trails with
     light casings, sage woods, teal water — with the hero-path route in cyan. */
  register({
    id: 'zelda',
    name: 'Zelda',
    dark: false, // the map is light parchment — route/glow contrast keys off this
    accent: '#62d8dc',
    fontsUrl: 'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Quicksand:wght@400;500;600;700&display=swap',
    vars: {
      '--bg': '#15181a',
      '--bg-2': '#1c2023',
      '--surface': 'rgba(22, 26, 28, .82)',
      '--surface-2': 'rgba(34, 39, 42, .7)',
      '--surface-solid': '#1d2124',
      '--text': '#e8e6d8',
      '--text-dim': '#96948a',
      '--line': 'rgba(98, 216, 220, .22)',
      '--line-strong': 'rgba(98, 216, 220, .45)',
      '--good': '#7ec850',
      '--warn': '#d8b64a',
      '--bad': '#e05a4e',
      '--radius': '14px',
      '--radius-sm': '10px',
      '--cut': '0px',
      '--font-body': "'Quicksand', 'Chakra Petch', system-ui, sans-serif",
      '--font-disp': "'Cinzel', 'Chakra Petch', serif",
      '--glow': '0 0 16px rgba(98, 216, 220, .3)',
      '--glow-sm': '0 0 9px rgba(98, 216, 220, .3)',
      '--shadow': '0 12px 40px rgba(0, 0, 0, .55)',
      '--shadow-sm': '0 5px 18px rgba(0, 0, 0, .4)'
    },
    css: reshapeCss('zelda', 16) + '\n' +
      /* Sheikah double-line panels + diamond section bullets + spaced serif brand */
      '[data-theme="zelda"] .panel, [data-theme="zelda"] .eta-card, [data-theme="zelda"] #dock, [data-theme="zelda"] .modal-card {\n' +
      '  box-shadow: 0 12px 40px rgba(0, 0, 0, .55), inset 0 0 0 1px rgba(98, 216, 220, .14);\n' +
      '}\n' +
      '[data-theme="zelda"] .section-label::before { transform: translateY(-50%) rotate(45deg); }\n' +
      '[data-theme="zelda"] .brand-name { letter-spacing: .3em; }\n' +
      '[data-theme="zelda"] .eta-dest { letter-spacing: .08em; }',
    map: {
      base: 'voyager',
      colors: {
        land: '#e7dcbb', landAlt: '#ded2ad',
        park: '#c2cf9b', wood: '#adc188',
        water: '#93bfb7', waterDark: '#7fb0a7',
        building: '#d4c79e',
        road: '#8b7a55', roadMajor: '#6b5c3e', roadCasing: '#efe6c8',
        rail: '#a3936d', boundary: '#a3936d',
        text: '#4a4232', halo: 'rgba(240, 233, 208, .92)',
        route: '#28b5c0'
      }
    }
  });

  /* Toon — Saturday-morning comic book. Cream paper, thick ink borders, hard
     offset shadows (no blur anywhere), Bangers headlines with Comic Neue body,
     buttons that physically press down. Map: flat saturated cartoon colors with
     black-outlined white roads and yellow highways. */
  register({
    id: 'toon',
    name: 'Toon',
    dark: false,
    accent: '#ff6b35',
    fontsUrl: 'https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@400;700&display=swap',
    vars: {
      '--bg': '#fdf3e0',
      '--bg-2': '#f7e9cf',
      '--surface': 'rgba(255, 252, 244, .96)',
      '--surface-2': 'rgba(250, 241, 222, .92)',
      '--surface-solid': '#fffcf4',
      '--text': '#181410',
      '--text-dim': '#6b5f52',
      '--line': 'rgba(24, 20, 16, .85)',
      '--line-strong': 'rgba(24, 20, 16, .95)',
      '--good': '#2ec4b6',
      '--warn': '#ffbf1f',
      '--bad': '#e63946',
      '--radius': '12px',
      '--radius-sm': '9px',
      '--cut': '0px',
      '--font-body': "'Comic Neue', 'Chakra Petch', sans-serif",
      '--font-disp': "'Bangers', 'Chakra Petch', sans-serif",
      '--glow': '0 0 0 rgba(0, 0, 0, 0)',
      '--glow-sm': '0 0 0 rgba(0, 0, 0, 0)',
      '--shadow': '6px 6px 0 rgba(24, 20, 16, .85)',
      '--shadow-sm': '4px 4px 0 rgba(24, 20, 16, .85)'
    },
    css: reshapeCss('toon', 14) + '\n' +
      /* ink outlines everywhere, no glass blur, buttons press down on tap */
      '[data-theme="toon"] .glass, [data-theme="toon"] .chip, [data-theme="toon"] .ctl,\n' +
      '[data-theme="toon"] .panel, [data-theme="toon"] #dock, [data-theme="toon"] .eta-card,\n' +
      '[data-theme="toon"] .toast, [data-theme="toon"] .btn, [data-theme="toon"] .modal-card,\n' +
      '[data-theme="toon"] .speedo, [data-theme="toon"] #search-input {\n' +
      '  border: 2px solid #181410;\n' +
      '  backdrop-filter: none; -webkit-backdrop-filter: none;\n' +
      '}\n' +
      '[data-theme="toon"] .btn:active, [data-theme="toon"] .ctl:active {\n' +
      '  transform: translate(2px, 2px); box-shadow: none;\n' +
      '}\n' +
      '[data-theme="toon"] .brand-name { font-size: 17px; letter-spacing: .12em; }\n' +
      '[data-theme="toon"] .eta-dest { letter-spacing: .06em; font-size: 17px; }',
    map: {
      base: 'voyager',
      colors: {
        land: '#fbe8b6', landAlt: '#f6dfa4',
        park: '#8fd85e', wood: '#6fc94a',
        water: '#57c7f2', waterDark: '#3fb5e5',
        building: '#f0d18e',
        road: '#ffffff', roadMajor: '#ffd23f', roadCasing: '#22201c',
        rail: '#8a8272', boundary: '#8a8272',
        text: '#22201c', halo: 'rgba(255, 255, 255, .95)',
        route: '#ff477e'
      }
    }
  });

  /* Frost — frosted-glass minimalism. Airy off-white world, heavy backdrop blur,
     hairline borders, big soft shadows, Inter type, system-blue accent. The
     opposite pole from the cyberpunk default: no glow, no grid, no vignette.
     Map: near-monochrome light with soft blue water and cream highways. */
  register({
    id: 'frost',
    name: 'Frost',
    dark: false,
    accent: '#0a84ff',
    fontsUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    vars: {
      '--bg': '#e9edf3',
      '--bg-2': '#f2f5f9',
      '--surface': 'rgba(255, 255, 255, .62)',
      '--surface-2': 'rgba(255, 255, 255, .5)',
      '--surface-solid': '#f7f9fc',
      '--text': '#17181c',
      '--text-dim': '#75798a',
      '--line': 'rgba(20, 30, 50, .08)',
      '--line-strong': 'rgba(20, 30, 50, .18)',
      '--good': '#30d158',
      '--warn': '#ff9f0a',
      '--bad': '#ff453a',
      '--radius': '18px',
      '--radius-sm': '14px',
      '--cut': '0px',
      '--font-body': "'Inter', 'Chakra Petch', system-ui, sans-serif",
      '--font-disp': "'Inter', 'Chakra Petch', system-ui, sans-serif",
      '--glow': '0 0 0 rgba(0, 0, 0, 0)',
      '--glow-sm': '0 0 0 rgba(0, 0, 0, 0)',
      '--shadow': '0 18px 50px rgba(30, 40, 70, .14)',
      '--shadow-sm': '0 6px 22px rgba(30, 40, 70, .1)'
    },
    css: reshapeCss('frost', 20) + '\n' +
      '[data-theme="frost"] .glass, [data-theme="frost"] .panel, [data-theme="frost"] #dock,\n' +
      '[data-theme="frost"] .eta-card, [data-theme="frost"] .chip, [data-theme="frost"] .ctl,\n' +
      '[data-theme="frost"] .toast, [data-theme="frost"] .modal-card, [data-theme="frost"] .speedo {\n' +
      '  backdrop-filter: blur(28px) saturate(180%); -webkit-backdrop-filter: blur(28px) saturate(180%);\n' +
      '}\n' +
      '[data-theme="frost"] #hud-vignette { display: none; }\n' +
      '[data-theme="frost"] .section-label::before { border-radius: 50%; }\n' +
      /* white text on the blue accent (the default dark-on-accent is tuned for neon) */
      '[data-theme="frost"] .seg-btn.active, [data-theme="frost"] .panel-tab.active,\n' +
      '[data-theme="frost"] .ctl-accent, [data-theme="frost"] .speed-chip.active,\n' +
      '[data-theme="frost"] .dock-badge { color: #fff; }',
    map: {
      base: 'voyager',
      colors: {
        land: '#f2f3f5', landAlt: '#eaecef',
        park: '#d5e8d0', wood: '#c6ddc0',
        water: '#b9d6ee', waterDark: '#a8c9e6',
        building: '#e3e5e9',
        road: '#ffffff', roadMajor: '#f9e9c0', roadCasing: '#d8dbe0',
        rail: '#d0d3d9', boundary: '#c6cad2',
        text: '#75798a', halo: 'rgba(255, 255, 255, .94)',
        route: '#0a84ff'
      }
    }
  });

  /* ============================== custom theme ============================== */
  /* Build-your-own theme: the user picks six colors in Settings and the engine
     derives a full theme from them — panel shades, readable text, hairlines from
     the accent, and a complete basemap palette. Persisted in localStorage and
     registered on every boot so 'Custom' is always in the picker. */
  var CUSTOM_KEY = 'convoy.customTheme.v1';
  var CUSTOM_SEED = {
    accent: '#ff8c1a', bg: '#141210', land: '#1a1713',
    road: '#8a7f6d', water: '#12222a', route: '#ff8c1a'
  };

  function hexRgb(h) { return (A.util && A.util.hexToRgb) ? A.util.hexToRgb(h) : [0, 0, 0]; }
  function rgbaOf(hex, a) { var c = hexRgb(hex); return 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + a + ')'; }
  // f > 0 lightens toward white, f < 0 darkens toward black.
  function shade(hex, f) {
    var c = hexRgb(hex);
    var to = f >= 0 ? 255 : 0, t = Math.abs(f);
    function ch(v) { return Math.round(v + (to - v) * t); }
    var n = (ch(c[0]) << 16) | (ch(c[1]) << 8) | ch(c[2]);
    return '#' + ('000000' + n.toString(16)).slice(-6);
  }
  function mix(hexA, hexB, t) {
    var a = hexRgb(hexA), b = hexRgb(hexB);
    function ch(i) { return Math.round(a[i] + (b[i] - a[i]) * t); }
    var n = (ch(0) << 16) | (ch(1) << 8) | ch(2);
    return '#' + ('000000' + n.toString(16)).slice(-6);
  }

  function buildCustomDef(cfg) {
    var dark = A.util ? A.util.luma(cfg.bg) < 128 : true;
    return {
      id: 'custom',
      name: 'Custom',
      dark: dark,
      accent: cfg.accent,
      _cfg: cfg, // kept so the Settings builder can prefill its pickers
      vars: {
        '--bg': cfg.bg,
        '--bg-2': shade(cfg.bg, dark ? 0.06 : -0.05),
        '--surface': rgbaOf(shade(cfg.bg, dark ? 0.04 : 0.3), 0.8),
        '--surface-2': rgbaOf(shade(cfg.bg, dark ? 0.12 : 0.15), 0.68),
        '--surface-solid': shade(cfg.bg, dark ? 0.08 : 0.2),
        '--text': dark ? '#eef2f5' : '#12161b',
        '--text-dim': dark ? '#8f9aa6' : '#4c5866',
        '--line': rgbaOf(cfg.accent, 0.2),
        '--line-strong': rgbaOf(cfg.accent, 0.42),
        '--good': '#00ff9c',
        '--warn': '#ffb000',
        '--bad': '#ff2b5e'
      },
      map: {
        base: 'voyager',
        colors: {
          land: cfg.land,
          landAlt: shade(cfg.land, dark ? 0.05 : -0.04),
          park: mix(cfg.land, dark ? '#2f8f4a' : '#7fbf6a', 0.3),
          wood: mix(cfg.land, dark ? '#256f3a' : '#639f55', 0.25),
          water: cfg.water,
          waterDark: shade(cfg.water, -0.2),
          building: shade(cfg.land, dark ? 0.1 : -0.08),
          road: cfg.road,
          roadMajor: shade(cfg.road, dark ? 0.4 : -0.2),
          roadCasing: shade(cfg.land, dark ? -0.4 : -0.25),
          rail: shade(cfg.land, dark ? 0.18 : -0.15),
          boundary: shade(cfg.land, dark ? 0.25 : -0.2),
          text: dark ? '#c6ccd4' : '#3c434b',
          halo: rgbaOf(shade(cfg.land, dark ? -0.5 : 0.55), 0.9),
          route: cfg.route
        }
      }
    };
  }

  function loadCustomCfg() {
    try {
      var raw = localStorage.getItem(CUSTOM_KEY);
      if (raw) return Object.assign({}, CUSTOM_SEED, JSON.parse(raw));
    } catch (e) { }
    return Object.assign({}, CUSTOM_SEED);
  }

  // Save + rebuild the custom theme. The caller applies it (ST.setTheme('custom')).
  function setCustom(cfg) {
    cfg = Object.assign(loadCustomCfg(), cfg);
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(cfg)); } catch (e) { }
    var def = buildCustomDef(cfg);
    REG.custom = def;
    var tag = document.getElementById('theme-css-custom');
    if (tag) tag.parentNode.removeChild(tag); // stale block — apply() re-injects
    if (current === 'custom') {
      ensureCss(def);
      // Editing the custom background can take the panels from dark to light
      // without any theme CHANGE, so applyTheme never runs. Re-measure here or
      // the safety-warning ink stays keyed to the brightness it had before the
      // edit — see store.applyUiBrightness.
      if (A.store && A.store.applyUiBrightness) A.store.applyUiBrightness();
    }
    return def;
  }

  register(buildCustomDef(loadCustomCfg()));

  /* The active theme's GPS route color (map.colors.route), or null to use the accent.
     Theme-level, not basemap-level — a GTA purple waypoint line stays purple on
     any basemap, just like the game. */
  function routeColor() {
    var m = REG[current] && REG[current].map;
    return (m && m.colors && m.colors.route) || null;
  }

  A.themes = {
    register: register,
    get: get,
    list: list,
    isDark: isDark,
    apply: apply,
    applyMapTheme: applyMapTheme,
    routeColor: routeColor,
    setCustom: setCustom,
    getCustomCfg: loadCustomCfg
  };
})();

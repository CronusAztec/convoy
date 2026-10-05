/* Convoy — overlays pack: the "Map overlays" settings section, through
   A.ui.addHook('settings'). Rendered only while the account holds the pack
   (the core rebuilds Settings on every open, so a pack that arrives later
   simply appears). The traffic row says so when the server has no key. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, U = A.util, ST = A.store;
  var PACK = 'overlays';

  A.ui.addHook('settings', function (body, kit) {
    if (!(A.packs && A.packs.has(PACK)) || !A.overlays) return;
    var caps = A.overlays.caps();
    body.appendChild(U.el('div', 'section-label', 'Map overlays'));
    body.appendChild(kit.row('Weather', 'Live precipitation radar (RainViewer, no key)',
      kit.toggle(!!S.settings.showWeather, function (v) { ST.setSetting('showWeather', v, 'weather'); })));
    body.appendChild(kit.field('Radar color', kit.segmented([
      { label: 'Radar', value: 'rain' },
      { label: 'Blue', value: 'temp' },
      { label: 'Vivid', value: 'wind' }
    ], S.settings.weatherLayer, function (v) { ST.setSetting('weatherLayer', v, 'weatherlayer'); })));
    body.appendChild(kit.row('Traffic', 'Live flow heatmap' + (caps.traffic ? '' : ' (the server has no traffic key yet)'),
      kit.toggle(!!S.settings.showTraffic, function (v) { ST.setSetting('showTraffic', v, 'traffic'); })));
    body.appendChild(kit.row('Hazards', 'Weather, live incidents and rider-reported hazards as pins',
      kit.toggle(!!S.settings.showHazards, function (v) { ST.setSetting('showHazards', v, 'hazards'); })));
    body.appendChild(U.el('div', 'hint-card',
      'Radar tiles and weather conditions come from RainViewer and Open-Meteo for the area you are ' +
      'looking at; traffic and incidents from TomTom through our server. The ⚠ map control reports a ' +
      'hazard at your position to riders nearby.'));
  });

  A.packs.register(PACK, { init: function () { A.overlays.init(); } });
})();

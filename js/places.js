/* Convoy — saved places + parking pin.

   Saved places: star a destination from the ETA card; it shows up (with recents)
   in the search dropdown for one-tap re-routing. Stored locally.

   Parking pin: one remembered spot on the map. Drops automatically when a trip
   arrives (settings.autoParkPin), or manually from the Ⓟ map control. Tapping
   the control flies back to the car; the pin's popup offers navigate/clear. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var PLACES_KEY = 'convoy.places.v1';
  var PARK_KEY = 'convoy.parking.v1';
  var MAX_SAVED = 12;

  var saved = [];       // [{label, sub, lng, lat, t}]
  var park = null;      // {lng, lat, t} | null
  var parkMarker = null;
  var tripWasActive = false;

  /* ---------------- storage ---------------- */
  function load() {
    try { saved = JSON.parse(localStorage.getItem(PLACES_KEY) || '[]'); } catch (e) { saved = []; }
    try { park = JSON.parse(localStorage.getItem(PARK_KEY) || 'null'); } catch (e) { park = null; }
  }
  function persistPlaces() {
    try { localStorage.setItem(PLACES_KEY, JSON.stringify(saved)); } catch (e) { }
  }
  function persistPark() {
    try { localStorage.setItem(PARK_KEY, JSON.stringify(park)); } catch (e) { }
  }

  /* ---------------- saved places ---------------- */
  function keyOf(p) { return p.lng.toFixed(5) + ',' + p.lat.toFixed(5); }
  function findIdx(p) {
    for (var i = 0; i < saved.length; i++) if (keyOf(saved[i]) === keyOf(p)) return i;
    return -1;
  }
  function isSaved(p) { return !!p && typeof p.lng === 'number' && findIdx(p) >= 0; }

  // Toggle a place in/out of favorites. Returns true when it is now saved.
  function toggleSave(p) {
    var i = findIdx(p);
    if (i >= 0) saved.splice(i, 1);
    else {
      saved.unshift({ label: p.label, sub: p.sub || 'Saved place', lng: p.lng, lat: p.lat, t: Date.now() });
      saved = saved.slice(0, MAX_SAVED);
    }
    persistPlaces();
    ST.emit('places');
    return i < 0;
  }

  /* ---------------- parking pin ---------------- */
  function parkEl() {
    var el = U.el('div', 'm-park');
    el.title = 'Your parked car';
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9 17.5V6.5h4.2a3.4 3.4 0 0 1 0 6.8H9"/></svg>';
    return el;
  }

  function showParkMarker() {
    removeParkMarker();
    if (!park || !A.mapview || !A.mapview.map()) return;
    var el = parkEl();
    el.addEventListener('click', function (e) { e.stopPropagation(); openParkPopup(); });
    parkMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([park.lng, park.lat]).addTo(A.mapview.map());
  }
  function removeParkMarker() {
    if (parkMarker) { parkMarker.remove(); parkMarker = null; }
  }

  function agoText(t) {
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' hr ago';
    return Math.floor(h / 24) + ' d ago';
  }

  var popupRef = null;
  function openParkPopup() {
    if (!park) return;
    closeParkPopup();
    var box = U.el('div', 'park-popup');
    box.innerHTML =
      '<b>Parked car</b><i>' + agoText(park.t) + '</i>' +
      '<div class="park-actions">' +
      '  <button class="btn btn-primary btn-small" id="park-nav">Walk back</button>' +
      '  <button class="btn btn-ghost btn-small" id="park-clear">Clear</button>' +
      '</div>';
    box.querySelector('#park-nav').addEventListener('click', function () {
      closeParkPopup();
      A.routing.setDestination([park.lng, park.lat], 'Parked car');
    });
    box.querySelector('#park-clear').addEventListener('click', function () {
      closeParkPopup();
      clearPark();
      A.ui.toast('Parking pin cleared', 'info');
    });
    popupRef = new maplibregl.Popup({ offset: 14, closeButton: false, maxWidth: '220px' })
      .setLngLat([park.lng, park.lat]).setDOMContent(box).addTo(A.mapview.map());
  }
  function closeParkPopup() {
    if (popupRef) { popupRef.remove(); popupRef = null; }
  }

  function setPark(pos) {
    park = { lng: pos[0], lat: pos[1], t: Date.now() };
    persistPark();
    showParkMarker();
    syncParkBtn();
  }
  function clearPark() {
    park = null;
    persistPark();
    removeParkMarker();
    closeParkPopup();
    syncParkBtn();
  }

  function syncParkBtn() {
    var btn = document.getElementById('ctl-park');
    if (btn) btn.classList.toggle('active', !!park);
  }

  // Ⓟ control: no pin → drop one here; pin exists → fly to it and open its popup.
  function onParkBtn() {
    if (!park) {
      var pos = A.sim.playerPos();
      if (!pos) return;
      setPark(pos);
      A.ui.toast('Parking pin dropped — tap Ⓟ to find your car later', 'success');
    } else {
      A.mapview.map().flyTo({ center: [park.lng, park.lat], zoom: Math.max(A.mapview.map().getZoom(), 15.5), duration: ST.dur(900) });
      openParkPopup();
    }
  }

  /* ---------------- init ---------------- */
  function init() {
    load();
    showParkMarker();
    syncParkBtn();
    var btn = document.getElementById('ctl-park');
    if (btn) btn.addEventListener('click', onParkBtn);

    // Auto parking pin: when a trip ends by ARRIVING (endTrip(true) clears the
    // route before emitting, so route==null distinguishes arrive from cancel),
    // remember where the car stopped.
    ST.on('trip', function (t) {
      if (t && t.active) { tripWasActive = true; return; }
      if (!t && tripWasActive) {
        tripWasActive = false;
        if (S.settings.autoParkPin && !S.route) {
          var pos = A.sim.playerPos();
          if (pos) {
            setPark(pos);
            A.ui.toast('Parking pin dropped at your destination', 'info');
          }
        }
      }
    });
  }

  A.places = {
    init: init,
    list: function () { return saved.slice(); },
    isSaved: isSaved,
    toggleSave: toggleSave,
    park: function () { return park; },
    setPark: setPark,
    clearPark: clearPark
  };
})();

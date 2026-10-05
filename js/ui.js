/* Convoy — UI layer: dock, panels, search, toasts, forms, onboarding */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store, D = A.data;

  var openName = null;
  var nearbyRefs = {};   // npcId -> {distEl, statusEl, btn}
  var convoyMemberRefs = {};

  /* ============================== toasts ============================== */
  function toast(msg, type) {
    var box = document.getElementById('toasts');
    var t = U.el('div', 'toast toast-' + (type || 'info'),
      '<span class="toast-dot"></span><span>' + U.esc(msg) + '</span>');
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    requestAnimationFrame(function () { t.classList.add('in'); });
    setTimeout(function () {
      t.classList.remove('in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 350);
    }, 3400);
  }

  /* ============================== panels & dock ============================== */
  var lastFocus = null; // element focused before a panel opened (restored on close)
  function openPanel(name) {
    document.querySelectorAll('.panel').forEach(function (p) {
      var open = p.dataset.panel === name;
      p.classList.toggle('open', open);
      p.setAttribute('aria-hidden', open ? 'false' : 'true');
      // Closed panels are translated off-screen at opacity:0, but opacity does not
      // remove a subtree from sequential focus navigation and pointer-events:none
      // only stops the mouse. Because panels are built lazily and never torn down,
      // a user who has opened all three leaves 133 invisible controls on the Tab
      // path between the dock and the map. inert removes them for keyboard and AT
      // alike; browsers without inert keep exactly today's behaviour.
      if (open) p.removeAttribute('inert'); else p.setAttribute('inert', '');
    });
    document.querySelectorAll('.dock-btn').forEach(function (b) {
      var active = b.dataset.dock === (name || 'map');
      b.classList.toggle('active', active);
      b.setAttribute('aria-expanded', active && !!name ? 'true' : 'false');
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    // Focus management: move focus into the panel header's close button on open
    // (a safe, always-present focus target), and restore the previous focus on close.
    if (name) {
      if (!lastFocus) lastFocus = document.activeElement;
      var panel = document.querySelector('.panel.open');
      var target = panel && panel.querySelector('.panel-close');
      if (target) target.focus();
    } else if (lastFocus) {
      try { lastFocus.focus(); } catch (e) {}
      lastFocus = null;
    }
    openName = name;
    // The screen a session ends on is the screen people quit from, so it is
    // worth knowing — the NAME only, never what is rendered on it.
    if (A.telemetry) A.telemetry.screen(name || 'map');
    if (name === 'nearby') renderNearby();
    if (name === 'convoy') renderConvoy();
    if (name === 'profile') {
      profileView = 'main'; // panel always reopens on the profile page (garage is a sub-page)
      // The main page (and the Settings box inside it, so toggles reflect the
      // current state) renders on the next microtask inside buildProfilePanel —
      // #settings-host does not exist until then, so it cannot be built here.
      buildProfilePanel();
    }
  }
  function closePanels() { openPanel(null); }

  // Settings "gear box" — a collapsible subsection inside the Profile panel,
  // opened by the gear button in the profile header (and its own header bar).
  function setGearbox(gb, open) {
    if (!gb) return;
    gb.classList.toggle('open', open);
    var head = gb.querySelector('.gearbox-head');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function toggleGearbox(forceOpen) {
    var gb = document.getElementById('gearbox');
    if (!gb) return;
    var willOpen = forceOpen != null ? forceOpen : !gb.classList.contains('open');
    setGearbox(gb, willOpen);
    if (!willOpen) return;
    var pbody = gb.closest ? gb.closest('.panel-body') : gb.parentNode;
    // Align the box to the top of the panel AFTER the 320ms expand finishes, so the
    // settings content (not just the "Settings" bar) lands in view. A direct panel-body
    // scroll is reliable here — scrollIntoView is flaky inside the fixed/transformed panel.
    setTimeout(function () {
      if (!pbody) return;
      var top = gb.getBoundingClientRect().top - pbody.getBoundingClientRect().top + pbody.scrollTop - 6;
      try { pbody.scrollTo({ top: top, behavior: S.settings.anim ? 'smooth' : 'auto' }); }
      catch (e) { pbody.scrollTop = top; }
    }, S.settings.anim ? 340 : 0);
  }

  function wireDock() {
    document.querySelectorAll('.dock-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.dataset.dock;
        if (name === 'map' || name === openName) closePanels();
        else openPanel(name);
      });
    });
    document.querySelectorAll('.panel-close').forEach(function (b) {
      b.addEventListener('click', closePanels);
    });
    // Backdrop click: a click landing on #onboarding itself (not a descendant
    // card) closes it — but only when the current occupant opted in via
    // overlayDismissable. The auth gate and the other blocking screens never do.
    var onboardingRoot = document.getElementById('onboarding');
    if (onboardingRoot) {
      onboardingRoot.addEventListener('click', function (e) {
        if (e.target === onboardingRoot && !onboardingRoot.hidden && overlayDismissable) closeOverlay();
      });
    }
    document.addEventListener('keydown', function (e) {
      var ob = document.getElementById('onboarding');
      var modalUp = ob && !ob.hidden;
      if (e.key === 'Tab' && modalUp) {
        var items = [].filter.call(ob.querySelectorAll(MODAL_FOCUSABLE), function (el) { return !el.disabled; });
        if (!items.length) { e.preventDefault(); return; }
        var first = items[0], last = items[items.length - 1];
        var cur = document.activeElement;
        if (!ob.contains(cur)) { e.preventDefault(); first.focus(); return; }
        if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key === 'Escape') {
        if (modalUp) { if (overlayDismissable) closeOverlay(); return; }
        closePanels(); A.mapview.closePopup();
        return;
      }
      if (e.key === '/' && !modalUp && document.activeElement &&
        !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault();
        document.getElementById('search-input').focus();
      }
    });
  }

  /* ============================== form helpers ============================== */
  var fieldSeq = 0;
  function mkField(label, child) {
    var w = U.el('div', 'field');
    var cid = child && child.id ? child.id : 'field-ctl-' + (++fieldSeq);
    if (child && child.setAttribute && !child.id) child.id = cid;
    w.innerHTML = '<label for="' + cid + '">' + U.esc(label) + '</label>';
    w.appendChild(child);
    return w;
  }

  function mkText(value, placeholder) {
    var i = U.el('input', 'input');
    i.type = 'text';
    i.value = value || '';
    i.placeholder = placeholder || '';
    i.spellcheck = false;
    i.maxLength = 24;
    return i;
  }

  function mkSelect(options, value) {
    var s = U.el('select', 'input select');
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if (String(o) === String(value)) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }

  // Select with a trailing 'Custom…' option that reveals a free-text input —
  // lets riders enter engines/mods that aren't in the preset list. Returns the
  // wrapper element with getValue()/setValue() (mirrors mkSegmented's API).
  var SELECT_CUSTOM = 'Custom…';
  function mkSelectCustom(options, value, placeholder, maxLen, onChange) {
    var w = U.el('div', 'select-custom');
    var s = mkSelect(options.concat([SELECT_CUSTOM]), value);
    var t = mkText('', placeholder || 'Type your own…');
    t.maxLength = maxLen || 24;
    t.hidden = true;
    w.appendChild(s);
    w.appendChild(t);
    w.getValue = function () {
      if (s.value !== SELECT_CUSTOM) return s.value;
      return t.value.trim() || options[0];
    };
    w.setValue = function (v) {
      v = v == null ? '' : String(v);
      var preset = options.some(function (o) { return String(o) === v; });
      if (preset || !v) { s.value = preset ? v : options[0]; t.value = ''; t.hidden = true; }
      else { s.value = SELECT_CUSTOM; t.value = v.slice(0, t.maxLength); t.hidden = false; }
    };
    s.addEventListener('change', function () {
      t.hidden = s.value !== SELECT_CUSTOM;
      if (!t.hidden) t.focus();
      if (onChange) onChange(w.getValue());
    });
    t.addEventListener('input', function () { if (onChange) onChange(w.getValue()); });
    w.setValue(value);
    return w;
  }

  function mkSegmented(options, value, onChange) {
    var w = U.el('div', 'segmented');
    options.forEach(function (o) {
      var b = U.el('button', 'seg-btn' + (o.value === value ? ' active' : ''), U.esc(o.label));
      b.type = 'button';
      b.dataset.value = o.value;
      b.addEventListener('click', function () {
        w.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        if (onChange) onChange(o.value);
      });
      w.appendChild(b);
    });
    w.getValue = function () {
      var a = w.querySelector('.seg-btn.active');
      return a ? a.dataset.value : value;
    };
    w.setValue = function (v) {
      w.querySelectorAll('.seg-btn').forEach(function (x) {
        x.classList.toggle('active', x.dataset.value === String(v));
      });
    };
    return w;
  }

  function mkToggle(checked, onChange) {
    var b = U.el('button', 'toggle' + (checked ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', checked ? 'true' : 'false');
    b.innerHTML = '<span class="knob"></span>';
    b.addEventListener('click', function () {
      b.classList.toggle('on');
      b.setAttribute('aria-checked', b.classList.contains('on') ? 'true' : 'false');
      if (onChange) onChange(b.classList.contains('on'));
    });
    return b;
  }

  // Drive a mkToggle from outside. Needed wherever the change can be refused
  // after the fact (a legality notice, a failed save): mkToggle flips itself on
  // click, so the only way back to the truth is to set it explicitly.
  function setToggle(btn, on) {
    if (!btn) return;
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function mkSwatches(paints, value, onChange) {
    var w = U.el('div', 'swatches');
    var custom;
    function setActive(hex) {
      w.querySelectorAll('.swatch').forEach(function (s) {
        s.classList.toggle('active', s.dataset.hex && s.dataset.hex.toLowerCase() === hex.toLowerCase());
      });
    }
    paints.forEach(function (p) {
      var s = U.el('button', 'swatch');
      s.type = 'button';
      s.title = p.name;
      s.dataset.hex = p.hex;
      s.style.background = p.hex;
      s.addEventListener('click', function () {
        setActive(p.hex);
        if (onChange) onChange(p.hex, p.name);
      });
      w.appendChild(s);
    });
    custom = U.el('label', 'swatch swatch-custom');
    custom.title = 'Custom color';
    custom.innerHTML = '<input type="color" value="' + U.safePaint(value) + '"/><span>+</span>';
    custom.querySelector('input').addEventListener('input', function (e) {
      setActive('');
      if (onChange) onChange(e.target.value, 'Custom');
    });
    w.appendChild(custom);
    setActive(value);
    w.setValue = setActive;
    return w;
  }

  // Rider insignia picker — buttons render geometric icons; value is a numeric key.
  function mkIconGrid(value, onChange) {
    var w = U.el('div', 'emoji-grid');
    var active = U.iconKey(value);
    for (var k = 0; k < U.ICON_COUNT; k++) {
      (function (key) {
        var b = U.el('button', 'emoji-btn' + (key === active ? ' active' : ''));
        b.type = 'button';
        b.dataset.key = String(key);
        b.innerHTML = U.riderIcon(key, { size: 18 });
        b.setAttribute('aria-label', 'Rider insignia ' + (key + 1));
        b.setAttribute('aria-pressed', String(key === active));
        b.addEventListener('click', function () {
          w.querySelectorAll('.emoji-btn').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
          b.classList.add('active');
          b.setAttribute('aria-pressed', 'true');
          if (onChange) onChange(key);
        });
        w.appendChild(b);
      }(k));
    }
    // Read the key off the button's dataset. This used to pass the BUTTON ELEMENT
    // to U.iconKey, which stringified it to "[object HTMLButtonElement]" and
    // hashed that — the same constant for every icon. Signup's avatar picker
    // therefore looked interactive but always saved one fixed glyph.
    w.getValue = function () {
      var a = w.querySelector('.emoji-btn.active');
      return a ? U.iconKey(a.dataset.key) : active;
    };
    return w;
  }
  // Back-compat alias for any leftover callers.
  var mkEmojiGrid = mkIconGrid;

  function yearList() {
    var ys = [];
    for (var y = 2026; y >= 1985; y--) ys.push(y);
    return ys;
  }

  /* ============================== nearby panel ============================== */
  var nearbyTab = 'nearby';
  var nearbyFilter = 'radius';      // radius | road | sight
  var nearbyShownIds = [];
  var NEARBY_RADIUS_M = 2000;       // radius-filter label only — geometry lives in sim.proximityMatch

  // Riders matching the active Nearby filter, relative to the driver's position
  // + heading. The actual geometry lives in A.sim.proximityMatch so the panel,
  // the map dot colors and proximity voice all agree on who is "around you".
  function filteredNearby() {
    return A.sim.getNearbySorted().filter(function (r) {
      return A.sim.proximityMatch(r.npc, nearbyFilter);
    });
  }

  function sameIdSet(a, b) {
    if (a.length !== b.length) return false;
    var s = Object.create(null);
    a.forEach(function (x) { s[x] = 1; });
    return b.every(function (x) { return s[x]; });
  }

  function renderNearby() {
    var body = document.getElementById('nearby-body');
    if (!body) return; // absent panel must not desync openName from the DOM
    body.innerHTML = '';
    nearbyRefs = {};

    var tabs = U.el('div', 'panel-tabs');
    var tN = U.el('button', 'panel-tab' + (nearbyTab === 'nearby' ? ' active' : ''), 'Nearby');
    var fb = S.friendReqs.length ? ' <em class="tab-badge">' + S.friendReqs.length + '</em>' : '';
    var tF = U.el('button', 'panel-tab' + (nearbyTab === 'friends' ? ' active' : ''), 'Friends' + fb);
    tN.addEventListener('click', function () { nearbyTab = 'nearby'; renderNearby(); });
    tF.addEventListener('click', function () { nearbyTab = 'friends'; renderNearby(); });
    tabs.appendChild(tN);
    tabs.appendChild(tF);
    body.appendChild(tabs);

    var content = U.el('div', 'tab-content');
    body.appendChild(content);

    if (nearbyTab === 'friends') renderFriendsInto(content);
    else renderNearbyListInto(content);
  }

  function renderNearbyListInto(content) {
    nearbyRefs = {};

    // filter selector: radius / same road / line-of-sight
    var seg = U.el('div', 'segmented nearby-filter');
    [['radius', 'Radius'], ['road', 'My road'], ['sight', 'In sight']].forEach(function (m) {
      var b = U.el('button', 'seg-btn' + (nearbyFilter === m[0] ? ' active' : ''), m[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        nearbyFilter = m[0];
        renderNearby();
        if (A.mapview && A.mapview.reclassifyMarkers) A.mapview.reclassifyMarkers();
      });
      seg.appendChild(b);
    });
    content.appendChild(seg);

    var rows = filteredNearby();
    nearbyShownIds = rows.map(function (r) { return r.npc.id; });
    var modeLabel = nearbyFilter === 'road' ? 'on your road'
      : nearbyFilter === 'sight' ? 'in sight ahead' : 'within ' + U.fmtDist(NEARBY_RADIUS_M, S.settings.units);
    document.getElementById('nearby-sub').textContent = rows.length + ' of ' + A.sim.count() + ' riders · ' + modeLabel;

    if (!rows.length) {
      var msg = nearbyFilter === 'road' ? 'No riders sharing your road right now.'
        : nearbyFilter === 'sight' ? 'Nothing in sight ahead. Try Radius.'
        : 'No riders within range right now.';
      content.appendChild(U.el('div', 'hint-card', msg));
      return;
    }

    rows.forEach(function (r) {
      var npc = r.npc;
      var row = U.el('div', 'row user-row');
      row.innerHTML =
        '<div class="u-ava" style="--paint:' + U.safePaint(npc.car.paint) + '">' + avaInner(npc, 20) + '</div>' +
        '<div class="u-info">' +
        '  <div class="u-name">' + U.esc(npc.name) + ' <span class="u-handle">@' + U.esc(npc.handle) + '</span></div>' +
        '  <div class="u-car">' + npc.car.year + ' ' + U.esc(npc.car.make) + ' ' + U.esc(npc.car.model) +
        (npc.car.trim ? ' ' + U.esc(npc.car.trim) : '') +
        '   <i class="paint-dot" style="background:' + U.safePaint(npc.car.paint) + '"></i></div>' +
        '</div>' +
        '<div class="u-side"><div class="u-dist"></div><div class="u-status"></div></div>';

      var btn = U.el('button', 'btn btn-small');
      row.appendChild(btn);

      // Tap the row → fly + popup; tap the avatar/name → Instagram-style profile.
      row.addEventListener('click', function (e) {
        if (e.target === btn) return;
        A.mapview.focusRider(npc.livePos || npc.pos);
        A.mapview.showNpcPopup(npc.id);
      });
      row.querySelector('.u-ava').addEventListener('click', function (e) {
        e.stopPropagation();
        openProfileOverlay(npc.id);
      });
      row.querySelector('.u-name').addEventListener('click', function (e) {
        e.stopPropagation();
        openProfileOverlay(npc.id);
      });
      btn.addEventListener('click', function () {
        if (!npc.member && !npc.invited) A.party.invite(npc.id);
      });

      content.appendChild(row);
      nearbyRefs[npc.id] = {
        distEl: row.querySelector('.u-dist'),
        statusEl: row.querySelector('.u-status'),
        btn: btn
      };
    });
    updateNearbyLive();
  }

  /* ----- friends tab ----- */
  function renderFriendsInto(content) {
    document.getElementById('nearby-sub').textContent = 'your network';
    if (!(A.auth && A.auth.isLoggedIn())) {
      var empty = U.el('div', 'convoy-hero');
      empty.innerHTML = '<div class="convoy-hero-art">' + U.riderIcon(5, { size: 44, stroke: 1.4 }) + '</div><h3>Friends need an account</h3>' +
        '<p>Sign in or create an account to add friends and see when they\'re online.</p>';
      var go = U.el('button', 'btn btn-primary btn-block', 'Create account / Log in');
      go.addEventListener('click', function () { closePanels(); showAuth(function () { location.reload(); }); });
      empty.appendChild(go);
      content.appendChild(empty);
      return;
    }

    var addWrap = U.el('div', 'friend-add');
    var addInput = mkText('', 'Add a friend by username'); addInput.maxLength = 20;
    var addBtn = U.el('button', 'icon-btn icon-btn-accent',
      '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>');
    var doAdd = function () { var u = addInput.value.trim(); if (u) { A.net.sendFriendAdd(u); addInput.value = ''; } };
    addBtn.addEventListener('click', doAdd);
    addInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd(); });
    addWrap.appendChild(addInput);
    addWrap.appendChild(addBtn);
    content.appendChild(addWrap);

    if (S.friendReqs.length) {
      content.appendChild(U.el('div', 'section-label', 'Requests · ' + S.friendReqs.length));
      S.friendReqs.forEach(function (rq) {
        var row = U.el('div', 'row friend-row');
        row.innerHTML =
          '<div class="u-ava" style="--paint:' + U.safePaint(rq.paint, '#888') + '">' + U.riderIcon(rq.emoji, { size: 20 }) + '</div>' +
          '<div class="u-info"><div class="u-name">' + U.esc(rq.name) + '</div>' +
          '<div class="u-handle">@' + U.esc(rq.username) + ' wants to be friends</div></div>';
        var side = U.el('div', 'friend-actions');
        var acc = U.el('button', 'btn btn-primary btn-small', 'Accept');
        acc.addEventListener('click', function () { A.net.sendFriendAccept(rq.id); });
        var dec = U.el('button', 'icon-btn icon-btn-sm', '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>');
        dec.title = 'Decline';
        dec.addEventListener('click', function () { A.net.sendFriendDecline(rq.id); });
        side.appendChild(acc);
        side.appendChild(dec);
        row.appendChild(side);
        content.appendChild(row);
      });
    }

    content.appendChild(U.el('div', 'section-label', 'Friends' + (S.friends.length ? ' · ' + S.friends.length : '')));
    if (!S.friends.length) {
      content.appendChild(U.el('div', 'hint-card', 'No friends yet. Add a username above.'));
      return;
    }
    var sorted = S.friends.slice().sort(function (a, b) {
      return (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name);
    });
    sorted.forEach(function (f) {
      var row = U.el('div', 'row friend-row');
      row.innerHTML =
        '<div class="u-ava" style="--paint:' + U.safePaint(f.paint, '#888') + '">' + U.riderIcon(f.emoji, { size: 20 }) +
        '<span class="online-dot' + (f.online ? ' on' : '') + '"></span></div>' +
        '<div class="u-info"><div class="u-name">' + U.esc(f.name) + '</div>' +
        '<div class="u-handle">@' + U.esc(f.username) + ' · ' +
        (f.online ? '<span class="online-text">online</span>' : 'offline') + '</div></div>';
      var side = U.el('div', 'friend-actions');
      var npc = A.sim.getByUsername(f.username);
      if (npc) {
        var loc = U.el('button', 'btn btn-small', 'Locate');
        loc.addEventListener('click', function () { A.mapview.focusRider(npc.livePos || npc.pos); A.mapview.showNpcPopup(npc.id); });
        side.appendChild(loc);
      }
      if (f.online) {
        var inv = U.el('button', 'btn btn-primary btn-small', 'Invite');
        inv.addEventListener('click', function () { A.net.sendInviteAccount(f.id); toast('Invited ' + f.name + ' to your convoy', 'info'); });
        side.appendChild(inv);
      }
      var rm = U.el('button', 'icon-btn icon-btn-sm', '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4.8h6V7M7.5 7l.8 12.2h7.4L16.5 7"/></svg>');
      rm.title = 'Remove friend';
      rm.addEventListener('click', function () { if (confirm('Remove ' + f.name + ' from friends?')) A.net.sendFriendRemove(f.id); });
      side.appendChild(rm);
      row.appendChild(side);
      content.appendChild(row);
    });
  }

  // Invisible mode: persist + notify the server. The map reaction (dimming the
  // player marker) and voice's proximity cut-off hang off the single 'ghost'
  // event the setter emits, so toggling does each piece of work exactly once.
  function applyGhost(on) {
    ST.setGhost(!!on);            // persists + emits 'ghost' → the listeners react
    if (A.net && A.net.sendGhost) A.net.sendGhost(!!on);
    A.ui.toast(on ? 'Invisible · only your convoy can see you' : 'Visible to riders again', 'info');
  }

  function updateGhostChip() {
    var chip = document.getElementById('chip-ghost');
    if (!chip) return;
    chip.hidden = !S.settings.ghost;
  }

  function buildGhostChip() {
    var bar = document.getElementById('chips');
    if (!bar || document.getElementById('chip-ghost')) return;
    var chip = U.el('button', 'chip chip-ghost');
    chip.id = 'chip-ghost';
    chip.type = 'button';
    chip.title = 'Invisible · only your convoy can see you. Tap to become visible';
    chip.innerHTML = '<span class="dot" style="background:#9b4dff;box-shadow:0 0 6px #9b4dff"></span><span>INVISIBLE</span>';
    chip.addEventListener('click', function () {
      applyGhost(!S.settings.ghost);
    });
    bar.appendChild(chip);
    chip.hidden = !S.settings.ghost;
  }

  function updateNearbyLive() {
    if (openName !== 'nearby' || nearbyTab !== 'nearby') return;
    var rows = filteredNearby();
    var ids = rows.map(function (r) { return r.npc.id; });
    if (!sameIdSet(ids, nearbyShownIds)) { renderNearby(); return; } // a rider entered/left the filter
    rows.forEach(function (r) {
      var ref = nearbyRefs[r.npc.id];
      if (!ref) return;
      ref.distEl.textContent = U.fmtDist(r.dist, S.settings.units);
      var st = r.npc.member ? 'In convoy' : (r.npc.mode === 'parked' ? 'Parked' : 'Cruising');
      ref.statusEl.textContent = st;
      ref.statusEl.className = 'u-status' + (r.npc.member ? ' in-convoy' : '');
      if (r.npc.member) { ref.btn.textContent = 'Joined ✓'; ref.btn.disabled = true; ref.btn.classList.remove('btn-primary'); }
      else if (r.npc.invited) { ref.btn.textContent = 'Invited…'; ref.btn.disabled = true; }
      else { ref.btn.textContent = 'Invite'; ref.btn.disabled = false; ref.btn.classList.add('btn-primary'); }
    });
  }

  /* ============================== convoy panel ============================== */
  function renderConvoy() {
    var body = document.getElementById('convoy-body');
    var sub = document.getElementById('convoy-sub');
    if (!body || !sub) return; // absent panel must not desync openName from the DOM
    body.innerHTML = '';
    convoyMemberRefs = {};

    if (!S.party) {
      sub.textContent = 'no active convoy';
      var hero = U.el('div', 'convoy-hero');
      hero.innerHTML =
        '<div class="convoy-hero-art">' + U.convoyFlag(0) + '</div>' +
        '<h3>Start a convoy</h3>' +
        '<p>Ride together in real time. Members appear on each other\'s map with a live link line.</p>';
      var nameInput = mkText('', U.pick((D.CONVOY_NAMES && D.CONVOY_NAMES.length) ? D.CONVOY_NAMES : A.party.FALLBACK_CONVOY_NAMES));
      var flagRow = U.el('div', 'emoji-row');
      var chosen = 0;
      for (var fi = 0; fi < 3; fi++) {
        (function (idx) {
          var b = U.el('button', 'emoji-btn' + (idx === 0 ? ' active' : ''));
          b.type = 'button';
          b.innerHTML = U.convoyFlag(idx);
          b.setAttribute('aria-label', 'Convoy flag ' + (idx + 1));
          b.setAttribute('aria-pressed', String(idx === 0));
          b.addEventListener('click', function () {
            flagRow.querySelectorAll('.emoji-btn').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
            b.classList.add('active');
            b.setAttribute('aria-pressed', 'true');
            chosen = idx;
          });
          flagRow.appendChild(b);
        }(fi));
      }
      var createBtn = U.el('button', 'btn btn-primary btn-block', 'Create convoy');
      createBtn.addEventListener('click', function () {
        // Trim like the join-code path below: whitespace-only must fall back
        // to the placeholder name, not create a convoy called "   ".
        A.party.create(nameInput.value.trim() || nameInput.placeholder, chosen);
      });
      hero.appendChild(mkField('Convoy name', nameInput));
      hero.appendChild(mkField('Flag', flagRow));
      hero.appendChild(createBtn);
      var tip = U.el('div', 'hint-card', 'Tap a car on the map or open <b>Nearby</b> to invite riders.');
      hero.appendChild(tip);

      if (A.net && A.net.isLive()) {
        hero.appendChild(U.el('div', 'auth-or', '<span>or join one</span>'));
        var codeInput = mkText('', 'Enter join code');
        codeInput.classList.add('code-input');
        var joinBtn = U.el('button', 'btn btn-block', 'Join by code');
        var doJoin = function () {
          var code = codeInput.value.trim();
          if (code) A.party.joinByCode(code);
        };
        joinBtn.addEventListener('click', doJoin);
        codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
        hero.appendChild(mkField('Join code', codeInput));
        hero.appendChild(joinBtn);
      }

      body.appendChild(hero);

      if (!D.CONVOY_NAMES) A.data.ensure().then(function () { if (openName === 'convoy') renderConvoy(); }).catch(function () {});
      return;
    }

    sub.textContent = S.party.members.length + ' riders linked';

    var head = U.el('div', 'convoy-head');
    head.innerHTML =
      '<div class="convoy-flag">' + U.convoyFlag(S.party.emoji) + '</div>' +
      '<div class="convoy-names"><div class="convoy-name">' + U.esc(S.party.name) + '</div>' +
      '<div class="convoy-count">' + (S.party.members.length + 1) + ' riders (incl. you)</div></div>';
    var leaveBtn = U.el('button', 'btn btn-ghost btn-small btn-danger-text', 'Leave');
    leaveBtn.addEventListener('click', function () { A.party.leave(); });
    head.appendChild(leaveBtn);
    body.appendChild(head);

    // "Where is everyone" as one button. It fits the whole convoy into a single
    // view, and when the group is too spread out for that to leave anyone
    // visible it says so and leans on the edge arrows instead of zooming out to
    // a map where nobody can be told apart.
    var fitBtn = U.el('button', 'btn btn-block btn-ghost', 'Fit the whole convoy on screen');
    fitBtn.addEventListener('click', function () {
      var pts = [];
      var me = A.sim && A.sim.playerPos && A.sim.playerPos();
      if (me) pts.push(me);
      S.party.members.forEach(function (id) {
        var npc = A.sim.getNpc(id);
        var p = npc && (npc.livePos || npc.pos);
        if (p) pts.push(p);
      });
      var r = A.mapview.fitRiders(pts);
      if (r.ok) { closePanels(); return; }
      if (r.reason === 'spread') {
        A.ui.toast('Riders are too far apart to fit — follow the edge arrows instead', 'info');
        if (S.settings.riderArrows === false) {
          ST.setSetting('riderArrows', true);
          if (A.riderarrows) A.riderarrows.refresh();
        }
        closePanels();
        return;
      }
      A.ui.toast('No rider positions yet', 'info');
    });
    body.appendChild(fitBtn);

    // SOS beacon: one tap tells the convoy chat you are stopped — for
    // breakdowns, flats, or losing the group. Your live pin shows them where.
    var sosBtn = U.el('button', 'btn btn-block btn-danger-text sos-btn', 'SOS · I\'m stopped and need help');
    sosBtn.addEventListener('click', function () {
      A.party.sendChat('🆘 I\'m stopped and need help. Check my pin on the map');
      sosBtn.textContent = 'SOS sent to your convoy';
      sosBtn.disabled = true;
      setTimeout(function () {
        sosBtn.textContent = 'SOS · I\'m stopped and need help';
        sosBtn.disabled = false;
      }, 8000);
    });
    body.appendChild(sosBtn);

    if (A.net && A.net.isLive()) {
      var privacy = U.el('div', 'convoy-privacy');
      var modeLabels = { invite: 'Invite-only', code: 'Open · anyone with the code', locked: 'Locked' };
      if (S.party.isLeader) {
        privacy.appendChild(mkField('Who can join', mkSegmented([
          { label: 'Invite', value: 'invite' },
          { label: 'Code', value: 'code' },
          { label: 'Locked', value: 'locked' }
        ], S.party.mode || 'invite', function (v) { A.party.setMode(v); })));
      } else {
        privacy.appendChild(U.el('div', 'privacy-label', (modeLabels[S.party.mode] || 'Invite-only')));
      }
      if (S.party.mode === 'code' && S.party.code) {
        var codeBox = U.el('div', 'join-code-box');
        codeBox.innerHTML = '<div class="jc-text"><span class="jc-label">Join code</span>' +
          '<span class="jc-code">' + U.esc(S.party.code) + '</span></div>';
        var copyc = U.el('button', 'btn btn-ghost btn-small', 'Copy');
        copyc.addEventListener('click', function () {
          if (navigator.clipboard) navigator.clipboard.writeText(S.party.code);
          copyc.textContent = 'Copied ✓';
          setTimeout(function () { copyc.textContent = 'Copy'; }, 1500);
        });
        codeBox.appendChild(copyc);
        privacy.appendChild(codeBox);
      }
      body.appendChild(privacy);
    }

    var members = U.el('div', 'convoy-members');
    if (!S.party.members.length) {
      members.appendChild(U.el('div', 'hint-card', 'No riders yet. Invite from <b>Nearby</b>.'));
    }
    S.party.members.forEach(function (id) {
      var npc = A.sim.getNpc(id);
      if (!npc) return;
      var chip = U.el('div', 'member-chip');
      chip.dataset.member = id; // voice module toggles .wt-speaking here
      chip.innerHTML =
        '<div class="u-ava u-ava-sm" style="--paint:' + npc.car.paint + '">' + avaInner(npc, 16) + '</div>' +
        '<div class="member-info"><b>' + U.esc(npc.name) + '</b><span class="member-dist"></span></div>';
      if (S.party.isLeader) {
        var kickBtn = U.el('button', 'icon-btn icon-btn-sm', '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>');
        kickBtn.title = 'Remove from convoy';
        kickBtn.addEventListener('click', function () { A.party.kick(id); });
        chip.appendChild(kickBtn);
      }
      chip.querySelector('.u-ava').addEventListener('click', function () {
        A.mapview.focusRider(npc.livePos || npc.pos);
      });
      // Tap the member's name for the Instagram-style profile.
      var nameEl = chip.querySelector('.member-info b');
      if (nameEl) nameEl.addEventListener('click', function () { openProfileOverlay(id); });
      members.appendChild(chip);
      convoyMemberRefs[id] = chip.querySelector('.member-dist');
    });
    body.appendChild(members);

    var chatWrap = U.el('div', 'chat');
    var chatLog = U.el('div', 'chat-log');
    chatLog.id = 'chat-log';
    renderChatInto(chatLog);
    var chatForm = U.el('div', 'chat-form');
    var chatInput = mkText('', 'Message the convoy…');
    chatInput.maxLength = 140;
    var sendBtn = U.el('button', 'icon-btn icon-btn-accent',
      '<svg viewBox="0 0 24 24"><path d="M3.8 11.4 20.2 3.6 13.6 20.4l-2.3-6.3-7.5-2.7Z" fill="currentColor" stroke="none"/></svg>');
    function send() {
      if (!chatInput.value.trim()) return;
      A.party.sendChat(chatInput.value);
      chatInput.value = '';
      chatInput.focus();
    }
    sendBtn.addEventListener('click', send);
    chatInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
    chatForm.appendChild(chatInput);
    chatForm.appendChild(sendBtn);
    chatWrap.appendChild(chatLog);
    chatWrap.appendChild(chatForm);
    body.appendChild(chatWrap);
    updateConvoyLive();
  }

  function renderChatInto(log) {
    if (!S.party) { log.innerHTML = ''; log._n = 0; log._last = null; return; }
    var chat = S.party.chat;
    // Incremental render keyed on the entry drawn last (_last), not on length:
    // the chat is a ring of A.party.CHAT_MAX, so past the cap every new line
    // lands with the length unchanged (ui-002; test/chatlog.test.js).
    var n = log._n || 0;
    var at = n > 0 ? chat.lastIndexOf(log._last) : -1;
    if (n > 0 && at === -1) { log.innerHTML = ''; n = 0; } // snapshot, or rotated past us
    else if (at !== -1 && at !== n - 1) {                   // k shifted off the front
      var drop = n - 1 - at;
      while (drop-- > 0 && log.firstChild) log.removeChild(log.firstChild);
      n = at + 1;
    }
    for (var i = n; i < chat.length; i++) {
      var m = chat[i], el;
      if (m.sys) {
        el = U.el('div', 'msg msg-sys', U.esc(m.text));
      } else if (m.from === 'me') {
        el = U.el('div', 'msg msg-me', U.esc(m.text));
      } else {
        el = U.el('div', 'msg msg-them',
          '<span class="msg-from">' + U.esc(m.from) + '</span>' + U.esc(m.text));
        // Report-on-the-message. Google Play's UGC policy wants reporting on the
        // CONTENT, not only on the person — and it is what someone reaches for
        // first anyway, with the offending line still on screen. The text is
        // snapshotted into the report because convoy chat is never persisted.
        if (m.fromId) addChatReport(el, m);
      }
      log.appendChild(el);
    }
    log._n = chat.length;
    log._last = chat[chat.length - 1] || null;
    log.scrollTop = log.scrollHeight;
  }

  // A small flag button on a received chat line. Opens the same report dialog the
  // rider card uses, pre-filled with the message and its author.
  function addChatReport(el, m) {
    var flag = U.el('button', 'msg-flag',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/>' +
      '<path d="M5 4.6c2-1.3 4-1.3 6 0s4 1.3 6 0v8.8c-2 1.3-4 1.3-6 0s-4-1.3-6 0"/></svg>');
    flag.type = 'button';
    flag.title = 'Report this message';
    flag.setAttribute('aria-label', 'Report this message from ' + (m.from || 'this rider'));
    flag.addEventListener('click', function (e) {
      e.stopPropagation();
      // Resolve the rider afresh — they may have left since the line was drawn,
      // in which case the id and the name from the message are all we have.
      var npc = A.sim.getNpc(m.fromId);
      showReportDialog({
        id: m.fromId,
        name: (npc && npc.profile && npc.profile.name) || m.from || 'this rider',
        emoji: m.emoji,
        account: (npc && npc.account) || null,
        self: false
      }, 'chat', m.text);
    });
    el.appendChild(flag);
  }

  function updateConvoyLive() {
    if (openName !== 'convoy' || !S.party) return;
    S.party.members.forEach(function (id) {
      var npc = A.sim.getNpc(id);
      var el = convoyMemberRefs[id];
      if (npc && el) {
        el.textContent = U.fmtDist(U.haversine(A.sim.playerPos(), npc.livePos || npc.pos), S.settings.units) + ' away';
      }
    });
  }

  function updateDockBadge() {
    var badge = document.getElementById('dock-convoy-badge');
    if (!badge) return; // a missing badge must not throw on every party emit
    var n = S.party ? S.party.members.length : 0;
    badge.hidden = !n;
    badge.textContent = n;
  }

  /* ============================== profile panel ============================== */
  var pf = {}; // profile form controls

  // Avatar inner markup: the uploaded photo when present, else the insignia glyph.
  // Only data:image URLs ever render (belt & braces on top of the server regex).
  // Mirrors the server's sanitizeAvatar(). A prefix test alone (/^data:image\//)
  // would let `data:image/x",onerror="…` out of the src="…" attribute below.
  var AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  function avaInner(r, size) {
    var a = r && r.avatar;
    if (typeof a === 'string' && a.length <= 24000 && AVATAR_RE.test(a)) {
      return '<img class="ava-img" src="' + a + '" alt=""/>';
    }
    return U.riderIcon(r ? r.emoji : 0, { size: size });
  }

  /* ---------------- profile photo: upload + content screen ----------------
     Pipeline: pick file → center-crop → screen for NSFW → compress to a small
     JPEG data URL (≤ ~19KB so it fits the server's avatar/frame caps) → save +
     sync. Screening runs CLIENT-side with NSFWJS (TensorFlow.js MobileNet,
     loaded from CDN only when a photo is actually chosen). If the model can't
     load (offline/native WebView), a conservative skin-exposure heuristic
     gates instead — when in doubt the photo is rejected, never auto-approved. */
  var nsfwModel = null, nsfwLoading = null;
  var loadScript = U.loadScript; // single implementation now lives in js/util.js
  function loadNsfwModel() {
    if (nsfwModel) return Promise.resolve(nsfwModel);
    if (nsfwLoading) return nsfwLoading;
    nsfwLoading = Promise.resolve()
      .then(function () {
        if (window.tf) return null;
        return loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      })
      .then(function () {
        if (window.nsfwjs) return null;
        // dist name differs across nsfwjs releases — try both UMD bundles
        return loadScript('https://cdn.jsdelivr.net/npm/nsfwjs@4.2.1/dist/browser.min.js')
          .catch(function () { return loadScript('https://cdn.jsdelivr.net/npm/nsfwjs@2.4.2/dist/nsfwjs.min.js'); });
      })
      .then(function () {
        // default hosted model first; fall back to the copy shipped in the npm package
        return window.nsfwjs.load().catch(function () {
          return window.nsfwjs.load('https://cdn.jsdelivr.net/npm/nsfwjs@4.2.1/models/mobilenet_v2/model.json', { size: 224 });
        });
      })
      .then(function (m) { nsfwModel = m; return m; })
      .catch(function (e) { nsfwLoading = null; throw e; });
    return nsfwLoading;
  }

  // Fallback gate when the ML model is unreachable: fraction of skin-toned
  // pixels. Portraits with background sit well under 0.6; wall-to-wall skin
  // (the images we must block) sits far above it.
  function skinRatio(canvas) {
    try {
      var ctx = canvas.getContext('2d');
      var d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var skin = 0, total = 0;
      for (var i = 0; i < d.length; i += 16) { // sample every 4th pixel
        var r = d[i], g = d[i + 1], b = d[i + 2];
        total++;
        if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
            (Math.max(r, g, b) - Math.min(r, g, b)) > 15 && Math.abs(r - g) > 15) skin++;
      }
      return total ? skin / total : 0;
    } catch (e) { return 1; } // unreadable canvas → treat as unverifiable
  }

  // → 'ok' | 'explicit' | 'suggestive' | 'unverified'
  function screenPhoto(canvas) {
    return loadNsfwModel().then(function (model) {
      return model.classify(canvas).then(function (preds) {
        var p = {};
        (preds || []).forEach(function (x) { p[x.className] = x.probability; });
        if ((p.Porn || 0) >= 0.25 || (p.Hentai || 0) >= 0.3) return 'explicit';
        if ((p.Sexy || 0) >= 0.5) return 'suggestive';
        return 'ok';
      });
    }).catch(function () {
      return skinRatio(canvas) > 0.6 ? 'unverified' : 'ok';
    });
  }

  function loadImageFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  function squareCanvas(img, size) {
    var side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    var sx = ((img.naturalWidth || img.width) - side) / 2;
    var sy = ((img.naturalHeight || img.height) - side) / 2;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    cv.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return cv;
  }

  // Compress until the data URL fits the transport caps (server rejects >24000
  // chars; we stop at ~19.5K for headroom). Returns '' if even 96px won't fit.
  function encodeAvatar(img) {
    var steps = [[128, 0.8], [128, 0.65], [128, 0.5], [96, 0.6], [96, 0.45]];
    for (var i = 0; i < steps.length; i++) {
      var url = squareCanvas(img, steps[i][0]).toDataURL('image/jpeg', steps[i][1]);
      if (url.length <= 19500) return url;
    }
    return '';
  }

  var pfpInput = null;
  function pickPhoto() {
    if (!pfpInput) {
      pfpInput = document.createElement('input');
      pfpInput.type = 'file';
      pfpInput.accept = 'image/*';
      pfpInput.style.display = 'none';
      document.body.appendChild(pfpInput);
      pfpInput.addEventListener('change', function () {
        var f = pfpInput.files && pfpInput.files[0];
        pfpInput.value = ''; // same file can be re-picked later
        if (f) handlePhotoFile(f);
      });
    }
    pfpInput.click();
  }

  function handlePhotoFile(file) {
    if (!/^image\//.test(file.type)) { toast('That is not an image file', 'warn'); return; }
    toast('Checking photo…', 'info');
    loadImageFile(file).then(function (img) {
      return screenPhoto(squareCanvas(img, 384)).then(function (verdict) {
        if (verdict !== 'ok') {
          toast(verdict === 'explicit' ? 'Photo rejected. Explicit content is not allowed'
            : verdict === 'suggestive' ? 'Photo rejected. Too suggestive for a profile photo'
            : 'Could not verify that photo is appropriate. Try a different one', 'warn');
          return;
        }
        var dataUrl = encodeAvatar(img);
        if (!dataUrl) { toast('Could not compress that image. Try a simpler photo', 'warn'); return; }
        S.profile.avatar = dataUrl;
        ST.saveProfile(S.profile);
        if (A.auth && A.auth.isLoggedIn()) A.auth.saveProfileToServer(S.profile);
        refreshAvatarBtn();
        renderProfileCard();
        renderAwards(); // "Photogenic" badge
        toast('Profile photo updated', 'success');
      });
    }).catch(function () { toast('Could not read that image', 'warn'); });
  }

  function removePhoto() {
    S.profile.avatar = '';
    ST.saveProfile(S.profile);
    if (A.auth && A.auth.isLoggedIn()) A.auth.saveProfileToServer(S.profile);
    refreshAvatarBtn();
    renderProfileCard();
    renderAwards();
    toast('Profile photo removed', 'info');
  }

  // Own-profile counters for the profile header. Friends is the only tally the
  // app keeps for a rider; convoy membership is live state, read off S.party.
  function selfStats() {
    return {
      friends: (S.friends || []).length,
      convoy: (S.party && S.party.members) ? S.party.members.length : 0
    };
  }

  // Instagram-style profile header: photo + friends / convoy counters beside
  // it, then name / handle / car "bio" line. Re-rendered on photo change, save,
  // party and friends updates.
  function renderProfileCard() {
    var card = document.getElementById('pf-card');
    if (!card) return;
    var c = S.profile.car;
    var carLine = c.year + ' ' + c.make + ' ' + c.model + (c.trim ? ' ' + c.trim : '');
    var loggedIn = A.auth && A.auth.isLoggedIn && A.auth.isLoggedIn();
    var st = selfStats();
    card.innerHTML =
      '<div class="pf-ig-top">' +
      '  <div class="pf-photo-wrap">' +
      '    <div class="pf-photo" style="--paint:' + U.safePaint(c.paint) + '">' + avaInner(S.profile, 34) + '</div>' +
      '    <button class="pf-cam" id="pf-cam" title="Change profile photo" aria-label="Change profile photo">' +
      '      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3v11H4Z"/><circle cx="12" cy="13" r="3.2"/></svg>' +
      '    </button>' +
      '  </div>' +
      '  <div class="pf-ig-stats">' +
      '    <span class="pf-stat"><b>' + st.friends + '</b>friends</span>' +
      '    <span class="pf-stat"><b>' + st.convoy + '</b>in convoy</span>' +
      '  </div>' +
      '</div>' +
      '<div class="pf-name">' + U.esc(S.profile.name) + '</div>' +
      '<div class="pf-handle">@' + U.esc(S.profile.handle) + '</div>' +
      '<div class="pf-carline">' + U.esc(carLine) + '</div>' +
      '<div class="pf-tags">' +
      (loggedIn ? '<span class="tag tag-live"><span class="dot dot-live"></span>Synced</span>'
        : '<span class="tag">Guest · local only</span>') +
      (S.profile.avatar ? '<button class="tag pf-remove-tag" id="pf-remove" type="button">Remove photo</button>' : '') +
      '</div>';
    card.querySelector('#pf-cam').addEventListener('click', pickPhoto);
    card.querySelector('.pf-photo').addEventListener('click', pickPhoto);
    var rm = card.querySelector('#pf-remove');
    if (rm) rm.addEventListener('click', removePhoto);
  }

  /* ---------------- awards (client-derived achievement badges) ----------------
     Computed from what the app already tracks: friends, profile photo, account
     state. Locked badges render dimmed so the page doubles as a goal list. */
  var AWARD_ICONS = {
    users:  '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.4 19.2c.6-3.1 2.9-4.7 5.6-4.7s5 1.6 5.6 4.7"/><circle cx="17" cy="9.6" r="2.6"/><path d="M16.2 14.6c2.3.2 4 1.7 4.4 4.4"/>',
    camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4Z"/><circle cx="12" cy="13" r="3.2"/>',
    shield: '<path d="M12 3 5 6v5c0 4 3 7 7 8 4-1 7-4 7-8V6Z"/>'
  };

  function computeAwards() {
    var st = selfStats();
    return [
      { name: 'Crew',           desc: 'Make 5 friends',        icon: 'users',  got: st.friends >= 5 },
      { name: 'Photogenic',     desc: 'Set a profile photo',   icon: 'camera', got: !!S.profile.avatar },
      { name: 'On the Grid',    desc: 'Create an account',     icon: 'shield', got: !!(A.auth && A.auth.isLoggedIn && A.auth.isLoggedIn()) }
    ];
  }

  function renderAwards() {
    var el = document.getElementById('pf-awards');
    if (!el) return;
    var list = computeAwards();
    var got = list.filter(function (a) { return a.got; }).length;
    var head = document.getElementById('pf-awards-count');
    if (head) head.textContent = got + ' / ' + list.length;
    el.innerHTML = list.map(function (a) {
      return '<div class="pf-badge' + (a.got ? '' : ' locked') + '">' +
        '<span class="pf-badge-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (U.own(AWARD_ICONS, a.icon) ? AWARD_ICONS[a.icon] : '') + '</svg></span>' +
        '<span class="pf-badge-name">' + U.esc(a.name) + '</span>' +
        '<span class="pf-badge-desc">' + U.esc(a.desc) + '</span>' +
        '</div>';
    }).join('');
  }

  /* ============================== public profile overlay ==============================
     Instagram-style, view-only page for any rider (yourself included). Reached by
     tapping a rider's popup header, a Nearby row, a convoy chip, or the "View
     public profile" button in the Garage. Renders identity + car + context
     actions. Reuses the existing modal host (#onboarding via
     openOverlay/closeOverlay) and the avaInner/carDot helpers. */
  // Build a "subject" (a normalized rider record) from an NPC id or 'self'.
  function profileSubject(from) {
    if (from === 'self') {
      var c = S.profile.car;
      var loggedIn = A.auth && A.auth.isLoggedIn();
      return {
        self: true,
        id: 'self',
        name: S.profile.name,
        handle: S.profile.handle,
        emoji: S.profile.emoji,
        avatar: S.profile.avatar || null,
        vibe: S.profile.vibe,
        car: c,
        account: loggedIn ? A.auth.username() : null,
        online: true
      };
    }
    var npc = A.sim.getNpc(from);
    if (!npc) return null;
    return {
      self: false,
      id: npc.id,
      name: npc.name,
      handle: npc.handle,
      emoji: npc.emoji,
      avatar: npc.avatar || null,
      vibe: npc.vibe,
      car: npc.car,
      account: npc.account || null,
      online: true
    };
  }

  function buildProfileOverlay(subject) {
    if (!subject) return null;
    var card = U.el('div', 'modal-card profile-overlay');
    var p = subject.car || {};
    var carLine = p.year + ' ' + (p.make || '') + ' ' + (p.model || '') + (p.trim ? ' ' + p.trim : '');
    var dist = '';
    if (!subject.self) {
      try { dist = U.fmtDist(U.haversine(A.sim.playerPos(), A.sim.getNpc(subject.id).pos), S.settings.units) + ' away'; }
      catch (e) { dist = ''; }
    }
    var friends = subject.self ? ((S.friends || []).length) : null;

    card.appendChild(authCloseHead(subject.self ? 'Your profile' : 'Rider profile', closeOverlay));

    // Header — large avatar, identity, status tags.
    var head = U.el('div', 'pf-po-head');
    head.innerHTML =
      '<div class="pf-photo-wrap">' +
      '  <div class="pf-po-photo" style="--paint:' + U.safePaint(p.paint) + '">' + avaInner(subject, 56) + '</div>' +
      '</div>' +
      '<div class="pf-po-id">' +
      '  <div class="pf-po-name">' + U.esc(subject.name || 'Rider') + '</div>' +
      '  <div class="pf-po-handle">@' + U.esc(subject.handle || 'rider') + (subject.account ? '' : ' · guest') + '</div>' +
      '  <div class="pf-po-tags">' +
      '    <span class="tag">' + U.esc(subject.vibe || 'Cruising') + '</span>' +
           (subject.self
              ? (A.auth && A.auth.isLoggedIn()
                  ? '<span class="tag tag-live"><span class="dot dot-live"></span>Synced</span>'
                  : '<span class="tag">Guest · local only</span>')
              : (subject.account
                  ? '<span class="tag tag-live"><span class="dot dot-live"></span>Account</span>'
                  : '<span class="tag">Guest</span>')) +
           (dist ? '<span class="tag">' + U.esc(dist) + '</span>' : '') +
      '  </div>' +
      '</div>';
    card.appendChild(head);

    // Counters strip — only the rider's own page has a tally to show.
    if (subject.self) {
      var strip = U.el('div', 'pf-po-strip');
      strip.innerHTML = '<span class="pf-po-stat"><b>' + friends + '</b>friends</span>';
      card.appendChild(strip);
    }

    // Car card.
    card.appendChild(U.el('div', 'section-label', 'Car'));
    var carCard = U.el('div', 'pf-po-car');
    carCard.innerHTML =
      '<span class="pf-po-car-dot">' + A.mapview.carDot(p.paint || '#4f8cff', 28) + '</span>' +
      '<div class="pf-po-car-info">' +
      '  <div class="pf-po-carline">' + U.esc(carLine.trim()) + '</div>' +
      '  <div class="pf-po-paint"><i class="paint-dot" style="background:' + U.safePaint(p.paint) + '"></i>' +
                U.esc(p.paintName || 'Paint') + ' · ' + U.esc(p.finish || 'Gloss') + '</div>' +
      '  <div class="pf-po-specs">' +
           (p.body ? '<span class="tag">' + U.esc(p.body) + '</span>' : '') +
           (p.drive ? '<span class="tag">' + U.esc(p.drive) + (p.hp ? ' · ' + p.hp + 'hp' : '') + '</span>' : '') +
           (p.engine ? '<span class="tag">' + U.esc(p.engine) + '</span>' : '') +
           (p.trans ? '<span class="tag">' + U.esc(p.trans) + '</span>' : '') +
           (p.mods && p.mods !== 'None' ? '<span class="tag">' + U.esc(p.mods) + '</span>' : '') +
           (p.exhaust && p.exhaust !== 'Stock' ? '<span class="tag">' + U.esc(p.exhaust) + '</span>' : '') +
      '  </div>' +
      '</div>';
    card.appendChild(carCard);

    // Action row — context dependent.
    var act = U.el('div', 'pf-po-actions');
    if (subject.self) {
      var edit = U.el('button', 'btn btn-primary btn-block', 'Edit profile');
      edit.addEventListener('click', function () { closeOverlay(); openPanel('profile'); });
      act.appendChild(edit);
    } else {
      var npc = A.sim.getNpc(subject.id);
      var inviteBtn = U.el('button', 'btn btn-primary btn-small');
      if (npc && npc.member) { inviteBtn.textContent = 'In convoy ✓'; inviteBtn.disabled = true; }
      else if (npc && npc.invited) { inviteBtn.textContent = 'Invited…'; inviteBtn.disabled = true; }
      else {
        inviteBtn.textContent = 'Invite to convoy';
        inviteBtn.addEventListener('click', function () {
          A.party.invite(subject.id);
          inviteBtn.textContent = 'Invited…';
          inviteBtn.disabled = true;
        });
      }
      act.appendChild(inviteBtn);

      var waveBtn = U.el('button', 'btn btn-ghost btn-small', 'Wave');
      waveBtn.addEventListener('click', function () {
        waveBtn.disabled = true;
        A.ui.toast('You waved at ' + subject.name, 'info');
        if (A.net && A.net.isLive()) A.net.sendWave(subject.id);
      });
      act.appendChild(waveBtn);

      // Add-friend for signed-in strangers.
      if (subject.account && A.auth && A.auth.isLoggedIn() && subject.account !== A.auth.username()) {
        var already = (S.friends || []).some(function (f) { return f.username === subject.account; });
        var friendBtn = U.el('button', 'btn btn-ghost btn-small');
        if (already) { friendBtn.textContent = 'Already friends'; friendBtn.disabled = true; }
        else {
          friendBtn.textContent = 'Add friend';
          friendBtn.addEventListener('click', function () {
            A.net.sendFriendAdd(subject.account);
            friendBtn.textContent = 'Request sent';
            friendBtn.disabled = true;
          });
        }
        act.appendChild(friendBtn);
      }
    }
    runHooks('profile-overlay', act, subject, card);
    card.appendChild(act);

    // Safety row — deliberately separated from the social actions above and
    // styled quietly. It has to be findable on every rider without competing
    // with "Invite" for attention, because the moment someone needs it they are
    // already looking for it.
    if (!subject.self) card.appendChild(buildSafetyRow(subject));
    return card;
  }

  /* ---------------- block & report ----------------
     Google Play's UGC policy wants both, in-app, on the content and on the
     person. Convoy carries chat, voice and profiles, so this row is
     reachable from any rider card and from any chat message.

     Block and report are separate on purpose. Blocking is the immediate,
     self-service one and needs no review; reporting reaches an operator and does
     nothing for the reporter's own feed. Doing only one of them is the common
     mistake — a block with no report leaves the rider free to do it to the next
     person, and a report with no block leaves the victim still exposed while
     they wait. So the block dialog offers to file a report at the same time. */

  // The rider's username, or null if they are a guest (or anonymised behind the
  // email gate). This — not an account uuid — is what identifies a blockable
  // rider on the client; see store.isBlockedUsername for why.
  function riderUsername(subject) {
    var npc = A.sim.getNpc(subject.id);
    return (npc && npc.account) || subject.account || null;
  }

  function buildSafetyRow(subject) {
    var row = U.el('div', 'pf-safety');
    var uname = riderUsername(subject);
    var isBlocked = uname ? ST.isBlockedUsername(uname)
                          : (S.hiddenRiders.indexOf(subject.id) >= 0);

    var blockBtn = U.el('button', 'btn btn-ghost btn-small btn-danger-text',
      isBlocked ? 'Unblock' : 'Block');
    blockBtn.addEventListener('click', function () {
      if (isBlocked) {
        // Resolve the account id from the canonical list — the server keys
        // block:remove on it, and it is the one place the client holds it.
        var entry = (S.blocked || []).filter(function (b) { return b.username === uname; })[0];
        doUnblock(entry && entry.id, subject.id, subject.name);
        closeOverlay();
        return;
      }
      showBlockDialog(subject);
    });
    row.appendChild(blockBtn);

    var repBtn = U.el('button', 'btn btn-ghost btn-small', 'Report');
    repBtn.addEventListener('click', function () { showReportDialog(subject, 'profile', null); });
    row.appendChild(repBtn);
    return row;
  }

  function doBlock(subject) {
    var uname = riderUsername(subject);
    if (uname && A.auth && A.auth.isLoggedIn()) {
      // No optimistic list entry. The server answers block:add with the
      // canonical block:list — including the account id that unblocking needs —
      // and inventing a half-populated row here would put an Unblock button on
      // screen with nothing to send. The pin is removed below either way, so the
      // block is visibly instant without the list having to guess.
      if (A.net && A.net.sendBlock) A.net.sendBlock(subject.id, uname);
      toast('Blocked ' + subject.name + '. They can no longer see you either', 'success');
    } else {
      // No account on one side or the other — say what actually happens rather
      // than pretending this is the same thing.
      ST.hideRider(subject.id);
      // Mirrors the dialog's three cases: whose missing account is the reason.
      toast(!(A.auth && A.auth.isLoggedIn())
        ? 'Hidden for this session. Create an account to block for good'
        : subject.name + ' is riding as a guest — hidden for this session', 'info');
    }
    // Drop them off the map right now rather than waiting for the server's
    // rider:remove. If the block somehow fails server-side the next scope tick
    // puts them back, which is the correct outcome — the block did not take.
    if (A.sim && A.sim.remoteRemove) A.sim.remoteRemove(subject.id);
    if (A.voice && A.voice.dropPeer) A.voice.dropPeer(subject.id);
    ST.emit('blocked', S.blocked);
  }

  function doUnblock(userId, riderId, name) {
    if (userId) {
      ST.removeBlock(userId);
      if (A.net && A.net.sendUnblock) A.net.sendUnblock(userId);
    }
    if (riderId) {
      var i = S.hiddenRiders.indexOf(riderId);
      if (i >= 0) S.hiddenRiders.splice(i, 1);
    }
    toast('Unblocked' + (name ? ' ' + name : ''), 'info');
    ST.emit('blocked', S.blocked);
  }

  function showBlockDialog(subject) {
    var uname = riderUsername(subject);
    var durable = !!(uname && A.auth && A.auth.isLoggedIn());
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('Block ' + subject.name, closeOverlay));

    // Three distinct situations, and they must not be described in the same
    // words. A signed-out viewer being told "they're riding as a guest" is
    // simply false — it is the VIEWER who has no account to hang a block on.
    var meSignedIn = !!(A.auth && A.auth.isLoggedIn());
    var warn = U.el('div', 'consent-warn consent-warn-danger');
    if (durable) {
      warn.innerHTML = '<b>You won\'t see each other again.</b>' +
        '<span>Their pin disappears from your map and yours from theirs. No chat, ' +
        'no voice, no waves, no convoy invites, in either direction. If you\'re ' +
        'friends, that ends too.</span>';
    } else if (!meSignedIn) {
      warn.innerHTML = '<b>Hidden for this session only.</b>' +
        '<span>You\'re riding as a guest, so there\'s no account to save a block to. ' +
        U.esc(subject.name) + ' will be hidden on this device until you close the app. ' +
        'Create an account to block riders for good.</span>';
    } else {
      warn.innerHTML = '<b>Hidden for this session only.</b>' +
        '<span>' + U.esc(subject.name) + ' is riding as a guest, so there\'s no account ' +
        'to block permanently. They\'ll be hidden on this device until you close the app.</span>';
    }
    card.appendChild(warn);

    var alsoReport = U.el('label', 'consent-row');
    alsoReport.innerHTML = '<input type="checkbox" checked/><span>Also report them, so we can ' +
      'review it. Blocking alone only protects you.</span>';
    if (A.auth && A.auth.isLoggedIn()) card.appendChild(alsoReport);

    var go = U.el('button', 'btn btn-block btn-lg btn-danger', 'Block ' + subject.name);
    go.addEventListener('click', function () {
      var wantsReport = !!(alsoReport.parentNode && alsoReport.querySelector('input').checked);
      doBlock(subject);
      if (wantsReport) showReportDialog(subject, 'profile', null);
      else closeOverlay();
    });
    card.appendChild(go);

    var no = U.el('button', 'btn btn-ghost btn-block', 'Cancel');
    no.addEventListener('click', closeOverlay);
    card.appendChild(no);
    openOverlay(card);
  }

  var REPORT_REASONS = [
    ['harassment', 'Harassment or bullying'],
    ['threats', 'Threats or violence'],
    ['hate', 'Hate speech'],
    ['sexual', 'Sexual or explicit content'],
    ['dangerous', 'Dangerous driving or street racing'],
    ['impersonation', 'Impersonating someone'],
    ['spam', 'Spam or a scam'],
    ['other', 'Something else']
  ];

  // `context` is where it happened ('chat' | 'voice' | 'profile' | 'map') and
  // `quoted` is the message being reported, snapshotted here because convoy chat
  // is never persisted server-side — by the time anyone reviews this, the convoy
  // and its history are gone.
  function showReportDialog(subject, context, quoted) {
    if (!A.auth || !A.auth.isLoggedIn()) {
      toast('Sign in to report a rider', 'warn');
      return;
    }
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('Report ' + subject.name, closeOverlay));
    card.appendChild(U.el('div', 'ob-note',
      'This goes to a human to review. It doesn\'t tell ' + U.esc(subject.name) +
      ' anything, and it doesn\'t block them — use Block for that.'));

    if (quoted) {
      var q = U.el('div', 'report-quote');
      q.innerHTML = '<span class="report-quote-label">Reported message</span>' +
        '<span class="report-quote-text">' + U.esc(quoted) + '</span>';
      card.appendChild(q);
    }

    card.appendChild(U.el('div', 'section-label', 'What happened?'));
    var chosen = '';
    var list = U.el('div', 'report-reasons');
    REPORT_REASONS.forEach(function (r) {
      var b = U.el('button', 'report-reason', U.esc(r[1]));
      b.type = 'button';
      b.addEventListener('click', function () {
        chosen = r[0];
        list.querySelectorAll('.report-reason').forEach(function (o) { o.classList.remove('on'); });
        b.classList.add('on');
        send.disabled = false;
      });
      list.appendChild(b);
    });
    card.appendChild(list);

    var detail = U.el('textarea', 'input report-detail');
    detail.placeholder = 'Anything else we should know? (optional)';
    detail.maxLength = 1000;
    card.appendChild(mkField('Details', detail));

    var err = U.el('div', 'auth-err'); err.hidden = true;
    card.appendChild(err);

    var send = U.el('button', 'btn btn-primary btn-block btn-lg', 'Send report');
    send.disabled = true;
    send.addEventListener('click', function () {
      err.hidden = true;
      if (!chosen) { showErr(err, 'Pick a reason'); return; }
      send.disabled = true; send.textContent = 'Sending…';
      A.auth.report({
        riderId: subject.id,
        subjectLabel: subject.name,
        reason: chosen,
        detail: detail.value.trim(),
        context: context || 'profile',
        evidence: quoted ? { quoted: quoted, at: Date.now() } : null
      }).then(function (r) {
        if (!r.ok) {
          showErr(err, r.error);
          send.disabled = false; send.textContent = 'Send report';
          return;
        }
        closeOverlay();
        toast('Report sent. Thanks — we\'ll look at it', 'success');
      });
    });
    card.appendChild(send);

    var cancel = U.el('button', 'btn btn-ghost btn-block', 'Cancel');
    cancel.addEventListener('click', closeOverlay);
    card.appendChild(cancel);
    openOverlay(card);
  }

  // Open the profile overlay for 'self' or an NPC id.
  function openProfileOverlay(from) {
    var subject = profileSubject(from);
    if (!subject) return;
    openOverlay(buildProfileOverlay(subject));
  }

  /* The Profile panel has two pages: 'main' — the Instagram-style profile
     (photo, counters, awards) — and 'garage' — the car editor
     sub-page. Reopening the panel always lands on main. Identity fields
     (name/handle/insignia/style) are set at signup and no longer editable. */
  var profileView = 'main';
  function showProfileView(v) {
    profileView = v;
    buildProfilePanel(); // builds the Settings box too when v === 'main'
  }

  // Bumped on every buildProfilePanel() call; a pending ensure().then()/.catch()
  // from an earlier call checks its own snapshot against this and no-ops if it
  // is stale — the fix for two overlapping garage opens (a click that beats a
  // debounce, or closeAuthEnter() re-rendering mid-load) both queuing into the
  // same cached promise and double-appending into `body`.
  var profileGen = 0;
  function buildProfilePanel() {
    var body = document.getElementById('profile-body');
    if (!body) return; // absent panel must not desync openName from the DOM
    body.innerHTML = '';
    // T1.5a: js/data.js is lazy (garage view needs D.MAKE_LIST/D.PAINTS/etc.);
    // the main page reads nothing lazy, so its await list is empty and it
    // renders on the next microtask through the same gen-guarded path.
    var gen = ++profileGen;
    var deps = profileView === 'garage' ? [A.data.ensure()] : [];
    Promise.all(deps).then(function () {
      if (gen !== profileGen || document.getElementById('profile-body') !== body) return;
      if (profileView === 'garage') buildGaragePage(body);
      else { buildProfileMain(body); buildSettings(document.getElementById('settings-host')); }
    }).catch(function () {
      if (gen !== profileGen || document.getElementById('profile-body') !== body) return;
      if (profileView === 'garage') {
        // A failed load must not trap the rider on the blank panel body.innerHTML
        // was cleared to at the top of this call — fall back to the main page
        // (which still offers the My Garage button, i.e. a retry) and correct
        // profileView so it matches what is actually on screen.
        toast('Could not load the garage — try again', 'warn');
        showProfileView('main');
      } else {
        buildProfileMain(body);
        buildSettings(document.getElementById('settings-host'));
      }
    });
  }

  /* ---- page 1: the profile ---- */
  /* ---------------- extension points (feature packs) ----------------
     Packs (js/packs.js) arrive after the core has booted and add to screens
     the core owns. Each named point is run where the core builds that screen:
       'settings'         (body, kit)            after Units, before Feature packs
       'profile'          (body)                 after Awards on the profile page
       'profile-overlay'  (actions, subject, card) the public-profile action row
       'init'             ()                     once ui.init() has run (at once
                                                 if it already has)
     A hook that throws is logged and skipped; it never takes the screen down. */
  var hooks = {}, uiInited = false;
  function addHook(name, fn) {
    if (typeof fn !== 'function') return;
    (hooks[name] = hooks[name] || []).push(fn);
    if (name === 'init' && uiInited) { try { fn(); } catch (e) { console.error('[convoy ui] init hook', e); } }
  }
  function runHooks(name, a, b, c) {
    var list = hooks[name] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](a, b, c); } catch (e) { console.error('[convoy ui] ' + name + ' hook', e); }
    }
  }
  // The builders a pack's settings section is made of, so it looks like ours.
  var settingsKit = { row: mkRow, toggle: mkToggle, field: mkField, segmented: mkSegmented, select: mkSelect, swatches: mkSwatches };

  function buildProfileMain(body) {
    var pfCard = U.el('div', 'pf-card');
    pfCard.id = 'pf-card';
    body.appendChild(pfCard);
    renderProfileCard();

    // Car card → opens the garage sub-page (the car editor lives there now).
    var c = S.profile.car;
    var garageBtn = U.el('button', 'pf-garage-btn');
    garageBtn.type = 'button';
    garageBtn.innerHTML =
      '<span class="pf-garage-dot">' + A.mapview.carDot(c.paint, 26) + '</span>' +
      '<span class="pf-garage-txt"><b>My Garage</b><i>' +
      U.esc(c.year + ' ' + c.make + ' ' + c.model + (c.trim ? ' ' + c.trim : '')) + '</i></span>' +
      '<span class="pf-garage-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>';
    garageBtn.addEventListener('click', function () { showProfileView('garage'); });
    body.appendChild(garageBtn);

    var pub = U.el('button', 'btn btn-ghost btn-block', 'View public profile');
    pub.title = 'See how your profile looks to other riders';
    pub.addEventListener('click', function () { openProfileOverlay('self'); });
    body.appendChild(pub);

    var awLabel = U.el('div', 'section-label pf-sec');
    awLabel.innerHTML = 'Awards <span class="pf-sec-count" id="pf-awards-count"></span>';
    body.appendChild(awLabel);
    var awards = U.el('div', 'pf-badges');
    awards.id = 'pf-awards';
    body.appendChild(awards);
    renderAwards();

    runHooks('profile', body);

    appendGearbox(body);
  }

  /* ---- page 2: the garage (car editor) ---- */
  function buildGaragePage(body) {
    var back = U.el('div', 'pf-back');
    var backBtn = U.el('button', 'btn btn-ghost btn-small', '← Profile');
    backBtn.type = 'button';
    backBtn.addEventListener('click', function () { showProfileView('main'); });
    back.appendChild(backBtn);
    back.appendChild(U.el('span', 'pf-back-title', 'My Garage'));
    body.appendChild(back);

    var preview = U.el('div', 'profile-preview');
    preview.id = 'profile-preview';
    body.appendChild(preview);

    pf.year = mkSelect(yearList(), S.profile.car.year);
    pf.make = mkSelect(D.MAKE_LIST, S.profile.car.make);
    pf.model = mkSelect(modelsFor(S.profile.car.make), S.profile.car.model);
    pf.trim = mkSelect(trimsFor(S.profile.car.make, S.profile.car.model), S.profile.car.trim);
    pf.paintHex = S.profile.car.paint;
    pf.paintName = S.profile.car.paintName;
    pf.paint = mkSwatches(D.PAINTS, pf.paintHex, function (hex, name) {
      pf.paintHex = hex; pf.paintName = name; updatePreview();
    });
    pf.finish = mkSegmented(
      D.FINISHES.map(function (f) { return { label: f, value: f }; }),
      S.profile.car.finish, updatePreview);

    // Spec sheet controls. Engine + mods take a preset OR a free-text custom
    // entry ('Custom…' in the select reveals the input) — swaps, builds, and
    // mod lists that aren't in the stock catalog.
    pf.body = mkSelect(D.BODY_TYPES, S.profile.car.body);
    pf.engine = mkSelectCustom(D.ENGINE_SIZES, S.profile.car.engine, 'e.g. 2JZ swap, LS3, K24 turbo', 24, updatePreview);
    pf.trans = mkSelect(D.TRANSMISSIONS, S.profile.car.trans);
    pf.drive = mkSegmented(
      D.DRIVETRAINS.map(function (d) { return { label: d, value: d }; }),
      S.profile.car.drive, updatePreview);
    pf.hp = mkText(String(S.profile.car.hp), 'HP');
    pf.hp.type = 'number';
    pf.hp.min = 50; pf.hp.max = 2000; pf.hp.step = 1;
    pf.hp.value = S.profile.car.hp;
    pf.mods = mkSelectCustom(D.MODS, S.profile.car.mods, 'e.g. full bolt-ons + E85 tune', 40, updatePreview);
    pf.exhaust = mkSelect(D.EXHAUST_NOTES, S.profile.car.exhaust);

    function fillSelect(sel, items) {
      sel.innerHTML = '';
      items.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m; o.textContent = m;
        sel.appendChild(o);
      });
    }
    pf.make.addEventListener('change', function () {
      fillSelect(pf.model, modelsFor(pf.make.value));
      fillSelect(pf.trim, trimsFor(pf.make.value, pf.model.value));
      updatePreview();
    });
    // Model changed → its trim list is different; repopulate before previewing.
    pf.model.addEventListener('change', function () {
      fillSelect(pf.trim, trimsFor(pf.make.value, pf.model.value));
      updatePreview();
    });
    // (engine + mods self-wire their onChange inside mkSelectCustom)
    [pf.year, pf.trim, pf.body, pf.trans, pf.exhaust].forEach(function (s) { s.addEventListener('change', updatePreview); });
    pf.hp.addEventListener('input', updatePreview);

    var sect = U.el('div', 'section-label', 'Car');
    body.appendChild(sect);
    var grid3 = U.el('div', 'grid3');
    grid3.appendChild(mkField('Year', pf.year));
    grid3.appendChild(mkField('Make', pf.make));
    grid3.appendChild(mkField('Model', pf.model));
    body.appendChild(grid3);
    body.appendChild(mkField('Trim', pf.trim));
    body.appendChild(mkField('Paint', pf.paint));
    body.appendChild(mkField('Finish', pf.finish));

    body.appendChild(U.el('div', 'section-label', 'Specs'));
    var specGrid = U.el('div', 'grid3');
    specGrid.appendChild(mkField('Body', pf.body));
    specGrid.appendChild(mkField('Engine', pf.engine));
    specGrid.appendChild(mkField('Transmission', pf.trans));
    body.appendChild(specGrid);
    var perfGrid = U.el('div', 'grid2');
    perfGrid.appendChild(mkField('Drivetrain', pf.drive));
    perfGrid.appendChild(mkField('Horsepower', pf.hp));
    body.appendChild(perfGrid);

    body.appendChild(U.el('div', 'section-label', 'Mods'));
    var modsGrid = U.el('div', 'grid2');
    modsGrid.appendChild(mkField('Mods', pf.mods));
    modsGrid.appendChild(mkField('Exhaust note', pf.exhaust));
    body.appendChild(modsGrid);

    var actions = U.el('div', 'profile-actions');
    var save = U.el('button', 'btn btn-primary btn-block', 'Save changes');
    save.addEventListener('click', saveProfileForm);
    var dice = U.el('button', 'btn btn-ghost', 'Randomize car');
    dice.title = 'Randomize the car (identity stays)';
    dice.addEventListener('click', randomizeProfileForm);
    actions.appendChild(save);
    actions.appendChild(dice);
    body.appendChild(actions);

    updatePreview();
  }

  // Settings — collapsible "gear box" subsection (the folded-in Settings tab).
  // Lives on the profile main page; controls render into #settings-host on open.
  function appendGearbox(body) {
    var gear = U.el('div', 'gearbox');
    gear.id = 'gearbox';
    gear.innerHTML =
      '<button class="gearbox-head" id="gearbox-head" type="button" aria-expanded="false" aria-controls="settings-host">' +
      '<span class="gb-gear"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.5M12 18.7v2.5M21.2 12h-2.5M5.3 12H2.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6"/></svg></span>' +
      '<span class="gb-label">Settings</span>' +
      '<span class="gb-chev"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span>' +
      '</button>' +
      '<div class="gearbox-body"><div class="gearbox-clip"><div class="gearbox-inner" id="settings-host"></div></div></div>';
    body.appendChild(gear);
    gear.querySelector('#gearbox-head').addEventListener('click', function () {
      toggleGearbox();
    });
  }

  function modelsFor(make) { return U.own(D.MAKES, make) ? D.MAKES[make] : ['Other']; }
  function trimsFor(make, model) {
    var mk = D.VEHICLES && D.VEHICLES[make];
    var trims = mk && mk[model];
    return (trims && trims.length) ? trims : ['Standard'];
  }

  // Live car preview on the garage page (identity is fixed — car only).
  function updatePreview() {
    var preview = document.getElementById('profile-preview');
    if (!preview || !pf.year) return;
    var finish = pf.finish.getValue();
    var drive = pf.drive ? pf.drive.getValue() : '';
    var hp = pf.hp ? pf.hp.value : '';
    var body = pf.body ? pf.body.value : '';
    var engine = pf.engine ? pf.engine.getValue() : '';
    var mods = pf.mods ? pf.mods.getValue() : '';
    var exhaust = pf.exhaust ? pf.exhaust.value : '';
    preview.innerHTML =
      '<div class="pp-car">' + A.mapview.carDot(pf.paintHex, 40) + '</div>' +
      '<div class="pp-info">' +
      '  <div class="pp-carline">' + pf.year.value + ' ' + U.esc(pf.make.value) + ' ' + U.esc(pf.model.value) +
      (pf.trim && pf.trim.value ? ' <span class="pp-trim">' + U.esc(pf.trim.value) + '</span>' : '') + '</div>' +
      '  <div class="pp-paint"><i class="paint-dot" style="background:' + U.safePaint(pf.paintHex) + '"></i>' +
      U.esc(pf.paintName) + ' · ' + finish + '</div>' +
      '  <div class="pp-specs"><span class="pp-tag">' + U.esc(body) + '</span>' +
      (engine ? '    <span class="pp-tag">' + U.esc(engine) + '</span>' : '') +
      '    <span class="pp-tag">' + U.esc(drive) + ' · ' + U.esc(hp) + 'hp</span>' +
      (mods && mods !== 'None' ? '    <span class="pp-tag">' + U.esc(mods) + '</span>' : '') +
      '    <span class="pp-tag">' + U.esc(exhaust) + '</span></div>' +
      '</div>';
  }

  function fillProfileForm() {
    if (!pf.year) return; // garage controls not built yet
    pf.year.value = S.profile.car.year;
    pf.make.value = S.profile.car.make;
    pf.make.dispatchEvent(new Event('change'));
    pf.model.value = S.profile.car.model;
    // The make-change handler refilled trims for the make's FIRST model — resync
    // to the saved model before restoring the saved trim.
    pf.model.dispatchEvent(new Event('change'));
    if (S.profile.car.trim) pf.trim.value = S.profile.car.trim;
    pf.paintHex = S.profile.car.paint;
    pf.paintName = S.profile.car.paintName;
    pf.paint.setValue(pf.paintHex);
    if (S.profile.car.body) {
      pf.body.value = S.profile.car.body;
      pf.engine.setValue(S.profile.car.engine || '2.0L');
      pf.trans.value = S.profile.car.trans || 'Automatic';
      pf.drive.setValue(S.profile.car.drive || 'FWD');
      pf.hp.value = S.profile.car.hp || 200;
      pf.mods.setValue(S.profile.car.mods || 'None');
      pf.exhaust.value = S.profile.car.exhaust || 'Stock';
    }
    renderProfileCard(); // stats (friends/nearby) go stale between opens
    updatePreview();
  }

  function saveProfileForm() {
    // Identity (name/handle/insignia/style) is fixed at signup; the garage
    // form only edits the car. Photo is managed by the profile header.
    var profile = {
      name: S.profile.name,
      handle: S.profile.handle,
      emoji: S.profile.emoji,
      avatar: S.profile.avatar || '',
      vibe: S.profile.vibe,
      car: {
        year: +pf.year.value,
        make: pf.make.value,
        model: pf.model.value,
        trim: pf.trim.value || '',
        paint: pf.paintHex,
        paintName: pf.paintName,
        finish: pf.finish.getValue(),
        body: pf.body.value,
        engine: pf.engine.getValue(),
        trans: pf.trans.value,
        drive: pf.drive.getValue(),
        hp: +pf.hp.value || 200,
        mods: pf.mods.getValue(),
        exhaust: pf.exhaust.value
      }
    };
    ST.saveProfile(profile);
    if (A.auth && A.auth.isLoggedIn()) A.auth.saveProfileToServer(profile); // sync across devices
    A.mapview.refreshPlayer();
    refreshAvatarBtn();
    renderProfileCard();
    renderAccount();
    toast(A.auth && A.auth.isLoggedIn() ? 'Profile saved & synced' : 'Profile saved', 'success');
  }

  // Car-only randomizer (identity is not editable anymore).
  function randomizeProfileForm() {
    if (!pf.year) return;
    var make = U.pick(D.MAKE_LIST);
    var paint = U.pick(D.PAINTS);
    var engine = U.pick(D.ENGINE_SIZES);
    pf.year.value = U.randInt(1995, 2026);
    pf.make.value = make;
    pf.make.dispatchEvent(new Event('change'));
    pf.model.value = U.pick(D.MAKES[make]);
    pf.model.dispatchEvent(new Event('change'));
    pf.trim.value = U.pick(trimsFor(make, pf.model.value));
    pf.paintHex = paint.hex;
    pf.paintName = paint.name;
    pf.paint.setValue(paint.hex);
    pf.body.value = U.pick(D.BODY_TYPES);
    pf.engine.setValue(engine);
    pf.trans.value = U.pick(D.TRANSMISSIONS);
    pf.drive.setValue(U.pick(D.DRIVETRAINS));
    pf.hp.value = engine === 'Electric' ? U.randInt(200, 1000) : U.randInt(150, 750);
    pf.mods.setValue(U.pick(D.MODS));
    pf.exhaust.value = U.pick(D.EXHAUST_NOTES);
    updatePreview();
  }

  function refreshAvatarBtn() {
    document.getElementById('btn-avatar').innerHTML = avaInner(S.profile, 22);
  }

  /* ============================== settings panel ============================== */
  var ACCENTS = [
    { name: 'Neutral Slate', hex: '#9aa3b0' },
    { name: 'Electric Cyan', hex: '#00f0ff' },
    { name: 'Hot Magenta', hex: '#ff2bd6' },
    { name: 'Acid Green', hex: '#a6ff3a' },
    { name: 'Sodium Amber', hex: '#ffb000' },
    { name: 'Hot Pink', hex: '#ff3d77' },
    { name: 'Electric Violet', hex: '#9b4dff' }
  ];

  function buildSettings(body) {
    if (!body) return;
    body.innerHTML = '';

    var account = U.el('div', 'account-section');
    account.id = 'account-section';
    body.appendChild(account);
    renderAccount();

    body.appendChild(U.el('div', 'section-label', 'Appearance'));
    // Theme choices come from the registry (js/themes.js) — registering a theme
    // there adds it here automatically. 'Auto' resolves dark/light by system setting.
    var accentSw; // built below; theme switches may snap the accent, so re-sync it
    var themeOpts = (A.themes ? A.themes.list() : [
      { id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }
    ]).map(function (t) { return { label: t.name, value: t.id }; });
    themeOpts.push({ label: 'Sun-sync', value: 'sun' }); // follows real sunrise/sunset at your location
    themeOpts.push({ label: 'Auto', value: 'auto' });
    var themeSeg = mkSegmented(themeOpts, S.settings.theme, function (v) {
      ST.setTheme(v);
      if (accentSw) accentSw.setValue(S.settings.accent);
    });
    themeSeg.classList.add('wrap'); // 8 options — let the chips flow onto extra rows
    body.appendChild(mkField('Theme', themeSeg));

    accentSw = mkSwatches(ACCENTS, S.settings.accent, function (hex) { ST.setAccent(hex); });
    body.appendChild(mkField('Accent color', accentSw));

    /* ---- custom theme builder ---- */
    // Six colors → js/themes.js derives the full theme (panels, text, hairlines,
    // complete map palette) and registers it as the 'Custom' chip above.
    if (A.themes && A.themes.getCustomCfg) {
      body.appendChild(U.el('div', 'section-label', 'Custom theme'));
      var draft = Object.assign({}, A.themes.getCustomCfg());
      [
        { key: 'accent', label: 'Accent' },
        { key: 'bg', label: 'Panels' },
        { key: 'land', label: 'Map land' },
        { key: 'road', label: 'Map roads' },
        { key: 'water', label: 'Map water' },
        { key: 'route', label: 'GPS route' }
      ].forEach(function (f) {
        var inp = U.el('input', 'dot-color');
        inp.type = 'color';
        inp.value = draft[f.key];
        inp.title = f.label;
        inp.setAttribute('aria-label', f.label);
        inp.addEventListener('input', function () { draft[f.key] = inp.value; });
        body.appendChild(mkField(f.label, inp));
      });
      var applyBtn = U.el('button', 'btn btn-primary btn-block');
      applyBtn.type = 'button';
      applyBtn.textContent = 'Apply custom theme';
      applyBtn.addEventListener('click', function () {
        A.themes.setCustom(draft);
        ST.setTheme('custom');
        if (themeSeg) themeSeg.setValue('custom');
        if (accentSw) accentSw.setValue(S.settings.accent);
        toast('Custom theme applied', 'success');
      });
      body.appendChild(applyBtn);
    }

    var styleSel = mkSelect(['auto', 'dark', 'positron', 'voyager', 'liberty', 'bright'], S.settings.mapStyle);
    var styleNames = {
      auto: 'Auto (match theme)',
      dark: 'Dark · Night City',
      positron: 'Minimal · Positron',
      voyager: 'Day · Voyager',
      liberty: 'Street · Liberty',
      bright: 'Bright · Colorful'
    };
    styleSel.querySelectorAll('option').forEach(function (o) { o.textContent = styleNames[o.value]; });
    styleSel.addEventListener('change', function () { ST.setMapStyle(styleSel.value); });
    body.appendChild(mkField('Map style', styleSel));

    // Blur budget (T2.4a): backdrop-filter is the most expensive thing the HUD
    // draws every frame over the map. 'auto' drops it on low-memory devices;
    // this row lets a rider override a wrong auto-detect either direction.
    var glassSel = mkSelect(['auto', 'on', 'off'], S.settings.glass);
    var glassNames = {
      auto: 'Auto (off on low-end devices)',
      on: 'Always on',
      off: 'Off (faster)'
    };
    glassSel.querySelectorAll('option').forEach(function (o) { o.textContent = glassNames[o.value]; });
    glassSel.addEventListener('change', function () { ST.setSetting('glass', glassSel.value); ST.applyGlass(); });
    body.appendChild(mkField('Glass blur', glassSel));

    /* ---- Map dots (recolor the rider categories live) ---- */
    // One color input per category. Each writes a CSS var via setDotColor, so the
    // change lands on every marker instantly (no reload, no marker rebuild).
    // The player dot also drives its halo via --accent — kept separate on purpose
    // so riders and the player read as distinct categories even when recolored.
    body.appendChild(U.el('div', 'section-label', 'Map dots'));
    var DOTS = [
      { key: 'you',    label: 'You' },
      { key: 'friend', label: 'Friends' },
      { key: 'near',   label: 'Nearby' },
      { key: 'road',   label: 'On your road' },
      { key: 'sight',  label: 'In sight' }
    ];
    var dc = S.settings.dotColors || {};
    DOTS.forEach(function (d) {
      var inp = U.el('input', 'dot-color');
      inp.type = 'color';
      inp.value = /^#[0-9a-fA-F]{6}$/.test(dc[d.key]) ? dc[d.key] : '#2f80ff';
      inp.title = d.label + ' dot color';
      inp.setAttribute('aria-label', d.label + ' dot color');
      inp.addEventListener('input', function () { ST.setDotColor(d.key, inp.value); });
      body.appendChild(mkField(d.label, inp));
    });
    var resetBtn = U.el('button', 'btn btn-ghost btn-small');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.style.marginTop = '4px';
    resetBtn.addEventListener('click', function () {
      ST.resetDotColors();
      // refresh every input to the reset value
      var fresh = (A.state.settings.dotColors) || {};
      body.querySelectorAll('.dot-color').forEach(function (inp, i) {
        if (DOTS[i]) inp.value = fresh[DOTS[i].key];
      });
    });
    body.appendChild(resetBtn);

    /* Grouped by what a rider is actually looking for: the camera, who is on
       the map, the drive itself, privacy, voice. */
    body.appendChild(U.el('div', 'section-label', 'Camera'));
    body.appendChild(mkRow('Follow camera', 'Keep the map centred on you as you drive',
      mkToggle(S.settings.followCam, function (v) { ST.setFollowCam(v); })));
    body.appendChild(mkRow('Speed-adaptive zoom', 'Eases out at highway speed, back in around town',
      mkToggle(S.settings.adaptiveZoom, function (v) { ST.setSetting('adaptiveZoom', v); })));
    body.appendChild(mkRow('Smooth animations', 'Camera flights and transitions',
      mkToggle(S.settings.anim, function (v) { ST.setAnim(v); })));

    /* ---- Riders on the map ---- */
    body.appendChild(U.el('div', 'section-label', 'Riders on the map'));
    body.appendChild(mkRow('Global drivers', 'The world-wide delayed layer, in amber',
      mkToggle(S.settings.showGlobal, function (v) { ST.setShowGlobal(v); })));
    body.appendChild(mkRow('Arrows to convoy riders', 'Off-screen riders get an edge arrow you can tap to fly to them',
      mkToggle(S.settings.riderArrows !== false, function (v) {
        ST.setSetting('riderArrows', v);
        if (A.riderarrows && A.riderarrows.refresh) A.riderarrows.refresh();
      })));
    body.appendChild(U.el('div', 'hint-card',
      'The convoy button on the map fits everyone into one view. When riders are too ' +
      'far apart for that to be useful, the arrows are how you still know where they are.'));

    /* ---- Driving ---- */
    body.appendChild(U.el('div', 'section-label', 'Driving'));
    body.appendChild(mkRow('Keep screen awake', 'Stops the display sleeping while riding',
      mkToggle(S.settings.keepAwake, function (v) { ST.setSetting('keepAwake', v); })));
    body.appendChild(mkRow('Space scenery', 'Stars, planets & day/night on the globe',
      mkToggle(S.settings.showSpace !== false, function (v) {
        ST.setSetting('showSpace', v);
        if (A.space && A.space.setEnabled) A.space.setEnabled(v);
      })));

    var navSupported = A.routing && A.routing.isNavSupported && A.routing.isNavSupported();
    body.appendChild(mkRow('Voice navigation',
      navSupported ? 'Spoken turn-by-turn directions during a trip' : 'Not supported on this device',
      mkToggle(S.settings.voiceNav && navSupported, function (v) {
        ST.setVoiceNav(v);
        if (A.routing && A.routing.setNavEnabled) A.routing.setNavEnabled(v);
        if (v && !navSupported) A.ui.toast('Voice navigation is not supported on this device', 'warn');
      })));
    if (navSupported) {
      var voices = (A.routing.listVoices && A.routing.listVoices()) || [];
      var voiceSel = document.createElement('select');
      voiceSel.className = 'input select';
      var autoOpt = document.createElement('option');
      autoOpt.value = ''; autoOpt.textContent = 'Auto (female voice)';
      voiceSel.appendChild(autoOpt);
      voices.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.name;
        o.textContent = v.name + (v.neural ? ' · natural' : (v.female ? ' · female' : ''));
        if (v.name === S.settings.navVoiceName) o.selected = true;
        voiceSel.appendChild(o);
      });
      voiceSel.addEventListener('change', function () {
        ST.setNavVoice(voiceSel.value);
        if (A.routing.setVoiceName) A.routing.setVoiceName(voiceSel.value);
        if (A.routing.previewVoice) A.routing.previewVoice(); // hear the pick immediately
      });
      body.appendChild(mkField('Navigator voice', voiceSel));
    }
    /* ---- Privacy ---- */
    body.appendChild(U.el('div', 'section-label', 'Privacy'));
    body.appendChild(mkRow('Invisible mode',
      'Hide from every rider outside your convoy. Proximity voice pauses while you are hidden',
      mkToggle(S.settings.ghost, function (v) { applyGhost(v); })));
    body.appendChild(U.el('div', 'hint-card',
      'Your live position is only ever shared while the app is open and you are visible. ' +
      'We keep no location history.'));

    /* ---- Voice chat ---- */
    var voiceHost = U.el('div', 'voice-settings-host');
    voiceHost.id = 'voice-settings-host';
    body.appendChild(voiceHost);
    buildVoiceSettings(voiceHost);

    // Units governs every distance and speed in the app, so it gets its own
    // heading.
    body.appendChild(U.el('div', 'section-label', 'Units'));
    body.appendChild(mkField('Distance & speed', mkSegmented([
      { label: 'Miles', value: 'mi' },
      { label: 'Kilometers', value: 'km' }
    ], S.settings.units, function (v) { ST.setUnits(v); })));

    // Sections contributed by feature packs the account holds, then the packs
    // screen itself — always present, so what exists is never a secret.
    runHooks('settings', body, settingsKit);
    buildPackSection(body);

    /* ---- Legal & data ----
       The disclosure surface. Everything the consent gate said at sign-up has to
       stay findable afterwards, or it was a one-time formality rather than a
       standing notice — and the deletion path has to live somewhere a rider can
       actually find it, which is what Google Play's account-deletion policy
       means by "in-app". */
    body.appendChild(U.el('div', 'section-label', 'Legal & data'));

    var signedIn = A.auth && A.auth.isLoggedIn();
    var hold = U.el('div', 'legal-note');
    hold.innerHTML = signedIn
      ? '<b>We hold your account.</b> Your username, profile, garage, friends, stats' +
        (A.auth.email() ? ' and email address' : '') + ' are stored on our servers as ' +
        '<b>@' + U.esc(A.auth.username()) + '</b>, and stay there until you delete them. ' +
        'While you\'re on the map, riders near you see your live location. We don\'t ' +
        'keep location history, we don\'t record voice, and we don\'t sell data.'
      : '<b>You\'re riding as a guest.</b> Nothing about you is on our servers — your ' +
        'profile and settings live in this browser only. While you\'re on the map, ' +
        'riders near you still see your live location.';
    body.appendChild(hold);

    var links = U.el('div', 'legal-links');
    links.innerHTML =
      '<a href="' + legalUrl('/terms') + '" target="_blank" rel="noopener">Terms of Service</a>' +
      '<a href="' + legalUrl('/privacy') + '" target="_blank" rel="noopener">Privacy Policy</a>' +
      '<a href="' + legalUrl('/notices') + '" target="_blank" rel="noopener">Third-party notices</a>' +
      '<a href="' + legalUrl('/delete-account') + '" target="_blank" rel="noopener">Delete your account</a>';
    body.appendChild(links);

    if (S.consent && S.consent.at) {
      body.appendChild(U.el('div', 'legal-consent',
        'You accepted the terms (v' + U.esc(S.consent.version) + ') on ' +
        new Date(S.consent.at).toLocaleDateString() + ', confirming you ride as a ' +
        'passenger and are 16 or older.'));
    }

    /* ---- diagnostics ----
       Disclosed here rather than buried in Settings, because it is the one
       switch on this screen that changes what leaves the device. The copy has
       to be specific enough to be a real choice: naming what is sent is the
       difference between a consent control and a dark pattern. */
    body.appendChild(mkRow('Crash reports', 'Anonymous crashes & app usage — no location, no messages',
      mkToggle(S.settings.diagnostics !== false, function (v) {
        ST.setSetting('diagnostics', v);
        if (A.telemetry) A.telemetry.setEnabled(v);
      })));
    body.appendChild(U.el('div', 'legal-consent',
      'When something breaks we get the error, which screen you were on, and ' +
      'your app version — tied to a random id that is thrown away when you close ' +
      'the app. We never send where you are, where you were going, or anything ' +
      'you or anyone else typed. Turn this off and nothing is sent at all.'));

    /* ---- Blocked riders ----
       The other half of "you can block someone": being able to see who, and
       change your mind. A block list you cannot inspect or undo is a trap, and
       the store policies that ask for blocking ask for this too. */
    body.appendChild(U.el('div', 'section-label', 'Blocked riders'));
    var blockHost = U.el('div', 'blocked-host');
    blockHost.id = 'blocked-host';
    body.appendChild(blockHost);
    renderBlockedList();
    body.appendChild(U.el('div', 'legal-consent',
      'Blocking hides you from each other completely — pins, chat, voice, waves ' +
      'and invites, both ways. To report a rider for review, open their card and ' +
      'tap Report.'));

    body.appendChild(U.el('div', 'section-label', 'Data'));
    var reset = U.el('button', 'btn btn-ghost btn-block btn-danger-text', 'Reset app data');
    reset.addEventListener('click', function () {
      if (confirm('Reset profile, settings and convoy? The app will reload.')) ST.reset();
    });
    body.appendChild(reset);

    if (signedIn) {
      var del = U.el('button', 'btn btn-ghost btn-block btn-danger-text', 'Delete account');
      del.addEventListener('click', showDeleteAccount);
      body.appendChild(del);
      body.appendChild(U.el('div', 'legal-consent',
        '"Reset app data" only clears this device. "Delete account" erases @' +
        U.esc(A.auth.username()) + ' from our servers for good.'));
    }

    // Android download — only meaningful on the web; hidden inside the native shell.
    var apkLink = (A.config && A.config.isNative) ? '' :
      '<a class="apk-link" href="/convoy.apk" download="Convoy.apk">⬇ Get the Android app (.apk)</a><br>';
    var about = U.el('div', 'about',
      'Convoy v0.3 · For passengers, never drivers.<br>' + apkLink +
      'Maps © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> & ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> ' +
      '(<a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener">ODbL</a>) · ' +
      'Routing by OSRM & TomTom.<br>' +
      '<a href="' + legalUrl('/notices') + '" target="_blank" rel="noopener">Full attribution &amp; licences</a>');
    body.appendChild(about);
  }

  // Redraws the blocked list in place. Safe to call when Settings isn't open —
  // net.js calls it whenever the server pushes a new canonical list.
  function renderBlockedList() {
    var host = document.getElementById('blocked-host');
    if (!host) return;
    host.innerHTML = '';
    var list = S.blocked || [];
    var hiddenCount = (S.hiddenRiders || []).length;

    if (!list.length) {
      host.appendChild(U.el('div', 'hint-card', hiddenCount
        ? 'No blocked accounts. ' + hiddenCount + ' guest rider' + (hiddenCount === 1 ? '' : 's') +
          ' hidden for this session.'
        : 'You haven\'t blocked anyone.'));
      return;
    }

    list.forEach(function (b) {
      var row = U.el('div', 'blocked-row');
      row.innerHTML =
        '<span class="blocked-ava">' + U.esc(b.emoji || '🚗') + '</span>' +
        '<span class="blocked-info"><b>' + U.esc(b.name || b.username || 'Rider') + '</b>' +
        (b.username ? '<span>@' + U.esc(b.username) + '</span>' : '<span>account removed</span>') +
        '</span>';
      var un = U.el('button', 'btn btn-ghost btn-small', 'Unblock');
      un.addEventListener('click', function () {
        un.disabled = true;
        doUnblock(b.id, null, b.name || b.username);
        renderBlockedList();
      });
      row.appendChild(un);
      host.appendChild(row);
    });

    if (hiddenCount) {
      host.appendChild(U.el('div', 'legal-consent',
        'Plus ' + hiddenCount + ' guest rider' + (hiddenCount === 1 ? '' : 's') +
        ' hidden for this session. Guests have no account to block permanently.'));
    }
  }

  var rowSeq = 0;
  function mkRow(title, sub, control) {
    var r = U.el('div', 'setting-row');
    var lid = 'row-lbl-' + (++rowSeq);
    r.innerHTML = '<div class="setting-text"><b id="' + lid + '">' + U.esc(title) + '</b>' + (sub ? '<span>' + U.esc(sub) + '</span>' : '') + '</div>';
    // The visible <b> is the control's name. Only wire it when the control is a real
    // control and has no name of its own — mkSegmented returns a plain wrapper div,
    // and some callers pass a pre-labelled control.
    if (control && control.setAttribute
        && !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby')
        && (control.tagName === 'BUTTON' || control.tagName === 'INPUT'
            || control.tagName === 'SELECT' || control.getAttribute('role'))) {
      control.setAttribute('aria-labelledby', lid);
    }
    r.appendChild(control);
    return r;
  }

  /* ============================== voice chat settings ==============================
     Every control here is gated on A.voice.capabilities(). The Android WebView
     is not desktop Chrome: output-sink selection and device enumeration may
     simply not exist there, and a switch that silently does nothing is worse
     than no switch at all — so a missing capability removes the row. */
  // Bumped on every buildVoiceSettings() call; the same re-entrancy shape as
  // buildProfilePanel()'s profileGen (task 2) — a stale pending ensure() call
  // (settings panel closed and reopened while voice was still loading) becomes
  // a no-op instead of rendering into a host that has already moved on.
  var voiceGen = 0;
  function buildVoiceSettings(host) {
    var gen = ++voiceGen;
    // js/voice.js is lazy now (task 3). A failed load degrades exactly like a
    // voice module that was never present — the caps-stripped section below
    // already handles that (guardrail: a missing capability drops the row
    // rather than crashing), so the rejection is swallowed here on purpose.
    A.voiceLoader.ensure().catch(function () { return null; }).then(function (V) {
      if (gen !== voiceGen || document.getElementById('voice-settings-host') !== host) return;
      host.innerHTML = '';
      renderVoiceSettings(host, V);
    });
  }

  function renderVoiceSettings(body, V) {
    var caps = (V && V.capabilities) ? V.capabilities() : {
      devices: false, inputPicker: false, outputPicker: false,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      voiceIsolation: false, leveler: false
    };

    body.appendChild(U.el('div', 'section-label', 'Voice chat'));

    /* --- who you are connected to --- */
    body.appendChild(mkField('Auto voice chat', mkSegmented([
      { label: 'Off', value: 'off' },
      { label: 'Nearby', value: 'radius' },
      { label: 'In sight', value: 'sight' },
      { label: 'My road', value: 'road' }
    ], (S.settings.proxVoice || 'off'), function (v) {
      if (V && V.setProxMode) V.setProxMode(v);
      else ST.setSetting('proxVoice', v);
    })));
    body.appendChild(U.el('div', 'hint-card',
      'Automatically links the walkie-talkie with riders <b>around you</b>, <b>in sight ahead</b> or ' +
      '<b>sharing your road</b>, like proximity voice chat. Both riders need it on. ' +
      'Convoy voice always works; Ghost mode pauses it.'));

    if (!V) return;   // voice module absent: the auto-link setting still saves

    /* --- the two controls a rider reaches for in a hurry --- */
    var muteToggle = mkToggle(V.isSelfMuted(), function (v) { V.setSelfMute(v); });
    body.appendChild(mkRow('Mute my mic',
      'Nobody hears you, whatever the mic mode says', muteToggle));

    var deafToggle = mkToggle(V.isDeafened(), function (v) { V.setDeafen(v); });
    body.appendChild(mkRow('Deafen',
      'Silence every rider at once — the calls stay up, so it lifts instantly', deafToggle));

    /* --- output level --- */
    var outVol = U.el('input', 'input');
    outVol.type = 'range'; outVol.min = '0'; outVol.max = '1'; outVol.step = '0.05';
    outVol.value = V.getMasterVolume();
    outVol.style.width = '100%';
    outVol.addEventListener('input', function () { V.setMasterVolume(parseFloat(outVol.value)); });
    body.appendChild(mkField('Voice volume', outVol));

    /* --- live input meter. Self-cleaning: the settings body is destroyed and
       rebuilt on every open, so the loop ends when its own bar leaves the
       document rather than needing a teardown hook. --- */
    var meterWrap = U.el('div', 'vc-meter');
    var meterBar = U.el('div', 'vc-meter-fill');
    meterWrap.appendChild(meterBar);
    body.appendChild(mkField('Input level', meterWrap));
    (function paintMeter() {
      if (meterBar.isConnected === false) return;
      var lvl = V.level ? V.level() : 0;
      // Speech sits low in a linear RMS; scale so normal talking fills the bar.
      var pct = Math.min(100, Math.round(Math.sqrt(lvl) * 140));
      meterBar.style.transform = 'scaleX(' + (pct / 100) + ')';
      meterBar.classList.toggle('hot', pct > 6 && !V.isSelfMuted());
      requestAnimationFrame(paintMeter);
    })();

    /* --- devices --- */
    if (caps.inputPicker || caps.outputPicker) {
      var devHost = U.el('div', 'vc-devices');
      body.appendChild(devHost);
      V.listDevices().then(function (d) {
        if (devHost.isConnected === false) return;
        if (!d.labelled) {
          // Browsers withhold device LABELS until the mic has been granted
          // once. A list of blank entries is useless, so ask instead.
          devHost.appendChild(U.el('div', 'hint-card',
            'Allow the microphone once and your input and output devices will be listed here by name.'));
          return;
        }
        if (caps.inputPicker && d.inputs.length) {
          devHost.appendChild(mkField('Microphone',
            mkDeviceSelect(d.inputs, V.getInputDevice(), 'System default', function (id) {
              V.setInputDevice(id).then(function (r) {
                if (r && r.ok === false && A.ui) A.ui.toast('Could not use that microphone', 'warn');
              });
            })));
        }
        if (caps.outputPicker && d.outputs.length) {
          devHost.appendChild(mkField('Output',
            mkDeviceSelect(d.outputs, V.getOutputDevice(), 'System default', function (id) {
              V.setOutputDevice(id).then(function (r) {
                if (r && r.ok === false && A.ui) A.ui.toast('This browser cannot choose an output device', 'warn');
              });
            })));
        }
      });
    }

    /* --- sound enhancement. Each row appears only where the engine reports
       the constraint, so an unsupported one is absent rather than dead. --- */
    var enh = [];
    if (caps.echoCancellation) enh.push(['ec', 'Echo cancellation', 'Stops the car speakers feeding back into your mic']);
    if (caps.noiseSuppression) enh.push(['ns', 'Noise suppression', 'Cuts road, wind and engine noise']);
    if (caps.autoGainControl) enh.push(['agc', 'Auto level', 'Evens out how loud you come across']);
    if (caps.voiceIsolation) enh.push(['isolation', 'Voice isolation', 'Keeps your voice, drops the rest of the cabin']);
    if (enh.length || caps.leveler) {
      body.appendChild(U.el('div', 'section-label', 'Sound enhancement'));
      enh.forEach(function (row) {
        body.appendChild(mkRow(row[1], row[2],
          mkToggle(V.getEnhancement(row[0]), function (v) { V.setEnhancement(row[0], v); })));
      });
      if (caps.leveler) {
        body.appendChild(mkRow('Even out loud riders',
          'Compresses incoming voice so nobody arrives twice as loud as the rest',
          mkToggle(V.isLeveler(), function (v) { V.setLeveler(v); })));
      }
    }
  }

  // A <select> whose labels differ from its values, plus a leading "system
  // default" row mapping to ''. mkSelect only handles value===label.
  function mkDeviceSelect(list, value, defaultLabel, onChange) {
    var s = U.el('select', 'input select');
    var first = document.createElement('option');
    first.value = ''; first.textContent = defaultLabel;
    if (!value) first.selected = true;
    s.appendChild(first);
    list.forEach(function (d) {
      if (!d.id || d.id === 'default') return;   // 'default' IS the row above
      var o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label || d.id;
      if (d.id === value) o.selected = true;
      s.appendChild(o);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  /* ============================== search ============================== */
  function wireSearch() {
    var input = document.getElementById('search-input');
    var results = document.getElementById('search-results');
    var clearBtn = document.getElementById('search-clear');
    var items = [];

    // Recent destinations — Google-Maps-style history shown when the box is empty
    // or just focused, so common trips are one tap away. Persisted in localStorage.
    var RECENTS_KEY = 'convoy.recents';
    function loadRecents() {
      try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch (e) { return []; }
    }
    function saveRecent(r) {
      var list = loadRecents().filter(function (x) {
        return !(x.label === r.label && Math.abs(x.lng - r.lng) < 1e-6 && Math.abs(x.lat - r.lat) < 1e-6);
      });
      list.unshift({ label: r.label, sub: r.sub, lng: r.lng, lat: r.lat });
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 6))); } catch (e) {}
    }

    // Search-result pin vs. recent-history clock — distinct icons like Google Maps.
    var PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12A7 7 0 0 0 5 9c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/></svg>';
    var CLOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>';
    function addRow(r, icon) {
      var item = U.el('div', 'sr-item',
        '<span class="sr-pin">' + icon + '</span><span class="sr-text"><b>' + U.esc(r.label) + '</b><i>' + U.esc(r.sub || '') + '</i></span>');
      item.setAttribute('role', 'option');
      item.addEventListener('mousedown', function (e) { e.preventDefault(); choose(r); });
      results.appendChild(item);
    }
    // Show/hide the results list with the combobox semantics kept in step — a
    // bare `results.hidden = x` left aria-expanded stuck and screen readers
    // announcing the list as permanently closed.
    function showResults(v) {
      results.hidden = !v;
      input.setAttribute('aria-expanded', String(!!v));
    }
    function showRecents() {
      var rec = loadRecents();
      if (!rec.length) { items = []; showResults(false); return; } // clear so Enter can't pick an invisible stale result
      items = rec;
      results.innerHTML = '';
      results.appendChild(U.el('div', 'sr-head', 'Recent'));
      rec.forEach(function (r) { addRow(r, CLOCK_SVG); });
      showResults(true);
    }

    var run = U.debounce(function () {
      var q = input.value.trim();
      if (q.length < 3) { showRecents(); return; }
      items = []; // previous search's rows are dead the moment a new query is in flight
      showResults(true);
      results.innerHTML = '<div class="sr-loading">Searching…</div>';
      A.routing.geocode(q).then(function (rows) {
        items = rows;
        if (!rows.length) {
          results.innerHTML = '<div class="sr-loading">No places found</div>';
          return;
        }
        results.innerHTML = '';
        rows.forEach(function (r) { addRow(r, PIN_SVG); });
      }).catch(function () {
        items = [];
        results.innerHTML = '<div class="sr-loading">Search unavailable. Check connection</div>';
      });
    }, 350);

    function choose(r) {
      saveRecent(r);
      input.value = r.label;
      showResults(false);
      input.blur();
      A.routing.setDestination([r.lng, r.lat], r.label);
    }

    // Keyboard navigation: Up/Down move a highlight through results, Enter picks
    // the highlighted (or first) one, Escape closes. Acts on a live query of the
    // DOM so it stays correct after each async refresh.
    function moveHighlight(step) {
      var els = results.querySelectorAll('.sr-item');
      if (!els.length) return;
      var cur = results.querySelector('.sr-item.active');
      var idx = cur ? Array.prototype.indexOf.call(els, cur) : -1;
      if (cur) cur.classList.remove('active');
      idx = (idx + step + els.length) % els.length;
      els[idx].classList.add('active');
      els[idx].scrollIntoView({ block: 'nearest' });
      return els[idx];
    }

    input.addEventListener('input', function () {
      clearBtn.hidden = !input.value;
      run();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
      else if (e.key === 'Enter') {
        var active = results.querySelector('.sr-item.active');
        if (active) active.dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
        // Only pick the first row when the list is actually visible — otherwise
        // Enter would navigate to a result the user can no longer see.
        else if (!results.hidden && items.length) choose(items[0]);
      }
      else if (e.key === 'Escape') { showResults(false); input.blur(); }
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { showResults(false); }, 150);
    });
    input.addEventListener('focus', function () {
      if (input.value.trim().length >= 3 && results.children.length) showResults(true);
      else showRecents();
    });
    clearBtn.addEventListener('click', function () {
      input.value = '';
      clearBtn.hidden = true;
      A.routing.clearRoute();
      input.focus();
      showRecents();   // empty box → fall back to recent destinations
    });
  }

  /* ============================== chips ============================== */
  function wireChips() {
    var live = document.getElementById('chip-live');
    var global = document.getElementById('chip-global');
    live.addEventListener('click', function () { openPanel('nearby'); });
    global.addEventListener('click', function () { ST.setShowGlobal(!S.settings.showGlobal); });
    syncGlobalChip();
  }

  function syncGlobalChip() {
    var chip = document.getElementById('chip-global');
    if (!chip) return;
    chip.classList.toggle('chip-off', !S.settings.showGlobal);
    // The chip is a toggle button — aria-pressed is how a screen reader hears the
    // layer flip rather than reading a permanently unpressed button.
    chip.setAttribute('aria-pressed', String(!!S.settings.showGlobal));
  }

  /* ============================== walkie-talkie ============================== */
  // All walkie wiring — PTT hold, Space, and the #wt-cycle mode button — lives in
  // js/voice.js wirePttButton(), which runs from showOverlay(true) before the
  // overlay is ever visible. This used to wire #wt-cycle too, so one tap ran
  // both handlers and skipped a mode (PTT → Toggle) with two toasts.
  function wireWalkieTalkie() { }

  function updateLiveChip() {
    var label = S.netMode === 'live' ? ' riders online' : ' nearby';
    document.getElementById('chip-live-text').textContent = 'LIVE · ' + A.sim.count() + label;
  }

  /* ============================== live invites ============================== */
  function inviteToast(from, party, onAccept, onDecline) {
    // A blocking gate is showing (auth, re-consent, password reset, OAuth setup, or
    // a card that opted out of dismissal): the rider cannot answer this, and its
    // Join/Pass buttons would be the one live thing they could reach around the
    // gate (#toasts is exempt from the shell trap so announcements still work).
    // Declining now is the same outcome the 30-second auto-decline below already
    // produces — a decision the rider could not make anyway, just made sooner.
    if (gateUp()) { if (onDecline) onDecline(); return; }
    var box = document.getElementById('toasts');
    var t = U.el('div', 'toast toast-info toast-invite',
      '<span class="toast-dot"></span><span><b>' + U.esc(from.name) + '</b> invited you to <b>' +
      U.esc(party.name) + '</b></span>');
    var actions = U.el('div', 'toast-actions');
    var yes = U.el('button', 'btn btn-primary btn-small', 'Join');
    var no = U.el('button', 'btn btn-ghost btn-small', 'Pass');
    var done = false;
    function close(cb) {
      if (done) return;
      done = true;
      t.classList.remove('in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 350);
      if (cb) cb();
    }
    yes.addEventListener('click', function () { close(onAccept); });
    no.addEventListener('click', function () { close(onDecline); });
    actions.appendChild(yes);
    actions.appendChild(no);
    t.appendChild(actions);
    box.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('in'); });
    setTimeout(function () { close(onDecline); }, 30000);
  }

  /* ============================== onboarding ============================== */
  /* ============================== auth + onboarding ============================== */
  var authOnDone = null;

  // ui-003: while #onboarding is up, the rest of the shell must be
  // unreachable by keyboard/AT (a trap needs both "can't tab out" and "can't
  // tab into something invisible behind the modal"), and Tab must wrap inside
  // it instead of walking off the end into the page. inert (below) delivers
  // the first two; the keydown handler in wireDock delivers the wrap.
  // overlayDismissable tracks whether Escape/backdrop-click may close what's
  // currently showing: false for every gate screen (auth, re-consent,
  // password reset, OAuth setup — closing those mid-flight strands the rider
  // with no session), true by default for openOverlay's user-initiated cards.
  var overlayDismissable = true;
  var modalLastFocus = null; // element focused before the modal opened, restored on close
  var shellInerted = [];     // exactly what setShellInert(true) touched, so (false)
                              // restores only that — never openPanel's own inert state
  var shellTrapped = false;  // ui-003b: a *chained* open — a second openOverlay() with no
                              // closeOverlay() between — is normal in this codebase (the race
                              // lobby re-renders on every state push, a profile overlay refreshes
                              // on a stats event, block→report, regen-recovery's success card).
                              // Without this flag the second call recomputes shellInerted from
                              // "body children that are not yet inert" — which is now none — so
                              // the list empties and the matching close restores nothing, leaving
                              // all 21 shell children inert until reload. Only the outermost open
                              // captures; only its close restores. A boolean on purpose: not a
                              // depth counter (closeOverlay runs once per dismissal however many
                              // cards were chained — chains replace root.innerHTML, they don't
                              // stack) and not shellInerted.length (which couples "is a trap
                              // active" to "did the capture find anything").
  function setShellInert(on) {
    if (on) {
      if (shellTrapped) return;
      shellTrapped = true;
      shellInerted = [].filter.call(document.body.children, function (el) {
        return el.id !== 'onboarding' && el.id !== 'toasts' &&
          el.tagName !== 'SCRIPT' && el.tagName !== 'NOSCRIPT' &&
          !el.hasAttribute('inert'); // leave openPanel's closed panels alone
      });
      shellInerted.forEach(function (el) { el.setAttribute('inert', ''); });
    } else {
      shellTrapped = false;
      shellInerted.forEach(function (el) { el.removeAttribute('inert'); });
      shellInerted = [];
    }
  }
  // A gate (auth / re-consent / password reset / OAuth setup, or an explicitly
  // non-dismissable card) is up: the rider is not in a position to answer anything.
  // A gate that is already on its way out (.closing — CSS gives it pointer-events:
  // none, so the rider can reach the toasts again) does not count.
  function gateUp() {
    var ob = document.getElementById('onboarding');
    return !!(ob && !ob.hidden && !ob.classList.contains('closing') && !overlayDismissable);
  }
  // #toasts is exempt from setShellInert on purpose — aria-live announcements must
  // still reach AT behind a modal — but inviteToast() puts live Join/Pass buttons in
  // that same container, and a socket push can land one while a gate is up. Only the
  // interactive toasts are inerted, never plain ones, whose whole purpose is to be
  // announced. Kept outside shellInerted / shellTrapped: the off-path is
  // unconditional (nothing else ever inerts a toast), so this is idempotent by
  // construction and cannot interact with the nesting logic above — which is also
  // why a chained {dismissable:false} card opened over a dismissable one (only
  // showRegenRecovery's success card) still re-scans: openOverlay calls this on
  // every open, trapped or not, and inviteToast's own gateUp() check covers every
  // invite that arrives afterwards.
  function setInviteToastsInert(on) {
    var box = document.getElementById('toasts');
    if (!box) return;
    [].forEach.call(box.querySelectorAll('.toast-invite'), function (t) {
      if (on) t.setAttribute('inert', ''); else t.removeAttribute('inert');
    });
  }
  var MODAL_FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  function focusFirstIn(root) {
    var f = root.querySelector(MODAL_FOCUSABLE);
    if (f) { try { f.focus(); } catch (e) {} }
  }
  // Shared open bookkeeping for every non-dismissable gate screen (showAuth,
  // showConsentGate, showResetPassword, showOAuthSetup): trap the shell and
  // force dismissal off, regardless of what the *previous* #onboarding guest
  // (a dismissable openOverlay card) last left overlayDismissable at.
  function beginModalGate() {
    // A gate can open inside a pending close: closeAuthEnter → enterApp → showConsentGate
    // (login never records consent locally, so an existing account on a new device, or any
    // rider after a LEGAL_VERSION bump, gets the re-consent gate synchronously). Left armed,
    // the 380ms hide timer would blank the gate and leave the shell inert. openOverlay
    // already cancels it first; the four gates must too.
    cancelOverlayClose();
    overlayDismissable = false;
    if (!modalLastFocus) modalLastFocus = document.activeElement;
    setShellInert(true);
    setInviteToastsInert(true);
  }

  function showAuth(onDone) {
    authOnDone = onDone || function () { };
    var root = document.getElementById('onboarding');
    beginModalGate();
    root.hidden = false;
    root.classList.remove('closing');
    renderAuth('welcome');
    requestAnimationFrame(function () { root.classList.add('show'); });
  }

  function closeAuthEnter(msg) {
    var root = document.getElementById('onboarding');
    A.mapview.refreshPlayer();
    refreshAvatarBtn();
    buildProfilePanel(); // re-render whichever profile page is showing
    renderAccount();
    refreshVerifyBanner();
    // Same guarded teardown as closeOverlay: done() below is auth.enterApp,
    // which may open another card straight away (the /delete-account deep link
    // resumes there after sign-in). An unguarded timer would blank it mid-flight.
    cancelOverlayClose();
    root.classList.add('closing');
    setShellInert(false);
    setInviteToastsInert(false);
    if (modalLastFocus) { try { modalLastFocus.focus(); } catch (e) {} modalLastFocus = null; }
    overlayCloseTimer = setTimeout(function () {
      overlayCloseTimer = null;
      root.hidden = true; root.innerHTML = '';
      root.classList.remove('closing', 'show');
    }, 380);
    if (msg) toast(msg, 'success');
    var done = authOnDone; authOnDone = null;
    if (done) done();
  }

  function authHeader() {
    return '<div class="ob-head">' +
      '  <div class="ob-logo">' + document.querySelector('.brand-logo').outerHTML + '</div>' +
      '  <h1>CONVOY</h1>' +
      '  <p>See the road together. Built for <b>passengers</b>, so the driver drives and you run the map.</p>' +
      '</div>';
  }

  // `backTo` is the auth screen the arrow returns to; the flows are nested now
  // (welcome → login → forgot), so "back" is no longer always the welcome card.
  function authBackHead(title, backTo) {
    var head = U.el('div', 'auth-head2');
    var back = U.el('button', 'auth-back', '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>');
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', function () { renderAuth(backTo || 'welcome'); });
    head.appendChild(back);
    head.appendChild(U.el('h2', 'auth-title', U.esc(title)));
    return head;
  }

  /* ---------------- social sign-in buttons ----------------
     Only the providers /api/auth/config reports are ever drawn: a button that
     dead-ends at "provider not enabled" is worse than no button at all. */

  // Recognisable marks for the providers people actually look for; everything
  // else gets a lettered badge, which is honest and costs nothing.
  var PROVIDER_MARKS = {
    google: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/>' +
      '<path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"/>' +
      '<path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1z"/>' +
      '<path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"/></svg>',
    apple: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
      '<path d="M16.4 12.7c0-2.4 2-3.6 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.6.9s-1.9-.9-3.1-.8c-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.6.8 1.2 1.7 2.5 3 2.4 1.2 0 1.6-.8 3.1-.8s1.9.8 3.1.7c1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7 0 0-2.5-1-2.6-3.9zM14 5.4c.7-.8 1.1-1.9 1-3-1 0-2.2.7-2.9 1.5-.6.7-1.1 1.9-1 3 1.1.1 2.2-.6 2.9-1.5z"/></svg>',
    github: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.8 2.7 1.3 3.4 1 .1-.7.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.3 11.3 0 0 1 6 0C17.5 4.8 18.5 5 18.5 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>',
    discord: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#5865F2" aria-hidden="true">' +
      '<path d="M20.3 4.5A19.8 19.8 0 0 0 15.4 3l-.3.5c1.7.4 2.6 1 3.5 1.7a12.4 12.4 0 0 0-9.2 0c.9-.7 1.9-1.3 3.5-1.7L12.6 3a19.8 19.8 0 0 0-4.9 1.5C4.5 9.2 3.6 13.8 4 18.3a19.9 19.9 0 0 0 6 3l1.3-2c-.7-.3-1.4-.6-2-1l.5-.4a14.2 14.2 0 0 0 12.1 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.9 19.9 0 0 0 6-3c.5-5.2-.8-9.8-3.4-13.8zM9.7 15.5c-1.2 0-2.1-1.1-2.1-2.4S8.5 10.7 9.7 10.7s2.1 1.1 2.1 2.4-.9 2.4-2.1 2.4zm4.6 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.1 1.1 2.1 2.4-.9 2.4-2.1 2.4z"/></svg>'
  };

  function providerMark(id, label) {
    if (U.own(PROVIDER_MARKS, id)) return PROVIDER_MARKS[id];
    return '<span class="oauth-letter">' + U.esc(String(label || id).charAt(0).toUpperCase()) + '</span>';
  }

  // Renders the provider buttons into `card`, if any are enabled. `verb` reads
  // "Continue with Google" on the welcome card and "Sign in with Google" on the
  // login card. Returns the number drawn so the caller knows whether to add a
  // divider above the email fields.
  function addProviderButtons(card, cfg, verb) {
    var list = (cfg && cfg.providers) || [];
    if (!list.length) return 0;
    var wrap = U.el('div', 'oauth-row');
    list.forEach(function (p) {
      var b = U.el('button', 'btn btn-oauth btn-block',
        providerMark(p.id, p.label) + '<span>' + U.esc(verb + ' ' + p.label) + '</span>');
      b.addEventListener('click', function () {
        b.disabled = true;
        A.auth.oauthStart(p.id).then(function (r) {
          if (!r.ok) { b.disabled = false; toast(r.error, 'warn'); return; }
          // On the web the page is navigating away, so leaving the button
          // disabled is right. In the APK the sign-in happens in a Custom Tab
          // over a still-running app: put the button back, or a rider who backs
          // out of the browser returns to a screen they can no longer use.
          if (r.pending) b.disabled = false;
        });
      });
      wrap.appendChild(b);
    });
    card.appendChild(wrap);
    return list.length;
  }

  /* App Store guideline 4.8: an app that offers a third-party sign-in (Google,
     GitHub, …) on iOS must offer Sign in with Apple beside it. The username +
     password and email paths are the app's own and are exempt — so on iOS the
     social buttons are drawn only when Apple is among the enabled providers;
     a deployment that enables Google alone falls back to the first-party
     paths rather than shipping a build the review would reject. Android and
     the web are untouched (the list is drawn as the server sent it). */
  function applyAppleSignInRule(cfg) {
    if (!cfg || !A.config || A.config.platform !== 'ios') return cfg;
    var list = cfg.providers || [];
    var hasApple = list.some(function (p) { return p && p.id === 'apple'; });
    if (hasApple || !list.length) return cfg;
    return Object.assign({}, cfg, { providers: [] });
  }

  // Cached across renders — renderAuth redraws on every step and this must not
  // refetch each time. A.auth.config() caches too; this keeps it synchronous so
  // the card can be built in one pass without a loading flash.
  var authCfg = { providers: [], email: false, magicLink: false };
  var authCfgLoaded = false;
  // buildCarSetup() reads the lazy name/make/paint/vibe catalog synchronously.
  // Only register/guest/showOAuthSetup need it — welcome/login etc. don't, so
  // they must not wait on it. .catch keeps a failed fetch from ever rejecting;
  // buildCarSetup's own seed covers that case.
  function withCatalog(fn) { A.data.ensure().catch(function () { return null; }).then(fn); }

  function withAuthConfig(fn) {
    A.auth.config().then(function (cfg) { authCfg = applyAppleSignInRule(cfg); authCfgLoaded = true; fn(authCfg); });
  }

  var errSeq = 0;
  function showErr(el, msg, bad) {
    if (!el) return;
    el.textContent = msg || 'Something went wrong';
    el.hidden = false;
    if (!bad) return; // ui-012: the input(s) at fault say so and point AT at this line
    if (!el.id) el.id = 'auth-err-' + (++errSeq);
    bad.forEach(function (i) { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', el.id); });
  }

  function mkPassword(placeholder) {
    var i = U.el('input', 'input');
    i.type = 'password';
    i.placeholder = placeholder || 'Password';
    i.autocomplete = 'current-password';
    i.maxLength = 200;
    return i;
  }

  // Last-resort seed for a failed js/data.js load (withCatalog's .catch) —
  // same bug class as renderConvoy() (cycle 8).
  var FALLBACK_NAMES = ['Rider', 'Ace', 'Nomad'];
  var FALLBACK_MAKES = { Toyota: ['Camry', 'Corolla', 'RAV4'], Honda: ['Civic', 'Accord', 'CR-V'] };
  var FALLBACK_MAKE_LIST = Object.keys(FALLBACK_MAKES);
  var FALLBACK_PAINTS = [{ hex: '#1a1a1a', name: 'Black' }, { hex: '#ffffff', name: 'White' }];
  var FALLBACK_VIBES = ['Cruising'];

  // Reusable car-setup fields (name, avatar, car, paint, pledge). Returns getProfile()+onPledge().
  function buildCarSetup(card, defaults) {
    // `defaults.name` pre-fills the display name — used after a provider sign-in,
    // where the provider already told us what this person calls themselves. It is
    // only ever a starting value; the field stays editable.
    var names = (D.NAMES && D.NAMES.length) ? D.NAMES : FALLBACK_NAMES;
    var makeList = (D.MAKE_LIST && D.MAKE_LIST.length) ? D.MAKE_LIST : FALLBACK_MAKE_LIST;
    var makes = (makeList === D.MAKE_LIST) ? D.MAKES : FALLBACK_MAKES;
    var paints = (D.PAINTS && D.PAINTS.length) ? D.PAINTS : FALLBACK_PAINTS;

    var name = (defaults && defaults.name) || U.pick(names);
    var make = U.pick(makeList);
    var model = U.pick(makes[make]);
    var paint = U.pick(paints);

    var nameInput = mkText(name, 'Display name');
    var emojiGrid = mkEmojiGrid(0);
    var yearSel = mkSelect(yearList(), 2022);
    var makeSel = mkSelect(makeList, make);
    var modelSel = mkSelect(makes[make], model);
    var trimSel = mkSelect(trimsFor(make, model));
    var paintHex = paint.hex, paintName = paint.name;
    var swatches = mkSwatches(paints, paintHex, function (hex, n) { paintHex = hex; paintName = n; });

    function refillTrims() {
      trimSel.innerHTML = '';
      trimsFor(makeSel.value, modelSel.value).forEach(function (t) {
        var o = document.createElement('option'); o.value = t; o.textContent = t; trimSel.appendChild(o);
      });
    }
    makeSel.addEventListener('change', function () {
      modelSel.innerHTML = '';
      modelsFor(makeSel.value).forEach(function (m) {
        var o = document.createElement('option'); o.value = m; o.textContent = m; modelSel.appendChild(o);
      });
      refillTrims();
    });
    modelSel.addEventListener('change', refillTrims);

    card.appendChild(mkField('Display name', nameInput));
    card.appendChild(mkField('Avatar', emojiGrid));
    var g3 = U.el('div', 'grid3');
    g3.appendChild(mkField('Year', yearSel));
    g3.appendChild(mkField('Make', makeSel));
    g3.appendChild(mkField('Model', modelSel));
    card.appendChild(g3);
    card.appendChild(mkField('Trim', trimSel));
    card.appendChild(mkField('Paint', swatches));

    var consent = buildConsentBlock(card);

    return {
      getConsent: consent.get,
      getProfile: function () {
        var nm = nameInput.value.trim() || name;
        return {
          name: nm,
          handle: nm.toLowerCase().replace(/[^a-z0-9]/g, ''),
          emoji: emojiGrid.getValue(),
          vibe: U.pick((D.VIBES && D.VIBES.length) ? D.VIBES : FALLBACK_VIBES),
          car: {
            year: +yearSel.value, make: makeSel.value, model: modelSel.value,
            trim: trimSel.value || '',
            paint: paintHex, paintName: paintName, finish: 'Gloss'
          }
        };
      },
      onPledge: consent.onChange
    };
  }

  /* Absolute URL for a legal page.

     On the web this is same-origin and the leading slash is enough. Inside the
     APK the WebView origin is https://localhost, where "/terms" is a dead link —
     only index.html, js/ and css/ are bundled (scripts/copy-web.js). These pages
     have to resolve against the deployed site, which is exactly what
     A.config.base is for. Every legal link in the app goes through here. */
  function legalUrl(p) { return ((A.config && A.config.base) || '') + p; }

  /* ---------------- feature legality notices ----------------
     Some of what a feature pack adds is lawful in one place and an offence a
     border away — enforcement markers, scanner audio in a moving car, a timed
     run. Terms §5 says so, but a feature someone taps on impulse deserves the
     notice at that moment, in plain words. Packs register their notice with
     registerFeatureNotice(key, { title, lede, points }) and call
     legalGate(key, proceed, cancel) before switching the feature on.

     Once per feature per Terms version (ST.featureAcked), not every time: a
     notice that fires on every tap gets dismissed unread, which is worse than
     no notice at all. */
  var FEATURE_NOTICES = {};
  function registerFeatureNotice(key, spec) {
    if (typeof key !== 'string' || !spec || typeof spec !== 'object') return;
    FEATURE_NOTICES[key] = {
      title: String(spec.title || 'Before you turn this on'),
      lede: String(spec.lede || ''),
      points: Array.isArray(spec.points) ? spec.points.map(String) : []
    };
  }
  // Runs `onProceed` once the rider has acknowledged — immediately if they
  // already have. `onCancel` is optional: callers that toggled something on
  // before asking use it to put the control back.
  function legalGate(key, onProceed, onCancel) {
    var spec = FEATURE_NOTICES[key];
    if (!spec || (ST.featureAcked && ST.featureAcked(key))) { onProceed(); return; }

    var card = U.el('div', 'modal-card');
    card.appendChild(U.el('div', 'auth-title', spec.title));
    if (spec.lede) card.appendChild(U.el('div', 'ob-note', spec.lede));

    var warn = U.el('div', 'consent-warn');
    warn.innerHTML = '<b>Where you are decides whether this is legal.</b>' +
      '<span>Convoy makes it available. Knowing the rule is on you.</span>';
    card.appendChild(warn);

    if (spec.points.length) {
      var list = U.el('ul', 'legal-list');
      spec.points.forEach(function (p) { list.appendChild(U.el('li', '', p)); });
      card.appendChild(list);
    }

    card.appendChild(U.el('div', 'ob-note',
      'Full detail in <a href="' + legalUrl('/terms#features') + '" target="_blank" rel="noopener">Terms &sect;5</a>.'));

    var ok = U.el('button', 'btn btn-primary btn-block btn-lg', 'I understand — it\'s legal where I am');
    ok.addEventListener('click', function () {
      ST.ackFeature(key);
      closeOverlay();
      onProceed();
    });
    card.appendChild(ok);

    var no = U.el('button', 'btn btn-ghost btn-block', 'Not now');
    no.addEventListener('click', function () {
      closeOverlay();
      if (onCancel) onCancel();
    });
    card.appendChild(no);

    openOverlay(card);
  }

  /* ---------------- Settings → Feature packs ----------------
     The one screen that explains the pack system to a rider (and to a store
     reviewer): what packs exist, which this account holds, and where a code
     goes. Packs are served by our server to the account that unlocked them;
     nothing in a pack is in the app you installed. Always rendered, signed in
     or not, so there is nothing hidden about it. */
  function buildPackSection(body) {
    body.appendChild(U.el('div', 'section-label', 'Feature packs'));
    var host = U.el('div', 'packs-host');
    body.appendChild(host);
    renderPackSection(host);
    // Re-render while this box is on screen: a redeem on this device, a sign-in
    // or sign-out, or a pack finishing its load all change what it shows.
    var off = ST.on('packs', function () {
      if (!host.isConnected) { off(); return; }
      renderPackSection(host);
    });
    if (A.packs && !(A.auth && A.auth.isLoggedIn())) {
      A.packs.ensureCatalog().then(function () { if (host.isConnected) renderPackSection(host); });
    }
  }

  function renderPackSection(host) {
    host.innerHTML = '';
    var P = A.packs;
    var st = P ? P.state() : { signedIn: false, held: [], loaded: [], packs: [], available: [] };
    var signedIn = !!(A.auth && A.auth.isLoggedIn());

    host.appendChild(U.el('div', 'hint-card',
      'Packs add features that are not part of the app you installed — they are sent to your ' +
      'account by our server once you redeem a code, and load when you sign in. ' +
      'A pack can stop at any time if its code is withdrawn.'));

    var list = U.el('div', 'packs-list');
    var rows = st.packs.map(function (p) { return { p: p, held: true, loaded: st.loaded.indexOf(p.id) >= 0 }; })
      .concat((st.available || []).map(function (p) { return { p: p, held: false, loaded: false }; }));
    if (!rows.length) list.appendChild(U.el('div', 'packs-empty', 'No packs are offered right now.'));
    rows.forEach(function (r) {
      var row = U.el('div', 'pack-row' + (r.held ? ' pack-row-held' : ''));
      var txt = U.el('div', 'pack-txt');
      txt.appendChild(U.el('b', '', r.p.title || r.p.id));
      if (r.p.blurb) txt.appendChild(U.el('i', '', r.p.blurb));
      row.appendChild(txt);
      row.appendChild(U.el('span', 'pack-badge' + (r.held ? ' on' : ''),
        r.held ? (r.loaded ? 'Unlocked' : 'Loading…') : 'Locked'));
      list.appendChild(row);
    });
    host.appendChild(list);

    var form = U.el('form', 'packs-redeem');
    form.setAttribute('autocomplete', 'off');
    var lab = U.el('label', 'packs-redeem-label', 'Redeem a code');
    var inp = U.el('input', 'input packs-code');
    inp.type = 'text'; inp.placeholder = 'CONVOY-XXXX-XXXX-XXXX-XXXX'; inp.maxLength = 32;
    inp.setAttribute('spellcheck', 'false'); inp.setAttribute('autocapitalize', 'characters');
    inp.setAttribute('aria-label', 'Feature pack code');
    var btn = U.el('button', 'btn btn-primary', 'Redeem');
    btn.type = 'submit';
    form.appendChild(lab);
    var rowf = U.el('div', 'packs-redeem-row');
    rowf.appendChild(inp); rowf.appendChild(btn);
    form.appendChild(rowf);
    if (!signedIn) {
      inp.disabled = true; btn.disabled = true;
      form.appendChild(U.el('div', 'packs-note', 'Sign in to redeem a code — a pack is unlocked on an account, not a device.'));
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!P || !signedIn) return;
      var code = inp.value.trim();
      if (!code) { inp.focus(); return; }
      btn.disabled = true; btn.textContent = 'Checking…';
      P.redeem(code).then(function (r) {
        inp.value = '';
        toast(r.granted.length
          ? 'Unlocked: ' + r.granted.join(', ')
          : 'That code adds nothing new to this account', r.granted.length ? 'success' : 'info');
        if (A.telemetry) A.telemetry.track('pack_unlock', { n: r.granted.length });
      }).catch(function (e) {
        toast((e && e.message) || 'Could not redeem that code', 'warn');
      }).then(function () {
        btn.disabled = false; btn.textContent = 'Redeem';
        if (host.isConnected) renderPackSection(host);
      });
    });
    host.appendChild(form);

    host.appendChild(U.el('div', 'packs-note',
      'Some packs cover features that are regulated in some places. Each one explains the rules ' +
      'before it switches on, and Terms &sect;5 applies to all of them.'));
  }

  /* ---------------- the consent gate ----------------
     Three separate confirmations, deliberately not one blanket "I agree":

       passenger — the safety condition the whole product rests on, and the one
                   claim we actually rely on. Terms §3.
       age       — 16+, because the app carries live location, open chat, voice
                   and user-generated reports. COPPA/GDPR Art. 8 and the store
                   policies all turn on it.
       terms     — acceptance of the Terms and the Privacy Policy, which is what
                   makes §7's "we hold your account" disclosure something the
                   rider has actually been told rather than something buried.

     Ticking all three is what enables the button, and the result is recorded
     with the document version and a timestamp (ST.setConsent) so there is a
     record of WHICH terms were accepted, not just that something was. */
  function buildConsentBlock(card) {
    var box = U.el('div', 'consent-block');

    var driveWarn = U.el('div', 'consent-warn');
    driveWarn.innerHTML =
      '<b>If you\'re driving, put the phone down.</b>' +
      '<span>Convoy is built for the passenger. Never operate it, look at it, or ' +
      'react to it while you\'re in control of a moving vehicle.</span>';
    box.appendChild(driveWarn);

    function row(html) {
      var l = U.el('label', 'consent-row');
      l.innerHTML = '<input type="checkbox" aria-required="true"/><span>' + html + '</span>';
      box.appendChild(l);
      return l.querySelector('input');
    }

    var cbPassenger = row('I\'m the <b>passenger</b>, or the car is parked. ' +
      'The driver\'s eyes stay on the road.');
    var cbAge = row('I\'m <b>16 or older</b>.');
    var cbTerms = row('I agree to the <a href="' + legalUrl('/terms') + '" target="_blank" rel="noopener">Terms of Service</a> ' +
      'and the <a href="' + legalUrl('/privacy') + '" target="_blank" rel="noopener">Privacy Policy</a>.');

    var hold = U.el('div', 'consent-note');
    hold.innerHTML =
      '<b>What we hold.</b> If you create an account, we store it on our servers — ' +
      'your username, profile, car, friends, stats, and your email if you give one — ' +
      'until you delete it. Riders near you see your live location while you\'re on ' +
      'the map. We don\'t keep location history, we don\'t record voice, and we ' +
      'don\'t sell anything. You can delete the account yourself at any time from ' +
      'Settings, or at <a href="' + legalUrl('/delete-account') + '" target="_blank" rel="noopener">/delete-account</a>.';
    box.appendChild(hold);

    card.appendChild(box);

    var listeners = [];
    function allChecked() { return cbPassenger.checked && cbAge.checked && cbTerms.checked; }
    function fire() { listeners.forEach(function (fn) { fn(allChecked()); }); }
    [cbPassenger, cbAge, cbTerms].forEach(function (cb) { cb.addEventListener('change', fire); });

    return {
      onChange: function (fn) { listeners.push(fn); },
      allChecked: allChecked,
      get: function () {
        return { passenger: cbPassenger.checked, age: cbAge.checked, terms: cbTerms.checked };
      }
    };
  }

  /* ---------------- re-consent, for riders already inside ----------------
     A returning rider carries a consent record from a previous session. If the
     documents have been revised since (ST.LEGAL_VERSION moved) that record no
     longer covers what they are agreeing to, so this stands in front of the app
     until they accept again. Same three boxes, no way past it but forward or
     out — an "ignore" option would leave someone using the app under terms they
     have declined. */
  function showConsentGate(onDone) {
    var root = document.getElementById('onboarding');
    var card = U.el('div', 'modal-card');
    card.appendChild(U.el('div', 'auth-title', S.consent ? 'Our terms have changed' : 'Before you ride'));
    card.appendChild(U.el('div', 'ob-note', S.consent
      ? 'We\'ve updated the Terms of Service and Privacy Policy. Please read them and ' +
        'confirm below to carry on riding.'
      : 'Two quick confirmations and one agreement, and you\'re on the map.'));

    var consent = buildConsentBlock(card);
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Agree &amp; continue');
    btn.disabled = true;
    consent.onChange(function (ok) { btn.disabled = !ok; });
    btn.addEventListener('click', function () {
      ST.setConsent(consent.get());
      closeOverlay();
      if (onDone) onDone();
    });
    card.appendChild(btn);

    // Declining has to lead somewhere honest: without consent there is no
    // lawful basis to put this rider on the map, so the only other door is out.
    var out = U.el('button', 'btn btn-ghost btn-block btn-danger-text', 'I don\'t agree');
    out.addEventListener('click', function () {
      if (!confirm('Without agreeing you can\'t use Convoy. Sign out and clear this device?')) return;
      if (A.auth && A.auth.isLoggedIn()) A.auth.logout();
      else ST.reset();
    });
    card.appendChild(out);

    beginModalGate();
    root.hidden = false;
    root.classList.remove('closing');
    root.innerHTML = '';
    root.appendChild(card);
    root.scrollTop = 0;
    requestAnimationFrame(function () { root.classList.add('show'); });
    focusFirstIn(root);
  }

  /* ----- generic overlay (reuses the modal backdrop while logged in) ----- */
  /* closeOverlay() hides the card immediately but defers the teardown by 380ms so
     the exit animation can play. That timer used to be fire-and-forget, which
     made any overlay opened during those 380ms self-destruct: the stale timeout
     lands and blanks the modal root that now holds the NEW card.

     It is reachable from every close→open handoff — accepting the consent gate
     and continuing into the delete-account screen, re-rendering the linked
     accounts list, a legality notice whose "proceed" opens another card. Holding
     the handle and cancelling it in openOverlay is what makes those safe. */
  var overlayCloseTimer = null;

  function cancelOverlayClose() {
    if (overlayCloseTimer) { clearTimeout(overlayCloseTimer); overlayCloseTimer = null; }
  }

  function openOverlay(card, opts) {
    var root = document.getElementById('onboarding');
    cancelOverlayClose();
    overlayDismissable = !opts || opts.dismissable !== false;
    if (!modalLastFocus) modalLastFocus = document.activeElement;
    setShellInert(true);
    // Mirrors the flag exactly: a non-dismissable card is a gate (invites on screen
    // go inert), a dismissable one is not (the off-path is an idempotent no-op).
    setInviteToastsInert(!overlayDismissable);
    root.hidden = false;
    root.classList.remove('closing');
    root.innerHTML = '';
    root.appendChild(card);
    requestAnimationFrame(function () { root.classList.add('show'); });
    focusFirstIn(root);
  }
  function closeOverlay() {
    var root = document.getElementById('onboarding');
    cancelOverlayClose();
    root.classList.add('closing');
    setShellInert(false);
    setInviteToastsInert(false);
    if (modalLastFocus) { try { modalLastFocus.focus(); } catch (e) {} modalLastFocus = null; }
    overlayCloseTimer = setTimeout(function () {
      overlayCloseTimer = null;
      root.hidden = true; root.innerHTML = '';
      root.classList.remove('closing', 'show');
    }, 380);
  }

  // "We've sent you something" — the terminal screen of every flow that hands
  // off to an inbox. Deliberately says nothing about whether the address exists.
  function buildSentCard(title, message, buttonLabel, onContinue) {
    var card = U.el('div', 'modal-card');
    card.appendChild(U.el('div', 'auth-title', U.esc(title)));
    card.appendChild(U.el('div', 'ob-note', U.esc(message)));
    card.appendChild(U.el('div', 'ob-note',
      'Not there in a minute or two? Check your spam folder.'));
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', buttonLabel);
    btn.addEventListener('click', onContinue);
    card.appendChild(btn);
    return card;
  }

  /* ---------------- provider sign-in: the missing half ----------------
     A provider tells us who someone is, not what they drive or what to call
     them on the map. This is the step that turns a GoTrue user into a Convoy
     account, and until it finishes the session resolves to nothing — so it is
     also what boot() resumes into if the rider closed the tab halfway. */
  function showOAuthSetup(info, onDone) {
    authOnDone = onDone || function () { };
    var root = document.getElementById('onboarding');
    var card = U.el('div', 'modal-card');
    var sug = (info && info.suggested) || {};

    card.appendChild(U.el('div', 'auth-title', 'Almost there'));
    card.appendChild(U.el('div', 'ob-note',
      info && info.email
        ? 'Signed in as <b>' + U.esc(info.email) + '</b>. Pick the name other riders see and set up your car.'
        : 'Pick the name other riders see and set up your car.'));

    var uInput = mkText(sug.username || '', 'Pick a username');
    uInput.autocomplete = 'username';
    uInput.maxLength = 20;
    var errEl = U.el('div', 'auth-err'); errEl.hidden = true;
    card.appendChild(mkField('Username', uInput));
    card.appendChild(errEl);
    card.appendChild(U.el('div', 'section-label', 'Your ride'));

    // Bypasses withAuthConfig (entered straight from js/auth.js) but still
    // needs the catalog buildCarSetup() reads.
    withCatalog(function () {
      var setup = buildCarSetup(card, { name: sug.name });
      var btn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Finish &amp; ride →');
      btn.disabled = true;
      setup.onPledge(function (ok) { btn.disabled = !ok; });
      btn.addEventListener('click', function () {
        errEl.hidden = true;
        if (!uInput.value.trim()) { showErr(errEl, 'Pick a username'); return; }
        // Recorded before the account exists: the boxes were ticked on this
        // screen, and the record has to survive even if the call below fails and
        // they retry.
        ST.setConsent(setup.getConsent());
        btn.disabled = true; btn.textContent = 'Setting up…';
        A.auth.oauthComplete(uInput.value.trim(), setup.getProfile()).then(function (r) {
          if (!r.ok) {
            showErr(errEl, r.error);
            btn.disabled = false; btn.innerHTML = 'Finish &amp; ride →';
            return;
          }
          root.innerHTML = '';
          root.appendChild(buildRecoveryCard(r.recoveryCode, 'I saved it, start riding →',
            function () { closeAuthEnter('Welcome, ' + S.profile.name); },
            'You\'re in. Save your recovery code',
            'Providers go down and accounts get locked. This is your way back in that doesn\'t depend on one.'));
          root.scrollTop = 0;
          focusFirstIn(root);
        });
      });
      card.appendChild(btn);

      beginModalGate();
      root.hidden = false;
      root.classList.remove('closing');
      root.innerHTML = '';
      root.appendChild(card);
      root.scrollTop = 0;
      requestAnimationFrame(function () { root.classList.add('show'); });
      focusFirstIn(root);
    });
  }

  // Landing screen for a password-reset link. The token has already been pulled
  // out of the URL by auth.js by the time this runs.
  function showResetPassword(token, onDone) {
    authOnDone = onDone || function () { };
    var root = document.getElementById('onboarding');
    var card = U.el('div', 'modal-card');
    card.appendChild(U.el('div', 'auth-title', 'Choose a new password'));
    card.appendChild(U.el('div', 'ob-note',
      'This signs you in and signs every other device out.'));
    var np = mkPassword('New password (6+ characters)');
    np.autocomplete = 'new-password';
    var err = U.el('div', 'auth-err'); err.hidden = true;
    card.appendChild(mkField('New password', np));
    card.appendChild(err);
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Set password &amp; sign in');
    var submit = function () {
      err.hidden = true;
      if (!np.value) { showErr(err, 'Enter a new password'); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      A.auth.resetWithToken(token, np.value).then(function (r) {
        if (r.ok) { closeAuthEnter('Password updated. Welcome back'); return; }
        showErr(err, r.error);
        btn.disabled = false; btn.innerHTML = 'Set password &amp; sign in';
      });
    };
    btn.addEventListener('click', submit);
    np.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    card.appendChild(btn);
    // A dead link has to lead somewhere, or the rider is stuck on this card.
    var back = U.el('button', 'btn btn-ghost btn-block', 'Back to sign-in');
    back.addEventListener('click', function () { renderAuth('login'); });
    card.appendChild(back);

    beginModalGate();
    root.hidden = false;
    root.classList.remove('closing');
    root.innerHTML = '';
    root.appendChild(card);
    root.scrollTop = 0;
    requestAnimationFrame(function () { root.classList.add('show'); });
    focusFirstIn(root);
  }

  function buildRecoveryCard(code, continueLabel, onContinue, title, subtitle) {
    var card = U.el('div', 'modal-card');
    card.appendChild(U.el('div', 'auth-title', U.esc(title || 'Save your recovery code')));
    if (subtitle) card.appendChild(U.el('div', 'ob-note', subtitle));
    var box = U.el('div', 'recovery-box');
    box.innerHTML = '<div class="recovery-code">' + U.esc(code) + '</div>';
    var copy = U.el('button', 'btn btn-ghost btn-small', 'Copy');
    copy.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(code);
      copy.textContent = 'Copied ✓';
      setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
    });
    box.appendChild(copy);
    card.appendChild(box);
    card.appendChild(U.el('div', 'recovery-warn',
      'This is the <b>only</b> way to reset your password if you forget it. Save it somewhere safe. We can\'t recover it for you.'));
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', continueLabel);
    btn.addEventListener('click', onContinue);
    card.appendChild(btn);
    return card;
  }

  function showChangePassword() {
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('Change password', closeOverlay));
    var oldP = mkPassword('Current password');
    var newP = mkPassword('New password (6+ characters)'); newP.autocomplete = 'new-password';
    var err = U.el('div', 'auth-err'); err.hidden = true;
    card.appendChild(mkField('Current password', oldP));
    card.appendChild(mkField('New password', newP));
    card.appendChild(err);
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Update password');
    btn.addEventListener('click', function () {
      err.hidden = true;
      if (!oldP.value || !newP.value) { showErr(err, 'Fill in both fields'); return; }
      btn.disabled = true; btn.textContent = 'Updating…';
      A.auth.changePassword(oldP.value, newP.value).then(function (r) {
        if (r.ok) { closeOverlay(); toast('Password updated', 'success'); }
        else { showErr(err, r.error); btn.disabled = false; btn.textContent = 'Update password'; }
      });
    });
    card.appendChild(btn);
    openOverlay(card);
  }

  /* ---------------- delete account (right to erasure) ----------------
     Reachable from Settings → Legal & data, and from the public
     /delete-account page via ?cv=delete. Both are required: Google Play wants an
     in-app path AND a web path that works without installing the app.

     Three deliberate frictions before the button does anything: it says exactly
     what goes, it re-authenticates, and it asks for the word DELETE. All three
     are re-checked server-side — this screen is the explanation, not the
     enforcement. */
  function showDeleteAccount() {
    if (!A.auth || !A.auth.isLoggedIn()) {
      toast('Sign in first — there\'s no account to delete', 'warn');
      return;
    }
    var viaProvider = A.auth.provider() !== 'password';
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('Delete your account', closeOverlay));

    var warn = U.el('div', 'consent-warn consent-warn-danger');
    warn.innerHTML = '<b>This is permanent. We can\'t undo it.</b>' +
      '<span>Deleting @' + U.esc(A.auth.username()) + ' erases it from our servers ' +
      'straight away, and your username goes back in the pool.</span>';
    card.appendChild(warn);

    card.appendChild(U.el('div', 'section-label', 'What gets deleted'));
    var list = U.el('ul', 'legal-list');
    list.innerHTML =
      '<li>Your username, password and recovery code</li>' +
      '<li>Your email address and any pending links</li>' +
      '<li>Your profile — name, handle, avatar, vibe</li>' +
      '<li>Your garage — every car detail you entered</li>' +
      '<li>Your friends and friend requests, both directions</li>' +
      '<li>Your stats and personal bests</li>';
    card.appendChild(list);
    card.appendChild(U.el('div', 'ob-note',
      'We never stored your location history or your voice, so there\'s nothing of ' +
      'those to remove. Encrypted backups roll off within 30 days. Messages already ' +
      'delivered to other riders stay on their devices. ' +
      '<a href="' + legalUrl('/privacy') + '" target="_blank" rel="noopener">Privacy Policy</a>'));

    var err = U.el('div', 'auth-err'); err.hidden = true;
    var pw = null, un = null;
    if (viaProvider) {
      // A provider account has no Convoy password to confirm with, so the check
      // is that they can name the account they are standing in.
      un = mkText('', 'Type your username');
      un.autocomplete = 'off';
      un.maxLength = 20;
      card.appendChild(mkField('Confirm your username', un));
      card.appendChild(U.el('div', 'ob-note',
        'This account signs in with ' + U.esc(A.auth.provider()) + ', so there\'s no ' +
        'Convoy password to check. Deleting here does not touch your ' +
        U.esc(A.auth.provider()) + ' account.'));
    } else {
      pw = mkPassword('Your password');
      card.appendChild(mkField('Confirm your password', pw));
    }

    var typed = mkText('', 'DELETE');
    typed.autocomplete = 'off';
    typed.maxLength = 10;
    card.appendChild(mkField('Type DELETE to confirm', typed));
    card.appendChild(err);

    var btn = U.el('button', 'btn btn-block btn-lg btn-danger', 'Delete my account permanently');
    btn.disabled = true;
    var recheck = function () {
      var filled = viaProvider ? !!un.value.trim() : !!pw.value;
      btn.disabled = !(filled && typed.value.trim().toUpperCase() === 'DELETE');
    };
    typed.addEventListener('input', recheck);
    (viaProvider ? un : pw).addEventListener('input', recheck);

    btn.addEventListener('click', function () {
      err.hidden = true;
      if (!confirm('Last check: permanently delete @' + A.auth.username() + '? This cannot be undone.')) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      A.auth.deleteAccount(viaProvider
        ? { confirmUsername: un.value.trim() }
        : { password: pw.value }
      ).then(function (r) {
        if (!r.ok) {
          showErr(err, r.error);
          btn.disabled = false; btn.textContent = 'Delete my account permanently';
          return;
        }
        // The account is gone and the session with it. Clear this device too, so
        // nothing is left pointing at an identity that no longer exists — and
        // because someone deleting their account rarely wants their old profile
        // waiting for them on the next load.
        ST.reset();
      });
    });
    card.appendChild(btn);

    var cancel = U.el('button', 'btn btn-ghost btn-block', 'Keep my account');
    cancel.addEventListener('click', closeOverlay);
    card.appendChild(cancel);

    openOverlay(card);
  }

  function showRegenRecovery() {
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('New recovery code', closeOverlay));
    card.appendChild(U.el('div', 'ob-note', 'Generating a new code invalidates your old one. Confirm your password to continue.'));
    var pw = mkPassword('Your password');
    var err = U.el('div', 'auth-err'); err.hidden = true;
    card.appendChild(mkField('Password', pw));
    card.appendChild(err);
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Generate new code');
    btn.addEventListener('click', function () {
      err.hidden = true;
      if (!pw.value) { showErr(err, 'Enter your password'); return; }
      btn.disabled = true; btn.textContent = 'Generating…';
      A.auth.regenRecovery(pw.value).then(function (r) {
        if (r.ok) openOverlay(buildRecoveryCard(r.recoveryCode, 'Done', closeOverlay, 'Your new recovery code'), { dismissable: false });
        else { showErr(err, r.error); btn.disabled = false; btn.textContent = 'Generate new code'; }
      });
    });
    card.appendChild(btn);
    openOverlay(card);
  }

  /* ---------------- the unverified-email banner ----------------
     While an account has an address it has not confirmed, the server sends every
     other rider anonymised — no names, no stats. Without a standing explanation
     that reads as a bug ("why is everyone called Rider?"), so this bar says what
     is happening and offers the one action that fixes it.

     Deliberately NOT dismissible: it is the only thing explaining the state the
     map is in, and it disappears by itself the moment the address is confirmed. */

  function verifyBannerEl() {
    var el = document.getElementById('verify-banner');
    if (el) return el;
    el = U.el('div', 'verify-banner');
    el.id = 'verify-banner';
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  function refreshVerifyBanner() {
    var el = verifyBannerEl();
    var show = A.auth && A.auth.isLoggedIn() && A.auth.email() && !A.auth.emailVerified();
    if (!show) { el.hidden = true; el.innerHTML = ''; return; }
    // Keyed on the address, not a bare flag: changing the email has to redraw
    // the line that names it.
    if (el.dataset.built === A.auth.email()) { el.hidden = false; return; }
    el.dataset.built = A.auth.email();
    el.innerHTML = '';
    var txt = U.el('div', 'verify-banner-text',
      '<b>Confirm your email to see rider names &amp; stats</b>' +
      '<span>We sent a link to ' + U.esc(A.auth.email()) + '</span>');
    el.appendChild(txt);
    var btn = U.el('button', 'btn btn-small', 'Resend');
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Sending…';
      A.auth.resendVerification().then(function (r) {
        btn.disabled = false; btn.textContent = 'Resend';
        // alreadyVerified means the link was opened elsewhere while this device
        // sat here — catch up rather than telling them to check their inbox.
        if (r.ok && r.alreadyVerified) { A.auth.me().then(refreshVerifyBanner); toast('Already confirmed ✓', 'success'); }
        else if (r.ok) toast('Confirmation email sent', 'success');
        else toast(r.error, 'warn');
      });
    });
    el.appendChild(btn);
    el.hidden = false;
  }

  /* ---------------- email, from the account panel ---------------- */

  // Attach an address to an account that never had one. Password-gated: without
  // it, a borrowed session could point the account's recovery path at someone
  // else's inbox.
  function showAddEmail() {
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('Add an email', closeOverlay));
    card.appendChild(U.el('div', 'ob-note',
      'You\'ll be able to reset your password by email and sign in without one. We\'ll send a link to confirm the address.'));
    var em = mkText('', 'you@example.com');
    em.type = 'email'; em.autocomplete = 'email'; em.maxLength = 254;
    var pw = mkPassword('Your password');
    var err = U.el('div', 'auth-err'); err.hidden = true;
    card.appendChild(mkField('Email', em));
    card.appendChild(mkField('Confirm your password', pw));
    card.appendChild(err);
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Add email');
    btn.addEventListener('click', function () {
      err.hidden = true;
      if (!em.value.trim() || !pw.value) { showErr(err, 'Fill in both fields'); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      A.auth.addEmail(em.value.trim(), pw.value).then(function (r) {
        if (!r.ok) { showErr(err, r.error); btn.disabled = false; btn.textContent = 'Add email'; return; }
        renderAccount();
        openOverlay(buildSentCard('Confirm your email',
          'We\'ve sent a link to ' + em.value.trim() + '. Open it to finish. Until then the address does nothing.',
          'Done', closeOverlay));
      });
    });
    card.appendChild(btn);
    openOverlay(card);
  }

  function showChangeEmail() {
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('Change email', closeOverlay));
    card.appendChild(U.el('div', 'ob-note',
      'We\'ll send a link to the new address. Nothing changes until you open it.'));
    var em = mkText('', 'you@example.com');
    em.type = 'email'; em.autocomplete = 'email'; em.maxLength = 254;
    var pw = mkPassword('Your password');
    var err = U.el('div', 'auth-err'); err.hidden = true;
    card.appendChild(mkField('New email', em));
    card.appendChild(mkField('Confirm your password', pw));
    card.appendChild(err);
    var btn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Send confirmation');
    btn.addEventListener('click', function () {
      err.hidden = true;
      if (!em.value.trim() || !pw.value) { showErr(err, 'Fill in both fields'); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      A.auth.changeEmail(em.value.trim(), pw.value).then(function (r) {
        if (!r.ok) { showErr(err, r.error); btn.disabled = false; btn.textContent = 'Send confirmation'; return; }
        openOverlay(buildSentCard('Check the new inbox',
          'If ' + r.sentTo + ' is free, a confirmation link is on its way. Your current address stays active until it\'s opened.',
          'Done', closeOverlay));
      });
    });
    card.appendChild(btn);
    openOverlay(card);
  }

  // Everything this account can sign in with, read live from the auth service.
  function showLinkedAccounts() {
    var card = U.el('div', 'modal-card');
    card.appendChild(authCloseHead('Sign-in methods', closeOverlay));
    var list = U.el('div', 'linked-list', '<div class="ob-note">Loading…</div>');
    card.appendChild(list);
    card.appendChild(U.el('div', 'ob-note',
      'Signing in with a provider that uses the same confirmed email links it to this account automatically. ' +
      'An account always keeps at least one method.'));
    var done = U.el('button', 'btn btn-ghost btn-block', 'Close');
    done.addEventListener('click', closeOverlay);
    card.appendChild(done);
    openOverlay(card);

    A.auth.identities().then(function (r) {
      list.innerHTML = '';
      if (!r.ok) { list.appendChild(U.el('div', 'auth-err', U.esc(r.error))); return; }
      if (!r.identities.length) { list.appendChild(U.el('div', 'ob-note', 'No linked methods found.')); return; }
      r.identities.forEach(function (idn) {
        var row = U.el('div', 'linked-row');
        var label = idn.provider === 'email' ? 'Email &amp; password' : U.esc(idn.provider);
        row.innerHTML = '<span class="linked-mark">' + providerMark(idn.provider, idn.provider) + '</span>' +
          '<span class="linked-info"><b>' + label + '</b>' +
          (idn.email ? '<span>' + U.esc(idn.email) + '</span>' : '') + '</span>';
        if (r.canUnlink) {
          var rm = U.el('button', 'btn btn-ghost btn-small btn-danger-text', 'Unlink');
          rm.addEventListener('click', function () {
            if (!confirm('Remove ' + idn.provider + ' as a way to sign in?')) return;
            rm.disabled = true;
            A.auth.unlinkIdentity(idn.id).then(function (res) {
              if (res.ok) { toast('Sign-in method removed', 'success'); showLinkedAccounts(); }
              else { rm.disabled = false; toast(res.error, 'warn'); }
            });
          });
          row.appendChild(rm);
        }
        list.appendChild(row);
      });
    });
  }

  function authCloseHead(title, onClose) {
    var head = U.el('div', 'auth-head2');
    var x = U.el('button', 'auth-back', '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', onClose);
    head.appendChild(x);
    head.appendChild(U.el('h2', 'auth-title', U.esc(title)));
    return head;
  }

  // Async only because the provider list comes from the server. A.auth.config()
  // caches after the first call, so every later render resolves immediately.
  function renderAuth(mode) {
    withAuthConfig(function (cfg) {
      if (mode === 'register' || mode === 'guest') withCatalog(function () { buildAuth(mode, cfg); });
      else buildAuth(mode, cfg);
    });
  }

  function buildAuth(mode, cfg) {
    var root = document.getElementById('onboarding');
    var card = U.el('div', 'modal-card');

    if (mode === 'welcome') {
      card.innerHTML = authHeader();
      var nProviders = addProviderButtons(card, cfg, 'Continue with');
      if (nProviders) card.appendChild(U.el('div', 'auth-or', '<span>or</span>'));
      var loginBtn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Log in');
      var regBtn = U.el('button', 'btn btn-block btn-lg', 'Create account');
      var guestBtn = U.el('button', 'btn btn-ghost btn-block', 'Continue as guest');
      loginBtn.addEventListener('click', function () { renderAuth('login'); });
      regBtn.addEventListener('click', function () { renderAuth('register'); });
      guestBtn.addEventListener('click', function () { renderAuth('guest'); });
      card.appendChild(loginBtn);
      card.appendChild(regBtn);
      card.appendChild(U.el('div', 'auth-or', '<span>or</span>'));
      card.appendChild(guestBtn);
      card.appendChild(U.el('div', 'ob-note', 'An account saves your car &amp; convoys across devices. Guest works instantly but stays on this device.'));

    } else if (mode === 'login') {
      card.appendChild(authBackHead('Welcome back'));
      if (addProviderButtons(card, cfg, 'Sign in with')) {
        card.appendChild(U.el('div', 'auth-or', '<span>or</span>'));
      }
      // One field for both identifiers — riders who signed up with an email
      // shouldn't have to remember which box it went in, and the server resolves
      // whichever they type.
      var idLabel = cfg.email ? 'Username or email' : 'Username';
      var lu = mkText('', idLabel);
      lu.autocomplete = 'username';
      lu.maxLength = cfg.email ? 254 : 20;
      var lp = mkPassword('Password');
      var lerr = U.el('div', 'auth-err'); lerr.hidden = true;
      card.appendChild(mkField(idLabel, lu));
      card.appendChild(mkField('Password', lp));
      card.appendChild(lerr);
      var lbtn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Log in');
      var lsubmit = function () {
        lerr.hidden = true;
        if (!lu.value.trim() || !lp.value) { showErr(lerr, 'Enter your ' + idLabel.toLowerCase() + ' and password'); return; }
        lbtn.disabled = true; lbtn.textContent = 'Signing in…';
        A.auth.login(lu.value.trim(), lp.value).then(function (r) {
          if (r.ok) closeAuthEnter('Welcome back, ' + S.profile.name);
          else { showErr(lerr, r.error); lbtn.disabled = false; lbtn.textContent = 'Log in'; }
        });
      };
      lbtn.addEventListener('click', lsubmit);
      lp.addEventListener('keydown', function (e) { if (e.key === 'Enter') lsubmit(); });
      lu.addEventListener('keydown', function (e) { if (e.key === 'Enter') lp.focus(); });
      card.appendChild(lbtn);
      if (cfg.magicLink) {
        var mlBtn = U.el('button', 'btn btn-ghost btn-block', 'Email me a sign-in link instead');
        mlBtn.addEventListener('click', function () { renderAuth('magic'); });
        card.appendChild(mlBtn);
      }
      var forgotRow = U.el('div', 'auth-switch');
      var forgot = U.el('button', 'auth-link', 'Forgot password?');
      // With email configured there are two ways back in, so ask which; without
      // it the recovery code is the only one and the question is noise.
      forgot.addEventListener('click', function () { renderAuth(cfg.email ? 'forgot' : 'recover'); });
      forgotRow.appendChild(forgot);
      card.appendChild(forgotRow);
      var lsw = U.el('div', 'auth-switch', 'New here? ');
      var lswa = U.el('button', 'auth-link', 'Create an account');
      lswa.addEventListener('click', function () { renderAuth('register'); });
      lsw.appendChild(lswa);
      card.appendChild(lsw);

    } else if (mode === 'forgot') {
      card.appendChild(authBackHead('Forgot password', 'login'));
      card.appendChild(U.el('div', 'ob-note',
        'We\'ll email you a link to set a new password. Only works if you confirmed your email.'));
      var fe = mkText('', 'you@example.com');
      fe.type = 'email'; fe.autocomplete = 'email'; fe.maxLength = 254;
      var ferr = U.el('div', 'auth-err'); ferr.hidden = true;
      card.appendChild(mkField('Email', fe));
      card.appendChild(ferr);
      var fbtn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Send reset link');
      var fsubmit = function () {
        ferr.hidden = true;
        if (!fe.value.trim()) { showErr(ferr, 'Enter your email address'); return; }
        fbtn.disabled = true; fbtn.textContent = 'Sending…';
        A.auth.forgot(fe.value.trim()).then(function (r) {
          if (!r.ok) { showErr(ferr, r.error); fbtn.disabled = false; fbtn.textContent = 'Send reset link'; return; }
          // Deliberately says "if" — the server won't reveal whether that
          // address has an account, and neither will this screen.
          root.innerHTML = '';
          root.appendChild(buildSentCard('Check your inbox',
            'If ' + fe.value.trim() + ' has a Convoy account, a reset link is on its way. It expires in an hour.',
            'Back to sign-in', function () { renderAuth('login'); }));
        });
      };
      fbtn.addEventListener('click', fsubmit);
      fe.addEventListener('keydown', function (e) { if (e.key === 'Enter') fsubmit(); });
      card.appendChild(fbtn);
      var toCode = U.el('div', 'auth-switch', 'No email on your account? ');
      var toCodeA = U.el('button', 'auth-link', 'Use a recovery code');
      toCodeA.addEventListener('click', function () { renderAuth('recover'); });
      toCode.appendChild(toCodeA);
      card.appendChild(toCode);

    } else if (mode === 'magic') {
      card.appendChild(authBackHead('Sign in by email', 'login'));
      card.appendChild(U.el('div', 'ob-note',
        'We\'ll email you a link that signs you straight in, no password needed. Only works if you confirmed your email.'));
      var me2 = mkText('', 'you@example.com');
      me2.type = 'email'; me2.autocomplete = 'email'; me2.maxLength = 254;
      var merr = U.el('div', 'auth-err'); merr.hidden = true;
      card.appendChild(mkField('Email', me2));
      card.appendChild(merr);
      var mbtn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Email me a link');
      var msubmit = function () {
        merr.hidden = true;
        if (!me2.value.trim()) { showErr(merr, 'Enter your email address'); return; }
        mbtn.disabled = true; mbtn.textContent = 'Sending…';
        A.auth.magicRequest(me2.value.trim()).then(function (r) {
          if (!r.ok) { showErr(merr, r.error); mbtn.disabled = false; mbtn.textContent = 'Email me a link'; return; }
          root.innerHTML = '';
          root.appendChild(buildSentCard('Check your inbox',
            'If ' + me2.value.trim() + ' has a Convoy account, a sign-in link is on its way. It expires in 15 minutes.',
            'Back to sign-in', function () { renderAuth('login'); }));
        });
      };
      mbtn.addEventListener('click', msubmit);
      me2.addEventListener('keydown', function (e) { if (e.key === 'Enter') msubmit(); });
      card.appendChild(mbtn);

    } else if (mode === 'recover') {
      card.appendChild(authBackHead('Reset password', cfg.email ? 'forgot' : 'login'));
      card.appendChild(U.el('div', 'ob-note', 'Enter your username and the recovery code you saved when you signed up.'));
      var ru = mkText('', 'Username'); ru.autocomplete = 'username'; ru.maxLength = 20;
      var rc = mkText('', 'CVY-XXXX-XXXX'); rc.maxLength = 16;
      var rp = mkPassword('New password (6+ characters)'); rp.autocomplete = 'new-password';
      var rerr = U.el('div', 'auth-err'); rerr.hidden = true;
      card.appendChild(mkField('Username', ru));
      card.appendChild(mkField('Recovery code', rc));
      card.appendChild(mkField('New password', rp));
      card.appendChild(rerr);
      var recBtn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Reset password');
      recBtn.addEventListener('click', function () {
        rerr.hidden = true;
        if (!ru.value.trim() || !rc.value.trim() || !rp.value) { showErr(rerr, 'Fill in all three fields'); return; }
        recBtn.disabled = true; recBtn.textContent = 'Resetting…';
        A.auth.recover(ru.value.trim(), rc.value.trim(), rp.value).then(function (r) {
          if (r.ok) {
            root.innerHTML = '';
            root.appendChild(buildRecoveryCard(r.recoveryCode, 'Saved, continue →',
              function () { closeAuthEnter('Password reset. Welcome back, ' + S.profile.name); },
              'Password reset! Here\'s your new recovery code',
              'Your old code no longer works. Save this new one.'));
            root.scrollTop = 0;
          } else { showErr(rerr, r.error); recBtn.disabled = false; recBtn.textContent = 'Reset password'; }
        });
      });
      card.appendChild(recBtn);

    } else if (mode === 'register' || mode === 'guest') {
      var isGuest = mode === 'guest';
      card.appendChild(authBackHead(isGuest ? 'Ride as a guest' : 'Create your account'));
      var uInput, pInput, eInput, errEl;
      if (!isGuest) {
        if (addProviderButtons(card, cfg, 'Continue with')) {
          card.appendChild(U.el('div', 'auth-or', '<span>or sign up with a password</span>'));
        }
        uInput = mkText('', 'Pick a username'); uInput.autocomplete = 'username'; uInput.maxLength = 20;
        pInput = mkPassword('Create a password (6+ characters)');
        pInput.autocomplete = 'new-password';
        errEl = U.el('div', 'auth-err'); errEl.hidden = true;
        card.appendChild(mkField('Username', uInput));
        // Optional, and labelled as such. An account with no email still works
        // exactly as before — the recovery code covers it — so this is an offer,
        // not a toll gate on signing up.
        if (cfg.email) {
          eInput = mkText('', 'you@example.com');
          eInput.type = 'email'; eInput.autocomplete = 'email'; eInput.maxLength = 254;
          eInput.required = true;
          card.appendChild(mkField('Email', eInput));
          card.appendChild(U.el('div', 'ob-note',
            'We send a link to confirm it. Until you open it, other riders show as ' +
            '&ldquo;Rider&rdquo; with no stats. Confirming unlocks names, stats and password reset by email.'));
        }
        card.appendChild(mkField('Password', pInput));
        card.appendChild(errEl);
        card.appendChild(U.el('div', 'section-label', 'Your ride'));
      }
      var setup = buildCarSetup(card);
      var rbtn = U.el('button', 'btn btn-primary btn-block btn-lg', isGuest ? 'Start riding →' : 'Create account &amp; ride →');
      rbtn.disabled = true;
      setup.onPledge(function (ok) { rbtn.disabled = !ok; });
      rbtn.addEventListener('click', function () {
        var profile = setup.getProfile();
        // Guests never touch the server, so this local record is the only
        // evidence that the passenger, age and terms boxes were ticked at all.
        ST.setConsent(setup.getConsent());
        if (isGuest) {
          ST.saveProfile(profile);
          ST.setOnboarded();
          closeAuthEnter('Welcome aboard, ' + profile.name + '. Riders are live around you');
          return;
        }
        errEl.hidden = true;
        [uInput, pInput, eInput].forEach(function (i) { if (i) i.removeAttribute('aria-invalid'); });
        var addr = eInput ? eInput.value.trim() : '';
        var bad = !uInput.value.trim() ? [uInput, 'Pick a username']
          : pInput.value.length < 6 ? [pInput, 'Password needs 6+ characters']
          : eInput && !addr ? [eInput, 'Enter your email address'] : null;
        if (bad) { showErr(errEl, bad[1], [bad[0]]); return; }
        rbtn.disabled = true; rbtn.textContent = 'Creating…';
        A.auth.register(uInput.value.trim(), pInput.value, profile, addr).then(function (r) {
          if (r.ok) {
            // show the recovery code before entering the app
            root.innerHTML = '';
            root.appendChild(buildRecoveryCard(r.recoveryCode, 'I saved it, start riding →',
              function () { closeAuthEnter('Welcome, ' + S.profile.name); },
              'Account created. Save your recovery code',
              addr && r.verificationSent
                ? 'We\'ve also emailed ' + addr + '. Confirm it to unlock password reset by email.'
                : 'You\'ll need this if you ever forget your password.'));
            root.scrollTop = 0;
          } else { showErr(errEl, r.error); rbtn.disabled = false; rbtn.textContent = 'Create account & ride →'; }
        });
      });
      card.appendChild(rbtn);
      card.appendChild(U.el('div', 'ob-note', 'Starts in Los Angeles · tap the locate control on the map to use your real location.'));
    }

    root.innerHTML = '';
    root.appendChild(card);
    root.scrollTop = 0;
    focusFirstIn(root);
  }

  function renderAccount() {
    var box = document.getElementById('account-section');
    if (!box) return;
    // The email and sign-in-method rows depend on what the server offers. Draw
    // once now so the panel isn't blank, then again when the answer lands —
    // guarded by the flag so this can't loop.
    if (!authCfgLoaded) withAuthConfig(function () { renderAccount(); });
    box.innerHTML = '';
    box.appendChild(U.el('div', 'section-label', 'Account'));
    var loggedIn = A.auth && A.auth.isLoggedIn();
    var row = U.el('div', 'account-row');
    if (loggedIn) {
      row.innerHTML =
        '<div class="u-ava u-ava-sm" style="--paint:' + U.safePaint(S.profile.car.paint) + '">' + avaInner(S.profile, 16) + '</div>' +
        '<div class="account-info"><b>@' + U.esc(A.auth.username()) + '</b><span>Signed in · synced across devices</span></div>';
      var out = U.el('button', 'btn btn-ghost btn-small btn-danger-text', 'Log out');
      out.addEventListener('click', function () {
        if (confirm('Log out of @' + A.auth.username() + '? Your account stays saved.')) A.auth.logout();
      });
      row.appendChild(out);
      box.appendChild(row);

      // Email state, when the server does email at all. Three shapes: none on
      // file, one that still needs confirming, one that's done.
      if (authCfg.email) {
        var addr = A.auth.email();
        var verified = A.auth.emailVerified();
        var mailRow = U.el('div', 'account-row');
        if (!addr) {
          mailRow.innerHTML = '<div class="account-info"><b>No email on this account</b>' +
            '<span>Your recovery code is the only way back in</span></div>';
          var addBtn = U.el('button', 'btn btn-ghost btn-small', 'Add email');
          addBtn.addEventListener('click', showAddEmail);
          mailRow.appendChild(addBtn);
        } else if (!verified) {
          mailRow.classList.add('account-row-warn');
          mailRow.innerHTML = '<div class="account-info"><b>' + U.esc(addr) + '</b>' +
            '<span>Not confirmed yet. Reset by email is off until you do</span></div>';
          var vBtn = U.el('button', 'btn btn-ghost btn-small', 'Resend');
          vBtn.addEventListener('click', function () {
            vBtn.disabled = true; vBtn.textContent = 'Sending…';
            A.auth.resendVerification().then(function (r) {
              vBtn.disabled = false; vBtn.textContent = 'Resend';
              if (r.ok && r.alreadyVerified) { renderAccount(); toast('Already confirmed ✓', 'success'); }
              else if (r.ok) toast('Confirmation email sent', 'success');
              else toast(r.error, 'warn');
            });
          });
          mailRow.appendChild(vBtn);
        } else {
          mailRow.innerHTML = '<div class="account-info"><b>' + U.esc(addr) + '</b>' +
            '<span>Confirmed ✓ · password reset and sign-in links enabled</span></div>';
          var edBtn = U.el('button', 'btn btn-ghost btn-small', 'Change');
          // A provider account has no Convoy password to confirm the change
          // with, so the address is theirs to change with the provider.
          if (A.auth.provider() === 'password') edBtn.addEventListener('click', showChangeEmail);
          else edBtn.addEventListener('click', function () {
            toast('This account signs in with ' + A.auth.provider() + '. Change your email there', 'info');
          });
          mailRow.appendChild(edBtn);
        }
        box.appendChild(mailRow);
      }

      var actions = U.el('div', 'account-actions');
      // Both of these confirm the CURRENT password before they do anything —
      // that check is what stops a borrowed session from taking an account over.
      // An account created through a provider has never had one, so for those
      // riders both buttons could only ever answer "password is incorrect".
      // Show what actually applies to them instead of a pair of dead ends.
      if (A.auth.provider() === 'password') {
        var chg = U.el('button', 'btn btn-ghost btn-small', 'Change password');
        chg.addEventListener('click', showChangePassword);
        var rec = U.el('button', 'btn btn-ghost btn-small', 'Recovery code');
        rec.addEventListener('click', showRegenRecovery);
        actions.appendChild(chg);
        actions.appendChild(rec);
      }
      // Only worth showing where more than one method can exist.
      if (authCfg.providers && authCfg.providers.length) {
        var linked = U.el('button', 'btn btn-ghost btn-small', 'Sign-in methods');
        linked.addEventListener('click', showLinkedAccounts);
        actions.appendChild(linked);
      }
      box.appendChild(actions);
      if (A.auth.provider() !== 'password') {
        box.appendChild(U.el('div', 'ob-note',
          'Your password is managed by ' + U.esc(A.auth.provider()) + '. The recovery code from ' +
          'sign-up still works if you ever lose access to that account.'));
      }
      return;
    } else {
      row.innerHTML =
        '<div class="u-ava u-ava-sm" style="--paint:' + U.safePaint(S.profile.car.paint) + '">' + avaInner(S.profile, 16) + '</div>' +
        '<div class="account-info"><b>Playing as guest</b><span>Car &amp; convoys stay on this device</span></div>';
      var create = U.el('button', 'btn btn-primary btn-small', 'Create account');
      create.addEventListener('click', function () {
        closePanels();
        showAuth(function () { location.reload(); }); // reconnect authenticated
        renderAuth('register');
      });
      row.appendChild(create);
    }
    box.appendChild(row);
  }

  function welcomeBack() {
    if (A.auth && A.auth.isLoggedIn()) toast('Welcome back, ' + S.profile.name, 'info');
    else toast('Welcome back', 'info');
  }

  /* ============================== init ============================== */
  function init() {
    wireDock();
    wireSearch();
    wireChips();
    wireWalkieTalkie();
    buildProfilePanel(); // includes the Settings gear box (built into #settings-host on open)
    refreshAvatarBtn();
    updateLiveChip(); // sim seeds before ui.init — sync the count now
    updateNearbyDockBadge(); // pending friend requests restored from a live session

    document.getElementById('btn-avatar').addEventListener('click', function () {
      openPanel(openName === 'profile' ? null : 'profile');
    });

    // Profile header gear → open/scroll to the Settings gear box (Settings has no dock tab).
    var psb = document.getElementById('profile-settings-btn');
    if (psb) psb.addEventListener('click', function () { toggleGearbox(); });

    // live refreshers
    var reclassTick = 0;
    ST.on('tick', function () {
      updateNearbyLive();
      updateConvoyLive();
      // Road/sight membership drifts as riders move — refresh the dot colors
      // every few seconds so the map keeps matching the active filter.
      if (nearbyFilter !== 'radius' && (++reclassTick % 3) === 0 &&
        A.mapview && A.mapview.reclassifyMarkers) A.mapview.reclassifyMarkers();
    });
    ST.on('nearby:seeded', function () { updateLiveChip(); if (openName === 'nearby') renderNearby(); });
    ST.on('party', function () {
      updateDockBadge();
      if (openName === 'convoy') renderConvoy();
      if (openName === 'nearby') updateNearbyLive();
      renderProfileCard(); // "in convoy" counter on the profile header
    });
    ST.on('chat', function () {
      var log = document.getElementById('chat-log');
      if (log) renderChatInto(log);
    });
    ST.on('units', function () {
      A.routing.renderEtaCard();
      if (openName === 'nearby') updateNearbyLive();
    });
    ST.on('global', function (v) {
      A.mapview.setGlobalVisible(v);
      syncGlobalChip();
      toast(v ? 'Global drivers on · delayed ~5 min' : 'Global drivers hidden', 'info');
    });
    ST.on('theme', function () { A.mapview.applyStyle(); });
    ST.on('mapstyle', function () { A.mapview.applyStyle(); });
    ST.on('accent', function () { A.mapview.applyAccent(); });

    // Voice navigation: keep routing's nav flag + chosen voice in sync with settings.
    if (A.routing && A.routing.setNavEnabled) A.routing.setNavEnabled(S.settings.voiceNav);
    if (A.routing && A.routing.setVoiceName) A.routing.setVoiceName(S.settings.navVoiceName);
    ST.on('voicenav', function (v) { if (A.routing && A.routing.setNavEnabled) A.routing.setNavEnabled(v); });
    ST.on('navvoice', function (name) { if (A.routing && A.routing.setVoiceName) A.routing.setVoiceName(name); });
    // Warm up the speech voice list — some browsers load voices async.
    if (window.speechSynthesis && window.speechSynthesis.getVoices) {
      try { window.speechSynthesis.getVoices(); } catch (e) { }
    }

    // Invisible mode: the chip shows while hidden, the player marker dims, and
    // voice drops its proximity peers (js/voice.js listens to 'ghost' itself).
    buildGhostChip();
    ST.on('ghost', function (v) {
      if (A.mapview && A.mapview.setPlayerGhost) A.mapview.setPlayerGhost(v);
      updateGhostChip();
    });
    // Persisted from a previous session: dim the marker now that the map is live.
    if (S.settings.ghost && A.mapview && A.mapview.setPlayerGhost) A.mapview.setPlayerGhost(true);

    ST.on('auth', function () { renderAccount(); });
    ST.on('profile', function () { if (openName === 'profile') renderAccount(); });
    ST.on('friends', function () {
      if (openName === 'nearby') renderNearby();
      updateNearbyDockBadge();
      if (A.mapview && A.mapview.reclassifyMarkers) A.mapview.reclassifyMarkers();
      renderProfileCard(); // friends counter on the profile header
      renderAwards();      // "Crew" badge
    });
    // auth.boot() decides whether to show the auth screen or enter the app
    uiInited = true;
    runHooks('init');
  }

  function updateNearbyDockBadge() {
    var btn = document.querySelector('.dock-btn[data-dock="nearby"]');
    if (!btn) return;
    var badge = btn.querySelector('.dock-badge');
    var n = S.friendReqs.length;
    if (!badge && n) {
      badge = U.el('em', 'dock-badge');
      btn.appendChild(badge);
    }
    if (badge) { badge.hidden = !n; badge.textContent = n; }
  }

  A.ui = {
    init: init,
    // Exposed so tests can wire the dock/panel/modal keyboard and backdrop
    // handlers (Tab-wrap, Escape, backdrop click) without running the rest of
    // init() — wireSearch/wireChips/wireWalkieTalkie touch audio and live
    // state that a jsdom harness has no reason to boot for a keyboard test.
    wireDock: wireDock,
    syncGlobalChip: syncGlobalChip,
    toast: toast,
    inviteToast: inviteToast,
    showAuth: showAuth,
    refreshVerifyBanner: refreshVerifyBanner,
    // Entered from auth.js when a link or an OAuth redirect brings the app back:
    // the "pick a username" step for a fresh provider account, and the landing
    // screen for a password-reset link.
    showOAuthSetup: showOAuthSetup,
    showResetPassword: showResetPassword,
    // Legal surfaces auth.js drives: the re-consent gate every rider passes on
    // the way into the app, and the erasure flow that /delete-account links to.
    showConsentGate: showConsentGate,
    // Block & report: net.js redraws the list when the server pushes a new one,
    // and party.js opens the report dialog from a chat line.
    refreshBlockedList: renderBlockedList,
    showReportDialog: showReportDialog,
    showBlockDialog: showBlockDialog,
    showDeleteAccount: showDeleteAccount,
    renderAccount: renderAccount,
    welcomeBack: welcomeBack,
    openPanel: openPanel,
    closePanels: closePanels,
    refreshAvatarBtn: refreshAvatarBtn,
    setProfilePhoto: handlePhotoFile, // photo → NSFW screen → compress → save (native bridge + tests)
    applyGhost: applyGhost, // invisible-mode toggle (settings row + status chip)
    openProfileOverlay: openProfileOverlay, // Instagram-style profile view
    // Raw overlay access for modules that build their own modal card.
    openOverlayRaw: openOverlay,
    openOverlay: openOverlay,
    // Feature-pack extension points (see the hooks block above legalGate).
    addHook: addHook,
    legalGate: legalGate,
    registerFeatureNotice: registerFeatureNotice,
    settingsKit: settingsKit,
    closeOverlay: closeOverlay,
    nearbyFilter: function () { return nearbyFilter; }, // mapview reads this to color dots by active filter
    // Does this rider match the active Nearby filter right now? (mapview uses
    // this so only matching riders get the brighter road/sight dot color.)
    nearbyMatches: function (npc) { return A.sim.proximityMatch(npc, nearbyFilter); },
    FALLBACK_NAMES: FALLBACK_NAMES // for tests, like A.party.FALLBACK_CONVOY_NAMES
  };
})();

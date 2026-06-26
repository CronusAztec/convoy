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
    });
    document.querySelectorAll('.dock-btn').forEach(function (b) {
      var active = b.dataset.dock === (name || 'map');
      b.classList.toggle('active', active);
      b.setAttribute('aria-expanded', active && !!name ? 'true' : 'false');
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
    if (name === 'nearby') renderNearby();
    if (name === 'convoy') renderConvoy();
    if (name === 'profile') {
      fillProfileForm();
      buildSettings(document.getElementById('settings-host')); // rebuild so toggles reflect current state
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
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closePanels(); A.mapview.closePopup(); }
      if (e.key === '/' && document.activeElement &&
        !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault();
        document.getElementById('search-input').focus();
      }
    });
  }

  /* ============================== form helpers ============================== */
  function mkField(label, child) {
    var w = U.el('div', 'field');
    w.innerHTML = '<label>' + U.esc(label) + '</label>';
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
    custom.innerHTML = '<input type="color" value="' + value + '"/><span>+</span>';
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
        b.innerHTML = U.riderIcon(key, { size: 18 });
        b.addEventListener('click', function () {
          w.querySelectorAll('.emoji-btn').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          if (onChange) onChange(key);
        });
        w.appendChild(b);
      }(k));
    }
    w.getValue = function () {
      var a = w.querySelector('.emoji-btn.active');
      return a ? U.iconKey(a) : active;
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
  var NEARBY_RADIUS_M = 2000;       // "in a radius around the driver"
  var ROAD_CROSS_M = 60;            // same street/freeway corridor half-width
  var ROAD_RANGE_M = 4000;          // how far up/down the road to look
  var SIGHT_FOV_DEG = 70;           // forward field of view (± degrees)
  var SIGHT_RANGE_M = 400;          // line-of-sight distance

  // Riders matching the active Nearby filter, relative to the driver's position + heading.
  function filteredNearby() {
    var rows = A.sim.getNearbySorted();
    var ppos = A.sim.playerPos();
    var phead = A.sim.playerHeading();
    if (nearbyFilter === 'road') {
      return rows.filter(function (r) {
        return r.dist <= ROAD_RANGE_M && U.crossTrack(ppos, phead, r.npc.livePos || r.npc.pos) <= ROAD_CROSS_M;
      });
    }
    if (nearbyFilter === 'sight') {
      return rows.filter(function (r) {
        return r.dist <= SIGHT_RANGE_M && Math.abs(U.relBearing(ppos, phead, r.npc.livePos || r.npc.pos)) <= SIGHT_FOV_DEG;
      });
    }
    return rows.filter(function (r) { return r.dist <= NEARBY_RADIUS_M; });
  }

  function sameIdSet(a, b) {
    if (a.length !== b.length) return false;
    var s = Object.create(null);
    a.forEach(function (x) { s[x] = 1; });
    return b.every(function (x) { return s[x]; });
  }

  function renderNearby() {
    var body = document.getElementById('nearby-body');
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
        : nearbyFilter === 'sight' ? 'Nothing in sight ahead — try Radius.'
        : 'No riders within range right now.';
      content.appendChild(U.el('div', 'hint-card', msg));
      return;
    }

    rows.forEach(function (r) {
      var npc = r.npc;
      var row = U.el('div', 'row user-row');
      row.innerHTML =
        '<div class="u-ava" style="--paint:' + npc.car.paint + '">' + U.riderIcon(npc.emoji, { size: 20 }) + '</div>' +
        '<div class="u-info">' +
        '  <div class="u-name">' + U.esc(npc.name) + ' <span class="u-handle">@' + U.esc(npc.handle) + '</span></div>' +
        '  <div class="u-car">' + npc.car.year + ' ' + U.esc(npc.car.make) + ' ' + U.esc(npc.car.model) +
        '   <i class="paint-dot" style="background:' + npc.car.paint + '"></i></div>' +
        '</div>' +
        '<div class="u-side"><div class="u-dist"></div><div class="u-status"></div></div>';

      var btn = U.el('button', 'btn btn-small');
      row.appendChild(btn);

      row.addEventListener('click', function (e) {
        if (e.target === btn) return;
        A.mapview.flyToUser(npc.livePos || npc.pos);
        A.mapview.showNpcPopup(npc.id);
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
          '<div class="u-ava" style="--paint:' + (rq.paint || '#888') + '">' + U.riderIcon(rq.emoji, { size: 20 }) + '</div>' +
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
      content.appendChild(U.el('div', 'hint-card', 'No friends yet — add a username above.'));
      return;
    }
    var sorted = S.friends.slice().sort(function (a, b) {
      return (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name);
    });
    sorted.forEach(function (f) {
      var row = U.el('div', 'row friend-row');
      row.innerHTML =
        '<div class="u-ava" style="--paint:' + (f.paint || '#888') + '">' + U.riderIcon(f.emoji, { size: 20 }) +
        '<span class="online-dot' + (f.online ? ' on' : '') + '"></span></div>' +
        '<div class="u-info"><div class="u-name">' + U.esc(f.name) + '</div>' +
        '<div class="u-handle">@' + U.esc(f.username) + ' · ' +
        (f.online ? '<span class="online-text">online</span>' : 'offline') + '</div></div>';
      var side = U.el('div', 'friend-actions');
      var npc = A.sim.getByUsername(f.username);
      if (npc) {
        var loc = U.el('button', 'btn btn-small', 'Locate');
        loc.addEventListener('click', function () { A.mapview.flyToUser(npc.livePos || npc.pos); A.mapview.showNpcPopup(npc.id); });
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

  // Apply Ghost Mode: persist + notify the server. All map/ghost/radar reactions
  // are owned by the single 'ghost' listener wired in init(), so toggling does
  // each piece of work exactly once (it used to run twice — here and in the listener).
  function applyGhost(on) {
    ST.setGhost(on);              // persists + emits 'ghost' → the listener reacts
    if (A.net && A.net.sendGhost) A.net.sendGhost(on);
    A.ui.toast(on ? 'Ghost mode on — radar engaged, you are invisible to other riders' : 'Ghost mode off', 'info');
  }

  function updateGhostChip() {
    var btn = document.getElementById('ctl-ghost');
    if (btn) btn.classList.toggle('active', !!S.settings.ghost);
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
    chip.title = 'Ghost mode — invisible to other riders';
    chip.innerHTML = '<span class="dot" style="background:#9b4dff;box-shadow:0 0 6px #9b4dff"></span><span>GHOST</span>';
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
    body.innerHTML = '';
    convoyMemberRefs = {};

    if (!S.party) {
      sub.textContent = 'no active convoy';
      var hero = U.el('div', 'convoy-hero');
      hero.innerHTML =
        '<div class="convoy-hero-art">' + U.convoyFlag(0) + '</div>' +
        '<h3>Start a convoy</h3>' +
        '<p>Ride together in real time. Members appear on each other\'s map with a live link line.</p>';
      var nameInput = mkText('', U.pick(D.CONVOY_NAMES));
      var flagRow = U.el('div', 'emoji-row');
      var chosen = 0;
      for (var fi = 0; fi < 3; fi++) {
        (function (idx) {
          var b = U.el('button', 'emoji-btn' + (idx === 0 ? ' active' : ''));
          b.type = 'button';
          b.innerHTML = U.convoyFlag(idx);
          b.addEventListener('click', function () {
            flagRow.querySelectorAll('.emoji-btn').forEach(function (x) { x.classList.remove('active'); });
            b.classList.add('active');
            chosen = idx;
          });
          flagRow.appendChild(b);
        }(fi));
      }
      var createBtn = U.el('button', 'btn btn-primary btn-block', 'Create convoy');
      createBtn.addEventListener('click', function () {
        A.party.create(nameInput.value || nameInput.placeholder, chosen);
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
      members.appendChild(U.el('div', 'hint-card', 'No riders yet — invite from <b>Nearby</b>.'));
    }
    S.party.members.forEach(function (id) {
      var npc = A.sim.getNpc(id);
      if (!npc) return;
      var chip = U.el('div', 'member-chip');
      chip.dataset.member = id; // voice module toggles .wt-speaking here
      chip.innerHTML =
        '<div class="u-ava u-ava-sm" style="--paint:' + npc.car.paint + '">' + U.riderIcon(npc.emoji, { size: 16 }) + '</div>' +
        '<div class="member-info"><b>' + U.esc(npc.name) + '</b><span class="member-dist"></span></div>';
      if (S.party.isLeader) {
        var kickBtn = U.el('button', 'icon-btn icon-btn-sm', '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>');
        kickBtn.title = 'Remove from convoy';
        kickBtn.addEventListener('click', function () { A.party.kick(id); });
        chip.appendChild(kickBtn);
      }
      chip.querySelector('.u-ava').addEventListener('click', function () {
        A.mapview.flyToUser(npc.livePos || npc.pos);
      });
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
    if (!S.party) { log.innerHTML = ''; log._n = 0; return; }
    var chat = S.party.chat;
    // Incremental render: if the log already shows the first N messages, only
    // append the new ones instead of clearing and rebuilding every line on each
    // 'chat' event. (Re-opens reset via _n being out of sync → full rebuild.)
    var n = log._n || 0;
    if (n > chat.length) { log.innerHTML = ''; n = 0; } // chat was trimmed/replaced
    for (var i = n; i < chat.length; i++) {
      var m = chat[i], el;
      if (m.sys) {
        el = U.el('div', 'msg msg-sys', U.esc(m.text));
      } else if (m.from === 'me') {
        el = U.el('div', 'msg msg-me', U.esc(m.text));
      } else {
        el = U.el('div', 'msg msg-them',
          '<span class="msg-from">' + U.esc(m.from) + '</span>' + U.esc(m.text));
      }
      log.appendChild(el);
    }
    log._n = chat.length;
    log.scrollTop = log.scrollHeight;
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
    var n = S.party ? S.party.members.length : 0;
    badge.hidden = !n;
    badge.textContent = n;
  }

  /* ============================== profile panel ============================== */
  var pf = {}; // profile form controls

  function buildProfilePanel() {
    var body = document.getElementById('profile-body');
    body.innerHTML = '';

    var preview = U.el('div', 'profile-preview');
    preview.id = 'profile-preview';
    body.appendChild(preview);

    pf.name = mkText(S.profile.name, 'Display name');
    pf.handleWrap = U.el('div', 'handle-wrap', '<span>@</span>');
    pf.handle = mkText(S.profile.handle, 'handle');
    pf.handle.maxLength = 16;
    pf.handleWrap.appendChild(pf.handle);
    pf.emoji = mkEmojiGrid(S.profile.emoji, updatePreview);
    pf.vibe = mkSelect(D.VIBES, S.profile.vibe);
    pf.year = mkSelect(yearList(), S.profile.car.year);
    pf.make = mkSelect(D.MAKE_LIST, S.profile.car.make);
    pf.model = mkSelect(modelsFor(S.profile.car.make), S.profile.car.model);
    pf.paintHex = S.profile.car.paint;
    pf.paintName = S.profile.car.paintName;
    pf.paint = mkSwatches(D.PAINTS, pf.paintHex, function (hex, name) {
      pf.paintHex = hex; pf.paintName = name; updatePreview();
    });
    pf.finish = mkSegmented(
      D.FINISHES.map(function (f) { return { label: f, value: f }; }),
      S.profile.car.finish, updatePreview);

    // Spec sheet controls
    pf.body = mkSelect(D.BODY_TYPES, S.profile.car.body);
    pf.engine = mkSelect(D.ENGINE_SIZES, S.profile.car.engine);
    pf.trans = mkSelect(D.TRANSMISSIONS, S.profile.car.trans);
    pf.drive = mkSegmented(
      D.DRIVETRAINS.map(function (d) { return { label: d, value: d }; }),
      S.profile.car.drive, updatePreview);
    pf.hp = mkText(String(S.profile.car.hp), 'HP');
    pf.hp.type = 'number';
    pf.hp.min = 50; pf.hp.max = 2000; pf.hp.step = 1;
    pf.hp.value = S.profile.car.hp;
    pf.mods = mkSelect(D.MODS, S.profile.car.mods);
    pf.exhaust = mkSelect(D.EXHAUST_NOTES, S.profile.car.exhaust);

    pf.make.addEventListener('change', function () {
      var models = modelsFor(pf.make.value);
      pf.model.innerHTML = '';
      models.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m; o.textContent = m;
        pf.model.appendChild(o);
      });
      updatePreview();
    });
    [pf.name, pf.handle].forEach(function (i) { i.addEventListener('input', updatePreview); });
    [pf.vibe, pf.year, pf.model, pf.body, pf.engine, pf.trans, pf.mods, pf.exhaust].forEach(function (s) { s.addEventListener('change', updatePreview); });
    pf.hp.addEventListener('input', updatePreview);

    var grid2 = U.el('div', 'grid2');
    grid2.appendChild(mkField('Display name', pf.name));
    grid2.appendChild(mkField('Handle', pf.handleWrap));
    body.appendChild(grid2);
    body.appendChild(mkField('Avatar', pf.emoji));
    body.appendChild(mkField('Style', pf.vibe));

    var sect = U.el('div', 'section-label', 'Car');
    body.appendChild(sect);
    var grid3 = U.el('div', 'grid3');
    grid3.appendChild(mkField('Year', pf.year));
    grid3.appendChild(mkField('Make', pf.make));
    grid3.appendChild(mkField('Model', pf.model));
    body.appendChild(grid3);
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
    modsGrid.appendChild(mkField('Visual mod', pf.mods));
    modsGrid.appendChild(mkField('Exhaust note', pf.exhaust));
    body.appendChild(modsGrid);

    var actions = U.el('div', 'profile-actions');
    var save = U.el('button', 'btn btn-primary btn-block', 'Save changes');
    save.addEventListener('click', saveProfileForm);
    var dice = U.el('button', 'btn btn-ghost', 'Randomize');
    dice.title = 'Randomize all fields';
    dice.addEventListener('click', randomizeProfileForm);
    actions.appendChild(save);
    actions.appendChild(dice);
    body.appendChild(actions);

    // Settings — collapsible "gear box" subsection (the folded-in Settings tab).
    // The actual controls are rendered into #settings-host on panel open.
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

    updatePreview();
  }

  function modelsFor(make) { return D.MAKES[make] || ['Other']; }

  function updatePreview() {
    var preview = document.getElementById('profile-preview');
    if (!preview) return;
    var finish = pf.finish.getValue();
    var drive = pf.drive ? pf.drive.getValue() : '';
    var hp = pf.hp ? pf.hp.value : '';
    var body = pf.body ? pf.body.value : '';
    var exhaust = pf.exhaust ? pf.exhaust.value : '';
    preview.innerHTML =
      '<div class="pp-car">' + A.mapview.carDot(pf.paintHex, 40) + '</div>' +
      '<div class="pp-info">' +
      '  <div class="pp-name">' + U.esc(pf.name.value || 'Rider') + '</div>' +
      '  <div class="pp-handle">@' + U.esc((pf.handle.value || 'rider').toLowerCase()) + ' · ' + U.esc(pf.vibe.value) + '</div>' +
      '  <div class="pp-carline">' + pf.year.value + ' ' + U.esc(pf.make.value) + ' ' + U.esc(pf.model.value) + '</div>' +
      '  <div class="pp-paint"><i class="paint-dot" style="background:' + pf.paintHex + '"></i>' +
      U.esc(pf.paintName) + ' · ' + finish + '</div>' +
      '  <div class="pp-specs"><span class="pp-tag">' + U.esc(body) + '</span>' +
      '    <span class="pp-tag">' + U.esc(drive) + ' · ' + U.esc(hp) + 'hp</span>' +
      '    <span class="pp-tag">' + U.esc(exhaust) + '</span></div>' +
      '</div>';
  }

  function fillProfileForm() {
    if (!pf.name) return;
    pf.name.value = S.profile.name;
    pf.handle.value = S.profile.handle;
    pf.vibe.value = S.profile.vibe;
    pf.year.value = S.profile.car.year;
    pf.make.value = S.profile.car.make;
    pf.make.dispatchEvent(new Event('change'));
    pf.model.value = S.profile.car.model;
    pf.paintHex = S.profile.car.paint;
    pf.paintName = S.profile.car.paintName;
    pf.paint.setValue(pf.paintHex);
    if (S.profile.car.body) {
      pf.body.value = S.profile.car.body;
      pf.engine.value = S.profile.car.engine || '2.0L';
      pf.trans.value = S.profile.car.trans || 'Automatic';
      pf.drive.setValue(S.profile.car.drive || 'FWD');
      pf.hp.value = S.profile.car.hp || 200;
      pf.mods.value = S.profile.car.mods || 'None';
      pf.exhaust.value = S.profile.car.exhaust || 'Stock';
    }
    updatePreview();
  }

  function saveProfileForm() {
    var profile = {
      name: pf.name.value.trim() || 'Rider',
      handle: (pf.handle.value.trim() || 'rider').toLowerCase().replace(/[^a-z0-9_]/g, ''),
      emoji: pf.emoji.getValue(),
      vibe: pf.vibe.value,
      car: {
        year: +pf.year.value,
        make: pf.make.value,
        model: pf.model.value,
        paint: pf.paintHex,
        paintName: pf.paintName,
        finish: pf.finish.getValue(),
        body: pf.body.value,
        engine: pf.engine.value,
        trans: pf.trans.value,
        drive: pf.drive.getValue(),
        hp: +pf.hp.value || 200,
        mods: pf.mods.value,
        exhaust: pf.exhaust.value
      }
    };
    ST.saveProfile(profile);
    if (A.auth && A.auth.isLoggedIn()) A.auth.saveProfileToServer(profile); // sync across devices
    A.mapview.refreshPlayer();
    refreshAvatarBtn();
    renderAccount();
    toast(A.auth && A.auth.isLoggedIn() ? 'Profile saved & synced' : 'Profile saved', 'success');
  }

  function randomizeProfileForm() {
    var make = U.pick(D.MAKE_LIST);
    var paint = U.pick(D.PAINTS);
    var engine = U.pick(D.ENGINE_SIZES);
    pf.name.value = U.pick(D.NAMES);
    pf.handle.value = pf.name.value.toLowerCase() + U.randInt(2, 99);
    pf.vibe.value = U.pick(D.VIBES);
    pf.year.value = U.randInt(1995, 2026);
    pf.make.value = make;
    pf.make.dispatchEvent(new Event('change'));
    pf.model.value = U.pick(D.MAKES[make]);
    pf.paintHex = paint.hex;
    pf.paintName = paint.name;
    pf.paint.setValue(paint.hex);
    pf.body.value = U.pick(D.BODY_TYPES);
    pf.engine.value = engine;
    pf.trans.value = U.pick(D.TRANSMISSIONS);
    pf.drive.setValue(U.pick(D.DRIVETRAINS));
    pf.hp.value = engine === 'Electric' ? U.randInt(200, 1000) : U.randInt(150, 750);
    pf.mods.value = U.pick(D.MODS);
    pf.exhaust.value = U.pick(D.EXHAUST_NOTES);
    var emojis = pf.emoji.querySelectorAll('.emoji-btn');
    emojis.forEach(function (b) { b.classList.remove('active'); });
    emojis[U.randInt(0, emojis.length - 1)].classList.add('active');
    updatePreview();
  }

  function refreshAvatarBtn() {
    document.getElementById('btn-avatar').innerHTML = U.riderIcon(S.profile.emoji, { size: 22 });
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
    body.appendChild(mkField('Theme', mkSegmented([
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' },
      { label: 'Auto', value: 'auto' }
    ], S.settings.theme, function (v) { ST.setTheme(v); })));

    var accentSw = mkSwatches(ACCENTS, S.settings.accent, function (hex) { ST.setAccent(hex); });
    body.appendChild(mkField('Accent color', accentSw));

    var styleSel = mkSelect(['auto', 'dark', 'positron', 'voyager', 'liberty', 'bright'], S.settings.mapStyle);
    var styleNames = {
      auto: 'Auto (match theme)',
      dark: 'Dark — Night City',
      positron: 'Minimal — Positron',
      voyager: 'Day — Voyager',
      liberty: 'Street — Liberty',
      bright: 'Bright — Colorful'
    };
    styleSel.querySelectorAll('option').forEach(function (o) { o.textContent = styleNames[o.value]; });
    styleSel.addEventListener('change', function () { ST.setMapStyle(styleSel.value); });
    body.appendChild(mkField('Map style', styleSel));

    body.appendChild(U.el('div', 'section-label', 'Map & live'));

    body.appendChild(mkRow('Global drivers', null,
      mkToggle(S.settings.showGlobal, function (v) { ST.setShowGlobal(v); })));
    body.appendChild(mkRow('Smooth animations', null,
      mkToggle(S.settings.anim, function (v) { ST.setAnim(v); })));
    body.appendChild(mkRow('Follow camera', null,
      mkToggle(S.settings.followCam, function (v) { ST.setFollowCam(v); })));
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
        o.textContent = v.name + (v.neural ? ' — natural' : (v.female ? ' — female' : ''));
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
    body.appendChild(mkRow('Ghost mode',
      'Go invisible and reveal nearby aircraft and police',
      mkToggle(S.settings.ghost, function (v) { applyGhost(v); })));

    /* ---- Routing ---- */
    body.appendChild(U.el('div', 'section-label', 'Routing'));
    body.appendChild(mkRow('Avoid police & cameras',
      'Pick a detour around police stations and speed cameras when one exists',
      mkToggle(S.settings.avoidPolice, function (v) { ST.setSetting('avoidPolice', v); })));

    /* ---- Radar audio (Ghost Mode sonar) ---- */
    body.appendChild(U.el('div', 'section-label', 'Radar audio'));
    // Master sonar volume slider. 0..1 → 0..100%.
    var volSlider = U.el('input', 'input');
    volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05';
    volSlider.value = S.settings.sonarVol != null ? S.settings.sonarVol : 0.8;
    volSlider.style.width = '100%';
    volSlider.addEventListener('input', function () { ST.setSetting('sonarVol', parseFloat(volSlider.value)); });
    body.appendChild(mkField('Sonar volume', volSlider));
    body.appendChild(mkRow('Heartbeat', 'Risk-driven pulse when threats are near',
      mkToggle(S.settings.sonarHeart, function (v) { ST.setSetting('sonarHeart', v); })));
    body.appendChild(mkField('Heartbeat sensitivity', mkSegmented([
      { label: 'Off', value: 'off' },
      { label: 'Low', value: 'low' },
      { label: 'Normal', value: 'normal' },
      { label: 'Aggressive', value: 'aggressive' }
    ], S.settings.heartSense, function (v) { ST.setSetting('heartSense', v); })));
    body.appendChild(mkRow('Proximity pings', 'Spatial ticks while the board is quiet',
      mkToggle(S.settings.sonarPings, function (v) { ST.setSetting('sonarPings', v); })));
    body.appendChild(mkField('Ping rate', mkSegmented([
      { label: 'Slow', value: 'slow' },
      { label: 'Normal', value: 'normal' },
      { label: 'Fast', value: 'fast' }
    ], S.settings.pingRate, function (v) { ST.setSetting('pingRate', v); })));
    body.appendChild(mkRow('Contact stings', 'Alert when a new threat becomes closest',
      mkToggle(S.settings.sonarStings, function (v) { ST.setSetting('sonarStings', v); })));

    /* ---- Ghost target filters (which Ghost-Mode targets are tracked) ---- */
    body.appendChild(U.el('div', 'section-label', 'Ghost targets'));
    body.appendChild(mkRow('Police stations', null,
      mkToggle(S.settings.ghostPolice, function (v) { ST.setSetting('ghostPolice', v); })));
    body.appendChild(mkRow('Speed cameras', null,
      mkToggle(S.settings.ghostCamera, function (v) { ST.setSetting('ghostCamera', v); })));
    body.appendChild(mkRow('Airplanes', null,
      mkToggle(S.settings.ghostAir, function (v) { ST.setSetting('ghostAir', v); })));
    body.appendChild(mkRow('Helicopters', null,
      mkToggle(S.settings.ghostHeli, function (v) { ST.setSetting('ghostHeli', v); })));

    /* ---- Data overlays ---- */
    body.appendChild(U.el('div', 'section-label', 'Map overlays'));
    body.appendChild(mkRow('Weather', 'Live precipitation radar (RainViewer, no key)',
      mkToggle(S.settings.showWeather, function (v) { ST.setSetting('showWeather', v, 'weather'); })));
    body.appendChild(mkField('Radar color', mkSegmented([
      { label: 'Radar', value: 'rain' },
      { label: 'Blue', value: 'temp' },
      { label: 'Vivid', value: 'wind' }
    ], S.settings.weatherLayer, function (v) { ST.setSetting('weatherLayer', v, 'weatherlayer'); })));
    body.appendChild(mkRow('Traffic', 'Live flow heatmap' + (A.config && A.config.routeCaps && A.config.routeCaps.routing ? '' : ' (needs server key)'),
      mkToggle(S.settings.showTraffic, function (v) { ST.setSetting('showTraffic', v, 'traffic'); })));
    body.appendChild(mkRow('Hazards', 'Weather + reported road hazards as pins',
      mkToggle(S.settings.showHazards, function (v) { ST.setSetting('showHazards', v, 'hazards'); })));

    body.appendChild(mkField('Units', mkSegmented([
      { label: 'Miles', value: 'mi' },
      { label: 'Kilometers', value: 'km' }
    ], S.settings.units, function (v) { ST.setUnits(v); })));

    body.appendChild(U.el('div', 'section-label', 'Data'));
    var reset = U.el('button', 'btn btn-ghost btn-block btn-danger-text', 'Reset app data');
    reset.addEventListener('click', function () {
      if (confirm('Reset profile, settings and convoy? The app will reload.')) ST.reset();
    });
    body.appendChild(reset);

    var about = U.el('div', 'about',
      'Convoy v0.3 · For passengers, never drivers.<br>' +
      'Maps © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> & ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> · Routing by OSRM.');
    body.appendChild(about);
  }

  function mkRow(title, sub, control) {
    var r = U.el('div', 'setting-row');
    r.innerHTML = '<div class="setting-text"><b>' + U.esc(title) + '</b>' + (sub ? '<span>' + U.esc(sub) + '</span>' : '') + '</div>';
    r.appendChild(control);
    return r;
  }

  /* ============================== search ============================== */
  function wireSearch() {
    var input = document.getElementById('search-input');
    var results = document.getElementById('search-results');
    var clearBtn = document.getElementById('search-clear');
    var items = [];

    var run = U.debounce(function () {
      var q = input.value.trim();
      if (q.length < 3) { results.hidden = true; return; }
      results.hidden = false;
      results.innerHTML = '<div class="sr-loading">Searching…</div>';
      A.routing.geocode(q).then(function (rows) {
        items = rows;
        if (!rows.length) {
          results.innerHTML = '<div class="sr-loading">No places found</div>';
          return;
        }
        results.innerHTML = '';
        rows.forEach(function (r) {
          var item = U.el('div', 'sr-item',
            '<span class="sr-pin"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12A7 7 0 0 0 5 9c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/></svg></span><span class="sr-text"><b>' + U.esc(r.label) + '</b><i>' + U.esc(r.sub) + '</i></span>');
          item.setAttribute('role', 'option');
          item.addEventListener('mousedown', function (e) {
            e.preventDefault();
            choose(r);
          });
          results.appendChild(item);
        });
      }).catch(function () {
        results.innerHTML = '<div class="sr-loading">Search unavailable — check connection</div>';
      });
    }, 350);

    function choose(r) {
      input.value = r.label;
      results.hidden = true;
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
        else if (items.length) choose(items[0]);
      }
      else if (e.key === 'Escape') { results.hidden = true; input.blur(); }
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { results.hidden = true; }, 150);
    });
    input.addEventListener('focus', function () {
      if (input.value.trim().length >= 3 && results.children.length) results.hidden = false;
    });
    clearBtn.addEventListener('click', function () {
      input.value = '';
      clearBtn.hidden = true;
      results.hidden = true;
      A.routing.clearRoute();
      input.focus();
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
    document.getElementById('chip-global').classList.toggle('chip-off', !S.settings.showGlobal);
  }

  /* ============================== walkie-talkie ============================== */
  // The PTT hold + spacebar wiring lives in js/voice.js (it owns mic state).
  // Here we only wire the mode-cycle button so the overlay is self-contained.
  function wireWalkieTalkie() {
    var cycle = document.getElementById('wt-cycle');
    if (!cycle) return;
    cycle.addEventListener('click', function () {
      if (!A.voice) return;
      var order = ['ptt', 'open', 'toggle'];
      var cur = A.voice.getMode();
      var next = order[(order.indexOf(cur) + 1) % order.length];
      A.voice.setMode(next);
      toast('Mic: ' + (next === 'ptt' ? 'Push-to-talk' : next === 'open' ? 'Open mic' : 'Toggle'), 'info');
    });
  }

  function updateLiveChip() {
    var label = S.netMode === 'live' ? ' riders online' : ' nearby';
    document.getElementById('chip-live-text').textContent = 'LIVE · ' + A.sim.count() + label;
  }

  /* ============================== live invites ============================== */
  function inviteToast(from, party, onAccept, onDecline) {
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

  function showAuth(onDone) {
    authOnDone = onDone || function () { };
    var root = document.getElementById('onboarding');
    root.hidden = false;
    root.classList.remove('closing');
    renderAuth('welcome');
    requestAnimationFrame(function () { root.classList.add('show'); });
  }

  function closeAuthEnter(msg) {
    var root = document.getElementById('onboarding');
    A.mapview.refreshPlayer();
    refreshAvatarBtn();
    fillProfileForm();
    renderAccount();
    root.classList.add('closing');
    setTimeout(function () {
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
      '  <p>See the road together. Built for <b>passengers</b> — the driver drives, you run the map.</p>' +
      '</div>';
  }

  function authBackHead(title) {
    var head = U.el('div', 'auth-head2');
    var back = U.el('button', 'auth-back', '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>');
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', function () { renderAuth('welcome'); });
    head.appendChild(back);
    head.appendChild(U.el('h2', 'auth-title', U.esc(title)));
    return head;
  }

  function showErr(el, msg) {
    if (!el) return;
    el.textContent = msg || 'Something went wrong';
    el.hidden = false;
  }

  function mkPassword(placeholder) {
    var i = U.el('input', 'input');
    i.type = 'password';
    i.placeholder = placeholder || 'Password';
    i.autocomplete = 'current-password';
    i.maxLength = 200;
    return i;
  }

  // Reusable car-setup fields (name, avatar, car, paint, pledge). Returns getProfile()+onPledge().
  function buildCarSetup(card) {
    var name = U.pick(D.NAMES);
    var make = U.pick(D.MAKE_LIST);
    var model = U.pick(D.MAKES[make]);
    var paint = U.pick(D.PAINTS);

    var nameInput = mkText(name, 'Display name');
    var emojiGrid = mkEmojiGrid(0);
    var yearSel = mkSelect(yearList(), 2022);
    var makeSel = mkSelect(D.MAKE_LIST, make);
    var modelSel = mkSelect(D.MAKES[make], model);
    var paintHex = paint.hex, paintName = paint.name;
    var swatches = mkSwatches(D.PAINTS, paintHex, function (hex, n) { paintHex = hex; paintName = n; });

    makeSel.addEventListener('change', function () {
      modelSel.innerHTML = '';
      D.MAKES[makeSel.value].forEach(function (m) {
        var o = document.createElement('option'); o.value = m; o.textContent = m; modelSel.appendChild(o);
      });
    });

    card.appendChild(mkField('Display name', nameInput));
    card.appendChild(mkField('Avatar', emojiGrid));
    var g3 = U.el('div', 'grid3');
    g3.appendChild(mkField('Year', yearSel));
    g3.appendChild(mkField('Make', makeSel));
    g3.appendChild(mkField('Model', modelSel));
    card.appendChild(g3);
    card.appendChild(mkField('Paint', swatches));

    var pledge = U.el('label', 'pledge');
    pledge.innerHTML = '<input type="checkbox"/><span>I\'m the <b>passenger</b>. The driver\'s eyes stay on the road.</span>';
    card.appendChild(pledge);

    return {
      getProfile: function () {
        var nm = nameInput.value.trim() || name;
        return {
          name: nm,
          handle: nm.toLowerCase().replace(/[^a-z0-9]/g, ''),
          emoji: emojiGrid.getValue(),
          vibe: U.pick(D.VIBES),
          car: {
            year: +yearSel.value, make: makeSel.value, model: modelSel.value,
            paint: paintHex, paintName: paintName, finish: 'Gloss'
          }
        };
      },
      onPledge: function (cb) {
        pledge.querySelector('input').addEventListener('change', function (e) { cb(e.target.checked); });
      }
    };
  }

  /* ----- generic overlay (reuses the modal backdrop while logged in) ----- */
  function openOverlay(card) {
    var root = document.getElementById('onboarding');
    root.hidden = false;
    root.classList.remove('closing');
    root.innerHTML = '';
    root.appendChild(card);
    requestAnimationFrame(function () { root.classList.add('show'); });
  }
  function closeOverlay() {
    var root = document.getElementById('onboarding');
    root.classList.add('closing');
    setTimeout(function () {
      root.hidden = true; root.innerHTML = '';
      root.classList.remove('closing', 'show');
    }, 380);
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
      'This is the <b>only</b> way to reset your password if you forget it. Save it somewhere safe — we can\'t recover it for you.'));
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
        if (r.ok) openOverlay(buildRecoveryCard(r.recoveryCode, 'Done', closeOverlay, 'Your new recovery code'));
        else { showErr(err, r.error); btn.disabled = false; btn.textContent = 'Generate new code'; }
      });
    });
    card.appendChild(btn);
    openOverlay(card);
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

  function renderAuth(mode) {
    var root = document.getElementById('onboarding');
    var card = U.el('div', 'modal-card');

    if (mode === 'welcome') {
      card.innerHTML = authHeader();
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
      var lu = mkText('', 'Username'); lu.autocomplete = 'username'; lu.maxLength = 20;
      var lp = mkPassword('Password');
      var lerr = U.el('div', 'auth-err'); lerr.hidden = true;
      card.appendChild(mkField('Username', lu));
      card.appendChild(mkField('Password', lp));
      card.appendChild(lerr);
      var lbtn = U.el('button', 'btn btn-primary btn-block btn-lg', 'Log in');
      var lsubmit = function () {
        lerr.hidden = true;
        if (!lu.value.trim() || !lp.value) { showErr(lerr, 'Enter your username and password'); return; }
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
      var forgotRow = U.el('div', 'auth-switch');
      var forgot = U.el('button', 'auth-link', 'Forgot password?');
      forgot.addEventListener('click', function () { renderAuth('recover'); });
      forgotRow.appendChild(forgot);
      card.appendChild(forgotRow);
      var lsw = U.el('div', 'auth-switch', 'New here? ');
      var lswa = U.el('button', 'auth-link', 'Create an account');
      lswa.addEventListener('click', function () { renderAuth('register'); });
      lsw.appendChild(lswa);
      card.appendChild(lsw);

    } else if (mode === 'recover') {
      card.appendChild(authBackHead('Reset password'));
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
            root.appendChild(buildRecoveryCard(r.recoveryCode, 'Saved — continue →',
              function () { closeAuthEnter('Password reset — welcome back, ' + S.profile.name); },
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
      var uInput, pInput, errEl;
      if (!isGuest) {
        uInput = mkText('', 'Pick a username'); uInput.autocomplete = 'username'; uInput.maxLength = 20;
        pInput = mkPassword('Create a password (6+ characters)');
        pInput.autocomplete = 'new-password';
        errEl = U.el('div', 'auth-err'); errEl.hidden = true;
        card.appendChild(mkField('Username', uInput));
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
        if (isGuest) {
          ST.saveProfile(profile);
          ST.setOnboarded();
          closeAuthEnter('Welcome aboard, ' + profile.name + ' — riders are live around you');
          return;
        }
        if (errEl) errEl.hidden = true;
        rbtn.disabled = true; rbtn.textContent = 'Creating…';
        A.auth.register(uInput.value.trim(), pInput.value, profile).then(function (r) {
          if (r.ok) {
            // show the recovery code before entering the app
            root.innerHTML = '';
            root.appendChild(buildRecoveryCard(r.recoveryCode, 'I saved it — start riding →',
              function () { closeAuthEnter('Welcome, ' + S.profile.name); },
              'Account created — save your recovery code',
              'You\'ll need this if you ever forget your password.'));
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
  }

  function renderAccount() {
    var box = document.getElementById('account-section');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(U.el('div', 'section-label', 'Account'));
    var loggedIn = A.auth && A.auth.isLoggedIn();
    var row = U.el('div', 'account-row');
    if (loggedIn) {
      row.innerHTML =
        '<div class="u-ava u-ava-sm" style="--paint:' + S.profile.car.paint + '">' + U.riderIcon(S.profile.emoji, { size: 16 }) + '</div>' +
        '<div class="account-info"><b>@' + U.esc(A.auth.username()) + '</b><span>Signed in · synced across devices</span></div>';
      var out = U.el('button', 'btn btn-ghost btn-small btn-danger-text', 'Log out');
      out.addEventListener('click', function () {
        if (confirm('Log out of @' + A.auth.username() + '? Your account stays saved.')) A.auth.logout();
      });
      row.appendChild(out);
      box.appendChild(row);
      var actions = U.el('div', 'account-actions');
      var chg = U.el('button', 'btn btn-ghost btn-small', 'Change password');
      chg.addEventListener('click', showChangePassword);
      var rec = U.el('button', 'btn btn-ghost btn-small', 'Recovery code');
      rec.addEventListener('click', showRegenRecovery);
      actions.appendChild(chg);
      actions.appendChild(rec);
      box.appendChild(actions);
      return;
    } else {
      row.innerHTML =
        '<div class="u-ava u-ava-sm" style="--paint:' + S.profile.car.paint + '">' + U.riderIcon(S.profile.emoji, { size: 16 }) + '</div>' +
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

    document.getElementById('btn-avatar').addEventListener('click', function () {
      openPanel(openName === 'profile' ? null : 'profile');
    });

    // Profile header gear → open/scroll to the Settings gear box (Settings has no dock tab).
    var psb = document.getElementById('profile-settings-btn');
    if (psb) psb.addEventListener('click', function () { toggleGearbox(); });

    // live refreshers
    ST.on('tick', function () { updateNearbyLive(); updateConvoyLive(); });
    ST.on('nearby:seeded', function () { updateLiveChip(); if (openName === 'nearby') renderNearby(); });
    ST.on('party', function () {
      updateDockBadge();
      if (openName === 'convoy') renderConvoy();
      if (openName === 'nearby') updateNearbyLive();
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
      toast(v ? 'Global drivers on — delayed ~5 min' : 'Global drivers hidden', 'info');
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

    // Ghost Mode: apply persisted state on boot, react to changes, and build
    // the status chip. The fetcher starts only after the map is ready.
    buildGhostChip();
    var ghostBtn = document.getElementById('ctl-ghost');
    if (ghostBtn) ghostBtn.addEventListener('click', function () { applyGhost(!S.settings.ghost); });
    ST.on('ghost', function (v) {
      if (A.mapview && A.mapview.setPlayerGhost) A.mapview.setPlayerGhost(v);
      if (A.mapview && A.mapview.setGhostLayersVisible) A.mapview.setGhostLayersVisible(v);
      if (A.ghost) { if (v) A.ghost.start(); else A.ghost.stop(); }
      if (A.radar) A.radar.setActive(v);
      updateGhostChip();
    });
    // if ghost was already on (persisted), apply it now that the map is live
    if (S.settings.ghost) {
      if (A.mapview && A.mapview.setPlayerGhost) A.mapview.setPlayerGhost(true);
      if (A.mapview && A.mapview.setGhostLayersVisible) A.mapview.setGhostLayersVisible(true);
      if (A.ghost) A.ghost.start();
      if (A.radar) A.radar.setActive(true);
    }
    ST.on('auth', function () { renderAccount(); });
    ST.on('profile', function () { if (openName === 'profile') renderAccount(); });
    ST.on('friends', function () {
      if (openName === 'nearby') renderNearby();
      updateNearbyDockBadge();
      if (A.mapview && A.mapview.reclassifyMarkers) A.mapview.reclassifyMarkers();
    });
    // auth.boot() decides whether to show the auth screen or enter the app
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
    toast: toast,
    inviteToast: inviteToast,
    showAuth: showAuth,
    renderAccount: renderAccount,
    welcomeBack: welcomeBack,
    openPanel: openPanel,
    closePanels: closePanels,
    refreshAvatarBtn: refreshAvatarBtn,
    applyGhost: applyGhost, // radar dock's exit button toggles ghost off through here
    nearbyFilter: function () { return nearbyFilter; } // mapview reads this to color dots by active filter
  };
})();

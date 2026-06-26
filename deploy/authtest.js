/* Exercise accounts/auth against production HTTPS. Creates one demo account. */
'use strict';
const https = require('https');
const WebSocket = require('ws');
const HOST = process.env.HOST || 'odoreeci.tech';

function apiPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = https.request({ host: HOST, path, method: 'POST', headers, timeout: 12000 }, (res) => {
      let b = ''; res.on('data', (d) => b += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}
function apiGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: HOST, path, method: 'GET', headers: token ? { Authorization: 'Bearer ' + token } : {}, timeout: 12000 }, (res) => {
      let b = ''; res.on('data', (d) => b += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
function wsHello(token, pos, profile) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://' + HOST + '/ws');
    const st = { ws, id: null, sees: new Set(), account: null, invite: null, party: null };
    const to = setTimeout(() => { resolve(st); }, 6000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, pos, heading: 90, profile })));
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.t === 'welcome') { st.id = m.id; st.account = m.account; (m.riders || []).forEach((r) => st.sees.add(r.id)); clearTimeout(to); resolve(st); }
    });
    ws.on('error', () => { clearTimeout(to); resolve(st); });
    st._live = () => { ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch (e) { return; } if (m.t === 'rider:add') st.sees.add(m.rider.id); if (m.t === 'invite') st.invite = m; if (m.t === 'party') st.party = m.party; }); };
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 6);

(async () => {
  const userA = 'demo_' + tag;
  const profA = { name: 'DemoAlpha', emoji: '🛰️', vibe: 'Road trip!', car: { year: 2025, make: 'Tesla', model: 'Model S', paint: '#4f8cff', paintName: 'Pulse Blue', finish: 'Gloss' } };
  const profB = { name: 'DemoBravo', emoji: '🦊', vibe: 'Night drive', car: { year: 2023, make: 'Subaru', model: 'WRX STI', paint: '#19c2b8', paintName: 'Miami Teal', finish: 'Matte' } };

  console.log('1) register https://' + HOST + '/api/register  user=' + userA);
  const reg = await apiPost('/api/register', { username: userA, password: 'demopass123', profile: profA });
  console.log('   ->', reg.status, reg.body.token ? '(token issued, handle=' + reg.body.profile.handle + ')' : JSON.stringify(reg.body));
  const tokenA = reg.body.token;

  console.log('2) login with correct + wrong password');
  const good = await apiPost('/api/login', { username: userA, password: 'demopass123' });
  const bad = await apiPost('/api/login', { username: userA, password: 'nope' });
  console.log('   correct ->', good.status, good.body.token ? 'token ok' : '', '| wrong ->', bad.status, bad.body.error);

  console.log('3) GET /api/me with token');
  const me = await apiGet('/api/me', tokenA);
  console.log('   ->', me.status, me.body.username, '-', me.body.profile && (me.body.profile.car.make + ' ' + me.body.profile.car.model));

  console.log('4) two authenticated clients convoy over wss');
  const A = await wsHello(tokenA, [-118.25, 34.05], profA); A._live();
  // second account
  const userB = 'demo2_' + tag;
  const regB = await apiPost('/api/register', { username: userB, password: 'demopass123', profile: profB });
  const B = await wsHello(regB.body.token, [-118.248, 34.051], profB); B._live();
  await wait(2500);
  console.log('   A id=' + A.id + ' account=' + JSON.stringify(A.account));
  console.log('   B id=' + B.id + ' account=' + JSON.stringify(B.account));
  console.log('   A sees B:', A.sees.has(B.id), '| B sees A:', B.sees.has(A.id));

  A.ws.send(JSON.stringify({ t: 'party:create', name: 'Account Test Convoy', emoji: '🔒' }));
  await wait(1000);
  A.ws.send(JSON.stringify({ t: 'party:invite', to: B.id }));
  await wait(1500);
  if (B.invite) { B.ws.send(JSON.stringify({ t: 'party:accept', pid: B.invite.party.id })); await wait(1500); }
  console.log('   B got invite from:', B.invite ? B.invite.from.name : 'NONE',
    '| convoy members:', A.party ? A.party.members.map((m) => m.name + '(@' + (m.id) + ')').length : 0);

  A.ws.close(); B.ws.close();
  const ok = tokenA && good.status === 200 && bad.status === 401 && me.status === 200 &&
    A.account && A.account.username === userA && A.sees.has(B.id) && B.invite;
  console.log('\n' + (ok ? 'RESULT: PASS — accounts work over production HTTPS (register, login, token ws, convoy).' : 'RESULT: check output above.'));
  console.log('Demo accounts created: @' + userA + ' / @' + userB + ' (password demopass123) — delete from server/data/users.json if unwanted.');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

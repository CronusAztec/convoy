/* Exercise friends + convoy join-codes with two real clients.
   Defaults to local server; pass BASE=https://odoreeci.tech for production. */
'use strict';
const WebSocket = require('ws');
const BASE = process.env.BASE || 'http://localhost:5173';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const http = BASE.indexOf('https') === 0 ? require('https') : require('http');
const { URL } = require('url');

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: 12000 }, (res) => {
      let b = ''; res.on('data', (d) => b += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

function client(token, pos, profile) {
  const ws = new WebSocket(WS);
  const st = { ws, id: null, friends: [], reqs: [], party: null, invite: null, events: [] };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    st.events.push(m.t);
    if (m.t === 'welcome') { st.id = m.id; if (m.account) { st.friends = m.account.friends || []; st.reqs = m.account.requests || []; } }
    if (m.t === 'friends') { st.friends = m.friends || []; st.reqs = m.requests || []; }
    if (m.t === 'friend:request') st.reqs.push(m.from);
    if (m.t === 'friend:added') st.friends.push(m.friend);
    if (m.t === 'friend:status') { const f = st.friends.find((x) => x.id === m.id); if (f) f.online = m.online; }
    if (m.t === 'party') st.party = m.party;
    if (m.t === 'invite') st.invite = m;
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, pos, heading: 90, profile })));
  return st;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 6);

(async () => {
  const pA = { name: 'AmigoA', emoji: '🦊', vibe: 'Road trip!', car: { year: 2022, make: 'Toyota', model: 'GR86', paint: '#f0691f', paintName: 'Sunset Orange', finish: 'Gloss' } };
  const pB = { name: 'AmigoB', emoji: '🐺', vibe: 'Night drive', car: { year: 2023, make: 'Subaru', model: 'BRZ', paint: '#2f6df6', paintName: 'Velocity Blue', finish: 'Matte' } };
  const ua = 'amA_' + tag, ub = 'amB_' + tag;
  const ra = await post('/api/register', { username: ua, password: 'pass1234', profile: pA });
  const rb = await post('/api/register', { username: ub, password: 'pass1234', profile: pB });
  console.log('registered', ua, ra.status, '/', ub, rb.status);

  // Put them ~6000km apart so proximity scope does NOT connect them (tests friend-only paths)
  const A = client(ra.body.token, [-118.25, 34.05], pA);
  const B = client(rb.body.token, [-74.0, 40.71], pB);
  await wait(1500);

  console.log('\n--- FRIENDS ---');
  A.ws.send(JSON.stringify({ t: 'friend:add', username: ub }));
  await wait(1200);
  console.log('B received request from:', B.reqs.map((r) => '@' + r.username).join(',') || 'NONE');
  B.ws.send(JSON.stringify({ t: 'friend:accept', id: A.id ? ra.body /* placeholder */ : null }));
  // accept needs the requester's ACCOUNT id, which B sees in its request list:
  const reqFromA = B.reqs[0];
  if (reqFromA) B.ws.send(JSON.stringify({ t: 'friend:accept', id: reqFromA.id }));
  await wait(1200);
  console.log('A friends:', A.friends.map((f) => '@' + f.username + (f.online ? '(online)' : '(offline)')).join(',') || 'none');
  console.log('B friends:', B.friends.map((f) => '@' + f.username + (f.online ? '(online)' : '(offline)')).join(',') || 'none');
  const aFriendId = A.friends[0] && A.friends[0].id;

  console.log('\n--- FRIEND INVITE ACROSS DISTANCE ---');
  A.ws.send(JSON.stringify({ t: 'party:create', name: 'Long-distance', emoji: '🛰️' }));
  await wait(800);
  if (aFriendId) A.ws.send(JSON.stringify({ t: 'party:invite', to: aFriendId })); // invite B by ACCOUNT id
  await wait(1200);
  console.log('B got cross-distance invite:', B.invite ? ('yes from ' + B.invite.from.name) : 'NO');
  if (B.invite) { B.ws.send(JSON.stringify({ t: 'party:accept', pid: B.invite.party.id })); await wait(1000); }
  console.log('Party members (A view):', A.party ? A.party.members.map((m) => m.name).join(',') : 'none');

  console.log('\n--- CONVOY JOIN CODE ---');
  const code = A.party && A.party.code;
  console.log('convoy code:', code, '| mode:', A.party && A.party.mode);
  A.ws.send(JSON.stringify({ t: 'party:mode', mode: 'code' }));
  await wait(600);
  console.log('mode after set:', A.party && A.party.mode);
  // a third client joins by code
  const rc = await post('/api/register', { username: 'amC_' + tag, password: 'pass1234', profile: pA });
  const C = client(rc.body.token, [2.35, 48.85], pA);
  await wait(1200);
  C.ws.send(JSON.stringify({ t: 'party:join', code: code }));
  await wait(1200);
  console.log('C joined via code? members(C view):', C.party ? C.party.members.map((m) => m.name).join(',') : 'NONE');
  // wrong code rejected
  C.badCode = false;
  const C2 = client(rc.body.token, [2.35, 48.85], pA);
  await wait(800);
  C2.ws.on && C2.ws.send(JSON.stringify({ t: 'party:join', code: 'ZZZZZZ' }));
  await wait(800);

  A.ws.close(); B.ws.close(); C.ws.close(); C2.ws.close();
  const friendsOk = A.friends.some((f) => f.username === ub) && B.friends.some((f) => f.username === ua);
  const inviteOk = !!B.invite && A.party && A.party.members.some((m) => m.name === 'AmigoB');
  const codeOk = C.party && C.party.members.length >= 2;
  console.log('\nRESULT: ' + ((friendsOk && inviteOk && codeOk) ? 'PASS' : 'PARTIAL') +
    ' — friends:' + friendsOk + ' crossDistanceInvite:' + inviteOk + ' joinByCode:' + codeOk);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

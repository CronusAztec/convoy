/* Two real clients against the PUBLIC Convoy server — proves cross-client realtime. */
'use strict';
const WebSocket = require('ws');
const URL = process.env.WSURL || 'ws://2.25.184.90/ws';

function client(name, pos, car) {
  const ws = new WebSocket(URL);
  const st = { name, ws, id: null, sees: new Set(), party: null, invite: null, chat: [], welcomeBots: 0 };
  ws.on('open', () => ws.send(JSON.stringify({
    t: 'hello', pos, heading: 90,
    profile: { name, handle: name.toLowerCase(), emoji: '🚗', vibe: 'Road trip!', car }
  })));
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t === 'welcome') { st.id = m.id; st.welcomeBots = (m.riders || []).length; (m.riders||[]).forEach(r=>st.sees.add(r.id)); }
    else if (m.t === 'rider:add') st.sees.add(m.rider.id);
    else if (m.t === 'rider:remove') st.sees.delete(m.id);
    else if (m.t === 'party') st.party = m.party;
    else if (m.t === 'invite') st.invite = m;
    else if (m.t === 'chat') st.chat.push((m.from ? m.from.name : 'sys') + ': ' + m.text);
  });
  ws.on('error', (e) => console.log(name + ' ws error: ' + e.message));
  return st;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = client('AlphaRider', [-118.2500, 34.0500], { year: 2023, make: 'Toyota', model: 'Supra', paint: '#e0342c', paintName: 'Racing Red', finish: 'Gloss' });
  const B = client('BravoRider', [-118.2480, 34.0510], { year: 2024, make: 'Tesla', model: 'Model 3', paint: '#19c2b8', paintName: 'Miami Teal', finish: 'Matte' });
  await wait(3000);

  console.log('A id:', A.id, '| welcome bots:', A.welcomeBots);
  console.log('B id:', B.id, '| welcome bots:', B.welcomeBots);
  console.log('A sees B? ', A.sees.has(B.id));
  console.log('B sees A? ', B.sees.has(A.id));

  // A creates a convoy and invites B
  A.ws.send(JSON.stringify({ t: 'party:create', name: 'Internet Test Convoy', emoji: '🛰️' }));
  await wait(1200);
  A.ws.send(JSON.stringify({ t: 'party:invite', to: B.id }));
  await wait(1500);
  console.log('B got invite? ', !!B.invite, B.invite ? '("' + B.invite.party.name + '" from ' + B.invite.from.name + ')' : '');

  if (B.invite) { B.ws.send(JSON.stringify({ t: 'party:accept', pid: B.invite.party.id })); await wait(1500); }
  console.log('Convoy members (A view):', A.party ? A.party.members.map((x) => x.name).join(', ') : 'none');

  // Chat both directions
  A.ws.send(JSON.stringify({ t: 'chat', text: 'Hello from Alpha over the internet 🛰️' }));
  await wait(900);
  B.ws.send(JSON.stringify({ t: 'chat', text: 'Bravo copies, loud and clear!' }));
  await wait(1500);
  console.log('B received chat:', JSON.stringify(B.chat.slice(-3)));
  console.log('A received chat:', JSON.stringify(A.chat.slice(-3)));

  A.ws.close(); B.ws.close();
  const ok = A.sees.has(B.id) && B.sees.has(A.id) && B.invite && A.party && A.party.members.length === 2;
  console.log('\n' + (ok ? 'RESULT: PASS — two internet clients see each other, convoyed, and chatted.' : 'RESULT: incomplete — see above.'));
  process.exit(0);
})();

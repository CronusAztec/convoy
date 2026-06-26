/* Password reset/change/regenerate against a server (default production HTTPS). */
'use strict';
const BASE = process.env.BASE || 'https://odoreeci.tech';
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

const prof = { name: 'ResetDemo', emoji: '🔑', vibe: 'Commute grind', car: { year: 2020, make: 'Honda', model: 'Civic', paint: '#7d8590', paintName: 'Nardo Gray', finish: 'Gloss' } };
const tag = Math.random().toString(36).slice(2, 6);
const user = 'reset_' + tag;

(async () => {
  const reg = await post('/api/register', { username: user, password: 'aaa111', profile: prof });
  const code1 = reg.body.recoveryCode;
  const tok = reg.body.token;
  console.log('register:', reg.status, '| recovery code:', code1);

  const chg = await post('/api/change-password', { oldPassword: 'aaa111', newPassword: 'bbb222' }, tok);
  const loginNew = await post('/api/login', { username: user, password: 'bbb222' });
  const loginOld = await post('/api/login', { username: user, password: 'aaa111' });
  console.log('change-password:', chg.status, '| login new pass:', loginNew.status, '| old pass:', loginOld.status, '(expect 200/401)');

  const regen = await post('/api/recovery', { password: 'bbb222' }, tok);
  const code2 = regen.body.recoveryCode;
  console.log('regenerate code:', regen.status, '| new code:', code2, '| changed:', code1 !== code2);

  const recOld = await post('/api/recover', { username: user, code: code1, password: 'ccc333' });
  const recNew = await post('/api/recover', { username: user, code: code2, password: 'ccc333' });
  const loginFinal = await post('/api/login', { username: user, password: 'ccc333' });
  console.log('recover w/ OLD code:', recOld.status, '(expect 401) | w/ NEW code:', recNew.status, '(expect 200) | login after:', loginFinal.status);

  const ok = reg.status === 200 && /^CVY-/.test(code1 || '') && chg.status === 200 &&
    loginNew.status === 200 && loginOld.status === 401 && regen.status === 200 &&
    code1 !== code2 && recOld.status === 401 && recNew.status === 200 && loginFinal.status === 200;
  console.log('\nRESULT: ' + (ok ? 'PASS — password reset/change/regenerate all correct on ' + BASE : 'CHECK OUTPUT'));
  console.log('(demo account @' + user + ' created on the server)');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

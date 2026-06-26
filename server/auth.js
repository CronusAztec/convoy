/* Convoy — stateless auth tokens (HMAC-SHA256). No session storage needed.
   Secret is generated once and persisted to DATA_DIR/.secret so tokens survive restarts. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SECRET_FILE = path.join(DATA_DIR, '.secret');
const TTL_MS = parseInt(process.env.TOKEN_TTL_DAYS || '30', 10) * 24 * 3600 * 1000;

let SECRET = null;
function secret() {
  if (SECRET) return SECRET;
  try {
    SECRET = fs.readFileSync(SECRET_FILE);
  } catch (e) {
    SECRET = crypto.randomBytes(32);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
    } catch (e2) { console.error('[auth] could not persist secret:', e2.message); }
  }
  return SECRET;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function mintToken(uid, ver) {
  const payload = b64url(JSON.stringify({ uid, ver: ver || 0, exp: Date.now() + TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch (e) { return null; }
  if (!data || !data.uid || !data.exp || data.exp < Date.now()) return null;
  return data; // { uid, ver } — caller must check ver against the user's current tokenVersion
}

module.exports = { mintToken, verifyToken };

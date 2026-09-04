#!/usr/bin/env node
/* Copies the web assets (index.html, js/, css/) into www/ so Capacitor can
   bundle them into the Android app. The server still serves from the project
   root — this only feeds Capacitor's webDir. Run before `cap sync`. */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const www = path.join(root, 'www');
const targets = ['index.html', 'js', 'css', 'fonts'];

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rmrf(www);
fs.mkdirSync(www, { recursive: true });
for (const t of targets) {
  const src = path.join(root, t);
  if (!fs.existsSync(src)) { console.warn('skip (missing):', t); continue; }
  const dst = path.join(www, t);
  if (fs.statSync(src).isDirectory()) copyDir(src, dst);
  else fs.copyFileSync(src, dst);
  console.log('copied', t);
}
console.log('www/ ready for Capacitor');

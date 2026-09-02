#!/usr/bin/env node
/* Convoy — OTA bundle packer.

   Turns www/ (the same tree Capacitor freezes into the APK) into the two files
   the OTA channel serves:

     ota-out/bundle-<version>.zip   the web layer, zip-rooted exactly like the
                                    APK bundles it (index.html at the top)
     ota-out/manifest.json          what release.js --ota uploads beside it

   Everything about the version comes from the ONE identity the app already
   has: the ?v=cyNNN cache-buster in index.html (telemetry reports it, the web
   client busts caches with it). cy109 packs as "1.0.109", and the Android
   versionName follows the same number, so the server can tell an old APK's
   builtin (version_name "builtin" + version_build "1.0.108") from a fresh one
   without any new bookkeeping.

   The zip is DETERMINISTIC — fixed entry order (sorted), fixed timestamps
   (1980-01-01, the zip epoch), deflate level 9 — so identical trees pack to
   identical bytes and the sha256 in the manifest is a content fingerprint,
   not a build artifact. A hand-rolled writer keeps that guarantee reviewable
   and dependency-free; it round-trip verifies every entry before emitting.

   Refuses to pack a version that is not newer than what the channel is
   already serving (stale pushes are the classic hotfix-channel accident)
   unless --force. --offline skips the check for local drills and tests.

   Run from the project root:
       node scripts/pack-ota.js                # refresh www/ (copy-web) then pack
       node scripts/pack-ota.js --reuse-www    # pack www/ as-is on disk
       node scripts/pack-ota.js --force        # pack even when not newer
       node scripts/pack-ota.js --offline      # don't consult the live channel
       node scripts/pack-ota.js --note "…"    # operator note recorded in the manifest
   release.js drives this module directly for --ota, so flags and module API
   stay in one place. */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const OUT_DIR = path.join(ROOT, 'ota-out');
const DEFAULT_SITE = (process.env.SITE_URL || 'https://odoreeci.tech').replace(/\/+$/, '');

/* ---------------- version identity ---------------- */

/* Read the cache-buster stamp out of index.html. Every asset tag must carry
   the SAME stamp: a mixed page means a half-done bump, and a bundle built from
   one is half-old-half-new with a version label that describes neither. */
function readStamp(html) {
  const stamps = new Set();
  let m;
  const re = /[?&]v=(cy\d{1,5})["'?&\s]/g;
  while ((m = re.exec(html))) stamps.add(m[1]);
  if (stamps.size === 0) return { error: 'no ?v=cyNNN cache-buster found in index.html' };
  if (stamps.size > 1) return { error: 'mixed cache-busters in index.html: ' + Array.from(stamps).join(', ') };
  return { stamp: Array.from(stamps)[0] };
}

function versionFromStamp(stamp) { return '1.0.' + parseInt(String(stamp).slice(2), 10); }

/* Minimal semver compare, deliberately NOT shared with server/ota.js — this
   script must run where the server's dependencies (pg, store.js) don't exist.
   Returns >0 when a is newer, 0 when equal, <0 when older; unparseable sorts
   below everything. */
function cmpVersion(a, b) {
  const pa = String(a || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  const pb = String(b || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 1; i <= 3; i++) {
    if (+pa[i] !== +pb[i]) return +pa[i] < +pb[i] ? -1 : 1;
  }
  return 0;
}

/* ---------------- deterministic zip ---------------- */

/* Collect every file under dir as a sorted list of zip entry names (forward
   slashes, forward-sorted, no directory entries — ZipInputStream creates dirs
   implicitly). A symlink inside www/ is a mistake, not something to silently
   dereference: the APK pipeline copies real files, and a symlink target could
   live anywhere. */
function walkFiles(dir) {
  const out = [];
  (function walk(p, rel) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      const name = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) throw new Error('symlink in bundle tree: ' + name + ' — resolve it, don\'t pack it');
      if (e.isDirectory()) walk(full, name);
      else if (e.isFile()) out.push(name);
    }
  })(dir, '');
  out.sort();
  return out;
}

/* Build the zip as a Buffer. Entry layout is the boring standard one: local
   file header + data per entry, then the central directory, then the EOCD.
   Timestamps are pinned to 1980-01-01 00:00 (zip epoch) so builds reproduce
   byte-for-byte. Deflate only when it actually wins; stored entries otherwise. */
function buildZip(dir) {
  const names = walkFiles(dir);
  if (!names.length) throw new Error('no files found under ' + dir);
  if (names.indexOf('index.html') < 0) {
    throw new Error('index.html missing from the zip root — the WebView would have nothing to load');
  }
  const parts = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(dir, name));
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    // Round-trip every entry before it ships — a hand-rolled zip writer earns
    // its keep by proving each record decodes back to the original bytes.
    const back = useDeflate ? zlib.inflateRawSync(body) : body;
    if (back.length !== data.length || (zlib.crc32(back) >>> 0) !== crc) {
      throw new Error('zip self-check failed for ' + name);
    }

    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header sig
    lh.writeUInt16LE(20, 4);           // version needed: 2.0
    lh.writeUInt16LE(0, 6);            // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);           // time 00:00:00
    lh.writeUInt16LE(0x0021, 12);      // date 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nb.length, 26);
    lh.writeUInt16LE(0, 28);           // extra length
    parts.push(lh, nb, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory sig
    ch.writeUInt16LE(20, 4);           // made by: spec 2.0, DOS — no attrs claimed
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt16LE(0, 30);           // extra
    ch.writeUInt16LE(0, 32);           // comment
    ch.writeUInt16LE(0, 34);           // disk number
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(offset, 42);      // local header offset
    central.push(Buffer.concat([ch, nb]));
    offset += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat(parts.concat([cd, eocd]));
}

/* ---------------- manifest ---------------- */

const KEEP_HISTORY = 10;

/* Assemble the manifest to publish. `published` is the channel's current
   /api/ota summary (or null): its current entry becomes history[0], so every
   push keeps the rollback chain intact without the server remembering state. */
function manifestFor(entry, published, force) {
  const m = {
    version: entry.version,
    file: entry.file,
    checksum: entry.checksum,
    size: entry.size,
    note: entry.note || '',
    force: !!force,
    history: []
  };
  if (published && published.current && published.current.version !== entry.version) {
    m.history.push(published.current);
  }
  if (published && Array.isArray(published.history)) {
    for (const h of published.history) {
      if (m.history.length >= KEEP_HISTORY) break;
      if (h.version !== entry.version && (!m.history[0] || h.version !== m.history[0].version)) {
        m.history.push(h);
      }
    }
  }
  m.history = m.history.slice(0, KEEP_HISTORY);
  return m;
}

/* ---------------- published-state fetch ---------------- */

function fetchPublished(siteUrl) {
  return new Promise((resolve) => {
    const url = siteUrl + '/api/ota';
    const proto = url.startsWith('https') ? 'https' : 'http';
    const req = require(proto).get(url, { timeout: 10000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ ok: false, status: res.statusCode, body: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/* ---------------- pack ---------------- */

/* The whole pack, as one call so release.js and the tests share it.
   opts: { reuseWww, offline, force, site, note, outDir }
   Resolves { version, stamp, zipPath, manifestPath, zipBytes, sha256 } or
   rejects with the reason. */
async function pack(opts) {
  opts = opts || {};
  const outDir = opts.outDir || OUT_DIR;
  const site = (opts.site || DEFAULT_SITE);

  if (!opts.reuseWww) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'copy-web.js')],
      { stdio: 'inherit', shell: false });
    if (r.status !== 0) throw new Error('copy-web.js failed');
  }
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const st = readStamp(html);
  if (st.error) throw new Error(st.error);
  const version = versionFromStamp(st.stamp);

  let published = null;
  if (!opts.offline) {
    const res = await fetchPublished(site);
    if (!res.ok || !res.body) throw new Error(
      'could not read the published channel at ' + site + '/api/ota (' + (res.error || res.status) + ') ' +
      '— refusing to pack blind. Use --offline for a local drill, or --force if you really mean it.');
    published = res.body;
    const cur = published.current && published.current.version;
    if (cur && cmpVersion(version, cur) <= 0 && !opts.force) {
      throw new Error('stamp ' + st.stamp + ' (v' + version + ') is not newer than the published bundle v' +
        cur + ' — bump ?v= in index.html, or pass --force to push anyway.');
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const zipBytes = buildZip(WWW);
  const sha256 = crypto.createHash('sha256').update(zipBytes).digest('hex');
  const file = 'bundle-' + version + '.zip';
  const zipPath = path.join(outDir, file);
  fs.writeFileSync(zipPath, zipBytes);

  const manifest = manifestFor(
    { version, file, checksum: sha256, size: zipBytes.length, note: opts.note || '' },
    published, false);
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return {
    version, stamp: st.stamp, zipPath, manifestPath, zipBytes: zipBytes.length,
    sha256, manifest, published: published || { current: null, history: [] }
  };
}

/* Rollback target: the newest history entry (or null when the channel has
   never had a previous bundle). release.js --ota --rollback turns this into a
   forced manifest — forced, because a rollback is by definition not newer. */
function rollbackTarget(published) {
  if (!published || !Array.isArray(published.history) || !published.history.length) return null;
  return published.history[0];
}

module.exports = { readStamp, versionFromStamp, cmpVersion, buildZip, walkFiles,
  manifestFor, fetchPublished, pack, rollbackTarget,
  _WWW: WWW, _OUT_DIR: OUT_DIR };

/* ---------------- CLI ---------------- */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };
  pack({
    reuseWww: has('--reuse-www'),
    offline: has('--offline'),
    force: has('--force'),
    note: arg('--note') || '',
    outDir: arg('--out')
  }).then((r) => {
    console.log('\nOTA bundle packed:');
    console.log('  stamp      ' + r.stamp + '  →  version ' + r.version);
    console.log('  zip        ' + r.zipPath + '  (' + Math.round(r.zipBytes / 1024) + ' KB)');
    console.log('  sha256     ' + r.sha256);
    console.log('  manifest   ' + r.manifestPath);
    console.log('\nPublish with:  node release.js --ota');
    if (r.manifest.history.length) {
      console.log('Rollback to:   v' + r.manifest.history[0].version +
        '  (node release.js --ota --rollback)');
    }
  }).catch((e) => {
    console.error('pack-ota: ' + e.message);
    process.exit(1);
  });
}

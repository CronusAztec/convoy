/* Convoy — Google Play release control (the control panel's store half).

   The OTA channel (ota.js) covers the web layer: an HTML/CSS/JS fix reaches
   installed APKs in minutes with no review. What it CANNOT do is ship native
   code — a new Capacitor plugin, a permission change, a Gradle bump. Those go
   through Google Play, and until now that meant a browser, the Play Console,
   and a human clicking through a wizard. That is a bad place to be at 2am when
   the fix is built and sitting on disk.

   This module is the Play Console's publishing API, reduced to the four moves
   an operator actually makes during an incident:

       upload   a built .aab/.apk → a track, as a staged rollout
       promote  a version from one track to another (internal → production)
       rollout  change the staged-rollout fraction (5% → 20% → 100%)
       halt     stop a rollout dead; resume puts it back

   ── How Play's API actually works (the part that bites) ───────────────────

   Every change is a transaction called an "edit": you insert one, mutate as
   much as you like, then commit. Nothing is live until the commit, and an
   uncommitted edit expires on its own. That is genuinely good for us — a
   failed upload leaves production untouched — but it means every operation
   here is three round trips, and an edit MUST be discarded on failure or it
   lingers and blocks the next one with a conflict. withEdit() owns that.

   Track releases carry a status, and the status decides which other fields
   are legal — get this wrong and the API returns a 400 that reads like a
   riddle:

       completed   fully live.       userFraction MUST be absent
       inProgress  staged rollout.   userFraction REQUIRED, 0 < f < 1
       halted      rollout stopped.  keeps the fraction it had
       draft       uploaded, unreleased

   So "roll out to 100%" is not `userFraction: 1` — it is `completed` with the
   field dropped entirely. validateRollout() encodes those rules once so the
   panel can refuse a bad combination before spending a round trip on it.

   ── Auth ─────────────────────────────────────────────────────────────────

   A Google Cloud service account with the Android Publisher role, invited to
   the Play Console. Its JSON key signs a short-lived RS256 JWT which is
   exchanged for an access token (the "two-legged OAuth" flow) — no refresh
   token, no interactive consent, nothing to expire in a drawer. Node's crypto
   signs RS256 natively, so this file has zero dependencies like the rest of
   the server.

   Unset PLAY_SERVICE_ACCOUNT_JSON ⇒ configured() is false ⇒ the panel renders
   the Play page as "not configured" and every action refuses. The failure
   mode is a store page that does nothing, never a half-published release.

   ── Deliberately NOT here ────────────────────────────────────────────────

   Listing copy, screenshots, pricing, data-safety answers. Those are review-
   gated content decisions, not incident moves, and the Console is the right
   place for them. This module only ever touches which BUILD is live and to
   HOW MANY people — which is exactly the surface an emergency needs. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const PKG = process.env.PLAY_PACKAGE || 'tech.odoreeci.convoy';
const KEY_FILE = process.env.PLAY_SERVICE_ACCOUNT_JSON || '';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/';

// Play's four tracks, ordered least → most exposed. The panel promotes along
// this list and the ordering is what makes "promote to the next track" mean
// something; a promotion that moves DOWN the list is a rollback and is
// allowed, but the panel says so out loud.
const TRACKS = ['internal', 'alpha', 'beta', 'production'];
const STATUSES = ['completed', 'inProgress', 'halted', 'draft'];

// An .aab is tens of megabytes over a residential uplink; the other calls are
// small JSON. One generous ceiling beats a per-call table nobody maintains.
const TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 20 * 1000;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;   // Play's own AAB ceiling is 200MB post-split

/* ---------------- service account ---------------- */

let keyCache = null;      // { email, privateKey } — parsed once, kept

function loadKey() {
  if (keyCache) return keyCache;
  if (!KEY_FILE) throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not set');
  let raw;
  try { raw = fs.readFileSync(KEY_FILE, 'utf8'); }
  catch (e) { throw new Error('cannot read the service-account key at ' + KEY_FILE + ': ' + e.message); }
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { throw new Error('the service-account key is not valid JSON'); }
  if (!obj || !obj.client_email || !obj.private_key) {
    throw new Error('the service-account key has no client_email/private_key — is it an OAuth client file by mistake?');
  }
  // Keys pasted through env/CI often arrive with literal \n instead of newlines,
  // which fails deep inside the signer with an unhelpful message. Fix it here.
  keyCache = {
    email: String(obj.client_email),
    privateKey: String(obj.private_key).replace(/\\n/g, '\n')
  };
  return keyCache;
}

function configured() {
  if (!KEY_FILE) return false;
  try { loadKey(); return true; }
  catch (e) { return false; }
}

// Why configured() is false, for the panel to render. Never thrown at a caller.
function configError() {
  if (!KEY_FILE) return 'PLAY_SERVICE_ACCOUNT_JSON is not set';
  try { loadKey(); return ''; }
  catch (e) { return e.message; }
}

function b64url(s) {
  return Buffer.from(s).toString('base64url');
}

/* The assertion Google trades for an access token. Signed RS256 over
   header.claims with the service account's private key; `aud` must be the
   token endpoint itself or the exchange is rejected. */
function signAssertion(now) {
  const key = loadKey();
  const iat = Math.floor((now || Date.now()) / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.email,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: iat + 3600,
    iat: iat
  }));
  const input = header + '.' + claims;
  const sig = crypto.createSign('RSA-SHA256').update(input).sign(key.privateKey).toString('base64url');
  return input + '.' + sig;
}

/* ---------------- access token ---------------- */

let tokenCache = { value: '', exp: 0 };

async function token() {
  // 60s of slack so a token can't expire mid-upload.
  if (tokenCache.value && Date.now() < tokenCache.exp - 60000) return tokenCache.value;
  const assertion = signAssertion(Date.now());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
            '&assertion=' + encodeURIComponent(assertion),
      signal: ctrl.signal
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    throw new Error('Google token endpoint unreachable: ' +
      (e.name === 'AbortError' ? 'timed out' : e.message));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !body || !body.access_token) {
    // The most common cause by far is a service account that exists in Cloud
    // but was never invited to the Play Console. Say so — the raw error
    // ("unauthorized_client") does not.
    const why = (body && (body.error_description || body.error)) || ('HTTP ' + res.status);
    throw new Error('Google refused the service account (' + why +
      ') — check it has the Android Publisher role AND an invitation in the Play Console');
  }
  tokenCache = {
    value: body.access_token,
    exp: Date.now() + (Number(body.expires_in) || 3600) * 1000
  };
  return tokenCache.value;
}

/* ---------------- HTTP ---------------- */

/* Every Play call goes through here. Returns { status, body } and does NOT
   throw for a non-2xx — callers decide what a status means (a 409 on commit
   is "someone else edited", a 404 on a track is "nothing released there").
   Network failures DO throw, so they can't be mistaken for a refusal. */
async function call(method, url, opts) {
  opts = opts || {};
  const headers = { 'Authorization': 'Bearer ' + await token() };
  let payload;
  if (opts.raw) {
    headers['Content-Type'] = opts.contentType || 'application/octet-stream';
    payload = opts.raw;
  } else if (opts.body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: method, headers: headers, body: payload, signal: ctrl.signal });
  } catch (e) {
    throw new Error('Google Play API unreachable: ' +
      (e.name === 'AbortError' ? 'timed out' : e.message));
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }   // 204s
  return { status: res.status, body: body || {} };
}

/* Play nests its errors ({error:{message, errors:[{reason,message}]}}); flatten
   so the panel shows one readable line instead of a JSON blob. */
function errText(r) {
  const e = r && r.body && r.body.error;
  if (!e) return 'HTTP ' + (r ? r.status : '?');
  if (e.errors && e.errors.length && e.errors[0].message) {
    return e.errors[0].message + ' (' + (e.errors[0].reason || r.status) + ')';
  }
  return (e.message || 'HTTP ' + r.status);
}

/* ---------------- the edit transaction ---------------- */

/* insert → fn(editId) → commit, discarding the edit if anything throws.

   The discard matters more than it looks: an abandoned edit is not free.
   Play allows one open edit per app, and the next insert fails until the
   stale one expires — turning a single failed upload into a locked-out
   publishing pipeline for the rest of the incident. Discard failures are
   swallowed (the edit expires on its own) but never hide the real error. */
async function withEdit(fn) {
  const ins = await call('POST', API + PKG + '/edits');
  if (ins.status !== 200 || !ins.body.id) {
    throw new Error('could not open a Play edit: ' + errText(ins));
  }
  const editId = ins.body.id;
  let result;
  try {
    result = await fn(editId);
  } catch (e) {
    await call('DELETE', API + PKG + '/edits/' + editId).catch(() => {});
    throw e;
  }
  const commit = await call('POST', API + PKG + '/edits/' + editId + ':commit');
  if (commit.status !== 200) {
    await call('DELETE', API + PKG + '/edits/' + editId).catch(() => {});
    throw new Error('Play rejected the commit: ' + errText(commit) + ' — nothing was published');
  }
  return result;
}

/* A read that must not leave a transaction behind. Tracks are only readable
   inside an edit, so reads open one and always discard it — a read has
   nothing to commit, and committing an untouched edit still burns a version
   of the app's listing. */
async function withReadEdit(fn) {
  const ins = await call('POST', API + PKG + '/edits');
  if (ins.status !== 200 || !ins.body.id) {
    throw new Error('could not open a Play edit: ' + errText(ins));
  }
  const editId = ins.body.id;
  try {
    return await fn(editId);
  } finally {
    await call('DELETE', API + PKG + '/edits/' + editId).catch(() => {});
  }
}

/* ---------------- rollout rules ---------------- */

/* The status/userFraction contract from the header comment, checked BEFORE a
   round trip. Returns a release-shaped object or throws a sentence an
   operator can act on. `fraction` arrives as a percent (the panel's unit)
   because "5%" is what a human says; Play wants 0.05. */
function releaseFor(versionCodes, status, percent, notes) {
  if (!STATUSES.includes(status)) {
    throw new Error('status must be one of: ' + STATUSES.join(', '));
  }
  const rel = { versionCodes: versionCodes.map(String), status: status };
  if (status === 'inProgress' || status === 'halted') {
    const f = Number(percent);
    if (!Number.isFinite(f) || f <= 0 || f >= 100) {
      throw new Error('a staged rollout needs a percentage above 0 and below 100 — ' +
        'use "completed" for a full release');
    }
    // Play stores the fraction, not the percent, and rejects more precision
    // than it keeps.
    rel.userFraction = Math.round((f / 100) * 10000) / 10000;
  }
  if (notes) {
    // en-US is the listing's default language; release notes in a language the
    // listing does not declare are rejected outright.
    rel.releaseNotes = [{ language: 'en-US', text: String(notes).slice(0, 500) }];
  }
  return rel;
}

function validTrack(t) {
  return TRACKS.includes(String(t));
}

/* ---------------- reads ---------------- */

/* Every track, its live release, and how far it has rolled out. This is the
   Play page's whole model — one call, one edit, no mutation. */
async function status() {
  return withReadEdit(async (editId) => {
    const r = await call('GET', API + PKG + '/edits/' + editId + '/tracks');
    if (r.status !== 200) throw new Error('could not read tracks: ' + errText(r));
    const byName = new Map();
    for (const t of (r.body.tracks || [])) byName.set(t.track, t);
    return TRACKS.map((name) => {
      const t = byName.get(name);
      const releases = ((t && t.releases) || []).map((rel) => ({
        name: rel.name || '',
        versionCodes: (rel.versionCodes || []).map(String),
        status: rel.status || '',
        // Back to percent for display; `completed` has no fraction by law.
        percent: rel.userFraction != null ? Math.round(rel.userFraction * 1000) / 10 : null,
        notes: (rel.releaseNotes && rel.releaseNotes[0] && rel.releaseNotes[0].text) || ''
      }));
      return { track: name, releases: releases };
    });
  });
}

/* The live release on a track — the one an operator means by "the rollout".
   Prefers an in-progress/halted staged release over a completed one, because
   that is the one with a knob to turn. */
function liveRelease(track) {
  const rels = (track && track.releases) || [];
  return rels.find((r) => r.status === 'inProgress') ||
         rels.find((r) => r.status === 'halted') ||
         rels.find((r) => r.status === 'completed') ||
         rels[0] || null;
}

/* ---------------- writes ---------------- */

/* Replace a track's releases with one release. Play's PUT is a whole-track
   replace, not a merge — which is why every write below builds the complete
   release object rather than patching a field. */
async function putTrack(editId, track, release) {
  const r = await call('PUT', API + PKG + '/edits/' + editId + '/tracks/' + track, {
    body: { track: track, releases: [release] }
  });
  if (r.status !== 200) throw new Error('Play rejected the track update: ' + errText(r));
  return r.body;
}

/* Upload a built artifact and release it. `filePath` is a local .aab or .apk —
   the file release.js just built, sitting on the same disk as this process.

   The versionCode is Play's, not ours: it is assigned by the upload response,
   so a caller never has to know or guess it. (Play rejects a versionCode it
   has already seen, which is the single most common publish failure — the
   error is surfaced verbatim because "you already uploaded 4" is exactly what
   the operator needs to hear.) */
async function upload(filePath, opts) {
  opts = opts || {};
  const track = String(opts.track || 'internal');
  if (!validTrack(track)) throw new Error('unknown track: ' + track);
  const isBundle = /\.aab$/i.test(filePath);
  if (!isBundle && !/\.apk$/i.test(filePath)) {
    throw new Error('only .aab and .apk artifacts can be uploaded');
  }
  let st;
  try { st = fs.statSync(filePath); }
  catch (e) { throw new Error('no artifact at ' + filePath); }
  if (!st.isFile() || !st.size) throw new Error('the artifact at ' + filePath + ' is empty');
  if (st.size > MAX_ARTIFACT_BYTES) throw new Error('artifact is larger than the 512MB ceiling');

  // Validate the release shape BEFORE spending an upload on it — a rejected
  // rollout percentage after a 40MB push is an avoidable insult.
  releaseFor(['0'], String(opts.status || 'inProgress'), opts.percent, opts.notes);

  const bytes = fs.readFileSync(filePath);
  return withEdit(async (editId) => {
    const kind = isBundle ? 'bundles' : 'apks';
    const up = await call('POST',
      UPLOAD + PKG + '/edits/' + editId + '/' + kind + '?uploadType=media', {
        raw: bytes,
        contentType: isBundle ? 'application/octet-stream' : 'application/vnd.android.package-archive'
      });
    if (up.status !== 200 || !up.body.versionCode) {
      throw new Error('upload failed: ' + errText(up));
    }
    const versionCode = String(up.body.versionCode);
    const release = releaseFor([versionCode], String(opts.status || 'inProgress'), opts.percent, opts.notes);
    await putTrack(editId, track, release);
    return { versionCode: versionCode, track: track, status: release.status,
             percent: release.userFraction != null ? release.userFraction * 100 : null,
             sha256: up.body.sha256 || '' };
  });
}

/* Move whatever is live on `from` onto `to`. The classic internal → production
   walk. The version codes come from the source track, so a promotion can
   never publish a build nobody tested. */
async function promote(opts) {
  opts = opts || {};
  const from = String(opts.from || ''), to = String(opts.to || '');
  if (!validTrack(from) || !validTrack(to)) throw new Error('unknown track');
  if (from === to) throw new Error('source and destination are the same track');
  return withEdit(async (editId) => {
    const r = await call('GET', API + PKG + '/edits/' + editId + '/tracks/' + from);
    if (r.status !== 200) throw new Error('could not read ' + from + ': ' + errText(r));
    const src = liveRelease({ releases: (r.body.releases || []).map((x) => ({
      status: x.status, versionCodes: (x.versionCodes || []).map(String)
    })) });
    if (!src || !src.versionCodes.length) {
      throw new Error('nothing is released on ' + from + ' to promote');
    }
    const release = releaseFor(src.versionCodes, String(opts.status || 'completed'), opts.percent, opts.notes);
    await putTrack(editId, to, release);
    return { versionCodes: src.versionCodes, from: from, to: to, status: release.status,
             percent: release.userFraction != null ? release.userFraction * 100 : null };
  });
}

/* Turn the rollout knob on a track that already has a release: 5% → 20% → 100%.
   Passing 100 means "completed", which drops userFraction — the one conversion
   an operator should never have to remember. */
async function setRollout(track, percent, notes) {
  if (!validTrack(track)) throw new Error('unknown track: ' + track);
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error('rollout percentage must be above 0 and at most 100');
  }
  return withEdit(async (editId) => {
    const r = await call('GET', API + PKG + '/edits/' + editId + '/tracks/' + track);
    if (r.status !== 200) throw new Error('could not read ' + track + ': ' + errText(r));
    const cur = liveRelease({ releases: (r.body.releases || []).map((x) => ({
      status: x.status, versionCodes: (x.versionCodes || []).map(String)
    })) });
    if (!cur || !cur.versionCodes.length) throw new Error('nothing is released on ' + track);
    const release = pct >= 100
      ? releaseFor(cur.versionCodes, 'completed', null, notes)
      : releaseFor(cur.versionCodes, 'inProgress', pct, notes);
    await putTrack(editId, track, release);
    return { track: track, versionCodes: cur.versionCodes, status: release.status,
             percent: pct >= 100 ? 100 : pct };
  });
}

/* THE STORE KILL SWITCH. Halting a staged rollout stops Play handing the
   build to anyone new — installs already out there stay out there, which is
   what the OTA channel and the feature flags are for. A halted rollout can be
   resumed at any fraction, so this is a pause, not a burn.

   Note what it cannot do: a `completed` release has no rollout left to halt.
   Play's own answer there is to roll forward with a fixed build, and the
   panel says so rather than pretending a button exists. */
async function halt(track) {
  if (!validTrack(track)) throw new Error('unknown track: ' + track);
  return withEdit(async (editId) => {
    const r = await call('GET', API + PKG + '/edits/' + editId + '/tracks/' + track);
    if (r.status !== 200) throw new Error('could not read ' + track + ': ' + errText(r));
    const rels = (r.body.releases || []);
    const live = rels.find((x) => x.status === 'inProgress');
    if (!live) {
      const completed = rels.find((x) => x.status === 'completed');
      throw new Error(completed
        ? 'the ' + track + ' release is fully live (100%) — a completed rollout cannot be halted, ' +
          'roll forward with a fixed build instead'
        : 'no rollout is in progress on ' + track);
    }
    // A halted release keeps the fraction it was halted at, so resuming knows
    // where it left off.
    const release = {
      versionCodes: (live.versionCodes || []).map(String),
      status: 'halted',
      userFraction: live.userFraction
    };
    await putTrack(editId, track, release);
    return { track: track, versionCodes: release.versionCodes,
             percent: Math.round((live.userFraction || 0) * 1000) / 10 };
  });
}

/* Undo a halt — back to inProgress at the given percentage (or the one it was
   halted at). */
async function resume(track, percent) {
  if (!validTrack(track)) throw new Error('unknown track: ' + track);
  return withEdit(async (editId) => {
    const r = await call('GET', API + PKG + '/edits/' + editId + '/tracks/' + track);
    if (r.status !== 200) throw new Error('could not read ' + track + ': ' + errText(r));
    const live = (r.body.releases || []).find((x) => x.status === 'halted');
    if (!live) throw new Error('nothing is halted on ' + track);
    const pct = Number(percent);
    const want = Number.isFinite(pct) && pct > 0
      ? pct
      : Math.round((live.userFraction || 0.05) * 1000) / 10;
    const release = want >= 100
      ? releaseFor((live.versionCodes || []).map(String), 'completed', null, null)
      : releaseFor((live.versionCodes || []).map(String), 'inProgress', want, null);
    await putTrack(editId, track, release);
    return { track: track, versionCodes: release.versionCodes, percent: want >= 100 ? 100 : want };
  });
}

function init() {
  const why = configError();
  console.log('[boot] Play publishing: ' + (why
    ? 'DISABLED (' + why + ')'
    : 'enabled for ' + PKG));
}

module.exports = {
  init, configured, configError, status, upload, promote, setRollout, halt, resume,
  liveRelease, TRACKS, STATUSES, PKG,
  // test surface: the pure halves, drivable without a Google account
  _releaseFor: releaseFor, _signAssertion: signAssertion, _errText: errText,
  _validTrack: validTrack, _withEdit: withEdit, _MAX_ARTIFACT_BYTES: MAX_ARTIFACT_BYTES,
  _resetTokenForTest: () => { tokenCache = { value: '', exp: 0 }; keyCache = null; }
};

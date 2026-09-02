/* Convoy — the SDK inventory has to stay true.

   Both stores make you declare what your SDKs collect, not just what your own
   servers receive, and Google scans the uploaded artifact for identifiers you did
   not declare. The failure mode is not a crash — it is a form that was accurate
   the day it was filled in and quietly stopped being accurate three dependencies
   later. Nothing in a normal build catches that.

   So this suite pins SDK-INVENTORY.md to the code:

     - every npm dependency, every gradle artifact and every remotely-loaded
       script must appear on that page, so adding one fails here until it is
       written down and the Data Safety form is re-checked;
     - no ads / analytics / attribution SDK may appear in any gradle file;
     - android/app/google-services.json must not exist — app/build.gradle applies
       the Firebase plugin the moment it does, which pulls Firebase into the APK
       and silently changes the label;
     - the manifest must not declare AD_ID, and the native code must not read a
       device identifier.

   The last three are the ones that matter most: they are the exact shapes
   Google's scan flags, and each is invisible in review until an upload is
   rejected.

   Run:  node test/sdk-inventory.test.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { group, ok, report, ROOT } = require('./harness');

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch (e) { return ''; }
}
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

// Substring matching is too generous for short names — "ws" and "pg" appear
// inside ordinary English words on the page, so a missing dependency would pass.
// Require the name to stand alone.
function names(hay, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  return new RegExp('(^|[^A-Za-z0-9_@./-])' + esc + '($|[^A-Za-z0-9_@./-])').test(hay);
}

const INVENTORY = read('SDK-INVENTORY.md');

/* ================================================================== */
group('the inventory exists and is wired into the release checklist');

ok('SDK-INVENTORY.md is present', INVENTORY.length > 0);
ok('...and DEPLOY.md points at it from the pre-launch checklist',
  /SDK-INVENTORY\.md/.test(read('DEPLOY.md')),
  'a list nobody is sent to read is a list that goes stale');

/* ================================================================== */
group('every npm dependency is written down');

function deps(rel) {
  let pkg;
  try { pkg = JSON.parse(read(rel)); } catch (e) { return []; }
  return Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
}

const npm = deps('package.json').concat(deps('server/package.json'));
ok('found the dependency lists at all', npm.length > 0, 'npm=' + npm.length);
npm.forEach(function (name) {
  ok('npm: ' + name, names(INVENTORY, name),
    name + ' is a dependency but is not in SDK-INVENTORY.md — add a row, then ' +
    're-check the Data Safety form before shipping it');
});

/* ================================================================== */
group('every gradle artifact is written down');

// Matches "group:artifact:version" in either quote style, including $variable
// versions. Project deps (project(':capacitor-android')) are caught separately.
const GRADLE_FILES = ['android/app/build.gradle', 'android/app/capacitor.build.gradle',
  'android/build.gradle'];
const artifacts = new Set();
const projects = new Set();
GRADLE_FILES.forEach(function (f) {
  const src = read(f);
  let m;
  const coord = /["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):[^"']*["']/g;
  while ((m = coord.exec(src))) artifacts.add(m[1] + ':' + m[2]);
  const proj = /project\(['"]:([A-Za-z0-9_.-]+)['"]\)/g;
  while ((m = proj.exec(src))) projects.add(m[1]);
});

ok('found gradle artifacts to check', artifacts.size > 0, 'artifacts=' + artifacts.size);
artifacts.forEach(function (coord) {
  const artifact = coord.split(':')[1];
  ok('gradle: ' + coord, names(INVENTORY, artifact),
    coord + ' is linked into the APK but is not in SDK-INVENTORY.md');
});
projects.forEach(function (p) {
  ok('gradle project: ' + p, names(INVENTORY, p),
    ':' + p + ' is linked into the APK but is not in SDK-INVENTORY.md');
});

/* ================================================================== */
group('every remotely-loaded script is written down');

// Code and assets the client pulls from someone else's host. Each of these sees
// the device IP, so each is a row on the page whether or not it "collects".
const hosts = new Set();
function collectHosts(src) {
  let m;
  const re = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
  while ((m = re.exec(src))) hosts.add(m[1].toLowerCase());
}
collectHosts(read('index.html').split('<noscript>')[0]);
['ui.js', 'mapview.js'].forEach(function (f) {
  const src = read('js/' + f);
  // Only the places that actually FETCH from a host at runtime.
  let m;
  const re = /(?:loadScript\(|src\s*=\s*|nsfwjs\.load\(|:\s*)['"](https:\/\/[^'"]+)['"]/g;
  while ((m = re.exec(src))) collectHosts(m[1]);
});

// Hosts that appear only inside explanatory comments/links, not as fetches.
const NOT_FETCHED = ['www.w3.org', 'schemas.android.com', 'odoreeci.tech'];
const fetched = Array.from(hosts).filter(function (h) { return NOT_FETCHED.indexOf(h) < 0; });

ok('found remote hosts to check', fetched.length > 0, JSON.stringify(fetched));
fetched.forEach(function (h) {
  ok('host: ' + h, INVENTORY.indexOf(h) >= 0,   // hosts are unambiguous as substrings
    h + ' serves code or assets to the app but is not in SDK-INVENTORY.md');
});

/* ================================================================== */
group('no ads, analytics or attribution SDK has crept in');

// Artifact fragments that would each change the privacy label the moment they
// appear. Checked against the gradle files rather than the APK so this runs
// without a build.
const BANNED = [
  'play-services-ads', 'play-services-ads-identifier', 'play-services-measurement',
  'firebase-analytics', 'firebase-crashlytics', 'firebase-perf', 'firebase-messaging',
  'com.appsflyer', 'com.adjust', 'io.branch', 'com.segment', 'com.amplitude',
  'com.mixpanel', 'com.onesignal', 'com.facebook.android', 'com.google.android.gms:play-services-ads'
];
const allGradle = GRADLE_FILES.map(read).join('\n') + read('android/variables.gradle');
BANNED.forEach(function (b) {
  ok('absent: ' + b, allGradle.indexOf(b) < 0,
    b + ' is linked — it collects on its own, so SDK-INVENTORY.md §1 and the ' +
    'Data Safety form both need updating before this ships');
});

/* ================================================================== */
group('the Firebase trapdoor is still shut');

// app/build.gradle applies the google-services plugin IF this file exists. It is
// one file away from Firebase being in the APK, collecting an app-instance id,
// with the label unchanged.
ok('android/app/google-services.json is absent', !exists('android/app/google-services.json'),
  'google-services.json is present, so app/build.gradle is applying the Firebase ' +
  'plugin and Firebase is in the APK — declare it, or remove the file');
ok('...and app/build.gradle still gates the plugin on that file, rather than always applying it',
  /google-services\.json/.test(read('android/app/build.gradle')),
  'if the gate is gone, this test no longer proves anything');

/* ================================================================== */
group('no device or advertising identifier is collected');

const manifest = read('android/app/src/main/AndroidManifest.xml');
ok('the manifest declares no AD_ID permission',
  manifest.indexOf('com.google.android.gms.permission.AD_ID') < 0,
  'Play correlates AD_ID with advertising-ID use — declaring it means declaring ' +
  'the "Device or other IDs" data type too');
ok('the manifest was actually read', manifest.indexOf('android.permission.INTERNET') >= 0);

// Every identifier API worth naming, across the Java we wrote.
const javaDir = path.join(ROOT, 'android/app/src/main/java');
function javaFiles(dir) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(javaFiles(p));
    else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}
const java = javaFiles(javaDir).map(function (f) { return fs.readFileSync(f, 'utf8'); }).join('\n');
ok('there is native Java to check', java.length > 0);
[['ANDROID_ID', 'Settings.Secure.ANDROID_ID'], ['getDeviceId', 'IMEI / device id'],
 ['getMacAddress', 'MAC address'], ['AdvertisingIdClient', 'advertising id'],
 ['getImei', 'IMEI'], ['getSubscriberId', 'IMSI']].forEach(function (pair) {
  ok('native code never reads ' + pair[1], java.indexOf(pair[0]) < 0,
    pair[0] + ' appears in the native sources — that is a "Device or other IDs" ' +
    'declaration, and Play\'s scan will find it');
});

/* ================================================================== */
group('the label answers are actually on the page');

// Not a judgement on whether they are right — a check that the section exists and
// still covers the types this app plainly handles, so nobody deletes it by
// accident and leaves the inventory without its conclusion.
[['Precise location', 'location'], ['Email address', 'email'], ['User IDs', 'user ids'],
 ['Voice or sound recordings', 'voice'], ['Crash logs', 'crash logs'],
 ['Device or other IDs', 'device ids']].forEach(function (pair) {
  ok('Data Safety row present: ' + pair[0], INVENTORY.indexOf(pair[0]) >= 0);
});
ok('the answer for device identifiers is explicitly "No"',
  /\*\*Device or other IDs\*\*\s*\|\s*\*\*No\*\*/.test(INVENTORY),
  'the one row Google scans for has to say No in as many words');

process.exit(report());

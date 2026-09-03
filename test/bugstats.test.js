/* Convoy — BUGS.md "## Stats" table integrity. `npm test` (test/run.js)

   BUGS.md's Stats table summarizes every `### BUG <prefix>-NNN` entry by
   severity. It has drifted from the real numbers before (Finding G, cycle 3
   stage 13: two of the table's own "corrected... was mis-added" notes were
   backwards — the smaller original numbers were the right ones). This suite
   regenerates the table from the file itself — headers paired 1:1 with the
   `- **Severity:**` line that follows each one — and fails loudly if the
   checked-in table doesn't match, instead of letting it drift silently again.
   Pure text parsing, no jsdom — fast. */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');

const ROOT = H.ROOT;
const BUGS_PATH = path.join(ROOT, 'BUGS.md');

const CATEGORY_ORDER = ['frontend', 'server', 'android', 'ui', 'runtime', 'add', 'perf'];
const CATEGORY_LABEL = {
  frontend: 'Frontend', server: 'Server', android: 'Android', ui: 'UI/UX',
  runtime: 'Runtime', add: 'Add', perf: 'Perf'
};
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

function parseBugCounts(text) {
  const lines = text.split('\n');
  const counts = {};
  for (const prefix of CATEGORY_ORDER) counts[prefix] = { critical: 0, high: 0, medium: 0, low: 0 };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^### BUG ([a-z]+)-\d+/);
    if (!m) continue;
    const prefix = m[1];
    let sev = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const sm = lines[j].match(/^- \*\*Severity:\*\* (\w+)/);
      if (sm) { sev = sm[1]; break; }
    }
    if (!sev || SEVERITIES.indexOf(sev) === -1) {
      throw new Error('BUG ' + prefix + '-??? near BUGS.md line ' + (i + 1) + ' has no parseable Severity line');
    }
    if (!counts[prefix]) counts[prefix] = { critical: 0, high: 0, medium: 0, low: 0 };
    counts[prefix][sev]++;
  }
  return counts;
}

function parseStatsTable(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Stats');
  if (start === -1) throw new Error('BUGS.md has no "## Stats" section');
  const rows = {};
  let total = null;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (i > start && /^#/.test(l)) break; // the severity table ends at the next heading (the roll-up below has its own)
    if (!l.startsWith('|')) continue;
    const raw = l.split('|'); // raw[0] is '' (text before the first pipe)
    if (raw.length < 7) continue;
    const area = raw[1].trim().replace(/\*/g, '');
    const nums = raw.slice(2, 6).map((c) => parseInt(c.replace(/\*/g, '').trim(), 10));
    if (nums.some((n) => Number.isNaN(n))) continue; // header/separator rows
    if (area === 'Total') { total = nums; continue; }
    rows[area] = nums;
  }
  return { rows, total };
}

function testBugStatsTableMatchesFile() {
  H.group('BUGS.md — "## Stats" table matches the file\'s own ### BUG / Severity lines');
  const text = fs.readFileSync(BUGS_PATH, 'utf8');
  const headerCount = (text.match(/^### BUG /gm) || []).length;
  const severityCount = (text.match(/^- \*\*Severity:\*\* /gm) || []).length;
  H.ok('every "### BUG" header has exactly one paired "Severity" line (' +
    headerCount + ' headers, ' + severityCount + ' severities)',
    headerCount === severityCount, 'these must be 1:1 for the table below to be trustworthy');

  const counts = parseBugCounts(text);
  H.ok('no bug category appears in the file that this suite does not know about',
    Object.keys(counts).every((p) => CATEGORY_ORDER.indexOf(p) !== -1),
    'found: ' + Object.keys(counts).join(', ') + ' — add any new prefix to CATEGORY_ORDER in this test');

  const { rows, total } = parseStatsTable(text);

  const grand = [0, 0, 0, 0];
  let grandTotal = 0;
  for (const prefix of CATEGORY_ORDER) {
    const label = CATEGORY_LABEL[prefix];
    const c = counts[prefix];
    const expected = [c.critical, c.high, c.medium, c.low];
    const expectedTotal = expected.reduce((a, b) => a + b, 0);
    for (let k = 0; k < 4; k++) grand[k] += expected[k];
    grandTotal += expectedTotal;
    const actual = rows[label];
    H.ok('Stats table row "' + label + '" (' + (actual ? actual.join('/') : 'MISSING') +
      ') matches ' + prefix + '-* bugs recomputed from BUGS.md (' + expected.join('/') + ', total ' + expectedTotal + ')',
      !!actual && actual.length === 4 && actual.every((n, k) => n === expected[k]),
      'recomputed: critical=' + c.critical + ' high=' + c.high + ' medium=' + c.medium + ' low=' + c.low);
  }
  H.ok('Stats table "Total" row (' + (total ? total.join('/') : 'MISSING') +
    ') matches the sum of every category (' + grand.join('/') + ', grand total ' + grandTotal + ')',
    !!total && total.length === 4 && total.every((n, k) => n === grand[k]),
    'recomputed grand total: critical=' + grand[0] + ' high=' + grand[1] + ' medium=' + grand[2] + ' low=' + grand[3]);
  H.ok('grand total (' + grandTotal + ') equals the count of "### BUG " headers (' + headerCount + ')',
    grandTotal === headerCount);
}

/* ---- B3 truth pass (cycle 53, 2026-09-03): the ledger is machine-checked ----
   Every Server + Runtime entry carries exactly one
     - **Status:** OPEN|FIXED|STALE (re-verified YYYY-MM-DD)[ — evidence]
   line right after its Severity line. FIXED/STALE must cite a real path in
   backticks, and the anti-rot check is the point of the whole thing: two
   "critical" server entries filed against server/auth.js sat in this file for
   two months after that file was deleted and nothing noticed. Now a FIXED line
   whose evidence path vanishes — or a STALE line whose "no longer exists" path
   comes back — turns npm test red with the bug's ID in the message. Scoped to
   ## Server and ## Runtime by the B3 pass, ## Frontend added by the cycle-60
   C4a pass (23 entries; test/domids.test.js executes the four "no null check"
   entries); ## UI/UX is C4b and ## Android is aspect D — each inherits these
   checks by being added to STATUS_SECTIONS. */
const STATUS_SECTIONS = ['Server', 'Runtime', 'Frontend'];
const STATUS_RE = /^- \*\*Status:\*\* (OPEN|FIXED|STALE) \(re-verified (\d{4}-\d{2}-\d{2})\)( — (.+))?$/;
const GONE_RE = /no longer exists|does not exist|was removed/;
// `server/server.js:3054` → server/server.js · `js/net.js:222-230` → js/net.js · `users.json` → users.json
const PATH_RE = /`([\w][\w./-]*\.(?:js|mjs|cjs|json|md|html|css|java|xml|gradle|service|sh|bat|env|txt))(?::\d+(?:-\d+)?)?`/g;

function citedPaths(tail) {
  const out = [];
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(tail || ''))) out.push(m[1]);
  return out;
}

function parseStatuses(text) {
  const lines = text.split('\n');
  const entries = [];
  let section = null, cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h2 = l.match(/^## (.+?)\s*$/);
    if (h2) { section = h2[1]; cur = null; continue; }
    const h3 = l.match(/^### BUG ([a-z]+-\d+)/);
    if (h3) { cur = { id: h3[1], section, line: i + 1, sevLine: null, statuses: [] }; entries.push(cur); continue; }
    if (!cur) continue;
    if (cur.sevLine === null && /^- \*\*Severity:\*\* /.test(l)) cur.sevLine = i + 1;
    if (/^- \*\*Status:\*\*/.test(l)) {
      const m = l.match(STATUS_RE);
      cur.statuses.push({ line: i + 1, status: m ? m[1] : null, date: m ? m[2] : null, tail: m ? (m[4] || '') : '' });
    }
  }
  return entries.filter((e) => STATUS_SECTIONS.indexOf(e.section) !== -1);
}

function parseRollup(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^### Open-status roll-up/.test(l));
  if (start === -1) return null;
  const rows = {};
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#/.test(l)) break;
    if (!l.startsWith('|')) continue;
    const raw = l.split('|');
    if (raw.length < 6) continue;
    const area = raw[1].trim().replace(/\*/g, '');
    const nums = raw.slice(2, 6).map((c) => parseInt(c.replace(/\*/g, '').trim(), 10));
    if (nums.some((n) => Number.isNaN(n))) continue;
    rows[area] = nums; // [OPEN, FIXED, STALE, total]
  }
  return rows;
}

function testStatusLedger() {
  H.group('BUGS.md — ' + STATUS_SECTIONS.join(' + ') + ' "Status" lines are present, well-formed and not rotten (B3 + C4a)');
  const text = fs.readFileSync(BUGS_PATH, 'utf8');
  const entries = parseStatuses(text);
  const ids = (arr) => arr.map((e) => e.id).join(', ') || 'none';

  const wrongCount = entries.filter((e) => e.statuses.length !== 1);
  H.ok('every ' + STATUS_SECTIONS.join('/') + ' entry (' + entries.length + ') carries exactly one "- **Status:**" line',
    entries.length >= 57 && wrongCount.length === 0,
    'entries with 0 or 2+ Status lines: ' + ids(wrongCount) + (entries.length < 57 ? ' (only ' + entries.length + ' entries parsed — 32 Server + 6 Runtime + 23 Frontend expected)' : ''));

  const misplaced = entries.filter((e) => e.statuses.length &&
    (e.sevLine === null || e.sevLine > e.line + 5 || e.statuses[0].line <= e.sevLine));
  H.ok('Status follows Severity, and Severity stays within 5 lines of the header (the Stats parser above depends on it)',
    misplaced.length === 0, 'misplaced: ' + ids(misplaced));

  const malformed = entries.filter((e) => e.statuses.some((st) => !st.status));
  H.ok('every Status line reads "OPEN|FIXED|STALE (re-verified YYYY-MM-DD)[ — evidence]" — nothing else',
    malformed.length === 0, 'malformed: ' + ids(malformed));

  const flat = [];
  for (const e of entries) for (const st of e.statuses) if (st.status) flat.push(Object.assign({ id: e.id }, st));

  const noEvidence = flat.filter((st) => (st.status === 'FIXED' || st.status === 'STALE') && citedPaths(st.tail).length === 0);
  H.ok('every FIXED and STALE line cites at least one `path` in its evidence tail',
    noEvidence.length === 0, 'no path cited: ' + ids(noEvidence));

  // The anti-rot check. FIXED: every cited path must exist. STALE: when the tail
  // says something is gone, the FIRST cited path must be absent and the rest
  // (what replaced it) must exist; otherwise everything cited must exist.
  const rotten = [];
  for (const st of flat) {
    if (st.status === 'OPEN') continue;
    const gone = st.status === 'STALE' && GONE_RE.test(st.tail);
    citedPaths(st.tail).forEach((p, i) => {
      const exists = fs.existsSync(path.join(ROOT, p));
      if (gone && i === 0) { if (exists) rotten.push(st.id + ' says `' + p + '` is gone but it exists'); }
      else if (!exists) rotten.push(st.id + ' cites `' + p + '` which does not exist');
    });
  }
  H.ok('anti-rot: every FIXED evidence path exists on disk, and a STALE "no longer exists" path really is gone',
    rotten.length === 0, rotten.join('; ') || 'none');

  const tally = {};
  for (const e of entries) {
    const t = tally[e.section] || (tally[e.section] = { OPEN: 0, FIXED: 0, STALE: 0, total: 0 });
    const st = e.statuses[0] && e.statuses[0].status;
    if (st) t[st]++;
    t.total++;
  }
  const rollup = parseRollup(text);
  H.ok('BUGS.md has an "### Open-status roll-up" table under ## Stats',
    !!rollup && Object.keys(rollup).length >= STATUS_SECTIONS.length + 1, 'missing or unparseable roll-up table (need a row per STATUS_SECTIONS area + Total)');
  const grand = { OPEN: 0, FIXED: 0, STALE: 0, total: 0 };
  for (const area of STATUS_SECTIONS) {
    const t = tally[area] || { OPEN: 0, FIXED: 0, STALE: 0, total: 0 };
    for (const k of Object.keys(grand)) grand[k] += t[k];
    const expected = [t.OPEN, t.FIXED, t.STALE, t.total];
    const actual = rollup && rollup[area];
    H.ok('roll-up row "' + area + '" (' + (actual ? actual.join('/') : 'MISSING') +
      ') matches the Status lines (OPEN/FIXED/STALE/total = ' + expected.join('/') + ')',
      !!actual && actual.length === 4 && actual.every((n, k) => n === expected[k]), 'recomputed: ' + expected.join('/'));
  }
  const expectedTotal = [grand.OPEN, grand.FIXED, grand.STALE, grand.total];
  const actualTotal = rollup && rollup.Total;
  H.ok('roll-up "Total" row (' + (actualTotal ? actualTotal.join('/') : 'MISSING') + ') matches (' + expectedTotal.join('/') + ')',
    !!actualTotal && actualTotal.length === 4 && actualTotal.every((n, k) => n === expectedTotal[k]), 'recomputed: ' + expectedTotal.join('/'));
}

testBugStatsTableMatchesFile();
testStatusLedger();
process.exit(H.report());

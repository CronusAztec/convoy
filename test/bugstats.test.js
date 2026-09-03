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

testBugStatsTableMatchesFile();
process.exit(H.report());

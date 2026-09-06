/* One-off quality pass on landing/index.html: html-validate + axe-core in jsdom.
   Same tooling the app's frontend gate uses. Run: node scripts/landing-shots/lint.js */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'landing', 'index.html'), 'utf8');

(async () => {
  const { HtmlValidate } = require('html-validate');
  const hv = new HtmlValidate({ extends: ['html-validate:recommended'], rules: { 'no-inline-style': 'off', 'require-sri': 'off', 'no-trailing-whitespace': 'off' } });
  const rep = await hv.validateString(html, 'landing/index.html');
  console.log('html-validate:', rep.valid ? 'valid' : 'INVALID', 'errors', rep.errorCount, 'warnings', rep.warningCount);
  for (const r of rep.results) for (const m of r.messages) console.log('  ', m.severity === 2 ? 'ERR ' : 'warn', m.line + ':' + m.column, m.ruleId, '-', m.message);

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const axeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  dom.window.eval(axeSrc);
  const res = await dom.window.axe.run(dom.window.document, { rules: { 'color-contrast': { enabled: false } } });
  console.log('axe violations:', res.violations.length);
  for (const v of res.violations) console.log('  ', v.impact, v.id, '-', v.help, '::', v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | '));
  const words = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log('em/en dashes in visible copy:', (words.match(/[—–]/g) || []).length);
  console.log('eyebrows (mono uppercase labels):', (html.match(/class="eyebrow"/g) || []).length, '/ sections', (html.match(/<section/g) || []).length);
})().catch((e) => { console.error(e); process.exit(1); });

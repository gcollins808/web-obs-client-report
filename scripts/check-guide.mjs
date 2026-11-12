// Keeps docs/GUIDE.md true. Two checks:
//   1. The compose block between the stack markers is the main stack file with its comments removed.
//   2. Every environment variable that the code reads is named in the guide's variable table.
// Run: node scripts/check-guide.mjs        (check)      node scripts/check-guide.mjs --write   (rewrite the compose block)
import fs from 'node:fs';
import path from 'node:path';

const GUIDE = 'docs/GUIDE.md';
const STACK = 'deploy/VPS-STACK-tunnel-both.yml';
const START = '<!-- stack:start -->';
const END = '<!-- stack:end -->';

function stripComments(text) {
  const out = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const cut = line.replace(/\s+#\s.*$/, '').replace(/\s+$/, '');
    out.push(cut);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist-report' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else if (/\.(mjs|ts|tsx|sh)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function variablesRead() {
  const names = new Set();
  for (const root of ['apps', 'scripts', 'packages']) {
    for (const f of walk(root)) {
      if (/test|e2e|smoke/i.test(path.basename(f)) || /[\/]tests?[\/]/.test(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})|\benv\.([A-Z][A-Z0-9_]{3,})/g)) names.add(m[1] || m[2]);
    }
  }
  names.delete('PATH'); names.delete('NODE_ENV');
  return [...names].sort();
}

const guide = fs.readFileSync(GUIDE, 'utf8');
const a = guide.indexOf(START), b = guide.indexOf(END);
if (a < 0 || b < a) { console.error('check-guide: stack markers not found in ' + GUIDE); process.exit(1); }
const want = '```yaml\n' + stripComments(fs.readFileSync(STACK, 'utf8')) + '```';
const have = guide.slice(a + START.length, b).trim();

if (process.argv.includes('--write')) {
  fs.writeFileSync(GUIDE, guide.slice(0, a + START.length) + '\n' + want + '\n' + guide.slice(b));
  console.log('check-guide: compose block rewritten');
  process.exit(0);
}

let failed = 0;
if (have !== want) { console.error('check-guide: the compose block in ' + GUIDE + ' is not the text of ' + STACK + ' (run with --write)'); failed++; }
const missing = variablesRead().filter((n) => !guide.includes('`' + n + '`'));
if (missing.length) { console.error('check-guide: variables read by the code but missing from the table: ' + missing.join(', ')); failed++; }
if (failed) process.exit(1);
console.log('check-guide: ok (compose block matches the stack file; ' + variablesRead().length + ' variables documented)');

// Checks the env setup without reading any value: .env is ignored by git and not tracked, only .env.example is
// committed, it lists every variable the server reads, and it holds no values for the secret ones.
//   node apps/server/tools/check-env.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const root = path.resolve(import.meta.dirname, '..', '..', '..');
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });

// 1. Every .env* file in the project (outside node_modules) other than the examples must be ignored by git.
const found = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist-report') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (e.name === '.env' || e.name.startsWith('.env.')) found.push(p);
  }
};
walk(root);
const real = found.filter((p) => !p.endsWith('.env.example'));
const unignored = real.filter((p) => git('check-ignore', '-q', path.relative(root, p)).status !== 0);
check('every .env file in the project is ignored by git', unignored.length === 0, unignored.map((p) => path.relative(root, p)).join(', '));
const tracked = git('ls-files').stdout.split('\n').filter((f) => /(^|[/])[.]env(?![^/]*[.]example$)([.][^/]*)?$/.test(f));
check('no .env file is tracked by git', tracked.length === 0, tracked.join(', '));
check('the example file is not ignored (they are the committed ones)', ['.env.example'].every((f) => git('check-ignore', '-q', f).status !== 0));

// 2. The example lists every variable the server reads, with no value for the secret ones.
const ex = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const listed = new Map(ex.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const code = ['server.mjs', 'ingest/ingest.mjs'].map((f) => fs.readFileSync(path.join(root, 'apps', 'server', f), 'utf8')).join(String.fromCharCode(10));
const used = new Set([...code.matchAll(/env[.]([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
const missing = [...used].filter((n) => !listed.has(n));
check('.env.example lists every variable the server reads', missing.length === 0, missing.join(', '));
check('the example holds no values', [...listed.values()].every((v) => v === ''));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nenv setup checks passed');
process.exit(failed ? 1 : 0);

// Tests for scripts/check-no-client-data.mjs: it needs the local list of client-name patterns and says so plainly when the list is missing,
// empty or invalid; it finds a name from the list in a file; it passes a clean folder. Uses temporary folders and made-up names only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'check-no-client-data.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-cnd-'));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };
const run = (cwd, env = {}) => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env: { ...process.env, WEBOBS_CLIENT_NAMES_FILE: '', ...env } });
const folder = (name, files) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t); return d; };

ok('the script itself holds no client name (it has no pattern list of its own)', () => { const t = fs.readFileSync(script, 'utf8'); assert.ok(!/\[\s*\['/.test(t), 'no array of name pieces'); assert.match(t, /WEBOBS_CLIENT_NAMES_FILE/); });
ok('a missing list FAILS with a plain message and never passes silently', () => {
  const r = run(folder('a', { 'x.txt': 'hello' })); assert.equal(r.status, 1); assert.match(r.stderr, /list of client names is missing/); assert.match(r.stderr, /WEBOBS_CLIENT_NAMES_FILE/); assert.ok(!/OK/.test(r.stdout));
  const r2 = run(folder('a2', { 'x.txt': 'hello' }), { WEBOBS_CLIENT_NAMES_FILE: path.join(tmp, 'nope.txt') }); assert.equal(r2.status, 1);
});
ok('an empty list, or one with only comments, FAILS', () => { for (const [i, body] of [['', 'e1'], ['# only a comment\n\n', 'e2']].map((x, i) => [x[0], 'e' + i])) { const list = path.join(tmp, body + '.txt'); fs.writeFileSync(list, i); const r = run(folder(body, { 'x.txt': 'hello' }), { WEBOBS_CLIENT_NAMES_FILE: list }); assert.equal(r.status, 1); assert.match(r.stderr, /empty/); } });
ok('an invalid pattern in the list FAILS', () => { const list = path.join(tmp, 'bad.txt'); fs.writeFileSync(list, '(unclosed\n'); const r = run(folder('b', { 'x.txt': 'hello' }), { WEBOBS_CLIENT_NAMES_FILE: list }); assert.equal(r.status, 1); assert.match(r.stderr, /not a valid pattern/); });
ok('a name from the list found in a file FAILS and names the file, not the name', () => {
  const list = path.join(tmp, 'names.txt'); fs.writeFileSync(list, '# made-up names\nacme-?widgets\n');
  const r = run(folder('c', { 'notes.txt': 'prepared for ACME-widgets today' }), { WEBOBS_CLIENT_NAMES_FILE: list });
  assert.equal(r.status, 1); assert.match(r.stderr, /notes\.txt: matches a client-name pattern/); assert.ok(!/acme/i.test(r.stderr), 'the matched name is not printed');
});
ok('a clean folder passes with the list read from WEBOBS_CLIENT_NAMES_FILE or from .client-names', () => {
  const list = path.join(tmp, 'names.txt');
  const r = run(folder('d', { 'x.txt': 'nothing to see' }), { WEBOBS_CLIENT_NAMES_FILE: list }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Client data check OK/);
  const r2 = run(folder('e', { 'x.txt': 'nothing to see', '.client-names': 'acme-?widgets\n' })); assert.equal(r2.status, 0, r2.stderr);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`all ${n} client-data check tests passed`);

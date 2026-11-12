// Tests scripts/sync-upstream.mjs, check-vendor-drift.mjs and upstream-moved.mjs against a SYNTHETIC local fake upstream.
// Foreground and self-terminating; no network. Everything happens in temporary folders under the OS temp dir, on COPIES of
// vendor/web-obs and UPSTREAM.md (the real ones are never touched), and is deleted at the end.   node scripts/test-sync-upstream.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, VENDOR_FILES, VENDOR_REL, sha256, hashDir, readManifest } from './lib/upstream.mjs';

let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sync-test-'));
const up = path.join(base, 'upstream');      // the fake upstream repository
const work = path.join(base, 'work');        // a copy of vendor/web-obs + UPSTREAM.md
const tmpRoot = path.join(base, 'tmp');      // os.tmpdir() for the sync runs, so its temporary clone can be checked
fs.mkdirSync(tmpRoot);
const realBefore = hashDir(path.join(REPO_ROOT, VENDOR_REL));
const realManifestBefore = fs.readFileSync(path.join(REPO_ROOT, 'UPSTREAM.md'));

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.invalid', ...a], { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const runEnv = { ...process.env, TMP: tmpRoot, TEMP: tmpRoot, TMPDIR: tmpRoot };
const node = (script, ...a) => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...a], { encoding: 'utf8', env: runEnv });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const sync = (...a) => node('sync-upstream.mjs', '--root', work, '--url', up, '--skip-tests', ...a);
const leftovers = () => fs.readdirSync(tmpRoot).filter((n) => n.startsWith('wo-upstream-'));
const vendored = (f) => fs.readFileSync(path.join(work, VENDOR_REL, f));
const manifestText = () => fs.readFileSync(path.join(work, 'UPSTREAM.md'), 'utf8');
const MIT = 'MIT License\n\nCopyright (c) 2026 Synthetic Test\n\nPermission is hereby granted, free of charge (synthetic test licence text).\n';

try {
  // ---- a synthetic upstream with the 17 files at src/..., two commits ----
  fs.mkdirSync(up);
  git(up, 'init', '-q', '-b', 'main');
  const content = new Map(VENDOR_FILES.map((f) => [f, Buffer.from(`// synthetic upstream file ${f}\nexport const v = 1;\n`)]));
  content.set('data/pillLabel.ts', Buffer.from("export const pillLabel = 'one';\n"));
  content.set('styles/ui.css', Buffer.from('.a { color: red; }\r\n.b { color: blue; }\r\n')); // CRLF on purpose: must stay byte-identical
  const writeUp = () => { for (const [f, b] of content) { fs.mkdirSync(path.dirname(path.join(up, 'src', f)), { recursive: true }); fs.writeFileSync(path.join(up, 'src', f), b); } };
  writeUp();
  fs.writeFileSync(path.join(up, 'LICENSE'), MIT);
  fs.writeFileSync(path.join(up, 'src', 'unrelated.ts'), 'export const notVendored = true;\n');
  git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'first');
  const sha1 = git(up, 'rev-parse', 'HEAD');
  const content1 = new Map(content);
  content.set('data/brandMark.ts', Buffer.from('// synthetic upstream file data/brandMark.ts, changed\nexport const v = 2;\n'));
  writeUp(); git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'second');
  const sha2 = git(up, 'rev-parse', 'HEAD');

  // ---- a copy of the vendored folder and UPSTREAM.md ----
  fs.cpSync(path.join(REPO_ROOT, VENDOR_REL), path.join(work, VENDOR_REL), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'UPSTREAM.md'), path.join(work, 'UPSTREAM.md'));

  console.log('drift check on the copy of the current baseline');
  check('check-vendor-drift passes on the unchanged copy', node('check-vendor-drift.mjs', '--root', work).status === 0);

  console.log('first sync (mixed baseline -> commit 1)');
  let r = sync(sha1);
  check('the mixed baseline refuses a sync without --force-drift', r.status !== 0 && /mixed baseline/.test(r.out));
  r = sync(sha1, '--dry-run', '--force-drift');
  check('dry run succeeds and writes nothing', r.status === 0 && /Dry run/.test(r.out) && fs.readFileSync(path.join(work, 'UPSTREAM.md')).equals(realManifestBefore), r.status ? r.out : '');
  r = sync(sha1, '--force-drift');
  check('sync to commit 1 succeeds', r.status === 0, r.status ? r.out : '');
  check('all 17 files are copied byte-identically (CRLF file included)', VENDOR_FILES.every((f) => vendored(f).equals(content1.get(f))));
  check('only the listed files are vendored', hashDir(path.join(work, VENDOR_REL)).size === 17 && !fs.existsSync(path.join(work, VENDOR_REL, 'unrelated.ts')));
  let m = readManifest(work);
  check('UPSTREAM.md records the source, resolved sha and commit date', m.fields.Source === up && m.fields.Commit === sha1 && /^\d{4}-\d\d-\d\dT/.test(m.fields['Commit date']));
  check('UPSTREAM.md records the licence, sync date and "none" for patches', m.fields['Upstream licence'] === 'MIT' && /^\d{4}-\d\d-\d\d$/.test(m.fields.Synced) && m.fields['Local patches'] === 'none');
  check('UPSTREAM.md records the sha256 of every vendored file', m.files.size === 17 && VENDOR_FILES.every((f) => m.files.get(f)?.sha256 === sha256(vendored(f))));
  check('the summary counts the changes against the previous copy', /changed 17/.test(r.out) && /changed 17/.test(manifestText()));
  check('the temporary clone is removed', leftovers().length === 0 && /Temporary clone removed/.test(r.out));
  check('check-vendor-drift passes after the sync', node('check-vendor-drift.mjs', '--root', work).status === 0);

  console.log('second sync (commit 1 -> main, one file changed upstream)');
  r = sync();
  check('sync to main succeeds without --force-drift', r.status === 0, r.status ? r.out : '');
  m = readManifest(work);
  check('UPSTREAM.md records the new sha', m.fields.Commit === sha2 && m.fields.Ref === 'main');
  check('the changed upstream file is reported as changed', /changed 1: data\/brandMark\.ts/.test(r.out) && /added 0/.test(r.out) && /removed 0/.test(r.out) && /changed 1: data\/brandMark\.ts/.test(manifestText()));
  check('the changed file is copied', vendored('data/brandMark.ts').equals(content.get('data/brandMark.ts')));
  check('the temporary clone is removed', leftovers().length === 0);

  console.log('upstream-moved');
  r = node('upstream-moved.mjs', '--root', work, '--url', up);
  check('up to date when upstream main is the recorded commit', r.status === 0 && /^up to date/m.test(r.out), r.out.trim());
  fs.writeFileSync(path.join(up, 'README.md'), 'synthetic\n'); git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'third');
  const sha3 = git(up, 'rev-parse', 'HEAD');
  r = node('upstream-moved.mjs', '--root', work, '--url', up);
  check('reports "upstream has moved to <sha>" after a new upstream commit', r.status === 0 && r.out.includes(`upstream has moved to ${sha3}`), r.out.trim());
  check('upstream-moved changes no file', readManifest(work).fields.Commit === sha2);

  console.log('drift: a hand-edited vendored file');
  fs.appendFileSync(path.join(work, VENDOR_REL, 'data/mapAttention.ts'), '// edited by hand\n');
  check('check-vendor-drift fails and names the file', (() => { const d = node('check-vendor-drift.mjs', '--root', work); return d.status !== 0 && d.out.includes('data/mapAttention.ts'); })());
  r = sync();
  check('sync refuses and names the file', r.status !== 0 && r.out.includes('data/mapAttention.ts') && /Refusing/.test(r.out));
  check('the refused sync changed nothing', readManifest(work).fields.Commit === sha2 && /edited by hand/.test(vendored('data/mapAttention.ts').toString()));
  r = sync('--force-drift');
  check('--force-drift overrides and restores the upstream bytes', r.status === 0 && vendored('data/mapAttention.ts').equals(content.get('data/mapAttention.ts')), r.status ? r.out : '');
  fs.writeFileSync(path.join(work, VENDOR_REL, 'data/extra.ts'), 'export {};\n');
  check('an extra file is drift too', (() => { const d = node('check-vendor-drift.mjs', '--root', work); return d.status !== 0 && d.out.includes('extra'); })());
  fs.rmSync(path.join(work, VENDOR_REL, 'data/extra.ts'));
  fs.rmSync(path.join(work, VENDOR_REL, 'types/site.ts'));
  check('a missing file is drift too', (() => { const d = node('check-vendor-drift.mjs', '--root', work); return d.status !== 0 && d.out.includes('missing'); })());
  r = sync('--force-drift');
  check('the missing file comes back with --force-drift', r.status === 0 && vendored('types/site.ts').equals(content.get('types/site.ts')));

  console.log('local patches');
  const patchDir = path.join(work, 'patches');
  fs.mkdirSync(patchDir);
  const patch = [
    'diff --git a/vendor/web-obs/data/pillLabel.ts b/vendor/web-obs/data/pillLabel.ts',
    '--- a/vendor/web-obs/data/pillLabel.ts',
    '+++ b/vendor/web-obs/data/pillLabel.ts',
    '@@ -1 +1 @@',
    "-export const pillLabel = 'one';",
    "+export const pillLabel = 'patched';",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(patchDir, '0001-test-highlight.patch'), patch);
  r = sync();
  check('sync with a patch succeeds', r.status === 0 && /Applied patch 0001-test-highlight\.patch/.test(r.out), r.status ? r.out : '');
  check('the patch is applied to the vendored file', vendored('data/pillLabel.ts').toString() === "export const pillLabel = 'patched';\n", JSON.stringify(vendored('data/pillLabel.ts').toString()));
  m = readManifest(work);
  check('UPSTREAM.md records the patch and the patched hash', /^1 /.test(m.fields['Local patches']) && manifestText().includes('patches/0001-test-highlight.patch') && manifestText().includes(sha256(Buffer.from(patch))) && m.files.get('data/pillLabel.ts').sha256 === sha256(vendored('data/pillLabel.ts')));
  check('check-vendor-drift passes with the patched file', node('check-vendor-drift.mjs', '--root', work).status === 0);
  const before = hashDir(path.join(work, VENDOR_REL)), manifestBefore = manifestText();
  fs.writeFileSync(path.join(patchDir, '0002-broken.patch'), patch.replace("-export const pillLabel = 'one';", "-export const pillLabel = 'nothing like this';"));
  r = sync();
  check('a patch that does not apply stops the sync with nothing changed', r.status !== 0 && /0002-broken\.patch does not apply/.test(r.out) && manifestText() === manifestBefore && [...before].every(([f, h]) => hashDir(path.join(work, VENDOR_REL)).get(f) === h));
  check('the temporary clone is removed after a failed sync too', leftovers().length === 0);

  console.log('bad input');
  r = sync('no-such-branch');
  check('an unknown ref fails cleanly', r.status !== 0 && /not found|could not fetch/.test(r.out) && leftovers().length === 0);
  check('an option-like ref is refused', sync('-x').status !== 0);

  console.log('viewer tests after a sync (stub npm scripts in the copy)');
  fs.rmSync(patchDir, { recursive: true });
  const stub = (code) => JSON.stringify({ name: 'stub', private: true, scripts: { typecheck: 'node -e "process.exit(0)"', 'report:test:safety': `node -e "process.exit(${code})"` } });
  fs.writeFileSync(path.join(work, 'package.json'), stub(0));
  r = node('sync-upstream.mjs', '--root', work, '--url', up, '--force-drift');
  check('runs npm run typecheck and report:test:safety and reports pass', r.status === 0 && /pass\s+npm run typecheck/.test(r.out) && /pass\s+npm run report:test:safety/.test(r.out) && /Viewer tests: pass/.test(r.out), r.status ? r.out : '');
  fs.writeFileSync(path.join(work, 'package.json'), stub(1));
  r = node('sync-upstream.mjs', '--root', work, '--url', up);
  check('a failing viewer test is reported and exits non-zero', r.status !== 0 && /FAIL\s+npm run report:test:safety/.test(r.out) && /Viewer tests: FAIL/.test(r.out));

  console.log('the real repository is untouched');
  const realAfter = hashDir(path.join(REPO_ROOT, VENDOR_REL));
  check('vendor/web-obs and UPSTREAM.md are unchanged', realAfter.size === realBefore.size && [...realBefore].every(([f, h]) => realAfter.get(f) === h) && fs.readFileSync(path.join(REPO_ROOT, 'UPSTREAM.md')).equals(realManifestBefore));
} catch (e) {
  check('test run', false, e.stack || e.message);
} finally {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

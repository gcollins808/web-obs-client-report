// Updates vendor/web-obs from upstream web-obs and rewrites UPSTREAM.md. Foreground, self-terminating, never commits or opens a PR.
//
//   npm run sync:upstream -- [ref-or-sha] [--url <git url or local path>] [--dry-run] [--force-drift]
//
//   ref-or-sha     branch, tag or commit to copy (default main)
//   --url          where to clone from (default https://github.com/AgriciDaniel/web-obs; a local path works too)
//   --dry-run      clone, compare and print the summary, but write nothing
//   --force-drift  go on even if vendor/web-obs no longer matches the hashes in UPSTREAM.md (hand edits are then overwritten),
//                  or if UPSTREAM.md records a mixed baseline that is not one upstream commit
//   For tests only: --root <dir> (a folder holding vendor/web-obs, UPSTREAM.md and patches/; default the repository root)
//                   --skip-tests (do not run the viewer typecheck and safety test afterwards)
//
// Steps: drift check, read-only clone into a temporary folder under the OS temp dir, copy only the files listed in
// scripts/lib/upstream.mjs from upstream src/, apply patches/*.patch (git apply --check first), rewrite UPSTREAM.md, print what
// changed, delete the temporary folder, run the viewer tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT, DEFAULT_URL, DEFAULT_REF, VENDOR_REL, MANIFEST_REL, PATCHES_REL, VENDOR_FILES, upstreamPath,
  sha256, hashDir, readManifest, checkDrift, describeDrift, isFullSha, diffMaps, summaryLines, renderManifest, parseArgs,
} from './lib/upstream.mjs';

let args;
try { args = parseArgs(process.argv.slice(2), ['url', 'root']); } catch (e) { console.error(e.message); process.exit(2); }
const ref = args.pos[0] || DEFAULT_REF;
const url = args.opts.url || DEFAULT_URL;
const root = path.resolve(args.opts.root || REPO_ROOT);
const dryRun = Boolean(args.opts['dry-run']);
const forceDrift = Boolean(args.opts['force-drift']);
const known = new Set(['url', 'root', 'dry-run', 'force-drift', 'skip-tests']);
const unknown = Object.keys(args.opts).filter((k) => !known.has(k));
if (unknown.length || args.pos.length > 1) { console.error(`Unknown argument: ${unknown.map((k) => '--' + k).concat(args.pos.slice(1)).join(' ')}`); process.exit(2); }
if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.startsWith('-')) { console.error('The ref must be a branch, tag or commit name.'); process.exit(2); }

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' };
// core.autocrlf=false: git must not change line endings anywhere (git apply would otherwise write CRLF on Windows).
const git = (cwd, gitArgs, opts = {}) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...gitArgs], { cwd, env: { ...gitEnv, ...(opts.env || {}) }, encoding: opts.buffer ? 'buffer' : 'utf8', maxBuffer: 1 << 28 });
const fail = (msg) => { console.error(msg); process.exitCode = 1; };

// ---- 1. drift: the vendored files must still be what UPSTREAM.md says ----
console.log(`sync-upstream: ${url} @ ${ref}${dryRun ? '  (dry run)' : ''}`);
let manifest;
try { manifest = readManifest(root); } catch (e) { console.error(e.message); process.exit(1); }
const drift = checkDrift(root);
if (!drift.ok) {
  console.log(`Drift: vendor/web-obs does not match ${MANIFEST_REL}:`);
  for (const l of describeDrift(drift)) console.log('  ' + l);
  if (!forceDrift) {
    console.error('Refusing to sync: these changes would be overwritten. Move them into patches/*.patch, or pass --force-drift to discard them.');
    process.exit(1);
  }
  console.log('  --force-drift given: going on; these changes will be overwritten.');
} else console.log(`Drift check OK: ${drift.count} vendored files match ${MANIFEST_REL}.`);
if (!isFullSha(manifest.fields.Commit)) {
  console.log(`${MANIFEST_REL} records no single upstream commit (Commit: ${manifest.fields.Commit || 'missing'}): the vendored copy is a mixed baseline with local changes.`);
  if (!forceDrift) {
    console.error('Refusing to sync: a sync replaces the whole copy and drops the local changes described in UPSTREAM.md. Pass --force-drift to do it anyway.');
    process.exit(1);
  }
  console.log('  --force-drift given: going on.');
}

// ---- 2. read-only clone into a temporary folder ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-upstream-'));
console.log(`Temporary clone: ${tmp}`);
let ok = false;
let result = null;
try {
  result = sync();
  ok = Boolean(result);
} catch (e) {
  fail('sync-upstream failed: ' + e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(fs.existsSync(tmp) ? `WARNING: could not delete the temporary clone ${tmp}` : 'Temporary clone removed.');
}
if (!ok) { process.exitCode = 1; process.exit(); }

// ---- 6. viewer tests ----
if (!dryRun && !args.opts['skip-tests']) {
  const npm = (script) => spawnSync(`npm run ${script}`, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 1 << 28 });
  let allPass = true;
  for (const script of ['typecheck', 'report:test:safety']) {
    const r = npm(script);
    const pass = r.status === 0;
    allPass &&= pass;
    console.log(`  ${pass ? 'pass' : 'FAIL'}  npm run ${script}`);
    if (!pass) console.log(((r.stdout || '') + (r.stderr || '')).split('\n').slice(-25).join('\n'));
  }
  console.log(allPass ? 'Viewer tests: pass.' : 'Viewer tests: FAIL. The files were updated; fix them with a patch in patches/ or go back with git checkout.');
  if (!allPass) process.exitCode = 1;
}
if (!dryRun) console.log('Nothing was committed. Review the change with git diff and commit it yourself.');

function sync() {
  const clone = path.join(tmp, 'clone');
  const init = git(tmp, ['init', '-q', clone]);
  if (init.status !== 0) throw new Error('git init failed: ' + init.stderr.trim());
  let f = git(clone, ['fetch', '-q', '--depth', '1', '--no-tags', url, ref]);
  let sha;
  if (f.status === 0) sha = git(clone, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).stdout.trim();
  else {
    // A short sha, or a host that does not serve single commits: fetch the branches and tags, then look the ref up.
    f = git(clone, ['fetch', '-q', '--no-tags', url, '+refs/heads/*:refs/remotes/up/*', '+refs/tags/*:refs/tags/*']);
    if (f.status !== 0) throw new Error(`could not fetch ${url}: ${f.stderr.trim().split('\n').pop()}`);
    for (const cand of [ref, 'up/' + ref]) {
      const r = git(clone, ['rev-parse', '--verify', '--quiet', cand + '^{commit}']);
      if (r.status === 0) { sha = r.stdout.trim(); break; }
    }
  }
  if (!isFullSha(sha)) throw new Error(`ref ${ref} not found at ${url}`);
  const commitDate = git(clone, ['show', '-s', '--format=%cI', sha]).stdout.trim();
  console.log(`Resolved ${ref} -> ${sha} (${commitDate})`);

  const lic = git(clone, ['cat-file', 'blob', `${sha}:LICENSE`]);
  const licence = lic.status === 0 && /MIT License/.test(lic.stdout) ? 'MIT' : 'NOT FOUND - check the upstream licence before using this copy';
  if (licence !== 'MIT') console.log('WARNING: no MIT LICENSE file found upstream at this commit.');

  // ---- 3. copy only the listed files, byte for byte, into a staging folder ----
  const stageRoot = path.join(tmp, 'stage');
  const stage = path.join(stageRoot, VENDOR_REL);
  const missing = [];
  for (const file of VENDOR_FILES) {
    const r = git(clone, ['cat-file', 'blob', `${sha}:${upstreamPath(file)}`], { buffer: true });
    if (r.status !== 0) { missing.push(upstreamPath(file)); continue; }
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.writeFileSync(path.join(stage, file), r.stdout);
  }
  if (missing.length) throw new Error(`upstream ${sha.slice(0, 7)} lacks files the viewer needs: ${missing.join(', ')}. Nothing was changed.`);

  // ---- 4. local patches ----
  const patchDir = path.join(root, PATCHES_REL);
  const patchFiles = fs.existsSync(patchDir) ? fs.readdirSync(patchDir).filter((n) => n.endsWith('.patch')).sort() : [];
  const patches = [];
  // Keep git from finding a repository above the staging folder: the patch is applied as a plain patch to these files only.
  const applyEnv = { GIT_CEILING_DIRECTORIES: tmp };
  for (const name of patchFiles) {
    const file = path.join(patchDir, name);
    const check = git(stageRoot, ['apply', '--check', '--whitespace=nowarn', file], { env: applyEnv });
    if (check.status !== 0) throw new Error(`patch ${name} does not apply to upstream ${sha.slice(0, 7)}: ${check.stderr.trim()}. Nothing was changed.`);
    const apply = git(stageRoot, ['apply', '--whitespace=nowarn', file], { env: applyEnv });
    if (apply.status !== 0) throw new Error(`patch ${name} failed: ${apply.stderr.trim()}. Nothing was changed.`);
    patches.push({ name, sha256: sha256(fs.readFileSync(file)) });
    console.log(`Applied patch ${name}`);
  }
  if (!patches.length) console.log('No local patches.');
  const extraFromPatch = [...hashDir(stage).keys()].filter((x) => !VENDOR_FILES.includes(x));
  if (extraFromPatch.length) throw new Error(`a patch added files outside the vendored list: ${extraFromPatch.join(', ')}. Nothing was changed.`);

  // ---- 5. compare, write, rewrite UPSTREAM.md ----
  const vendorDir = path.join(root, VENDOR_REL);
  const before = hashDir(vendorDir);
  const after = hashDir(stage);
  const diff = diffMaps(before, after);
  console.log('Changes versus the previous vendored copy:');
  for (const l of summaryLines(diff)) console.log('  ' + l);

  if (dryRun) { console.log('Dry run: nothing was written.'); return true; }
  for (const file of diff.removed) fs.rmSync(path.join(vendorDir, file));
  for (const file of after.keys()) {
    fs.mkdirSync(path.dirname(path.join(vendorDir, file)), { recursive: true });
    fs.copyFileSync(path.join(stage, file), path.join(vendorDir, file));
  }
  // remove folders a removed file left empty
  (function prune(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const p = path.join(d, e.name); prune(p); if (!fs.readdirSync(p).length) fs.rmdirSync(p); } })(vendorDir);
  const text = renderManifest({ url, ref, sha, commitDate, licence, syncDate: new Date().toISOString().slice(0, 10), patches, diff, hashes: after });
  fs.writeFileSync(path.join(root, MANIFEST_REL), text);
  console.log(`Wrote ${VENDOR_REL} (${after.size} files) and ${MANIFEST_REL}.`);
  const post = checkDrift(root);
  if (!post.ok) throw new Error('after the sync the folder does not match the new UPSTREAM.md: ' + describeDrift(post).join('; '));
  return true;
}

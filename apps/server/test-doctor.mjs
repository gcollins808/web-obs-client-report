// Tests scripts/webobs-doctor.sh with a mock docker and a mock curl (no real container, no network), and the helper's --fingerprints.
// Synthetic values only. Foreground and self-terminating. Needs a POSIX sh (Git Bash on Windows).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprintLines } from './tools/make-stack-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const doctor = path.resolve(here, '../../scripts/webobs-doctor.sh');
const helper = path.resolve(here, 'tools/make-stack-env.mjs');
const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
if (sh.status !== 0) { console.log('Doctor test SKIPPED: no sh found.'); process.exit(0); }

const SECRET = 'S'.repeat(8) + 'zq9'.repeat(18), WRONG = 'W'.repeat(8) + 'zq9'.repeat(18);
const AUD = 'a1b2c3d4'.repeat(8), OTHER_AUD = 'e4f5a6b7'.repeat(8);
const TEAM = 'exampleteam.cloudflareaccess.com', BASE = 'https://reports.example.test';
const good = { WEBOBS_REPORT_BASE: BASE, RETENTION_DAYS: '90', MAIL_MODE: 'outbox', INGEST_ENABLED: '1', INGEST_SECRET: SECRET, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-doctor-'));
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const w = (f, t, mode) => fs.writeFileSync(f, t, { mode });
w(path.join(bin, 'docker'), `#!/bin/sh
D="$MOCK_DIR"
case "$1" in
  inspect) for last; do :; done; [ -f "$D/inspect-$last" ] || exit 1; cat "$D/inspect-$last";;
  image) echo "ghcr.io/example/web-obs-client-report@sha256:0123456789abcdef";;
  exec) name=$2; shift; shift
    case "$1" in
      node) shift; ( set -a; . "$D/env-$name"; exec node "$@" );;
      printenv) shift; ( set -a; . "$D/env-$name"; printenv "$@" );;
      tail) [ -f "$D/log" ] && cat "$D/log" || exit 1;;
      *) exit 1;;
    esac;;
  *) exit 1;;
esac
`, 0o755);
w(path.join(bin, 'curl'), `#!/bin/sh
for last; do :; done
case "$last" in */ingest/healthz) cat "$MOCK_DIR/curl-ingest";; *) cat "$MOCK_DIR/curl-root";; esac
`, 0o755);

function scenario(name, { ingestEnv = good, reportEnv = good, log = '', root = '200 ', ingest = '403 ', expectEnv = good, allowOut = [], inspect = 'running|healthy|2026-11-08T10:00:00Z|ghcr.io/example/web-obs-client-report:v0.1.1|sha256:aaaaaaaaaaaaaaaaaaaaaaaa' } = {}) {
  const d = path.join(tmp, name); fs.mkdirSync(d);
  const envFile = (e) => Object.entries(e).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n';
  w(path.join(d, 'env-webobs-ingest'), envFile(ingestEnv)); w(path.join(d, 'env-webobs-report'), envFile(reportEnv));
  w(path.join(d, 'inspect-webobs-ingest'), inspect); w(path.join(d, 'inspect-webobs-report'), inspect);
  if (log) w(path.join(d, 'log'), log);
  w(path.join(d, 'curl-root'), root); w(path.join(d, 'curl-ingest'), ingest);
  const exp = path.join(d, 'expected.txt'); w(exp, fingerprintLines(expectEnv).join('\n') + '\n');
  const r = spawnSync('sh', [doctor, exp], { encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MOCK_DIR: d } });
  const out = r.stdout + r.stderr;
  for (const s of [SECRET, WRONG, AUD, OTHER_AUD].filter((x) => !allowOut.includes(x))) assert.ok(!out.includes(s), `${name}: a value leaked into the output`);
  return { status: r.status, out };
}

// 1. everything matches
let r = scenario('ok', { log: '{"at":"2026-11-08T10:01:00.000Z","event":"accepted","linkId":"x"}\n' });
assert.equal(r.status, 0, r.out); assert.match(r.out, /PASS INGEST_SECRET/); assert.match(r.out, /PASS CF_ACCESS_AUD/); assert.match(r.out, /VERDICT: PASS/);
assert.match(r.out, /SKIP WEBOBS_FEEDBACK_TO/); assert.match(r.out, /blocked without a token/);

// 2. the container holds another INGEST_SECRET, and the log says bad-secret
r = scenario('secret', { ingestEnv: { ...good, INGEST_SECRET: WRONG }, log: '{"at":"2026-11-08T10:02:00.000Z","event":"denied","reason":"bad-secret"}\n{"at":"2026-11-08T10:03:00.000Z","event":"denied","reason":"bad-secret"}\n' });
assert.equal(r.status, 1); assert.match(r.out, /FAIL INGEST_SECRET/); assert.match(r.out, /PASS CF_ACCESS_AUD/); assert.match(r.out, /2026-11-08T10:03:00.000Z {2}bad-secret/); assert.match(r.out, /VERDICT: FAIL/);
assert.match(r.out, /INGEST_SECRET in the webobs-ingest container does not match the file/);

// 3. the container holds another AUD, the Access redirect names yet another application
const redir = (aud) => `302 https://exampleteam.cloudflareaccess.com/cdn-cgi/access/login/reports.example.test?kid=${aud}&redirect_url=%2F`;
r = scenario('aud', { ingestEnv: { ...good, CF_ACCESS_AUD: OTHER_AUD }, root: '200 ', ingest: redir(OTHER_AUD) });
assert.equal(r.status, 1); assert.match(r.out, /FAIL CF_ACCESS_AUD/); assert.match(r.out, /note: the redirect names an application with another tag/);

// 4. the viewer root sits behind Access (clients could not open links)
r = scenario('root', { root: redir(AUD), ingest: redir(AUD) });
assert.equal(r.status, 1); assert.match(r.out, /redirects to the Cloudflare Access login/); assert.match(r.out, /the redirect names the application whose tag is in CF_ACCESS_AUD/); assert.match(r.out, /scope the Access application to the \/ingest\* path/);

// 5. INGEST_ENABLED off, container unhealthy, route missing, not-https reason
r = scenario('misc', { ingestEnv: { ...good, INGEST_ENABLED: '0' }, inspect: 'running|unhealthy|2026-11-08T10:00:00Z|img:v1|sha256:bbbbbbbbbbbbbbbbbbbbbbbb', ingest: '404 ', log: '{"at":"2026-11-08T10:04:00.000Z","event":"denied","reason":"not-https"}\n' });
assert.equal(r.status, 1); assert.match(r.out, /INGEST_ENABLED is not 1/); assert.match(r.out, /reports unhealthy/); assert.match(r.out, /returned 404/); assert.match(r.out, /not-https/);

// 5b. secret-only mode (no Cloudflare Access on the ingest)
const LONG = 'L'.repeat(70);
const noedge = { WEBOBS_REPORT_BASE: BASE, RETENTION_DAYS: '90', MAIL_MODE: 'outbox', INGEST_ENABLED: '1', INGEST_SECRET: LONG, INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: 'yes' };
r = scenario('noedge', { ingestEnv: noedge, reportEnv: noedge, expectEnv: noedge, root: '200 ', ingest: '200 ' });
assert.equal(r.status, 0, r.out); assert.match(r.out, /Mode: secret-only/); assert.match(r.out, /PASS INGEST_SECRET/); assert.match(r.out, /PASS secret length is 48 or more/);
assert.ok(!/FAIL CF_ACCESS|PASS CF_ACCESS|SKIP CF_ACCESS/.test(r.out), 'CF_ACCESS_* are not checked in this mode'); assert.match(r.out, /as expected in secret-only mode/); assert.match(r.out, /VERDICT: PASS/);
r = scenario('noedge-covered', { ingestEnv: noedge, reportEnv: noedge, expectEnv: noedge, root: '200 ', ingest: redir(OTHER_AUD), allowOut: [OTHER_AUD] });
assert.equal(r.status, 1); assert.match(r.out, /Another Cloudflare Access application still covers \/ingest\*/); assert.ok(r.out.includes(OTHER_AUD), 'the tag in the redirect is named');
r = scenario('noedge-weak', { ingestEnv: { ...noedge, INGEST_SECRET: 'x'.repeat(40), INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: '' }, reportEnv: noedge, expectEnv: noedge, root: redir(OTHER_AUD), ingest: '200 ', allowOut: [OTHER_AUD] });
assert.equal(r.status, 1); assert.match(r.out, /FAIL INGEST_SECRET/); assert.match(r.out, /INGEST_ACKNOWLEDGE_NO_EDGE_AUTH is not yes/); assert.match(r.out, /shorter than 48/); assert.match(r.out, /redirects to the Access login/);

// 6. a missing container and a missing expected file
fs.rmSync(path.join(tmp, 'ok', 'inspect-webobs-ingest'));
r = scenario('gone', { log: '' }); // scenario writes inspect files; remove one and run again by hand
const d = path.join(tmp, 'gone'); fs.rmSync(path.join(d, 'inspect-webobs-ingest'));
const g = spawnSync('sh', [doctor, path.join(d, 'expected.txt')], { encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MOCK_DIR: d } });
assert.equal(g.status, 1); assert.match(g.stdout, /webobs-ingest: NOT FOUND/); assert.match(g.stdout, /does not exist: deploy the stack/);
const none = spawnSync('sh', [doctor, path.join(tmp, 'nope.txt')], { encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MOCK_DIR: d } });
assert.equal(none.status, 2); assert.match(none.stdout, /No expected-fingerprints file/);

// 7. the helper: fingerprints never contain the value, and agree with the container-side maths (scenario 1 passed with them)
const envFile = path.join(tmp, 'stack.env'); fs.writeFileSync(envFile, Object.entries(good).map(([k, v]) => `${k}=${v}`).join('\n') + '\nCLOUDFLARE_ACCESS_ID=idvalue\nCLOUDFLARE_SERVICE_SECRET=svcvalue\n');
const f = spawnSync(process.execPath, [helper, '--fingerprints', envFile], { encoding: 'utf8' });
assert.equal(f.status, 0, f.stderr); assert.match(f.stdout, new RegExp(`^INGEST_SECRET ${SECRET.length} [0-9a-f]{8}$`, 'm')); assert.match(f.stdout, /cat > ~\/webobs-expected\.txt <<'EOF'/);
for (const s of [SECRET, AUD, 'idvalue', 'svcvalue']) assert.ok(!f.stdout.includes(s), 'fingerprints leaked a value');
assert.ok(!/CLOUDFLARE_/.test(f.stdout), 'the plugin token names are not stack variables');
const outFile = path.join(tmp, 'expected-out.txt');
const wv = spawnSync(process.execPath, [helper, '--write-expected', envFile, outFile], { encoding: 'utf8' });
assert.equal(wv.status, 0, wv.stderr); assert.equal(fs.readFileSync(outFile, 'utf8'), fingerprintLines(good).join('\n') + '\n');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Doctor OK: 9 scenarios with a mock docker and curl (secret-only mode: pass, another Access application covering the path, weak settings; Access mode: pass,wrong secret, wrong AUD and redirect, viewer behind Access, off/unhealthy/404/not-https, missing container and file), no value ever printed; helper --fingerprints and --write-expected.');

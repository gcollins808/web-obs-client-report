// Container smoke test. Synthetic data only. Runs in the foreground, makes a few requests to a server it starts itself on a
// random port INSIDE the container, prints a result, and exits. Nothing is published, nothing keeps running, nothing polls.
//
// It is NOT part of the image. Mount it for the run (see docs/LIVE-TEST-RUNBOOK.md, part A):
//   docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
//     -v "<this file's folder>:/smoke:ro" -e EXPECT_LOCKED_DOWN=1 webobs-report:local node /smoke/docker-smoke.mjs
//
// APP_DIR is where server.mjs lives (default: the current folder, which is /app in the image).
// Expected: 20 checks, or 24 with EXPECT_LOCKED_DOWN=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const APP_DIR = path.resolve(process.env.APP_DIR || process.cwd());
const LOCKED = process.env.EXPECT_LOCKED_DOWN === '1';
let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

const { createServer } = await import(pathToFileURL(path.join(APP_DIR, 'server.mjs')).href);
const { hashToken, newToken } = await import(pathToFileURL(path.join(APP_DIR, 'tokens.mjs')).href);

// ---- synthetic data in a temporary folder (tmpfs in the locked-down run) ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-smoke-'));
const reportsDir = path.join(work, 'reports'), registryDir = path.join(work, 'registry');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
const fileId = crypto.randomBytes(16).toString('hex');
const report = { format: 'webobs.client-report', version: '1.1', meta: { review: { state: 'approved' } }, client: { name: 'Example Co (synthetic)' } };
fs.writeFileSync(path.join(reportsDir, fileId + '.json'), JSON.stringify(report));
const token = newToken();
const entry = (id, tok, over = {}) => fs.writeFileSync(path.join(registryDir, id + '.json'), JSON.stringify({ id, tokenHash: hashToken(tok), path: fileId + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false, ...over }));
entry('good', token);
const expiredTok = newToken(); entry('old', expiredTok, { expiresAt: new Date(Date.now() - 1000).toISOString() });
const revokedTok = newToken(); entry('rev', revokedTok, { revoked: true });

console.log('image contents');
check('the built viewer page is in the image', fs.existsSync(path.join(APP_DIR, 'report.html')) && fs.statSync(path.join(APP_DIR, 'report.html')).size > 10000);
check('no .env, key or report data is in the app folder', !fs.readdirSync(APP_DIR).some((n) => /^\.env|\.pem$|\.key$/.test(n)) && !fs.existsSync(path.join(APP_DIR, 'reports')));
check('the cleanup tool is in the image (tools/cleanup.mjs)', fs.existsSync(path.join(APP_DIR, 'tools', 'cleanup.mjs')));
check('the data folder holds nothing from the image',!fs.existsSync('/data/reports') || fs.readdirSync('/data/reports').length === 0);

console.log('serving (synthetic report, in-process)');
const { server } = createServer({ reportsDir, registryDir, appFile: path.join(APP_DIR, 'report.html'), outboxDir: path.join(work, 'outbox'), trustProxy: true, deniedDelayMs: 0 });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (p, h = {}) => fetch(base + p, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', ...h } });
try {
  const ok = await get(`/api/r/${token}/report.json`);
  const body = await ok.json();
  check('a valid link returns the report', ok.status === 200 && body.format === 'webobs.client-report');
  check('noindex, no-store and no-referrer headers are on the reply', /noindex/.test(ok.headers.get('x-robots-tag') || '') && /no-store/.test(ok.headers.get('cache-control') || '') && ok.headers.get('referrer-policy') === 'no-referrer');
  const page = await get(`/r/${token}`); const html = await page.text();
  check('the viewer page is served and holds no report text', page.status === 200 && html.includes('data-server-report') && !html.includes('Example Co'));
  const bad = [await get(`/api/r/${newToken()}/report.json`), await get(`/api/r/${expiredTok}/report.json`), await get(`/api/r/${revokedTok}/report.json`), await get('/api/r/short/report.json')];
  const texts = await Promise.all(bad.map((r) => r.text()));
  check('unknown, expired, revoked and malformed links all get the same 404 text', bad.every((r) => r.status === 404) && new Set(texts).size === 1, texts[0]);
  const pageBad = await get(`/r/${newToken()}`);
  check('a bad link on the page route shows the one unavailable line (403)', pageBad.status === 403 && /This link is not available\. Please request a fresh one\./.test(await pageBad.text()));
  check('plain http (not through the proxy) gets no data', (await get(`/api/r/${token}/report.json`, { 'x-forwarded-proto': 'http' })).status === 403);
  check('the health check answers', (await get('/healthz', { 'x-forwarded-proto': 'http' })).status === 200);
  check('the root and other paths are refused', (await get('/')).status === 403 && (await get('/data/reports/' + fileId + '.json')).status === 403);
} finally { await new Promise((r) => server.close(r)); }

console.log("a report's look (styles), served by the neutral image");
{
  const STYLES = { accent: '#F2994A', surface: '#101010', headingFont: 'Oswald', bodyFont: 'Inter', name: 'Example Agency' };
  const fid2 = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(reportsDir, fid2 + '.json'), JSON.stringify({ ...report, styles: STYLES }));
  const tok2 = newToken(); entry('look', tok2, { path: fid2 + '.json' });
  const fontsDir = path.join(APP_DIR, 'fonts'), sharedDir = path.resolve(APP_DIR, '..', 'viewer', 'brand');
  const fonts = ['Oswald.woff2', 'Inter-Regular.woff2', 'Inter-SemiBold.woff2'].map((f) => (fs.existsSync(path.join(fontsDir, f)) ? fs.readFileSync(path.join(fontsDir, f)) : null));
  check('the three bundled fonts are in the image (real woff2 files, under the size cap) with their licence notices', fonts.every((b) => b && b.subarray(0, 4).toString('latin1') === 'wOF2' && b.length < 200 * 1024) && fs.existsSync(path.join(fontsDir, 'OFL-Oswald.txt')) && fs.existsSync(path.join(fontsDir, 'OFL-Inter.txt')));
  check('the shared checker modules are in the image, and the image holds no brand of its own', ['color.mjs', 'styles.mjs', 'styles-hash.mjs'].every((f) => fs.existsSync(path.join(sharedDir, f))) && !fs.readFileSync(path.join(APP_DIR, 'report.html'), 'utf8').includes('id="brand-tokens"'));
  const { server: s2 } = createServer({ reportsDir, registryDir, appFile: path.join(APP_DIR, 'report.html'), outboxDir: path.join(work, 'outbox'), trustProxy: true, deniedDelayMs: 0 });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const g2 = (pth) => fetch(b2 + pth, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' } });
  try {
    const styled = await g2(`/r/${tok2}`), plain = await g2(`/r/${token}`);
    const sb = await styled.text(), pb = await plain.text();
    check('the page for a report with a look carries the style, the title and an embedded font in its first bytes', styled.status === 200 && sb.indexOf('id="wo-styles"') > 0 && sb.indexOf('id="wo-styles"') < sb.indexOf('<body') && sb.includes('url(data:font/woff2;base64,') && /base64,[A-Za-z0-9+/=]{1000,}/.test(sb) && sb.includes('Example Agency') && !sb.includes('<!--wo-brand-->'));
    check('the security headers, including the exact CSP, are the same with and without a look; a report without one gets the plain page', styled.headers.get('content-security-policy') === plain.headers.get('content-security-policy') && /unsafe-inline/.test(styled.headers.get('content-security-policy') || '') && ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'cache-control', 'permissions-policy'].every((h) => styled.headers.get(h) === plain.headers.get(h)) && !pb.includes('id="wo-styles"'));
  } finally { await new Promise((r) => s2.close(r)); }
  const sf = path.join(work, 'look.json'); fs.writeFileSync(sf, JSON.stringify(STYLES));
  const chk = spawnSync(process.execPath, [path.join(APP_DIR, 'tools', 'check-styles.mjs'), sf], { encoding: 'utf8', cwd: APP_DIR });
  check('tools/check-styles.mjs accepts a good file (exit 0) and refuses a bad one (exit 1)', chk.status === 0 && /accepted/.test(chk.stdout) && (fs.writeFileSync(sf, JSON.stringify({ acent: '#112233' })), spawnSync(process.execPath, [path.join(APP_DIR, 'tools', 'check-styles.mjs'), sf], { encoding: 'utf8', cwd: APP_DIR }).status === 1));
}

console.log('the optional ingest');
const runIngest = (env) => spawnSync(process.execPath, [path.join(APP_DIR, 'ingest', 'ingest.mjs')], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 15000 });

/** Starts the real process with the ingest switched off and checks that it keeps running, answers 503 and shows as unhealthy; then stops it. */
const checkIdle = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(APP_DIR, 'ingest', 'ingest.mjs')], { env: { PATH: process.env.PATH, INGEST_PORT: '0', ...env } });
  let out = '', done = false;
  const fin = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve({ ...v, out }); };
  const timer = setTimeout(() => fin({ ok: false, why: 'no idle line within 10 seconds' }), 10000);
  child.on('exit', (code) => fin({ ok: false, why: 'it exited with ' + code }));
  child.stdout.on('data', async (d) => {
    out += d; const m = /idling on port (\d+)/.exec(out); if (!m || done) return;
    try {
      const base = 'http://127.0.0.1:' + m[1];
      const health = await fetch(base + '/ingest/healthz'); const post = await fetch(base + '/ingest/v1/reports', { method: 'POST', body: '{}' });
      const body = await health.text(); await new Promise((r) => setTimeout(r, 1200));
      fin({ ok: true, still: child.exitCode === null, health: health.status, body, post: post.status });
    } catch (e) { fin({ ok: false, why: String(e) }); }
  });
});
const ing = await checkIdle({});
check('ingest switched off keeps running and idles (503, unhealthy on purpose, "switched off")', ing.ok && ing.still && ing.health === 503 && /switched off/.test(ing.body) && ing.post === 503 && /ingest is switched off/.test(ing.out), ing.why ?? `still ${ing.still}, health ${ing.health}`);
const shortSecret = 'too-short-' + crypto.randomBytes(4).toString('hex');
const mis = runIngest({ INGEST_ENABLED: '1', INGEST_SECRET: shortSecret, INGEST_REQUIRE_ACCESS_HEADER: '0' });
const misOut = (mis.stdout || '') + (mis.stderr || '');
check('ingest switched on with a short secret exits non-zero with a plain reason (no value)', mis.status !== 0 && mis.status !== null && /ingest not started: INGEST_SECRET/.test(misOut) && !misOut.includes(shortSecret), `exit ${mis.status}`);
// Without Cloudflare Access the ingest needs a written acknowledgment: a long secret alone is not enough to start it.
const longSecret = crypto.randomBytes(32).toString('hex');
const noAck = runIngest({ INGEST_ENABLED: '1', INGEST_SECRET: longSecret, INGEST_REQUIRE_ACCESS_HEADER: '0' });
const noAckOut = (noAck.stdout || '') + (noAck.stderr || '');
check('ingest switched on without Cloudflare Access and without the acknowledgment exits non-zero (names INGEST_ACKNOWLEDGE_NO_EDGE_AUTH, no value)', noAck.status !== 0 && noAck.status !== null && /ingest not started: .*INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes/.test(noAckOut) && !noAckOut.includes(longSecret), `exit ${noAck.status}`);

if (LOCKED) {
  console.log('locked-down run (expected with --read-only, non-root, no capabilities)');
  check('not running as root', typeof process.getuid === 'function' && process.getuid() !== 0, `uid ${process.getuid?.()}`);
  const cannotWrite = (p) => { try { fs.writeFileSync(path.join(p, '.smoke-write-test'), 'x'); fs.rmSync(path.join(p, '.smoke-write-test')); return false; } catch { return true; } };
  check('the app folder cannot be written', cannotWrite(APP_DIR));
  check('the root of the container cannot be written', cannotWrite('/'));
  check('the temporary folder can be written (tmpfs)', !cannotWrite(os.tmpdir()));
}

fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED, ${passed} passed` : `\nall ${passed} container smoke checks passed`);
process.exit(failed ? 1 : 0);

// Viewer-server hardening tests (second independent review: findings 1 and 2). Synthetic data only; foreground; nothing left running.
//   node apps/server/test-hardening.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from './server.mjs';
import { hashToken, newToken } from './tokens.mjs';

// Node's fetch refuses some ports outright ("bad port"). listen(0) can land on one; if so, close and try again.
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
async function listenFetchable(server, host = '127.0.0.1') {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => { server.off('error', reject); resolve(); }); });
    const { port } = server.address();
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise((r) => server.close(r));
  }
  throw new Error('no usable port after 20 tries');
}

let failed = 0;
const check =(name, ok, extra = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-srv-hard-'));
const reportsDir = path.join(dir, 'reports'), registryDir = path.join(dir, 'registry');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
fs.writeFileSync(path.join(dir, 'app.html'), '<html><body>viewer</body></html>');
const good = fs.readFileSync(new URL('../../fixtures/client-report.sample.json', import.meta.url), 'utf8');
const addReport = (text) => {
  const fileId = crypto.randomBytes(16).toString('hex'), tok = newToken();
  fs.writeFileSync(path.join(reportsDir, fileId + '.json'), text);
  fs.writeFileSync(path.join(registryDir, fileId.slice(0, 8) + '.json'), JSON.stringify({ id: fileId.slice(0, 8), tokenHash: hashToken(tok), path: fileId + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false }));
  return tok;
};
const boot = async (over = {}) => {
  const { server } = createServer({ reportsDir, registryDir, appFile: path.join(dir, 'app.html'), outboxDir: path.join(dir, 'outbox'), trustProxy: true, deniedDelayMs: 0, rateGeneral: 10000, rateBadToken: 10000, ...over });
  const base = `http://127.0.0.1:${await listenFetchable(server)}`;
  const get = async (p) => { const t0 = Date.now(); const r = await fetch(base + p, { headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9' } }); const body = await r.text(); return { status: r.status, body, ms: Date.now() - t0 }; };
  return { get, close: () => new Promise((r) => server.close(r)) };
};

console.log('second review, finding 2: a report is checked again before it is served');
{
  const okTok = addReport(good);
  const withClient = (patch) => { const r = JSON.parse(good); patch(r); return JSON.stringify(r); };
  const bad = {
    'a javascript: address': addReport(withClient((r) => { r.client = { ...(r.client || {}), website: 'javascript:alert(1)' }; r.meta = { ...(r.meta || {}), siteUrl: 'javascript:alert(1)' }; })),
    'a field outside the contract': addReport(withClient((r) => { r.extra = 'x'; })),
    'a wrong type': addReport(withClient((r) => { r.findings = 'not a list'; })),
    'an unapproved report': addReport(withClient((r) => { r.meta = { ...(r.meta || {}), review: { state: 'draft' } }; })),
  };
  const s = await boot();
  const ok = await s.get(`/api/r/${okTok}/report.json`);
  check('a valid report is served', ok.status === 200);
  const unknown = await s.get(`/api/r/${newToken()}/report.json`);
  for (const [name, tok] of Object.entries(bad)) {
    const r = await s.get(`/api/r/${tok}/report.json`);
    check(`${name} behind a valid link is refused like any bad link`, r.status === 404 && r.body === unknown.body, `status ${r.status}`);
  }
  const page = await s.get(`/r/${bad['a wrong type']}`);
  check('the viewer page is refused too (403, the one unavailable line)', page.status === 403 && /This link is not available\. Please request a fresh one\./.test(page.body));
  await s.close();
}

console.log('second review, finding 1: a slow or down report source answers at the fixed refusal time');
{
  const tok = addReport(good);
  const slow = { read: () => new Promise((r) => setTimeout(() => r({ text: good, mtimeMs: Date.now() }), 2500)) };
  const down = { read: async () => { throw new Error('down'); } };
  const s = await boot({ source: slow, deniedDelayMs: 200 });
  const a = await s.get(`/api/r/${tok}/report.json`), b = await s.get(`/api/r/${newToken()}/report.json`);
  check('a valid link with a slow source is refused', a.status === 404 && a.body === b.body);
  check('and it takes about the same time as an unknown link, not 2.5 s', a.ms >= 180 && a.ms < 700 && Math.abs(a.ms - b.ms) < 300, `${a.ms} ms vs ${b.ms} ms`);
  await s.close();
  const d = await boot({ source: down, deniedDelayMs: 200 });
  const c = await d.get(`/api/r/${tok}/report.json`);
  check('a source that throws is the same refusal at the same time', c.status === 404 && c.ms >= 180 && c.ms < 700, `${c.ms} ms`);
  await d.close();
  const fast = await boot({ source: { read: async () => ({ text: good, mtimeMs: Date.now() }) }, deniedDelayMs: 200 });
  check('a fast source still serves a valid link', (await fast.get(`/api/r/${tok}/report.json`)).status === 200);
  await fast.close();
}

console.log('the viewer shows the plain refusal if it cannot draw a report');
{
  const main = fs.readFileSync(new URL('../viewer/src/main.tsx', import.meta.url), 'utf8');
  check('the report and the explore pack are drawn inside a guard that renders the one unavailable line on an error', /class RenderGuard/.test(main) && /getDerivedStateFromError/.test(main) && /<RenderGuard><PackageViewer/.test(main) && /<RenderGuard><ExploreViewer/.test(main) && /RenderGuard[\s\S]*UNAVAILABLE/.test(main));
}

console.log('the image carries every file the server imports');
{
  const df = fs.readFileSync(new URL('../../deploy/Dockerfile', import.meta.url), 'utf8').split(String.fromCharCode(10)).filter((l) => l.startsWith('COPY apps/server/')).join(' ');
  const imports = [...fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8').matchAll(/from '[.][/]([\w/-]+[.]mjs)'/g)].map((x) => x[1]);
  check('every local file imported by server.mjs is copied into the image', imports.length >= 4 && imports.every((f) => df.includes('apps/server/' + f)), imports.join(','));
  check('the cleanup tool is copied into the image as tools/cleanup.mjs', /^COPY apps\/server\/tools\/cleanup[.]mjs [.]\/tools\/cleanup[.]mjs$/m.test(fs.readFileSync(new URL('../../deploy/Dockerfile', import.meta.url), 'utf8')));
  const cleanupSrc = fs.readFileSync(new URL('./tools/cleanup.mjs', import.meta.url), 'utf8');
  const cleanupImports = [...cleanupSrc.matchAll(/^import .* from '([^']+)'/gm)].map((x) => x[1]);
  check('the cleanup tool imports only node: modules (nothing else is beside it in the image)', cleanupImports.length > 0 && cleanupImports.every((m) => m.startsWith('node:')), cleanupImports.join(','));
}

console.log('the cleanup tool runs from the image layout (/app/tools, no .env anywhere)');
{
  const app = path.join(dir, 'app'), data = path.join(dir, 'cdata');
  fs.mkdirSync(path.join(app, 'tools'), { recursive: true });
  fs.copyFileSync(new URL('./tools/cleanup.mjs', import.meta.url), path.join(app, 'tools', 'cleanup.mjs'));
  fs.mkdirSync(path.join(data, 'reports'), { recursive: true }); fs.mkdirSync(path.join(data, 'registry'), { recursive: true });
  const fid = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(data, 'reports', fid + '.json'), '{}');
  fs.writeFileSync(path.join(data, 'registry', 'keepme0001.json'), JSON.stringify({ id: 'keepme0001', tokenHash: hashToken(newToken()), path: fid + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false }));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '' };
  const r = spawnSync(process.execPath, ['tools/cleanup.mjs', '--reports', path.join(data, 'reports'), '--registry', path.join(data, 'registry'), '--dry-run'], { cwd: app, env, encoding: 'utf8', timeout: 15000 });
  check('a dry run from <app>/tools exits 0, keeps the 1 link and removes nothing', r.status === 0 && /Dry run: 0 expired, 0 revoked, 0 with a missing file, 0 unreferenced file[(]s[)] would be removed; 1 link[(]s[)] kept[.]/.test(r.stdout) && fs.readdirSync(path.join(data, 'reports')).length === 1, `exit ${r.status} ${r.stderr.slice(0, 200)}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} server hardening check(s) FAILED` : '\nall server hardening checks passed');
process.exit(failed ? 1 : 0);

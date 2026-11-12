// Container smoke test for the push path. Synthetic report only. Foreground and self-terminating: it starts the ingest and the viewer
// server INSIDE the container on random ports, pushes one report, opens the link, checks the files and the audit log, and exits.
// Nothing is published, nothing keeps running, nothing polls.
//
//   docker run --rm --read-only --tmpfs /tmp --tmpfs /data:uid=1000,gid=1000 --cap-drop ALL --security-opt no-new-privileges:true \
//     -e INGEST_SECRET=<test secret, 32+ characters> -v "<report-server/tools folder>:/smoke:ro" webobs-report:local node /smoke/docker-smoke-ingest.mjs
// Expected: 8 checks (the last runs the image's tools/cleanup.mjs as a dry run).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const APP_DIR = path.resolve(process.env.APP_DIR || process.cwd());
const DATA = process.env.DATA_DIR || '/data';
let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const secret = process.env.INGEST_SECRET || '';
if (secret.length < 32) { console.log('Set INGEST_SECRET (32+ characters) for this run: -e INGEST_SECRET=...'); process.exit(2); }

const { createIngestServer } = await import(pathToFileURL(path.join(APP_DIR, 'ingest', 'ingest.mjs')).href);
const { createServer } = await import(pathToFileURL(path.join(APP_DIR, 'server.mjs')).href);
const reportsDir = path.join(DATA, 'reports'), registryDir = path.join(DATA, 'registry'), auditLog = path.join(DATA, 'audit', 'ingest.log');
const report = { format: 'webobs.client-report', version: '1.1', meta: { review: { state: 'approved' } }, client: { name: 'Example Co (synthetic)' } };
const H = { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5' };
// The default mode (the Cloudflare Access check on). There is no Cloudflare here, so a stand-in verifier accepts one fixed test value;
// the real token verification is covered by apps/server/ingest/test-hardening.mjs.
const EDGE = { 'cf-access-jwt-assertion': 'smoke-test-edge-token' };

console.log('ingest inside the image');
const ing = createIngestServer({ enabled: true, secret, reportsDir, registryDir, auditLog, publicBase: 'https://audit.example.test', trustProxy: true, deniedDelayMs: 0, requireAccessHeader: true, verifyAccess: async (t) => t === EDGE['cf-access-jwt-assertion'] });
await new Promise((r) => ing.server.listen(0, '127.0.0.1', r));
const view = createServer({ reportsDir, registryDir, trustProxy: true, deniedDelayMs: 0, outboxDir: path.join(DATA, 'outbox') });
await new Promise((r) => view.server.listen(0, '127.0.0.1', r));
try {
  const post = (headers) => fetch(`http://127.0.0.1:${ing.server.address().port}/ingest/v1/reports`, { method: 'POST', headers: { ...H, ...EDGE, 'content-type': 'application/json', ...headers }, body: JSON.stringify(report) });
  const none = await post({}), wrong = await post({ authorization: 'Bearer wrong' });
  check('no secret and a wrong secret both get the plain 404', none.status === 404 && wrong.status === 404 && (await none.text()) === 'Access denied');
  const ok = await post({ authorization: 'Bearer ' + secret });
  const body = await ok.json();
  check('the right secret gets 201 and a link', ok.status === 201 && /^https:[/][/]audit[.]example[.]test[/]r[/][A-Za-z0-9_-]{43}$/.test(body.link || ''));
  const token = (body.link || '').split('/r/')[1];
  const files = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [];
  check('one report was stored under a random 32-hex name', files.length === 1 && /^[0-9a-f]{32}[.]json$/.test(files[0]));
  const regText = fs.readdirSync(registryDir).filter((n) => n.endsWith('.json')).map((n) => fs.readFileSync(path.join(registryDir, n), 'utf8')).join('');
  check('the registry holds a hash, not the token', regText.length > 0 && !regText.includes(token));
  const served = await fetch(`http://127.0.0.1:${view.server.address().port}/api/r/${token}/report.json`, { headers: H });
  check('the viewer server serves it through the new link', served.status === 200 && (await served.json()).format === 'webobs.client-report');
  const bad = await fetch(`http://127.0.0.1:${view.server.address().port}/api/r/${token.slice(0, -1)}x/report.json`, { headers: H });
  check('a link with one letter changed gets the same Access denied', bad.status === 404 && (await bad.text()) === 'Access denied');
  const log = fs.existsSync(auditLog) ? fs.readFileSync(auditLog, 'utf8') : '';
  check('the audit log has entries and holds no token, secret or client name', log.includes('"accepted"') && !log.includes(token) && !log.includes(secret) && !log.includes('Example Co'));
  // The cleanup tool shipped in the image, run the way the docs say (from APP_DIR), as a dry run.
  const before = [...fs.readdirSync(reportsDir), ...fs.readdirSync(registryDir)].sort().join(',');
  const cl = spawnSync(process.execPath, ['tools/cleanup.mjs', '--reports', reportsDir, '--registry', registryDir, '--dry-run'], { cwd: APP_DIR, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000 });
  const after = [...fs.readdirSync(reportsDir), ...fs.readdirSync(registryDir)].sort().join(',');
  check('tools/cleanup.mjs --dry-run keeps the 1 link and removes nothing', cl.status === 0 && /0 expired, 0 revoked, 0 with a missing file, 0 unreferenced file[(]s[)] would be removed; 1 link[(]s[)] kept[.]/.test(cl.stdout || '') && before === after, `exit ${cl.status} ${(cl.stdout || '').trim().split(String.fromCharCode(10)).pop()}`);
  // A report that carries a look: one request with two named parts, checked again by the image's own copy of the shared checker.
  const { makeEnvelope } = await import(pathToFileURL(path.resolve(APP_DIR, '..', 'viewer', 'brand', 'styles-hash.mjs')).href);
  const STYLES = { accent: '#F2994A', surface: '#101010', headingFont: 'Oswald', bodyFont: 'Inter', name: 'Example Agency' };
  const postBody = (b) => fetch(`http://127.0.0.1:${ing.server.address().port}/ingest/v1/reports`, { method: 'POST', headers: { ...H, ...EDGE, 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: JSON.stringify(b) });
  const env = makeEnvelope(report, STYLES);
  const okEnv = await postBody(env); const envBody = await okEnv.json();
  const stored = fs.readdirSync(reportsDir).map((f) => JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8')));
  check('an envelope with a styles part and a data part (same hash) gets 201 and one file with the look inside', okEnv.status === 201 && stored.length === 2 && stored.filter((r) => r.styles && r.styles.accent === '#f2994a').length === 1);
  const names = Object.keys(env), other = { [names[0]]: STYLES, ['data_' + 'f'.repeat(12)]: report };
  const mismatch = await postBody(other); const dupText = '{"' + names[0] + '":' + JSON.stringify(STYLES) + ',"' + names[0] + '":' + JSON.stringify(STYLES) + ',"' + names[1] + '":' + JSON.stringify(report) + '}';
  const dup = await fetch(`http://127.0.0.1:${ing.server.address().port}/ingest/v1/reports`, { method: 'POST', headers: { ...H, ...EDGE, 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: dupText });
  check('a hash mismatch and a repeated part name are refused with 422 and nothing more is stored', mismatch.status === 422 && dup.status === 422 && fs.readdirSync(reportsDir).length === 2);
  const log2 = fs.readFileSync(auditLog, 'utf8');
  check('the audit log names the styles by a 12-hex hash and the refusals by reason codes, never the styles text', /"styles":"[0-9a-f]{12}"/.test(log2) && log2.includes('styles-mismatch') && log2.includes('duplicate-key') && !log2.includes('Example Agency'));
  const servedLook = await fetch(`http://127.0.0.1:${view.server.address().port}/api/r/${(envBody.link || '').split('/r/')[1]}/report.json`, { headers: H });
  check('the viewer server serves the report and does not send the look back in report.json', servedLook.status === 200 && !('styles' in (await servedLook.json())));
} finally {
  await new Promise((r) => ing.server.close(r)); await new Promise((r) => view.server.close(r));
}
console.log(failed ? `\n${failed} check(s) FAILED, ${passed} passed` : `\nall ${passed} container push checks passed`);
process.exit(failed ? 1 : 0);

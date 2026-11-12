// Tests for the audit fixes: unreadable addresses, broken requests, a client that drops the connection part-way, reports with a list that is
// not a list, a missing page file, an unexpected error in a handler (VULN-001); revoking a link through the ingest (LOGIC-001); the capped
// audit log (IAC-001). Synthetic data only. Everything runs inside this process on loopback and exits by itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './server.mjs';
import { createIngestServer } from './ingest/ingest.mjs';
import { checkIncomingReport } from './ingest/contract-check.mjs';

const stray = []; // anything that would have crashed the process
process.on('unhandledRejection', (e) => stray.push('unhandledRejection: ' + String(e?.message ?? e)));
process.on('uncaughtException', (e) => stray.push('uncaughtException: ' + String(e?.message ?? e)));
const watchdog = setTimeout(() => { console.error('FAIL: the checks did not finish in time; stray errors: ' + stray.join(' | ')); process.exit(1); }, 90000); watchdog.unref();
let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('  ok   ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-h2-'));
const reportsDir = path.join(tmp, 'reports'), registryDir = path.join(tmp, 'registry'), auditLog = path.join(tmp, 'audit', 'ingest.log');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
const appFile = path.join(tmp, 'app.html'); fs.writeFileSync(appFile, '<html lang="en"><head></head><body>page</body></html>');
const SECRET = 'hardening-two-secret-' + 'k'.repeat(40), WRONG = 'wrong-secret-' + 'z'.repeat(40);
const SAMPLE = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'client-report.sample.json'), 'utf8');
const H = { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.7' };

const ing = createIngestServer({ enabled: true, secret: SECRET, reportsDir, registryDir, auditLog, publicBase: 'https://audit.example.test', trustProxy: true, deniedDelayMs: 0, requireAccessHeader: false, acknowledgeNoEdgeAuth: true, auditMaxBytes: 2048, auditKeep: 2, rateBadPerMin: 100000, ratePerHour: 100000 });
const view = createServer({ reportsDir, registryDir, appFile, outboxDir: path.join(tmp, 'outbox'), trustProxy: true, deniedDelayMs: 0, feedbackTo: 'feedback@agency.example', mailMode: 'outbox', rateGeneral: 100000, rateBadToken: 100000 });
await new Promise((r) => ing.server.listen(0, '127.0.0.1', r)); await new Promise((r) => view.server.listen(0, '127.0.0.1', r));
const iport = ing.server.address().port, vport = view.server.address().port;

const req = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...H, ...headers } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', reject); r.end(body);
});
const raw = (port, text, { hold = 400 } = {}) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(text)); let out = '';
  s.on('data', (d) => (out += d)); s.on('error', () => {}); s.on('close', () => resolve(out)); setTimeout(() => s.destroy(), hold);
});
const upload = async () => { const r = await req(iport, 'POST', '/ingest/v1/reports?hours=1', { headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' }, body: SAMPLE }); assert.equal(r.status, 201, r.body); return JSON.parse(r.body); };
const tokenOf = (link) => link.split('/r/')[1];
const alive = async (what) => { for (const [port, p] of [[vport, '/healthz'], [iport, '/ingest/healthz']]) assert.equal((await req(port, 'GET', p)).status, 200, `${what}: the server still answers on ${p}`); };

// ---- VULN-001 ----
await ok('an address that cannot be read as a URL gets the plain refusal, on both servers, and they keep serving', async () => {
  for (const bad of ['//[', '//%', '//%zz', '///[', '//[::']) {
    const a = await raw(vport, `GET ${bad} HTTP/1.1\r\nHost: x\r\nx-forwarded-proto: https\r\ncf-connecting-ip: 203.0.113.7\r\n\r\n`);
    assert.match(a, /^HTTP\/1\.1 (403|404|400)/, 'viewer: ' + bad);
    const b = await raw(iport, `GET ${bad} HTTP/1.1\r\nHost: x\r\nx-forwarded-proto: https\r\ncf-connecting-ip: 203.0.113.7\r\n\r\n`);
    assert.match(b, /^HTTP\/1\.1 (404|400)/, 'ingest: ' + bad);
  }
  await alive('after unreadable addresses');
});
await ok('a request that is not valid HTTP gets a plain 400 and the servers keep serving', async () => {
  for (const port of [vport, iport]) assert.match(await raw(port, 'NOT HTTP AT ALL\r\n\r\n'), /^HTTP\/1\.1 400 Bad Request/);
  await alive('after broken requests');
});
await ok('a client that drops the connection mid-body ends quietly (viewer feedback route and ingest upload)', async () => {
  const { link } = await upload(); const token = tokenOf(link);
  const fb = `POST /api/r/${token}/feedback HTTP/1.1\r\nHost: x\r\nx-forwarded-proto: https\r\ncf-connecting-ip: 203.0.113.7\r\ncontent-type: application/json\r\ncontent-length: 5000\r\n\r\n{"general":"abc`;
  await raw(vport, fb, { hold: 300 });
  const up = `POST /ingest/v1/reports HTTP/1.1\r\nHost: x\r\nx-forwarded-proto: https\r\ncf-connecting-ip: 203.0.113.7\r\nauthorization: Bearer ${SECRET}\r\ncontent-type: application/json\r\ncontent-length: 90000\r\n\r\n{"format":"webobs.client-report"`;
  await raw(iport, up, { hold: 300 });
  await sleep(300); await alive('after dropped connections'); assert.deepEqual(stray, [], 'no unhandled error escaped');
});
await ok('a findings entry that is not a list does not crash the checker, on upload or when serving', async () => {
  for (const findings of ['not a list', { a: 1 }, 7, null]) {
    const r = JSON.parse(SAMPLE); r.map.site.audit = { ...(r.map.site.audit ?? {}), findings };
    assert.doesNotThrow(() => checkIncomingReport(r)); assert.ok(Array.isArray(checkIncomingReport(r)));
    const up = await req(iport, 'POST', '/ingest/v1/reports?hours=1', { headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' }, body: JSON.stringify(r) });
    assert.ok([201, 422].includes(up.status), 'upload answered plainly: ' + up.status);
  }
  // a stored file with such a shape, served: refusal or the report, never a crash
  const bad = JSON.parse(SAMPLE); bad.map.site.audit = { findings: 'x' };
  const fileId = 'a'.repeat(32), linkId = 'b'.repeat(10), token = 'T'.repeat(43);
  fs.writeFileSync(path.join(reportsDir, fileId + '.json'), JSON.stringify(bad));
  const { hashToken } = await import('./tokens.mjs');
  fs.writeFileSync(path.join(registryDir, linkId + '.json'), JSON.stringify({ id: linkId, tokenHash: hashToken(token), path: fileId + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), revoked: false }));
  const s = await req(vport, 'GET', `/api/r/${token}/report.json`); assert.ok([200, 404].includes(s.status), 'served plainly: ' + s.status);
  await alive('after odd report shapes');
});
await ok('a missing page file gives a plain 500 for the page and the server keeps serving', async () => {
  const { link } = await upload(); const token = tokenOf(link);
  fs.renameSync(appFile, appFile + '.gone');
  try { const r = await req(vport, 'GET', `/r/${token}`); assert.equal(r.status, 500); assert.doesNotMatch(r.body, /ENOENT|\\|\/tmp|at /, 'no detail leaks'); assert.equal((await req(vport, 'GET', `/api/r/${token}/report.json`)).status, 200, 'the data route still works'); }
  finally { fs.renameSync(appFile + '.gone', appFile); }
  assert.equal((await req(vport, 'GET', `/r/${token}`)).status, 200, 'and recovers when the file is back');
});
await ok('an unexpected error inside a handler ends that request with a plain answer, the server keeps serving, and nothing leaks', async () => {
  const brokenView = createServer({ reportsDir, registryDir, appFile, trustProxy: true, deniedDelayMs: 0, source: { get() { throw new Error('boom: secret detail /var/x'); }, read() { throw new Error('boom: secret detail /var/x'); } } });
  await new Promise((r) => brokenView.server.listen(0, '127.0.0.1', r)); const p = brokenView.server.address().port;
  const { link } = await upload(); const r = await req(p, 'GET', `/r/${tokenOf(link)}`);
  assert.ok([403, 404, 500].includes(r.status)); assert.doesNotMatch(r.body, /boom|secret detail|\/var\//);
  assert.equal((await req(p, 'GET', '/healthz')).status, 200); await new Promise((res) => brokenView.server.close(res));
});

// ---- LOGIC-001 ----
const revoke = (id, headers = { authorization: 'Bearer ' + SECRET }, method = 'POST') => req(iport, method, `/ingest/v1/links/${id}/revoke`, { headers });
await ok('a link made by the ingest can be revoked, and the viewer then gives the uniform refusal', async () => {
  const { link, linkId } = await upload(); const token = tokenOf(link);
  assert.equal((await req(vport, 'GET', `/api/r/${token}/report.json`)).status, 200, 'served before');
  const r = await revoke(linkId); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { ok: true, linkId, revoked: true });
  const after = await req(vport, 'GET', `/api/r/${token}/report.json`); assert.equal(after.status, 404); assert.equal(after.body, 'Access denied');
  assert.equal((await req(vport, 'GET', `/r/${token}`)).status, 403, 'the page route refuses too');
  assert.equal((await revoke(linkId)).status, 200, 'revoking again is harmless');
  const entry = JSON.parse(fs.readFileSync(path.join(registryDir, linkId + '.json'), 'utf8')); assert.equal(entry.revoked, true); assert.ok(entry.tokenHash && entry.path, 'the rest of the entry is kept');
  assert.ok(!fs.existsSync(path.join(registryDir, linkId + '.json.tmp')), 'no temporary file left');
});
await ok('revoking is refused without the secret, with a wrong one, with a bad id, or with the wrong method; an unknown id says so only to an authorised caller', async () => {
  const { linkId, link } = await upload(); const token = tokenOf(link);
  for (const headers of [{}, { authorization: 'Bearer ' + WRONG }, { authorization: 'Basic abc' }]) { const r = await revoke(linkId, headers); assert.equal(r.status, 404); assert.equal(r.body, 'Access denied'); }
  for (const id of ['ZZZZZZZZZZ', 'abc', 'a'.repeat(11), '..%2f..%2fx', 'A'.repeat(10)]) { const r = await revoke(id); assert.equal(r.status, 404); assert.equal(r.body, 'Access denied', 'bad id: ' + id); }
  assert.equal((await revoke(linkId, { authorization: 'Bearer ' + SECRET }, 'GET')).body, 'Access denied');
  assert.equal((await req(vport, 'GET', `/api/r/${token}/report.json`)).status, 200, 'nothing above revoked it');
  const none = await revoke('c'.repeat(10)); assert.equal(none.status, 404); assert.equal(none.body, 'No such link.');
  assert.ok(!fs.existsSync(path.join(registryDir, 'cccccccccc.json')), 'nothing was created');
});
await ok('revoking writes an audit line with the id only', async () => {
  const { linkId } = await upload(); await revoke(linkId);
  const lines = fs.readdirSync(path.dirname(auditLog)).filter((f) => f.startsWith('ingest.log')).flatMap((f) => fs.readFileSync(path.join(path.dirname(auditLog), f), 'utf8').trim().split('\n'));
  const line = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'revoked' && l.linkId === linkId); assert.ok(line, 'an audit line for the revoke');
  assert.deepEqual(Object.keys(line).sort(), ['at', 'event', 'linkId']);
});

// ---- IAC-001 ----
await ok('the audit log is capped: old files shift up, at most keep+1 files, bounded total size', async () => {
  for (let i = 0; i < 400; i++) await req(iport, 'POST', '/ingest/v1/reports', { headers: { authorization: 'Bearer ' + WRONG } });
  const files = fs.readdirSync(path.dirname(auditLog)).filter((f) => f.startsWith('ingest.log')).sort();
  assert.deepEqual(files, ['ingest.log', 'ingest.log.1', 'ingest.log.2'], 'only the log and two old files');
  const total = files.reduce((a, f) => a + fs.statSync(path.join(path.dirname(auditLog), f)).size, 0);
  assert.ok(total <= 3 * (2048 + 300), 'total size stays near keep+1 times the cap: ' + total);
  assert.ok(fs.statSync(auditLog).size > 0, 'the current log still records');
});

await sleep(200); assert.deepEqual(stray, [], 'no unhandled error escaped during the whole run');
for (const s of [ing.server, view.server]) await new Promise((r) => s.close(r));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`all ${n} hardening-2 checks passed`);
process.exit(0);

// LOGIC-001 end to end: a link made through the ingest is listed in the Studio's links panel, revoked through the local helper (the Studio's
// Revoke button), and the viewer then answers the uniform refusal. Wrong secret, a bad id and an unknown id are refused. Synthetic data only;
// real in-process servers on loopback; exits by itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.mjs';
import { createIngestServer } from './ingest/ingest.mjs';
import { createHelper } from './scripts/publish-helper.mjs';
import { revokeHttps } from './scripts/lib/publish-https.mjs';
import { listLinks, revokeAny, extendLink } from './scripts/lib/links-core.mjs';
import { PublishError, parseTarget } from './scripts/lib/publish-core.mjs';

let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('  ok   ' + name); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-rv-'));
const reportsDir = path.join(tmp, 'reports'), registryDir = path.join(tmp, 'registry'), indexFile = path.join(tmp, 'index.json');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
const appFile = path.join(tmp, 'app.html'); fs.writeFileSync(appFile, '<html lang="en"><head></head><body></body></html>');
const SECRET = 'revoke-test-secret-' + 'q'.repeat(40);
const reportFile = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'client-report.sample.json');

const ing = createIngestServer({ enabled: true, secret: SECRET, reportsDir, registryDir, auditLog: path.join(tmp, 'audit.log'), publicBase: 'https://audit.example.test', requireHttps: false, trustProxy: false, deniedDelayMs: 0, requireAccessHeader: false, acknowledgeNoEdgeAuth: true });
const view = createServer({ reportsDir, registryDir, appFile, outboxDir: path.join(tmp, 'outbox'), requireHttps: false, trustProxy: false, deniedDelayMs: 0 });
await new Promise((r) => ing.server.listen(0, '127.0.0.1', r)); await new Promise((r) => view.server.listen(0, '127.0.0.1', r));
const target = `http://127.0.0.1:${ing.server.address().port}/ingest/v1/reports`;
const env = { WEBOBS_PUBLISH_TARGET: target, WEBOBS_REPORT_BASE: 'https://audit.example.test', WEBOBS_INGEST_SECRET: SECRET };
const helper = createHelper({ env, indexFile });
const hport = await helper.listen(0);
const hbase = `http://127.0.0.1:${hport}`, auth = { Authorization: 'Bearer ' + helper.startToken, 'Content-Type': 'application/json' };
const call = async (p, body, method = 'POST') => { const r = await fetch(hbase + p, { method, headers: auth, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
const serve = (token) => fetch(`http://127.0.0.1:${view.server.address().port}/api/r/${token}/report.json`).then(async (r) => ({ status: r.status, body: await r.text() }));

let link, id, token;
await ok('publishing to an https target is noted in the local index, so the links panel lists it', async () => {
  const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const r = await call('/publish', { client: 'demo-client', hours: 1, report: rep });
  assert.equal(r.status, 200, JSON.stringify(r.json)); ({ link, id } = r.json); token = link.split('/r/')[1];
  assert.match(id, /^[a-f0-9]{10}$/); assert.equal((await serve(token)).status, 200);
  const l = await call('/links', undefined, 'GET'); assert.equal(l.status, 200);
  const row = l.json.links.find((x) => x.id === id); assert.ok(row, 'listed'); assert.equal(row.client, 'demo-client'); assert.equal(row.revoked, false);
  assert.ok(!JSON.stringify(l.json).includes(token), 'the token is never in the list');
});
await ok('the Studio Revoke button works for an https target: the link stops working at once and shows as revoked', async () => {
  const r = await call('/links/revoke', { id }); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true);
  const s = await serve(token); assert.equal(s.status, 404); assert.equal(s.body, 'Access denied');
  const l = await call('/links', undefined, 'GET'); assert.equal(l.json.links.find((x) => x.id === id).revoked, true);
  const again = await call('/links/revoke', { id }); assert.equal(again.status, 200, 'revoking twice is harmless');
});
await ok('extending is not offered for an ingest link, with a plain message', async () => {
  const e = await call('/links/extend', { id, hours: 5 }); assert.notEqual(e.status, 200); assert.match(e.json.message, /Extending is not available/);
});
await ok('a wrong secret, a missing secret, a bad id and an unknown id are refused with plain messages and change nothing', async () => {
  const t = parseTarget(target);
  const fresh = await call('/publish', { client: 'second', hours: 1, report: JSON.parse(fs.readFileSync(reportFile, 'utf8')) }); const id2 = fresh.json.id, tok2 = fresh.json.link.split('/r/')[1];
  await assert.rejects(revokeHttps({ target: t, id: id2, env: { ...env, WEBOBS_INGEST_SECRET: 'x'.repeat(60) }, PublishError }), (e) => e instanceof PublishError && /refused/.test(e.message) && !e.message.includes(SECRET));
  await assert.rejects(revokeHttps({ target: t, id: id2, env: { WEBOBS_INGEST_SECRET: '' }, PublishError }), /not set/);
  for (const bad of ['ZZZ', '../x', 'a'.repeat(11), '']) await assert.rejects(revokeHttps({ target: t, id: bad, env, PublishError }), /not a link id/);
  await assert.rejects(revokeHttps({ target: t, id: 'e'.repeat(10), env, PublishError }), (e) => e.code === 'not-found');
  assert.equal((await serve(tok2)).status, 200, 'the second link is untouched by all of the above');
  assert.throws(() => extendLink(t, id2, 5, indexFile), /not available/);
  assert.ok(Array.isArray(listLinks(t, indexFile)));
  await revokeAny(t, id2, { env, indexFile }); assert.equal((await serve(tok2)).status, 404);
});

helper.server.close(); for (const s of [ing.server, view.server]) await new Promise((r) => s.close(r));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`all ${n} https revoke checks passed`);
process.exit(0);

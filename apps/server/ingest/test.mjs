// Foreground, self-terminating checks for the HTTPS ingest route. Synthetic data only; servers run inside this process on random ports.
// Run: node apps/server/ingest/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';
import { createIngestServer, loadIngestConfig, describeIngestSetup, sameSecret, startupProblems } from './ingest.mjs';
import * as local from './contract-check.mjs';
import { createServer } from '../server.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-ingest-'));
const reportsDir = path.join(dir, 'reports'), registryDir = path.join(dir, 'registry'), auditLog = path.join(dir, 'audit', 'ingest.log');
const SECRET = 'ingest-test-secret-' + 'x'.repeat(30);
const synthetic = (over = {}) => ({
  format: 'webobs.client-report', version: '1.1',
  meta: { reportId: 'rpt-ingest-1', review: { state: 'approved', reviewedBy: 'Test' }, source: { siteId: 'demo.test', capturedAt: '2026-01-01T00:00:00Z' } },
  client: { name: 'Zebra Quartz Ltd', domain: 'zebra-quartz.test', accent: null }, feedback: {}, findings: [],
  map: { site: { schemaVersion: 1, siteId: 'zebra-quartz.test', domain: 'zebra-quartz.test', nodes: [{ id: 'a', url: 'https://zebra-quartz.test/', title: 'Home' }], edges: [], sections: [], stats: { pagesCrawled: 1 } } },
  modes: { guided: { tour: ['welcome'], steps: [{ id: 'welcome', kind: 'welcome' }] } }, ...over,
});

console.log('off by default, and the contract copy matches the source');
{
  check('INGEST_ENABLED defaults to off', loadIngestConfig({}).enabled === false && /switched off; this process idles/.test(describeIngestSetup(loadIngestConfig({})).join(' ')));
  check('a short or missing secret is called out, and no value is printed', /INGEST_SECRET is missing or shorter than 32/.test(describeIngestSetup(loadIngestConfig({ INGEST_ENABLED: '1', INGEST_SECRET: 'short-secret-value' })).join(' ')) && !describeIngestSetup(loadIngestConfig({ INGEST_ENABLED: '1', INGEST_SECRET: 'short-secret-value' })).join(' ').includes('short-secret-value'));
  check('the secret comparison is exact', sameSecret('abc', 'abc') && !sameSecret('abc', 'abd') && !sameSecret('abc', 'abcd') && !sameSecret('', 'x'));
  const { build } = createRequire(path.join(root, 'package.json'))('esbuild');
  const o = await build({ entryPoints: [path.join(root, 'packages', 'contract', 'src', 'contract.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  const src = await import('data:text/javascript;base64,' + Buffer.from(o.outputFiles[0].contents).toString('base64'));
  const same = ['REPORT_FIELDS', 'MAP_NODE_FIELDS', 'MAP_EDGE_FIELDS', 'MAP_SECTION_FIELDS', 'MAP_STAT_FIELDS', 'MAP_SITE_FIELDS', 'MAP_AUDIT_FINDING_FIELDS'].every((k) => JSON.stringify(src[k]) === JSON.stringify(local[k]));
  check('the server\'s field lists equal packages/contract/src/contract.ts', same);
  const viewer = fs.readFileSync(path.join(root, 'apps', 'server', 'server.mjs'), 'utf8');
  const code = viewer.replace(/\/\/.*$/gm, '');
  check('the public viewer does not import the ingest server (only the pure contract checker) and never writes or deletes in the reports or registry folders', !/ingest/i.test(code.replace("./ingest/contract-check.mjs", '')) && !/ingest[.]mjs/.test(code) && !code.split(String.fromCharCode(10)).some((l) => /(writeFileSync|renameSync|rmSync|unlinkSync|copyFileSync|mkdirSync)/.test(l) && /(reportsDir|registryDir)/.test(l)));
}

const boot = async (over = {}) => {
  const { server, cfg } = createIngestServer({ enabled: true, secret: SECRET, reportsDir, registryDir, auditLog, publicBase: 'https://audit.example.test', trustProxy: true, deniedDelayMs: 0, ratePerHour: 1000, rateBadPerMin: 1000, requireAccessHeader: false, acknowledgeNoEdgeAuth: true, ...over });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = (extra = {}) => ({ 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5', authorization: 'Bearer ' + SECRET, 'content-type': 'application/json', ...extra });
  const post = (body, { q = '', headers = {}, raw } = {}) => fetch(`${base}/ingest/v1/reports${q}`, { method: 'POST', headers: H(headers), body: raw ?? JSON.stringify(body) });
  return { cfg, base, H, post, fetchRaw: (p, init = {}) => fetch(base + p, init), close: () => new Promise((r) => server.close(r)) };
};

console.log('accepting a report');
let firstToken, firstLink;
{
  const s = await boot();
  const r = await s.post(synthetic(), { q: '?file=../../etc/x&id=1' });
  const j = await r.json();
  check('a valid report is accepted with 201 and a link', r.status === 201 && j.ok && /^https:\/\/audit\.example\.test\/r\/[A-Za-z0-9_-]{43}$/.test(j.link));
  firstLink = j.link; firstToken = j.link.split('/r/')[1];
  const files = fs.readdirSync(reportsDir);
  check('the server named the file: 32 random hex characters, nothing from the caller', files.length === 1 && /^[0-9a-f]{32}\.json$/.test(files[0]));
  const entry = JSON.parse(fs.readFileSync(path.join(registryDir, j.linkId + '.json'), 'utf8'));
  check('the registry holds the token hash, the file name and an expiry, never the token', /^[0-9a-f]{64}$/.test(entry.tokenHash) && entry.path === files[0] && !JSON.stringify(entry).includes(firstToken) && entry.revoked === false);
  check('the default life is 72 hours', Math.abs((Date.parse(entry.expiresAt) - Date.now()) / 3600000 - 72) < 0.1);
  const r2 = await s.post(synthetic(), { q: '?hours=5' }); const j2 = await r2.json();
  check('the caller can ask for a shorter life', Math.abs((Date.parse(j2.expiresAt) - Date.now()) / 3600000 - 5) < 0.1);
  check('two uploads never share a file name or overwrite each other', fs.readdirSync(reportsDir).length === 2);
  check('the stored report is exactly what was sent', JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8')).client.name === 'Zebra Quartz Ltd');

  // The public viewer, with read-only roles, serves what ingest wrote.
  const { server: viewer } = createServer({ reportsDir, registryDir, appFile: path.join(dir, 'app.html'), trustProxy: true, deniedDelayMs: 0 });
  fs.writeFileSync(path.join(dir, 'app.html'), '<!doctype html><html><body>v</body></html>');
  await new Promise((rr) => viewer.listen(0, '127.0.0.1', rr));
  const v = await fetch(`http://127.0.0.1:${viewer.address().port}/api/r/${firstToken}/report.json`, { headers: { 'x-forwarded-proto': 'https' } });
  check('the viewer serves the report through the new link', v.status === 200 && (await v.json()).client.name === 'Zebra Quartz Ltd');
  await new Promise((rr) => viewer.close(rr));
  await s.close();
}

console.log('everything else gets the same plain denial');
{
  const FLOOR = 100;
  const s = await boot({ deniedDelayMs: FLOOR, requireAccessHeader: true, verifyAccess: async (t) => t === 'edge-token-present' });
  const withAccess = { 'cf-access-jwt-assertion': 'edge-token-present' };
  const cases = {
    'no credentials': () => s.fetchRaw('/ingest/v1/reports', { method: 'POST', headers: { 'x-forwarded-proto': 'https', ...withAccess }, body: '{}' }),
    'wrong secret': () => s.post(synthetic(), { headers: { authorization: 'Bearer wrong-secret', ...withAccess } }),
    'no edge header': () => s.post(synthetic()),
    'plain http': () => s.post(synthetic(), { headers: { 'x-forwarded-proto': 'http', ...withAccess } }),
    'right secret, wrong route': () => s.fetchRaw('/ingest/v1/other', { method: 'POST', headers: s.H(withAccess), body: '{}' }),
    'right secret, wrong method': () => s.fetchRaw('/ingest/v1/reports', { method: 'GET', headers: s.H(withAccess) }),
    'a guess at the viewer path': () => s.fetchRaw('/r/' + 'x'.repeat(43), { headers: s.H() }),
  };
  const out = [];
  for (const [name, fn] of Object.entries(cases)) { const t0 = Date.now(); const r = await fn(); out.push({ name, status: r.status, body: await r.text(), ms: Date.now() - t0 }); }
  check('every refusal is 404 with the same two words', out.every((x) => x.status === 404 && x.body === 'Access denied'), out.map((x) => x.name + ':' + x.status).join(' '));
  check('every refusal waits at least the fixed time', out.every((x) => x.ms >= FLOOR - 15), out.map((x) => x.ms).join(','));
  const okAgain = await s.post(synthetic(), { headers: withAccess });
  check('with the edge header and the right secret it works', okAgain.status === 201);
  check('no refusal wrote a file', fs.readdirSync(reportsDir).length === 3);
  check('the health check answers without credentials', (await s.fetchRaw('/healthz')).status === 200);
  const hz = await s.fetchRaw('/ingest/healthz');
  check('/ingest/healthz answers the same as /healthz (a probe through the ingest/* tunnel route)', hz.status === 200 && (await hz.text()) === 'ok');
  check('nothing else under /ingest/ is a health check', (await s.fetchRaw('/ingest/healthz/x')).status === 404 && (await s.fetchRaw('/ingest/v1/healthz')).status === 404);
  check('security headers are on every response', (await s.fetchRaw('/healthz')).headers.get('x-robots-tag') === 'noindex, nofollow, noarchive, nosnippet' && (await s.fetchRaw('/healthz')).headers.get('cache-control') === 'no-store');
  await s.close();
}

console.log('only the contract is accepted');
{
  const s = await boot();
  const before = fs.readdirSync(reportsDir).length;
  const bad = async (name, body, status, extra = {}) => { const r = await s.post(body, extra); check(name, r.status === status, `got ${r.status}`); };
  await bad('the agency-only explore pack is refused', { format: 'webobs.explore-pack', version: '1.0' }, 422);
  await bad('an unapproved report is refused', synthetic({ meta: { review: { state: 'draft' } } }), 422);
  await bad('a top-level field outside the contract is refused', synthetic({ obsidianPath: 'sites/x/Pages/a.md' }), 422);
  await bad('a map field outside the contract is refused', synthetic({ map: { site: { ...synthetic().map.site, nodes: [{ id: 'a', obsidianPath: 'sites/x/Pages/a.md' }] } } }), 422);
  await bad('a site field outside the contract is refused', synthetic({ map: { site: { ...synthetic().map.site, resources: [] } } }), 422);
  await bad('an unsupported major version is refused', synthetic({ version: '2.0' }), 422);
  await bad('something that is not a report is refused', { hello: 'world' }, 422);
  await bad('text that is not JSON is refused', null, 400, { raw: 'not json at all' });
  await bad('hours below 1 are refused', synthetic(), 400, { q: '?hours=0' });
  await bad('hours above the limit are refused', synthetic(), 400, { q: '?hours=9999' });
  check('nothing refused was stored', fs.readdirSync(reportsDir).length === before);
  await s.close();
  const small = await boot({ maxBytes: 500 });
  await (async () => { const r = await small.post(synthetic()); check('a file over the size cap is refused (413)', r.status === 413); })();
  const lying = await fetch(`${small.base}/ingest/v1/reports`, { method: 'POST', headers: small.H({ 'content-length': '10' }), body: JSON.stringify(synthetic()) }).catch(() => null);
  check('and nothing was stored for it', fs.readdirSync(reportsDir).length === before);
  await small.close();
}

console.log('the link entry is written last');
{
  const s = await boot();
  const realRename = fs.renameSync; let seen = null;
  fs.renameSync = (from, to) => {
    if (String(to).startsWith(registryDir)) {
      seen = { reportThere: fs.readdirSync(reportsDir).some((f) => /^[0-9a-f]{32}.json$/.test(f)), entryThere: fs.existsSync(to) };
      throw new Error('simulated failure at the last step');
    }
    return realRename(from, to);
  };
  const before = new Set(fs.readdirSync(registryDir).filter((f) => f.endsWith('.json')));
  let r; try { r = await s.post(synthetic()); } finally { fs.renameSync = realRename; }
  const body = await r.text();
  check('when the link entry is written, the report is already stored and the entry is not yet visible', seen && seen.reportThere === true && seen.entryThere === false);
  check('if the last step fails there is no link: a plain 500 with no link or token', r.status === 500 && !body.includes('https:') && !body.includes('/r/') && !body.toLowerCase().includes('token'));
  check('and no new live link entry exists', fs.readdirSync(registryDir).filter((f) => f.endsWith('.json') && !before.has(f)).length === 0);
  await s.close();
}

console.log('flooding is limited');
{
  const s = await boot({ ratePerHour: 2, rateBadPerMin: 3 });
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await s.post(synthetic())).status);
  check('uploads per hour are capped (429 after the limit)', codes.slice(0, 2).every((c) => c === 201) && codes[2] === 429, codes.join(','));
  const bads = []; for (let i = 0; i < 6; i++) bads.push((await s.post(synthetic(), { headers: { authorization: 'Bearer nope' + i } })).status);
  check('repeated wrong secrets are slowed down (429)', bads.includes(429) && bads[0] === 404, bads.join(','));
  await s.close();
  const full = await boot({ maxReports: fs.readdirSync(reportsDir).length });
  check('a full store refuses new reports (507) instead of filling the disk', (await full.post(synthetic())).status === 507);
  await full.close();
}


console.log('the https publish transport (laptop side)');
{
  const { publishAny, parseTarget, describeTarget, PublishError } = await import('../scripts/lib/publish-core.mjs');
  const s = await boot();
  const file = path.join(dir, 'client.json'); fs.writeFileSync(file, JSON.stringify(synthetic()));
  const url = s.base + '/ingest/v1/reports';
  const CFID = 'cf-id-abcdef', CFSEC = 'cf-secret-' + 'q'.repeat(24);
  const env = { WEBOBS_INGEST_SECRET: SECRET, CF_ACCESS_CLIENT_ID: CFID, CF_ACCESS_CLIENT_SECRET: CFSEC };
  const sentHeaders = [];
  const spy = async (u, init) => { sentHeaders.push({ u, h: init.headers, redirect: init.redirect }); return fetch(u, { ...init, headers: { ...init.headers, 'x-forwarded-proto': 'https' } }); };
  const r = await publishAny({ reportFile: file, slug: 'zebra', hours: 6, target: url, env, indexFile: path.join(os.tmpdir(), 'wo-ingest-test-index.json'), fetchImpl: spy });
  check('publishing to an https target returns the server-made link', /^https:\/\/audit\.example\.test\/r\/[A-Za-z0-9_-]{43}$/.test(r.link) && r.id && r.expires);
  check('it sends the app secret and the Cloudflare Access service token as headers, with no redirects followed', sentHeaders[0].h.Authorization === 'Bearer ' + SECRET && sentHeaders[0].h['CF-Access-Client-Id'] === CFID && sentHeaders[0].h['CF-Access-Client-Secret'] === CFSEC && sentHeaders[0].redirect === 'manual');
  check('the requested life is passed on', Math.abs((Date.parse(r.expires) - Date.now()) / 3600000 - 6) < 0.1);
  check('the target can be described without showing a secret', describeTarget(parseTarget(url)) === new URL(url).host);
  const fail = async (e, fetchImpl) => { try { await publishAny({ reportFile: file, slug: 'zebra', target: url, env: e, fetchImpl }); return null; } catch (x) { return x; } };
  const wrong = await fail({ ...env, WEBOBS_INGEST_SECRET: 'wrong-secret-' + 'z'.repeat(30) }, spy);
  check('a wrong secret gives a plain refusal that names no secret', wrong instanceof PublishError && /refused the upload/.test(wrong.message) && ![SECRET, CFID, CFSEC, 'wrong-secret'].some((x) => wrong.message.includes(x)));
  const none = await fail({ CF_ACCESS_CLIENT_ID: CFID }, spy);
  check('no secret on this machine stops before anything is sent', none instanceof PublishError && /WEBOBS_INGEST_SECRET is not set/.test(none.message));
  const redirected = await fail(env, async () => ({ status: 302, text: async () => '' }));
  check('a redirect (Cloudflare Access login) is reported as a refusal, not followed', redirected instanceof PublishError && /refused the upload/.test(redirected.message));
  const down = await fail(env, async () => { throw new Error('ECONNREFUSED ' + SECRET); });
  check('an unreachable server gives a plain message with no detail', down instanceof PublishError && down.message === 'The server could not be reached.');
  const bad = path.join(dir, 'pack.json'); fs.writeFileSync(bad, JSON.stringify({ format: 'webobs.explore-pack' }));
  const sentBefore = sentHeaders.length;
  let refused = null; try { await publishAny({ reportFile: bad, slug: 'zebra', target: url, env, fetchImpl: spy }); } catch (x) { refused = x; }
  check('the explore pack is refused on this machine before it is sent', refused instanceof PublishError && sentHeaders.length === sentBefore);
  let plain = null; try { parseTarget('http://ingest.example.test/ingest/v1/reports'); } catch (x) { plain = x; }
  check('plain http to another machine is refused as a target', plain instanceof PublishError && parseTarget('http://127.0.0.1:1/x').kind === 'https');
  check('credentials are only read from the environment passed in, never from a file', !fs.readFileSync(path.join(root, 'apps', 'server', 'scripts', 'lib', 'publish-https.mjs'), 'utf8').match(/readFileSync\([^)]*(env|secret)/i));
  await s.close();
}

console.log('values and nested fields are checked, not just field names');
{
  const { applyCase, loadBadValues, loadSynthetic } = await import(new URL('../../../fixtures/apply-case.mjs', import.meta.url).href);
  const base = loadSynthetic(), cases = loadBadValues();
  const { build } = createRequire(path.join(root, 'package.json'))('esbuild');
  const o = await build({ entryPoints: [path.join(root, 'packages', 'contract', 'src', 'contract.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  const src = await import('data:text/javascript;base64,' + Buffer.from(o.outputFiles[0].contents).toString('base64'));
  check('the server\'s value spec equals the one in packages/contract/src/contract.ts', JSON.stringify(src.REPORT_SPEC) === JSON.stringify(local.REPORT_SPEC) && src.REPORT_MAX_CHARS === local.REPORT_MAX_CHARS);
  const body = (f) => f.slice(f.indexOf('// ----------------'));
  const tsText = fs.readFileSync(path.join(root, 'packages', 'contract', 'src', 'contractValues.ts'), 'utf8'), mjsText = fs.readFileSync(path.join(root, 'apps', 'server', 'ingest', 'contract-check.mjs'), 'utf8');
  check('the value-check code in the two files is the same text', mjsText.includes(body(tsText).trim()));
  check('the checked-in synthetic report is accepted by the server\'s check', local.checkIncomingReport(base).length === 0, local.checkIncomingReport(base).join(' '));
  for (const c of cases.good) { const p = local.checkIncomingReport(applyCase(base, c)); check(`still accepted: ${c.name}`, p.length === 0, p.join(' ')); }
  for (const c of cases.bad) { const p = local.checkIncomingReport(applyCase(base, c)); check(`refused by the check: ${c.name}`, p.length > 0); }
  const same = cases.bad.every((c) => { const r = applyCase(base, c); return JSON.stringify(local.reportValueProblems(r)) === JSON.stringify(src.reportValueProblems(r)); }) && cases.good.every((c) => { const r = applyCase(base, c); return JSON.stringify(local.reportValueProblems(r)) === JSON.stringify(src.reportValueProblems(r)); });
  check('the server and the builder report exactly the same value problems on every case', same);

  const s = await boot();
  const before = fs.readdirSync(reportsDir).length;
  const okRes = await s.post(base);
  check('the synthetic report is accepted over HTTPS (201)', okRes.status === 201, `got ${okRes.status}`);
  const stored = fs.readdirSync(reportsDir).length;
  check('and it is stored', stored === before + 1);
  let wrong = 0, leaked = 0;
  for (const c of cases.bad) {
    const r = await s.post(applyCase(base, c)); const t = await r.text();
    const want = c.name.startsWith('size:') ? [413, 422] : [422];
    if (!want.includes(r.status)) { wrong++; console.log(`  FAIL over HTTPS: ${c.name} -> ${r.status}`); }
    if (/alert\(1\)|onerror|<script/i.test(t)) leaked++;
  }
  failed += wrong;
  check('every bad value is refused over HTTPS (422, or 413 for the size case)', wrong === 0);
  check('the refusal text never echoes the hostile value back', leaked === 0);
  check('nothing from any bad report was stored', fs.readdirSync(reportsDir).length === stored);
  await s.close();
}

console.log('the audit log holds ids and times only');
{
  const log = fs.readFileSync(auditLog, 'utf8');
  const lines = log.trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
  check('there is a line for accepted, rejected and denied events', ['accepted', 'rejected', 'denied'].every((e) => lines.some((l) => l.event === e)));
  check('every line has a time and only known fields', lines.every((l) => l.at && Object.keys(l).every((k) => ['at', 'event', 'linkId', 'fileId', 'bytes', 'hours', 'reason'].includes(k))));
  check('no token, secret, address, client name or domain is in the log', !log.includes(firstToken) && !log.includes(SECRET) && !/203\.0\.113|Zebra|zebra-quartz/i.test(log));
}

console.log('starting the process: switched off idles (503, unhealthy on purpose), a misconfiguration exits 1');
{
/** Starts the real process with the ingest switched off and checks that it keeps running, answers 503 and shows as unhealthy; then stops it. */
const checkIdle = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'ingest.mjs')], { env: { PATH: process.env.PATH, ENV_FILE: path.join(dir, 'no-such.env'), INGEST_PORT: '0', ...env } });
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

  const run = (env) => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'ingest.mjs')], { env: { PATH: process.env.PATH, ENV_FILE: path.join(dir, 'no-such.env'), ...env }, encoding: 'utf8', timeout: 15000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const off = await checkIdle({});
  check('INGEST_ENABLED unset: it keeps running (no exit, so a restart policy cannot loop), says it is switched off, answers 503 to the health path and to an upload', off.ok && off.still && off.health === 503 && /switched off/.test(off.body) && off.post === 503 && off.out.includes('ingest is switched off (INGEST_ENABLED is not 1); idling on port'), off.why ?? `still ${off.still}, health ${off.health}, post ${off.post}`);
  const off2 = await checkIdle({ INGEST_ENABLED: '0', INGEST_SECRET: SECRET });
  check('INGEST_ENABLED=0 with a secret set: still idles', off2.ok && off2.still && off2.health === 503 && !off2.out.includes(SECRET), off2.why ?? '');
  const shortSecret = 'short-secret-value';
  const bad = run({ INGEST_ENABLED: '1', INGEST_SECRET: shortSecret, INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_PORT: '0' });
  check('switched on with a short secret: exit 1 and a plain reason naming INGEST_SECRET, no value', bad.status === 1 && /ingest not started: INGEST_SECRET is missing or shorter than 48 characters [(]48 are required when INGEST_REQUIRE_ACCESS_HEADER=0[)]/.test(bad.out) && !bad.out.includes(shortSecret), `exit ${bad.status}`);
  const noSecret = run({ INGEST_ENABLED: '1', INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_PORT: '0' });
  check('switched on with no secret: exit 1', noSecret.status === 1 && /INGEST_SECRET/.test(noSecret.out), `exit ${noSecret.status}`);
  const noAccess = run({ INGEST_ENABLED: '1', INGEST_SECRET: SECRET, INGEST_REQUIRE_ACCESS_HEADER: '1', INGEST_PORT: '0' });
  check('switched on, Access check on but CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD empty: exit 1 with a plain reason, no value', noAccess.status === 1 && /ingest not started: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set/.test(noAccess.out) && !noAccess.out.includes(SECRET) && !/at .*ingest[.]mjs:\d+/.test(noAccess.out), `exit ${noAccess.status}`);
  check('startupProblems lists nothing for a good configuration', startupProblems({ secret: SECRET, requireAccessHeader: true, accessTeamDomain: 'team.example.test', accessAudience: 'aud' }).length === 0);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall ingest checks passed');
process.exit(failed ? 1 : 0);

// Tests for running the ingest WITHOUT Cloudflare Access (opt-in, not recommended) and for the configurable client-IP header, plus
// proof that the default Cloudflare mode is unchanged. Synthetic data and fake keys only. Foreground and self-terminating: servers
// run inside this process on random ports, and the one real ingest process started here is stopped before the file ends.
//   node apps/server/ingest/test-no-edge.mjs
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createIngestServer, loadIngestConfig, startupProblems, describeIngestSetup, MIN_SECRET_NO_EDGE, NO_EDGE_WARNING } from './ingest.mjs';
import { createServer } from '../server.mjs';
import { clientAddress, clientIpHeaderName, isIpAddress } from '../clientip.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-ingest-noedge-'));
const fresh = () => { const d = fs.mkdtempSync(path.join(dir, 'v-')); return { reportsDir: path.join(d, 'reports'), registryDir: path.join(d, 'registry'), auditLog: path.join(d, 'audit', 'ingest.log') }; };
const LONG = crypto.randomBytes(32).toString('hex');            // 64 characters, what the helper makes
const CF_SECRET = 'cf-mode-test-secret-' + 'k'.repeat(20);       // 40 characters: fine with Cloudflare Access, too short without it
const report = fs.readFileSync(new URL('../../../fixtures/client-report.sample.json', import.meta.url), 'utf8');
const clientName = JSON.parse(report).client.name;
const ingestFile = path.join(import.meta.dirname, 'ingest.mjs');
const noEdgeEnv = (over = {}) => ({ INGEST_ENABLED: '1', INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: 'yes', INGEST_SECRET: LONG, TRUST_PROXY: '1', CLIENT_IP_HEADER: 'X-Real-IP', WEBOBS_REPORT_BASE: 'https://audit.example.test', ...over });
const audits = [];

/** An in-process ingest built from environment-style settings (so the env parsing is tested too), with test folders and timings. */
const boot = async (env, over = {}) => {
  const v = fresh(); audits.push(v.auditLog);
  const { server, cfg } = createIngestServer({ ...loadIngestConfig(env), ...v, deniedDelayMs: 0, ratePerHour: 1000, rateBadPerMin: 1000, ...over });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (headers = {}, secret = LONG) => fetch(`${base}/ingest/v1/reports`, { method: 'POST', headers: { 'x-forwarded-proto': 'https', 'content-type': 'application/json', ...(secret === null ? {} : { authorization: 'Bearer ' + secret }), ...headers }, body: report });
  return { cfg, v, base, post, close: () => new Promise((r) => server.close(r)) };
};
const builds = (env, over = {}) => { try { createIngestServer({ ...loadIngestConfig(env), ...fresh(), ...over }); return true; } catch { return false; } };
const runIngest = (env) => {
  const r = spawnSync(process.execPath, [ingestFile], { env: { PATH: process.env.PATH, ENV_FILE: path.join(dir, 'no-such.env'), INGEST_PORT: '0', ...env }, encoding: 'utf8', timeout: 15000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const plainReason = (out) => /ingest not started: /.test(out) && !/\bat .*[.]mjs:\d+/.test(out) && !/Error:/.test(out);

console.log('no-edge mode: the right 48+ character secret is accepted and the report is served');
{
  const s = await boot(noEdgeEnv());
  check('the settings parse: Access check off, acknowledged, X-Real-IP named', s.cfg.requireAccessHeader === false && s.cfg.acknowledgeNoEdgeAuth === true && s.cfg.clientIpHeader === 'x-real-ip');
  const r = await s.post({ 'x-real-ip': '198.51.100.20' });
  const j = await r.json();
  check('the right secret gets 201 and a link', r.status === 201 && /^https:\/\/audit\.example\.test\/r\/[A-Za-z0-9_-]{43}$/.test(j.link || ''), `got ${r.status}`);
  const token = (j.link || '').split('/r/')[1];
  fs.writeFileSync(path.join(dir, 'app.html'), '<!doctype html><html><body>v</body></html>');
  const { server: viewer } = createServer({ reportsDir: s.v.reportsDir, registryDir: s.v.registryDir, appFile: path.join(dir, 'app.html'), outboxDir: path.join(dir, 'outbox'), trustProxy: true, clientIpHeader: 'X-Real-IP', deniedDelayMs: 0 });
  await new Promise((rr) => viewer.listen(0, '127.0.0.1', rr));
  const vbase = `http://127.0.0.1:${viewer.address().port}`;
  const served = await fetch(`${vbase}/api/r/${token}/report.json`, { headers: { 'x-forwarded-proto': 'https', 'x-real-ip': '198.51.100.21' } });
  check('the viewer serves the uploaded report through the new link', served.status === 200 && (await served.json()).client.name === clientName);
  const page = await fetch(`${vbase}/r/${token}`, { headers: { 'x-forwarded-proto': 'https' } });
  check('the viewer page opens for the link', page.status === 200 && /data-server-report/.test(await page.text()));
  const plain = await fetch(`${vbase}/api/r/${token}/report.json`);
  check('without X-Forwarded-Proto: https from the proxy the viewer refuses (403): the proxy must set it', plain.status === 403);
  const plainIngest = await s.post({ 'x-forwarded-proto': 'http' });
  check('and the ingest refuses plain http with the same 404', plainIngest.status === 404 && (await plainIngest.text()) === 'Access denied');
  await new Promise((rr) => viewer.close(rr));
  check('the health checks answer without credentials', (await fetch(s.base + '/healthz')).status === 200 && (await fetch(s.base + '/ingest/healthz')).status === 200);
  await s.close();
}

console.log('no-edge mode: a wrong or missing secret gets the same 404 at the same fixed time');
{
  const FLOOR = 150;
  const s = await boot(noEdgeEnv(), { deniedDelayMs: FLOOR });
  const cases = {
    'no Authorization header': () => s.post({}, null),
    'wrong secret': () => s.post({}, crypto.randomBytes(32).toString('hex')),
    'one character changed': () => s.post({}, LONG.slice(0, -1) + (LONG.endsWith('a') ? 'b' : 'a')),
    'the secret minus its last character': () => s.post({}, LONG.slice(0, -1)),
    'the secret plus one character': () => s.post({}, LONG + 'a'),
    'empty bearer': () => s.post({}, ''),
    'Basic instead of Bearer': () => s.post({ authorization: 'Basic ' + Buffer.from('x:' + LONG).toString('base64') }, null),
  };
  const out = [];
  for (const [name, fn] of Object.entries(cases)) { const t0 = Date.now(); const r = await fn(); out.push({ name, status: r.status, body: await r.text(), type: r.headers.get('content-type'), ms: Date.now() - t0 }); }
  check('every refusal is 404 with exactly the same body and type', out.every((x) => x.status === 404 && x.body === 'Access denied' && x.type === out[0].type), out.map((x) => x.name + ':' + x.status).join(' '));
  check('every refusal waits at least the fixed time', out.every((x) => x.ms >= FLOOR - 15), out.map((x) => x.ms).join(','));
  check('and they all take about the same time', Math.max(...out.map((x) => x.ms)) - Math.min(...out.map((x) => x.ms)) < FLOOR, out.map((x) => x.ms).join(','));
  check('nothing was stored for any of them', !fs.existsSync(s.v.reportsDir) || fs.readdirSync(s.v.reportsDir).length === 0);
  await s.close();
}

console.log('no-edge mode needs the written acknowledgment (exactly yes)');
{
  for (const [label, ack] of [['missing', undefined], ['empty', ''], ['true', 'true'], ['1', '1'], ['YES', 'YES'], ['" yes"', ' yes']]) {
    const env = noEdgeEnv(); if (ack === undefined) delete env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH; else env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH = ack;
    check(`acknowledgment ${label}: createIngestServer throws`, !builds(env));
    check(`acknowledgment ${label}: startupProblems names INGEST_ACKNOWLEDGE_NO_EDGE_AUTH`, startupProblems(loadIngestConfig(env)).some((p) => p.includes('INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes')));
  }
  check('acknowledgment yes: it builds', builds(noEdgeEnv()));
  check('an override of true is the only accepted in-code value (a string does not count)', !builds(noEdgeEnv(), { acknowledgeNoEdgeAuth: 'yes' }) && builds(noEdgeEnv(), { acknowledgeNoEdgeAuth: true }));
  for (const [label, ack] of [['missing', undefined], ['true', 'true'], ['1', '1']]) {
    const env = noEdgeEnv(); if (ack === undefined) delete env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH; else env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH = ack;
    const r = runIngest(env);
    check(`the real process, acknowledgment ${label}: exit 1 with a plain reason, names only`, r.status === 1 && plainReason(r.out) && /ingest not started: INGEST_REQUIRE_ACCESS_HEADER=0 [(]no Cloudflare Access[)] also needs INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes/.test(r.out) && !r.out.includes(LONG) && !r.out.includes(NO_EDGE_WARNING), `exit ${r.status}`);
  }
}

console.log('no-edge mode needs a secret of at least 48 characters');
{
  const s47 = 'n'.repeat(MIN_SECRET_NO_EDGE - 1), s40 = CF_SECRET;
  check('the minimum is 48', MIN_SECRET_NO_EDGE === 48);
  check('47 characters: createIngestServer throws', !builds(noEdgeEnv({ INGEST_SECRET: s47 })));
  check('40 characters: createIngestServer throws', !builds(noEdgeEnv({ INGEST_SECRET: s40 })));
  check('48 characters: it builds', builds(noEdgeEnv({ INGEST_SECRET: 'n'.repeat(48) })));
  check('startupProblems says 48 for a 40-character secret', startupProblems(loadIngestConfig(noEdgeEnv({ INGEST_SECRET: s40 }))).some((p) => /INGEST_SECRET is missing or shorter than 48 characters/.test(p)));
  const r = runIngest(noEdgeEnv({ INGEST_SECRET: s47 }));
  check('the real process with a 47-character secret: exit 1, plain reason, no value', r.status === 1 && plainReason(r.out) && /shorter than 48 characters/.test(r.out) && !r.out.includes(s47), `exit ${r.status}`);
  check('the same 40-character secret is still fine with Cloudflare Access on (32 rule unchanged)', builds({ INGEST_ENABLED: '1', INGEST_SECRET: s40, CF_ACCESS_TEAM_DOMAIN: 'team.example.test', CF_ACCESS_AUD: 'a'.repeat(64) }));
}

console.log('the real process in no-edge mode starts with a loud warning');
{
  const port = await new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const v = fresh();
  const child = spawn(process.execPath, [ingestFile], { env: { PATH: process.env.PATH, ENV_FILE: path.join(dir, 'no-such.env'), ...noEdgeEnv(), INGEST_PORT: String(port), INGEST_REPORTS_DIR: v.reportsDir, INGEST_REGISTRY_DIR: v.registryDir, INGEST_AUDIT_LOG: v.auditLog }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const listening = await new Promise((r) => { const t = setTimeout(() => r(false), 10000); const tick = setInterval(() => { if (/ingest listening on port/.test(out)) { clearTimeout(t); clearInterval(tick); r(true); } }, 25); child.on('exit', () => { clearTimeout(t); clearInterval(tick); r(false); }); });
  let health = 0; if (listening) { try { health = (await fetch(`http://127.0.0.1:${port}/ingest/healthz`)).status; } catch { health = -1; } }
  child.kill();
  await new Promise((r) => { if (child.exitCode !== null || child.signalCode) r(); else child.on('exit', r); });
  check('it starts and answers /ingest/healthz', listening && health === 200, `listening=${listening} health=${health}`);
  check('it prints the one-line WARNING', out.split(/\r?\n/).includes(NO_EDGE_WARNING) && NO_EDGE_WARNING === 'WARNING: ingest running WITHOUT Cloudflare Access: protected only by the app secret, size cap and in-app rate limits');
  check('no secret value is printed', !out.includes(LONG));
  const notice = describeIngestSetup(loadIngestConfig(noEdgeEnv({ CLIENT_IP_HEADER: '' }))).join(' ');
  check('a start-up notice says to name your proxy\'s header when CLIENT_IP_HEADER is left at CF-Connecting-IP', /CLIENT_IP_HEADER is CF-Connecting-IP while running without Cloudflare/.test(notice));
}

console.log('client address: the configured header, its last entry, plain IPs only, else the connection address');
{
  const req = (headers, remote = '10.0.0.9') => ({ headers, socket: { remoteAddress: remote } });
  check('TRUST_PROXY off: the connection address, the header ignored', clientAddress(req({ 'x-real-ip': '198.51.100.1' }), { trustProxy: false, header: 'x-real-ip' }) === '10.0.0.9');
  check('the default header is CF-Connecting-IP', clientIpHeaderName(undefined) === 'cf-connecting-ip' && clientIpHeaderName('') === 'cf-connecting-ip' && clientAddress(req({ 'cf-connecting-ip': '198.51.100.1' }), { trustProxy: true }) === '198.51.100.1');
  check('the configured name is matched case-insensitively', clientAddress(req({ 'x-real-ip': '198.51.100.2' }), { trustProxy: true, header: 'X-REAL-IP' }) === '198.51.100.2' && loadIngestConfig({ CLIENT_IP_HEADER: ' X-Real-IP ' }).clientIpHeader === 'x-real-ip');
  check('a header name with odd characters falls back to the default', clientIpHeaderName('x real ip') === 'cf-connecting-ip' && clientIpHeaderName('x-real-ip:') === 'cf-connecting-ip');
  check('several entries: the LAST one is used', clientAddress(req({ 'x-forwarded-for': '203.0.113.50, 198.51.100.3' }), { trustProxy: true, header: 'x-forwarded-for' }) === '198.51.100.3');
  check('a repeated header (array) also uses the last entry', clientAddress(req({ 'x-real-ip': ['203.0.113.50', '198.51.100.4'] }), { trustProxy: true, header: 'x-real-ip' }) === '198.51.100.4');
  check('IPv6 addresses are accepted', ['2001:db8::1', '::1', '::ffff:192.0.2.1', 'fe80::1:2:3:4'].every(isIpAddress));
  const garbage = ['', ' ', 'unknown', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '01.2.3.4', '1.2.3.4:8080', '[2001:db8::1]', '2001:db8::1%eth0', '::g', '1.2.3.4 x', '1.2.3.4;x', 'x'.repeat(100), '1.2.3.4\t'];
  check('garbage is not an address', garbage.every((g) => !isIpAddress(g)), garbage.filter(isIpAddress).join('|'));
  // Surrounding blanks are trimmed (HTTP drops them anyway), so the tab case is only a garbage value for isIpAddress itself.
  check('missing or garbage header: the connection address (fail safe)', clientAddress(req({}), { trustProxy: true, header: 'x-real-ip' }) === '10.0.0.9' && garbage.filter((g) => g !== '1.2.3.4\t').every((g) => clientAddress(req({ 'x-real-ip': g }), { trustProxy: true, header: 'x-real-ip' }) === '10.0.0.9') && clientAddress(req({ 'x-real-ip': '198.51.100.1, garbage' }), { trustProxy: true, header: 'x-real-ip' }) === '10.0.0.9');
  check('the viewer reads CLIENT_IP_HEADER too', (await import('../server.mjs')).loadConfig({ CLIENT_IP_HEADER: 'X-Real-IP' }).clientIpHeader === 'x-real-ip' && (await import('../server.mjs')).loadConfig({}).clientIpHeader === 'cf-connecting-ip');
}

console.log('rate limits follow CLIENT_IP_HEADER (ingest)');
{
  const s = await boot(noEdgeEnv(), { rateBadPerMin: 2 });
  const bad = async (h) => (await s.post(h, 'wrong-' + crypto.randomBytes(8).toString('hex'))).status;
  const a = []; for (let i = 0; i < 3; i++) a.push(await bad({ 'x-real-ip': '198.51.100.1', 'cf-connecting-ip': `203.0.113.${i}` }));
  check('wrong secrets from one X-Real-IP are limited; rotating CF-Connecting-IP does not help', a[0] === 404 && a[1] === 404 && a[2] === 429, a.join(','));
  check('another X-Real-IP has its own bucket', (await bad({ 'x-real-ip': '198.51.100.2' })) === 404);
  const firsts = []; for (let i = 0; i < 3; i++) firsts.push(await bad({ 'x-real-ip': `203.0.113.${60 + i}, 198.51.100.1` }));
  check('several entries: rotating the first entry does not help, the last one counts', firsts.every((c) => c === 429), firsts.join(','));
  check('several entries: a different LAST entry is a different caller', (await bad({ 'x-real-ip': '198.51.100.1, 198.51.100.3' })) === 404);
  await s.close();

  const g = await boot(noEdgeEnv(), { rateBadPerMin: 2 });
  const gb = async (h) => (await g.post(h, 'wrong-' + crypto.randomBytes(8).toString('hex'))).status;
  const gs = []; for (const v of ['not-an-ip', '999.1.1.1', '1.2.3.4:80', 'x, y']) gs.push(await gb({ 'x-real-ip': v }));
  check('rotating garbage in the header does not avoid the limit (it falls back to the connection address)', gs[0] === 404 && gs[1] === 404 && gs.slice(2).every((c) => c === 429), gs.join(','));
  check('a request with no header at all shares that same bucket and is limited too', (await gb({})) === 429);
  check('a valid address in the header still has its own bucket', (await gb({ 'x-real-ip': '198.51.100.9' })) === 404);
  await g.close();

  const u = await boot(noEdgeEnv(), { ratePerHour: 1 });
  const up = []; for (const ip of ['198.51.100.30', '198.51.100.30', '198.51.100.31']) up.push((await u.post({ 'x-real-ip': ip })).status);
  check('uploads per hour are counted per X-Real-IP address', up.join(',') === '201,429,201', up.join(','));
  await u.close();
}

console.log('rate limits follow CLIENT_IP_HEADER (viewer)');
{
  const v = fresh(); fs.mkdirSync(v.reportsDir, { recursive: true }); fs.mkdirSync(v.registryDir, { recursive: true });
  const { server } = createServer({ reportsDir: v.reportsDir, registryDir: v.registryDir, appFile: path.join(dir, 'app.html'), outboxDir: path.join(dir, 'outbox'), trustProxy: true, clientIpHeader: 'X-Real-IP', deniedDelayMs: 0, rateGeneral: 1000, rateBadToken: 2 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (h) => (await fetch(`http://127.0.0.1:${server.address().port}/api/r/${'q'.repeat(43)}/report.json`, { headers: { 'x-forwarded-proto': 'https', ...h } })).status;
  const a = []; for (let i = 0; i < 3; i++) a.push(await get({ 'x-real-ip': '198.51.100.1', 'cf-connecting-ip': `203.0.113.${i}` }));
  check('wrong links from one X-Real-IP are limited; CF-Connecting-IP is ignored when another header is configured', a.join(',') === '404,404,429', a.join(','));
  check('several entries: the last one counts', (await get({ 'x-real-ip': '203.0.113.99, 198.51.100.1' })) === 429 && (await get({ 'x-real-ip': '198.51.100.1, 198.51.100.5' })) === 404);
  const gs = []; for (const g of ['junk', '1.2.3.4:5', '::zz']) gs.push(await get({ 'x-real-ip': g }));
  check('garbage falls back to the connection address and is still limited', gs.join(',') === '404,404,429', gs.join(','));
  await new Promise((r) => server.close(r));
}

console.log('Cloudflare mode (the default) is unchanged');
{
  check('INGEST_REQUIRE_ACCESS_HEADER unset means the Access check is ON', loadIngestConfig({}).requireAccessHeader === true && loadIngestConfig({ INGEST_REQUIRE_ACCESS_HEADER: '' }).requireAccessHeader === true && loadIngestConfig({ INGEST_REQUIRE_ACCESS_HEADER: '1' }).requireAccessHeader === true);
  check('only exactly 0 turns it off (false, no, off do not)', ['false', 'no', 'off', ' 0'].every((x) => loadIngestConfig({ INGEST_REQUIRE_ACCESS_HEADER: x }).requireAccessHeader === true) && loadIngestConfig({ INGEST_REQUIRE_ACCESS_HEADER: '0' }).requireAccessHeader === false);
  const unset = runIngest({ INGEST_ENABLED: '1', INGEST_SECRET: CF_SECRET });
  check('switched on with INGEST_REQUIRE_ACCESS_HEADER unset and no team domain/AUD: exit 1 (the Access check is the default)', unset.status === 1 && /CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set/.test(unset.out) && !unset.out.includes(NO_EDGE_WARNING), `exit ${unset.status}`);

  const TEAM = 'team-example.cloudflareaccess.com', AUD = 'a'.repeat(64);
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims, key = pair.privateKey) => { const d = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`; return `${d}.${crypto.sign('RSA-SHA256', Buffer.from(d), key).toString('base64url')}`; };
  const nowS = Math.floor(Date.now() / 1000);
  const good = { iss: `https://${TEAM}`, aud: [AUD], exp: nowS + 600, iat: nowS, nbf: nowS - 5 };
  const jwksFetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const cfEnv = { INGEST_ENABLED: '1', INGEST_SECRET: CF_SECRET, TRUST_PROXY: '1', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, WEBOBS_REPORT_BASE: 'https://audit.example.test' };
  check('no acknowledgment is needed with the Access check on', builds(cfEnv) && startupProblems(loadIngestConfig(cfEnv)).length === 0);
  const FLOOR = 150;
  const s = await boot(cfEnv, { deniedDelayMs: FLOOR, jwksFetch });
  const withJwt = (jwt) => s.post({ 'cf-connecting-ip': '198.51.100.40', ...(jwt === null ? {} : { 'cf-access-jwt-assertion': jwt }) }, CF_SECRET);
  const cases = { 'forged (signed by another key)': () => withJwt(sign(good, other.privateKey)), 'missing': () => withJwt(null), 'expired': () => withJwt(sign({ ...good, exp: nowS - 5 })), 'valid token, wrong secret': () => s.post({ 'cf-access-jwt-assertion': sign(good) }, 'wrong') };
  const out = [];
  for (const [name, fn] of Object.entries(cases)) { const t0 = Date.now(); const r = await fn(); out.push({ name, status: r.status, body: await r.text(), ms: Date.now() - t0 }); }
  check('forged, missing and expired JWT (and a wrong secret) all get the same 404', out.every((x) => x.status === 404 && x.body === 'Access denied'), out.map((x) => x.name + ':' + x.status).join(' '));
  check('each after the fixed time', out.every((x) => x.ms >= FLOOR - 15), out.map((x) => x.ms).join(','));
  const ok = await withJwt(sign(good));
  check('a valid token with the right secret is accepted (201)', ok.status === 201);
  check('no warning is printed in Cloudflare mode (startup notices do not mention running without it)', !describeIngestSetup(loadIngestConfig(cfEnv)).some((l) => /without Cloudflare|not recommended/i.test(l)));
  await s.close();
}

console.log('the audit log still holds ids and times only (no addresses)');
{
  const text = audits.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('');
  const lines = text.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  check('there are accepted, denied and rate-limited lines', ['accepted', 'denied', 'rate-limited'].every((e) => lines.some((l) => l.event === e)));
  check('only known fields', lines.every((l) => Object.keys(l).every((k) => ['at', 'event', 'linkId', 'fileId', 'bytes', 'hours', 'reason'].includes(k))));
  check('no address, secret or client name appears', !/198\.51\.100|203\.0\.113|127\.0\.0\.1|::1|x-real-ip/i.test(text) && !text.includes(LONG) && !text.includes(CF_SECRET) && !text.includes(clientName));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} no-edge check(s) FAILED` : '\nall no-edge and client-address checks passed');
process.exit(failed ? 1 : 0);

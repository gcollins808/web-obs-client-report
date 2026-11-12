// Full system smoke test of the image: the Cloudflare and the no-Cloudflare ingest workflows, the viewer, the exporter's output, the
// cleanup tool and the container health checks. Synthetic data and fake keys only (a test RSA keypair and a fake key list made here;
// random secrets made here and never printed). Foreground and self-terminating: every server runs INSIDE this process on a port inside
// the container, the few real processes it starts (node ingest/ingest.mjs, node tools/cleanup.mjs, the health-check snippets) exit by
// themselves, and nothing is published or left running.
//
// It is NOT part of the image. Mount it for the run (with the exporter fixtures and the deploy folder):
//   docker run --rm --read-only --tmpfs /tmp --tmpfs /data:uid=1000,gid=1000 --cap-drop ALL --security-opt no-new-privileges:true \
//     -v "<this file's folder>:/smoke:ro" -v "<fixtures folder>:/fixtures:ro" -v "<repo>/deploy:/deploy:ro" \
//     webobs-report:<tag> node /smoke/docker-smoke-full.mjs
//
// Sections: A Cloudflare mode, B no-Cloudflare mode, C viewer (+ cleanup, audit log and output scan), D exporter output, F health checks.
// (E, F2 and G are run on the host; run them by hand on a host with Docker.) Prints one ok/FAIL line per check, totals per section, exits 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync, execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const APP_DIR = path.resolve(process.env.APP_DIR || process.cwd());
const DATA = process.env.DATA_DIR || '/data';
const FIXTURES = process.env.FIXTURES_DIR || '/fixtures';
const DEPLOY = process.env.DEPLOY_DIR || '/deploy';

// ---- everything this process (and every process it starts) prints is kept, to prove no secret, token or JWT was ever printed ----
let captured = '';
for (const stream of [process.stdout, process.stderr]) {
  const orig = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { captured += String(chunk); return orig(chunk, ...rest); };
}
const SECRETS = new Set();
const keep = (s) => { SECRETS.add(s); return s; };

let failed = 0, passed = 0, section = '';
const counts = {};
const heading = (letter, title) => { section = letter; counts[letter] ||= { ok: 0, all: 0 }; console.log(`\n${letter}. ${title}`); };
const check = (name, ok, extra = '') => {
  if (ok) passed++; else failed++;
  counts[section].all++; if (ok) counts[section].ok++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

const imp = (rel) => import(pathToFileURL(path.join(APP_DIR, rel)).href);
const { createServer, loadConfig } = await imp('server.mjs');
const { createIngestServer, loadIngestConfig, INGEST_ROUTE, MIN_SECRET_NO_EDGE } = await imp('ingest/ingest.mjs');
const { verifyAccessJwt } = await imp('ingest/access-jwt.mjs');
const { checkIncomingReport } = await imp('ingest/contract-check.mjs');
const { hashToken, newToken } = await imp('tokens.mjs');

// Node's fetch refuses some ports ("bad port"); listen(0) can land on one. Same helper as apps/server/test-tunnel-path.mjs.
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const servers = [];
async function listen(server, port = 0) {
  servers.push(server);
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, port ? undefined : '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const p = server.address().port;
    if (port || !FETCH_BLOCKED_PORTS.has(p)) return p;
    await new Promise((r) => server.close(r));
  }
  throw new Error('no usable port after 20 tries');
}
const stop = async (server) => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };

// ---- synthetic settings, secrets and a fake Cloudflare Access setup ----
const PUBLIC = 'https://audit.example.test';
const TEAM = 'example-team.cloudflareaccess.com';
const AUD = crypto.randomBytes(32).toString('hex');
const SECRET_CF = keep(crypto.randomBytes(32).toString('hex'));
const SECRET_NE = keep(crypto.randomBytes(32).toString('hex'));
const CLIENT_NAME = 'Synthetic Smoke Client ' + crypto.randomBytes(3).toString('hex');
const REPORT_TEXT = 'Synthetic finding text ' + crypto.randomBytes(3).toString('hex');
const report = { format: 'webobs.client-report', version: '1.1', meta: { review: { state: 'approved' } }, client: { name: CLIENT_NAME, preparedFor: REPORT_TEXT } };
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'smoke-key-1';
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
let jwksCalls = 0;
const jwksFetch = async (url) => { jwksCalls++; if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return { ok: false, json: async () => ({}) }; return { ok: true, json: async () => ({ keys: [jwk] }) }; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signJwt = (claims, key = pair.privateKey) => { const data = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64(claims)}`; return keep(`${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`); };
const nowS = () => Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: nowS() + 3600, iat: nowS(), nbf: nowS() - 5, sub: 'synthetic-service-token', ...over });
const JWT = signJwt(claims());

const cfEnv = (over = {}) => ({ INGEST_ENABLED: '1', INGEST_SECRET: SECRET_CF, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, WEBOBS_REPORT_BASE: PUBLIC, TRUST_PROXY: '1', ...over });
const neEnv = (over = {}) => ({ INGEST_ENABLED: '1', INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: 'yes', INGEST_SECRET: SECRET_NE, WEBOBS_REPORT_BASE: PUBLIC, TRUST_PROXY: '1', CLIENT_IP_HEADER: 'X-Real-IP', ...over });
const auditLogs = [];
const vol = (name) => { const d = path.join(DATA, name); const v = { reportsDir: path.join(d, 'reports'), registryDir: path.join(d, 'registry'), auditLog: path.join(d, 'audit', 'ingest.log') }; auditLogs.push(v.auditLog); return v; };
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

async function bootIngest(env, v, over = {}) {
  const { server, cfg } = createIngestServer({ ...loadIngestConfig(env), ...v, jwksFetch, ...over });
  const port = await listen(server, over.port || 0);
  return { server, cfg, v, base: `http://127.0.0.1:${port}` };
}
async function bootViewer(v, over = {}) {
  const { server, cfg } = createServer({ ...loadConfig({ ...process.env, TRUST_PROXY: '1' }), reportsDir: v.reportsDir, registryDir: v.registryDir, appFile: process.env.APP_FILE || path.join(APP_DIR, 'report.html'), outboxDir: path.join(DATA, 'outbox'), ...over });
  const port = await listen(server, over.port || 0);
  return { server, cfg, v, base: `http://127.0.0.1:${port}` };
}
let ipN = 0;
const nextIp = () => `198.51.100.${(ipN++ % 250) + 1}`;
/** One push. secret/jwt null = header left out. Returns status, body text, content type and the time it took. */
async function push(base, { secret, jwt = null, ip = nextIp(), ipHeader = 'cf-connecting-ip', headers = {}, body = JSON.stringify(report) } = {}) {
  const h = { 'x-forwarded-proto': 'https', 'content-type': 'application/json', [ipHeader]: ip, ...headers };
  if (secret != null) h.authorization = 'Bearer ' + secret;
  if (jwt != null) h['cf-access-jwt-assertion'] = jwt;
  const t0 = performance.now();
  const r = await fetch(base + INGEST_ROUTE, { method: 'POST', headers: h, body });
  const text = await r.text();
  return { status: r.status, text, type: r.headers.get('content-type'), ms: performance.now() - t0, json: (() => { try { return JSON.parse(text); } catch { return {}; } })() };
}
const vget = (base, p, ip = nextIp()) => fetch(base + p, { headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': ip } });
const tokenOf = (link) => keep(String(link || '').split('/r/')[1] || '');
const same = (a, b) => a.status === b.status && a.text === b.text && a.type === b.type;
const runNode = (args, env, cwd = APP_DIR) => {
  const r = spawnSync(process.execPath, args, { cwd, env: { PATH: process.env.PATH, ENV_FILE: '/nonexistent.env', ...env }, encoding: 'utf8', timeout: 20000 });
  const out = (r.stdout || '') + (r.stderr || '');
  captured += out;
  return { status: r.status, out, stdout: r.stdout || '' };
};
const plainReason = (out) => /ingest not started: /.test(out) && !/\n\s+at .+:\d+/.test(out) && !/Error:/.test(out);
const runAsync = (args) => new Promise((resolve) => { execFile(process.execPath, args, { timeout: 10000 }, (err, so, se) => { captured += String(so || '') + String(se || ''); resolve(err ? (typeof err.code === 'number' ? err.code : -1) : 0); }); });

/** A cloudflared stand-in: ordered routes, first match wins, full path forwarded; the edge sets proto, caller address and (on Access routes) the JWT. */
function makeTunnel(routes) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://x').pathname;
    const route = routes.find((r) => r.match(pathname));
    const headers = { ...req.headers, host: 'audit.example.test', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.77' };
    delete headers['cf-access-jwt-assertion'];
    if (route.access) headers['cf-access-jwt-assertion'] = signJwt(claims());
    route.hits.push(pathname);
    const up = http.request({ host: '127.0.0.1', port: route.port, method: req.method, path: req.url, headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
    req.pipe(up);
  });
}
/** A plain reverse proxy (no Cloudflare): sets X-Forwarded-Proto and X-Real-IP itself. The test names the emulated caller in
 *  x-emulated-client (the value the proxy writes into X-Real-IP, verbatim, so several entries or garbage can be tested); without it the
 *  proxy sends no X-Real-IP at all. Any X-Real-IP the caller sent is dropped. */
function makeProxy(port) {
  return http.createServer((req, res) => {
    const headers = { ...req.headers, 'x-forwarded-proto': 'https' };
    delete headers['x-real-ip']; delete headers['x-emulated-client'];
    if (req.headers['x-emulated-client'] !== undefined) headers['x-real-ip'] = req.headers['x-emulated-client'];
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
    req.pipe(up);
  });
}

console.log(`image app folder ${APP_DIR}; data ${DATA}; uid ${process.getuid?.()}`);

// =====================================================================================================================================
heading('A', 'CLOUDFLARE MODE (INGEST_REQUIRE_ACCESS_HEADER unset = on; real token verifier, fake key list)');
{
  const va = vol('a');
  const ia = await bootIngest(cfEnv(), va);
  const DELAY = ia.cfg.deniedDelayMs;
  check('settings: Access check on by default, refusal time is the default DENIED_DELAY_MS (250)', ia.cfg.requireAccessHeader === true && DELAY === 250, `delay ${DELAY}`);
  check('the image\'s verifier accepts the fake test token against the fake key list (sanity)', await verifyAccessJwt(JWT, { teamDomain: TEAM, audience: AUD, getKey: async (k) => (k === KID ? jwk : null) }));
  const ok = await push(ia.base, { secret: SECRET_CF, jwt: JWT });
  const tok = tokenOf(ok.json.link);
  check('right secret + valid JWT -> 201 and a link', ok.status === 201 && /^https:\/\/audit\.example\.test\/r\/[A-Za-z0-9_-]{43}$/.test(ok.json.link || ''), `status ${ok.status}`);
  check('the key list was fetched through the jwksFetch override', jwksCalls >= 1);
  const refusals = {
    'missing JWT': await push(ia.base, { secret: SECRET_CF }),
    'forged JWT (other key)': await push(ia.base, { secret: SECRET_CF, jwt: signJwt(claims(), other.privateKey) }),
    'expired JWT': await push(ia.base, { secret: SECRET_CF, jwt: signJwt(claims({ exp: nowS() - 10 })) }),
    'wrong audience': await push(ia.base, { secret: SECRET_CF, jwt: signJwt(claims({ aud: [crypto.randomBytes(32).toString('hex')] })) }),
    'wrong issuer': await push(ia.base, { secret: SECRET_CF, jwt: signJwt(claims({ iss: 'https://other-team.cloudflareaccess.com' })) }),
  };
  const r0 = refusals['missing JWT'];
  check('missing / forged / expired / wrong-audience / wrong-issuer JWT -> the identical 404 Access denied', Object.values(refusals).every((r) => r.status === 404 && r.text === 'Access denied' && same(r, r0)), Object.entries(refusals).map(([k, r]) => `${k}:${r.status}`).join(', '));
  const wrong = await push(ia.base, { secret: keep(crypto.randomBytes(32).toString('hex')), jwt: JWT });
  const missing = await push(ia.base, { secret: null, jwt: JWT });
  check('wrong secret and missing secret with a valid JWT -> the identical 404', same(wrong, r0) && same(missing, r0), `${wrong.status}/${missing.status}`);
  check('wrong vs missing secret take about the same time (within 150 ms)', Math.abs(wrong.ms - missing.ms) <= 150, `${Math.round(wrong.ms)} ms vs ${Math.round(missing.ms)} ms`);
  const all = [...Object.values(refusals), wrong, missing];
  check(`every refusal waits at least DENIED_DELAY_MS (${DELAY} ms)`, all.every((r) => r.ms >= DELAY), all.map((r) => Math.round(r.ms)).join(','));
  check('nothing was stored for the refused pushes (1 report, 1 link)', files(va.reportsDir).length === 1 && files(va.registryDir).filter((n) => n.endsWith('.json')).length === 1);
  const hz = await fetch(ia.base + '/ingest/healthz'), hz2 = await fetch(ia.base + '/healthz');
  check('/ingest/healthz and /healthz answer ok without credentials', hz.status === 200 && (await hz.text()) === 'ok' && hz2.status === 200 && (await hz2.text()) === 'ok');
  void tok;
  await stop(ia.server);

  console.log('  -- two-route tunnel emulation (cloudflared stand-in, the edge adds a fresh valid JWT on ingest/*)');
  const vt = vol('a-tunnel');
  const it = await bootIngest(cfEnv(), vt), vw = await bootViewer(vt);
  const ingestRoute = { match: (p) => p.startsWith('/ingest/'), port: Number(new URL(it.base).port), access: true, hits: [] };
  const catchAll = { match: () => true, port: Number(new URL(vw.base).port), access: false, hits: [] };
  const right = makeTunnel([ingestRoute, catchAll]);
  const rbase = `http://127.0.0.1:${await listen(right)}`;
  const tp = await fetch(rbase + INGEST_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SECRET_CF }, body: JSON.stringify(report) });
  const tj = await tp.json().catch(() => ({}));
  const ttok = tokenOf(tj.link);
  check('right order (ingest/* first): push through the tunnel -> 201 and a link', tp.status === 201 && ttok.length === 43, `status ${tp.status}`);
  const tr = await fetch(`${rbase}/api/r/${ttok}/report.json`), tpage = await fetch(`${rbase}/r/${ttok}`);
  check('the viewer serves that link through the tunnel (report.json 200, page 200)', tr.status === 200 && (await tr.json()).format === 'webobs.client-report' && tpage.status === 200);
  const ih = await fetch(rbase + '/ingest/healthz'), vh = await fetch(rbase + '/healthz');
  check('/ingest/healthz (ingest) and /healthz (viewer) answer ok through the tunnel', ih.status === 200 && (await ih.text()) === 'ok' && vh.status === 200 && (await vh.text()) === 'ok' && ingestRoute.hits.includes('/ingest/healthz') && catchAll.hits.includes('/healthz'));
  const before = files(vt.reportsDir).length + files(vt.registryDir).length;
  ingestRoute.hits.length = 0;
  const wrongT = makeTunnel([catchAll, ingestRoute]);
  const wbase = `http://127.0.0.1:${await listen(wrongT)}`;
  const wp = await fetch(wbase + INGEST_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SECRET_CF }, body: JSON.stringify(report) });
  const wt = await wp.text();
  check('WRONG order (catch-all first): the push gets Access denied, no link', [403, 404].includes(wp.status) && /This link is not available/.test(wt) && !wt.includes('/r/'), `status ${wp.status}`);
  check('WRONG order: nothing is stored and the ingest is never reached', files(vt.reportsDir).length + files(vt.registryDir).length === before && ingestRoute.hits.length === 0);
  for (const s of [right, wrongT, it.server, vw.server]) await stop(s);
}

// =====================================================================================================================================
heading('B', 'NO-CLOUDFLARE MODE (INGEST_REQUIRE_ACCESS_HEADER=0, INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes, 64-char secret)');
{
  const vb = vol('b');
  const ib = await bootIngest(neEnv(), vb);
  const DELAY = ib.cfg.deniedDelayMs;
  check('settings parse: Access check off, acknowledged, CLIENT_IP_HEADER x-real-ip', ib.cfg.requireAccessHeader === false && ib.cfg.acknowledgeNoEdgeAuth === true && ib.cfg.clientIpHeader === 'x-real-ip');
  const ok = await push(ib.base, { secret: SECRET_NE, ipHeader: 'x-real-ip' });
  tokenOf(ok.json.link);
  check('right secret -> 201 and a link', ok.status === 201 && /^https:\/\/audit\.example\.test\/r\/[A-Za-z0-9_-]{43}$/.test(ok.json.link || ''), `status ${ok.status}`);
  const wrong = await push(ib.base, { secret: keep(crypto.randomBytes(32).toString('hex')), ipHeader: 'x-real-ip' });
  const missing = await push(ib.base, { secret: null, ipHeader: 'x-real-ip' });
  check('wrong and missing secret -> the identical 404 Access denied', same(wrong, missing) && wrong.status === 404 && wrong.text === 'Access denied');
  check('about the same time (within 150 ms), both at least DENIED_DELAY_MS', Math.abs(wrong.ms - missing.ms) <= 150 && wrong.ms >= DELAY && missing.ms >= DELAY, `${Math.round(wrong.ms)} / ${Math.round(missing.ms)} ms, delay ${DELAY}`);
  check('nothing stored for them', files(vb.reportsDir).length === 1);
  await stop(ib.server);

  const LONG = keep(crypto.randomBytes(32).toString('hex'));
  for (const [label, ack] of [['missing', undefined], ['true', 'true'], ['1', '1']]) {
    const env = neEnv({ INGEST_SECRET: LONG }); if (ack === undefined) delete env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH; else env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH = ack;
    let threw = false; try { createIngestServer({ ...loadIngestConfig(env), ...vol('b-x') }); } catch { threw = true; }
    const r = runNode(['ingest/ingest.mjs'], { INGEST_ENABLED: '1', INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_SECRET: LONG, INGEST_PORT: '0', ...(ack === undefined ? {} : { INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: ack }) });
    check(`acknowledgment ${label}: createIngestServer throws`, threw);
    check(`acknowledgment ${label}: the real process exits 1 with a plain names-only reason`, r.status === 1 && plainReason(r.out) && /INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes/.test(r.out) && !r.out.includes(LONG), `exit ${r.status}`);
  }
  const S32 = keep(crypto.randomBytes(16).toString('hex'));
  let threw32 = false; try { createIngestServer({ ...loadIngestConfig(neEnv({ INGEST_SECRET: S32 })), ...vol('b-x') }); } catch { threw32 = true; }
  check(`a 32-char secret in no-edge mode: createIngestServer throws (needs ${MIN_SECRET_NO_EDGE}+)`, threw32 && MIN_SECRET_NO_EDGE === 48);
  const r32 = runNode(['ingest/ingest.mjs'], { INGEST_ENABLED: '1', INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: 'yes', INGEST_SECRET: S32, INGEST_PORT: '0' });
  check('a 32-char secret in no-edge mode: the real process exits 1, "shorter than 48", no value', r32.status === 1 && plainReason(r32.out) && /shorter than 48 characters/.test(r32.out) && !r32.out.includes(S32), `exit ${r32.status}`);
  let built32cf = true; try { createIngestServer({ ...loadIngestConfig(cfEnv({ INGEST_SECRET: S32 })), ...vol('b-x'), jwksFetch }); } catch { built32cf = false; }
  check('the same 32-char secret is still accepted with Cloudflare Access on (32 rule unchanged)', built32cf);

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
  const off = await checkIdle({});
  check('INGEST_ENABLED unset: the real process keeps running, says "switched off", answers 503 and shows as unhealthy on purpose', off.ok && off.still && off.health === 503 && /ingest is switched off/.test(off.out), off.why ?? `still ${off.still}, health ${off.health}`);

  console.log('  -- rate limits per caller behind a test reverse proxy (CLIENT_IP_HEADER=X-Real-IP, default limit 10 bad tries/min)');
  const proxied = async (name) => {
    const s = await bootIngest(neEnv(), vol(name), { deniedDelayMs: 20 });
    const p = makeProxy(Number(new URL(s.base).port));
    const base = `http://127.0.0.1:${await listen(p)}`;
    const bad = (client) => fetch(base + INGEST_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-' + crypto.randomBytes(4).toString('hex'), ...(client === undefined ? {} : { 'x-emulated-client': client }) }, body: '{}' }).then(async (r) => ({ status: r.status, text: await r.text() }));
    const flood = async (clientFn, n = 13) => { const out = []; for (let i = 0; i < n; i++) out.push((await bad(clientFn(i))).status); return out; };
    return { s, p, bad, flood, limit: s.cfg.rateBadPerMin };
  };
  {
    const t = await proxied('b-rate1');
    const codes = await t.flood(() => '198.51.100.10');
    check(`bad-secret flood from address A: first ${t.limit} get 404, then 429`, t.limit === 10 && codes.slice(0, 10).every((c) => c === 404) && codes.slice(10).every((c) => c === 429), codes.join(','));
    check('address B is still answered 404 (not limited)', (await t.bad('198.51.100.20')).status === 404);
    await stop(t.p); await stop(t.s.server);
  }
  {
    const t = await proxied('b-rate2');
    const codes = await t.flood((i) => `203.0.113.${i + 1}, 198.51.100.40`);
    check('several entries: the LAST one counts (changing first entries do not escape the limit)', codes.slice(10).every((c) => c === 429) && codes.slice(0, 10).every((c) => c === 404), codes.join(','));
    check('the same last entry alone is limited; a different last entry is not', (await t.bad('198.51.100.40')).status === 429 && (await t.bad('198.51.100.40, 198.51.100.41')).status === 404 && (await t.bad('198.51.100.1')).status === 404);
    await stop(t.p); await stop(t.s.server);
  }
  {
    const t = await proxied('b-rate3');
    const codes = await t.flood(() => undefined);
    check('missing header: falls back to the connection address and still limits (fail safe)', codes.slice(10).every((c) => c === 429) && codes.slice(0, 10).every((c) => c === 404), codes.join(','));
    check('garbage header then shares that fallback bucket (429); a real address is not limited (404)', (await t.bad('not-an-ip')).status === 429 && (await t.bad('198.51.100.50')).status === 404);
    await stop(t.p); await stop(t.s.server);
  }
  {
    const t = await proxied('b-rate4');
    const garbage = ['unknown', '1.2.3.4:8080', '999.1.1.1', '[2001:db8::1]', 'x'.repeat(80), '1.2.3', '198.51.100.1;x', 'garbage, more-garbage', '01.2.3.4', ' ', '::g', 'a b', 'z'];
    const codes = await t.flood((i) => garbage[i]);
    check('garbage headers (13 different values) fall back to the connection address and still limit', codes.slice(10).every((c) => c === 429) && codes.slice(0, 10).every((c) => c === 404), codes.join(','));
    await stop(t.p); await stop(t.s.server);
  }
  const logs = auditLogs.filter((f) => f.includes(`${path.sep}b`) && fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('');
  check('the audit log has denied and rate-limited entries but never an address', /"denied"/.test(logs) && /"rate-limited"/.test(logs) && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(logs) && !/::/.test(logs) && !/x-real-ip|unknown|not-an-ip/i.test(logs));
}

// =====================================================================================================================================
heading('C', 'VIEWER (links, headers, refusals, bad reports behind valid links, cleanup tool)');
{
  const vc = vol('c');
  const ic = await bootIngest(cfEnv(), vc, { ratePerHour: 1000 }), vw = await bootViewer(vc);
  const pushed = [];
  for (let i = 0; i < 3; i++) { const r = await push(ic.base, { secret: SECRET_CF, jwt: JWT }); pushed.push({ status: r.status, token: tokenOf(r.json.link), id: r.json.linkId }); }
  check('three synthetic reports pushed (201 each)', pushed.every((p) => p.status === 201 && p.token.length === 43));
  const [good, toExpire, toRevoke] = pushed;
  const rj = await vget(vw.base, `/api/r/${good.token}/report.json`);
  const body = await rj.json();
  const page = await vget(vw.base, `/r/${good.token}`); const html = await page.text();
  check('the link opens: report.json 200 (format webobs.client-report), page 200', rj.status === 200 && body.format === 'webobs.client-report' && body.client?.name === CLIENT_NAME && page.status === 200);
  check('the page carries the report address only, never the report text', html.includes('data-server-report') && !html.includes(CLIENT_NAME));
  for (const [label, r] of [['report.json', rj], ['page', page]]) {
    const h = (n) => r.headers.get(n) || '';
    check(`headers on ${label}: X-Robots-Tag noindex, Cache-Control no-store, Referrer-Policy no-referrer, X-Frame-Options DENY, CSP with connect-src 'self'`, /noindex/.test(h('x-robots-tag')) && /no-store/.test(h('cache-control')) && h('referrer-policy') === 'no-referrer' && h('x-frame-options') === 'DENY' && /(^|;)\s*connect-src 'self'(;|$)/.test(h('content-security-policy')));
  }
  const refuse = async (token) => { const a = await vget(vw.base, `/api/r/${token}/report.json`); const p = await vget(vw.base, `/r/${token}`); return { api: { status: a.status, text: await a.text(), type: a.headers.get('content-type') }, page: { status: p.status, text: await p.text(), type: p.headers.get('content-type') } }; };
  const baseline = await refuse(keep(newToken()));
  check('baseline refusal: unknown link -> 404 Access denied (api) and the 403 page with the one unavailable line', baseline.api.status === 404 && baseline.api.text === 'Access denied' && baseline.page.status === 403 && /This link is not available\. Please request a fresh one\./.test(baseline.page.text));
  const t = good.token, mid = 20;
  const changed = t.slice(0, mid) + (t[mid] === 'A' ? 'B' : 'A') + t.slice(mid + 1);
  const ch = await refuse(changed);
  check('a link with one letter changed -> the identical refusal', same(ch.api, baseline.api) && same(ch.page, baseline.page));
  const editEntry = (id, change) => { const f = path.join(vc.registryDir, id + '.json'); const e = JSON.parse(fs.readFileSync(f, 'utf8')); fs.writeFileSync(f, JSON.stringify({ ...e, ...change })); };
  editEntry(toExpire.id, { expiresAt: new Date(Date.now() - 60000).toISOString() });
  editEntry(toRevoke.id, { revoked: true });
  const ex = await refuse(toExpire.token), rv = await refuse(toRevoke.token);
  check('expired link (registry entry edited) -> the identical refusal', same(ex.api, baseline.api) && same(ex.page, baseline.page));
  check('revoked link (registry entry edited) -> the identical refusal', same(rv.api, baseline.api) && same(rv.page, baseline.page));
  // Bad reports placed straight in the folder (as a folder or ssh publish would), each behind a valid, unexpired link entry.
  const place = (name, rep) => {
    const fileId = crypto.randomBytes(16).toString('hex'), token = keep(newToken());
    fs.writeFileSync(path.join(vc.reportsDir, fileId + '.json'), typeof rep === 'string' ? rep : JSON.stringify(rep));
    fs.writeFileSync(path.join(vc.registryDir, name + '.json'), JSON.stringify({ id: name, tokenHash: hashToken(token), path: fileId + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false }));
    return token;
  };
  const big = { ...report, assets: { 'img:a': 'data:image/png;base64,' + 'A'.repeat(1200000), 'img:b': 'data:image/png;base64,' + 'A'.repeat(1200000) } };
  const bigText = JSON.stringify(big);
  const bigProblems = checkIncomingReport(big);
  check('sanity: the over-2MB report (~2.4 MB, under the 5 MB file cap) fails only the 2 MB contract size rule', bigText.length > 2 * 1024 * 1024 && bigText.length < 5 * 1024 * 1024 && bigProblems.length === 1 && /larger than the allowed size/.test(bigProblems[0]), `${bigText.length} chars`);
  const cases = {
    'over 2 MB': place('bigone0001', bigText),
    'not approved (draft)': place('draft00001', { ...report, meta: { review: { state: 'draft' } } }),
    'bad value (control character in client.name)': place('badval0001', { ...report, client: { name: 'Synthetic‮Client' } }),
    'bad value (feedback.to not an email)': place('badval0002', { ...report, feedback: { to: 'not an email' } }),
  };
  for (const [label, token] of Object.entries(cases)) { const r = await refuse(token); check(`${label} behind a valid link -> the identical refusal`, same(r.api, baseline.api) && same(r.page, baseline.page), `${r.api.status}/${r.page.status}`); }
  await stop(ic.server); await stop(vw.server);

  console.log('  -- the image\'s cleanup tool (node tools/cleanup.mjs, run from /app)');
  const vk = vol('c-clean');
  const ik = await bootIngest(cfEnv(), vk);
  const kp = [];
  for (let i = 0; i < 3; i++) { const r = await push(ik.base, { secret: SECRET_CF, jwt: JWT }); kp.push({ token: tokenOf(r.json.link), id: r.json.linkId }); }
  await stop(ik.server);
  const entryOf = (id) => JSON.parse(fs.readFileSync(path.join(vk.registryDir, id + '.json'), 'utf8'));
  const [kGood, kExp, kRev] = kp;
  const goodFile = entryOf(kGood.id).path, expFile = entryOf(kExp.id).path, revFile = entryOf(kRev.id).path;
  const edit = (id, change) => { const f = path.join(vk.registryDir, id + '.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...change })); };
  edit(kExp.id, { expiresAt: new Date(Date.now() - 60000).toISOString() });
  edit(kRev.id, { revoked: true });
  const orphanId = crypto.randomBytes(16).toString('hex'), orphan = path.join(vk.reportsDir, orphanId + '.json');
  fs.writeFileSync(orphan, JSON.stringify(report)); const old = new Date(Date.now() - 72 * 3600000); fs.utimesSync(orphan, old, old);
  const tmpId = crypto.randomBytes(5).toString('hex'), tmp = path.join(vk.registryDir, tmpId + '.json.tmp');
  fs.writeFileSync(tmp, '{}'); const hourAgo = new Date(Date.now() - 2 * 3600000); fs.utimesSync(tmp, hourAgo, hourAgo);
  const snap = () => [...files(vk.reportsDir).map((n) => 'reports/' + n), ...files(vk.registryDir).map((n) => 'registry/' + n)].sort().join(',');
  const before = snap();
  const dry = runNode(['tools/cleanup.mjs', '--reports', vk.reportsDir, '--registry', vk.registryDir, '--dry-run'], {});
  const dl = dry.stdout;
  check('dry run lists the expired, revoked, orphan and .json.tmp items', dry.status === 0 && dl.includes(`would remove link ${kExp.id} (expired)`) && dl.includes(`would remove link ${kRev.id} (revoked)`) && dl.includes(`would remove unreferenced report file ${orphanId}.json`) && dl.includes(`would remove an interrupted upload leftover (${tmpId})`) && /Dry run: 1 expired, 1 revoked, 0 with a missing file, 1 unreferenced file\(s\) would be removed; 1 link\(s\) kept\./.test(dl), `exit ${dry.status}`);
  check('dry run removes nothing', snap() === before);
  const real = runNode(['tools/cleanup.mjs', '--reports', vk.reportsDir, '--registry', vk.registryDir], {});
  const want = ['registry/' + kGood.id + '.json', 'reports/' + goodFile].sort().join(',');
  check('real run removes exactly those and keeps the valid link (its entry and its report)', real.status === 0 && /^1 expired, 1 revoked, 0 with a missing file, 1 unreferenced file\(s\) removed; 1 link\(s\) kept\./m.test(real.stdout) && snap() === want, `left: ${snap().split(',').length} file(s); expired/revoked files gone: ${![expFile, revFile].some((f) => fs.existsSync(path.join(vk.reportsDir, f)))}`);
  const vk2 = await bootViewer(vk);
  const still = await vget(vk2.base, `/api/r/${kGood.token}/report.json`);
  check('the kept link still opens after the cleanup', still.status === 200);
  const hashes = kp.map((p) => hashToken(p.token));
  check('the cleanup output holds ids only (no token, no token hash)', !kp.some((p) => (dry.out + real.out).includes(p.token)) && !hashes.some((h) => (dry.out + real.out).includes(h)));
  await stop(vk2.server);
}

// =====================================================================================================================================
heading('D', 'EXPORTER OUTPUT (the plugin exporter\'s files from the synthetic demo site, pushed in both modes)');
{
  for (const mode of ['cloudflare', 'no-cloudflare']) {
    const v = vol('d-' + mode);
    const ing = await bootIngest(mode === 'cloudflare' ? cfEnv() : neEnv(), v), vw = await bootViewer(v);
    for (const name of ['exported-demo.json', 'exported-demo-with-feedback.json']) {
      const file = path.join(FIXTURES, name);
      if (!fs.existsSync(file)) { check(`${mode}: ${name} is mounted at ${FIXTURES}`, false); continue; }
      const text = fs.readFileSync(file, 'utf8'); const fx = JSON.parse(text);
      const r = mode === 'cloudflare' ? await push(ing.base, { secret: SECRET_CF, jwt: JWT, body: text }) : await push(ing.base, { secret: SECRET_NE, ipHeader: 'x-real-ip', body: text });
      const tok = tokenOf(r.json.link);
      check(`${mode}: ${name} -> 201 and a link`, r.status === 201 && tok.length === 43, `status ${r.status} ${r.status === 201 ? '' : r.text.slice(0, 160)}`);
      const s = await vget(vw.base, `/api/r/${tok}/report.json`);
      const served = await s.json().catch(() => ({}));
      const expect = structuredClone(fx); if (expect.feedback) delete expect.feedback.to;
      check(`${mode}: ${name} served by the viewer (200, webobs.client-report, same content${fx.feedback ? ', feedback.to kept on the server' : ''})`, s.status === 200 && served.format === 'webobs.client-report' && JSON.stringify(served) === JSON.stringify(expect) && !(served.feedback && 'to' in served.feedback));
    }
    await stop(ing.server); await stop(vw.server);
  }
}

// =====================================================================================================================================
heading('F', 'HEALTH (the exact healthcheck commands from deploy/VPS-STACK-tunnel-both-bindmount.yml)');
{
  const yml = path.join(DEPLOY, 'VPS-STACK-tunnel-both-bindmount.yml');
  const text = fs.existsSync(yml) ? fs.readFileSync(yml, 'utf8') : '';
  const tests = text.split(/\r?\n/).map((l) => /^\s*test:\s*(\[.*\])\s*$/.exec(l)).filter(Boolean).map((m) => JSON.parse(m[1]));
  check('the stack file is mounted and has two healthcheck.test arrays of the form ["CMD","node","-e",<code>]', tests.length === 2 && tests.every((t) => t.length === 4 && t[0] === 'CMD' && t[1] === 'node' && t[2] === '-e'), `${tests.length} found`);
  const codes = tests.map((t) => t[3]);
  check('one probes 127.0.0.1:8080/healthz (report), the other 127.0.0.1:8081/healthz (ingest)', codes.some((c) => c.includes('http://127.0.0.1:8080/healthz')) && codes.some((c) => c.includes('http://127.0.0.1:8081/healthz')));
  const vf = vol('f');
  const vw = await bootViewer(vf, { port: 8080 });
  const ing = await bootIngest(cfEnv(), vf, { port: 8081 });
  const up = []; for (const c of codes) up.push(await runAsync(['-e', c]));
  check('with the viewer on 8080 and the ingest on 8081 both healthchecks exit 0 (healthy)', up.length === 2 && up.every((c) => c === 0), up.join(','));
  await stop(vw.server); await stop(ing.server);
  const down = []; for (const c of codes) down.push(await runAsync(['-e', c]));
  check('with the servers closed both healthchecks exit 1', down.length === 2 && down.every((c) => c === 1), down.join(','));
}

// =====================================================================================================================================
heading('C', 'VIEWER, continued: the audit logs and everything printed during the whole run');
{
  const ALLOWED = new Set(['at', 'event', 'reason', 'linkId', 'fileId', 'bytes', 'hours']);
  const lines = auditLogs.filter((f) => fs.existsSync(f)).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
  let parsedOk = true; const keys = new Set();
  for (const l of lines) { try { for (const k of Object.keys(JSON.parse(l))) keys.add(k); } catch { parsedOk = false; } }
  check(`the audit logs (${lines.length} lines) hold only ids, times and events`, lines.length > 20 && parsedOk && [...keys].every((k) => ALLOWED.has(k)), [...keys].sort().join(','));
  const all = lines.join('\n');
  const fxNames = ['exported-demo.json', 'exported-demo-with-feedback.json'].map((n) => path.join(FIXTURES, n)).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).client?.name).filter(Boolean);
  const leaks = [...SECRETS].filter((s) => all.includes(s)).length;
  check('the audit logs hold no token, secret, JWT, address, client name or report text', leaks === 0 && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(all) && !all.includes(CLIENT_NAME) && !all.includes(REPORT_TEXT) && !fxNames.some((n) => all.includes(n)), `${SECRETS.size} values checked`);
  const outLeaks = [...SECRETS].filter((s) => s && captured.includes(s)).length;
  check(`stdout/stderr of this run (servers, spawned processes, checks) holds none of the ${SECRETS.size} secrets, tokens or JWTs`, SECRETS.size > 20 && outLeaks === 0, `${captured.length} characters scanned`);
}

http.globalAgent.destroy();
for (const s of servers) { try { s.closeAllConnections(); s.close(); } catch { /* already closed */ } }
console.log('\nper section: ' + Object.entries(counts).map(([k, v]) => `${k} ${v.ok}/${v.all}`).join(', '));
console.log(failed ? `\n${failed} check(s) FAILED, ${passed} passed` : `\nall ${passed} full-system container checks passed`);
process.exit(failed ? 1 : 0);

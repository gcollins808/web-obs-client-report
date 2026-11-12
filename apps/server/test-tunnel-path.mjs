// The one-hostname, two-container path, end to end in one process. Synthetic data only; foreground; nothing left running.
//   node apps/server/test-tunnel-path.mjs
//
// It starts the viewer (createServer) and the ingest (createIngestServer) on random 127.0.0.1 ports with a shared temporary data folder,
// plus a tiny reverse proxy that behaves like cloudflared with two public-hostname routes on the same hostname:
//   1. path ingest/*  -> the ingest       (must be listed ABOVE the catch-all)
//   2. everything else -> the viewer
// Like cloudflared it forwards the FULL original path (it does not strip the matched prefix) and adds X-Forwarded-Proto: https and
// CF-Connecting-IP. On the ingest route it also adds the Cf-Access-Jwt-Assertion header, as Cloudflare Access does after it has
// accepted the service token (the ingest verifies it; here a stub verifier stands in for the signature check, which test-hardening covers).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from './server.mjs';
import { createIngestServer, INGEST_ROUTE } from './ingest/ingest.mjs';

let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-tunnel-'));
const reportsDir = path.join(dir, 'reports'), registryDir = path.join(dir, 'registry'), auditLog = path.join(dir, 'audit', 'ingest.log');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
fs.writeFileSync(path.join(dir, 'app.html'), '<!doctype html><html><body>viewer</body></html>');
const SECRET = 'tunnel-path-test-secret-' + 'y'.repeat(24);
const PUBLIC = 'https://audit.example.test';
const ACCESS_JWT = 'stub-access-assertion';
const report = JSON.parse(fs.readFileSync(new URL('../../fixtures/client-report.sample.json', import.meta.url), 'utf8'));
const countFiles = () => fs.readdirSync(reportsDir).length + fs.readdirSync(registryDir).length;

const viewer = createServer({ reportsDir, registryDir, appFile: path.join(dir, 'app.html'), outboxDir: path.join(dir, 'outbox'), trustProxy: true, deniedDelayMs: 0, rateGeneral: 10000, rateBadToken: 10000 });
const ingest = createIngestServer({
  enabled: true, secret: SECRET, reportsDir, registryDir, auditLog, publicBase: PUBLIC, trustProxy: true, deniedDelayMs: 0,
  ratePerHour: 1000, rateBadPerMin: 1000, requireAccessHeader: true, verifyAccess: async (t) => t === ACCESS_JWT,
});
const hits = { viewer: [], ingest: [] };
viewer.server.on('request', (req) => hits.viewer.push(req.url));
ingest.server.on('request', (req) => hits.ingest.push(req.url));
const viewerPort = await listenFetchable(viewer.server);
const ingestPort = await listenFetchable(ingest.server);

/** A cloudflared stand-in: ordered routes, the first match wins, the full path is forwarded unchanged. */
function makeTunnel(routes) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://x').pathname;
    const route = routes.find((r) => r.match(pathname));
    const headers = { ...req.headers, host: 'audit.example.test', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.77' };
    delete headers['cf-access-jwt-assertion']; // only the edge sets it
    if (route.access) headers['cf-access-jwt-assertion'] = ACCESS_JWT;
    const up = http.request({ host: '127.0.0.1', port: route.port, method: req.method, path: req.url, headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
    req.pipe(up);
  });
}
const ingestRoute = { name: 'ingest/*', match: (p) => p.startsWith('/ingest/'), port: ingestPort, access: true };
const catchAll = { name: 'catch-all', match: () => true, port: viewerPort, access: false };

const servers = [viewer.server, ingest.server];
try {
  console.log('right order: ingest/* above the catch-all');
  const tunnel = makeTunnel([ingestRoute, catchAll]); servers.push(tunnel);
  const base = `http://127.0.0.1:${await listenFetchable(tunnel)}`;
  const push = (b = base, h = {}) => fetch(b + INGEST_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SECRET, ...h }, body: JSON.stringify(report) });

  check('the plugin route constant is the ingest\'s accepted route', INGEST_ROUTE === '/ingest/v1/reports');
  const doc = fs.readFileSync(new URL('../../docs/INGEST-SECURITY.md', import.meta.url), 'utf8');
  check('docs/INGEST-SECURITY.md names the same route (the plugin appends exactly it to the base address)', doc.includes('POST ' + INGEST_ROUTE));

  hits.ingest.length = 0; hits.viewer.length = 0;
  const r = await push();
  const body = await r.json().catch(() => ({}));
  check('a push through the tunnel with the secret gets 201 and a link', r.status === 201 && typeof body.link === 'string' && body.link.startsWith(PUBLIC + '/r/'), `status ${r.status}`);
  check('the ingest saw the FULL path (no prefix stripped)', hits.ingest.some((u) => u.startsWith(INGEST_ROUTE)) && hits.viewer.length === 0, hits.ingest.join(' '));
  const token = String(body.link || '').split('/r/')[1] || '';
  const served = await fetch(`${base}/api/r/${token}/report.json`);
  check('the returned link\'s report opens through the tunnel (200, from the viewer)', served.status === 200 && (await served.json()).format === 'webobs.client-report' && hits.viewer.length === 1);
  const page = await fetch(`${base}/r/${token}`);
  check('the returned link\'s page opens through the tunnel (200)', page.status === 200);

  hits.ingest.length = 0; hits.viewer.length = 0;
  const root = await fetch(base + '/'), bad = await fetch(base + '/r/bad');
  check('viewer paths (/ and /r/bad) are answered by the viewer with the one unavailable line', root.status === 403 && bad.status === 403 && /This link is not available/.test(await root.text()) && /This link is not available/.test(await bad.text()));
  check('viewer paths never reach the ingest', hits.ingest.length === 0 && hits.viewer.length === 2, `ingest saw ${hits.ingest.length}`);

  const hz = await fetch(base + '/ingest/healthz');
  check('/ingest/healthz through the tunnel reaches the ingest and answers ok', hz.status === 200 && (await hz.text()) === 'ok' && hits.ingest.includes('/ingest/healthz'));
  const vh = await fetch(base + '/healthz');
  check('/healthz through the tunnel is the viewer\'s own', vh.status === 200 && hits.viewer.includes('/healthz'));

  const noSecret = await push(base, { authorization: '' });
  check('a push without the secret is refused (404 Access denied)', noSecret.status === 404 && (await noSecret.text()) === 'Access denied');

  console.log('wrong order: the catch-all listed first');
  const wrong = makeTunnel([catchAll, ingestRoute]); servers.push(wrong);
  const wbase = `http://127.0.0.1:${await listenFetchable(wrong)}`;
  hits.ingest.length = 0;
  const before = countFiles();
  const w = await push(wbase);
  const wtext = await w.text();
  check('the push gets the viewer\'s plain refusal (403/404), no link', [403, 404].includes(w.status) && /This link is not available/.test(wtext) && !wtext.includes('/r/'), `status ${w.status}`);
  check('nothing is stored and the ingest is never reached', countFiles() === before && hits.ingest.length === 0);
  const whz = await fetch(wbase + '/ingest/healthz');
  check('/ingest/healthz in the wrong order is also refused by the viewer (a quick way to spot it)', [403, 404].includes(whz.status) && /This link is not available/.test(await whz.text()));
} finally {
  // Close everything gently (keep-alive sockets of the proxy agent and of fetch included) and let the process end by itself:
  // a hard process.exit while sockets are still closing can trip a libuv assertion on Windows.
  http.globalAgent.destroy();
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} tunnel path check(s) FAILED, ${passed} passed` : `\nall ${passed} tunnel path checks passed`);
process.exitCode = failed ? 1 : 0;

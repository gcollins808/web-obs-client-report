// Tests for the ingest hardening (independent review findings 2, 4, 5, 6). Synthetic data only. Foreground; nothing is left running.
//   node apps/server/ingest/test-hardening.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createIngestServer } from './ingest.mjs';
import { verifyAccessJwt } from './access-jwt.mjs';
import { cleanup } from '../tools/cleanup.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const SECRET = 'ingest-test-secret-' + 'x'.repeat(30);
const TEAM = 'team-example.cloudflareaccess.com', AUD = 'a'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-ingest-hard-'));
const fresh = () => { const d = fs.mkdtempSync(path.join(dir, 'v-')); return { reportsDir: path.join(d, 'reports'), registryDir: path.join(d, 'registry'), auditLog: path.join(d, 'audit', 'ingest.log') }; };
const report = fs.readFileSync(new URL('../../../fixtures/client-report.sample.json', import.meta.url), 'utf8');
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// ---- a test keypair and a fake JWKS (no network) ----
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
const sign = (claims, { key = pair.privateKey, kid = 'test-key-1', alg = 'RS256' } = {}) => {
  const head = b64({ alg, kid, typ: 'JWT' }), body = b64(claims), data = `${head}.${body}`;
  return alg === 'none' ? `${data}.` : `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
};
const nowS = Math.floor(Date.now() / 1000);
const good = { iss: `https://${TEAM}`, aud: [AUD], exp: nowS + 600, iat: nowS, nbf: nowS - 5 };
let jwksCalls = 0, jwksUp = true;
const jwksFetch = async (url) => { jwksCalls++; if (!jwksUp) throw new Error('down'); if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return { ok: false }; return { ok: true, json: async () => ({ keys: [jwk] }) }; };

const boot = async (over = {}) => {
  const v = fresh();
  const { server, cfg } = createIngestServer({ enabled: true, secret: SECRET, ...v, publicBase: 'https://audit.example.test', trustProxy: true, deniedDelayMs: 0, ratePerHour: 1000, rateBadPerMin: 1000, requireAccessHeader: true, accessTeamDomain: TEAM, accessAudience: AUD, jwksFetch, ...over });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (headers = {}) => fetch(`${base}/ingest/v1/reports`, { method: 'POST', headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5', authorization: 'Bearer ' + SECRET, 'content-type': 'application/json', ...headers }, body: report });
  return { cfg, v, post, close: () => new Promise((r) => server.close(r)) };
};

console.log('finding 2: the Cloudflare Access token is verified, not just looked for');
{
  const s = await boot();
  const cases = {
    'no token': {},
    'text that is not a token': { 'cf-access-jwt-assertion': 'edge-token-present' },
    'signed by a different key': { 'cf-access-jwt-assertion': sign(good, { key: other.privateKey }) },
    'alg none': { 'cf-access-jwt-assertion': sign(good, { alg: 'none' }) },
    'expired': { 'cf-access-jwt-assertion': sign({ ...good, exp: nowS - 5 }) },
    'not yet valid': { 'cf-access-jwt-assertion': sign({ ...good, nbf: nowS + 3600 }) },
    'wrong audience': { 'cf-access-jwt-assertion': sign({ ...good, aud: ['b'.repeat(64)] }) },
    'wrong issuer': { 'cf-access-jwt-assertion': sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }) },
    'unknown key id': { 'cf-access-jwt-assertion': sign(good, { kid: 'nope' }) },
  };
  const codes = {}; for (const [name, h] of Object.entries(cases)) codes[name] = (await s.post(h)).status;
  check('every bad or missing token gets the same plain 404', Object.values(codes).every((c) => c === 404), JSON.stringify(codes));
  check('nothing was stored for them', !fs.existsSync(s.v.reportsDir) || fs.readdirSync(s.v.reportsDir).length === 0);
  const ok = await s.post({ 'cf-access-jwt-assertion': sign(good) });
  check('a valid token (right key, issuer, audience, unexpired) with the right secret is accepted', ok.status === 201);
  check('a valid token with a wrong secret is still refused', (await s.post({ 'cf-access-jwt-assertion': sign(good), authorization: 'Bearer wrong' })).status === 404);
  const before = jwksCalls; await s.post({ 'cf-access-jwt-assertion': sign(good) });
  check('the public keys are cached, not fetched for every request', jwksCalls === before);
  jwksUp = false; const s2 = await boot();
  check('if the key list cannot be fetched, the token is not valid (no fail-open)', (await s2.post({ 'cf-access-jwt-assertion': sign(good) })).status === 404);
  const callsBefore = jwksCalls; for (let i = 0; i < 6; i++) await s2.post({ 'cf-access-jwt-assertion': sign(good) });
  check('while the key list is unreachable it is tried at most once a minute, not on every request, and every token stays invalid', jwksCalls - callsBefore === 0 && (await s2.post({ 'cf-access-jwt-assertion': sign(good) })).status === 404, `${jwksCalls - callsBefore} extra fetches`);
  jwksUp = true; await s.close(); await s2.close();
  check('the verifier never throws on garbage', (await Promise.all([null, 5, '', 'a.b', 'a.b.c', '....', 'x'.repeat(20000)].map((t) => verifyAccessJwt(t, { teamDomain: TEAM, audience: AUD, getKey: async () => jwk })))).every((r) => r === false));
}

console.log('finding 6: the server enforces its own start rules');
{
  const v = fresh();
  const throws = (o) => { try { createIngestServer({ ...v, ...o }); return false; } catch { return true; } };
  check('it cannot be built switched off', throws({ enabled: false, secret: SECRET }));
  check('it cannot be built with a short secret', throws({ enabled: true, secret: 'short' }) && throws({ enabled: true, secret: '' }));
  check('it cannot be built asking for the Access check without a team domain and audience', throws({ enabled: true, secret: SECRET, requireAccessHeader: true, accessTeamDomain: '', accessAudience: '' }));
  check('it can be built when all three are right', !throws({ enabled: true, secret: SECRET, requireAccessHeader: false, acknowledgeNoEdgeAuth: true }));
}

console.log('finding 6: a failed upload leaves nothing behind');
{
  const s = await boot({ requireAccessHeader: false, acknowledgeNoEdgeAuth: true });
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).startsWith(s.v.registryDir)) throw new Error('simulated'); return realRename(from, to); };
  let r; try { r = await s.post(); } finally { fs.renameSync = realRename; }
  check('the answer is a plain 500', r.status === 500);
  check('no report file is left in the reports folder', fs.readdirSync(s.v.reportsDir).length === 0);
  check('no .tmp or link entry is left in the registry folder', fs.readdirSync(s.v.registryDir).length === 0);
  await s.close();
}

console.log('finding 4: the rate-limit answer waits like every other refusal');
{
  const s = await boot({ requireAccessHeader: false, acknowledgeNoEdgeAuth: true, deniedDelayMs: 120, rateBadPerMin: 1 });
  const t = async () => { const t0 = Date.now(); const r = await s.post({ authorization: 'Bearer wrong' }); return [r.status, Date.now() - t0]; };
  const a = await t(), b = await t();
  check('a refusal (404) and the rate-limited answer (429) both leave after the fixed time', a[0] === 404 && b[0] === 429 && a[1] >= 105 && b[1] >= 105, `${a} ${b}`);
  await s.close();
}

console.log('finding 5: only the configured client-IP header (default CF-Connecting-IP) names the caller');
{
  const s = await boot({ requireAccessHeader: false, acknowledgeNoEdgeAuth: true, rateBadPerMin: 2 });
  const viaXff = []; for (let i = 0; i < 4; i++) viaXff.push((await s.post({ authorization: 'Bearer wrong', 'cf-connecting-ip': '', 'x-forwarded-for': `198.51.100.${i}` })).status);
  check('rotating X-Forwarded-For does not avoid the limit', viaXff.includes(429), viaXff.join(','));
  await s.close();
}

console.log('finding 6: cleanup removes old interrupted-upload leftovers');
{
  const v = fresh(); fs.mkdirSync(v.reportsDir, { recursive: true }); fs.mkdirSync(v.registryDir, { recursive: true });
  const oldTmp = path.join(v.registryDir, 'aaaaaaaaaa.json.tmp'), newTmp = path.join(v.registryDir, 'bbbbbbbbbb.json.tmp');
  fs.writeFileSync(oldTmp, '{}'); fs.writeFileSync(newTmp, '{}');
  const old = new Date(Date.now() - 5 * 3600000); fs.utimesSync(oldTmp, old, old);
  const dry = cleanup({ reportsDir: v.reportsDir, registryDir: v.registryDir, dry: true });
  check('a dry run reports it and removes nothing', dry.tmp === 1 && fs.existsSync(oldTmp));
  const r = cleanup({ reportsDir: v.reportsDir, registryDir: v.registryDir });
  check('an old .json.tmp is removed', r.tmp === 1 && !fs.existsSync(oldTmp));
  check('a recent one (a live upload) is left alone', fs.existsSync(newTmp));
}

console.log('the image carries every file the ingest imports');
{
  const df = fs.readFileSync(new URL('../../../deploy/Dockerfile', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('./ingest.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '[.][/]([\w-]+[.]mjs)'/g)].map((x) => x[1]);
  const copied = df.split(/\r?\n/).filter((l) => l.startsWith('COPY apps/server/ingest/')).join(' ');
  check('every ./file imported by ingest.mjs is copied into the image', imports.length >= 2 && imports.every((f) => copied.includes(f)), imports.join(','));
  // ../ imports (tokens.mjs, clientip.mjs) land next to server.mjs in /app, one level above /app/ingest/.
  const parentImports = [...src.matchAll(/from '[.][.][/]([\w-]+[.]mjs)'/g)].map((x) => x[1]);
  const copiedTop = df.split(/\r?\n/).filter((l) => /^COPY apps\/server\/[\w-]+[.]mjs .*[.][/]$/.test(l)).join(' ');
  check('every ../file imported by ingest.mjs is copied into the image beside server.mjs (clientip.mjs included)', parentImports.includes('clientip.mjs') && parentImports.includes('tokens.mjs') && parentImports.every((f) => copiedTop.split(' ').includes('apps/server/' + f)), parentImports.join(','));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} ingest hardening check(s) FAILED` : '\nall ingest hardening checks passed');
process.exit(failed ? 1 : 0);

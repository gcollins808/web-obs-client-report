// HTTPS ingest: lets the agency's tools PUSH an approved client report to the server, instead of dropping files on a volume.
// Optional and OFF by default (INGEST_ENABLED=1 turns it on). To remove the feature, delete this folder (see docs/FEATURES.md).
//
// It is a SEPARATE process from the public viewer (apps/server/server.mjs). The viewer only reads its volumes (mounted read-only);
// this process is the only one with write access, listens on its own port, and is reached through its own tunnel route (path ingest/* on the viewer's hostname).
//
//   POST /ingest/v1/reports[?hours=72]      body: the client report JSON (webobs.client-report)
//        header:  Authorization: Bearer <INGEST_SECRET>
//        reply:   201 {"ok":true,"linkId","expiresAt","link"}   the link is shown ONCE; only its hash is stored
//   GET  /healthz  and  /ingest/healthz     "ok"   (the second one is reachable through the tunnel's ingest/* route)
//
// Two locks (the default, INGEST_REQUIRE_ACCESS_HEADER unset or 1): (1) at the edge, a Cloudflare Access policy with a service token;
// this process then also VERIFIES the Access token Cloudflare adds (signature against your team's public keys, issuer, audience,
// expiry), so a request that reaches it some other way is refused; (2) an application secret compared in constant time. Anything
// else, for any reason, gets the same plain "Access denied" (404), sent at the same fixed time after the request arrived (a
// rate-limit answer included).
//
// Without Cloudflare (NOT recommended): INGEST_REQUIRE_ACCESS_HEADER=0 together with INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes and a secret
// of at least 48 characters. Lock (1) is then gone: only the secret, the size cap and the in-app rate limits remain. Without the
// acknowledgment, or with a shorter secret, the process refuses to start. See docs/SETUP.md, "Running the ingest without Cloudflare".
//
// The SERVER chooses the random 32-hex file id and the link token, stores only the token's hash with the expiry, never overwrites,
// writes the report first and the link entry last, and keeps an audit log of ids and times only (never content, tokens or addresses).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newToken, hashToken } from '../tokens.mjs';
import { checkIncomingReport } from './contract-check.mjs';
import { splitEnvelope } from './envelope.mjs';
import { stylesHash } from '../../viewer/brand/styles-hash.mjs';
import { makeJwksSource, verifyAccessJwt } from './access-jwt.mjs';
import { clientAddress, clientIpHeaderName } from '../clientip.mjs';

const DAY_MS = 86400000;
const ACCESS_DENIED = 'Access denied';
/** The one upload route. The plugin appends exactly this to the base address (see docs/INGEST-SECURITY.md). */
export const INGEST_ROUTE = '/ingest/v1/reports';
/** Revokes a link made by this ingest (the id is the 10 hex characters in its registry file name). Same locks as an upload. */
export const REVOKE_ROUTE = /^[/]ingest[/]v1[/]links[/]([a-f0-9]{10})[/]revoke$/;
/** Health checks: the plain one for the container probe, and one under /ingest/ so a probe through the tunnel route works too. */
export const HEALTH_PATHS = ['/healthz', '/ingest/healthz'];
/** Shortest secret accepted with the Cloudflare Access check on, and without it (the secret is then the only lock). */
export const MIN_SECRET = 32;
export const MIN_SECRET_NO_EDGE = 48;
export const NO_EDGE_WARNING = 'WARNING: ingest running WITHOUT Cloudflare Access: protected only by the app secret, size cap and in-app rate limits';
const minSecretFor = (cfg) => (cfg.requireAccessHeader ? MIN_SECRET : MIN_SECRET_NO_EDGE);

export function loadIngestConfig(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  return {
    enabled: env.INGEST_ENABLED === '1',
    port: n(env.INGEST_PORT, 8081),
    secret: env.INGEST_SECRET || '',
    // On unless exactly 0: the Cloudflare Access check is the default. Turning it off also needs the acknowledgment below.
    requireAccessHeader: env.INGEST_REQUIRE_ACCESS_HEADER !== '0',
    // Only the exact word yes counts (not 1, not true): running without Cloudflare Access is a deliberate, written-down choice.
    acknowledgeNoEdgeAuth: env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH === 'yes',
    accessTeamDomain: (env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:[/][/]/, '').replace(/[/]+$/, ''),
    accessAudience: (env.CF_ACCESS_AUD || '').trim(),
    reportsDir: path.resolve(env.INGEST_REPORTS_DIR || '/data/reports'),
    registryDir: path.resolve(env.INGEST_REGISTRY_DIR || '/data/registry'),
    auditLog: path.resolve(env.INGEST_AUDIT_LOG || '/data/audit/ingest.log'),
    // The audit log is capped: when it reaches this size it is renamed to .1 (older ones shift up) and a new one starts; at most this many old files stay.
    auditMaxBytes: Math.max(1024, n(env.INGEST_AUDIT_MAX_BYTES, 1048576)),
    auditKeep: Math.max(1, Math.min(20, n(env.INGEST_AUDIT_KEEP, 3))),
    defaultHours: n(env.INGEST_DEFAULT_HOURS, 72),
    maxHours: n(env.INGEST_MAX_HOURS, 720),
    maxBytes: n(env.INGEST_MAX_BYTES, 2 * 1024 * 1024),
    maxReports: n(env.INGEST_MAX_REPORTS, 1000),
    ratePerHour: n(env.INGEST_RATE_PER_HOUR, 30),
    rateBadPerMin: n(env.INGEST_BAD_PER_MIN, 10),
    publicBase: (env.WEBOBS_REPORT_BASE || '').trim().replace(/[/]+$/, ''),
    requireHttps: env.REQUIRE_HTTPS !== '0',
    trustProxy: env.TRUST_PROXY === '1',
    // With TRUST_PROXY=1: the one header that names the caller (rate limits only). Empty: CF-Connecting-IP. See ../clientip.mjs.
    clientIpHeader: clientIpHeaderName(env.CLIENT_IP_HEADER),
    deniedDelayMs: n(env.DENIED_DELAY_MS, 250),
    now: () => Date.now(),
  };
}

/** Reasons the ingest must not start although it is switched on. Names only: no value is ever printed. */
export function startupProblems(cfg) {
  const out = [];
  const min = minSecretFor(cfg);
  if (typeof cfg.secret !== 'string' || cfg.secret.length < min) out.push(`INGEST_SECRET is missing or shorter than ${min} characters${cfg.requireAccessHeader ? '' : ' (48 are required when INGEST_REQUIRE_ACCESS_HEADER=0)'}.`);
  if (cfg.requireAccessHeader && (!cfg.accessTeamDomain || !cfg.accessAudience)) out.push('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set while the Access check is on (INGEST_REQUIRE_ACCESS_HEADER unset or 1).');
  if (!cfg.requireAccessHeader && cfg.acknowledgeNoEdgeAuth !== true) out.push('INGEST_REQUIRE_ACCESS_HEADER=0 (no Cloudflare Access) also needs INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes. Not recommended: see docs/SETUP.md.');
  return out;
}

/** Plain-words start-up lines. Names only: no value is ever printed. */
export function describeIngestSetup(cfg) {
  const out = [];
  if (!cfg.enabled) { out.push('INGEST_ENABLED is not 1: the ingest route is switched off; this process idles (503 on its port) instead of exiting.'); return out; }
  if (cfg.secret.length < minSecretFor(cfg)) out.push(`INGEST_SECRET is missing or shorter than ${minSecretFor(cfg)} characters: the ingest route will not start. Make one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  if (!cfg.publicBase) out.push('WEBOBS_REPORT_BASE missing: the reply cannot include a link. It is the public address of the viewer (https://...).');
  else if (!/^https:[/][/]/.test(cfg.publicBase)) out.push('WEBOBS_REPORT_BASE should start with https://.');
  if (cfg.requireHttps && !cfg.trustProxy) out.push('TRUST_PROXY is not 1 while HTTPS is required: every request is refused unless TLS is terminated in front and TRUST_PROXY=1 is set.');
  if (!cfg.requireAccessHeader) {
    out.push('INGEST_REQUIRE_ACCESS_HEADER=0: no Cloudflare Access token is verified (not recommended). The secret (48+ characters), the size cap and the in-app rate limits are the only protection.');
    if (cfg.acknowledgeNoEdgeAuth !== true) out.push('INGEST_ACKNOWLEDGE_NO_EDGE_AUTH is not yes: the ingest route will not start without Cloudflare Access.');
    if (cfg.trustProxy && cfg.clientIpHeader === 'cf-connecting-ip') out.push('CLIENT_IP_HEADER is CF-Connecting-IP while running without Cloudflare: set it to the header your reverse proxy sets (for example X-Real-IP), or all callers share one rate-limit bucket.');
  } else if (!cfg.accessTeamDomain || !cfg.accessAudience) out.push('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set while the Access check is on (INGEST_REQUIRE_ACCESS_HEADER unset or 1): the ingest route will not start.');
  if (!fs.existsSync(cfg.reportsDir)) out.push('INGEST_REPORTS_DIR folder not found (it needs a read-write mount).');
  if (!fs.existsSync(cfg.registryDir)) out.push('INGEST_REGISTRY_DIR folder not found (it needs a read-write mount).');
  return out;
}

function limiter() {
  const hits = new Map();
  return (key, limit, windowMs, now) => {
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return true;
  };
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** Constant-time comparison of two secrets of any length (both are hashed first). */
export const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function send(res, code, body, type = 'text/plain; charset=utf-8') { res.statusCode = code; res.setHeader('Content-Type', type); res.end(body); }

export function createIngestServer(overrides = {}) {
  const cfg = { ...loadIngestConfig(), ...overrides };
  // Enforced here, not only in the start-up code: a server cannot be built switched off, with a short secret, or with the Access check
  // asked for but not configured.
  if (!cfg.enabled) throw new Error('The ingest route is switched off (INGEST_ENABLED is not 1).');
  if (!cfg.requireAccessHeader && cfg.acknowledgeNoEdgeAuth !== true) throw new Error('INGEST_REQUIRE_ACCESS_HEADER=0 (no Cloudflare Access) needs INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes.');
  if (typeof cfg.secret !== 'string' || cfg.secret.length < minSecretFor(cfg)) throw new Error(`INGEST_SECRET must be at least ${minSecretFor(cfg)} characters.`);
  if (cfg.requireAccessHeader && !cfg.verifyAccess && (!cfg.accessTeamDomain || !cfg.accessAudience)) throw new Error('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required when the Access check is on.');
  const verifyAccess = cfg.verifyAccess || ((token) => verifyAccessJwt(token, { teamDomain: cfg.accessTeamDomain, audience: cfg.accessAudience, getKey: getKey(), now: cfg.now }));
  let keySource = null; function getKey() { keySource ||= makeJwksSource({ teamDomain: cfg.accessTeamDomain, fetchImpl: cfg.jwksFetch || fetch, now: cfg.now }); return keySource; }
  const allow = limiter();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** ids and times only. A failure to log never blocks or reveals anything. */
  /** Size-based rotation, so traffic from the internet can never fill the volume through log lines: at most (keep + 1) files of about auditMaxBytes each. */
  const rotateAudit = () => {
    try {
      if (fs.statSync(cfg.auditLog).size < cfg.auditMaxBytes) return;
      for (let i = cfg.auditKeep; i >= 1; i--) {
        const from = i === 1 ? cfg.auditLog : `${cfg.auditLog}.${i - 1}`, to = `${cfg.auditLog}.${i}`;
        if (i === cfg.auditKeep) { try { fs.unlinkSync(to); } catch { /* none yet */ } }
        try { fs.renameSync(from, to); } catch { /* none yet */ }
      }
    } catch { /* no log yet */ }
  };
  const audit = (event, fields = {}) => {
    try {
      fs.mkdirSync(path.dirname(cfg.auditLog), { recursive: true });
      rotateAudit();
      fs.appendFileSync(cfg.auditLog, JSON.stringify({ at: new Date(cfg.now()).toISOString(), event, ...fields }) + String.fromCharCode(10));
    } catch { /* logging is best effort */ }
  };

  // Every refusal, the 429 included, is sent at the same fixed moment after the request arrived.
  const pad = async (started) => { const wait = cfg.deniedDelayMs - (Date.now() - started); if (wait > 0) await sleep(wait); };
  const deny = async (res, started, reason) => {
    audit('denied', { reason });
    await pad(started);
    return send(res, 404, ACCESS_DENIED);
  };

  /** Marks one ingest-made link as revoked (the viewer then answers the uniform refusal). Runs only after the Access and secret locks. Only an existing entry changes; the audit line holds the id only. */
  const revokeLink = (res, id, ip, now) => {
    if (!allow(`rv:${ip}`, cfg.ratePerHour, 3600000, now)) { res.setHeader('Retry-After', '3600'); audit('rate-limited', { reason: 'revoke' }); return send(res, 429, 'Too many requests. Try again later.'); }
    const file = path.join(cfg.registryDir, `${id}.json`);
    let entry; try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { entry = null; }
    if (!entry || typeof entry !== 'object' || entry.id !== id) { audit('revoke-missing', { linkId: id }); return send(res, 404, 'No such link.'); }
    if (entry.revoked !== true) {
      entry.revoked = true;
      const tmp = path.join(cfg.registryDir, `${id}.json.tmp`);
      try { fs.writeFileSync(tmp, JSON.stringify(entry) + String.fromCharCode(10)); fs.renameSync(tmp, file); } catch { try { fs.unlinkSync(tmp); } catch { /* not there */ } audit('error'); return send(res, 500, 'The link could not be revoked.'); }
    }
    audit('revoked', { linkId: id });
    return send(res, 200, JSON.stringify({ ok: true, linkId: id, revoked: true }), 'application/json; charset=utf-8');
  };

  const handle = async (req, res) => {
    const started = Date.now();
    const now = cfg.now();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    // With TRUST_PROXY=1, the last entry of the one configured header (CLIENT_IP_HEADER, default CF-Connecting-IP), if it is a plain IP
    // address; otherwise the connection's address (fail safe: stricter, never looser). Used for the rate limits only, never logged.
    const ip = clientAddress(req, { trustProxy: cfg.trustProxy, header: cfg.clientIpHeader });
    const proto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || '') : (req.socket.encrypted ? 'https' : 'http');
    // An address that cannot be read as a URL (for example "//[" or "//%") gets the same uniform refusal as any other unknown address.
    let url; try { url = new URL(req.url || '/', 'http://x'); } catch { return deny(res, started, 'wrong-route'); }

    if (HEALTH_PATHS.includes(url.pathname)) return send(res, 200, 'ok');
    if (cfg.requireHttps && proto !== 'https') return deny(res, started, 'not-https');

    // Lock 1: the Cloudflare Access token. Signature, issuer, audience and expiry are verified here, not just looked for.
    if (cfg.requireAccessHeader && !(await verifyAccess(String(req.headers['cf-access-jwt-assertion'] || '')))) return failAuth('bad-access-token');
    // Lock 2: the application secret.
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!given || !sameSecret(given, cfg.secret)) return failAuth('bad-secret');
    const revoke = req.method === 'POST' ? REVOKE_ROUTE.exec(url.pathname) : null;
    if (revoke) return revokeLink(res, revoke[1], ip, now);
    if (url.pathname !== INGEST_ROUTE || req.method !== 'POST') return deny(res, started, 'wrong-route');

    // From here the caller is authenticated, so plain, specific errors are fine.
    if (!allow(`ok:${ip}`, cfg.ratePerHour, 3600000, now)) { res.setHeader('Retry-After', '3600'); audit('rate-limited'); return send(res, 429, 'Too many uploads. Try again later.'); }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cfg.maxBytes) { audit('rejected', { reason: 'too-big' }); return send(res, 413, 'That file is too large.'); }
    const chunks = []; let size = 0;
    // A client that drops the connection part-way ends this request quietly; there is no one left to answer.
    try { for await (const chunk of req) { size += chunk.length; if (size > cfg.maxBytes) { audit('rejected', { reason: 'too-big' }); return send(res, 413, 'That file is too large.'); } chunks.push(chunk); } } catch { audit('rejected', { reason: 'aborted' }); return; }
    let report, bodyText; try { bodyText = Buffer.concat(chunks).toString('utf8'); report = JSON.parse(bodyText); } catch { audit('rejected', { reason: 'not-json' }); return send(res, 400, 'That is not valid JSON.'); }
    // One request may carry the report and a styles file (styles_<hash> and data_<hash>); a plain report goes through unchanged.
    const split = splitEnvelope(report, bodyText);
    if (split.kind === 'error') { audit('rejected', { reason: split.reason }); return send(res, split.status, split.message); }
    report = split.report;
    let stylesId = split.kind === 'envelope' ? split.hash : null; if (!stylesId && report && report.styles) { try { stylesId = stylesHash(report.styles); } catch { stylesId = null; } }
    let problems; try { problems = checkIncomingReport(report); } catch { problems = ['That is not a valid report.']; } // a check that cannot run is a refusal, never a crash
    if (problems.length) { audit('rejected', { reason: stylesId && problems.some((p) => /styles/i.test(p)) ? 'styles-invalid' : 'contract' }); return send(res, 422, problems.join(' ')); }

    const hoursRaw = url.searchParams.get('hours');
    const hours = hoursRaw === null ? cfg.defaultHours : Number(hoursRaw);
    if (!(hours >= 1 && hours <= cfg.maxHours)) return send(res, 400, `Hours must be between 1 and ${cfg.maxHours}.`);

    try {
      fs.mkdirSync(cfg.reportsDir, { recursive: true }); fs.mkdirSync(cfg.registryDir, { recursive: true });
      if (fs.readdirSync(cfg.reportsDir).filter((f) => f.endsWith('.json')).length >= cfg.maxReports) { audit('rejected', { reason: 'full' }); return send(res, 507, 'The server holds the most reports it allows. Remove old ones first.'); }
      // The server picks every name: a random file id, a random link id and a random token. Nothing from the caller names a file.
      const fileId = crypto.randomBytes(16).toString('hex');
      const linkId = crypto.randomBytes(5).toString('hex');
      const token = newToken();
      const expiresAt = new Date(now + hours * 3600000).toISOString();
      const text = JSON.stringify(report);
      const reportFile = path.join(cfg.reportsDir, `${fileId}.json`), tmp = path.join(cfg.registryDir, `${linkId}.json.tmp`);
      try {
        fs.writeFileSync(reportFile, text, { flag: 'wx' }); // report first; never overwrites
        const entry = { id: linkId, tokenHash: hashToken(token), path: `${fileId}.json`, createdAt: new Date(now).toISOString(), expiresAt, revoked: false };
        fs.writeFileSync(tmp, JSON.stringify(entry) + String.fromCharCode(10), { flag: 'wx' });
        fs.renameSync(tmp, path.join(cfg.registryDir, `${linkId}.json`)); // link entry last, so a link never points at a missing report
      } catch (e) {
        // A failed upload leaves nothing behind: no orphan report and no half-written link entry.
        for (const f of [reportFile, tmp]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
        throw e;
      }
      audit('accepted', { linkId, fileId, bytes: text.length, hours, ...(stylesId ? { styles: stylesId } : {}) });
      const link = cfg.publicBase ? `${cfg.publicBase}/r/${token}` : null;
      return send(res, 201, JSON.stringify({ ok: true, linkId, expiresAt, link, token: link ? undefined : token }), 'application/json; charset=utf-8');
    } catch {
      audit('error');
      return send(res, 500, 'The report could not be stored.');
    }

    async function failAuth(reason) {
      if (!allow(`auth:${ip}`, cfg.rateBadPerMin, 60000, now)) { res.setHeader('Retry-After', '60'); audit('rate-limited', { reason: 'auth' }); await pad(started); return send(res, 429, 'Too many requests.'); }
      return deny(res, started, reason);
    }
  };
  // One request that goes wrong ends with a plain answer and nothing else. The server itself keeps running, and no detail leaves it.
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch {
      try { audit('error'); if (res.headersSent || res.writableEnded) res.destroy(); else send(res, 500, 'The report could not be stored.'); } catch { /* the connection is already gone */ }
    }
  });
  // A request that is not valid HTTP (broken framing, an oversized header) gets a plain 400 and the connection closes.
  server.on('clientError', (_err, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch { /* gone */ } });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return { server, cfg };
}

/**
 * What a switched-off ingest does instead of exiting: it keeps the container running and answers 503 to everything, health checks included,
 * so Docker's health shows "unhealthy" (not a healthy ingest) while the log line says it is switched off on purpose. It reads no body,
 * stores nothing and needs no secret.
 */
export function createIdleServer() {
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '3600');
    res.end('The ingest is switched off.');
  });
  server.on('clientError', (_err, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch { /* gone */ } });
  return server;
}

// Run directly: node apps/server/ingest/ingest.mjs
//   switched off (INGEST_ENABLED is not 1): one plain line, then it IDLES (every request answers 503, the health check shows it as unhealthy on purpose),
//   so a stack with the ingest variables unset deploys cleanly and a restart policy such as unless-stopped does not restart it in a loop;
//   switched on but misconfigured (short secret, Access settings missing, Access off without the acknowledgment): a plain reason
//   (names only) and exit 1. Running without Cloudflare Access prints a one-line WARNING on every start.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  try { process.loadEnvFile(process.env.ENV_FILE || path.join(import.meta.dirname, '..', '.env')); } catch { /* environment only */ }
  const cfg = loadIngestConfig();
  if (!cfg.enabled) {
    const idle = createIdleServer();
    idle.listen(cfg.port, () => console.log(`ingest is switched off (INGEST_ENABLED is not 1); idling on port ${idle.address().port}. Every request answers 503 and the health check shows it as unhealthy on purpose. Set INGEST_ENABLED=1 and the other names, then redeploy, to turn it on.`));
    // As the main process of a container this must still end promptly on docker stop.
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => idle.close(() => process.exit(0)));
  } else {
    for (const line of describeIngestSetup(cfg)) console.log('notice: ' + line);
    const problems = startupProblems(cfg);
    if (problems.length) { for (const p of problems) console.error('ingest not started: ' + p); process.exit(1); }
    if (!cfg.requireAccessHeader) console.warn(NO_EDGE_WARNING);
    const { server } = createIngestServer();
    server.listen(cfg.port, () => console.log(`ingest listening on port ${cfg.port}`));
  }
}

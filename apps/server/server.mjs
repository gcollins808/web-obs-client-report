// Token-gated report server (prototype). The image holds no client data: reports sit on a read-only volume and are
// served only to a request that carries the right token. Plain Node, no web framework.
//
//   /r/<token>                    the client viewer (a static page; no report inside)
//   /api/r/<token>/report.json    the client report, after the token is checked on the server
//   /api/r/<token>/feedback       POST: the client's feedback, emailed by the server to the address in the environment
//   /healthz                      "ok", nothing else
//
// Only a SHA-256 hash of each token is stored (one small file per link in the registry folder), with an expiry and a revoked flag.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NL = String.fromCharCode(10);
const DAY = 86400000;

import { hashToken, TOKEN_SHAPE } from './tokens.mjs';
import { composeFeedbackEmail, readFeedback } from './email.mjs';
import { makeSource, reportIdOf } from './source.mjs';
import { clientAddress, clientIpHeaderName } from './clientip.mjs';
import { createStyleInjector } from './styles-inject.mjs';
import { validateStyles } from '../viewer/brand/styles.mjs';
// Pure checking code (no file is written by it). The same value and shape rules the ingest applies are applied again before anything is served,
// because reports can also arrive by folder or ssh, which skip the ingest.
import { checkIncomingReport } from './ingest/contract-check.mjs';
export { hashToken };

export function loadConfig(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  return {
    port: n(env.PORT, 8080),
    // Where reports are read from: a folder ("directory", the default) or a fixed HTTPS address ("https"). Only ever from here, never from a request.
    reportSource: (env.REPORT_SOURCE || 'directory').trim(),
    reportsDir: path.resolve(env.REPORTS_DIR || '/data/reports'),
    reportSourceUrl: (env.REPORT_SOURCE_URL || '').trim(),
    reportSourceToken: env.REPORT_SOURCE_TOKEN || '',
    reportSourceTimeoutMs: n(env.REPORT_SOURCE_TIMEOUT_MS, 5000),
    sourceFetch: (...a) => fetch(...a),
    // The public address of the report app, used for the links make-token and publish print.
    publicBase: (env.WEBOBS_REPORT_BASE || '').trim(),
    // Every refusal waits at least this long, so a wrong link, an expired one and an unreachable source take about the same time.
    deniedDelayMs: n(env.DENIED_DELAY_MS, 250),
    registryDir: path.resolve(env.REGISTRY_DIR || '/data/registry'),
    // Fonts bundled in the image (a report's styles can only NAME one of them).
    fontsDir: path.resolve(env.FONTS_DIR || path.join(import.meta.dirname || '.', 'fonts')),
    appFile: path.resolve(env.APP_FILE || path.join(import.meta.dirname || '.', 'app', 'report.html')),
    requireHttps: env.REQUIRE_HTTPS !== '0',
    trustProxy: env.TRUST_PROXY === '1',
    // With TRUST_PROXY=1: the one header that names the caller (rate limits only). Empty: CF-Connecting-IP. See clientip.mjs.
    clientIpHeader: clientIpHeaderName(env.CLIENT_IP_HEADER),
    retentionDays: n(env.RETENTION_DAYS, 90),
    feedbackTo: (env.WEBOBS_FEEDBACK_TO || '').trim(),
    feedbackSubject: (env.WEBOBS_FEEDBACK_SUBJECT || '').trim(),
    // Without an API key the server writes each message to a file instead of sending it, so it runs (and is tested) with no credentials.
    mailMode: env.MAIL_MODE || (env.RESEND_API_KEY ? 'resend' : 'outbox'),
    resendKey: env.RESEND_API_KEY || '',
    resendFrom: (env.RESEND_FROM || '').trim(),
    fetch: (...a) => fetch(...a),
    outboxDir: path.resolve(env.OUTBOX_DIR || '/data/outbox'),
    rateGeneral: n(env.RATE_GENERAL_PER_MIN, 60),
    rateBadToken: n(env.RATE_BAD_TOKEN_PER_MIN, 10),
    rateFeedback: n(env.RATE_FEEDBACK_PER_10MIN, 5),
    maxBody: 20000,
    now: () => Date.now(),
  };
}

// ---- small helpers --------------------------------------------------------------------------------
export function isEmail(s) {
  if (typeof s !== 'string' || s.length > 200 || s.length < 6) return false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c <= 32 || c === 127) return false; }
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const dom = s.slice(at + 1);
  return dom.includes('.') && !dom.startsWith('.') && !dom.endsWith('.');
}
/** Keep text plain: drop control characters except newlines, and cap the length. */
export function cleanText(s, max) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.charCodeAt(0);
    if (c === 10) out += NL; else if (c === 13) continue; else if (c < 32 || c === 127) continue; else out += ch;
    if (out.length >= max) break;
  }
  return out;
}
const oneLine = (s, max) => cleanText(s, max).split(NL).join(' ').trim();

function sendText(res, code, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(body)); // from the bytes, not the characters (a title can hold non-ASCII text)
  res.end(body);
}
// The only words a refused request ever gets.
const ACCESS_DENIED = 'Access denied';
const ACCESS_DENIED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive, nosnippet"><meta name="referrer" content="no-referrer"><title>Link not available</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#07090f;color:#e8ebf2;font:18px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}h1{font-size:1.4rem;font-weight:600;margin:0;max-width:28em;padding:0 22px;text-align:center}</style></head><body><h1>This link is not available. Please request a fresh one.</h1></body></html>';

// ---- registry ------------------------------------------------------------------------------------
/** One small JSON file per link, so adding or revoking a link never has to rewrite anyone else's. */
function readRegistry(cfg) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(cfg.registryDir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { const e = JSON.parse(fs.readFileSync(path.join(cfg.registryDir, n), 'utf8')); if (e && typeof e === 'object') out.push(e); } catch { /* skip a file that is not a link entry */ }
  }
  return out;
}
/** The registry entry for this token, or null. Constant-time comparison of the hashes; every entry is checked. */
export function findEntry(cfg, token) {
  if (!TOKEN_SHAPE.test(token)) return null;
  const want = Buffer.from(hashToken(token), 'hex');
  let hit = null;
  for (const e of readRegistry(cfg)) {
    if (typeof e.tokenHash !== 'string' || e.tokenHash.length !== 64) continue;
    const have = Buffer.from(e.tokenHash, 'hex');
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) hit = e;
  }
  return hit;
}
/**
 * The report text for this registry entry, or null. Null for every reason alike: no entry, revoked, expired, a stored name that
 * is not a random file id, the source has nothing or is unreachable, or the report is past retention.
 */
export async function resolveReport(cfg, source, e, deadlineMs = 0) {
  if (!e || e.revoked) return null;
  const now = cfg.now();
  if (!e.expiresAt || Date.parse(e.expiresAt) <= now) return null;
  const id = reportIdOf(e.path);
  if (!id) return null;
  // A slow or down source must not make a valid link answer later than every other refusal: the read is cut off at the fixed refusal
  // time (the caller passes what is left of it). With DENIED_DELAY_MS=0 there is no cut-off. For a remote source raise DENIED_DELAY_MS.
  let timer; const cutoff = deadlineMs > 0 ? new Promise((r) => { timer = setTimeout(() => r(null), deadlineMs); }) : null;
  let got; try { got = cutoff ? await Promise.race([source.read(id), cutoff]) : await source.read(id); } catch { got = null; } finally { clearTimeout(timer); }
  if (!got) return null;
  if (cfg.retentionDays > 0 && got.mtimeMs != null && now - got.mtimeMs > cfg.retentionDays * DAY) return null; // past retention: no longer served
  return got.text;
}

// ---- rate limiting (in memory, per key) --------------------------------------------------------------
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

// ---- mail ------------------------------------------------------------------------------------------
async function sendMail(cfg, msg) {
  if (cfg.mailMode === 'outbox') {
    fs.mkdirSync(cfg.outboxDir, { recursive: true });
    const file = path.join(cfg.outboxDir, `${cfg.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify(msg, null, 2));
    return { delivered: 'outbox' };
  }
  if (cfg.mailMode === 'resend') {
    // Resend's HTTP API. The key is read from the environment, goes only in the Authorization header, and is never logged or returned.
    if (!cfg.resendKey || !cfg.resendFrom) throw new Error('resend is not configured');
    const res = await cfg.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.resendFrom, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
    if (!res.ok) throw new Error('resend refused the message (' + res.status + ')');
    return { delivered: 'resend' };
  }
  throw new Error('unknown MAIL_MODE');
}

// ---- start-up report ----------------------------------------------------------------------------
/** Plain-words lines about what is missing and what that means. Names only: no value is ever printed. */
export function describeSetup(cfg, envFileFound) {
  const out = [];
  if (!envFileFound) out.push('No .env file found next to the server: using the environment as it is. (Copy .env.example to apps/server/.env.)');
  if (!cfg.feedbackTo) out.push('WEBOBS_FEEDBACK_TO missing: clients cannot send feedback (the send button will say it is not set up). It is the team address that receives it.');
  else if (!isEmail(cfg.feedbackTo)) out.push('WEBOBS_FEEDBACK_TO is not a valid email address: clients cannot send feedback.');
  if (cfg.mailMode === 'resend') {
    if (!cfg.resendKey) out.push('RESEND_API_KEY missing: MAIL_MODE asks for Resend but there is no key, so feedback cannot be sent.');
    if (!cfg.resendFrom) out.push('RESEND_FROM missing: it is the verified sender address in Resend. Without it feedback cannot be sent.');
  } else if (cfg.mailMode === 'outbox') {
    out.push('RESEND_API_KEY missing: feedback is written to the outbox file instead of being emailed.');
  } else out.push('MAIL_MODE is not "outbox" or "resend": feedback cannot be sent.');
  if (cfg.requireHttps && !cfg.trustProxy) out.push('TRUST_PROXY is not 1 while HTTPS is required: every request over plain http is refused, so this only works with TLS in front and TRUST_PROXY=1 (or REQUIRE_HTTPS=0 for local testing).');
  if (cfg.reportSource === 'directory') {
    if (!fs.existsSync(cfg.reportsDir)) out.push('REPORTS_DIR folder not found: there are no reports to serve. It is where the client reports are mounted.');
  } else if (cfg.reportSource === 'https') {
    const s = makeSource(cfg);
    if (s.kind === 'unavailable') out.push('REPORT_SOURCE_URL is not usable (' + s.why + '): no report can be read, so every link is refused.');
    if (!cfg.reportSourceToken) out.push('REPORT_SOURCE_TOKEN is empty: reports are requested without a bearer token. That is fine only if the source needs none.');
  } else out.push('REPORT_SOURCE is not "directory" or "https": no report can be read, so every link is refused.');
  if (!cfg.publicBase) out.push('WEBOBS_REPORT_BASE missing: it is the public address of this report app (https://...). The link tools print links from it.');
  else if (!/^https:[/][/]/.test(cfg.publicBase)) out.push('WEBOBS_REPORT_BASE should start with https://: links to clients must be secure.');
  if (!fs.existsSync(cfg.registryDir)) out.push('REGISTRY_DIR folder not found: no link will work. It holds one small file of hashes per link, made by make-token.mjs.');
  if (!fs.existsSync(cfg.appFile)) out.push('APP_FILE not found: the viewer page cannot be served. Build the app (npm run report:build) and point APP_FILE at report.html.');
  return out;
}

// ---- server --------------------------------------------------------------------------------------
export function createServer(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const source = overrides.source || makeSource(cfg);
  const allow = limiter();
  let appHtml = null;
  const app = () => { if (!appHtml) appHtml = fs.readFileSync(cfg.appFile, 'utf8'); return appHtml; };
  const lastFeedback = new Map();
  // A styles problem is logged as a reason code only (never the styles, a path or a link), at most one line per code per minute and 30 a minute.
  const styleLogged = new Map(); let styleWindow = { at: 0, n: 0 };
  const logStyles = (code) => {
    try {
      const t = Date.now(); if (t - styleWindow.at > 60000) styleWindow = { at: t, n: 0 };
      if (styleWindow.n >= 30 || t - (styleLogged.get(code) || 0) < 60000) return;
      styleLogged.set(code, t); styleWindow.n++; console.log('[styles] ' + String(code).slice(0, 40));
    } catch { /* logging is best effort */ }
  };
  const injector = overrides.styleInjector || createStyleInjector({ fontsDir: cfg.fontsDir, log: logStyles });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * The one refusal. Same words, same shape, same wait, whatever the reason (no link, wrong, expired, revoked, report missing,
   * source unreachable). The page route answers 403 with a plain page; the data routes answer 404 with the same two words.
   * It says nothing about which case it was and never redirects.
   */
  // Every refusal, including the 429 "too many requests", leaves at the same fixed moment after the request arrived. Local checks
  // finish well inside that time. The one exception is a slow remote report source, which can only be reached with a valid link entry.
  const pad = async (started) => { const wait = cfg.deniedDelayMs - (Date.now() - started); if (wait > 0) await sleep(wait); };
  const deny = async (res, started, wantsPage) => {
    await pad(started);
    if (wantsPage) return sendText(res, 403, ACCESS_DENIED_PAGE, 'text/html; charset=utf-8');
    return sendText(res, 404, ACCESS_DENIED);
  };

  const handle = async (req, res) => {
    const started = Date.now();
    const now = cfg.now();
    // On every response, including the viewer, the denied page and errors.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    // With TRUST_PROXY=1 the caller is named by ONE configured header (CLIENT_IP_HEADER, default CF-Connecting-IP, which the tunnel sets
    // itself): its last entry, only if it is a plain IP address. Otherwise, or without TRUST_PROXY=1, the address of the connection.
    // X-Forwarded-Proto is read only with TRUST_PROXY=1: the proxy in front must set it (https), or every non-health request is refused.
    const ip = clientAddress(req, { trustProxy: cfg.trustProxy, header: cfg.clientIpHeader });
    const proto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || '') : (req.socket.encrypted ? 'https' : 'http');
    // An address that cannot be read as a URL (for example "//[" or "//%") gets the same plain refusal as any other unknown address.
    let url; try { url = new URL(req.url || '/', 'http://x'); } catch { return deny(res, started, !String(req.url || '').startsWith('/api')); }
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/api';

    if (url.pathname === '/healthz') return sendText(res, 200, 'ok');
    // A crawl-politeness file only: the real protection is the noindex header on every response above, not this.
    if (url.pathname === '/robots.txt') return sendText(res, 200, 'User-agent: *' + NL + 'Disallow: /' + NL);
    if (cfg.requireHttps && proto !== 'https') return sendText(res, 403, 'HTTPS is required.');
    if (cfg.requireHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (!allow(`g:${ip}`, cfg.rateGeneral, 60000, now)) { res.setHeader('Retry-After', '60'); await pad(started); return sendText(res, 429, 'Too many requests.'); }

    const m = /^\/(?:api\/)?r\/([^/]+)(?:\/(report\.json|feedback))?\/?$/.exec(url.pathname);
    // Not a report address at all (the home page, a guess, a sitemap): the same refusal. There is no home page and no listing.
    if (!m) return deny(res, started, !isApi);
    let token; try { token = decodeURIComponent(m[1]); } catch { return deny(res, started, !isApi); }
    const what = m[2] || '';

    // A wrong token counts against the caller; the answer is the same whether it never existed, expired or was revoked.
    const entry = findEntry(cfg, token);
    const text = await resolveReport(cfg, source, entry, cfg.deniedDelayMs > 0 ? Math.max(1, cfg.deniedDelayMs - (Date.now() - started)) : 0);
    // Only a client report is ever served: an explore pack or anything else behind a valid link is refused like any other failure.
    let parsed = null; if (text != null) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    // A report's styles are checked again here with the same function the ingest used. Styles that do not pass are dropped (the neutral look is served);
    // they never make an otherwise good report unavailable. A reason code is logged, never the styles.
    if (parsed && parsed.styles !== undefined) {
      try { const sv = validateStyles(parsed.styles); if (sv.ok) parsed.styles = sv.styles; else { delete parsed.styles; logStyles(sv.codes.includes('unreadable') ? 'styles-unreadable' : 'styles-invalid'); } } catch { delete parsed.styles; logStyles('styles-error'); }
    }
    // Also the value and shape check: a report that does not fit the contract (wrong types, hostile values, unknown fields) is not served.
    try { if (parsed && parsed.format === 'webobs.client-report' && checkIncomingReport(parsed).length) parsed = null; } catch { parsed = null; } // a check that cannot run is a refusal, never a crash
    if (!parsed || parsed.format !== 'webobs.client-report') {
      if (!allow(`bad:${ip}`, cfg.rateBadToken, 60000, now)) { res.setHeader('Retry-After', '60'); await pad(started); return sendText(res, 429, 'Too many requests.'); }
      return deny(res, started, !isApi);
    }

    if (!isApi && !what && req.method === 'GET') {
      // The viewer page. It learns where to fetch the report from two attributes on <html>; the report itself is not in it.
      const safe = encodeURIComponent(token);
      let page; try { page = app(); } catch { return sendText(res, 500, 'This page is not available right now. Please try again in a few minutes.'); }
      // The report's styles (already checked once at upload) are checked again here and written into the first bytes of the page. Any problem: the page as it is.
      try { page = injector.inject(page, parsed.styles).html; } catch { logStyles('inject-error'); } // the page as it is; a visitor always gets a complete page
      const at = page.indexOf('<html');
      const attrs = ` data-start="viewer" data-server-report="/api/r/${safe}/report.json" data-server-feedback="/api/r/${safe}/feedback"`;
      const html = at < 0 ? page : page.slice(0, at + 5) + attrs + page.slice(at + 5);
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    }

    if (isApi && what === 'report.json' && req.method === 'GET') {
      const report = parsed;
      // The reply address stays on the server: the browser never needs it.
      if (report.feedback) delete report.feedback.to;
      delete report.styles; // the page already has them in its first bytes
      return sendText(res, 200, JSON.stringify(report), 'application/json; charset=utf-8');
    }

    if (isApi && what === 'feedback' && req.method === 'POST') {
      if (!cfg.feedbackTo || !isEmail(cfg.feedbackTo)) return sendText(res, 503, 'Feedback is not set up for this report.');
      if (!allow(`fb:${entry.id}`, cfg.rateFeedback, 600000, now)) { res.setHeader('Retry-After', '600'); return sendText(res, 429, 'Too many messages. Please try again later.'); }
      let raw = ''; let tooBig = false;
      // A client that drops the connection part-way ends this request quietly; there is no one left to answer.
      try { for await (const chunk of req) { raw += chunk; if (raw.length > cfg.maxBody) { tooBig = true; break; } } } catch { return; }
      if (tooBig) return sendText(res, 413, 'That message is too long.');
      let body; try { body = JSON.parse(raw); } catch { return sendText(res, 400, 'Not valid JSON.'); }
      const report = parsed;
      // The email is built here from the report and the client's answers; the browser supplies no recipient, subject, sender or markup.
      const fb = readFeedback(report, body);
      if (!fb.items.length && !fb.general) return sendText(res, 400, 'Nothing to send.');
      const mail = composeFeedbackEmail(report, fb, new Date(now));
      const subject = cfg.feedbackSubject ? oneLine(cfg.feedbackSubject.split('{client}').join(oneLine(report.client?.name || 'client', 120)), 200) : mail.subject;
      const msg = { to: cfg.feedbackTo, subject, text: mail.text, html: mail.html, receivedAt: new Date(now).toISOString() };
      try { await sendMail(cfg, msg); } catch { return sendText(res, 502, 'The message could not be sent. Please try again later.'); }
      lastFeedback.set(entry.id, now);
      return sendText(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    }
    return sendText(res, 405, 'Not allowed.');
  };
  // One request that goes wrong ends with a plain answer and nothing else. The server itself keeps running, and no detail leaves it.
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch {
      try { if (res.headersSent || res.writableEnded) res.destroy(); else sendText(res, 500, 'Something went wrong on our side. Please try again in a few minutes.'); } catch { /* the connection is already gone */ }
    }
  });
  // A request that is not valid HTTP (broken framing, an oversized header) gets a plain 400 and the connection closes.
  server.on('clientError', (_err, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch { /* gone */ } });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, cfg };
}

// Run directly: node apps/server/server.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  // Settings may come from a .env file next to this script (git-ignored); real environment variables win.
  let envFileFound = true;
  try { process.loadEnvFile(process.env.ENV_FILE || path.join(import.meta.dirname, '.env')); } catch { envFileFound = false; }
  const { server, cfg } = createServer();
  for (const line of describeSetup(cfg, envFileFound)) console.log('notice: ' + line);
  server.listen(cfg.port, () => console.log(`report server listening on port ${cfg.port} (feedback mode: ${cfg.mailMode})`));
}

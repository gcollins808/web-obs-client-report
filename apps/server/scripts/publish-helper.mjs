// The Studio's Publish button needs something that can run ssh. A web page cannot, and must not hold a secret, so this small helper
// does the push. You start it yourself, in a visible terminal, only when you want to publish:
//
//   npm run publish:helper
//
// It listens on 127.0.0.1 only, prints a one-time start token that you paste into the Studio, and stops by itself after 30 idle
// minutes (or Ctrl+C). It refuses to start without a terminal, so it cannot be run hidden or detached. Nothing polls it: the Studio
// asks it once when you press Connect and once when you press Publish. The upload credential is your own ssh key on this machine,
// used only by the ssh and scp commands the helper runs; it is never read by this script, sent to the page, or logged.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { publishAny, parseTarget, describeTarget, PublishError } from './lib/publish-core.mjs';
import { newToken } from '../tokens.mjs';
import { listCaptures, planRemoval, moveToTrash, CaptureError } from './lib/capture-core.mjs';
import { listLinks, revokeAny, extendLink, defaultIndexFile } from './lib/links-core.mjs';

const DEFAULT_ORIGINS = ['4176', '4177', '5176'].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
const MAX_BODY = 40 * 1024 * 1024;

export function createHelper(opts = {}) {
  const env = opts.env ?? process.env;
  const startToken = opts.token ?? newToken();
  const origins = new Set((env.WEBOBS_STUDIO_ORIGINS ? env.WEBOBS_STUDIO_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS));
  const idleMs = opts.idleMs ?? 30 * 60 * 1000;
  const hits = [];
  let idleTimer = null; let port = 0;
  const publish = opts.publish ?? publishAny;
  const indexFile = opts.indexFile ?? defaultIndexFile(env);
  const defaultHours = Number(env.WEBOBS_REPORT_TTL_HOURS) > 0 ? Number(env.WEBOBS_REPORT_TTL_HOURS) : 72;

  const server = http.createServer(async (req, res) => {
    touch();
    const origin = req.headers.origin;
    const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
    // Only this machine, addressed as itself: blocks DNS rebinding.
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(421, { ok: false, message: 'Wrong host.' });
    // Only the Studio's own origins may call it from a browser.
    if (origin !== undefined && !origins.has(origin)) return send(403, { ok: false, message: 'This page is not allowed to use the publish helper.' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    const now = Date.now();
    while (hits.length && now - hits[0] > 60000) hits.shift();
    if (hits.length >= 20) return send(429, { ok: false, message: 'Too many requests. Wait a minute.' });
    hits.push(now);

    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    const want = Buffer.from(startToken);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { ok: false, message: 'The start token is not right. Copy it from the terminal where the helper is running.' });

    const url = new URL(req.url || '/', 'http://x');
    const target = (() => { try { return parseTarget(env.WEBOBS_PUBLISH_TARGET); } catch { return null; } })();
    if (req.method === 'GET' && url.pathname === '/status') {
      return send(200, { ok: true, targetSet: Boolean(target), target: target ? describeTarget(target) : null, baseSet: Boolean((env.WEBOBS_REPORT_BASE || '').trim()), vaultSet: Boolean((env.WEBOBS_VAULT || '').trim()), defaultHours });
    }
    if (req.method === 'POST' && url.pathname === '/publish') {
      if (!target) return send(400, { ok: false, message: 'WEBOBS_PUBLISH_TARGET is not set in the .env on this machine, so there is nowhere to publish to.' });
      if (!(env.WEBOBS_REPORT_BASE || '').trim()) return send(400, { ok: false, message: 'WEBOBS_REPORT_BASE is not set in the .env on this machine, so the link would have no address.' });
      let raw = ''; let tooBig = false;
      for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) { tooBig = true; break; } }
      if (tooBig) return send(413, { ok: false, message: 'That report is too large to publish.' });
      let body; try { body = JSON.parse(raw); } catch { return send(400, { ok: false, message: 'Not valid JSON.' }); }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-helper-'));
      try {
        const file = path.join(dir, 'report.client-report.json');
        fs.writeFileSync(file, JSON.stringify(body.report ?? null));
        const r = await publish({ reportFile: file, slug: String(body.client ?? ''), hours: Number(body.hours ?? defaultHours), target: env.WEBOBS_PUBLISH_TARGET, base: env.WEBOBS_REPORT_BASE, indexFile, env });
        opts.onPublished?.({ id: r.id }); // the terminal learns that something was published, never the link
        return send(200, { ok: true, link: r.link, id: r.id, expires: r.expires });
      } catch (e) {
        return send(e instanceof PublishError && e.code !== 'upload-failed' ? 400 : 502, { ok: false, message: e instanceof PublishError ? e.message : 'Publishing failed.' });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    // ---- manage: archive a capture, see and revoke links. Nothing here deletes; archiving moves to the vault's trash folder. ----
    const readJson = async (cap = 1_000_000) => { let t = ''; for await (const chunk of req) { t += chunk; if (t.length > cap) throw new PublishError('That request is too large.', 'too-big'); } try { return JSON.parse(t || '{}'); } catch { throw new PublishError('Not valid JSON.', 'bad-json'); } };
    const vault = (env.WEBOBS_VAULT || '').trim();
    const manage = async (fn) => {
      try { return send(200, { ok: true, ...(await fn()) }); }
      catch (e) {
        if (e instanceof PublishError || e instanceof CaptureError) return send(e.code === 'upload-failed' ? 502 : 400, { ok: false, message: e.message });
        return send(500, { ok: false, message: 'That did not work.' });
      }
    };
    const needVault = () => { if (!vault) throw new CaptureError('WEBOBS_VAULT is not set in the .env on this machine, so there is no vault to look in.', 'no-vault'); };
    if (req.method === 'GET' && url.pathname === '/captures') return manage(() => { needVault(); return { captures: listCaptures(vault) }; });
    if (req.method === 'POST' && url.pathname === '/archive/preview') return manage(async () => { needVault(); const b = await readJson(); const p = planRemoval(vault, String(b.domain ?? '')); return { plan: { domain: p.domain, items: p.items.map(({ label, rel, files, bytes }) => ({ label, rel, files, bytes })), files: p.files, bytes: p.bytes } }; });
    if (req.method === 'POST' && url.pathname === '/archive') return manage(async () => { needVault(); const b = await readJson(); const r = moveToTrash(vault, String(b.domain ?? ''), String(b.confirm ?? '')); opts.onArchived?.({ domain: r.domain }); return { moved: { domain: r.domain, trash: r.trash, files: r.files } }; });
    if (req.method === 'GET' && url.pathname === '/links') return manage(() => ({ links: listLinks(target, indexFile) }));
    if (req.method === 'POST' && url.pathname === '/links/revoke') return manage(async () => { const b = await readJson(); await revokeAny(target, String(b.id ?? ''), { env, indexFile, fetchImpl: opts.fetchImpl }); opts.onRevoked?.({ id: String(b.id) }); return {}; });
    if (req.method === 'POST' && url.pathname === '/links/extend') return manage(async () => { const b = await readJson(); const expiresAt = extendLink(target, String(b.id ?? ''), Number(b.hours), indexFile); opts.onExtended?.({ id: String(b.id) }); return { expiresAt }; });
    return send(404, { ok: false, message: 'Not found.' });
  });

  function touch() { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { opts.onIdle?.(); server.close(); }, idleMs); idleTimer.unref?.(); }
  return {
    server, startToken,
    listen: (p = 0) => new Promise((resolve) => { server.listen(p, '127.0.0.1', () => { port = server.address().port; touch(); resolve(port); }); }),
    close: () => new Promise((resolve) => { if (idleTimer) clearTimeout(idleTimer); server.close(() => resolve()); }),
  };
}

// Run directly: node apps/server/scripts/publish-helper.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  try { process.loadEnvFile(path.resolve(import.meta.dirname, '..', '..', '..', '.env')); } catch { /* no .env file */ }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('The publish helper must be started by you in a visible terminal. It will not run hidden or in the background.');
    process.exit(2);
  }
  const helper = createHelper({ onPublished: (r) => console.log(`published (link id ${r.id})`), onArchived: (r) => console.log(`archived capture ${r.domain} (moved to the vault trash)`), onRevoked: (r) => console.log(`revoked link ${r.id}`), onIdle: () => { console.log('Idle for 30 minutes: stopping.'); process.exit(0); } });
  const want = Number(process.env.WEBOBS_HELPER_PORT || 4178);
  const port = await helper.listen(want);
  const t = (() => { try { return parseTarget(process.env.WEBOBS_PUBLISH_TARGET); } catch { return null; } })();
  console.log(`Publish helper listening on 127.0.0.1:${port} (this machine only).`);
  console.log(t ? `Publishes to ${describeTarget(t)}.` : 'WEBOBS_PUBLISH_TARGET is not set in .env: the Studio will save the file instead of publishing.');
  console.log((process.env.WEBOBS_VAULT || '').trim() ? 'Archive capture is available (WEBOBS_VAULT is set).' : 'WEBOBS_VAULT is not set in .env: the Studio cannot list or archive captures.');
  if (!(process.env.WEBOBS_REPORT_BASE || '').trim()) console.log('WEBOBS_REPORT_BASE is not set in .env: links cannot be made until it is.');
  console.log('');
  console.log('Paste this start token into the Studio (it works only for this run):');
  console.log(helper.startToken);
  console.log('');
  console.log('Press Ctrl+C to stop. It also stops after 30 idle minutes.');
  process.on('SIGINT', () => { console.log('Stopped.'); process.exit(0); });
}

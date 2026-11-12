// Publish transport "https": POST the approved client report to the server's ingest route (apps/server/ingest) and get the link back.
// Optional feature; to remove it, delete this file, apps/server/ingest/, and the two lines in publish-core.mjs that mention it.
//
// Credentials come from environment variables on THIS machine only, never from a file in the project or the vault, and are never
// printed, logged or put in an error message:
//   WEBOBS_INGEST_SECRET        the application secret the ingest route checks
//   CF_ACCESS_CLIENT_ID         Cloudflare Access service token (id), sent as CF-Access-Client-Id
//   CF_ACCESS_CLIENT_SECRET     Cloudflare Access service token (secret), sent as CF-Access-Client-Secret
import fs from 'node:fs';
import path from 'node:path';
import { makeEnvelope } from '../../../viewer/brand/styles-hash.mjs';

/** The reply for a refused request is the same whatever the reason, so these hints are generic. */
export const OLD_SERVER_HINT = 'This server does not accept a report with a look yet. Update the report server and the ingest to 0.1.4 first (see docs/SETUP.md), or publish without a look.';
const HINT_REFUSED = 'The server refused the upload. Check the ingest secret and the Cloudflare Access service token on this machine.';

export function parseHttpsTarget(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null; // plain http only to this machine, for tests
  if (u.username || u.password || u.hash) return null;
  return { kind: 'https', url: u.origin + u.pathname + u.search };
}

/**
 * @param {{ reportFile: string, target: { url: string }, hours?: number, env?: Record<string,string|undefined>, fetchImpl?: typeof fetch, timeoutMs?: number, PublishError: any, checkReportFile: (r: unknown) => void }} o
 */
export async function publishHttps(o) {
  const { PublishError } = o;
  const env = o.env ?? process.env;
  const secret = env.WEBOBS_INGEST_SECRET || '';
  if (!secret) throw new PublishError('WEBOBS_INGEST_SECRET is not set on this machine, so the upload cannot be authorised.', 'no-target');
  const hours = Number(o.hours ?? 72);
  if (!(hours > 0 && hours <= 720)) throw new PublishError('Hours must be between 1 and 720.', 'bad-hours');
  const parsed = JSON.parse(fs.readFileSync(o.reportFile, 'utf8'));
  o.checkReportFile(parsed); // the same checks as every other transport, before anything leaves this machine
  // A report that carries a look is sent as ONE request with two named parts (styles_<hash> and data_<hash>); a plain report is sent as it is.
  let text, sentEnvelope = false;
  if (parsed && typeof parsed === 'object' && parsed.styles && typeof parsed.styles === 'object') { const { styles, ...rest } = parsed; text = JSON.stringify(makeEnvelope(rest, styles)); sentEnvelope = true; } else text = JSON.stringify(parsed);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) { headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID; headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET; }
  const target = new URL(o.target.url);
  target.searchParams.set('hours', String(hours));
  let res;
  try {
    res = await (o.fetchImpl ?? fetch)(target.toString(), { method: 'POST', headers, body: text, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30000) });
  } catch {
    throw new PublishError('The server could not be reached.', 'upload-failed');
  }
  // A redirect almost always means Cloudflare Access sent us to its login page: the service token is missing or wrong.
  if (res.status >= 300 && res.status < 400) throw new PublishError(HINT_REFUSED, 'upload-failed');
  if (res.status === 404 || res.status === 401 || res.status === 403) throw new PublishError(HINT_REFUSED, 'upload-failed');
  if (res.status === 429) throw new PublishError('The server says there have been too many uploads. Try again later.', 'upload-failed');
  const replyText = await res.text();
  let body = null; try { body = JSON.parse(replyText); } catch { /* not JSON */ }
  // A server older than 0.1.4 does not know the two-part request and answers that it is not a client report. Say what to do.
  if (sentEnvelope && res.status === 422 && /not a client report/i.test(replyText)) throw new PublishError(OLD_SERVER_HINT, 'upload-failed');
  if (sentEnvelope && res.status === 422 && replyText.length < 400) throw new PublishError(`The server did not accept the report with its look: ${replyText.trim()}`, 'upload-failed');
  if (res.status !== 201 || !body?.ok) {
    // The ingest route answers an authorised caller with a short plain reason (too large, outside the contract, and so on).
    throw new PublishError(`The server did not accept the report (${res.status}).`, 'upload-failed');
  }
  if (!body.link) throw new PublishError('The server stored the report but sent no link: set WEBOBS_REPORT_BASE on the server.', 'upload-failed');
  return { link: body.link, id: String(body.linkId), expires: String(body.expiresAt), steps: ['sent to the ingest route over https; the server made the link'] };
}

const LINK_ID = /^[a-f0-9]{10}$/;
const HINT_REFUSED_REVOKE = 'The server refused the request. Check the ingest secret and the Cloudflare Access service token on this machine.';

/**
 * Revokes a link the ingest made: POST <server>/ingest/v1/links/<id>/revoke with the same credentials as an upload. The viewer then gives
 * the uniform refusal for that link. Nothing but the link id is sent.
 * @param {{ target: { url: string }, id: string, env?: Record<string,string|undefined>, fetchImpl?: typeof fetch, timeoutMs?: number, PublishError: any }} o
 */
export async function revokeHttps(o) {
  const { PublishError } = o;
  const env = o.env ?? process.env;
  const secret = env.WEBOBS_INGEST_SECRET || '';
  if (!secret) throw new PublishError('WEBOBS_INGEST_SECRET is not set on this machine, so the request cannot be authorised.', 'no-target');
  if (!LINK_ID.test(String(o.id))) throw new PublishError('That is not a link id made by the ingest.', 'bad-id');
  const headers = { Authorization: 'Bearer ' + secret };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) { headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID; headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET; }
  const url = new URL('/ingest/v1/links/' + o.id + '/revoke', o.target.url);
  let res;
  try { res = await (o.fetchImpl ?? fetch)(url.toString(), { method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 30000) }); }
  catch { throw new PublishError('The server could not be reached.', 'upload-failed'); }
  if (res.status >= 300 && res.status < 400) throw new PublishError(HINT_REFUSED_REVOKE, 'upload-failed');
  const text = await res.text().catch(() => '');
  if (res.status === 404 && text === 'No such link.') throw new PublishError('The server has no link with that id.', 'not-found');
  if (res.status === 404 || res.status === 401 || res.status === 403) throw new PublishError(HINT_REFUSED_REVOKE, 'upload-failed');
  if (res.status === 429) throw new PublishError('The server says there have been too many requests. Try again later.', 'upload-failed');
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status !== 200 || !body?.ok) throw new PublishError(`The server did not revoke the link (${res.status}).`, 'upload-failed');
  return { revoked: true, id: String(body.linkId) };
}

// The ingest keeps its own registry and cannot list it, so links made through it are noted in the same local, agency-side index the other
// targets use (never uploaded): the link id, the client label and the dates. The Studio's links panel reads them from there.
const defaultIndex = (env = process.env) => path.resolve(env.WEBOBS_REPORT_INDEX || path.join(import.meta.dirname, '..', '..', '..', '..', '.report-index', 'index.json'));
export function capturedAtOf(reportFile) { try { return JSON.parse(fs.readFileSync(reportFile, 'utf8')).meta?.source?.capturedAt ?? null; } catch { return null; } }
export function recordLink(indexFile, entry, env = process.env) {
  const file = indexFile || defaultIndex(env);
  let links = []; try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j.links)) links = j.links; } catch { /* a new index */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, note: 'Local only. Maps links to clients. Do not upload.', links: [...links.filter((x) => x.linkId !== entry.linkId), entry] }, null, 2));
}

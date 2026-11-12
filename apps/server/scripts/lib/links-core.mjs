// See, revoke and extend published links: reads and edits the one-small-file-per-link registry in the publish target (a local folder, or
// a server over ssh with the agency machine's own keys). Used by the Studio's links panel through the local helper.
// A registry entry holds only a hash of its token, a random file name and the dates; this module never returns the hash. The client
// name for each link comes from the LOCAL index on this machine (written by make-token), never from the server.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PublishError } from './publish-core.mjs';
import { revokeHttps } from './publish-https.mjs';

const ID = /^[A-Za-z0-9]{1,32}$/;
const OPTS = ['-o', 'BatchMode=yes'];
const clean = (e) => ({ id: String(e.id ?? ''), createdAt: String(e.createdAt ?? ''), expiresAt: String(e.expiresAt ?? ''), revoked: Boolean(e.revoked) });
const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const defaultIndexFile = (env = process.env) => path.resolve(env.WEBOBS_REPORT_INDEX || path.join(root, '.report-index', 'index.json'));

/** Splits text that holds several JSON objects one after another (compact or pretty printed). */
export function splitObjects(text) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip a broken entry */ } start = -1; } }
  }
  return out;
}

const ssh = (target, remote, input) => spawnSync('ssh', [...OPTS, target.host, remote], { encoding: 'utf8', input });
const readIndex = (indexFile) => { try { const j = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return Array.isArray(j.links) ? j.links : []; } catch { return []; } };
const writeIndex = (indexFile, links) => { fs.mkdirSync(path.dirname(indexFile), { recursive: true }); fs.writeFileSync(indexFile, JSON.stringify({ version: 1, note: 'Local only. Maps links to clients. Do not upload.', links }, null, 2)); };

function readEntry(target, id) {
  if (target.kind === 'local') {
    const f = path.join(target.dir, 'registry', `${id}.json`);
    if (!fs.existsSync(f)) throw new PublishError('No link with that id.', 'not-found');
    const e = splitObjects(fs.readFileSync(f, 'utf8'))[0];
    if (!e) throw new PublishError('That link entry could not be read.', 'failed');
    return e;
  }
  const got = ssh(target, `cat ${target.dir}/registry/${id}.json`);
  if (got.status !== 0) throw new PublishError('No link with that id.', 'not-found');
  const e = splitObjects(got.stdout || '')[0];
  if (!e) throw new PublishError('That link entry could not be read.', 'failed');
  return e;
}
function writeEntry(target, id, entry) {
  const body = JSON.stringify(entry) + String.fromCharCode(10);
  if (target.kind === 'local') {
    const f = path.join(target.dir, 'registry', `${id}.json`);
    fs.writeFileSync(f + '.tmp', body); fs.renameSync(f + '.tmp', f);
    return;
  }
  const file = `${target.dir}/registry/${id}.json`;
  const put = ssh(target, `cat > ${file}.tmp && mv ${file}.tmp ${file}`, body);
  if (put.status !== 0) throw new PublishError('Could not update the link on the server.', 'upload-failed');
}

/** Links with their status from the server's registry and the client name from the local index. */
export function listLinks(target, indexFile = defaultIndexFile()) {
  if (!target) throw new PublishError('No publish target is set (WEBOBS_PUBLISH_TARGET).', 'no-target');
  if (target.kind === 'https') {
    // The ingest keeps its own registry and cannot list it: show the links this machine made through it, from the local index.
    return readIndex(indexFile).filter((x) => x.via === 'https').map((x) => ({ ...clean({ id: x.linkId, createdAt: x.createdAt, expiresAt: x.expiresAt, revoked: x.revoked }), client: String(x.client ?? ''), capturedAt: x.capturedAt ?? null })).filter((e) => ID.test(e.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  let entries = [];
  if (target.kind === 'local') {
    const dir = path.join(target.dir, 'registry');
    if (fs.existsSync(dir)) entries = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).flatMap((n) => splitObjects(fs.readFileSync(path.join(dir, n), 'utf8')));
  } else {
    const r = ssh(target, `cat ${target.dir}/registry/*.json 2>/dev/null; true`);
    if (r.error) throw new PublishError('Could not run ssh.', 'upload-failed');
    entries = splitObjects(r.stdout || '');
  }
  const names = new Map(readIndex(indexFile).map((x) => [x.linkId, x]));
  return entries.map(clean).filter((e) => ID.test(e.id)).map((e) => ({ ...e, client: String(names.get(e.id)?.client ?? ''), capturedAt: names.get(e.id)?.capturedAt ?? null })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Marks one link revoked. The server re-reads the registry on every request, so it stops working at once. */
export function revokeLink(target, id) {
  if (!target) throw new PublishError('No publish target is set (WEBOBS_PUBLISH_TARGET).', 'no-target');
  if (!ID.test(String(id))) throw new PublishError('That is not a link id.', 'bad-id');
  writeEntry(target, id, { ...readEntry(target, id), revoked: true });
}

/** Sets a link's expiry to `hours` from now (1 to 720). Returns the new expiry time. */
export function extendLink(target, id, hours, indexFile = defaultIndexFile()) {
  if (!target) throw new PublishError('No publish target is set (WEBOBS_PUBLISH_TARGET).', 'no-target');
  if (!ID.test(String(id))) throw new PublishError('That is not a link id.', 'bad-id');
  if (target.kind === 'https') throw new PublishError('Extending is not available for links made through the ingest. Publish a new link instead.', 'unsupported');
  const h = Number(hours);
  if (!(h > 0 && h <= 720)) throw new PublishError('Hours must be between 1 and 720.', 'bad-hours');
  const entry = readEntry(target, id);
  if (entry.revoked) throw new PublishError('That link was revoked. Publish a new one instead.', 'revoked');
  const expiresAt = new Date(Date.now() + h * 3600000).toISOString();
  writeEntry(target, id, { ...entry, expiresAt });
  const idx = readIndex(indexFile);
  if (idx.some((x) => x.linkId === id)) writeIndex(indexFile, idx.map((x) => (x.linkId === id ? { ...x, expiresAt } : x)));
  return expiresAt;
}

/** Revokes a link on any kind of target. An https target asks the ingest to do it (it holds the registry), then notes it in the local index. */
export async function revokeAny(target, id, o = {}) {
  if (target?.kind === 'https') {
    await revokeHttps({ target, id: String(id), env: o.env, fetchImpl: o.fetchImpl, PublishError });
    const file = o.indexFile ?? defaultIndexFile(o.env);
    const idx = readIndex(file);
    if (idx.some((x) => x.linkId === id)) writeIndex(file, idx.map((x) => (x.linkId === id ? { ...x, revoked: true } : x)));
    return;
  }
  revokeLink(target, id);
}

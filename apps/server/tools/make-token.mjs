// Create, list, revoke or extend report links. Run this on your own machine, then copy the staging folder to the server volume.
// The token is printed once and never stored: the registry keeps only its SHA-256 hash.
//
// What goes on the server has NO client text in it: the report is stored as reports/<32 random hex>.json and the registry entry holds
// only a link id, the hash of the token, that random file name and the dates. The client name lives only in YOUR local index file
// (default .report-index/index.json, set WEBOBS_REPORT_INDEX to move it), which never goes to the server.
//
//   node apps/server/tools/make-token.mjs create --report <client-report.json> --client <label> [--hours 72] [--out report-staging] [--base https://reports.example.com] [--index <file>]
//   node apps/server/tools/make-token.mjs list    [--out report-staging] [--index <file>]
//   node apps/server/tools/make-token.mjs revoke  <link-id> [--out report-staging]
//   node apps/server/tools/make-token.mjs extend  <link-id> --hours <n> [--out report-staging] [--index <file>]
// --hours defaults to WEBOBS_REPORT_TTL_HOURS (72 if unset); the most is 720 (30 days).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newToken, hashToken } from '../tokens.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { flags[rest[i].slice(2)] = rest[i + 1]; i++; } else pos.push(rest[i]); }
const fail = (m) => { console.error('error: ' + m); process.exit(2); };

const root = path.resolve(import.meta.dirname, '..', '..', '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env: flags only */ }
const out = path.resolve(flags.out || 'report-staging');
const registryDir = path.join(out, 'registry');
const indexFile = path.resolve(flags.index || process.env.WEBOBS_REPORT_INDEX || path.join(root, '.report-index', 'index.json'));
const defaultHours = Number(process.env.WEBOBS_REPORT_TTL_HOURS) > 0 ? Number(process.env.WEBOBS_REPORT_TTL_HOURS) : 72;
const hoursOf = () => { const h = Number(flags.hours ?? defaultHours); if (!(h > 0 && h <= 720)) fail('--hours must be between 1 and 720'); return h; };

const safeId = (id) => String(id).split('').filter((c) => /[A-Za-z0-9]/.test(c)).join('').slice(0, 32);
const entryFile = (id) => path.join(registryDir, safeId(id) + '.json');
// One unreadable file must not hide the others.
const readEntries = () => { let names = []; try { names = fs.readdirSync(registryDir).filter((n) => n.endsWith('.json')); } catch { return []; } return names.flatMap((n) => { try { return [JSON.parse(fs.readFileSync(path.join(registryDir, n), 'utf8'))]; } catch { return []; } }); };
const writeEntry = (e) => {
  fs.mkdirSync(registryDir, { recursive: true });
  const tmp = entryFile(e.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(e) + String.fromCharCode(10));
  fs.renameSync(tmp, entryFile(e.id));
};
// The local, agency-side index: which link is for which client. Never uploaded.
const readIndex = () => { try { const j = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return Array.isArray(j.links) ? j.links : []; } catch { return []; } };
const writeIndex = (links) => { fs.mkdirSync(path.dirname(indexFile), { recursive: true }); fs.writeFileSync(indexFile, JSON.stringify({ version: 1, note: 'Local only. Maps links to clients. Do not upload.', links }, null, 2)); };

if (cmd === 'create') {
  if (!flags.report) fail('--report <client-report.json> is required');
  if (!flags.client) fail('--client <label> is required (kept only in your local index)');
  let report; try { report = JSON.parse(fs.readFileSync(flags.report, 'utf8')); } catch { fail('the report file could not be read as JSON'); }
  if (report.format === 'webobs.explore-pack') fail('this is the agency-only explore pack. It must never go on the server.');
  if (report.format !== 'webobs.client-report') fail('not a webobs.client-report file');
  if (report.meta?.review?.state !== 'approved') fail('the report is not approved (review state: ' + report.meta?.review?.state + ')');
  const hours = hoursOf();
  const label = String(flags.client).slice(0, 80);

  const fileId = crypto.randomBytes(16).toString('hex'); // 128 random bits; says nothing about the client
  const dest = path.join(out, 'reports', `${fileId}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(flags.report, dest);

  const token = newToken();
  const id = crypto.randomBytes(5).toString('hex');
  const now = Date.now();
  const entry = { id, tokenHash: hashToken(token), path: `${fileId}.json`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + hours * 3600000).toISOString(), revoked: false };
  writeEntry(entry);
  writeIndex([...readIndex().filter((x) => x.linkId !== id), { linkId: id, fileId, client: label, capturedAt: report.meta?.source?.capturedAt ?? null, createdAt: entry.createdAt, expiresAt: entry.expiresAt }]);

  const base = (flags.base || process.env.WEBOBS_REPORT_BASE || 'https://reports.example.com').replace(/[/]+$/, '');
  console.log(`link id   ${id}`);
  console.log(`expires   ${entry.expiresAt}`);
  console.log(`report    ${dest}`);
  console.log('');
  console.log('Send this link to the client. It is shown ONCE and is not stored anywhere (only its hash is):');
  console.log(`${base}/r/${token}`);
  console.log('');
  console.log(`Next: copy ${out} to the server volume (see apps/server/README.md).`);
} else if (cmd === 'list') {
  const reg = new Map(readEntries().map((e) => [e.id, e]));
  for (const x of readIndex()) { const e = reg.get(x.linkId); console.log(`${x.linkId}  ${x.client}  made ${x.createdAt}  expires ${e?.expiresAt ?? x.expiresAt}${e?.revoked ? '  REVOKED' : ''}${e ? '' : '  (not in this registry)'}`); }
} else if (cmd === 'revoke') {
  const t = readEntries().find((x) => x.id === pos[0]);
  if (!t) fail('no link with that id in this registry folder');
  t.revoked = true; writeEntry(t);
  console.log(`revoked ${t.id}. Copy this file to the server's registry folder to take effect: ${entryFile(t.id)}`);
} else if (cmd === 'extend') {
  const t = readEntries().find((x) => x.id === pos[0]);
  if (!t) fail('no link with that id in this registry folder');
  const hours = hoursOf();
  t.expiresAt = new Date(Date.now() + hours * 3600000).toISOString(); writeEntry(t);
  writeIndex(readIndex().map((x) => (x.linkId === t.id ? { ...x, expiresAt: t.expiresAt } : x)));
  console.log(`extended ${t.id}: now expires ${t.expiresAt}. Copy this file to the server's registry folder to take effect: ${entryFile(t.id)}`);
} else {
  fail('usage: make-token.mjs create|list|revoke|extend ...');
}

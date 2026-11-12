// v0.1.5 review fixes: a look whose colours cannot reach readable contrast is refused (upload 422, serve neutral + reason code, check tool exits 1),
// fixable cases are still nudged, the link fallback in the CSS, the seal that survives the two-part upload, and one way of counting the agency name.
// Synthetic data only. Foreground; nothing is left running.   node apps/server/test-readability.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { validateStyles, readabilityProblems, deriveStyleOutput } from '../viewer/brand/styles.mjs';
import { contrast } from '../viewer/brand/color.mjs';
import { stylesHash, makeEnvelope } from '../viewer/brand/styles-hash.mjs';
import { createIngestServer } from './ingest/ingest.mjs';
import { splitEnvelope } from './ingest/envelope.mjs';
import { checkIncomingReport } from './ingest/contract-check.mjs';
import { createServer } from './server.mjs';
import { hashToken, newToken } from './tokens.mjs';
import { MARKER } from './styles-inject.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); } };
const base = JSON.parse(fs.readFileSync(path.join(here, '../../fixtures/client-report.sample.json'), 'utf8'));
const GOOD = { accent: '#F2994A', secondary: '#2ECDF5', link: '#23AEEB', text: '#C4C4C4', muted: '#6B6B6B', surface: '#101010', headingFont: 'Oswald', bodyFont: 'Inter', headingCase: 'uppercase', name: 'Example Agency', footerText: 'Prepared by Example Agency' };
const grey = (g) => '#' + g.toString(16).padStart(2, '0').repeat(3);

// ---- (1) LOGIC-001: unreadable looks are refused ----
console.log('readability is enforced');
await ok('a very light card colour is refused, naming the slot, with the reason code', () => {
  const v = validateStyles({ surface: '#ffffff' });
  assert.equal(v.ok, false); assert.equal(v.styles, null); assert.ok(v.codes.includes('unreadable')); assert.ok(v.errors.some((e) => /^surface:/.test(e) && /card/.test(e)), v.errors.join(' | '));
});
await ok('light text on a light card is refused', () => { const v = validateStyles({ text: '#eeeeee', surface: '#f5f5f5' }); assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /^surface:/.test(e))); });
await ok('equal colours: text and card the same light colour are refused; the same dark colour is fixed by lightening the text', () => {
  assert.equal(validateStyles({ text: '#f5f5f5', surface: '#f5f5f5' }).ok, false);
  const v = validateStyles({ text: '#202020', surface: '#202020' }); assert.equal(v.ok, true); assert.ok(deriveStyleOutput(v.styles).notes.some((x) => /^text /.test(x)));
});
await ok('a mid-grey card that the light page text cannot read on is refused', () => assert.equal(validateStyles({ surface: '#808080' }).ok, false));
await ok('near the threshold: the lightest card that still reads is accepted and the next level is refused', () => {
  let lastOk = -1; for (let g = 0; g < 256; g++) if (validateStyles({ surface: grey(g) }).ok) lastOk = g; else if (lastOk >= 0) break;
  assert.ok(lastOk > 20 && lastOk < 200, 'threshold level ' + lastOk);
  assert.equal(validateStyles({ surface: grey(lastOk) }).ok, true); assert.equal(validateStyles({ surface: grey(lastOk + 1) }).ok, false);
  assert.ok(contrast('#f4f6fb', grey(lastOk)) >= 4.5 && contrast('#f4f6fb', grey(lastOk + 1)) < 4.5, 'the numbers match the 4.5:1 rule');
});
await ok('keep the nudging: dim text, dim muted and a dark link on the default card are adjusted, not refused', () => {
  for (const st of [{ text: '#303030' }, { muted: '#202020' }, { link: '#003366' }, { accent: '#112233' }, { secondary: '#000000' }, { text: '#303030', muted: '#202020', link: '#003366', surface: '#101010' }]) {
    const v = validateStyles(st); assert.equal(v.ok, true, JSON.stringify(st) + ' ' + v.errors.join(' '));
    const o = deriveStyleOutput(v.styles); assert.ok(o.checks.filter((c) => c.min >= 4.5).every((c) => c.ok), JSON.stringify(st));
  }
});
await ok('the good look, a light-on-dark agency look and a client look still pass', () => {
  assert.equal(validateStyles(GOOD).ok, true);
  assert.equal(validateStyles({ accent: '#E8743B', secondary: '#4FB0C6', text: '#E6E6E6', muted: '#9A9A9A', surface: '#1B1D22' }).ok, true);
});
await ok('readabilityProblems: empty for a good look, one entry per slot, never throws', () => {
  assert.deepEqual(readabilityProblems({}), []); assert.deepEqual(readabilityProblems(GOOD), []);
  const p = readabilityProblems({ surface: '#ffffff', muted: '#fafafa', text: '#ffffff' }); assert.equal(new Set(p.map((x) => x.slot)).size, p.length);
  assert.doesNotThrow(() => readabilityProblems(null)); assert.doesNotThrow(() => readabilityProblems({ surface: 5 }));
});
await ok('the card edge and the accent on the stage stay advisory (a faint edge or dim accent is not unreadable text)', () => {
  const o = deriveStyleOutput(validateStyles({ accent: '#112233' }).styles); assert.ok(o.checks.some((c) => !c.ok && c.min < 4.5));
  assert.equal(validateStyles({ accent: '#112233' }).ok, true);
});

console.log('the check tool, the upload and the serve');
await ok('check-styles exits non-zero for an unreadable look and zero for a good one', () => {
  const tool = path.join(here, 'tools', 'check-styles.mjs'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-read-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ surface: '#ffffff' })); fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(GOOD));
  const bad = spawnSync(process.execPath, [tool, path.join(dir, 'bad.json')], { encoding: 'utf8' }), good = spawnSync(process.execPath, [tool, path.join(dir, 'good.json'), path.join(dir, 'none.html')], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stdout, /REFUSED/); assert.match(bad.stdout, /surface:/); assert.equal(good.status, 0, good.stdout + good.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-read-srv-'));
const SECRET = 'readability-test-secret-' + 'x'.repeat(30);
const reportsDir = path.join(tmp, 'reports'), registryDir = path.join(tmp, 'registry'), auditLog = path.join(tmp, 'audit', 'ingest.log');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
const ing = createIngestServer({ enabled: true, secret: SECRET, reportsDir, registryDir, auditLog, publicBase: 'https://audit.example.test', trustProxy: true, deniedDelayMs: 0, ratePerHour: 10000, rateBadPerMin: 1000, requireAccessHeader: false, acknowledgeNoEdgeAuth: true });
await new Promise((r) => ing.server.listen(0, '127.0.0.1', r));
const post = (body) => fetch(`http://127.0.0.1:${ing.server.address().port}/ingest/v1/reports`, { method: 'POST', headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5', authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
await ok('upload: an envelope with a very light card is refused 422 with a plain message naming the slot; nothing is stored; the audit line holds a reason code', async () => {
  const r = await post(makeEnvelope(base, { ...GOOD, surface: '#ffffff' }));
  assert.equal(r.status, 422); assert.match(r.text, /surface/); assert.ok(!r.text.includes('#ffffff'.toUpperCase()));
  assert.deepEqual(fs.readdirSync(reportsDir), []);
  const last = fs.readFileSync(auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop(); assert.equal(last.reason, 'styles-unreadable');
});
await ok('upload: a bare report that carries unreadable styles is refused too', async () => { assert.equal((await post({ ...base, styles: { surface: '#fafafa' } })).status, 422); assert.deepEqual(fs.readdirSync(reportsDir), []); });
await ok('upload: a nudgeable look is accepted', async () => assert.equal((await post(makeEnvelope(base, { ...GOOD, text: '#303030' }))).status, 201));
await new Promise((r) => ing.server.close(r));

await ok('serve: a stored look that is unreadable is dropped, the neutral page is served, and only a reason code is logged', async () => {
  const app = path.join(tmp, 'app.html'); fs.writeFileSync(app, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Website review</title>' + MARKER + '</head><body><div id="root"></div></body></html>');
  const rd = path.join(tmp, 'r2'), gd = path.join(tmp, 'g2'); fs.mkdirSync(rd); fs.mkdirSync(gd);
  const add = (styles) => { const tok = newToken(), fid = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(rd, fid + '.json'), JSON.stringify({ ...base, ...(styles ? { styles } : {}) })); fs.writeFileSync(path.join(gd, fid.slice(0, 8) + '.json'), JSON.stringify({ id: fid.slice(0, 8), tokenHash: hashToken(tok), path: fid + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), revoked: false })); return tok; };
  const light = add({ surface: '#ffffff', accent: '#F2994A' }), plain = add(null), fine = add(GOOD);
  const { server } = createServer({ reportsDir: rd, registryDir: gd, appFile: app, outboxDir: path.join(tmp, 'outbox'), trustProxy: true, deniedDelayMs: 0, rateGeneral: 100000, rateBadToken: 100000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (t) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/r/${t}`, { headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9' } }); return { status: r.status, body: await r.text() }; };
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  let a, b, c; try { a = await get(light); b = await get(plain); c = await get(fine); } finally { console.log = orig; }
  await new Promise((r) => server.close(r));
  assert.equal(a.status, 200); assert.ok(!a.body.includes('id="wo-styles"')); assert.ok(!a.body.includes('F2994A') && !a.body.toLowerCase().includes('--rp-accent:#f2994a'), 'no part of the look is applied');
  assert.equal(a.body.split(light).join('T'), b.body.split(plain).join('T'), 'same page as a report with no look');
  assert.ok(logs.includes('[styles] styles-unreadable') && logs.every((l) => /^\[styles\] [a-z-]{1,40}$/.test(l)), logs.join('|'));
  assert.ok(c.body.includes('id="wo-styles"'), 'a readable look is still applied');
});

// ---- (3) LOGIC-003: links keep a colour when the look sets neither link nor accent ----
console.log('links have a fallback colour');
await ok('every use of --rp-link in the viewer CSS has a fallback, and the link rule falls back to the accent', () => {
  const css = fs.readFileSync(path.join(here, '../viewer/src/viewer.css'), 'utf8') + fs.readFileSync(path.join(here, '../viewer/src/styles.css'), 'utf8');
  const uses = css.match(/var\(--rp-link[^)]*\)?\)?/g) || []; assert.ok(uses.length >= 1);
  assert.ok(uses.every((u) => /var\(--rp-link,\s*var\(--rp-accent/.test(u)), uses.join(' | '));
});
await ok('a look with neither link nor accent writes no --rp-link, so the fallback is what applies', () => assert.equal(deriveStyleOutput(validateStyles({ text: '#e6e6e6', surface: '#101010' }).styles).vars['--rp-link'], undefined));

// ---- (a) the seal ----
console.log('the seal and the two-part upload');
const { build: _b } = { build };
const out = path.join(tmp, 'pkg.mjs'); await build({ entryPoints: [path.join(here, '../../packages/contract/src/package.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
const L = await import('data:text/javascript;base64,' + fs.readFileSync(out).toString('base64'));
const sha = async (s) => crypto.createHash('sha256').update(s).digest('hex');
const verify = (r) => { const { styles: _s, ...plain } = r; return crypto.createHash('sha256').update(JSON.stringify({ ...plain, meta: { ...r.meta, integrity: undefined } })).digest('hex') === r.meta.integrity.contentSha256; };
await ok('the seal does not depend on the look: the same report sealed with and without a look has the same hash', async () => {
  const a = await L.sealReport({ ...base, meta: { ...base.meta, integrity: undefined } }, sha), b = await L.sealReport({ ...a, styles: GOOD }, sha);
  assert.equal(a.meta.integrity.contentSha256, b.meta.integrity.contentSha256); assert.ok(verify(a)); assert.ok(verify(b));
});
await ok('a report sealed with its look still verifies after it is split into two parts and merged by the ingest', async () => {
  const sealed = await L.sealReport({ ...base, styles: GOOD, meta: { ...base.meta, integrity: undefined } }, sha);
  const { styles, ...dataPart } = sealed; const body = JSON.stringify(makeEnvelope(dataPart, styles));
  const r = splitEnvelope(JSON.parse(body), body); assert.equal(r.kind, 'envelope'); assert.ok(verify(r.report), 'the stored report verifies'); assert.deepEqual(checkIncomingReport(r.report), []);
});
await ok('a report edited after export no longer verifies (the seal still detects changes)', async () => {
  const sealed = await L.sealReport({ ...base, styles: GOOD, meta: { ...base.meta, integrity: undefined } }, sha); const t = { ...sealed, client: { ...sealed.client, name: 'Changed' } };
  assert.equal(verify(t), false);
});

// ---- (b) one way of counting ----
console.log('the agency name is counted one way');
await ok('80 characters are accepted by the validator and by the contract check even when each character takes two UTF-16 units; 81 are refused', () => {
  const emoji80 = '\u{1F600}'.repeat(80), emoji81 = '\u{1F600}'.repeat(81);
  assert.equal(validateStyles({ name: emoji80 }).ok, true); assert.equal(validateStyles({ name: emoji81 }).ok, false);
  assert.deepEqual(checkIncomingReport({ ...base, styles: { name: emoji80, footerText: '\u{1F600}'.repeat(120) } }), []);
  assert.ok(checkIncomingReport({ ...base, styles: { name: emoji81 } }).length > 0);
  assert.equal(validateStyles({ name: 'n'.repeat(80) }).ok, true); assert.equal(validateStyles({ name: 'n'.repeat(81) }).ok, false);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} readability check(s) FAILED` : `\nall ${n} readability checks passed`);
process.exit(failed ? 1 : 0);

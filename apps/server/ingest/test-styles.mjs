// Ingest tests for a report that arrives with a styles file: one request, two named parts (styles_<hash>, data_<hash>), checked and stored together.
// Synthetic data only. Foreground; nothing is left running.   node apps/server/ingest/test-styles.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIngestServer } from './ingest.mjs';
import { splitEnvelope } from './envelope.mjs';
import { checkIncomingReport } from './contract-check.mjs';
import { stylesHash, makeEnvelope } from '../../viewer/brand/styles-hash.mjs';
import { createServer } from '../server.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const SECRET = 'ingest-test-secret-' + 'x'.repeat(30);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-ingest-styles-'));
const fresh = () => { const d = fs.mkdtempSync(path.join(dir, 'v-')); return { reportsDir: path.join(d, 'reports'), registryDir: path.join(d, 'registry'), auditLog: path.join(d, 'audit', 'ingest.log') }; };
const reportObj = JSON.parse(fs.readFileSync(new URL('../../../fixtures/client-report.sample.json', import.meta.url), 'utf8'));
const STYLES = { accent: '#F2994A', secondary: '#2ECDF5', link: '#23AEEB', text: '#C4C4C4', muted: '#6B6B6B', surface: '#101010', headingFont: 'Oswald', bodyFont: 'Inter', headingCase: 'uppercase', name: 'Example Agency', footerText: 'Prepared by Example Agency' };

const boot = async (over = {}) => {
  const v = fresh();
  const { server, cfg } = createIngestServer({ enabled: true, secret: SECRET, ...v, publicBase: 'https://audit.example.test', trustProxy: true, deniedDelayMs: 0, ratePerHour: 10000, rateBadPerMin: 1000, requireAccessHeader: false, acknowledgeNoEdgeAuth: true, ...over });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => { const r = await fetch(`${base}/ingest/v1/reports`, { method: 'POST', headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5', authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
  const stored = () => (fs.existsSync(v.reportsDir) ? fs.readdirSync(v.reportsDir) : []);
  const audit = () => (fs.existsSync(v.auditLog) ? fs.readFileSync(v.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { v, cfg, post, stored, audit, close: () => new Promise((r) => server.close(r)) };
};
const env = (styles = STYLES, report = reportObj) => makeEnvelope(report, styles);

console.log('the envelope: one request, two named parts');
{
  const s = await boot(); const h = stylesHash(STYLES);
  const ok = await s.post(env());
  check('a styles part and a data part with the same hash are accepted (201)', ok.status === 201, ok.text.slice(0, 80));
  const file = s.stored()[0], saved = JSON.parse(fs.readFileSync(path.join(s.v.reportsDir, file), 'utf8'));
  check('exactly one file is stored: the report with the checked styles inside (colours lower-cased)', s.stored().length === 1 && saved.format === 'webobs.client-report' && saved.styles.accent === '#f2994a' && Object.keys(saved).every((k) => !/^(styles|data)_/.test(k)));
  check('the audit line names the styles hash (a short id, no styles text)', s.audit().some((e) => e.event === 'accepted' && e.styles === h) && !JSON.stringify(s.audit()).includes('Example Agency'));
  const bare = await s.post(reportObj);
  check('a bare report (no styles) is still accepted exactly as before', bare.status === 201 && s.stored().length === 2);
  const bareFile = s.stored().map((f) => JSON.parse(fs.readFileSync(path.join(s.v.reportsDir, f), 'utf8'))).find((r) => !r.styles);
  check('and is stored without a styles field', Boolean(bareFile) && !('styles' in bareFile));
  check('a bare report that carries its own valid styles field is accepted and the audit line has its hash', (await s.post({ ...reportObj, styles: STYLES })).status === 201 && s.audit().filter((e) => e.styles === h).length === 2);
  await s.close();
}

console.log('pairing, duplicates and mismatches: nothing is stored');
{
  const s = await boot(); const h = stylesHash(STYLES); const other = stylesHash({ accent: '#112233' });
  const cases = {
    'different hashes in the two names': { ['styles_' + h]: STYLES, ['data_' + other]: reportObj },
    'the hash does not match the styles that were sent': { ['styles_' + other]: STYLES, ['data_' + other]: reportObj },
    'a styles part only': { ['styles_' + h]: STYLES },
    'a data part only': { ['data_' + h]: reportObj },
    'a third part': { ...env(), extra: 1 },
    'two styles parts': { ['styles_' + h]: STYLES, ['styles_' + other]: { accent: '#112233' }, ['data_' + h]: reportObj },
    'a short hash': { ['styles_' + h.slice(0, 8)]: STYLES, ['data_' + h.slice(0, 8)]: reportObj },
    'an upper-case hash': { ['styles_' + h.toUpperCase()]: STYLES, ['data_' + h.toUpperCase()]: reportObj },
    'parts that are not objects': { ['styles_' + h]: 'x', ['data_' + h]: 'y' },
    'a data part that already has styles': { ['styles_' + h]: STYLES, ['data_' + h]: { ...reportObj, styles: STYLES } },
    'a data part that is a list': { ['styles_' + h]: STYLES, ['data_' + h]: [reportObj] },
    'styles with an unknown key': (() => { const st = { ...STYLES, acent: '#112233' }; const hh = stylesHash(st); return { ['styles_' + hh]: st, ['data_' + hh]: reportObj }; })(),
    'styles with a bad colour': (() => { const st = { ...STYLES, accent: 'red' }; const hh = stylesHash(st); return { ['styles_' + hh]: st, ['data_' + hh]: reportObj }; })(),
    'styles with a font that is not bundled': (() => { const st = { ...STYLES, headingFont: 'Comic Sans' }; const hh = stylesHash(st); return { ['styles_' + hh]: st, ['data_' + hh]: reportObj }; })(),
    'a report part that is not a valid report': { ['styles_' + h]: STYLES, ['data_' + h]: { format: 'webobs.client-report', version: '1.0' } },
  };
  const codes = {};
  for (const [name, body] of Object.entries(cases)) codes[name] = (await s.post(body)).status;
  check('every one of these is refused with 422', Object.values(codes).every((c) => c === 422), JSON.stringify(Object.entries(codes).filter(([, c]) => c !== 422)));
  const dup = `{"styles_${h}":${JSON.stringify(STYLES)},"styles_${h}":${JSON.stringify(STYLES)},"data_${h}":${JSON.stringify(reportObj)}}`;
  const dupr = await s.post(dup);
  check('the same part name twice in the raw request is refused (JSON.parse alone would hide it)', dupr.status === 422 && /more than once|exactly two/.test(dupr.text), dupr.text.slice(0, 80));
  const dup2 = `{"styles_${h}":${JSON.stringify(STYLES)},"data_${h}":${JSON.stringify(reportObj)},"data_${h}":${JSON.stringify(reportObj)}}`;
  check('and for the data part', (await s.post(dup2)).status === 422);
  check('nothing was stored by any of them', s.stored().length === 0);
  const reasons = s.audit().filter((e) => e.event === 'rejected').map((e) => e.reason);
  check('the audit log holds reason codes only', reasons.length >= 15 && reasons.every((r) => /^[a-z-]{1,30}$/.test(r)) && reasons.includes('styles-mismatch') && reasons.includes('duplicate-key') && reasons.includes('styles-invalid') && reasons.includes('envelope'), [...new Set(reasons)].join(','));
  check('the answers are plain sentences and never echo the styles text', Object.values(cases).length > 0 && !(await s.post(cases['styles with a bad colour'])).text.includes('red'));
  await s.close();
}

console.log('hostile styles in a valid envelope');
{
  const s = await boot(); const ATTACKS = ['</style><script>alert(1)</script>', 'url(http://example.invalid/x)', '@import "x"', '\\', '$&', '{}', '__proto__', 'x'.repeat(5000)];
  let allRefused = true, stored = 0;
  for (const slot of ['accent', 'secondary', 'link', 'text', 'muted', 'surface', 'headingFont', 'bodyFont', 'headingCase']) for (const a of ATTACKS) { const st = { ...STYLES, [slot]: a }; const r = await s.post({ ['styles_' + stylesHash(st)]: st, ['data_' + stylesHash(st)]: reportObj }); if (r.status !== 422) allRefused = false; }
  check('every attack value in every colour, font and case slot is refused at upload', allRefused);
  const proto = `{"styles_x":1}`; check('a name that is not a 12-hex hash is refused', (await s.post(proto)).status === 422);
  const protoStyles = '{"styles_' + stylesHash({}) + '":{"__proto__":{"a":1}},"data_' + stylesHash({}) + '":' + JSON.stringify(reportObj) + '}';
  check('a __proto__ key inside the styles is refused', (await s.post(protoStyles)).status === 422 && ({}).a === undefined);
  const big = { ...STYLES, extra: 'x'.repeat(5000) }; check('oversize styles are refused', (await s.post({ ['styles_' + stylesHash(big)]: big, ['data_' + stylesHash(big)]: reportObj })).status === 422);
  stored = s.stored().length; check('nothing was stored', stored === 0);
  const txt = { ...STYLES, name: '<b>Agency & "Co"</b>', footerText: 'Prepared by </script><script>' };
  const okText = await s.post({ ['styles_' + stylesHash(txt)]: txt, ['data_' + stylesHash(txt)]: reportObj });
  check('plain text with < > & quotes is valid text (it is escaped at serve time, never pasted)', okText.status === 201);
  const oversizeBody = await s.post(JSON.stringify({ ...env(), pad: 'x'.repeat(3 * 1024 * 1024) }));
  check('the existing 2 MB upload limit still applies to the whole request', oversizeBody.status === 413);
  await s.close();
}

console.log('the checker that guards the stored file and the server agree');
{
  const withStyles = { ...reportObj, styles: STYLES };
  check('the contract check accepts a report with valid styles and refuses one with bad styles', checkIncomingReport(withStyles).length === 0 && checkIncomingReport({ ...reportObj, styles: { accent: 'red' } }).length > 0 && checkIncomingReport({ ...reportObj, styles: { grey_0: '#000000' } }).length > 0);
  check('a split of a plain report is a pass-through', splitEnvelope(reportObj, JSON.stringify(reportObj)).kind === 'bare' && splitEnvelope(null, 'null').kind === 'bare' && splitEnvelope([], '[]').kind === 'bare');
  check('splitEnvelope never throws on odd input', [undefined, 5, 'x', { get styles_aaaaaaaaaaaa() { throw new Error('x'); } }].every((x) => { try { splitEnvelope(x, ''); return true; } catch { return false; } }));
}

console.log('end to end: what the ingest stored is served with its look');
{
  const s = await boot({ publicBase: 'https://r.example.test' });
  const created = JSON.parse((await s.post(env())).text);
  const token = created.link.split('/r/')[1];
  const PAGE = '<!doctype html><html lang="en"><head><title>Website review</title><!--wo-brand--></head><body>viewer</body></html>';
  fs.writeFileSync(path.join(dir, 'app.html'), PAGE);
  const { server } = createServer({ reportsDir: s.v.reportsDir, registryDir: s.v.registryDir, appFile: path.join(dir, 'app.html'), trustProxy: true, deniedDelayMs: 0, rateGeneral: 1000, rateBadToken: 1000, outboxDir: path.join(dir, 'outbox') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = await fetch(`http://127.0.0.1:${server.address().port}/r/${token}`, { headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9' } });
  const body = await page.text();
  check('the viewer server puts the stored styles into the page', page.status === 200 && body.includes('--rp-accent:#f2994a') && body.includes('<title>Example Agency'));
  await new Promise((r) => server.close(r)); await s.close();
}

console.log('the publish tool sends a report that carries a look as one envelope request');
{
  const { publishAny } = await import('../scripts/lib/publish-core.mjs');
  const v = fresh();
  const { server } = createIngestServer({ enabled: true, secret: SECRET, ...v, publicBase: 'https://r.example.test', trustProxy: true, deniedDelayMs: 0, ratePerHour: 10000, rateBadPerMin: 1000, requireAccessHeader: false, acknowledgeNoEdgeAuth: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/ingest/v1/reports`;
  const env = { WEBOBS_INGEST_SECRET: SECRET };
  const seen = []; const spyFetch = (u, init) => { seen.push(JSON.parse(init.body)); return fetch(u, { ...init, headers: { ...init.headers, 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5' } }); };
  const f1 = path.join(dir, 'with-styles.json'); fs.writeFileSync(f1, JSON.stringify({ ...reportObj, styles: STYLES }));
  const f2 = path.join(dir, 'plain.json'); fs.writeFileSync(f2, JSON.stringify(reportObj));
  const f3 = path.join(dir, 'bad-styles.json'); fs.writeFileSync(f3, JSON.stringify({ ...reportObj, styles: { accent: 'red' } }));
  const idx = path.join(dir, 'index.json');
  const r1 = await publishAny({ reportFile: f1, slug: 'acme', hours: 24, target: url, env, fetchImpl: spyFetch, indexFile: idx });
  check('a report with styles is sent as { styles_<hash>, data_<hash> } and the data part does not repeat the styles', r1.link.startsWith('https://r.example.test/r/') && Object.keys(seen[0]).length === 2 && Object.keys(seen[0]).some((k) => /^styles_[0-9a-f]{12}$/.test(k)) && !('styles' in seen[0]['data_' + stylesHash(STYLES)]));
  const r2 = await publishAny({ reportFile: f2, slug: 'acme', hours: 24, target: url, env, fetchImpl: spyFetch, indexFile: idx });
  check('a plain report is sent exactly as before (no envelope)', Boolean(r2.link) && seen[1].format === 'webobs.client-report' && !Object.keys(seen[1]).some((k) => /^(styles|data)_/.test(k)));
  let blocked = false; const before = seen.length;
  try { await publishAny({ reportFile: f3, slug: 'acme', hours: 24, target: url, env, fetchImpl: spyFetch, indexFile: idx }); } catch (e) { blocked = /styles are not valid/.test(String(e.message)); }
  check('bad styles are refused on this machine, before anything is sent', blocked && seen.length === before);
  const stored = fs.readdirSync(v.reportsDir).map((f) => JSON.parse(fs.readFileSync(path.join(v.reportsDir, f), 'utf8')));
  const oldServer = async () => new Response('That is not a client report.', { status: 422 });
  let oldMsg = ''; try { await publishAny({ reportFile: f1, slug: 'acme', hours: 24, target: url, env, fetchImpl: oldServer, indexFile: idx }); } catch (e) { oldMsg = String(e.message); }
  check('an older server that refuses the two-part request is explained plainly (update the server first)', /does not accept a report with a look yet/.test(oldMsg) && /0.1.4/.test(oldMsg));
  let plainOld = ''; try { await publishAny({ reportFile: f2, slug: 'acme', hours: 24, target: url, env, fetchImpl: oldServer, indexFile: idx }); } catch (e) { plainOld = String(e.message); }
  check('a report without a look gets the ordinary message from an older server, not the look hint', !/with a look/.test(plainOld) && plainOld.length > 0);
  check('the server stored the look with the first report and none with the second', stored.length === 2 && stored.filter((r) => r.styles).length === 1);
  await new Promise((r) => server.close(r));
}

console.log(failed ? `${failed} check(s) FAILED` : 'all ingest styles checks passed');
process.exit(failed ? 1 : 0);

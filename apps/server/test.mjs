// Foreground, self-terminating checks for the report server. Synthetic data only; the server runs inside this process on a
// random port and is closed at the end. Run: node apps/server/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, hashToken, cleanText } from './server.mjs';
import { newToken } from './tokens.mjs';
import { composeFeedbackEmail, readFeedback } from './email.mjs';

const NL2 = String.fromCharCode(10);
const FB0 = { general: 'hello' };
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-srv-'));
const staging = path.join(dir, 'staging');
const synthetic = (over = {}) => ({
  format: 'webobs.client-report', version: '1.1',
  meta: { reportId: 'rpt-test-1', review: { state: 'approved', reviewedBy: 'Test' }, source: { siteId: 'demo.test', capturedAt: '2026-01-01T00:00:00Z' } },
  client: { name: 'Demo Client', domain: 'demo.test', accent: null }, feedback: { to: 'agency@demo.test', subject: 'x' }, findings: [],
  modes: { guided: { tour: ['welcome', 'g-f1'], steps: [{ id: 'welcome', kind: 'welcome' }, { id: 'g-f1', kind: 'finding', findingId: 'f1', title: 'Security settings <have> gaps', checkpoint: { id: 'cp-f1', options: ['This is what I expected', 'This surprises me', 'I would like to discuss this'] } }] } }, ...over,
});
fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(synthetic()));
fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ format: 'webobs.explore-pack', version: '1.0' }));
fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(synthetic({ meta: { reportId: 'd', review: { state: 'draft' } } })));
fs.writeFileSync(path.join(dir, 'app.html'), '<!doctype html><html lang="en"><body>viewer</body></html>');

const tool = (...args) => spawnSync(process.execPath, [path.join(import.meta.dirname, 'tools', 'make-token.mjs'), ...args, '--out', staging, '--index', path.join(dir, 'index.json')], { encoding: 'utf8' });
const mint = (extra = []) => {
  const r = tool('create', '--report', path.join(dir, 'ok.json'), '--client', 'Demo Client', '--base', 'https://r.test', ...extra);
  const m = /https:\/\/r\.test\/r\/([A-Za-z0-9_-]+)/.exec(r.stdout);
  const id = /link id\s+(\w+)/.exec(r.stdout)?.[1];
  return { r, token: m?.[1], id };
};

console.log('token randomness');
{
  const N = 5000; const toks = Array.from({ length: N }, newToken);
  check('every token is 43 URL-safe characters (32 bytes)', toks.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t)));
  check('no two of ' + N + ' tokens are the same', new Set(toks).size === N);
  const freq = new Map(); for (const t of toks) for (const c of t.slice(0, 42)) freq.set(c, (freq.get(c) || 0) + 1);
  const total = N * 42; const H = -[...freq.values()].reduce((a, n) => a + (n / total) * Math.log2(n / total), 0);
  check('characters are spread evenly (entropy near 6 bits each)', H > 5.95, 'H=' + H.toFixed(3));
  const maxShare = Math.max(...freq.values()) / total;
  check('no character dominates', maxShare < 0.03, 'max ' + (maxShare * 100).toFixed(2) + '%');
  const firsts = new Set(toks.map((t) => t[0])); check('the first character varies', firsts.size > 40, firsts.size + ' distinct');
  const sorted = [...toks].sort(); let shared = 0; for (let i = 1; i < sorted.length; i++) { let k = 0; while (k < 43 && sorted[i][k] === sorted[i - 1][k]) k++; shared = Math.max(shared, k); }
  check('no two tokens share a long prefix (no counter or timestamp)', shared < 6, 'longest shared prefix ' + shared);
  const asBytes = toks.map((t) => Buffer.from(t, 'base64url')); let rising = 0; for (let i = 1; i < N; i++) if (asBytes[i][0] > asBytes[i - 1][0]) rising++;
  check('consecutive tokens are not ordered', rising / (N - 1) > 0.45 && rising / (N - 1) < 0.55, (rising / (N - 1)).toFixed(3));
  const bits = asBytes.reduce((a, b) => a + [...b].reduce((x, v) => x + v.toString(2).split('1').length - 1, 0), 0) / (N * 32 * 8);
  check('about half of all bits are set', bits > 0.49 && bits < 0.51, bits.toFixed(4));
  check('the hash is not the token and is 64 hex characters', hashToken(toks[0]) !== toks[0] && /^[0-9a-f]{64}$/.test(hashToken(toks[0])));
}

console.log('token tool');
const a = mint();
check('creates a link with a 32-byte (43 character) token', a.token?.length === 43, `len ${a.token?.length}`);
const entries = () => fs.readdirSync(path.join(staging, 'registry')).filter((n) => n.endsWith('.json'));
const regText = entries().map((n) => fs.readFileSync(path.join(staging, 'registry', n), 'utf8')).join(String.fromCharCode(10));
check('registry holds the hash and never the token', regText.includes(hashToken(a.token)) && !regText.includes(a.token));
check('each link is its own small file', fs.existsSync(path.join(staging, 'registry', a.id + '.json')));
const aPath = JSON.parse(fs.readFileSync(path.join(staging, 'registry', a.id + '.json'), 'utf8')).path;
check('the report is stored under a random 32-hex name, in no client folder', /^[0-9a-f]{32}[.]json$/.test(aPath) && fs.existsSync(path.join(staging, 'reports', aPath)));
check('the explore pack is refused', tool('create', '--report', path.join(dir, 'pack.json'), '--client', 'x').status !== 0);
check('an unapproved report is refused', tool('create', '--report', path.join(dir, 'draft.json'), '--client', 'x').status !== 0);
check('two links never share a token', mint().token !== a.token);

// A registry entry for each failure case, written by hand (as the tool would).
const mk = (tok, over) => fs.writeFileSync(path.join(staging, 'registry', over.id + '.json'), JSON.stringify({ tokenHash: hashToken(tok), path: aPath, createdAt: 'x', expiresAt: new Date(Date.now() + 86400000).toISOString(), revoked: false, ...over }));
const expired = 'E'.repeat(43), revoked = 'R'.repeat(43), traversal = 'T'.repeat(43), packTok = 'P'.repeat(43);
mk(expired, { id: 'exp', expiresAt: new Date(Date.now() - 1000).toISOString() });
mk(revoked, { id: 'rev', revoked: true });
mk(traversal, { id: 'trv', path: '../ok.json' });
const packId = 'c'.repeat(32);
fs.writeFileSync(path.join(staging, 'reports', packId + '.json'), JSON.stringify({ format: 'webobs.explore-pack' }));
mk(packTok, { id: 'pak', path: packId + '.json' });
fs.writeFileSync(path.join(staging, 'registry', 'broken.json'), 'not json');

const outbox = path.join(dir, 'outbox');
const boot = async (over = {}) => {
  const { server, cfg } = createServer({ reportsDir: path.join(staging, 'reports'), registryDir: path.join(staging, 'registry'), appFile: path.join(dir, 'app.html'), outboxDir: outbox, feedbackTo: 'feedback@agency.example', trustProxy: true, retentionDays: 90, deniedDelayMs: 0, ...over });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7', ...headers } });
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7', ...headers }, body: JSON.stringify(body) });
  return { server, cfg, get, post, close: () => new Promise((r) => server.close(r)) };
};

console.log('serving');
{
  const s = await boot();
  const ok = await s.get(`/api/r/${a.token}/report.json`);
  const j = await ok.json();
  check('a valid token returns the report', ok.status === 200 && j.format === 'webobs.client-report');
  check('the reply address is not sent to the browser', j.feedback && !('to' in j.feedback));
  check('no-store and no-index headers are set', /no-store/.test(ok.headers.get('cache-control')) && /noindex/.test(ok.headers.get('x-robots-tag')));
  check('referrer, framing and sniffing are locked down', ok.headers.get('referrer-policy') === 'no-referrer' && ok.headers.get('x-frame-options') === 'DENY' && ok.headers.get('x-content-type-options') === 'nosniff');
  const page = await s.get(`/r/${a.token}`); const html = await page.text();
  check('the viewer page points at the API and holds no report', page.status === 200 && html.includes(`data-server-report="/api/r/${a.token}/report.json"`) && !html.includes('Demo Client'));
  const bad = await s.get(`/api/r/${'x'.repeat(43)}/report.json`);
  const ex = await s.get(`/api/r/${expired}/report.json`), rv = await s.get(`/api/r/${revoked}/report.json`), tv = await s.get(`/api/r/${traversal}/report.json`), pk = await s.get(`/api/r/${packTok}/report.json`);
  const bodies = await Promise.all([bad, ex, rv, tv, pk].map((x) => x.text()));
  check('unknown, expired, revoked, traversal and explore-pack links all answer 404', [bad, ex, rv, tv, pk].every((x) => x.status === 404));
  check('they all answer with the same text', new Set(bodies).size === 1);
  check('a malformed token is 404', (await s.get('/api/r/short/report.json')).status === 404);
  check('no https means no data', (await s.get(`/api/r/${a.token}/report.json`, { 'x-forwarded-proto': 'http' })).status === 403);
  check('the health check answers without data', (await s.get('/healthz', { 'x-forwarded-proto': 'http' })).status === 200);
  check('HSTS is sent over https', /max-age/.test(ok.headers.get('strict-transport-security') || ''));
  check('other paths are refused the same way (403 page, 404 for data)', (await s.get('/')).status === 403 && (await s.get('/data/reports/x.json')).status === 403 && (await s.get('/api/x')).status === 404);
  await s.close();
}

console.log('revocation, expiry and retention are checked on every request');
{
  const s = await boot();
  const before = (await s.get(`/api/r/${a.token}/report.json`)).status;
  const ef = path.join(staging, 'registry', a.id + '.json'); const e0 = JSON.parse(fs.readFileSync(ef, 'utf8'));
  fs.writeFileSync(ef, JSON.stringify({ ...e0, revoked: true }));
  const after = (await s.get(`/api/r/${a.token}/report.json`)).status;
  check('revoking in the registry takes effect without a restart', before === 200 && after === 404);
  fs.writeFileSync(ef, JSON.stringify(e0));
  const old = Date.now() / 1000 - 100 * 86400;
  fs.utimesSync(path.join(staging, 'reports', aPath), old, old);
  check('a report past the retention period is no longer served', (await s.get(`/api/r/${a.token}/report.json`)).status === 404);
  const now = Date.now() / 1000; fs.utimesSync(path.join(staging, 'reports', aPath), now, now);
  check('and is served again when inside it', (await s.get(`/api/r/${a.token}/report.json`)).status === 200);
  await s.close();
}

console.log('rate limits');
{
  const s = await boot({ rateBadToken: 3, rateGeneral: 1000 });
  const codes = []; for (let i = 0; i < 6; i++) codes.push((await s.get(`/api/r/${String(i).repeat(43)}/report.json`)).status);
  check('repeated wrong tokens are slowed down (429)', codes.includes(429) && codes[0] === 404, codes.join(','));
  await s.close();
  const g = await boot({ rateGeneral: 3 });
  const c2 = []; for (let i = 0; i < 6; i++) c2.push((await g.get('/nothing')).status);
  check('a general per-address limit applies', c2.includes(429), c2.join(','));
  await g.close();
}

console.log('start-up notices');
{
  const { describeSetup, loadConfig } = await import('./server.mjs');
  const SECRET = 're_secret_' + 'z'.repeat(20);
  const bare = describeSetup(loadConfig({}), false).join(NL2);
  check('says a missing .env file in plain words', /No .env file found/.test(bare));
  check('says which variable is missing and what it does', /WEBOBS_FEEDBACK_TO missing: clients cannot send feedback/.test(bare) && /RESEND_API_KEY missing: feedback is written to the outbox file/.test(bare));
  const full = describeSetup(loadConfig({ WEBOBS_FEEDBACK_TO: 'feedback@agency.example', RESEND_API_KEY: SECRET, RESEND_FROM: 'r@sender.example', TRUST_PROXY: '1' }), true).join(NL2);
  check('no key warning when the key and sender are set', !/RESEND_API_KEY missing|RESEND_FROM missing/.test(full));
  check('a key with no sender is called out', /RESEND_FROM missing/.test(describeSetup(loadConfig({ WEBOBS_FEEDBACK_TO: 'a@b.co', RESEND_API_KEY: SECRET }), true).join(NL2)));
  const all = bare + NL2 + full + NL2 + describeSetup(loadConfig({ RESEND_API_KEY: SECRET }), true).join(NL2);
  check('no value is ever printed', !all.includes(SECRET) && !all.includes('feedback@agency.example'));
}

console.log('mail settings');
{
  const { loadConfig } = await import('./server.mjs');
  check('with no API key the default is the outbox file', loadConfig({}).mailMode === 'outbox');
  check('with an API key the default is Resend', loadConfig({ RESEND_API_KEY: 'k' }).mailMode === 'resend');
  check('an explicit MAIL_MODE wins', loadConfig({ RESEND_API_KEY: 'k', MAIL_MODE: 'outbox' }).mailMode === 'outbox');
}

console.log('random file names, expiry, extend and cleanup');
{
  const names = []; const regs = [];
  for (let i = 0; i < 12; i++) { const m = mint(); const e = JSON.parse(fs.readFileSync(path.join(staging, 'registry', m.id + '.json'), 'utf8')); names.push(e.path); regs.push(JSON.stringify(e)); }
  check('file names are 32 hex characters (128 random bits) and different every time', names.every((n) => /^[0-9a-f]{32}[.]json$/.test(n)) && new Set(names).size === names.length);
  const serverTree = [...fs.readdirSync(path.join(staging, 'reports')), ...fs.readdirSync(path.join(staging, 'registry'))].join(' ') + regs.join(' ') + fs.readdirSync(path.join(staging, 'registry')).map((n) => fs.readFileSync(path.join(staging, 'registry', n), 'utf8')).join(' ');
  check('no client text is in any server-side file name or registry entry', !/demo|client/i.test(serverTree));
  check('the client name is only in the local index, which is not in the staging folder', /Demo Client/.test(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) && !fs.existsSync(path.join(staging, 'index.json')));
  const hoursLeft = (m) => (Date.parse(JSON.parse(fs.readFileSync(path.join(staging, 'registry', m.id + '.json'), 'utf8')).expiresAt) - Date.now()) / 3600000;
  const dflt = mint(); const two = mint(['--hours', '2']);
  check('the default life is 72 hours', Math.abs(hoursLeft(dflt) - 72) < 0.1, hoursLeft(dflt).toFixed(2));
  check('the operator can choose another time when exporting', Math.abs(hoursLeft(two) - 2) < 0.1);
  check('more than 720 hours is refused', mint(['--hours', '9999']).token === undefined);

  // an expired link, then extend brings it back with the exact new time
  const ex = mint(); const exFile = path.join(staging, 'registry', ex.id + '.json'); const exE = JSON.parse(fs.readFileSync(exFile, 'utf8'));
  fs.writeFileSync(exFile, JSON.stringify({ ...exE, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const sv = await boot(); const url = (t) => '/api/r/' + t + '/report.json';
  const expiredRes = await sv.get(url(ex.token)); const wrongRes = await sv.get(url('w'.repeat(43)));
  check('an expired link and a wrong link look exactly the same', expiredRes.status === 404 && wrongRes.status === 404 && (await expiredRes.text()) === (await wrongRes.text()) && expiredRes.headers.get('content-type') === wrongRes.headers.get('content-type'));
  const ext = tool('extend', ex.id, '--hours', '5');
  const newExp = JSON.parse(fs.readFileSync(exFile, 'utf8')).expiresAt;
  check('extend sets a new expiry from now and prints the exact time', ext.status === 0 && Math.abs((Date.parse(newExp) - Date.now()) / 3600000 - 5) < 0.1 && ext.stdout.includes(newExp), ext.stderr + ' id=' + ex.id + ' files=' + fs.readdirSync(path.join(staging, 'registry')).slice(0, 3).join(','));
  check('the extended link works again without restarting the server', (await sv.get(url(ex.token))).status === 200);
  for (const p of ['/reports', '/reports/', '/registry/', '/api/', '/api/r', '/api/r/', '/r/', '/data/reports/', '/' + aPath]) if (![403, 404].includes((await sv.get(p)).status)) check('no listing or file route at ' + p, false);
  check('the report folder is not browsable: no listing and no file route', (await sv.get('/reports/' + aPath)).status === 403 && (await sv.get('/api/r/')).status === 404);
  await sv.close();

  // feedback sent by email is unaffected by removal, and cleanup deletes what has expired
  fs.rmSync(outbox, { recursive: true, force: true });
  const fbSrv = await boot(); const fbRes = await fbSrv.post('/api/r/' + ex.token + '/feedback', { general: 'Great report' }); await fbSrv.close();
  const mails = fs.existsSync(outbox) ? fs.readdirSync(outbox) : [];
  check('feedback is delivered (to the outbox) before removal', fbRes.status === 200 && mails.length === 1);
  const { cleanup } = await import('./tools/cleanup.mjs');
  const vol = path.join(dir, 'cleanup-volume'); fs.mkdirSync(path.join(vol, 'reports'), { recursive: true }); fs.mkdirSync(path.join(vol, 'registry'), { recursive: true });
  const entry = (id, over) => { const file = id + '.json'; fs.writeFileSync(path.join(vol, 'reports', file), '{"format":"webobs.client-report"}'); fs.writeFileSync(path.join(vol, 'registry', id + '.json'), JSON.stringify({ id, tokenHash: 'h'.repeat(64), path: file, createdAt: 'x', expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false, ...over })); };
  entry('keep1', {}); entry('gone1', { expiresAt: new Date(Date.now() - 1000).toISOString() }); entry('gone2', { revoked: true });
  fs.writeFileSync(path.join(vol, 'registry', 'gone3.json'), JSON.stringify({ id: 'gone3', tokenHash: 'h'.repeat(64), path: 'missing.json', expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false }));
  fs.writeFileSync(path.join(vol, 'reports', 'orphan-old.json'), '{}'); fs.utimesSync(path.join(vol, 'reports', 'orphan-old.json'), Date.now() / 1000 - 100 * 3600, Date.now() / 1000 - 100 * 3600);
  fs.writeFileSync(path.join(vol, 'reports', 'orphan-new.json'), '{}');
  const lines = [];
  const dry = cleanup({ reportsDir: vol + '/reports', registryDir: vol + '/registry', dry: true, log: (l) => lines.push(l) });
  check('a dry run lists what it would remove and removes nothing', dry.expired === 1 && dry.revoked === 1 && dry.missingFile === 1 && dry.orphans === 1 && fs.existsSync(path.join(vol, 'reports', 'gone1.json')));
  const done = cleanup({ reportsDir: path.resolve(vol, 'reports'), registryDir: path.resolve(vol, 'registry'), log: (l) => lines.push(l) });
  const left = (d) => fs.readdirSync(path.join(vol, d)).sort().join(',');
  check('cleanup deletes expired and revoked reports with their registry entries', !fs.existsSync(path.join(vol, 'reports', 'gone1.json')) && !fs.existsSync(path.join(vol, 'registry', 'gone1.json')) && !fs.existsSync(path.join(vol, 'reports', 'gone2.json')) && !fs.existsSync(path.join(vol, 'registry', 'gone2.json')) && done.expired === 1 && done.revoked === 1);
  check('it removes an entry whose file is already gone and an old unreferenced file, and keeps a recent one', !fs.existsSync(path.join(vol, 'registry', 'gone3.json')) && !fs.existsSync(path.join(vol, 'reports', 'orphan-old.json')) && fs.existsSync(path.join(vol, 'reports', 'orphan-new.json')), left('reports'));
  check('a live link and its report are kept', left('registry') === 'keep1.json' && fs.existsSync(path.join(vol, 'reports', 'keep1.json')));
  check('the log names link ids and never a token or hash', lines.every((l) => !/h{20}/.test(l)));
  check('feedback already emailed is unaffected by removal', fs.readdirSync(outbox).length === 1 && JSON.parse(fs.readFileSync(path.join(outbox, fs.readdirSync(outbox)[0]), 'utf8')).text.includes('Great report'));
}

console.log('the feedback email');
const FB = { answers: { 'cp-f1': 'This surprises me' }, comments: { f1: 'Please call me <script>alert(1)</script>' }, general: 'Thanks & regards', name: 'Pat Client' };
{
  const rep1 = synthetic(); const fb = readFeedback(rep1, FB);
  const mail = composeFeedbackEmail(rep1, fb, new Date('2026-11-07T14:03:00Z'));
  check('clear subject with the client name', mail.subject === 'Feedback from Demo Client on their website review');
  check('text carries client, report, step, answer, note, name and a timestamp', ['Demo Client', 'rpt-test-1', 'Step 2 of 2', 'This surprises me', 'Please call me', 'Pat Client', 'Sat, 07 Nov 2026 14:03:00 UTC', 'Thanks & regards'].every((x) => mail.text.includes(x)));
  check('html carries the same facts', ['Demo Client', 'rpt-test-1', 'Step 2 of 2', 'This surprises me', 'Pat Client', '14:03:00 UTC'].every((x) => mail.html.includes(x)));
  check('html is escaped: no script tag survives', !mail.html.includes('<script>') && mail.html.includes('&lt;script&gt;') && mail.html.includes('Security settings &lt;have&gt; gaps'));
  check('html is phone friendly: viewport, narrow card, readable size, no images or scripts', /name="viewport"/.test(mail.html) && /max-width:560px/.test(mail.html) && /font-size:16px/.test(mail.html) && !/<img|<script|<link|<iframe/.test(mail.html));
  check('there is a plain text alternative', mail.text.length > 100 && !/<html|<div|<table/i.test(mail.text));
  const sensitive = ['agency@demo.test', 'api.resend', '/data/', 'C:/', 'Users', 'token', 'tokenHash'];
  check('nothing sensitive: no link, token, path or reply address', sensitive.every((x) => !mail.text.includes(x) && !mail.html.includes(x)));
  check('an answer that is not one of the step options is dropped', readFeedback(rep1, { answers: { 'cp-f1': 'Free text <b>' } }).items.length === 0);
  check('notes are length-limited', readFeedback(rep1, { comments: { f1: 'x'.repeat(5000) } }).items[0].note.length === 600);
}

console.log('feedback through the server');
{
  fs.rmSync(outbox, { recursive: true, force: true });
  const s = await boot({ rateFeedback: 3 });
  const url = '/api/r/' + a.token + '/feedback';
  const r1 = await s.post(url, { ...FB, to: 'evil@x.test', subject: 'Hacked', html: '<b>x</b>' });
  const files = fs.existsSync(outbox) ? fs.readdirSync(outbox) : [];
  const msg = files.length ? JSON.parse(fs.readFileSync(path.join(outbox, files[0]), 'utf8')) : {};
  check('feedback is accepted and written to the outbox', r1.status === 200 && files.length === 1);
  check('recipient and subject come from the server, not the browser', msg.to === 'feedback@agency.example' && msg.subject === 'Feedback from Demo Client on their website review' && !String(msg.html).includes('<b>x</b>'));
  check('the stored message holds text and html, and not the link', msg.text && msg.html && !msg.text.includes(a.token) && !msg.html.includes(a.token) && !JSON.stringify(msg).includes(a.id));
  check('feedback needs a valid token', (await s.post('/api/r/' + 'x'.repeat(43) + '/feedback', FB)).status === 404);
  check('an empty message is refused', (await s.post(url, {})).status === 400);
  check('a second message inside the window is accepted', (await s.post(url, FB)).status === 200);
  check('a third message inside the window is refused', (await s.post(url, FB)).status === 429);
  await s.close();
  const big = await boot();
  check('an oversized message is refused', (await big.post(url, { general: 'x'.repeat(30000) })).status === 413);
  await big.close();
  const none = await boot({ feedbackTo: '' });
  check('with no address configured it says so and sends nothing', (await none.post(url, FB)).status === 503);
  await none.close();

  // Resend, with a stand-in for the network: no real email is sent in tests.
  const KEY = 're_test_' + 'k'.repeat(24);
  const calls = [];
  const stub = (status) => async (u, init) => { calls.push({ url: u, init }); return { ok: status < 400, status }; };
  fs.rmSync(outbox, { recursive: true, force: true });
  const rs = await boot({ mailMode: 'resend', resendKey: KEY, resendFrom: 'Reports <reports@sender.example>', fetch: stub(200) });
  const rr = await rs.post(url, { ...FB, to: 'evil@x.test' });
  const sent = calls[0] ? JSON.parse(calls[0].init.body) : {};
  check('Resend: the message is posted to the Resend API', rr.status === 200 && calls.length === 1 && calls[0].url === 'https://api.resend.com/emails');
  check('Resend: recipient and sender come from the environment', sent.to?.[0] === 'feedback@agency.example' && sent.from === 'Reports <reports@sender.example>');
  check('Resend: it sends both html and a text alternative', /<html/.test(sent.html || '') && (sent.text || '').length > 100);
  check('Resend: the key is only in the Authorization header', calls[0]?.init.headers.Authorization === 'Bearer ' + KEY && !calls[0].init.body.includes(KEY) && !(await rr.clone().text()).includes(KEY));
  check('Resend: nothing is written to the outbox', !fs.existsSync(outbox));
  await rs.close();
  const bad = await boot({ mailMode: 'resend', resendKey: KEY, resendFrom: 'a@b.co', fetch: stub(500) });
  const rb = await bad.post(url, FB); const rbt = await rb.text();
  check('Resend: a refusal gives the client a plain error and no key', rb.status === 502 && !rbt.includes(KEY));
  await bad.close();
  const nofrom = await boot({ mailMode: 'resend', resendKey: KEY, resendFrom: '', fetch: stub(200) });
  check('Resend: no sender configured means nothing is sent', (await nofrom.post(url, FB)).status === 502);
  await nofrom.close();
  check('text cleaning drops control characters', cleanText('a' + String.fromCharCode(0, 7) + 'b', 10) === 'ab');
}

console.log('access denied: one plain refusal for every case');
{
  const s = await boot({ rateBadToken: 1000, rateGeneral: 1000 });
  const T = (n) => String(n).repeat(43);
  const cases = {
    'no link': ['/r/', '/', '/r'],
    'wrong link': [`/r/${T('x')}`],
    'malformed link': ['/r/short', '/r/%E0%A4%A'],
    'expired link': [`/r/${expired}`],
    'revoked link': [`/r/${revoked}`],
    'path in the registry': [`/r/${traversal}`],
    'explore pack behind a valid link': [`/r/${packTok}`],
  };
  const seen = [];
  for (const [name, paths] of Object.entries(cases)) for (const p of paths) {
    const r = await s.get(p); const body = await r.text();
    seen.push({ name, p, status: r.status, body, type: r.headers.get('content-type') });
  }
  const pageOnes = seen.filter((x) => x.status !== 404 || true);
  check('the page route answers 403 in every case', seen.every((x) => x.status === 403), seen.map((x) => x.name + ':' + x.status).join(' '));
  check('with exactly the same page every time', new Set(seen.map((x) => x.body)).size === 1 && seen.every((x) => x.type === 'text/html; charset=utf-8'));
  check('the page says only the one unavailable line', /<h1>This link is not available\. Please request a fresh one\.<\/h1>/.test(seen[0].body) && !/expired|revoked|invalid|not found|report/i.test(seen[0].body.replace(/<meta[^>]*>/g, '').replace('This link is not available. Please request a fresh one.', '').replace('Link not available', '')));
  check('the page has no script, no link, no image, no form and no third-party address', !/<script|<a |<img|<form|<link|https?:\/\//i.test(seen[0].body));
  check('the page carries its own robots and referrer meta tags', /<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">/.test(seen[0].body) && /<meta name="referrer" content="no-referrer">/.test(seen[0].body));
  const apis = [];
  for (const t of [T('x'), expired, revoked, traversal, packTok, 'short']) for (const w of ['report.json', 'feedback']) {
    const r = w === 'feedback' ? await s.post(`/api/r/${t}/feedback`, FB0) : await s.get(`/api/r/${t}/${w}`);
    apis.push({ status: r.status, body: await r.text(), type: r.headers.get('content-type') });
  }
  check('the data endpoints answer 404 in every case', apis.every((x) => x.status === 404), apis.map((x) => x.status).join(','));
  check('with the same two words every time', new Set(apis.map((x) => x.body)).size === 1 && apis[0].body === 'Access denied' && apis.every((x) => x.type === apis[0].type));
  check('there is never a redirect or a Location header', seen.every((x) => x.status < 300 || x.status > 399) );
  const loc = await s.get(`/r/${T('x')}`); check('no Location header on a refusal', loc.headers.get('location') === null);
  await s.close();

  // Timing: every refusal waits the same floor, so a missing link, an expired one and an unreachable source cannot be told apart by speed.
  const FLOOR = 120;
  const t = await boot({ deniedDelayMs: FLOOR });
  const times = [];
  for (const p of [`/r/${T('x')}`, `/r/${expired}`, `/r/${revoked}`, `/r/${packTok}`, `/api/r/${T('y')}/report.json`, '/']) { const a0 = Date.now(); await (await t.get(p)).text(); times.push(Date.now() - a0); }
  check('every refusal takes at least the fixed wait', times.every((x) => x >= FLOOR - 15), times.join(','));
  check('and they all take about the same time', Math.max(...times) - Math.min(...times) < FLOOR, times.join(','));
  await t.close();
}

console.log('caller address behind the tunnel');
{
  const s = await boot({ rateBadToken: 2, rateGeneral: 1000 });
  const bad = (cfIp, fwd) => s.get(`/api/r/${'q'.repeat(43)}/report.json`, { 'cf-connecting-ip': cfIp, 'x-forwarded-for': fwd });
  const first = []; for (let i = 0; i < 4; i++) first.push((await bad('198.51.100.1', `spoof${i}`)).status);
  check('a caller cannot dodge the limit by changing X-Forwarded-For when CF-Connecting-IP is present', first.includes(429), first.join(','));
  check('another real address is counted separately', (await bad('198.51.100.2', 'x')).status === 404);
  // X-Forwarded-For is never trusted: without CF-Connecting-IP every caller is the connection's own address, so changing it dodges nothing.
  const noCf = (fwd) => s.get(`/api/r/${'q'.repeat(43)}/report.json`, { 'x-forwarded-for': fwd });
  const viaXff = []; for (let i = 0; i < 4; i++) viaXff.push((await noCf(`203.0.113.${i}`)).status);
  check('X-Forwarded-For alone is ignored: rotating it does not avoid the limit', viaXff.includes(429), viaXff.join(','));
  await s.close();
}
console.log('the 429 answer waits like every other refusal');
{
  const s = await boot({ rateBadToken: 1, rateGeneral: 1000, deniedDelayMs: 120 });
  const tm = async () => { const t0 = Date.now(); const r = await s.get(`/api/r/${'z'.repeat(43)}/report.json`, { 'cf-connecting-ip': '198.51.100.77' }); return [r.status, Date.now() - t0]; };
  const one = await tm(), two = await tm();
  check('the first refusal (404) and the rate-limited one (429) both wait the fixed time', one[0] === 404 && two[0] === 429 && one[1] >= 105 && two[1] >= 105, `${one} ${two}`);
  await s.close();
}
console.log('the image does not trust the proxy by itself');
{
  const df = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'deploy', 'Dockerfile'), 'utf8').split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('#')).join(String.fromCharCode(10));
  check('TRUST_PROXY is not baked into the Dockerfile', !/TRUST_PROXY/.test(df));
  const dc = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'deploy', 'docker-compose.example.yml'), 'utf8').split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('#'));
  check('the compose file sets TRUST_PROXY on purpose and publishes no ports', dc.some((l) => /TRUST_PROXY: "1"/.test(l)) && !dc.some((l) => /^\s*ports:/.test(l)));
  const deployDir = path.join(import.meta.dirname, '..', '..', 'deploy');
  const ymls = fs.readdirSync(deployDir).filter((n) => /[.]ya?ml$/.test(n));
  const lines = (n) => fs.readFileSync(path.join(deployDir, n), 'utf8').split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('#'));
  const badYml = ymls.filter((n) => { const t = lines(n); return t.some((l) => /^\s*ports:/.test(l)) || !t.some((l) => /TRUST_PROXY: "1"/.test(l)) || !t.some((l) => /read_only: true/.test(l)) || !t.some((l) => /no-new-privileges:true/.test(l)); });
  check('every deploy/*.yml publishes no ports and keeps TRUST_PROXY, read_only and no-new-privileges', ymls.length >= 8 && badYml.length === 0, badYml.join(', '));
  const both = lines('VPS-STACK-tunnel-both.yml').join(String.fromCharCode(10)), drop = lines('docker-compose.yml').join(String.fromCharCode(10));
  check('the both-containers stack: viewer volume read-only, ingest off by default and restarted with unless-stopped, no profiles', /- webobs-data:\/data:ro/.test(both) && /INGEST_ENABLED: \$\{INGEST_ENABLED:-0\}/.test(both) && !/on-failure/.test(both) && (both.match(/restart: unless-stopped/g) || []).length === 3 && !/profiles:/.test(both));
  const bind = lines('VPS-STACK-tunnel-both-bindmount.yml').join(String.fromCharCode(10));
  check('both main stack files include the required cleanup service (daily, data read-write, no network) and the audit cap names', [both, bind].every((s) => /container_name: webobs-cleanup/.test(s) && /node tools\/cleanup\.mjs --reports \/data\/reports --registry \/data\/registry/.test(s) && /network_mode: "none"/.test(s) && /INGEST_AUDIT_MAX_BYTES:/.test(s) && /INGEST_AUDIT_KEEP:/.test(s) && !/on-failure/.test(s)) && /restart: unless-stopped/.test(drop) && !/on-failure/.test(drop));
  const vars = { 'VPS-STACK-tunnel-both.yml': 2, 'docker-compose.yml': 2, 'VPS-STACK-ingest.yml': 1, 'VPS-STACK-ingest-tunnel-volume.yml': 1 };
  const badVars = Object.entries(vars).filter(([n, services]) => { const t = lines(n).join(String.fromCharCode(10)); return !/INGEST_REQUIRE_ACCESS_HEADER: \$\{INGEST_REQUIRE_ACCESS_HEADER:-1\}/.test(t) || !/INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: \$\{INGEST_ACKNOWLEDGE_NO_EDGE_AUTH:-\}/.test(t) || (t.match(/CLIENT_IP_HEADER: \$\{CLIENT_IP_HEADER:-CF-Connecting-IP\}/g) || []).length !== services || /INGEST_REQUIRE_ACCESS_HEADER: "0"|INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: "?yes/.test(t); }).map(([n]) => n);
  check('the stacks default to the Cloudflare Access check ON, no acknowledgment, and CF-Connecting-IP on every service', badVars.length === 0, badVars.join(', '));
  check('the drop-in compose: ingest and cleanup behind profiles, viewer volume read-only',/profiles: \["ingest"\]/.test(drop) && /profiles: \["cleanup"\]/.test(drop) && /- webobs-data:\/data:ro/.test(drop) && /INGEST_ENABLED: \$\{INGEST_ENABLED:-0\}/.test(drop));
}

console.log('headers on every response');
{
  const s = await boot();
  const paths = [`/api/r/${a.token}/report.json`, `/r/${a.token}`, `/r/${'x'.repeat(43)}`, `/api/r/${'x'.repeat(43)}/report.json`, '/', '/healthz', '/robots.txt', '/sitemap.xml', '/nope/nope'];
  const rs = []; for (const p of paths) rs.push([p, await s.get(p, p === '/healthz' ? {} : {})]);
  rs.push(['http', await s.get('/', { 'x-forwarded-proto': 'http' })]);
  rs.push(['post-bad', await s.post(`/api/r/${'x'.repeat(43)}/feedback`, {})]);
  const each = (fn) => rs.every(([, r]) => fn(r));
  const bad = (fn) => rs.filter(([, r]) => !fn(r)).map(([p]) => p).join(' ');
  check('X-Robots-Tag: noindex, nofollow, noarchive, nosnippet', each((r) => r.headers.get('x-robots-tag') === 'noindex, nofollow, noarchive, nosnippet'), bad((r) => r.headers.get('x-robots-tag') === 'noindex, nofollow, noarchive, nosnippet'));
  check('Cache-Control: no-store', each((r) => r.headers.get('cache-control') === 'no-store'));
  check('Referrer-Policy: no-referrer', each((r) => r.headers.get('referrer-policy') === 'no-referrer'));
  check('nothing may be framed or sniffed', each((r) => r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff'));
  check('the content security policy allows no third-party address', each((r) => { const c = r.headers.get('content-security-policy') || ''; return c.includes("default-src 'self'") && !/https?:/.test(c); }));
  const page = await (await s.get(`/r/${a.token}`)).text();
  check('the viewer page repeats the robots meta tag and has no third-party script, font or analytics', !/(?:src|href)=["']https?:/i.test(page));
  const viewerSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'viewer', 'index.html'), 'utf8');
  check('the viewer shell has the robots and referrer meta tags', /name="robots" content="noindex, nofollow, noarchive, nosnippet"/.test(viewerSrc) && /name="referrer" content="no-referrer"/.test(viewerSrc));
  const rb = await (await s.get('/robots.txt')).text();
  check('robots.txt only disallows; there is no sitemap', /Disallow: \//.test(rb) && (await s.get('/sitemap.xml')).status === 403 && !/sitemap/i.test(rb));
  await s.close();
}

console.log('report source adapters');
{
  const { dirSource, httpsSource, reportIdOf, makeSource } = await import('./source.mjs');
  const id1 = 'a1'.repeat(16), id2 = 'b2'.repeat(16);
  check('only a random file id is accepted as a name', reportIdOf(id1 + '.json') === id1 && reportIdOf('../x.json') === null && reportIdOf('p/' + id1 + '.json') === null && reportIdOf(id1) === null && reportIdOf(id1.toUpperCase() + '.json') === null && reportIdOf(id1.slice(1) + '.json') === null);

  // directory adapter
  const rd = path.join(dir, 'src-dir'); fs.mkdirSync(path.join(rd, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(rd, id1 + '.json'), '{"x":1}'); fs.writeFileSync(path.join(dir, 'outside.json'), 'secret'); fs.writeFileSync(path.join(rd, id2 + '.json'), 'x'.repeat(200));
  const ds = dirSource(rd, { maxBytes: 100 });
  check('directory: reads a file by id', (await ds.read(id1))?.text === '{"x":1}');
  check('directory: nothing but an id is read (no path, no dots, no names)', (await ds.read('../outside')) === null && (await ds.read('sub')) === null && (await ds.read('..%2foutside')) === null && (await ds.read(id1 + '.json')) === null);
  check('directory: a missing file and an oversize file are both just null', (await ds.read('f'.repeat(32))) === null && (await ds.read(id2)) === null);

  // https adapter, with a stand-in for the network (no connection is made)
  const calls = [];
  const reply = (over = {}) => ({ status: over.status ?? 200, headers: new Headers({ 'content-type': 'application/json' }), ...(over.headers ? { headers: over.headers } : {}), body: new Response(over.body ?? '{"y":2}').body });
  const mkFetch = (fn) => async (u, init) => { calls.push({ u, init }); return fn(u, init); };
  const BASE = 'https://reports.example.test/data';
  const hs = (fn, extra = {}) => httpsSource({ base: BASE, token: 'tok_secret_value', fetchImpl: mkFetch(fn), ...extra });
  const got = await hs(() => reply()).read(id1);
  check('https: GETs <base>/<id>.json with the bearer token, no redirects, a time limit', got?.text === '{"y":2}' && calls[0].u === `${BASE}/${id1}.json` && calls[0].init.headers.Authorization === 'Bearer tok_secret_value' && calls[0].init.redirect === 'manual' && calls[0].init.signal instanceof AbortSignal);
  check('https: the token is sent in the header only, never in the address', !calls[0].u.includes('tok_secret_value'));
  const noTok = httpsSource({ base: BASE, fetchImpl: mkFetch(() => reply()) }); calls.length = 0; await noTok.read(id1);
  check('https: with no token configured no Authorization header is sent', !('Authorization' in calls[0].init.headers));
  calls.length = 0;
  check('https: only an id can be requested (nothing from a request reaches the address)', (await hs(() => reply()).read('../../etc/passwd')) === null && (await hs(() => reply()).read('a/b')) === null && calls.length === 0);
  check('https: a redirect is not followed, whoever it points to', (await hs(() => reply({ status: 302, headers: new Headers({ location: 'https://evil.example.test/x' }) })).read(id1)) === null);
  check('https: not found, forbidden and server errors are just null', (await Promise.all([404, 403, 401, 500, 204].map((st) => hs(() => reply({ status: st })).read(id1)))).every((x) => x === null));
  check('https: a network failure or a timeout is just null', (await hs(async () => { throw new Error('ECONNREFUSED secret detail'); }).read(id1)) === null && (await hs(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }).read(id1)) === null);
  check('https: a body that says it is too big is refused before reading', (await hs(() => reply({ headers: new Headers({ 'content-length': '999999999' }) }), { maxBytes: 1000 }).read(id1)) === null);
  check('https: a body that lies about its size is cut off at the cap', (await hs(() => reply({ body: 'z'.repeat(5000) }), { maxBytes: 1000 }).read(id1)) === null);
  check('https: Last-Modified becomes the file time (for retention)', (await hs(() => reply({ headers: new Headers({ 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' }) })).read(id1))?.mtimeMs === Date.parse('Wed, 01 Jan 2025 00:00:00 GMT'));
  for (const bad of ['http://reports.example.test', 'ftp://x.test', 'not a url', '', 'https://user:pw@reports.example.test', 'https://reports.example.test/?a=1', 'https://reports.example.test/#x']) {
    if ((await httpsSource({ base: bad, fetchImpl: mkFetch(() => reply()) }).read(id1)) !== null) check('https: refuses the setting ' + JSON.stringify(bad), false);
  }
  check('https: plain http and addresses with a login, query or fragment are refused', true);

  // Through the server: the source decides, the answer stays the same plain refusal
  const regDir = path.join(dir, 'src-registry'); fs.mkdirSync(regDir, { recursive: true });
  const tok = newToken();
  fs.writeFileSync(path.join(regDir, 'lnk1.json'), JSON.stringify({ id: 'lnk1', tokenHash: hashToken(tok), path: id1 + '.json', expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false }));
  const mkSrv = async (fetchImpl, over = {}) => {
    const { server } = createServer({ reportSource: 'https', reportSourceUrl: BASE, reportSourceToken: 'tok_secret_value', sourceFetch: fetchImpl, registryDir: regDir, appFile: path.join(dir, 'app.html'), outboxDir: outbox, feedbackTo: 'feedback@agency.example', trustProxy: true, deniedDelayMs: 0, ...over });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { get: (p) => fetch(base + p, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' } }), close: () => new Promise((r) => server.close(r)) };
  };
  const okReport = JSON.stringify(synthetic());
  const up = await mkSrv(async () => reply({ body: okReport }));
  const r1 = await up.get(`/api/r/${tok}/report.json`);
  check('server with an https source: a valid link serves the report', r1.status === 200 && (await r1.json()).format === 'webobs.client-report');
  const page = await up.get(`/r/${tok}`);
  check('server with an https source: the viewer page opens', page.status === 200);
  await up.close();
  const down = await mkSrv(async () => { throw new Error('ENOTFOUND reports.example.test'); });
  const dr = await down.get(`/api/r/${tok}/report.json`); const dp = await down.get(`/r/${tok}`); const dpt = await dp.text();
  check('an unavailable source gives the same refusal and no detail', dr.status === 404 && (await dr.text()) === 'Access denied' && dp.status === 403 && /<h1>This link is not available\. Please request a fresh one\.<\/h1>/.test(dpt) && !/ENOTFOUND|example\.test|source/i.test(dpt));
  await down.close();
  const old = await mkSrv(async () => reply({ body: okReport, headers: new Headers({ 'last-modified': new Date(Date.now() - 100 * 86400000).toUTCString() }) }));
  check('retention applies to an https source that sends Last-Modified', (await old.get(`/api/r/${tok}/report.json`)).status === 404);
  await old.close();
  const evil = await mkSrv(async () => reply({ status: 301, headers: new Headers({ location: 'https://evil.example.test/x' }) }));
  check('a redirecting source is refused', (await evil.get(`/api/r/${tok}/report.json`)).status === 404);
  await evil.close();
  const wrongFormat = await mkSrv(async () => reply({ body: JSON.stringify({ format: 'webobs.explore-pack' }) }));
  check('a source returning an explore pack is refused', (await wrongFormat.get(`/api/r/${tok}/report.json`)).status === 404);
  await wrongFormat.close();
  check('the registry is read from its own folder, not from the report source', calls.every((c) => c.u.startsWith(BASE + '/') && c.u.endsWith('.json')) && !calls.some((c) => c.u.includes('lnk1')));
  check('the adapter comes from configuration only', makeSource({ reportSource: 'directory', reportsDir: rd }).kind === 'directory' && makeSource({ reportSource: 'https', reportSourceUrl: BASE, sourceFetch: async () => reply() }).kind === 'https' && makeSource({ reportSource: 'ftp' }).kind === 'unavailable');
  const { loadConfig, describeSetup } = await import('./server.mjs');
  check('REPORT_SOURCE defaults to a directory and /data/reports', loadConfig({}).reportSource === 'directory' && loadConfig({}).reportsDir.endsWith(path.join('data', 'reports')));
  const notes = describeSetup(loadConfig({ REPORT_SOURCE: 'https', REPORT_SOURCE_URL: 'http://plain.example.test', REPORT_SOURCE_TOKEN: 'sekrit-token', WEBOBS_REPORT_BASE: 'http://audit.example.test' }), true).join(NL2);
  check('start-up notes name a bad source and a non-https public address, and print no value', /REPORT_SOURCE_URL is not usable/.test(notes) && /WEBOBS_REPORT_BASE should start with https/.test(notes) && !/sekrit-token|plain\.example/.test(notes));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall report server checks passed');
process.exit(failed ? 1 : 0);

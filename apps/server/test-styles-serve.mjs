// Serve-time tests for a report's styles: injected into the first bytes, headers identical with and without styles, refusals unchanged, never breaks the page.
// Synthetic data only. Foreground; nothing is left running.   node apps/server/test-styles-serve.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';
import { hashToken, newToken } from './tokens.mjs';
import { createStyleInjector, MARKER } from './styles-inject.mjs';
import { stylesHash } from '../viewer/brand/styles-hash.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
async function listenFetchable(server) {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const { port } = server.address(); if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise((r) => server.close(r));
  }
  throw new Error('no usable port');
}
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-srv-styles-'));
const reportsDir = path.join(dir, 'reports'), registryDir = path.join(dir, 'registry');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Website review</title>' + MARKER + '<style>body{margin:0}</style></head><body><div id="root"></div><script>/* app */</script></body></html>';
const BAKED = PAGE.replace('</head>', '<style id="brand-tokens">.baked{color:red}</style></head>');
const writeApp = (name, html) => { const p = path.join(dir, name); fs.writeFileSync(p, html); return p; };
const appPlain = writeApp('app.html', PAGE);
const base = JSON.parse(fs.readFileSync(path.join(here, '../../fixtures/client-report.sample.json'), 'utf8'));
const STYLES = { accent: '#F2994A', secondary: '#2ECDF5', link: '#23AEEB', text: '#C4C4C4', muted: '#6B6B6B', surface: '#101010', headingFont: 'Oswald', bodyFont: 'Inter', headingCase: 'uppercase', name: 'Example Agency', footerText: 'Prepared by Example Agency' };
const addReport = (patch) => {
  const r = JSON.parse(JSON.stringify(base)); patch?.(r);
  const fileId = crypto.randomBytes(16).toString('hex'), tok = newToken();
  fs.writeFileSync(path.join(reportsDir, fileId + '.json'), JSON.stringify(r));
  fs.writeFileSync(path.join(registryDir, fileId.slice(0, 8) + '.json'), JSON.stringify({ id: fileId.slice(0, 8), tokenHash: hashToken(tok), path: fileId + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false }));
  return tok;
};
const boot = async (over = {}) => {
  const { server } = createServer({ reportsDir, registryDir, appFile: appPlain, outboxDir: path.join(dir, 'outbox'), trustProxy: true, deniedDelayMs: 0, rateGeneral: 100000, rateBadToken: 100000, ...over });
  const b = `http://127.0.0.1:${await listenFetchable(server)}`;
  const req = async (p, init = {}) => { const r = await fetch(b + p, { ...init, headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9', ...(init.headers || {}) } }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, headers: Object.fromEntries([...r.headers.entries()]), buf, body: buf.toString('utf8') }; };
  return { get: (p) => req(p), req, close: () => new Promise((r) => server.close(r)) };
};
const withoutBodyHeaders = (h) => { const c = { ...h }; delete c['content-length']; delete c.date; return c; };
const logs = []; const origLog = console.log;
const capture = async (fn) => { logs.length = 0; console.log = (...a) => { logs.push(a.join(' ')); }; try { return await fn(); } finally { console.log = origLog; } };

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

console.log('a report with styles: the page carries them in its first bytes');
{
  const plainTok = addReport(), styledTok = addReport((r) => { r.styles = STYLES; });
  const s = await boot();
  const plain = await s.get(`/r/${plainTok}`), styled = await s.get(`/r/${styledTok}`);
  check('both pages are served', plain.status === 200 && styled.status === 200);
  check('a report without styles gets exactly the page as before (only the address attributes added)', plain.body === PAGE.replace('<html', `<html data-start="viewer" data-server-report="/api/r/${plainTok}/report.json" data-server-feedback="/api/r/${plainTok}/feedback"`));
  const iStyle = styled.body.indexOf('<style id="wo-styles">'), iJson = styled.body.indexOf('<script type="application/json" id="wo-brand">'), iBody = styled.body.indexOf('<body'), iApp = styled.body.indexOf('/* app */');
  check('the generated style and the JSON block come before the body and before the app script (no unstyled first paint)', iStyle > 0 && iJson > iStyle && iBody > iJson && iApp > iBody, `${iStyle} ${iJson} ${iBody}`);
  check('the title is replaced, not doubled', (styled.body.match(/<title>/g) || []).length === 1 && styled.body.includes('<title>Example Agency · Website health walkthrough</title>'));
  check('the marker is gone from the served page', !styled.body.includes(MARKER));
  check('the CSS variables are there, written by the server (accent, card, fonts embedded)', styled.body.includes('--rp-accent:#f2994a') && styled.body.includes('--rp-card-solid:#101010') && styled.body.includes('@font-face{font-family:"Oswald"') && /url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\)/.test(styled.body));
  const blockText = /<script type="application\/json" id="wo-brand">([^<]*)<\/script>/.exec(styled.body)?.[1] || '';
  let block = null; try { block = JSON.parse(blockText); } catch { /* checked below */ }
  check('the JSON block holds only the allow-listed presentation fields', block && JSON.stringify(Object.keys(block).sort()) === JSON.stringify(['accent', 'bodyFont', 'footer', 'headingCase', 'headingFont', 'name', 'v']));
  const hash = stylesHash(STYLES);
  check('no styles hash or part name is anywhere in the page', !styled.body.includes(hash) && !styled.body.includes('styles_') && !styled.body.includes('data_'));
  check('the stage background colour is not set by the styles', !/--bg\b/.test(styled.body.slice(iStyle, iBody)) && !styled.body.slice(iStyle, iBody).includes('#07090f'));
  const hs = withoutBodyHeaders(styled.headers), hp = withoutBodyHeaders(plain.headers);
  check('every response header is identical with and without styles (content length aside)', JSON.stringify(hs) === JSON.stringify(hp), JSON.stringify(Object.keys(hs).filter((k) => hs[k] !== hp[k])));
  check('the Content-Security-Policy is exactly the unchanged one', styled.headers['content-security-policy'] === CSP && plain.headers['content-security-policy'] === CSP);
  for (const h of ['cache-control', 'x-robots-tag', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'permissions-policy']) check(`${h} is set and the same`, Boolean(styled.headers[h]) && styled.headers[h] === plain.headers[h]);
  check('no ETag, Last-Modified or Range support on a styled page; no-store kept', !styled.headers.etag && !styled.headers['last-modified'] && !styled.headers['accept-ranges'] && styled.headers['cache-control'] === 'no-store');
  check('Content-Length is the byte length of the page', Number(styled.headers['content-length']) === styled.buf.length);
  const cond = await s.req(`/r/${styledTok}`, { headers: { 'if-none-match': '*', 'if-modified-since': new Date().toUTCString(), range: 'bytes=0-10' } });
  check('conditional and range headers are ignored (full page, 200)', cond.status === 200 && cond.buf.equals(styled.buf));
  const head = await s.req(`/r/${styledTok}`, { method: 'HEAD' }), headPlain = await s.req(`/r/${plainTok}`, { method: 'HEAD' });
  check('HEAD answers exactly as it does for a report without styles', head.status === headPlain.status && head.buf.length === 0 && (head.status === 200 ? head.headers['content-length'] === styled.headers['content-length'] : true));
  const rj = await s.get(`/api/r/${styledTok}/report.json`);
  check('report.json does not carry the styles back to the browser', rj.status === 200 && !('styles' in JSON.parse(rj.body)));
  await s.close();
}

console.log('a title with non-ASCII text: the length is in bytes');
{
  const tok = addReport((r) => { r.styles = { ...STYLES, name: 'Café 東京 😀 & <Co>' }; });
  const s = await boot(); const r = await s.get(`/r/${tok}`);
  check('Content-Length equals the bytes and the title is escaped', Number(r.headers['content-length']) === r.buf.length && r.buf.length > r.body.length && r.body.includes('<title>Café 東京 😀 &amp; &lt;Co&gt; · Website health walkthrough</title>'));
  const block = /id="wo-brand">([^<]*)</.exec(r.body)?.[1] || '';
  check('the JSON block is escaped and round-trips', !/[<>&]/.test(block) && JSON.parse(block).name === 'Café 東京 😀 & <Co>');
  await s.close();
}

console.log('refusals are unchanged and carry no styles');
{
  const styledTok = addReport((r) => { r.styles = STYLES; });
  const s = await boot();
  const wrong = newToken();
  const bad1 = await s.get(`/r/${wrong}`), bad2 = await s.get('/r/short'), bad3 = await s.get('/'), api1 = await s.get(`/api/r/${wrong}/report.json`);
  const expired = (() => { const t = newToken(); const fid = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(reportsDir, fid + '.json'), JSON.stringify({ ...base, styles: STYLES })); fs.writeFileSync(path.join(registryDir, 'ex' + fid.slice(0, 6) + '.json'), JSON.stringify({ id: 'ex', tokenHash: hashToken(t), path: fid + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), revoked: false })); return t; })();
  const revoked = (() => { const t = newToken(); const fid = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(reportsDir, fid + '.json'), JSON.stringify({ ...base, styles: STYLES })); fs.writeFileSync(path.join(registryDir, 'rv' + fid.slice(0, 6) + '.json'), JSON.stringify({ id: 'rv', tokenHash: hashToken(t), path: fid + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: true })); return t; })();
  const e = await s.get(`/r/${expired}`), rv = await s.get(`/r/${revoked}`);
  check('a wrong, an expired and a revoked link give the same bytes (the refusal page)', bad1.buf.equals(e.buf) && bad1.buf.equals(rv.buf) && bad1.buf.equals(bad2.buf) && bad1.buf.equals(bad3.buf) && bad1.status === 403);
  check('the refusal page and the data refusal carry no styles, no JSON block and no marker', ![bad1, api1, e, rv].some((x) => /wo-styles|wo-brand|rp-accent|Example Agency/.test(x.body)) && api1.status === 404);
  check('the refusal page headers equal those of a page served without styles in every security header', ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cache-control'].every((h) => bad1.headers[h] === (e.headers[h])));
  const noStylesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-srv-nostyles-'));
  fs.mkdirSync(path.join(noStylesDir, 'reports')); fs.mkdirSync(path.join(noStylesDir, 'registry'));
  const s2 = await boot({ reportsDir: path.join(noStylesDir, 'reports'), registryDir: path.join(noStylesDir, 'registry') });
  const baseline = await s2.get(`/r/${wrong}`);
  check('the refusal is byte-identical to the one from a server that has never held a styled report', baseline.buf.equals(bad1.buf) && JSON.stringify(withoutBodyHeaders(baseline.headers)) === JSON.stringify(withoutBodyHeaders(bad1.headers)));
  await s2.close(); await s.close();
}

console.log('bad styles never break a page, and the process stays up');
{
  const hostile = { accent: 'red</style><script>alert(1)</script>', text: 'url(http://example.invalid/x)', name: 'ok', __proto__x: 1, surface: ['#101010'] };
  const badTok = addReport((r) => { r.styles = hostile; }), protoTok = (() => { const t = newToken(); const fid = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(reportsDir, fid + '.json'), JSON.stringify(base).replace(/}$/, ',"styles":{"__proto__":{"polluted":1},"accent":"#112233"}}')); fs.writeFileSync(path.join(registryDir, 'pp' + fid.slice(0, 6) + '.json'), JSON.stringify({ id: 'pp', tokenHash: hashToken(t), path: fid + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false })); return t; })();
  const plainTok = addReport();
  const s = await boot();
  const out = await capture(async () => ({ bad: await s.get(`/r/${badTok}`), proto: await s.get(`/r/${protoTok}`), plain: await s.get(`/r/${plainTok}`) }));
  const norm = (x, tok) => x.body.split(tok).join('T');
  check('styles that do not pass: the page is served complete and neutral (same as a report without styles)', out.bad.status === 200 && norm(out.bad, badTok) === norm(out.plain, plainTok) && out.proto.status === 200 && norm(out.proto, protoTok) === norm(out.plain, plainTok));
  check('a reason code was logged, and nothing but the code (no styles text, no path, no link)', logs.some((l) => l === '[styles] styles-invalid') && logs.every((l) => /^\[styles\] [a-z-]{1,40}$/.test(l)));
  check('the prototype was not polluted', ({}).polluted === undefined);
  const again = await capture(async () => { for (let i = 0; i < 5; i++) await s.get(`/r/${badTok}`); });
  check('the same problem is logged at most once a minute', logs.length === 0);
  await s.close();
}

console.log('the injector itself cannot break the page');
{
  const tok = addReport((r) => { r.styles = STYLES; });
  const throwing = { inject() { throw new Error('boom'); } };
  const s = await boot({ styleInjector: throwing });
  const r = await capture(() => s.get(`/r/${tok}`));
  check('an injector that throws on purpose: the visitor still gets a complete page, a code is logged, the server keeps answering', r.status === 200 && r.body.includes('</html>') && !r.body.includes('wo-styles') && logs.includes('[styles] inject-error') && (await s.get('/healthz')).status === 200);
  await s.close();
  const noMarker = writeApp('nomarker.html', PAGE.replace(MARKER, '')), twice = writeApp('twice.html', PAGE.replace(MARKER, MARKER + MARKER)), apart = writeApp('apart.html', PAGE.replace('</title>' + MARKER, '</title><meta name="x">' + MARKER));
  for (const [name, f] of [['missing', noMarker], ['twice', twice], ['not right after the title', apart]]) {
    const s2 = await boot({ appFile: f }); const x = await capture(() => s2.get(`/r/${tok}`));
    check(`marker ${name}: the page is served neutral and a code is logged`, x.status === 200 && !x.body.includes('wo-styles') && logs.includes('[styles] marker'));
    await s2.close();
  }
  const real = path.join(here, '../../apps/viewer/../../dist-report/report.html');
  if (fs.existsSync(real)) {
    const html = fs.readFileSync(real, 'utf8');
    check('the built viewer page holds the marker exactly once, right after its title', html.split(MARKER).length === 2 && html.includes('</title>' + MARKER));
    const inj = createStyleInjector({ fontsDir: path.join(here, 'fonts') }).inject(html, STYLES);
    check('and the injector accepts the built page', inj.used === true && inj.html.includes('id="wo-styles"') && !inj.html.includes(MARKER) && (inj.html.match(/<title>/g) || []).length === (html.match(/<title>/g) || []).length);
  } else console.log('  skip the built page check (build it first with npm run build)');
}

console.log('a page that was built with its own brand: the report styles replace it');
{
  const tok = addReport((r) => { r.styles = STYLES; });
  const s = await boot({ appFile: writeApp('baked.html', BAKED) }); const r = await s.get(`/r/${tok}`);
  check('the build\'s own style block is removed and the report\'s block is in', r.status === 200 && !r.body.includes('id="brand-tokens"') && !r.body.includes('.baked{') && r.body.includes('id="wo-styles"'));
  const plainTok = addReport(); const p = await s.get(`/r/${plainTok}`);
  check('without styles the build\'s own look is untouched', p.body.includes('<style id="brand-tokens">.baked{color:red}</style>'));
  await s.close();
}

console.log('fonts come only from the bundled folder, by name');
{
  const tok = addReport((r) => { r.styles = { headingFont: 'Oswald', bodyFont: 'Inter' }; });
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-fonts-'));
  fs.writeFileSync(path.join(bad, 'Oswald.woff2'), Buffer.from('not a font at all, and long enough to pass the size check............'));
  fs.writeFileSync(path.join(bad, 'Inter-Regular.woff2'), Buffer.alloc(0));
  const s = await boot({ fontsDir: bad }); const r = await capture(() => s.get(`/r/${tok}`));
  check('a font file with the wrong magic bytes, or an empty one, or a missing one, is left out; the page and the other variables are still served', r.status === 200 && !r.body.includes('@font-face') && r.body.includes('--rp-font-heading:') && logs.includes('[styles] font-unreadable'));
  await s.close();
  const fonts = ['Oswald.woff2', 'Inter-Regular.woff2', 'Inter-SemiBold.woff2'].map((f) => fs.readFileSync(path.join(here, 'fonts', f)));
  check('the bundled fonts in the repository are real woff2 files under the size cap', fonts.every((b) => b.subarray(0, 4).toString('latin1') === 'wOF2' && b.length > 1000 && b.length < 200 * 1024));
}

console.log(failed ? `${failed} check(s) FAILED` : 'all styles serve checks passed');
process.exit(failed ? 1 : 0);

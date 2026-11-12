// Real-browser check of a report that carries its own look (styles), served through the token server. Foreground and self-terminating.
//   node apps/server/e2e-styles.mjs <client-report.json> [screenshot-folder]      (after npm run report:build)
// Checks: the look is in the first paint (nothing changes after the card first appears), no policy violations, fonts ready before the first draw,
// the header holds the client name only (no agency name), a report's own accent wins, the neutral look is untouched, and the phone-width header is balanced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from './server.mjs';
import { hashToken, newToken } from './tokens.mjs';
import crypto from 'node:crypto';

const reportFile = process.argv[2], shots = process.argv[3];
if (!reportFile || !fs.existsSync('dist-report/report.html')) { console.error('usage: node apps/server/e2e-styles.mjs <client-report.json> [screenshot-folder]  (after npm run report:build)'); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-e2e-styles-'));
const reportsDir = path.join(dir, 'reports'), registryDir = path.join(dir, 'registry'); fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
const base0 = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const AGENCY = { accent: '#F2994A', secondary: '#2ECDF5', link: '#23AEEB', text: '#C4C4C4', muted: '#6B6B6B', surface: '#101010', headingFont: 'Oswald', bodyFont: 'Inter', headingCase: 'uppercase', name: 'Example Agency', footerText: 'Prepared by Example Agency' };
const add = (patch) => { const r = JSON.parse(JSON.stringify(base0)); patch(r); const f = crypto.randomBytes(16).toString('hex'), t = newToken(); fs.writeFileSync(path.join(reportsDir, f + '.json'), JSON.stringify(r)); fs.writeFileSync(path.join(registryDir, f.slice(0, 8) + '.json'), JSON.stringify({ id: f.slice(0, 8), tokenHash: hashToken(t), path: f + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false })); return t; };
const tokens = {
  agency: add((r) => { r.styles = AGENCY; }),
  neutral: add(() => {}),
  client: add((r) => { r.styles = { accent: '#7DD3A8', surface: '#14181f', text: '#E6EAF0', name: 'Harbour Studio' }; }),
  override: add((r) => { r.styles = AGENCY; r.client = { ...r.client, accent: '#FF3399' }; }),
  lightcard: add((r) => { r.styles = { accent: '#5cff8d', secondary: '#d4f52e', surface: '#f7f7f7', text: '#323334', muted: '#707070', cardText: '#323334', name: 'Harbour Studio' }; }),
  redcard: add((r) => { r.styles = { accent: '#5cff8d', surface: '#d52924', text: '#323334', name: 'Harbour Studio' }; }),
};
const { server } = createServer({ port: 0, reportsDir, registryDir, appFile: path.resolve('dist-report/report.html'), outboxDir: path.join(dir, 'outbox'), feedbackTo: 'feedback@agency.example', requireHttps: false, deniedDelayMs: 0 });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const cp = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cp}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--user-data-dir=' + path.join(dir, 'prof'), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 40; i++) { try { t = await (await fetch(`http://127.0.0.1:${cp}/json`)).json(); if (t.length) break; } catch { /* starting */ } await sleep(250); }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.result?.value;
await send('Runtime.enable'); await send('Page.enable');
let failed = 0; const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  ' + d : ''}`); };

// Recorders that run before the page's own scripts: policy violations, and what the card looks like from the first moment it exists.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__viol = []; document.addEventListener('securitypolicyviolation', (e) => window.__viol.push(e.violatedDirective + ' ' + e.blockedURI));
  window.__seen = []; window.__font0 = null;
  const sample = () => { const c = document.querySelector('.pv-card'); if (!c) return false;
    const h = c.querySelector('h2'); const cs = getComputedStyle(c);
    window.__seen.push({ bg: cs.backgroundColor, edge: cs.borderTopColor, accent: getComputedStyle(document.querySelector('.rp-root')).getPropertyValue('--rp-accent').trim(), hFont: h ? getComputedStyle(h).fontFamily : '', hCase: h ? getComputedStyle(h).textTransform : '', root: getComputedStyle(document.querySelector('.rp-root')).backgroundColor });
    if (window.__font0 === null) window.__font0 = document.fonts.check('600 1em "Oswald"') && document.fonts.check('400 1em "Inter"');
    return true; };
  let frames = 0; const tick = () => { sample(); if (frames++ < 90) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
` });

const open = async (tok, w = 1280, h = 800) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await send('Page.navigate', { url: `${base}/r/${tok}` });
  for (let i = 0; i < 60 && !(await ev("!!document.querySelector('.pv-card')")); i++) await sleep(500);
  await sleep(2200);
};
const snap = async (name) => { if (!shots) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64')); };
const info = async () => JSON.parse(await ev(`JSON.stringify({
  title: document.title, htmlBg: getComputedStyle(document.documentElement).backgroundColor, root: getComputedStyle(document.querySelector('.rp-root')).backgroundColor,
  card: getComputedStyle(document.querySelector('.pv-card')).backgroundColor, edge: getComputedStyle(document.querySelector('.pv-card')).borderTopColor,
  h2: (document.querySelector('.pv-card h2') ? getComputedStyle(document.querySelector('.pv-card h2')).fontFamily : ''), body: getComputedStyle(document.querySelector('.pv-card p, .pv-card')).fontFamily,
  btn: (document.querySelector('.pv-btn.primary') ? getComputedStyle(document.querySelector('.pv-btn.primary')).backgroundColor : ''),
  footer: document.querySelector('.pv-footer')?.textContent || '', agency: !!document.querySelector('.rp-agency'), header: document.querySelector('.rp-brand-mini')?.textContent || '',
  styled: !!document.getElementById('wo-styles'), block: document.getElementById('wo-brand')?.textContent || '', viol: window.__viol, seen: window.__seen, font0: window.__font0,
  scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth })`));

console.log('an agency look carried by the report');
await open(tokens.agency); await snap('agency-desktop');
const a = await info();
check('the page opens with the look in its first bytes (the style and block exist, the title is the agency title)', a.styled && a.title.includes('Example Agency') && a.block.includes('Example Agency'), a.title);
check('the page and stage background is the original dark, the card is the styles surface', a.root === 'rgb(7, 9, 15)' && a.htmlBg === 'rgb(7, 9, 15)' && a.card === 'rgb(16, 16, 16)', `${a.root} ${a.card}`);
check('the card has the edge line', /^rgba\(196, 196, 196, 0\.2\d*\)$/.test(a.edge), a.edge);
check('the heading uses the bundled heading font and the body the bundled body font', /Oswald/.test(a.h2) && /Inter/.test(a.body), `${a.h2} | ${a.body}`);
check('the accent is the styles accent', a.btn === 'rgb(242, 153, 74)', a.btn);
check('the footer names the agency once and the header holds the client name only (no agency name, no divider)', a.footer === 'Prepared by Example Agency' && !a.agency && !/Example Agency/.test(a.header) && a.header.length > 0, a.header);
check('no policy violations on the branded load', a.viol.length === 0, JSON.stringify(a.viol));
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
const distinct = (k) => new Set(a.seen.map((s) => s[k]));
check('from the moment the card first exists nothing changes: same background, edge, accent, root colour, heading font and case in every frame', a.seen.length > 20 && ['bg', 'edge', 'accent', 'hFont', 'hCase', 'root'].every((k) => distinct(k).size === 1), `${a.seen.length} frames, ${['bg', 'edge', 'accent', 'hFont', 'hCase', 'root'].map((k) => distinct(k).size).join('')}`);
check('the fonts were ready when the card first appeared (no font swap after the first draw)', a.font0 === true);
check('the heading is upper-case from the first frame', a.seen[0]?.hCase === 'uppercase');
const html = await (await fetch(`${base}/r/${tokens.agency}`)).text();
check('the served page holds no external address for styles, fonts or scripts', !/(href|src)=["']https?:\/\//.test(html) && !/url\(https?:/.test(html));

console.log('a client look (another accent, own surface) and a report accent that wins');
await open(tokens.client); await snap('client-desktop');
const c = await info();
check('a different look from the same server: its accent, its card, its title; no agency fonts', c.btn === 'rgb(125, 211, 168)' && c.card === 'rgb(20, 24, 31)' && c.title.includes('Harbour Studio') && c.root === 'rgb(7, 9, 15)' && !/Oswald/.test(c.h2), JSON.stringify({ btn: c.btn, card: c.card, title: c.title }));
await open(tokens.override); const o = await info();
check('a report\'s own accent (client.accent) wins over the styles accent; the rest of the look stays', o.btn === 'rgb(255, 51, 153)' && o.card === 'rgb(16, 16, 16)', o.btn);

console.log('text on cards (v0.1.6): a light card carries dark card text while the page text stays light on the dark stage');
await open(tokens.lightcard); await snap('lightcard-desktop');
const lc = await ev("JSON.stringify((() => { const col = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).color : null; }; const bg = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).backgroundColor : null; }; return { card: col('.pv-card h2') || col('.pv-card'), cardBg: bg('.pv-card'), muted: col('.pv-card .pv-small') || col('.pv-card .pv-step'), top: col('.rp-brand-mini'), root: bg('.rp-root') }; })())");
const L = JSON.parse(lc);
check('the text on the light card is the card text (dark), on the card color', L.card === 'rgb(50, 51, 52)' && L.cardBg === 'rgb(247, 247, 247)', lc);
check('the page text outside the cards is still light on the dark stage', L.root === 'rgb(7, 9, 15)' && L.top && Number(L.top.match(/[0-9]+/g)[0]) > 120, lc);
await open(tokens.redcard);
const rc = await ev("JSON.stringify({ card: getComputedStyle(document.querySelector('.pv-card h2') || document.querySelector('.pv-card')).color, bg: getComputedStyle(document.querySelector('.pv-card')).backgroundColor })");
const R = JSON.parse(rc);
check('a red card without cardText still shows the light page text on it (unchanged behavior)', R.bg === 'rgb(213, 41, 36)' && Number(R.card.match(/[0-9]+/g)[0]) > 200, rc);

// Severity chips, warning boxes, links, the second color, the muted text and the muted label chip inside the cards, measured in the real page against the card as drawn (v0.1.6 and 0.1.7 reviews): a light card, a red card, and the default dark look.
const CONTRAST_JS = `JSON.stringify((() => {
  const parse = (s) => { const n = (s.match(/[0-9.]+/g) || []).map(Number); return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let acc = { r: 7, g: 9, b: 15, a: 1 }; for (let i = chain.length - 1; i >= 0; i--) acc = chain[i].a > 0 ? blend(chain[i], acc) : acc; return acc; };
  const result = {}; for (const [cname, csel] of [['tour', '.pv-card-body'], ['tour', '.pv-card'], ['bar', '.pv-bar-body']]) { const card = document.querySelector(csel); if (!card || result[cname]) continue; const host = document.createElement('div'); card.appendChild(host);
  host.innerHTML = '<span class="rp-chip sev-high">High</span> <span class="rp-chip sev-medium">Medium</span> <span class="rp-chip sev-low">Low</span> <span class="rp-chip warn">Warn</span> <div class="rp-notes-warn">A warning box</div> <p class="rp-caveat">Keep in mind: a caveat</p> <span class="rp-chip">Plain chip</span> <span class="rp-chip lab-INFER">Inferred</span> <span class="rp-chip lab-FETCH">Fetched</span> <span class="rp-chip lab-LAB">Lab note</span> <a class="pv-link" href="#">A link</a> <p class="pv-pagepath">Muted path text</p> <details open><summary>Second color</summary></details>';
  const out = {}; for (const host0 of host.children) { const el = host0.tagName === 'DETAILS' ? host0.querySelector('summary') : host0; const cs = getComputedStyle(el); const bg = bgOf(el); const fg = blend(parse(cs.color), bg); const L1 = lum(fg), L2 = lum(bg); out[cname + ': ' + host0.textContent.slice(0, 12)] = Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100; }
  host.remove(); result[cname] = out; } const flat = {}; for (const [c, o] of Object.entries(result)) Object.assign(flat, o); return flat; })())`;
for (const [name, tok, expectDark] of [['light card', tokens.lightcard, false], ['red card', tokens.redcard, true], ['default dark look', tokens.agency, true]]) {
  await open(tok); const cc = JSON.parse(await ev(CONTRAST_JS)); const low = Object.entries(cc).filter(([, v]) => v < 4.5);
  check(`${name}: each severity chip, the warning chip, the warning box, the caveat, a plain chip, the muted label chips (Fetched, Lab), a link, the second color and the muted text inside the cards read at 4.5:1 or better`, Object.keys(cc).length >= 12 && low.length === 0, JSON.stringify(cc));
}

console.log('the neutral look is untouched');
await open(tokens.neutral); await snap('neutral-desktop');
const n = await info();
check('no styles: no style block, no JSON block, today\'s card colour and fonts, no footer', !n.styled && n.block === '' && n.card !== 'rgb(16, 16, 16)' && !/Oswald/.test(n.h2) && n.footer === '' && n.root === 'rgb(7, 9, 15)', JSON.stringify({ card: n.card, footer: n.footer }));
check('no policy violations and nothing in the header but the client name', n.viol.length === 0 && n.header.length > 0 && !n.agency);

console.log('phone width');
await open(tokens.agency, 390, 844); await snap('agency-phone');
const p = await info();
const box = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('.rp-brand-mini').getBoundingClientRect(); const t = document.querySelector('.rp-tools').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, toolsLeft: t.left, h: r.height }; })())`));
check('the header holds the client name inside the screen, clear of the tools, on one or two lines, and the page does not scroll sideways', box.left >= 0 && box.right <= 390 && box.right <= box.toolsLeft + 1 && box.h < 70 && p.scrollW <= p.innerW, JSON.stringify(box));
await open(tokens.neutral, 390, 844); await snap('neutral-phone');
await open(tokens.client, 390, 844); await snap('client-phone');

ws.close(); chrome.kill(); server.close(); await sleep(1500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the browser profile may still be closing */ }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nstyles end-to-end checks passed');
process.exit(failed ? 1 : 0);

// End-to-end check of the page card (v0.1.5): in a real browser, clicking a page on the map opens a card with the page, the findings that touch it, "Jump to this step" and "Back to tour".
// Same set-up as e2e.mjs (token server, headless Chrome). Run: node apps/server/e2e-pagecard.mjs <client-report.json>  (after npm run report:build)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from './server.mjs';

const report = process.argv[2];
if (!report || !fs.existsSync('dist-report/report.html')) { console.error('usage: node apps/server/e2e-pagecard.mjs <client-report.json>  (after npm run report:build)'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-e2e-'));
const out = spawnSync(process.execPath, ['apps/server/tools/make-token.mjs', 'create', '--report', report, '--client', 'e2e', '--out', path.join(dir, 'staging'), '--index', path.join(dir, 'index.json'), '--base', 'https://x.test'], { encoding: 'utf8' });
const token = /\/r\/([A-Za-z0-9_-]+)/.exec(out.stdout)?.[1];
if (!token) { console.error(out.stderr || out.stdout); process.exit(1); }
const { server } = createServer({ port: 0, reportsDir: path.join(dir, 'staging', 'reports'), registryDir: path.join(dir, 'staging', 'registry'), appFile: path.resolve('dist-report/report.html'), outboxDir: path.join(dir, 'outbox'), feedbackTo: 'feedback@agency.example', requireHttps: false });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const cp = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cp}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--user-data-dir=' + path.join(dir, 'prof'), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 40; i++) { try { t = await (await fetch(`http://127.0.0.1:${cp}/json`)).json(); if (t.length) break; } catch { /* starting */ } await sleep(250); }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let holdMs = 0; let fetchAnswer = null; let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Fetch.requestPaused' && fetchAnswer) { const rid = d.params.requestId; ws.send(JSON.stringify({ id: ++id, method: fetchAnswer.fail ? 'Fetch.failRequest' : 'Fetch.fulfillRequest', params: fetchAnswer.fail ? { requestId: rid, errorReason: 'Failed' } : { requestId: rid, responseCode: fetchAnswer.code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(fetchAnswer.body).toString('base64') } })); } else if (d.method === 'Fetch.requestPaused') { const rid = d.params.requestId; setTimeout(() => ws.send(JSON.stringify({ id: ++id, method: 'Fetch.continueRequest', params: { requestId: rid } })), holdMs); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? ''); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.result?.value;
await send('Runtime.enable'); await send('Page.enable');
let failed = 0; const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  ' + d : ''}`); };

await send('Page.navigate', { url: `${base}/r/${token}` });
for (let i = 0; i < 40 && !(await ev("!!document.querySelector('.pv-card')")); i++) await sleep(500);
check('the viewer opens', await ev("!!document.querySelector('.pv-card')"));
await ev("document.querySelectorAll('.pv-dots button')[1]?.click()"); await sleep(1500);

const pillRects = () => ev("JSON.stringify([...document.querySelectorAll('.wo-node-pill')].filter(p=>!p.classList.contains('is-hidden')).map(p=>{const r=p.getBoundingClientRect();return {id:p.dataset.nodeId,x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};}).filter(r=>r.w>4&&r.h>4&&r.x>0&&r.y>70&&r.x<window.innerWidth-20&&r.y<window.innerHeight-20))");
const clickAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };
let pills = []; for (let i = 0; i < 30 && pills.length < 2; i++) { pills = JSON.parse((await pillRects()) || '[]'); if (pills.length < 2) await sleep(500); }
check('the map shows clickable page labels', pills.length >= 2, `${pills.length} labels`);
const BG0 = await ev("getComputedStyle(document.querySelector('.rp-globe-layer')).backgroundColor + '|' + getComputedStyle(document.querySelector('.rp-root')).backgroundColor");
const cardOpen = () => ev("!!document.querySelector('[data-testid=page-card]')");
const topCard = (p) => clickAt(p.x, p.y).then(() => sleep(500));

await topCard(pills[0]);
check('clicking a page opens the page card', await cardOpen());
check('the card is a labelled dialog that names the page', await ev("(()=>{const c=document.querySelector('[data-testid=page-card]');return !!c && c.getAttribute('role')==='dialog' && /^Page: /.test(c.getAttribute('aria-label')||'') && !!c.querySelector('h2')?.textContent;})()"));
check('keyboard focus moves to the card', await ev("document.activeElement===document.querySelector('[data-testid=page-card]')"));
check('it has a Back to tour button and a findings list or a plain no-issue line', await ev("(()=>{const c=document.querySelector('[data-testid=page-card]');return [...c.querySelectorAll('button')].some(b=>b.textContent==='Back to tour') && (!!c.querySelector('ul') || /did not flag anything/.test(c.textContent));})()"));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(400);
check('Escape closes the card and the tour card gets focus back', !(await cardOpen()) && await ev("document.activeElement===document.querySelector('.pv-card')"));
check('the tour did not move', await ev("/Step 2 of/.test(document.querySelector('.pv-step')?.textContent||'')"));

pills = JSON.parse((await pillRects()) || '[]');
await topCard(pills[0]);
await ev("[...document.querySelectorAll('[data-testid=page-card] button')].find(b=>b.textContent==='Back to tour')?.click()"); await sleep(300);
check('Back to tour closes the card', !(await cardOpen()));

// Find a page that a step covers and use Jump.
let jumped = false, before = '';
for (const p of JSON.parse((await pillRects()) || '[]').slice(0, 25)) {
  await topCard(p);
  if (await ev("!![...document.querySelectorAll('[data-testid=page-card] button')].find(b=>b.textContent==='Jump to this step')")) {
    before = await ev("document.querySelector('.pv-step')?.textContent || ''");
    await ev("[...document.querySelectorAll('[data-testid=page-card] button')].find(b=>b.textContent==='Jump to this step')?.click()"); await sleep(1200);
    jumped = true; break;
  }
  await ev("[...document.querySelectorAll('[data-testid=page-card] button')].find(b=>b.textContent==='Back to tour')?.click()"); await sleep(250);
}
check('a page covered by a step offers Jump to this step, and it closes the card and goes to that step', jumped && !(await cardOpen()) && /^Step \d+ of \d+$/.test(await ev("document.querySelector('.pv-step')?.textContent||''")), `before "${before}", after "${await ev("document.querySelector('.pv-step')?.textContent||''")}"`);
check('the stage background is unchanged by the card', (await ev("getComputedStyle(document.querySelector('.rp-globe-layer')).backgroundColor + '|' + getComputedStyle(document.querySelector('.rp-root')).backgroundColor")) === BG0, BG0);

// Phone width.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(1500);
await ev("document.querySelector('.pv-reopen')?.click()");
let ph = []; for (let i = 0; i < 20 && ph.length < 1; i++) { ph = JSON.parse((await pillRects()) || '[]'); if (!ph.length) await sleep(500); }
check('at 390 px wide the map still shows page labels', ph.length >= 1, `${ph.length}`);
if (ph.length) {
  await topCard(ph[0]);
  const geo = JSON.parse((await ev("(()=>{const c=document.querySelector('[data-testid=page-card]');if(!c)return 'null';const r=c.getBoundingClientRect();return JSON.stringify({l:r.left,r:r.right,b:r.bottom,sw:document.documentElement.scrollWidth});})()")) || 'null');
  check('on a phone the card fits the screen and the page does not scroll sideways', !!geo && geo.l >= 0 && geo.r <= 390 && geo.b <= 844 && geo.sw <= 390, JSON.stringify(geo));
}
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
ws.close(); chrome.kill(); server.close(); await sleep(1500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the browser profile may still be closing */ }
console.log(failed ? `\n${failed} check(s) FAILED` : '\npage card checks passed');
process.exit(failed ? 1 : 0);

// End-to-end check, foreground and self-terminating: the real viewer in headless Chrome, served through the token server,
// with a synthetic-free copy of the local test export. Needs the app built (npm run report:build). Run: node apps/server/e2e.mjs <client-report.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from './server.mjs';

const report = process.argv[2];
if (!report || !fs.existsSync('dist-report/report.html')) { console.error('usage: node apps/server/e2e.mjs <client-report.json>  (after npm run report:build)'); process.exit(2); }
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
check('the viewer opens from the link and loads the report through the server', await ev("!!document.querySelector('.pv-card')"));
check('there is no file picker in server mode', !(await ev("!!document.querySelector('input[type=file]')")));
// A refresh comes back to the same report and the same step.
await ev("document.querySelectorAll('.pv-dots button')[3]?.click()"); await sleep(1200);
await ev("document.querySelector('.pv-answers .pv-btn')?.click()"); await sleep(300);
const stepBefore = await ev("document.querySelector('.pv-step')?.textContent");
await send('Page.reload'); for (let i = 0; i < 40 && !(await ev("!!document.querySelector('.pv-card')")); i++) await sleep(500);
check('a refresh reloads the same report at the same step', (await ev("document.querySelector('.pv-step')?.textContent")) === stepBefore && Boolean(stepBefore), String(stepBefore));
check('and keeps the answer the client gave', await ev("document.querySelector('.pv-answers .pv-btn')?.getAttribute('aria-pressed')") === 'true');
// A refresh with the step in the address (#step=0 is the welcome screen) stays on that step and never shows a box that looks like a file drop.
await send('Page.navigate', { url: 'about:blank' }); await sleep(300);
await send('Page.navigate', { url: `${base}/r/${token}#step=0` }); for (let i = 0; i < 40 && !(await ev("!!document.querySelector('.pv-card')")); i++) await sleep(500);
check('the welcome screen is open at #step=0', /Step 1 of/i.test(await ev("document.querySelector('.pv-step')?.textContent") ?? '') && (await ev('location.hash')) === '#step=0');
holdMs = 2500; await send('Fetch.enable', { patterns: [{ urlPattern: '*report.json*', requestStage: 'Request' }] });
await send('Page.reload'); await sleep(1900); // the report is still on its way, and the one-second delay of the loading line has passed
const loading = JSON.parse(await ev(`JSON.stringify({ box: !!document.querySelector('.pv-dropbox'), text: document.body.innerText, file: !!document.querySelector('input[type=file]'), dashed: [...document.querySelectorAll('.pv-open, .pv-open *')].some((e) => getComputedStyle(e).borderTopStyle === 'dashed'), bg: getComputedStyle(document.documentElement).backgroundColor, line: !!document.querySelector('.pv-loading') })`));
check('while the report loads after a refresh there is no drop-style box and no file picker', !loading.box && !loading.dashed && !loading.file, JSON.stringify(loading));
check('the loading line is quiet: one short line, no "One moment" splash', loading.line && !/One moment|drop|choose a file/i.test(loading.text));
check('the page is dark from the first paint (no white flash)', /^rgb\(\d+, \d+, \d+\)$/.test(loading.bg) && loading.bg.match(/\d+/g).every((n) => Number(n) < 60), loading.bg);
holdMs = 0; await send('Fetch.disable');
for (let i = 0; i < 40 && !(await ev("!!document.querySelector('.pv-card')")); i++) await sleep(500);
check('then the report appears at the same step', /Step 1 of/i.test(await ev("document.querySelector('.pv-step')?.textContent") ?? '') && (await ev('location.hash')) === '#step=0');
await ev("document.querySelectorAll('.pv-dots button')[document.querySelectorAll('.pv-dots button').length-1]?.click()"); await sleep(1200);
const lastHash = await ev('location.hash'); await send('Page.reload'); for (let i = 0; i < 40 && !(await ev("!!document.querySelector('.pv-card')")); i++) await sleep(500);
check('a refresh on the feedback step stays on the feedback step', (await ev('location.hash')) === lastHash && /Tell us what you think|Step 12 of 12/i.test(await ev("document.querySelector('.pv-card')?.innerText") ?? ''), lastHash);
check('the last step offers Send, not mailto, Copy or Download', await ev("[...document.querySelectorAll('.pv-card .pv-btn, .pv-card a.pv-btn')].map(b=>b.textContent).join('|')") === 'Send my feedback to the team|Back|Finish');
await ev("[...document.querySelectorAll('.pv-card .pv-btn')].find(b=>b.textContent==='Send my feedback to the team')?.click()"); await sleep(1500);
const files = fs.existsSync(path.join(dir, 'outbox')) ? fs.readdirSync(path.join(dir, 'outbox')) : [];
const msg = files.length ? JSON.parse(fs.readFileSync(path.join(dir, 'outbox', files[0]), 'utf8')) : {};
check('Send delivers one message through the server', files.length === 1 && msg.to === 'feedback@agency.example');
check('the page tells the client it was sent to the team', /Your feedback was sent to the team/.test(await ev("document.body.innerText")));
const html = await (await fetch(`${base}/r/${token}`)).text();
check('the page itself carries no report data', !html.includes('"webobs.client-report"') || html.indexOf('"format":"webobs.client-report"') < 0);
// Every kind of failure shows the SAME line and the SAME page: nothing says which case it was.
const LINE = 'This link is not available. Please request a fresh one.';
const kinds = { 'a 404 answer': { code: 404, body: 'Access denied' }, 'a 200 that is not a report': { code: 200, body: '{"format":"other"}' }, 'broken JSON': { code: 200, body: '{nope' }, 'a newer report format': { code: 200, body: '{"format":"webobs.client-report","version":"9.0"}' }, 'a report with the wrong shape': { code: 200, body: '{"format":"webobs.client-report","version":"1.1","client":5}' }, 'the network failing': { fail: true } };
const seenKinds = {};
await send('Fetch.enable', { patterns: [{ urlPattern: '*report.json*', requestStage: 'Request' }] });
for (const [name, ans] of Object.entries(kinds)) {
  fetchAnswer = ans; await send('Page.navigate', { url: 'about:blank' }); await sleep(200); await send('Page.navigate', { url: `${base}/r/${token}` }); await sleep(2500);
  seenKinds[name] = JSON.parse(await ev("JSON.stringify({ text: document.body.innerText.trim(), html: document.querySelector('#root').innerHTML })"));
}
fetchAnswer = null; await send('Fetch.disable');
const firstKind = Object.values(seenKinds)[0];
check('every failure kind shows exactly the one unavailable line', Object.values(seenKinds).every((s) => s.text === LINE), JSON.stringify(Object.entries(seenKinds).map(([k, s]) => [k, s.text.slice(0, 40)])));
check('and the page is identical whatever the failure was (nothing reveals which case it was)', Object.values(seenKinds).every((s) => s.html === firstKind.html));
await send('Page.navigate', { url: 'file:///' + path.resolve('dist-report/report.html').split(String.fromCharCode(92)).join('/') + '#view' }); await sleep(2500);
const bare = await ev('document.body.innerText');
check('with no report the viewer shows only the one unavailable line, with no file picker and no hint', bare.trim() === 'This link is not available. Please request a fresh one.' && !(await ev("!!document.querySelector('input[type=file]')")));
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
ws.close(); chrome.kill(); server.close(); await sleep(1500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the browser profile may still be closing; the OS temp folder is cleaned later */ }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nend-to-end checks passed');
process.exit(failed ? 1 : 0);

// Real-browser check of the Studio's Publish, Archive capture and Revoke link buttons. Foreground and self-terminating:
// it starts its own report server, publish helper and static page server inside this process, drives headless Chrome, then closes
// everything. It uses temporary folders only (never your vault or the dev volume) and the capture you pass in, which is only read.
// Needs the app built (npm run report:build) and ports 4176 (page; set E2E_PAGE_PORT to use another) and 4178 (helper) free.
//   node apps/server/scripts/e2e-studio.mjs <path to a _site-graph.json>
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from '../server.mjs';
import { createHelper } from './publish-helper.mjs';
const PAGE_PORT = Number(process.env.E2E_PAGE_PORT) || 4176;

const capture = process.argv[2];
if (!capture || !fs.existsSync(capture) || !fs.existsSync('dist-report/report.html')) { console.error('usage: node apps/server/scripts/e2e-studio.mjs <_site-graph.json>   (after npm run report:build)'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  ' + d : ''}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-studio-'));
const volume = path.join(tmp, 'volume'), vault = path.join(tmp, 'vault');
for (const d of ['reports', 'registry']) fs.mkdirSync(path.join(volume, d), { recursive: true });
const put = (rel, text) => { const f = path.join(vault, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('sites/demo.test/_site-graph.json', '{}'); put('sites/demo.test/Pages/home.md', 'home'); put('sites/other.test/_site-graph.json', '{}');
put('.web-obs/history/demo.test/cap1/_site-graph.json', 'old');

// report server (what the client's link opens)
const rs = createServer({ port: 0, reportsDir: path.join(volume, 'reports'), registryDir: path.join(volume, 'registry'), appFile: path.resolve('dist-report/report.html'), requireHttps: false, outboxDir: path.join(tmp, 'outbox'), feedbackTo: 'feedback@agency.example' });
await new Promise((r) => rs.server.listen(0, '127.0.0.1', r));
const serverBase = `http://127.0.0.1:${rs.server.address().port}`;
// publish helper (what the Studio talks to), with the dev settings pointed at the temporary folders
const helper = createHelper({ env: { WEBOBS_PUBLISH_TARGET: volume, WEBOBS_REPORT_BASE: serverBase, WEBOBS_VAULT: vault }, indexFile: path.join(tmp, 'index.json') });
try { await helper.listen(4178); } catch { console.error('Port 4178 is in use (is a publish helper already running?). Stop it and run this again.'); process.exit(2); }
// the Studio page, served from one of the helper's allowed origins
const pages = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const file = u.pathname === '/report.html' ? path.resolve('dist-report/report.html') : u.pathname === '/cap.json' ? path.resolve(capture) : null;
  if (!file) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8'); fs.createReadStream(file).pipe(res);
});
await new Promise((r, j) => { pages.once('error', j); pages.listen(PAGE_PORT, '127.0.0.1', r); }).catch(() => { console.error('Port ' + PAGE_PORT + ' is in use. Stop what is using it and run this again.'); process.exit(2); });

const cp = 9900 + Math.floor(Math.random() * 90);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${cp}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--user-data-dir=' + path.join(tmp, 'prof'), 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 40; i++) { try { t = await (await fetch(`http://127.0.0.1:${cp}/json`)).json(); if (t.length) break; } catch { /* starting */ } await sleep(250); }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? ''); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.result?.value;
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const until = async (expr, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };
const click = (text, scope = 'document') => ev(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
const setValue = (sel, value) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const tab = (label) => ev(`(() => { const b = [...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return Boolean(b); })()`);

console.log('studio, in a real browser');
await send('Page.navigate', { url: `http://127.0.0.1:${PAGE_PORT}/report.html?manifest=cap.json` });
check('the Studio opens the capture', await until("!!document.querySelector('.ad-bar') && !!document.querySelector('[role=tab]')", 60000));
await tab('Brand'); await sleep(500);
await ev("(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'approved')); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'approved'); s.dispatchEvent(new Event('change', { bubbles: true })); })()"); await sleep(300);
await tab('Export'); await sleep(500);

// Without a helper, Publish must not pretend: it would save a file, not upload.
check('before Connect the page says it is not connected', /Not connected/.test(await ev('document.body.innerText')));
check('the helper refuses a wrong token and the page says why', await (async () => { await setValue('input[aria-label="Publish helper start token"]', 'x'.repeat(43)); await click('Connect'); return until("/start token is not right/.test(document.body.innerText)", 8000); })());
await setValue('input[aria-label="Publish helper start token"]', helper.startToken); await sleep(400); await click('Connect');
check('Connect shows where Publish will upload', await until("document.body.innerText.includes('Helper connected. Publish will upload to')", 8000), String(await ev("document.querySelector('.ad-banner')?.textContent")));

const publishOnce = async () => {
  await ev("document.querySelector('.ad-published') && [...document.querySelectorAll('.ad-published button')].find((b) => b.textContent === 'Hide')?.click()"); await sleep(300);
  await click('Publish', "document.querySelector('.ad-main')");
  const ok = await until("!!document.querySelector('.ad-published code')", 90000);
  return ok ? await ev("document.querySelector('.ad-published code').textContent") : null;
};
const link1 = await publishOnce();
check('Publish shows a link once', Boolean(link1) && link1.startsWith(serverBase + '/r/'), link1 ? link1.replace(/[/]r[/].+/, '/r/…') : (await ev("document.querySelector('.ad-banner')?.textContent")));
const files1 = fs.readdirSync(path.join(volume, 'registry'));
check('one report and one link entry reached the volume', files1.length === 1 && fs.readdirSync(path.join(volume, 'reports')).length === 1);
check('the link is served by the report server', link1 && (await fetch(link1.replace('/r/', '/api/r/') + '/report.json')).status === 200);
await ev("[...document.querySelectorAll('.ad-published button')].find((b) => b.textContent === 'Hide')?.click()"); await sleep(300);
check('Hide removes the link from the page', !(await ev("!!document.querySelector('.ad-published')")) && !(await ev('document.body.innerHTML')).includes(link1.split('/r/')[1]));
const link2 = await publishOnce();
check('a second Publish makes a different link without touching the first', Boolean(link2) && link2 !== link1 && fs.readdirSync(path.join(volume, 'registry')).length === 2);

console.log('links panel: see and revoke');
await tab('Captures'); await sleep(500);
await click('Show published links');
check('both links are listed (by id, with no token or hash)', await until("document.querySelectorAll('.ad-manage table')[document.querySelectorAll('.ad-manage table').length - 1]?.querySelectorAll('tbody tr').length === 2", 8000) && !(await ev('document.querySelector(\'.ad-manage\').innerText')).includes(link1.split('/r/')[1]));
await click('Revoke…', 'document.querySelector(".ad-manage")');
check('revoke asks first and says what happens', await until("!!document.querySelector('[role=alertdialog]') && /stops? working|will see/.test(document.querySelector('[role=alertdialog]').innerText)", 5000));
check('nothing is revoked before the confirmation', (await fetch(link1.replace('/r/', '/api/r/') + '/report.json')).status === 200 && (await fetch(link2.replace('/r/', '/api/r/') + '/report.json')).status === 200);
await click('Revoke link'); await sleep(1500);
const s1 = (await fetch(link1.replace('/r/', '/api/r/') + '/report.json')).status, s2 = (await fetch(link2.replace('/r/', '/api/r/') + '/report.json')).status;
check('exactly one link stops working, the other still works', (s1 === 404 && s2 === 200) || (s1 === 200 && s2 === 404), `${s1}/${s2}`);
check('the list shows it as Revoked', /Revoked/.test(await ev("document.querySelector('.ad-manage').innerText")));

console.log('a look (styles file) attached on the Brand & review tab');
{
  let lookFile = ''; let lookN = 0; // a new file name each time: the browser does not report a change when the same name is chosen again
  const attach = async (obj) => {
    lookFile = path.join(os.tmpdir(), 'wo-studio-look-' + process.pid + '-' + (++lookN) + '.json');
    fs.writeFileSync(lookFile, typeof obj === 'string' ? obj : JSON.stringify(obj));
    await send('DOM.enable'); const doc = await send('DOM.getDocument');
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file][accept*=json]' });
    await send('DOM.setFileInputFiles', { files: [lookFile], nodeId: q.result.nodeId });
  };
  await tab('Brand'); await sleep(500);
  await attach({ acent: '#112233' });
  check('a styles file with a typo is refused on the page and names the key', await until("document.body.innerText.includes('\"acent\" is not a styles name')", 8000));
  await attach('{not json');
  check('a file that is not JSON gets a plain message', await until("document.body.innerText.includes('That file is not valid JSON.')", 8000));
  await attach({ accent: '#7DD3A8', surface: '#14181f', name: 'Harbour Studio' });
  check('a good styles file is accepted and the page says so', await until("document.body.innerText.includes('Attached: 3 style settings')", 8000));
  await tab('Export'); await sleep(500);
  const before = new Set(fs.readdirSync(path.join(volume, 'reports')));
  const link3 = await publishOnce();
  check('Publish with a look shows a link', Boolean(link3) && link3.startsWith(serverBase + '/r/'));
  const added = fs.readdirSync(path.join(volume, 'reports')).filter((f) => !before.has(f));
  const stored = added.length === 1 ? JSON.parse(fs.readFileSync(path.join(volume, 'reports', added[0]), 'utf8')) : null;
  check('the report that reached the volume carries the look (checked, colours lower-cased)', Boolean(stored) && stored.styles && stored.styles.accent === '#7dd3a8' && stored.styles.name === 'Harbour Studio');
  const page3 = link3 ? await (await fetch(link3)).text() : '';
  check('the link opens a page with the look in its first bytes and no styles in report.json', page3.includes('id="wo-styles"') && page3.includes('Harbour Studio') && !('styles' in (await (await fetch(link3.replace('/r/', '/api/r/') + '/report.json')).json())));
  await tab('Brand'); await sleep(300);
  check('Remove look puts the report back to the built-in look', await click('Remove look', "document.querySelector('.ad-main')"));
  await tab('Captures'); await sleep(400); // back to the panel the next steps use
  for (let i = 1; i <= lookN; i++) { try { fs.unlinkSync(path.join(os.tmpdir(), 'wo-studio-look-' + process.pid + '-' + i + '.json')); } catch { /* temp file */ } }
}

console.log('captures panel: archive');
await click('Show my captures');
check('the captures are listed', await until("[...document.querySelectorAll('.ad-manage td')].some((x) => x.textContent === 'demo.test') && [...document.querySelectorAll('.ad-manage td')].some((x) => x.textContent === 'other.test')", 8000));
await ev("(() => { const r = [...document.querySelectorAll('.ad-manage tr')].find((x) => x.textContent.includes('demo.test')); [...r.querySelectorAll('button')].find((b) => b.textContent.startsWith('Archive'))?.click(); })()");
check('Archive capture lists exactly what will move, with counts', await until("(() => { const d = document.querySelector('[role=alertdialog]'); return !!d && d.innerText.includes('sites/demo.test/') && d.innerText.includes('.web-obs/history/demo.test/') && /2 files/.test(d.innerText) && /moved/.test(d.innerText); })()", 8000));
check('the move button is off until the domain is typed', await ev("[...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent.startsWith('Move'))?.disabled === true"));
check('nothing has moved yet', fs.existsSync(path.join(vault, 'sites/demo.test')));
await setValue('input[aria-label="Type the domain to confirm"]', 'demo.test'); await sleep(300); await click('Move to the trash folder'); await sleep(1500);
const trashRoot = path.join(vault, '.web-obs', 'trash'); const trashed = fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot) : [];
check('the capture and its history moved to the trash folder', !fs.existsSync(path.join(vault, 'sites/demo.test')) && !fs.existsSync(path.join(vault, '.web-obs/history/demo.test')) && trashed.length === 1 && fs.existsSync(path.join(trashRoot, trashed[0] || 'x', 'REMOVED.txt')));
check('nothing was deleted and other sites are untouched', fs.existsSync(path.join(trashRoot, trashed[0] || 'x', 'sites', 'Pages', 'home.md')) && fs.existsSync(path.join(vault, 'sites/other.test/_site-graph.json')));
check('the page confirms it', /Nothing was deleted/.test(await ev('document.body.innerText')));

console.log('the client side');
const live = s1 === 200 ? link1 : link2;
await send('Page.navigate', { url: live });
check('the surviving link opens the report through the server', await until("!!document.querySelector('.pv-card')", 60000));
const dead = s1 === 404 ? link1 : link2;
await send('Page.navigate', { url: dead }); await sleep(2500);
check('the revoked link shows only the one unavailable line', (await ev('document.body.innerText')).trim() === 'This link is not available. Please request a fresh one.');
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

ws.close(); chrome.kill(); await helper.close(); await new Promise((r) => rs.server.close(r)); await new Promise((r) => pages.close(r));
await sleep(1500); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* browser profile still closing; the OS cleans the temp folder later */ }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nstudio browser checks passed');
process.exit(failed ? 1 : 0);

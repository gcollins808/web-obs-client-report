// Foreground, self-terminating checks for the one-command publish flow and the safe "remove capture" script.
// Uses a local report export and temporary folders only; no network, no ssh, nothing outside the temp folder is changed.
// Run: node apps/server/scripts/test-publish-and-remove.mjs <client-report.json>
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../server.mjs';

const report = process.argv[2];
if (!report || !fs.existsSync(report)) { console.error('usage: node apps/server/scripts/test-publish-and-remove.mjs <client-report.json>'); process.exit(2); }
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const node = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, WEBOBS_PUBLISH_TARGET: '', WEBOBS_REPORT_BASE: '', WEBOBS_VAULT: '', WEBOBS_REPORT_INDEX: path.join(os.tmpdir(), 'wo-test-index.json') } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-pub-'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

console.log('publish');
const target = path.join(tmp, 'volume');
const p = node('apps/server/scripts/publish-client-report.mjs', report, '--client', 'client-one', '--to', target, '--hours', '12', '--base', 'https://r.test');
const link = /https:\/\/r\.test\/r\/([A-Za-z0-9_-]{43})/.exec(p.stdout);
check('one command ends with a link', p.status === 0 && Boolean(link), p.stderr.trim().slice(0, 120));
check('the link is printed once', (p.stdout.match(/r[/]([A-Za-z0-9_-]{43})/g) || []).length === 1);
const files = fs.existsSync(target) ? walk(target).map((f) => path.relative(target, f).split(path.sep).join('/')) : [];
check('the report has a random name under reports/ and the link entry is under registry/', files.some((f) => /^reports[/][0-9a-f]{32}[.]json$/.test(f)) && files.some((f) => /^registry[/]\w+[.]json$/.test(f)) && files.length === 2, files.join(', '));
check('only the client report is uploaded, never an explore pack', files.every((f) => !/explore/.test(f)) && !walk(target).some((f) => fs.readFileSync(f, 'utf8').includes('webobs.explore-pack')));
check('the token is in no uploaded file (only its hash)', !walk(target).some((f) => fs.readFileSync(f, 'utf8').includes(link[1])));
const leftover = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wo-publish-'));
check('temporary export and staging folders are cleaned up', leftover.length === 0, leftover.join(', '));

// The published folder works with the real server.
const { server } = createServer({ port: 0, reportsDir: path.join(target, 'reports'), registryDir: path.join(target, 'registry'), appFile: path.join(tmp, 'app.html'), requireHttps: false, outboxDir: path.join(tmp, 'outbox') });
fs.writeFileSync(path.join(tmp, 'app.html'), '<!doctype html><html><body>viewer</body></html>');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const res = await fetch(`http://127.0.0.1:${server.address().port}/api/r/${link[1]}/report.json`);
const body = await res.json().catch(() => ({}));
check('the server serves the published report to that link', res.status === 200 && body.format === 'webobs.client-report');
await new Promise((r) => server.close(r));

const dry = node('apps/server/scripts/publish-client-report.mjs', report, '--client', 'client-one', '--to', path.join(tmp, 'never'), '--dry-run', '--base', 'https://r.test');
check('a dry run uploads nothing', dry.status === 0 && !fs.existsSync(path.join(tmp, 'never')) && /dry run/.test(dry.stdout));
check('a bad client name is refused', node('apps/server/scripts/publish-client-report.mjs', report, '--client', '../x', '--to', target).status !== 0);
check('a bad target is refused', node('apps/server/scripts/publish-client-report.mjs', report, '--client', 'x', '--to', 'relative/path').status !== 0);
check('no target and no dry run is refused', node('apps/server/scripts/publish-client-report.mjs', report, '--client', 'x').status !== 0);
const pack = path.join(tmp, 'x.explore-pack.json'); fs.writeFileSync(pack, JSON.stringify({ format: 'webobs.explore-pack' }));
check('an explore pack is refused', node('apps/server/scripts/publish-client-report.mjs', pack, '--client', 'x', '--to', target).status !== 0);

console.log('remove capture');
const vault = path.join(tmp, 'vault');
const put = (rel, text = 'x') => { const f = path.join(vault, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('sites/a.test/_site-graph.json', '{}'); put('sites/a.test/Pages/home.md', 'home'); put('sites/b.test/_site-graph.json', '{"keep":1}');
put('.web-obs/history/a.test/cap1/_site-graph.json', 'old'); put('.web-obs/history/b.test/cap1/x.json', 'b-old');
const before = walk(vault).length;
const dryRun = node('apps/server/scripts/remove-capture.mjs', vault, 'a.test');
check('without --confirm it lists what it would move and changes nothing', dryRun.status === 0 && /sites\/a.test\//.test(dryRun.stdout) && /history\/a.test\//.test(dryRun.stdout) && /Nothing has been changed/.test(dryRun.stdout) && walk(vault).length === before);
check('the wrong confirmation changes nothing', node('apps/server/scripts/remove-capture.mjs', vault, 'a.test', '--confirm', 'b.test').stdout.includes('Nothing has been changed') && walk(vault).length === before);
check('a path-like domain is refused', node('apps/server/scripts/remove-capture.mjs', vault, '../x').status !== 0);
check('an unknown domain is refused', node('apps/server/scripts/remove-capture.mjs', vault, 'zzz.test').status !== 0);
const done = node('apps/server/scripts/remove-capture.mjs', vault, 'a.test', '--confirm', 'a.test');
const trashRoot = path.join(vault, '.web-obs', 'trash');
const trashed = fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot) : [];
check('with --confirm the capture and its history move to the trash folder', done.status === 0 && trashed.length === 1 && !fs.existsSync(path.join(vault, 'sites', 'a.test')) && !fs.existsSync(path.join(vault, '.web-obs', 'history', 'a.test')));
const inTrash = trashed.length ? walk(path.join(trashRoot, trashed[0])).map((f) => path.relative(path.join(trashRoot, trashed[0]), f).split(path.sep).join('/')).sort() : [];
check('nothing was deleted: every file is in the trash, with a note on how to restore', ['history/cap1/_site-graph.json', 'sites/Pages/home.md', 'sites/_site-graph.json', 'REMOVED.txt'].every((f) => inTrash.includes(f)), inTrash.join(', '));
check('other sites are untouched', fs.readFileSync(path.join(vault, 'sites/b.test/_site-graph.json'), 'utf8') === '{"keep":1}' && fs.existsSync(path.join(vault, '.web-obs/history/b.test/cap1/x.json')));

console.log('publish helper (the Studio button)');
{
  const { createHelper } = await import('./publish-helper.mjs');
  const { REPORT_FIELDS } = await import('./lib/publish-core.mjs');
  const volume = path.join(tmp, 'helper-volume');
  const env = { WEBOBS_PUBLISH_TARGET: volume, WEBOBS_REPORT_BASE: 'https://r.test' };
  const published = [];
  const h = createHelper({ env, indexFile: path.join(tmp, 'helper-index.json'), onPublished: (r) => published.push(r.id) });
  const port = await h.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: 'Bearer ' + h.startToken };
  const ORIGIN = 'http://127.0.0.1:4177';
  const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
  const post = (body, headers = {}) => fetch(base + '/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...auth, ...headers }, body: JSON.stringify(body) });

  check('it listens on this machine only', h.server.address().address === '127.0.0.1');
  check('no token and a wrong token are refused', (await fetch(base + '/status', { headers: { Origin: ORIGIN } })).status === 401 && (await fetch(base + '/status', { headers: { Origin: ORIGIN, Authorization: 'Bearer ' + 'x'.repeat(43) } })).status === 401);
  const st = await (await fetch(base + '/status', { headers: { Origin: ORIGIN, ...auth } })).json();
  check('status reports only whether a target is set, and the host', st.ok && st.targetSet && st.baseSet && st.target === 'a local folder');
  check('another website cannot call it', (await fetch(base + '/status', { headers: { Origin: 'https://evil.example', ...auth } })).status === 403);
  const pre = await fetch(base + '/publish', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  check('the Studio origin gets a preflight answer with no token needed', pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN && pre.headers.get('access-control-allow-private-network') === 'true');
  const rebinding = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, path: '/status', headers: { Host: 'evil.example', ...auth } }, (res) => resolve(res.statusCode)); r.end(); });
  check('a request addressed to another host name is refused (DNS rebinding)', rebinding === 421);

  const ok = await post({ report: rep, client: 'client-one', hours: 7 }); const okj = await ok.json();
  check('publish pushes the report and returns the link once', ok.status === 200 && okj.ok && /^https:\/\/r\.test\/r\/[A-Za-z0-9_-]{43}$/.test(okj.link));
  const volFiles = walk(volume).map((f) => path.relative(volume, f).split(path.sep).join('/'));
  check('the report and one link entry are on the volume, and no token is in them', volFiles.length === 2 && !walk(volume).some((f) => fs.readFileSync(f, 'utf8').includes(okj.link.split('/r/')[1])));
  check('the terminal is told a link id, never the link', published.length === 1 && !published.some((x) => String(x).includes(okj.link.split('/r/')[1])));
  const sv = createServer({ port: 0, reportsDir: path.join(volume, 'reports'), registryDir: path.join(volume, 'registry'), appFile: path.join(tmp, 'app.html'), requireHttps: false, outboxDir: path.join(tmp, 'outbox2') });
  await new Promise((r) => sv.server.listen(0, '127.0.0.1', r));
  const served = await fetch(`http://127.0.0.1:${sv.server.address().port}/api/r/${okj.link.split('/r/')[1]}/report.json`);
  check('the real server serves what the helper published', served.status === 200);
  await new Promise((r) => sv.server.close(r));

  const bad1 = await post({ report: { format: 'webobs.explore-pack' }, client: 'x' });
  const bad2 = await post({ report: { ...rep, meta: { ...rep.meta, review: { state: 'draft' } } }, client: 'x' });
  const bad3 = await post({ report: { ...rep, agencyNotes: 'x' }, client: 'x' });
  check('an explore pack, an unapproved report and a report with extra fields are refused', [bad1, bad2, bad3].every((r) => r.status === 400) && walk(volume).length === 2);
  check('a bad client name is refused', (await post({ report: rep, client: '../x' })).status === 400);
  const msgs = JSON.stringify([await bad1.clone().json().catch(() => ({})), okj]);
  check('no response carries the start token', !msgs.includes(h.startToken));
  check('the contract field list in the helper matches the report contract', (() => { const src = fs.readFileSync('packages/contract/src/contract.ts', 'utf8'); const m = /REPORT_FIELDS = \[([^\]]*)\]/.exec(src); return Boolean(m) && JSON.stringify(m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean)) === JSON.stringify(REPORT_FIELDS); })());
  await h.close();

  const noTarget = createHelper({ env: { WEBOBS_REPORT_BASE: 'https://r.test' } }); const p2 = await noTarget.listen(0);
  const r2 = await fetch(`http://127.0.0.1:${p2}/publish`, { method: 'POST', headers: { Authorization: 'Bearer ' + noTarget.startToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ report: rep, client: 'x' }) });
  check('with no WEBOBS_PUBLISH_TARGET it says so and uploads nothing', r2.status === 400 && /WEBOBS_PUBLISH_TARGET/.test((await r2.json()).message));
  await noTarget.close();
  const noBase = createHelper({ env: { WEBOBS_PUBLISH_TARGET: volume } }); const p3 = await noBase.listen(0);
  check('with no WEBOBS_REPORT_BASE it says so', (await fetch(`http://127.0.0.1:${p3}/publish`, { method: 'POST', headers: { Authorization: 'Bearer ' + noBase.startToken, 'Content-Type': 'application/json' }, body: '{}' })).status === 400);
  await noBase.close();
  const lim = createHelper({ env }); const p4 = await lim.listen(0); const codes = [];
  for (let i = 0; i < 24; i++) codes.push((await fetch(`http://127.0.0.1:${p4}/status`, { headers: { Authorization: 'Bearer ' + lim.startToken } })).status);
  check('requests are rate limited', codes.includes(429) && codes[0] === 200);
  await lim.close();
  const idle = createHelper({ env, idleMs: 150 }); await idle.listen(0);
  await new Promise((r) => idle.server.once('close', r)); check('it stops by itself when idle', !idle.server.listening);
  const hidden = node('apps/server/scripts/publish-helper.mjs');
  check('started without a terminal (hidden or detached) it refuses to run', hidden.status === 2 && /visible terminal/.test(hidden.stderr));
  const shell = fs.existsSync('dist-report/report.html') ? fs.readFileSync('dist-report/report.html', 'utf8') : '';
  const envTxt = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  const targetVal = /^WEBOBS_PUBLISH_TARGET=(.+)$/m.exec(envTxt)?.[1]?.trim();
  check('no secret or publish setting is in the built page', shell.length > 0 && !/RESEND_API_KEY|re_[A-Za-z0-9]{20,}/.test(shell) && !(targetVal && shell.includes(targetVal)));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\npublish and remove-capture checks passed');
process.exit(failed ? 1 : 0);

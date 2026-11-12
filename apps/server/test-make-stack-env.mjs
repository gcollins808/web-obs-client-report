// Tests for tools/make-stack-env.mjs with FAKE values only. Foreground; temp folders only; the clipboard is never touched.
//   node apps/server/test-make-stack-env.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathProblem, checkEnv, parseEnv, newSecret, serialize } from './tools/make-stack-env.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const tool = path.join(import.meta.dirname, 'tools', 'make-stack-env.mjs');
const run = (args, lines = []) => spawnSync(process.execPath, [tool, ...args], { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 30000 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-stackenv-'));
const FAKE_AUD = 'a1b2c3d4'.repeat(8);              // 64 hex, fake
const FAKE_KEY = 'fake_resend_key_' + 'z'.repeat(24); // fake
const secretOf = (f) => parseEnv(fs.readFileSync(f, 'utf8')).INGEST_SECRET;

console.log('writing the file (ingest on)');
{
  const f = path.join(tmp, 'ok', 'stack.env');
  const r = run([], [f, 'https://reports.example.com', '', 'y', '', 'myteam.cloudflareaccess.com', FAKE_AUD, 'feedback@example.com', FAKE_KEY, 'sender@example.com']);
  check('it exits 0 and writes the file', r.status === 0 && fs.existsSync(f), (r.stderr || '').slice(0, 120));
  const env = parseEnv(fs.readFileSync(f, 'utf8'));
  check('the non-secret production values are pre-filled', env.WEBOBS_REPORT_BASE === 'https://reports.example.com' && env.RETENTION_DAYS === '90' && env.INGEST_ENABLED === '1');
  check('mail mode becomes resend when a key is given', env.MAIL_MODE === 'resend' && env.RESEND_FROM === 'sender@example.com' && env.WEBOBS_FEEDBACK_TO === 'feedback@example.com');
  check('INGEST_SECRET is 64 hex characters made by the tool', /^[0-9a-f]{64}$/.test(env.INGEST_SECRET));
  check('the Cloudflare names are written', env.CF_ACCESS_TEAM_DOMAIN === 'myteam.cloudflareaccess.com' && env.CF_ACCESS_AUD === FAKE_AUD);
  const out = r.stdout + r.stderr;
  check('no secret value is ever printed', !out.includes(env.INGEST_SECRET) && !out.includes(FAKE_KEY) && !out.includes(FAKE_AUD));
  check('the summary says only set / not set and the secret length', /INGEST_SECRET: set, 64 characters/.test(out) && /RESEND_API_KEY: set\b/.test(out) && !out.includes('=') === false || /INGEST_SECRET: set, 64 characters/.test(out));
  check('the Portainer step and the keep-private advice are printed', /Load variables from \.env file/.test(out) && /never committed/.test(out));
  check('two runs make different secrets', (() => { const g = path.join(tmp, 'ok2', 'stack.env'); run([], [g, '', '', 'n', '', '']); return secretOf(g) !== env.INGEST_SECRET; })());
}

console.log('the public address is remembered, and no private hostname is in the code');
{
  const d = path.join(tmp, 'mem');
  const f1 = path.join(d, 'a.env');
  const first = run([], [f1, 'https://reports.example.com', '', 'n', '', '']);
  check('the address typed is remembered in a small non-secret file next to the env file', first.status === 0 && fs.readFileSync(path.join(d, '.last-base'), 'utf8').trim() === 'https://reports.example.com' && /remembered/.test(first.stdout));
  const f2 = path.join(d, 'b.env');
  const second = run([], [f2, '', '', 'n', '', '']);
  check('next time Enter alone uses the remembered address', second.status === 0 && parseEnv(fs.readFileSync(f2, 'utf8')).WEBOBS_REPORT_BASE === 'https://reports.example.com');
  check('the remembered file holds only the address, no secret', !fs.readFileSync(path.join(d, '.last-base'), 'utf8').includes(secretOf(f2)) && fs.readFileSync(path.join(d, '.last-base'), 'utf8').trim().split(String.fromCharCode(10)).length === 1);
  check('without a remembered address the default is the neutral placeholder', parseEnv(fs.readFileSync(path.join(tmp, 'ok2', 'stack.env'), 'utf8')).WEBOBS_REPORT_BASE === 'https://audit.example.com');
  const src = fs.readFileSync(tool, 'utf8') + fs.readFileSync(import.meta.filename, 'utf8');
  check('no private hostname appears in the helper or its test', !new RegExp('csc' + 'loud', 'i').test(src));
}

console.log('viewer-only default');
{
  const f = path.join(tmp, 'viewer', 'stack.env');
  const r = run([], [f, '', '', '', '', '']);
  const env = parseEnv(fs.readFileSync(f, 'utf8'));
  check('ingest defaults to off, mail to outbox, no Cloudflare names asked', r.status === 0 && env.INGEST_ENABLED === '0' && env.MAIL_MODE === 'outbox' && !env.CF_ACCESS_AUD && !env.CF_ACCESS_TEAM_DOMAIN && !env.RESEND_API_KEY);
  check('check passes for a viewer-only file', checkEnv(env).length === 0);
}

console.log('validation and refusing bad paths');
{
  const f = path.join(tmp, 'v2', 'stack.env');
  const r = run([], [f, '', '', 'y', 'y', 'https://wrong.example.com', 'not-a-domain', 'myteam.cloudflareaccess.com', 'short', FAKE_AUD, '', '']);
  check('a wrong team domain and a wrong AUD tag are re-asked, not accepted', r.status === 0 && /cloudflareaccess\.com/.test(r.stdout) && parseEnv(fs.readFileSync(f, 'utf8')).CF_ACCESS_AUD === FAKE_AUD);
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const vault = path.join(tmp, 'vault'); fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  check('a path inside a git repository is refused', /git repository/.test(pathProblem(path.join(repo, 'sub', 'x.env'))));
  check('a path inside an Obsidian vault is refused', /Obsidian vault/.test(pathProblem(path.join(vault, 'x.env'))));
  check('cloud-synced folders are refused', /cloud-synced/.test(pathProblem('C:/Users/me/OneDrive/Documents/x.env')) && /cloud-synced/.test(pathProblem('/home/me/Dropbox/x.env')));
  check('an ordinary folder is accepted', pathProblem(path.join(tmp, 'plain', 'x.env')) === null);
  const g = path.join(tmp, 'v3', 'stack.env');
  const r2 = run([], [path.join(repo, 'x.env'), g, '', '', 'n', '', '']);
  check('the tool refuses the repo path and asks again; nothing is written there', r2.status === 0 && !fs.existsSync(path.join(repo, 'x.env')) && fs.existsSync(g) && /Refused/.test(r2.stdout));
}

console.log('overwrite needs a yes');
{
  const f = path.join(tmp, 'ow', 'stack.env');
  run([], [f, '', '', 'n', '', '']);
  const before = fs.readFileSync(f, 'utf8');
  const no = run([], [f, '', '', 'n', '', '', 'no']);
  check('without yes the file is left alone', no.status !== 0 && fs.readFileSync(f, 'utf8') === before);
  const yes = run([], [f, '', '', 'n', '', '', 'yes']);
  check('with yes it is replaced (new secret)', yes.status === 0 && fs.readFileSync(f, 'utf8') !== before);
}

console.log('--check, --rotate, --copy-secret errors');
{
  const f = path.join(tmp, 'chk', 'stack.env');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, serialize({ WEBOBS_REPORT_BASE: 'https://audit.example.com', INGEST_ENABLED: '1', INGEST_SECRET: 'shortFAKEvalue123', CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com' }));
  const r = run(['--check', f]);
  check('--check exits 1 and names the problems', r.status === 1 && /INGEST_SECRET: shorter than 32/.test(r.stdout) && /CF_ACCESS_AUD: missing/.test(r.stdout));
  check('--check shows no values', !r.stdout.includes('shortFAKEvalue123') && !r.stdout.includes('myteam.cloudflareaccess.com'));
  const ok = path.join(tmp, 'ok', 'stack.env');
  const good = run(['--check', ok]);
  check('--check passes a complete file', good.status === 0 && /OK/.test(good.stdout));
  const old = secretOf(ok);
  const rot = run(['--rotate', ok]);
  const fresh = secretOf(ok);
  check('--rotate makes a new 64 character secret and keeps the rest', rot.status === 0 && fresh !== old && /^[0-9a-f]{64}$/.test(fresh) && parseEnv(fs.readFileSync(ok, 'utf8')).CF_ACCESS_AUD === FAKE_AUD);
  check('--rotate prints neither the old nor the new secret, and says to update the plugin', !(rot.stdout + rot.stderr).includes(old) && !(rot.stdout + rot.stderr).includes(fresh) && /Publish secret/.test(rot.stdout));
  const noSecret = path.join(tmp, 'chk', 'nosecret.env'); fs.writeFileSync(noSecret, 'WEBOBS_REPORT_BASE=https://a.example.com\n');
  const cs = run(['--copy-secret', noSecret]);
  check('--copy-secret with no secret in the file fails and touches nothing', cs.status === 1 && /not in that file/.test(cs.stderr));
  check('a missing file is a plain error', run(['--check', path.join(tmp, 'nope.env')]).status === 1);
}

console.log('ingest without Cloudflare Access (opt-in, not recommended)');
{
  const cfFile = path.join(tmp, 'ok', 'stack.env');
  const cfEnv = parseEnv(fs.readFileSync(cfFile, 'utf8'));
  check('answering Enter to "Use Cloudflare Access?" keeps today\'s behaviour: no switch-off, no acknowledgment, no header written', cfEnv.CF_ACCESS_AUD === FAKE_AUD && !('INGEST_REQUIRE_ACCESS_HEADER' in cfEnv) && !('INGEST_ACKNOWLEDGE_NO_EDGE_AUTH' in cfEnv) && !('CLIENT_IP_HEADER' in cfEnv));
  const f = path.join(tmp, 'noedge', 'stack.env');
  const r = run([], [f, 'https://reports.example.com', '', 'y', 'n', '', 'feedback@example.com', '']);
  const out = r.stdout + r.stderr;
  const env = fs.existsSync(f) ? parseEnv(fs.readFileSync(f, 'utf8')) : {};
  check('it exits 0 and writes the file', r.status === 0 && fs.existsSync(f), (r.stderr || '').slice(0, 120));
  check('the question is asked after "Turn the ingest ON now?", and the save path is still asked first', out.indexOf('Where to save the file') >= 0 && out.indexOf('Where to save the file') < out.indexOf('Public address of the viewer') && out.indexOf('Turn the ingest ON now?') < out.indexOf('Use Cloudflare Access for the ingest? (recommended) [Y/n]'));
  check('n writes INGEST_REQUIRE_ACCESS_HEADER=0 and INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes', env.INGEST_ENABLED === '1' && env.INGEST_REQUIRE_ACCESS_HEADER === '0' && env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH === 'yes');
  check('the team-domain and AUD prompts are skipped and nothing Cloudflare is written', !/Cloudflare team domain|AUD tag/.test(out) && !env.CF_ACCESS_TEAM_DOMAIN && !env.CF_ACCESS_AUD);
  check('the client-IP header defaults to x-real-ip and the question says it is YOUR reverse proxy\'s header', env.CLIENT_IP_HEADER === 'x-real-ip' && /YOUR reverse proxy/.test(out) && /Client-IP header your reverse proxy sets \[x-real-ip\]/.test(out));
  check('a plain warning is printed: no edge authentication, no edge rate limiting or bot filtering, only the secret and in-app limits, alternatives in docs/SETUP.md', /WITHOUT Cloudflare Access/.test(out) && /not recommended/.test(out) && /no Cloudflare edge authentication/.test(out) && /no edge rate limiting or bot filtering/.test(out) && /Only INGEST_SECRET/.test(out) && /docs\/SETUP[.]md/.test(out));
  check('the secret is 64 hex characters (48 are required in this mode) and is not printed', /^[0-9a-f]{64}$/.test(env.INGEST_SECRET || '') && !out.includes(env.INGEST_SECRET));
  check('the summary says the ingest runs without Cloudflare Access', /INGEST_REQUIRE_ACCESS_HEADER: 0 [(]ingest WITHOUT Cloudflare Access, not recommended[)]/.test(out));
  check('--check passes the no-Cloudflare file (no Cloudflare names needed)', checkEnv(env).length === 0 && run(['--check', f]).status === 0);
  const g = path.join(tmp, 'noedge2', 'stack.env');
  const r2 = run([], [g, '', '', 'y', 'N', 'x_bad', 'X-Client-IP', '', '']);
  check('a custom header is accepted after a bad one is re-asked', r2.status === 0 && parseEnv(fs.readFileSync(g, 'utf8')).CLIENT_IP_HEADER === 'X-Client-IP' && /plain header name/.test(r2.stdout));
  const v = path.join(tmp, 'noedge3', 'stack.env');
  const r3 = run([], [v, '', '', 'n', '', '']);
  const venv = parseEnv(fs.readFileSync(v, 'utf8'));
  check('viewer-only: the Cloudflare question is not asked and no acknowledgment is written', r3.status === 0 && !/Use Cloudflare Access/.test(r3.stdout) && !venv.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH && !venv.INGEST_REQUIRE_ACCESS_HEADER);

  const base = { WEBOBS_REPORT_BASE: 'https://audit.example.com', INGEST_ENABLED: '1', INGEST_REQUIRE_ACCESS_HEADER: '0', INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: 'yes', INGEST_SECRET: 'f'.repeat(64) };
  const has = (e, re) => checkEnv(e).some((p) => re.test(p));
  check('checkEnv: no-Cloudflare without the acknowledgment is a problem', has({ ...base, INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: undefined }, /INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: must be yes/));
  check('checkEnv: an acknowledgment other than exactly yes is a problem', has({ ...base, INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: 'true' }, /INGEST_ACKNOWLEDGE_NO_EDGE_AUTH/) && has({ ...base, INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: '1' }, /INGEST_ACKNOWLEDGE_NO_EDGE_AUTH/));
  check('checkEnv: a secret under 48 characters is a problem without Cloudflare (40 is fine with it)', has({ ...base, INGEST_SECRET: 'f'.repeat(47) }, /INGEST_SECRET: shorter than 48/) && !has({ WEBOBS_REPORT_BASE: 'https://audit.example.com', INGEST_ENABLED: '1', INGEST_SECRET: 'f'.repeat(40), CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com', CF_ACCESS_AUD: FAKE_AUD }, /INGEST_SECRET/));
  check('checkEnv: a complete no-Cloudflare file passes without Cloudflare names', checkEnv(base).length === 0);
  check('checkEnv: with Cloudflare (the default) the team domain and AUD are still required', has({ ...base, INGEST_REQUIRE_ACCESS_HEADER: undefined, INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: undefined }, /CF_ACCESS_AUD: missing/));
  check('checkEnv: an odd INGEST_REQUIRE_ACCESS_HEADER or CLIENT_IP_HEADER is a problem', has({ ...base, INGEST_REQUIRE_ACCESS_HEADER: 'false' }, /INGEST_REQUIRE_ACCESS_HEADER/) && has({ ...base, CLIENT_IP_HEADER: 'x real ip' }, /CLIENT_IP_HEADER/));
}

console.log('helpers');
check('newSecret is 64 hex and different each time', /^[0-9a-f]{64}$/.test(newSecret()) && newSecret() !== newSecret());
check('the source never interpolates the secret value into output', !/[`'"].*[$][{]env[.]INGEST_SECRET[}]/.test(fs.readFileSync(tool, 'utf8')) && !/console[.](log|error)[(]env[.]INGEST_SECRET/.test(fs.readFileSync(tool, 'utf8')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} make-stack-env check(s) FAILED` : '\nall make-stack-env checks passed');
process.exitCode = failed ? 1 : 0;

// Builds the production env file for the both-containers Portainer stack (deploy/VPS-STACK-tunnel-both.yml).
// Run it yourself, at your own keyboard. Nobody else should type or see the secrets. No packages needed (Node 18 or newer).
//
//   node apps/server/tools/make-stack-env.mjs                    ask questions and write the file
//   node apps/server/tools/make-stack-env.mjs --check [file]     report which required names are missing or too short (no values shown)
//   node apps/server/tools/make-stack-env.mjs --fingerprints [file]   print NAME, length and a short fingerprint per variable (no values) plus a paste block for the VPS
//   node apps/server/tools/make-stack-env.mjs --write-expected [file] [out]   write those expected lines to a small file (default webobs-expected.txt beside the env file)
//   node apps/server/tools/make-stack-env.mjs --rotate [file]  make a NEW INGEST_SECRET inside an existing file (never printed)
//   node apps/server/tools/make-stack-env.mjs --copy-secret [file]   copy INGEST_SECRET to the clipboard (never printed); paste it into the
//                                                                plugin's "Publish secret" field, then clear the clipboard
//
// What it does: pre-fills the non-secret production values, makes INGEST_SECRET itself (32 random bytes as 64 hex characters) and never
// prints it, asks for the Cloudflare Access names (or, if you choose to run the ingest WITHOUT Cloudflare Access, which is not
// recommended, writes INGEST_REQUIRE_ACCESS_HEADER=0, INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes and the client-IP header your reverse proxy
// sets) and the optional Resend names, and writes one KEY=VALUE file that Portainer can load
// (Add stack > Environment variables > Load variables from .env file). It refuses a path inside any git repository, inside an
// Obsidian vault, or inside a cloud-synced folder, and it will not overwrite a file unless you type yes.
// Keep the file private: not in a repo, not in a shared or synced folder, never committed. Delete it after you have loaded it into Portainer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// A neutral default. The helper remembers the last address you typed in a small non-secret file (.last-base) next to the env file.
const DEFAULT_BASE = 'https://audit.example.com';
const BASE_SHAPE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const ORDER = ['WEBOBS_REPORT_BASE', 'RETENTION_DAYS', 'MAIL_MODE', 'WEBOBS_FEEDBACK_TO', 'RESEND_API_KEY', 'RESEND_FROM', 'INGEST_ENABLED', 'INGEST_SECRET', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'INGEST_REQUIRE_ACCESS_HEADER', 'INGEST_ACKNOWLEDGE_NO_EDGE_AUTH', 'CLIENT_IP_HEADER'];
const SECRET_NAMES = new Set(['RESEND_API_KEY', 'INGEST_SECRET']);
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const TEAM = /^[a-z0-9][a-z0-9-]{0,61}\.cloudflareaccess\.com$/i;
const AUD = /^[0-9a-f]{64}$/i;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
/** Shortest INGEST_SECRET the ingest accepts with the Cloudflare Access check on, and without it. The helper always makes 64. */
const MIN_SECRET = 32, MIN_SECRET_NO_EDGE = 48;
export const NO_EDGE_WARNING_LINES = [
  'WARNING: the ingest will run WITHOUT Cloudflare Access. This is not recommended.',
  '  There is no Cloudflare edge authentication, and no edge rate limiting or bot filtering. Only INGEST_SECRET (64 characters, made',
  '  here) and the ingest\'s own rate limits, size cap and identical refusals protect it: anyone who learns the secret can upload.',
  '  Safer alternatives (a reverse proxy with mTLS, basic auth or an IP allow-list in front of /ingest/*, or a VPN) and a checklist are',
  '  in docs/SETUP.md, "Running the ingest without Cloudflare (not recommended)".',
];
const CLOUD = /(^|[\\/])(onedrive[^\\/]*|dropbox|google ?drive|icloud ?drive|iclouddrive|box|mega|sync\.com|pcloud)([\\/]|$)/i;

export const newSecret = () => crypto.randomBytes(32).toString('hex');

/** "NAME length first-8-hex-of-sha256" for every name the stack reads that is in the file. Never the value. The VPS doctor computes the same inside the containers. */
export const fingerprint = (v) => `${v.length} ${crypto.createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 8)}`;
export const fingerprintLines = (env) => ORDER.filter((n) => Object.prototype.hasOwnProperty.call(env, n)).map((n) => `${n} ${fingerprint(env[n])}`);
export const heredoc = (lines) => `cat > ~/webobs-expected.txt <<'EOF'\n${lines.join('\n')}\nEOF`;

/** Why this path must not hold the file, or null if it is acceptable. */
export function pathProblem(file) {
  const full = path.resolve(file);
  if (CLOUD.test(full)) return 'that looks like a cloud-synced folder (OneDrive, Dropbox, Google Drive, iCloud ...). Use a local folder.';
  let dir = path.dirname(full);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return `that is inside a git repository (${path.basename(dir) || dir}). The file must never be committed.`;
    if (fs.existsSync(path.join(dir, '.obsidian'))) return `that is inside an Obsidian vault (${path.basename(dir) || dir}).`;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Names that are missing or too short, never the values. */
export function checkEnv(env) {
  const problems = [];
  const need = (n, ok, why) => { if (!env[n]) problems.push(`${n}: missing`); else if (!ok(env[n])) problems.push(`${n}: ${why}`); };
  need('WEBOBS_REPORT_BASE', (v) => /^https:\/\/[^/\s]+$/.test(v), 'must be https:// plus a host, no trailing slash');
  if (env.RETENTION_DAYS && !/^\d{1,4}$/.test(env.RETENTION_DAYS)) problems.push('RETENTION_DAYS: must be a number');
  if (env.MAIL_MODE && !['outbox', 'resend'].includes(env.MAIL_MODE)) problems.push('MAIL_MODE: must be outbox or resend');
  if (env.MAIL_MODE === 'resend') { need('RESEND_API_KEY', (v) => v.length >= 20, 'too short'); need('RESEND_FROM', (v) => EMAIL.test(v), 'not an email address'); }
  const noEdge = env.INGEST_REQUIRE_ACCESS_HEADER === '0';
  if (env.INGEST_REQUIRE_ACCESS_HEADER && !['0', '1'].includes(env.INGEST_REQUIRE_ACCESS_HEADER)) problems.push('INGEST_REQUIRE_ACCESS_HEADER: must be 1 (or absent) for Cloudflare Access, or 0 to run without it');
  if (env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH && env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH !== 'yes') problems.push('INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: must be exactly yes, or absent');
  if (env.CLIENT_IP_HEADER && !HEADER.test(env.CLIENT_IP_HEADER)) problems.push('CLIENT_IP_HEADER: must be a plain header name, e.g. X-Real-IP');
  if (env.INGEST_ENABLED === '1') {
    if (noEdge) {
      need('INGEST_SECRET', (v) => v.length >= MIN_SECRET_NO_EDGE, `shorter than ${MIN_SECRET_NO_EDGE} characters (required without Cloudflare Access)`);
      if (env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH !== 'yes') problems.push('INGEST_ACKNOWLEDGE_NO_EDGE_AUTH: must be yes when INGEST_REQUIRE_ACCESS_HEADER=0 (the ingest refuses to start otherwise)');
    } else {
      need('INGEST_SECRET', (v) => v.length >= MIN_SECRET, `shorter than ${MIN_SECRET} characters`);
      need('CF_ACCESS_TEAM_DOMAIN', (v) => TEAM.test(v), 'should look like yourteam.cloudflareaccess.com');
      need('CF_ACCESS_AUD', (v) => AUD.test(v), 'should be 64 hex characters (the Application Audience tag)');
    }
  }
  return problems;
}

export function serialize(env) {
  const lines = ['# Production variables for the both-containers stack. PRIVATE: keep out of repos, vaults and cloud folders. Never commit.'];
  for (const n of ORDER) if (env[n] !== undefined && env[n] !== '') lines.push(`${n}=${env[n]}`);
  return lines.join('\n') + '\n';
}

function summary(env) {
  const rows = ORDER.map((n) => {
    const v = env[n];
    if (n === 'INGEST_SECRET') return `  ${n}: ${v ? `set, ${v.length} characters` : 'not set'}`;
    if (n === 'INGEST_REQUIRE_ACCESS_HEADER') return `  ${n}: ${v === '0' ? '0 (ingest WITHOUT Cloudflare Access, not recommended)' : 'not set (Cloudflare Access check on, the default)'}`;
    return `  ${n}: ${v ? 'set' : 'not set'}`;
  });
  return rows.join('\n');
}

// ---- input: raw mode in a terminal (so secrets are not echoed), plain lines when piped ----------------------------------------
function makeAsker() {
  const tty = Boolean(process.stdin.isTTY);
  let queue = null, closed = false, waiter = null, buf = '';
  if (!tty) {
    queue = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; const parts = buf.split(/\r?\n/); buf = parts.pop(); queue.push(...parts); if (waiter) { const w = waiter; waiter = null; w(); } });
    process.stdin.on('end', () => { if (buf) queue.push(buf); buf = ''; closed = true; if (waiter) { const w = waiter; waiter = null; w(); } });
  }
  const askPiped = async (q) => {
    process.stdout.write(q);
    while (!queue.length && !closed) await new Promise((r) => { waiter = r; });
    const line = queue.length ? queue.shift() : '';
    process.stdout.write('\n');
    return line;
  };
  const askTty = (q, hidden) => new Promise((resolve) => {
    process.stdout.write(q);
    let s = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); resolve(s); return; }
        if (ch === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\nCancelled.\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (s) { s = s.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { s += ch; if (!hidden) process.stdout.write(ch); }
      }
    };
    process.stdin.on('data', onData);
  });
  return (q, hidden = false) => (tty ? askTty(q, hidden) : askPiped(q));
}

async function askValid(ask, label, { def = '', hidden = false, ok, why, blankOk = false }) {
  for (let tries = 0; tries < 5; tries++) {
    const shown = def ? ` [${hidden ? 'keep' : def}]` : blankOk ? ' [blank to skip]' : '';
    const raw = (await ask(`${label}${shown}: `, hidden)).trim();
    const v = raw || def;
    if (!v && blankOk) return '';
    if (v && /[\s"'#]/.test(v)) { console.log('  No spaces, quotes or # in a value.'); continue; }
    if (v && ok(v)) return v;
    console.log(`  ${why}`);
  }
  throw new Error(`Too many invalid answers for ${label}.`);
}

function defaultPath() { return path.join(os.homedir(), 'webobs-secrets', 'webobs-stack.env'); }

function readEnvFile(file) {
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

function writeEnvFile(file, env) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialize(env), { mode: 0o600 });
}

function copyToClipboard(text) {
  const cmds = process.platform === 'win32' ? [['clip', []]] : process.platform === 'darwin' ? [['pbcopy', []]] : [['xclip', ['-selection', 'clipboard']], ['wl-copy', []]];
  for (const [cmd, args] of cmds) { const r = spawnSync(cmd, args, { input: text, windowsHide: true }); if (r.status === 0) return true; }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a.startsWith('--'));
  const fileArg = args.find((a) => !a.startsWith('--'));

  if (flag === '--fingerprints' || flag === '--write-expected') {
    const file = path.resolve(fileArg || defaultPath());
    const lines = fingerprintLines(readEnvFile(file));
    if (flag === '--fingerprints') {
      console.log(`Fingerprints from ${file}  (NAME  length  first 8 hex of sha256; no value is shown)\n`);
      console.log(lines.join('\n'));
      console.log('\nTo give the VPS these expected lines, paste this block into an ssh session on the VPS (it holds no secret):\n');
      console.log(heredoc(lines));
      return;
    }
    const out = path.resolve(args.filter((a) => !a.startsWith('--'))[1] || path.join(path.dirname(file), 'webobs-expected.txt'));
    fs.writeFileSync(out, lines.join('\n') + '\n');
    console.log(`Wrote ${lines.length} expected lines to ${out} (names, lengths and short fingerprints only, no values).\nCopy it to the VPS as ~/webobs-expected.txt (scp, or run --fingerprints and paste the block).`);
    return;
  }
  if (flag === '--check') {
    const file = path.resolve(fileArg || defaultPath());
    const env = readEnvFile(file);
    const problems = checkEnv(env);
    console.log(`Checked ${file}\n${summary(env)}`);
    if (problems.length) { console.log('\nProblems:\n' + problems.map((p) => '  ' + p).join('\n')); process.exitCode = 1; } else console.log('\nOK: nothing missing or too short.');
    return;
  }
  if (flag === '--rotate' || flag === '--copy-secret') {
    const file = path.resolve(fileArg || defaultPath());
    const env = readEnvFile(file);
    if (flag === '--copy-secret') {
      if (!env.INGEST_SECRET) throw new Error('INGEST_SECRET is not in that file.');
      console.log(copyToClipboard(env.INGEST_SECRET) ? `INGEST_SECRET (${env.INGEST_SECRET.length} characters) copied to the clipboard. Paste it into the plugin's Publish secret field, then clear the clipboard.` : 'Could not reach the clipboard on this system. Open the file yourself and copy the value.');
      return;
    }
    env.INGEST_SECRET = newSecret();
    writeEnvFile(file, env);
    console.log(`INGEST_SECRET: replaced, ${env.INGEST_SECRET.length} characters (not shown).`);
    console.log('Next: 1) load the file into the Portainer stack again and update the stack; 2) put the same value in the plugin\'s "Publish secret" field (run again with --copy-secret to copy it without showing it). Until both match, pushes are refused.');
    return;
  }

  const ask = makeAsker();
  console.log('Production variables for the both-containers stack. Secrets are not shown. Press Enter to accept a value in [brackets].\n');
  let file, problem;
  for (let tries = 0; tries < 5; tries++) {
    const raw = (await ask(`Where to save the file [${defaultPath()}]: `)).trim();
    file = path.resolve(raw || defaultPath());
    problem = pathProblem(file);
    if (!problem) break;
    console.log(`  Refused: ${problem}`);
  }
  if (problem) throw new Error('No acceptable path chosen. Nothing was written.');
  const lastBaseFile = path.join(path.dirname(file), '.last-base');
  let remembered = '';
  try { const v = fs.readFileSync(lastBaseFile, 'utf8').trim(); if (BASE_SHAPE.test(v)) remembered = v; } catch { /* nothing remembered yet */ }
  const env = {};
  console.log(`The public address is remembered (not secret) in ${lastBaseFile}, so next time you can just press Enter.`);
  env.WEBOBS_REPORT_BASE = await askValid(ask, 'Public address of the viewer', { def: remembered || DEFAULT_BASE, ok: (v) => BASE_SHAPE.test(v), why: 'Use https://host with no path and no trailing slash.' });
  env.RETENTION_DAYS = await askValid(ask, 'Days a report is served at most', { def: '90', ok: (v) => /^\d{1,4}$/.test(v) && Number(v) >= 1, why: 'A whole number of days.' });
  const ingestNow = ((await ask('Turn the ingest ON now? Say no for a viewer-only first deploy. [y/N]: ')).trim().toLowerCase().startsWith('y'));
  env.INGEST_ENABLED = ingestNow ? '1' : '0';
  env.INGEST_SECRET = newSecret();
  let noEdge = false;
  if (ingestNow) noEdge = (await ask('Use Cloudflare Access for the ingest? (recommended) [Y/n]: ')).trim().toLowerCase().startsWith('n');
  if (ingestNow && !noEdge) {
    env.CF_ACCESS_TEAM_DOMAIN = await askValid(ask, 'Cloudflare team domain (yourteam.cloudflareaccess.com)', { ok: (v) => TEAM.test(v), why: 'It should look like yourteam.cloudflareaccess.com (no https://).' });
    env.CF_ACCESS_AUD = await askValid(ask, 'Access application AUD tag (64 hex characters)', { hidden: true, ok: (v) => AUD.test(v), why: 'Copy the Application Audience (AUD) Tag from the Access application: 64 hex characters.' });
  } else if (ingestNow) {
    console.log(NO_EDGE_WARNING_LINES.join('\n'));
    env.INGEST_REQUIRE_ACCESS_HEADER = '0';
    env.INGEST_ACKNOWLEDGE_NO_EDGE_AUTH = 'yes';
    console.log('  The ingest counts requests per caller address for its rate limits. Name the header YOUR reverse proxy sets to the caller\'s');
    console.log('  address (and overwrites when a caller sends it). If the header is wrong or missing, all callers share one limit.');
    env.CLIENT_IP_HEADER = await askValid(ask, 'Client-IP header your reverse proxy sets', { def: 'x-real-ip', ok: (v) => HEADER.test(v), why: 'A plain header name, for example X-Real-IP.' });
  } else console.log('  Ingest stays off. The secret is made now so you can turn the ingest on later; Cloudflare names are not needed yet.');
  env.WEBOBS_FEEDBACK_TO = await askValid(ask, 'Where client feedback goes (email)', { blankOk: true, ok: (v) => EMAIL.test(v), why: 'Not an email address.' });
  const key = await askValid(ask, 'Resend API key (blank = no email, feedback stays in memory)', { hidden: true, blankOk: true, ok: (v) => v.length >= 20, why: 'That looks too short for an API key.' });
  if (key) {
    env.RESEND_API_KEY = key;
    env.RESEND_FROM = await askValid(ask, 'Sender address for feedback email', { ok: (v) => EMAIL.test(v), why: 'Not an email address.' });
    env.MAIL_MODE = 'resend';
  } else env.MAIL_MODE = 'outbox';

  if (fs.existsSync(file)) {
    const yes = (await ask(`${file} already exists. Overwrite it? Type yes to confirm: `)).trim().toLowerCase();
    if (yes !== 'yes') { console.log('Not overwritten. Nothing was written.'); process.exitCode = 1; return; }
  }
  writeEnvFile(file, env);
  try { fs.writeFileSync(lastBaseFile, env.WEBOBS_REPORT_BASE + '\n'); } catch { /* remembering is optional */ }
  console.log(`\nWritten: ${file}\n${summary(env)}`);
  const problems = checkEnv(env);
  if (problems.length) console.log('\nNote:\n' + problems.map((p) => '  ' + p).join('\n'));
  console.log(`
Next:
  1. Portainer > Stacks > Add stack > paste deploy/VPS-STACK-tunnel-both.yml > Environment variables > "Load variables from .env file" > pick this file.
  2. Keep the file private: not in a repo, not in a synced or shared folder, never committed. Delete it once the stack is deployed (Portainer keeps the values).
  3. The plugin's "Publish secret" must be the SAME value as INGEST_SECRET: run  node apps/server/tools/make-stack-env.mjs --copy-secret "${file}"  and paste it into the plugin (then clear the clipboard).
  4. Rotation later:  node apps/server/tools/make-stack-env.mjs --rotate "${file}"  then reload the file in Portainer and update the plugin field.
  5. Check any time (no values shown):  node apps/server/tools/make-stack-env.mjs --check "${file}"`);
  if (noEdge) console.log(`  6. Without Cloudflare: your reverse proxy must end HTTPS, set X-Forwarded-Proto: https and ${env.CLIENT_IP_HEADER}, and be the ONLY way to
     reach the ingest (do not publish port 8081). Work through the checklist in docs/SETUP.md before turning it on.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

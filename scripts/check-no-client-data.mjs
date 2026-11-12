// Fails if anything that `git add -A` would pick up (tracked or untracked, not ignored) looks like real client data.
// No client name appears in this file or anywhere in the repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
// The client names are NOT kept in this repository. They come from a local, git-ignored list: one pattern (a regular expression, matched
// without regard to case) per line, blank lines and lines starting with # ignored. The list is `.client-names` in the folder you run this
// from, or the file named by the environment variable WEBOBS_CLIENT_NAMES_FILE. If the list is missing, empty or not readable, the check FAILS
// with a plain message; it is never skipped silently. It is run locally before each commit and is NOT part of CI on purpose. The list is a local, untracked file and never a repository secret: anyone with write access to the repository can read its secrets through a workflow.
const listFile = process.env.WEBOBS_CLIENT_NAMES_FILE || '.client-names';
const stop = (why) => { console.error(`Client data check FAILED: ${why}\n  Put one client-name pattern per line in ${listFile} (git-ignored), or set WEBOBS_CLIENT_NAMES_FILE to a file that holds them.`); process.exit(1); };
let listText; try { listText = fs.readFileSync(listFile, 'utf8'); } catch { stop(`the list of client names is missing or cannot be read (${listFile}).`); }
const names = [];
for (const line of listText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) { try { names.push(new RegExp(line, 'i')); } catch { stop('a line in the list of client names is not a valid pattern.'); } }
if (!names.length) stop(`the list of client names is empty (${listFile}).`);
let files;
try {
  files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
} catch { // not inside a git work tree: check every file below the current folder instead
  files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === '.git') continue; const p = d === '.' ? e.name : d + '/' + e.name; if (e.isDirectory()) walk(p); else files.push(p); } })('.');
}
const allowed = new Set(['scripts/check-no-client-data.mjs']);
const bad = [];
for (const f of files) {
  if (allowed.has(f) || !fs.existsSync(f) || fs.statSync(f).size > 20e6) continue;
  if (/^(examples|dev-volume)\//.test(f) || /\.(client-report|explore-pack|walkthrough)\.json$/.test(f) && !f.startsWith('fixtures/')) { bad.push(`${f}: a report/export file outside the fixtures`); continue; }
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip|gz|pdf)$/i.test(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  const hit = names.find((r) => r.test(text));
  if (hit) bad.push(`${f}: matches a client-name pattern`);
}
if (bad.length) { console.error('Client data check FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`Client data check OK: ${files.length} files that git would add, none look like client data.`);

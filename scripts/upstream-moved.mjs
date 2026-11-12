// Reports whether upstream web-obs has moved past the commit recorded in UPSTREAM.md. It only reports: no pull request, no merge,
// no change to any file.   node scripts/upstream-moved.mjs [ref] [--url <git url or local path>] [--root <dir>]
// Prints "up to date (<sha>)" or "upstream has moved to <sha> (recorded: <commit>)". Exit 0 for both; 2 if the remote cannot be read.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, DEFAULT_URL, DEFAULT_REF, readManifest, isFullSha, parseArgs } from './lib/upstream.mjs';

const { pos, opts } = parseArgs(process.argv.slice(2), ['url', 'root']);
const root = path.resolve(opts.root || REPO_ROOT);
const { fields } = readManifest(root);
const url = opts.url || fields.Source || DEFAULT_URL;
const ref = pos[0] || (fields.Ref && /^[A-Za-z0-9._\/-]+$/.test(fields.Ref) ? fields.Ref : DEFAULT_REF);
if (ref.startsWith('-')) { console.error('bad ref'); process.exit(2); }
// The recorded commit; for the mixed baseline (no single commit) the "Compare base" field names the main commit it started from.
const recorded = isFullSha(fields.Commit) ? fields.Commit : (/^[0-9a-f]{7,40}$/.exec(fields['Compare base'] || '') || [])[0];

const r = spawnSync('git', ['ls-remote', url, ref], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
if (r.status !== 0) { console.error(`could not read ${url}: ${(r.stderr || '').trim().split('\n').pop()}`); process.exit(2); }
const lines = r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
const pick = lines.find(([, n]) => n === `refs/heads/${ref}`) || lines.find(([, n]) => n === `refs/tags/${ref}^{}`) || lines.find(([, n]) => n === `refs/tags/${ref}`) || lines[0];
if (!pick) { console.error(`${ref} not found at ${url}`); process.exit(2); }
const sha = pick[0];
if (recorded && sha.startsWith(recorded)) console.log(`up to date (${ref} is ${sha})`);
else console.log(`upstream has moved to ${sha} (${ref}; recorded: ${recorded || 'none'})`);

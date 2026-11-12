// One command from a capture (or an exported report) to a live link: export the allowlisted client JSON, create the link,
// copy the report and the link entry to the server's data folder, and print the link once. The Studio's Publish button runs
// the same flow (apps/server/scripts/lib/publish-core.mjs) through apps/server/scripts/publish-helper.mjs.
//
//   node apps/server/scripts/publish-client-report.mjs <_site-graph.json | name.client-report.json> --client <slug> [--approve-as "Name"]
//        [--hours 72] [--to user@host:/srv/webobs | /local/folder] [--base https://reports.example.com] [--dry-run]
//
// --to defaults to WEBOBS_PUBLISH_TARGET and --base to WEBOBS_REPORT_BASE (from .env). No password or key is read from any file:
// the upload uses your own SSH keys or agent (ssh and scp, BatchMode, so it never waits at a password prompt).
// The agency-only explore pack is created in a temporary folder only to be thrown away; it is never uploaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishAny, PublishError } from './lib/publish-core.mjs';

try { process.loadEnvFile(path.resolve(import.meta.dirname, '..', '..', '..', '.env')); } catch { /* no .env: flags only */ }
const [input, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) { if (rest[i] === '--dry-run') flags.dry = true; else if (rest[i].startsWith('--')) { flags[rest[i].slice(2)] = rest[i + 1]; i++; } }

let work = null;
const cleanup = () => { if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp folder left for the OS to clean */ } } };
const fail = (m, code = 2) => { console.error('error: ' + m); cleanup(); process.exit(code); };

if (!input || !fs.existsSync(input)) fail('usage: publish-client-report.mjs <_site-graph.json | .client-report.json> --client <slug> [--approve-as "Name"] [--hours 72] [--to target] [--base url] [--dry-run]');
const target = String(flags.to || process.env.WEBOBS_PUBLISH_TARGET || '').trim();
const base = String(flags.base || process.env.WEBOBS_REPORT_BASE || 'https://reports.example.com');

// A finished client report is recognised by its name (*.client-report.json) or by its content (format webobs.client-report).
const isClientReportFile = (file) => {
  if (file.endsWith('.client-report.json')) return true;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).format === 'webobs.client-report'; } catch { return false; }
};

let result;
try {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-publish-cli-'));
  let report = path.resolve(input);
  if (!isClientReportFile(report)) {
    if (!flags['approve-as']) fail('exporting from a capture needs --approve-as "Your Name" (a person approves what goes to a client)');
    const out = path.join(work, 'export');
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, 'export-client-report.mjs'), report, '--out', out, '--approve-as', String(flags['approve-as'])], { encoding: 'utf8' });
    if (r.status !== 0) fail('the export failed: ' + (r.stderr || '').trim().split(String.fromCharCode(10)).slice(-1)[0], 1);
    const made = fs.readdirSync(out).find((n) => n.endsWith('.client-report.json'));
    if (!made) fail('the export produced no client report');
    report = path.join(out, made);
  }
  console.log('1. client report ready: ' + path.basename(report));
  result = await publishAny({ reportFile: report, slug: String(flags.client || ''), hours: Number(flags.hours ?? process.env.WEBOBS_REPORT_TTL_HOURS ?? 72), target, base, indexFile: process.env.WEBOBS_REPORT_INDEX || undefined, dry: Boolean(flags.dry) });
  result.steps.forEach((s, i) => console.log(`${i + 2}. ${s}`));
} catch (e) {
  fail(e instanceof PublishError ? e.message : 'unexpected error', e instanceof PublishError && ['bad-slug', 'bad-hours', 'no-target', 'bad-target', 'bad-report', 'not-approved'].includes(e.code) ? 2 : 1);
} finally {
  cleanup(); // the export and the explore pack are thrown away
}
console.log('');
console.log('Send the client this link. It is shown once and is not stored anywhere (only its hash is):');
console.log(result.link);

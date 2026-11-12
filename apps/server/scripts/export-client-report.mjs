// Export a Client Report Package (JSON) from a Web-Obs capture.
// Usage: node apps/server/scripts/export-client-report.mjs <_site-graph.json> [--out dir] [--approve-as "Name"] [--no-map] [--feedback-to you@agency.com]   (default: WEBOBS_FEEDBACK_TO from .env) [--walkthrough saved.json] [--prepared-for "X"] [--presenter "Y"] [--accent #hex]
// Without --approve-as the package is written as a DRAFT and the command exits non-zero (a draft must not reach a client).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateStyles } from '../../viewer/brand/styles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--no-map'));
if (!file) { console.error('usage: export-client-report.mjs <_site-graph.json> [--out dir] [--approve-as "Name"]'); process.exit(2); }

const outJs = path.join(root, 'packages', 'contract', 'tests', '.build', 'core.mjs');
await build({ entryPoints: [path.join(root, 'packages', 'contract', 'tests', 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: outJs, logLevel: 'error' });
const lib = await import(pathToFileURL(outJs).href);

// Settings from the project's .env (real environment variables win). Nothing is hardcoded in the source.
for (const envFile of [path.join(root, '.env.local'), path.join(root, '.env')]) { try { process.loadEnvFile(envFile); } catch { /* no such file */ } }
const envTo = (process.env.WEBOBS_FEEDBACK_TO ?? '').trim() || undefined;
const envSubject = (process.env.WEBOBS_FEEDBACK_SUBJECT ?? '').trim() || undefined;
if (envTo && !lib.isEmail(envTo)) { console.error('WEBOBS_FEEDBACK_TO is not a valid email address.'); process.exit(2); }

const raw = fs.readFileSync(file);
const m = JSON.parse(raw.toString('utf8'));
const sha = crypto.createHash('sha256').update(raw).digest('hex');
let w;
let stylesFromFile = null;
if (flag('--walkthrough')) {
  w = JSON.parse(fs.readFileSync(flag('--walkthrough'), 'utf8'));
  if (w.walkthroughVersion !== '0.2') { console.error('Not a walkthrough 0.2 file.'); process.exit(2); }
  if (w.source?.manifestSha256 !== sha) { console.error('That walkthrough was written for a different capture.'); process.exit(1); }
} else w = lib.buildDraft(m, sha, { presenter: flag('--presenter'), preparedFor: flag('--prepared-for') });
if (flag('--styles')) {
  // A styles file (the look this report carries). Checked with the same function the upload and the server use; nothing is written if it does not pass.
  const v = validateStyles(JSON.parse(fs.readFileSync(flag('--styles'), 'utf8').replace(/^\uFEFF/, '')));
  if (!v.ok) { console.error('The styles file is not valid: ' + v.errors.join(' ')); process.exit(1); }
  stylesFromFile = v.styles;
}
if (flag('--accent')) w.brand.accent = { hex: flag('--accent'), approvedBy: flag('--approve-as') ?? null };
const approver = flag('--approve-as');
// A reviewed walkthrough saved from the studio carries its own approval; --approve-as is only for unreviewed drafts.
if (approver) { w.authoring.reviewState = 'approved'; w.authoring.reviewedBy = approver; }

if (flag('--feedback-to')) w.brand.feedbackEmail = flag('--feedback-to');
if (w.brand.feedbackEmail && !lib.isEmail(w.brand.feedbackEmail)) { console.error('--feedback-to is not a valid email address.'); process.exit(2); }
const v = lib.validate(w, m, { manifestSha: sha, mode: 'client' });
const dir = flag('--out') ?? path.join(path.dirname(file), 'client-report');
fs.mkdirSync(dir, { recursive: true });
const base = m.domain;
if (!v.ok) {
  console.error('Walkthrough is not exportable:\n' + v.errors.map((e) => `  - ${e.where}: ${e.message}`).join('\n'));
  fs.writeFileSync(path.join(dir, `${base}.walkthrough.draft.json`), JSON.stringify(w, null, 2));
  process.exit(1);
}
let report = lib.buildClientReport(w, m, { createdAt: new Date().toISOString(), includeMap: !args.includes('--no-map'), feedbackDefaults: { to: envTo, subject: envSubject }, ...(stylesFromFile ? { styles: stylesFromFile } : {}) });
report = await lib.sealReport(report, async (s) => crypto.createHash('sha256').update(s).digest('hex'));
const problems = lib.validateClientReport(report, lib.makeCtx(m));
if (problems.length) { console.error('Client report failed its own checks:\n' + problems.map((p) => `  - ${p.where}: ${p.message}`).join('\n')); process.exit(1); }
const pack = lib.buildExplorePack(w, m, report, { createdAt: new Date().toISOString() });
const packProblems = lib.validateExplorePack(pack);
if (packProblems.length) { console.error('Explore pack failed its checks:\n' + packProblems.map((p) => `  - ${p.where}: ${p.message}`).join('\n')); process.exit(1); }
fs.writeFileSync(path.join(dir, `${base}.client-report.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(dir, `${base}.explore-pack.json`), JSON.stringify(pack));
const kb = (f) => (fs.statSync(path.join(dir, f)).size / 1024).toFixed(0);
console.log(`wrote ${dir}\n  ${base}.client-report.json  (${kb(`${base}.client-report.json`)} KB, safe to send${report.feedback ? '; feedback goes to ' + report.feedback.to : '; NO feedback address set'})\n  ${base}.explore-pack.json   (${kb(`${base}.explore-pack.json`)} KB, AGENCY ONLY: never send)`);

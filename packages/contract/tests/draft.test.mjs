// Node test-suite for the pure walkthrough logic. Run: npm run report:test
// Usage: node packages/contract/tests/draft.test.mjs [manifest.json ...]   (defaults to fixtures/site/_site-graph.json)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.build', 'core.mjs');
await build({ entryPoints: [path.join(here, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const core = await import(pathToFileURL(out).href);

const defaults = [path.resolve(here, '..', '..', '..', 'fixtures', 'site', '_site-graph.json')];
const files = process.argv.slice(2).length ? process.argv.slice(2) : defaults.filter((f) => fs.existsSync(f));
if (!files.length) { console.error('no manifest found: run node fixtures/make-synthetic.mjs, or pass a _site-graph.json path'); process.exit(2); }

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

for (const file of files) {
  const raw = fs.readFileSync(file);
  const m = JSON.parse(raw.toString('utf8'));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  console.log(`\n${m.domain}  schema ${m.schemaVersion}  ${m.nodes.length} nodes`);
  const w = core.buildDraft(m, sha);
  const v = core.validate(w, m, { manifestSha: sha });
  check('draft validates with no errors', v.ok, v.errors.slice(0, 4).map((e) => `${e.where}: ${e.message}`).join(' | '));
  console.log(`       issues ${w.issues.length} (${w.issues.filter((i) => i.disposition !== 'confirmed').length} unverified), scenes ${w.scenes.length}, warnings ${v.warnings.length}`);
  console.log('       ' + w.issues.map((i) => `${i.id}[${i.severity.level}/${i.effort.size}${i.disposition !== 'confirmed' ? '/' + i.disposition : ''}]`).join(' '));

  // Every binding must render to a real value in every claim a client can see.
  const ctx = core.makeCtx(m);
  const dashes = [];
  const walk = (s, where) => { const errs = []; const r = core.renderText(s, ctx, errs); if (errs.length || r.includes('\u2014')) dashes.push(where); return r; };
  for (const i of w.issues) { i.whatWeSaw.forEach((c) => walk(c.text, i.id)); i.fix.forEach((s) => walk(s, i.id)); }
  check('all bindings render', dashes.length === 0, dashes.join(','));
  const texts = [];
  for (const i of w.issues) i.whatWeSaw.forEach((c) => texts.push(core.renderText(c.text, ctx)));
  for (const s of w.scenes) { s.claims?.forEach((c) => texts.push(core.renderText(c.text, ctx))); s.stops?.forEach((st) => texts.push(core.renderText(st.caption.text, ctx))); }
  const bad = texts.filter((x) => /(^|[^0-9])1 (page|link|image|match|group|gap|item|opportunity|anchor|pattern|note|mismatch|click|day) (have|are|point|load|contain|share|ask|name|use|show|delay|skip|do|link|were|return|redirect|cannot)/.test(x) || /[2-9]d* (pages|links) (has|is|was|points|loads|contains)/.test(x));
  check('count/verb agreement ("1 page has", "19 pages have")', bad.length === 0, bad.slice(0, 2).join(' | '));

  // Mutations the validator must reject.
  const mut = (name, fn) => { const c = structuredClone(w); fn(c); const r = core.validate(c, m, { manifestSha: sha }); check(`rejects: ${name}`, r.errors.length > 0); };
  if (w.issues[0]) {
    mut('invented number in prose', (c) => { c.issues[0].whatWeSaw[0].text = '37 pages are affected.'; });
    mut('unknown finding', (c) => { c.issues[0].findings.push('seo:made-up'); });
    mut('revenue promise', (c) => { c.issues[0].whyItMatters.push({ text: 'Fixing this will increase leads.', label: 'INFER', basis: 'x' }); });
    mut('INFER without basis', (c) => { c.issues[0].whyItMatters[0] && delete c.issues[0].whyItMatters[0].basis; if (!c.issues[0].whyItMatters[0]) c.issues[0].whyItMatters = [{ text: 'x', label: 'INFER' }]; });
    mut('observation without refs', (c) => { c.issues[0].whatWeSaw[0].refs = []; });
    mut('stale manifest hash', (c) => { c.source.manifestSha256 = '0'.repeat(64); });
    mut('unverified issue in client scene', (c) => { c.issues[0].disposition = 'needs-verification'; delete c.issues[0].dispositionNote; });
  }
  // The client copy must not carry presenter material in the data itself.
  const cc = core.stripForClient(w);
  const json = JSON.stringify(cc);
  check('client copy has no talk tracks', !json.includes('"talk"'));
  check('client copy has no presenter-only scenes', cc.scenes.every((s) => (s.audience ?? 'client') === 'client'));
  check('client copy has no unverified issues or notes', cc.issues.every((i) => i.disposition === 'confirmed') && !json.includes('dispositionNote'));
  check('client copy still validates', core.validate(cc, m, { manifestSha: sha }).ok, core.validate(cc, m, { manifestSha: sha }).errors.slice(0, 2).map((e) => e.message).join(' | '));
  check('full walkthrough is untouched by stripping', JSON.stringify(w).includes('"talk"') === (w.scenes.some((s) => s.talk?.length) || w.issues.some((i) => i.talk?.length)));
  const clientGate = core.validate(w, m, { manifestSha: sha, mode: 'client' });
  check('client export blocked until approved', !clientGate.ok);
  w.authoring.reviewState = 'approved';
  check('client export allowed once approved', core.validate(w, m, { manifestSha: sha, mode: 'client' }).ok);
}
// A skipped browser step leaves an empty pages list. That must not produce a "Browser tests covered N pages" line (and so no blocking error).
if (files.length) {
  const raw0 = fs.readFileSync(files[0]);
  const base = JSON.parse(raw0.toString('utf8'));
  const sha0 = crypto.createHash('sha256').update(raw0).digest('hex');
  const withPages = (pages) => { const x = structuredClone(base); x.siteIntel = { ...(x.siteIntel ?? {}), browserAudit: { state: pages.length ? 'ok' : 'skipped', pages, findings: [] } }; return x; };
  const limitsOf = (x) => core.buildDraft(x, sha0).scenes.flatMap((s) => JSON.stringify(s)).join(' ');
  const empty = withPages([]), some = withPages([{ url: 'https://example.test/', lab: { lcpMs: 1200 } }]);
  const wEmpty = core.buildDraft(empty, sha0), wSome = core.buildDraft(some, sha0);
  check('browser pages empty: no "Browser tests covered" line', !limitsOf(empty).includes('Browser tests covered'));
  check('browser pages empty: the draft has no blocking problem from it', !core.validate(wEmpty, empty, { manifestSha: sha0 }).errors.some((e) => /browserAudit\.pages/.test(e.message)));
  check('browser pages present: the "Browser tests covered" line is there', limitsOf(some).includes('Browser tests covered'));
  check('browser pages present: the line validates', !core.validate(wSome, some, { manifestSha: sha0 }).errors.some((e) => /browserAudit\.pages/.test(e.message)));
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

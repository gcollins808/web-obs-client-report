// Tests for the Client Report Package 1.1 and the agency-only Explore Pack. Run: npm run report:test:package
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.build', 'core.mjs');
await build({ entryPoints: [path.join(here, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const L = await import(pathToFileURL(out).href);

const defaults = [path.resolve(here, '..', '..', '..', 'fixtures', 'site', '_site-graph.json')];
const files = process.argv.slice(2).length ? process.argv.slice(2) : defaults.filter((f) => fs.existsSync(f));
if (!files.length) { console.error('no manifest found: run node fixtures/make-synthetic.mjs, or pass a _site-graph.json path'); process.exit(2); }
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const sha256 = async (s) => crypto.createHash('sha256').update(s).digest('hex');
const SEV = { high: 3, medium: 2, low: 1 };

for (const file of files) {
  const raw = fs.readFileSync(file);
  const m = JSON.parse(raw.toString('utf8'));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  console.log(`\n${m.domain}`);
  const w = L.buildDraft(m, sha, { presenter: 'Dana', preparedFor: 'Casey' });
  w.authoring.reviewState = 'approved'; w.authoring.reviewedBy = 'Tester';
  w.brand.feedbackEmail = 'feedback@agency.example';
  w.scenes.forEach((s) => { s.talk = ['PRIVATE-SCENE-NOTE']; s.stops?.forEach((st) => { st.talk = ['PRIVATE-STOP-NOTE']; }); });
  w.issues.forEach((i) => { i.talk = ['PRIVATE-ISSUE-NOTE']; });
  const ctx = L.makeCtx(m);
  const r = await L.sealReport(L.buildClientReport(w, m, { createdAt: '2026-01-01T00:00:00Z' }), sha256);
  const json = JSON.stringify(r);
  const g = r.modes.guided;

  // ---- client report: safety --------------------------------------------------
  check('package validates', L.validateClientReport(r, ctx).length === 0, L.validateClientReport(r, ctx).slice(0, 3).map((p) => `${p.where}: ${p.message}`).join(' | '));
  check('no presenter notes in client file', !json.includes('PRIVATE-'));
  check('no unresolved bindings', !json.includes('{{'));
  check('no vault paths or raw links', !/obsidianPath|rawPath|_site-graph|targetUrl/.test(json));
  check('unverified findings are held back', w.issues.filter((i) => i.disposition !== 'confirmed').every((i) => !r.findings.some((f) => f.id === i.id)));
  check('presentation mode is gone', !('presentation' in r.modes) && r.version === '1.1');
  check('integrity hash verifies', (() => { const { integrity } = r.meta; const body = { ...r, meta: { ...r.meta, integrity: undefined } }; return integrity && crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') === integrity.contentSha256; })());
  check('deterministic (same input, same bytes)', JSON.stringify(L.buildClientReport(w, m, { createdAt: 'x' })) === JSON.stringify(L.buildClientReport(w, m, { createdAt: 'x' })));
  check('map is optional', L.validateClientReport(L.buildClientReport(w, m, { createdAt: 'x', includeMap: false }), ctx).length === 0);

  // ---- tour: top five, ranking, categories ---------------------------------------
  check('tour has at most five findings, default = the ranked top', g.top.picked === 'auto' && g.top.findingIds.length <= 5 && g.top.findingIds.every((id, i) => id === r.findings[i].id));
  check('tour ends with the feedback step and states how it ranks', g.tour[g.tour.length - 1] === 'send' && g.top.basis === L.RANKING_BASIS);
  check('every finding is in exactly one of tour / more', r.findings.every((f) => { const s = g.steps.find((x) => x.kind === 'finding' && x.findingId === f.id); return s && g.tour.includes(s.id) !== g.more.includes(s.id); }));
  check('every finding names its engine categories', r.findings.every((f) => f.categories.length > 0 && f.categories.every((c) => c.id && c.label)));
  check('sitewide issues have no spotlight; page issues point at real map nodes', r.findings.every((f) => (f.scope === 'sitewide' ? f.spotlight.kind === 'sitewide' : true) && (f.spotlight.kind !== 'pages' || f.spotlight.nodeIds.every((id) => r.map.site.nodes.some((n) => n.id === id)))));
  {
    // Ranking is priority level first, then distinct pages affected, never raw item counts.
    const pack = L.buildExplorePack(w, m, r, { createdAt: 'x' });
    const conf = pack.stories.filter((s) => s.disposition === 'confirmed');
    const ordered = conf.every((a, i) => i === 0 || SEV[conf[i - 1].severity.level] > SEV[a.severity.level] || (SEV[conf[i - 1].severity.level] === SEV[a.severity.level] && conf[i - 1].pagesAffected >= a.pagesAffected));
    check('ranking: severity first, then distinct pages affected', ordered, conf.map((s) => `${s.severity.level}/${s.pagesAffected}`).join(' '));
    check('held-back stories rank below every confirmed one', pack.stories.findIndex((s) => s.disposition !== 'confirmed') < 0 || pack.stories.slice(0, conf.length).every((s) => s.disposition === 'confirmed'));

    // ---- explore pack ----------------------------------------------------------------
    check('explore pack validates and is agency-only', L.validateExplorePack(pack).length === 0 && pack.audience === 'agency-only', L.validateExplorePack(pack).slice(0, 2).map((p) => p.message).join(' | '));
    check('explore pack holds the whole scrape (every node, every engine finding)', pack.capture.nodes.length === m.nodes.length && (pack.capture.audit?.findings?.length ?? 0) === (m.audit?.findings?.length ?? 0));
    check('explore pack carries held-back stories and private notes', w.issues.filter((i) => i.disposition !== 'confirmed').every((i) => pack.stories.some((s) => s.id === i.id)) && JSON.stringify(pack).includes('PRIVATE-SCENE-NOTE') && (!w.issues.length || JSON.stringify(pack).includes('PRIVATE-ISSUE-NOTE')));
    check('explore pack has no vault paths or machine details', !('captureProvenance' in pack.capture) && pack.capture.nodes.every((n) => !('obsidianPath' in n) && !('rawPath' in n)));
    check('client validator refuses an explore pack', L.validateClientReport(pack, ctx).length > 0);
    const bad = structuredClone(pack); bad.audience = 'everyone';
    check('explore pack must be marked agency-only', L.validateExplorePack(bad).length > 0);
    const bad2 = structuredClone(pack); bad2.capture.nodes[0].obsidianPath = 'x.md';
    check('explore pack rejects a vault path', L.validateExplorePack(bad2).length > 0);
  }

  // ---- top-five picks -------------------------------------------------------------
  if (r.findings.length >= 3) {
    const want = [r.findings[2].id, r.findings[0].id];
    const wp = structuredClone(w); wp.tour = { picks: [...want, 'does-not-exist'] };
    const rp = L.buildClientReport(wp, m, { createdAt: 'x' });
    check('agency picks are honoured, in their order', rp.modes.guided.top.picked === 'agency' && rp.modes.guided.top.findingIds.join() === want.join() && L.validateClientReport(rp, ctx).length === 0);
    const wq = structuredClone(w); wq.tour = { picks: r.findings.map((f) => f.id) };
    check('picks are capped at five', L.buildClientReport(wq, m, { createdAt: 'x' }).modes.guided.top.findingIds.length <= 5);
    const wu = structuredClone(w); wu.issues[0].disposition = 'needs-verification'; wu.issues[0].dispositionNote = 'x'; wu.tour = { picks: [wu.issues[0].id] };
    check('an unverified issue cannot be pinned into the tour', !L.buildClientReport(wu, m, { createdAt: 'x' }).modes.guided.top.findingIds.includes(wu.issues[0].id));
  }

  // ---- feedback email ----------------------------------------------------------------
  {
    const answers = {}, comments = {};
    for (const id of g.top.findingIds) { answers[`cp-${id}`] = 'This surprises me'; comments[id] = 'Please call me about this.'; }
    const fb = L.composeFeedback(r, { answers, comments, general: 'Thanks.', name: 'Casey' });
    check('feedback: mailto goes to the agency address with a subject and the answers', fb.mailto?.startsWith('mailto:feedback@agency.example?subject=') && (g.top.findingIds.length === 0 || (decodeURIComponent(fb.mailto).includes('This surprises me') && decodeURIComponent(fb.mailto).includes(r.findings[0].title))));
    check('feedback: stays within the mailto length limit', !fb.mailto || fb.mailto.length <= L.MAILTO_LIMIT);
    const long = {}; for (const id of g.top.findingIds) long[id] = 'x'.repeat(590);
    const fl = L.composeFeedback(r, { answers, comments: long, general: 'y'.repeat(1400), name: 'Casey' });
    check('feedback: long messages are shortened for mailto but kept whole for copy', g.top.findingIds.length === 0 || (fl.truncated && fl.mailto.length <= L.MAILTO_LIMIT && fl.body.length > 3000));
    const noTo = structuredClone(r); delete noTo.feedback;
    check('feedback: no address set means no mailto, copy/download only', L.composeFeedback(noTo, { answers, comments }).mailto === null);
    const hostile = L.composeFeedback(r, { answers: {}, comments: {}, name: 'a&b=c?d\n\rBcc: evil@x.example' });
    check('feedback: special characters cannot add recipients or headers', hostile.mailto && !/[\r\n]/.test(hostile.mailto) && decodeURIComponent(hostile.mailto.split('&body=')[0]).split('?subject=')[0] === 'mailto:feedback@agency.example');
    const wn = structuredClone(w); delete wn.brand.feedbackEmail;
    check('feedback: absent in the file when the agency sets no address', L.buildClientReport(wn, m, { createdAt: 'x' }).feedback === undefined);
    const dflt = L.buildClientReport(wn, m, { createdAt: 'x', feedbackDefaults: { to: 'default@env.example', subject: 'Re: {client}' } });
    check('feedback: .env default fills in when the report sets no address', dflt.feedback?.to === 'default@env.example' && dflt.feedback.subject === `Re: ${r.client.name}` && L.validateClientReport(dflt, ctx).length === 0);
    check('feedback: a per-report address beats the .env default', L.buildClientReport(w, m, { createdAt: 'x', feedbackDefaults: { to: 'default@env.example' } }).feedback.to === 'feedback@agency.example');
    const stepIds = new Set(m.nodes.map((n) => n.id));
    const claims = g.steps.flatMap((x) => (x.kind === 'finding' ? x.beats.found : []));
    check('claims: every claim page list points at real map pages', claims.every((c) => (c.nodeIds ?? []).every((id) => stepIds.has(id))));
    const th = structuredClone(r); th.client.theme = { accent: '#112233', dark: { bg: 'red;}body{display:none' } };
    const mp = r.map?.site;
    if (mp) {
      check('contract: the map carries no capture internals', ['resources', 'linkHealth', 'siteIntel', 'sitemaps', 'robotsPolicy', 'captureWarnings', 'recapture'].every((k) => !(k in mp)));
      check('contract: map pages carry no notes, paths or page text', mp.nodes.every((n) => !('metaDescription' in n) && !('obsidianPath' in n) && !('h1' in n) && !('snapshot' in n)));
      const leak = structuredClone(r); leak.map.site.nodes[0].obsidianPath = 'C:/vault/x.md'; leak.map.site.resources = [];
      check('contract: a field outside the allowlist is refused', L.validateClientReport(leak, ctx).filter((p) => /not part of the contract/.test(p.message)).length >= 2);
    }
    const extra = structuredClone(r); extra.agencyNotes = 'x';
    check('contract: an unknown top-level field is refused', L.validateClientReport(extra, ctx).some((p) => /contract/.test(p.message)));
    check('theme: a non-hex colour is rejected', L.validateClientReport(th, ctx).some((p) => p.where.startsWith('client.theme')));
    check('feedback: a newline in the .env subject cannot inject a header', !/[\r\n]/.test(L.buildClientReport(wn, m, { createdAt: 'x', feedbackDefaults: { to: 'a@b.co', subject: 'hi' + String.fromCharCode(10) + 'Bcc: x@y.zz' } }).feedback.subject));
  }
  console.log(`       findings ${r.findings.length}, guided ${g.steps.length} steps (tour ${g.tour.length}), report ${(json.length / 1024).toFixed(0)} KB, explore pack ${(JSON.stringify(L.buildExplorePack(w, m, r, { createdAt: 'x' })).length / 1024).toFixed(0)} KB`);

  // ---- the validator must reject a tampered or careless file ----------------------
  const mut = (name, fn) => { if (!r.findings.length) return; const c = structuredClone(r); fn(c); check(`rejects: ${name}`, L.validateClientReport(c, ctx).length > 0); };
  mut('draft review state', (c) => { c.meta.review.state = 'draft'; });
  mut('leaked talk key', (c) => { c.findings[0].talk = ['x']; });
  mut('leaked explore data', (c) => { c.stories = []; });
  mut('presentation mode reintroduced', (c) => { c.modes.presentation = { sequence: [] }; });
  mut('unresolved binding', (c) => { c.findings[0].observed[0].text += ' {{m:stats.x}}'; });
  mut('promise language', (c) => { c.findings[0].implications.push({ text: 'This will increase leads.', label: 'INFER', labelText: 'x', basis: 'b', sources: [] }); });
  mut('observation without sources', (c) => { c.findings[0].observed[0].sources = []; });
  mut('INFER without basis', (c) => { c.findings[0].implications.push({ text: 'x', label: 'INFER', labelText: 'x', sources: [] }); });
  mut('guided step for a missing finding', (c) => { c.modes.guided.steps.find((s) => s.kind === 'finding').findingId = 'nope'; });
  mut('hand-typed figure in plain prose', (c) => { c.modes.guided.steps.find((s) => s.kind === 'finding').beats.yourPart = 'Fix all 40 pages.'; });
  mut('missing glossary term', (c) => { c.glossary = []; });
  mut('tour references an unknown step', (c) => { c.modes.guided.tour.push('nope'); });
  mut('tour not ending with feedback step', (c) => { c.modes.guided.tour = c.modes.guided.tour.filter((id) => id !== 'send'); });
  mut('six findings in the tour', (c) => { c.modes.guided.top.findingIds = [...c.findings.map((f) => f.id), ...c.findings.map((f) => f.id)].slice(0, 6); });
  mut('no ranking basis', (c) => { c.modes.guided.top.basis = ''; });
  mut('spotlight at a page that is not on the map', (c) => { c.findings[0].spotlight = { kind: 'pages', nodeIds: ['ghost'], pageCount: 1, filter: 'all' }; });
  mut('vault path in the globe data', (c) => { c.map.site.nodes[0].obsidianPath = 'sites/x/page.md'; });
  mut('bad feedback address', (c) => { c.feedback.to = 'not an email'; });
  mut('feedback address with a header injection', (c) => { c.feedback.to = 'a@b.co\nBcc: x@y.zz'; });
  mut('multi-line feedback subject', (c) => { c.feedback.subject = 'hi\nBcc: x@y.zz'; });
  mut('non-image asset', (c) => { c.assets.x = 'javascript:alert(1)'; });
}
// ---- values and nested structure (the same cases are run against the server's copy in apps/server/ingest/test.mjs) ----
{
  console.log('\nvalues and nested fields');
  const { applyCase, loadBadValues, loadSynthetic } = await import(pathToFileURL(path.join(here, '..', '..', '..', 'fixtures', 'apply-case.mjs')).href);
  const base = loadSynthetic(), cases = loadBadValues();
  const problems = (r) => L.validateClientReport(r).map((p) => `${p.where}: ${p.message}`);
  check('the checked-in synthetic report validates', problems(base).length === 0, problems(base).slice(0, 3).join(' | '));
  for (const c of cases.good) { const p = problems(applyCase(base, c)); check(`still valid: ${c.name}`, p.length === 0, p.slice(0, 2).join(' | ')); }
  for (const c of cases.bad) { const p = problems(applyCase(base, c)); check(`refused: ${c.name}`, p.length > 0); }
  check('feedback address strictness: "?bcc=" is not an email', !L.isEmail('a@b.co?bcc=x@y.zz') && L.isEmail('a@b.co'));
  check('the values are in the check names too: javascript: in a map page url is named in the problem', problems(applyCase(base, cases.bad.find((c) => c.set === 'map.site.nodes.0.url'))).some((s) => s.startsWith('map.site.nodes[0].url')));
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall package checks passed');
process.exit(failed ? 1 : 0);

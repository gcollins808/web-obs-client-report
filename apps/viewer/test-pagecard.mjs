// Unit checks for the page card data (v0.1.5): which findings touch a page and which tour step covers it. Pure; no browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };
const out = await build({ entryPoints: ['apps/viewer/src/lib/pageCard.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { pageCardInfo } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].contents).toString('base64'));
const report = JSON.parse(fs.readFileSync('fixtures/client-report.sample.json', 'utf8'));
const nodes = report.map.site.nodes;
const steps = report.modes.guided.steps, tour = report.modes.guided.tour.map((id) => steps.find((s) => s.id === id)).filter(Boolean);
const claimPage = steps.flatMap((s) => (s.kind === 'finding' ? s.beats.found : [])).flatMap((c) => c.nodeIds ?? []).find((id) => nodes.some((x) => x.id === id));

ok('a page named by a finding step lists that finding and jumps to a tour step', () => {
  assert.ok(claimPage, 'the sample has a page named by a statement');
  const i = pageCardInfo(report, nodes, tour, claimPage);
  assert.ok(i); assert.ok(i.findings.length >= 1); assert.ok(i.findings.every((f) => f.id && typeof f.title === 'string'));
  assert.ok(i.jump && i.jump.tourIndex >= 0 && i.jump.tourIndex < tour.length);
  assert.equal(tour[i.jump.tourIndex].kind === 'finding' || tour[i.jump.tourIndex].kind === 'map', true);
});
ok('title and path come from the page and are bounded', () => {
  const i = pageCardInfo(report, [{ id: 'p', title: 'x'.repeat(500), path: '/y'.repeat(400) }], tour, 'p');
  assert.equal(i.title.length, 160); assert.equal(i.path.length, 300); assert.equal(i.jump, null); assert.deepEqual(i.findings, []);
});
ok('a page with no title uses its path; with neither, a plain line', () => {
  assert.equal(pageCardInfo(report, [{ id: 'p', path: '/about' }], tour, 'p').title, '/about');
  assert.equal(pageCardInfo(report, [{ id: 'p' }], tour, 'p').title, 'This page');
});
ok('an unknown page, a missing report and hostile input return null and never throw', () => {
  assert.equal(pageCardInfo(report, nodes, tour, 'no-such-page'), null);
  assert.equal(pageCardInfo(null, nodes, tour, nodes[0].id), null);
  assert.equal(pageCardInfo(report, null, tour, 'x'), null);
  assert.equal(pageCardInfo(report, nodes, tour, { toString() { throw new Error('boom'); } }), null);
});
ok('a map step that names a page gives its view number', () => {
  const synth = { findings: [], modes: { guided: { steps: [] } } };
  const mapStep = { id: 'm', kind: 'map', stops: [{ focus: { nodeIds: ['a'] } }, { focus: { nodeIds: ['b'] } }] };
  synth.modes.guided.steps = [mapStep];
  assert.deepEqual(pageCardInfo(synth, [{ id: 'b', title: 'B' }], [mapStep], 'b').jump, { tourIndex: 0, stopIdx: 1 });
});
ok('a page only in a step outside the tour lists the finding but has no jump', () => {
  const f = { id: 'f1', title: 'A finding' };
  const stepIn = { id: 'g-f1', kind: 'finding', findingId: 'f1', beats: { found: [{ nodeIds: ['p'] }] } };
  const synth = { findings: [f], modes: { guided: { steps: [stepIn] } } };
  const i = pageCardInfo(synth, [{ id: 'p', title: 'P' }], [], 'p');
  assert.deepEqual(i.findings, [{ id: 'f1', title: 'A finding' }]); assert.equal(i.jump, null);
});
console.log(`Page card data OK: ${n} checks.`);

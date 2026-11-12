// Static regression test for the refresh splash: while a report is loading after a refresh, the viewer must show only a quiet line (no box that
// looks like a file drop zone, no "One moment" splash), must open dark from the first paint, and the error panel must not use a dashed drop style.
// The real-browser version of this check is in apps/server/e2e.mjs. Foreground, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(here, 'src', 'main.tsx'), 'utf8');
const css = fs.readFileSync(path.join(here, 'src', 'viewer.css'), 'utf8');
const brand = fs.readFileSync(path.join(here, 'brand', 'load-brand.mjs'), 'utf8');
const pv = fs.readFileSync(path.join(here, 'src', 'components', 'PackageViewer.tsx'), 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };
const rule = (sel) => { const i = css.indexOf(sel + ' {'); assert.ok(i >= 0, 'css rule missing: ' + sel); return css.slice(i, css.indexOf('}', i)); };

ok('the loading state is one quiet line, not the drop-style box and not a splash', () => {
  const at = main.indexOf('error || !hasSource');
  const seg = main.slice(at, at + 420);
  const colon = seg.search(/\n\s*: /);
  assert.ok(colon > 0, 'the loading branch follows the error branch');
  const errPart = seg.slice(0, colon), loadPart = seg.slice(colon).split('</p>')[0];
  assert.match(errPart, /pv-dropbox/);
  assert.match(loadPart, /className="pv-loading"/);
  assert.doesNotMatch(loadPart, /pv-dropbox|One moment|<h1>/);
  assert.ok(!/One moment/.test(main), 'no "One moment" splash text anywhere');
});
ok('the error panel is a plain solid panel, never a dashed drop-zone look', () => {
  assert.ok(!/dashed/.test(rule('.pv-open .pv-dropbox')), 'no dashed border');
  assert.match(rule('.pv-open .pv-dropbox'), /border: 1px solid/);
});
ok('the loading line appears only after a moment (fade in with a delay of one second or more)', () => {
  const r = rule('.pv-open .pv-loading');
  assert.match(r, /opacity: 0/);
  const m = /animation: pv-fade-in [0-9.]+s ease ([0-9.]+)s/.exec(r);
  assert.ok(m && Number(m[1]) >= 1, 'delay: ' + (m ? m[1] : 'none'));
  assert.match(css, /@keyframes pv-fade-in/);
});
ok('viewer pages are dark from the first paint (the same fixed colour in every build)', () => {
  assert.match(css, /html\[data-start='viewer'\] \{ background: #07090f; \}/);
  assert.doesNotMatch(brand, /data-start='viewer'\]\{background/); // the page colour is reserved: a brand never sets it
});
ok('the step stays in the address so a refresh returns to it (read on load, written on every change)', () => {
  assert.match(pv, /useState\(\(\) => Number\(\/step=\(\[0-9\]\+\)\/\.exec\(hash\)/);
  assert.match(pv, /history\.replaceState\(null, '', location\.pathname \+ location\.search \+ '#step=' \+ cur\)/);
});
console.log(`all ${n} refresh-splash checks passed`);

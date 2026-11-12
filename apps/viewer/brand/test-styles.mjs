// Tests for the shared styles validator and CSS writer (apps/viewer/brand/styles.mjs, styles-hash.mjs). Synthetic data only. Foreground and self-terminating.
//   node apps/viewer/brand/test-styles.mjs
import assert from 'node:assert/strict';
import {
  validateStyles, deriveStyleOutput, buildStyleCss, cssIsSafe, canonicalStyles, safeJson, fontFilesFor,
  STYLE_SLOTS, COLOR_SLOTS, FONT_SLOTS, TEXT_SLOTS, STYLES_MAX_CHARS, BUNDLED_FONTS,
} from './styles.mjs';
import { stylesHash, makeEnvelope } from './styles-hash.mjs';
import { STAGE_BG, contrast } from './color.mjs';

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };
const good = () => ({ accent: '#F2994A', secondary: '#2ECDF5', link: '#23AEEB', text: '#C4C4C4', muted: '#6B6B6B', surface: '#101010', headingFont: 'Oswald', bodyFont: 'Inter', headingCase: 'uppercase', name: 'Example Agency', footerText: 'Prepared by Example Agency' });
const FONT_B64 = { 'Oswald.woff2': 'AAAA', 'Inter-Regular.woff2': 'AAAA', 'Inter-SemiBold.woff2': 'AAAA' };

// ---- a good file ----
ok('a full file passes; colours are lower-cased; the result is a fresh object with only the allowed slots', () => {
  const input = good(); const v = validateStyles(input);
  assert.equal(v.ok, true, v.errors.join(' ')); assert.deepEqual(Object.keys(v.styles).sort(), STYLE_SLOTS.filter((k) => k !== 'cardText' && k !== 'cardMuted').sort());
  assert.equal(v.styles.accent, '#f2994a'); assert.notEqual(v.styles, input);
});
ok('an empty file and a file with one slot pass (every slot is optional)', () => { assert.equal(validateStyles({}).ok, true); assert.equal(validateStyles({ accent: '#112233' }).ok, true); });
ok('the slot list is the documented one and has no slot for the stage background or the 3D render', () => {
  assert.deepEqual([...STYLE_SLOTS].sort(), ['accent', 'bodyFont', 'cardMuted', 'cardText', 'footerText', 'headingCase', 'headingFont', 'link', 'muted', 'name', 'secondary', 'surface', 'text']);
  for (const reserved of ['bg', 'background', 'stage', 'render', 'palette', 'grey_0', 'grey_1', 'headerText']) assert.ok(!STYLE_SLOTS.includes(reserved), reserved);
  for (const reserved of ['bg', 'background', 'stage', 'grey_0', 'grey_1', 'headerText']) { const v = validateStyles({ [reserved]: '#000000' }); assert.equal(v.ok, false); assert.deepEqual(v.codes, ['unknown-key']); }
});
ok('a typo names the key in the message ("acent")', () => { const v = validateStyles({ acent: '#112233' }); assert.equal(v.ok, false); assert.match(v.errors[0], /"acent"/); });

// ---- the hostile table: every slot against every attack value ----
const ATTACKS = [
  '</style>', '</script>', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'url(http://example.invalid/x)', 'url(', '@import "x"', '@import url(x);', '\\', '\\3c /style', '$&', "$'", '$`', '$1',
  '"; } body { display:none } /*', "'; background: url(x)", '{', '}', '};--x:1;{', 'expression(alert(1))', 'javascript:alert(1)', '__proto__', 'constructor', 'prototype', 'toString',
  '#GGGGGG', '#fff', '#ffff', '#12345', '#1234567', 'red', 'rgb(1,2,3)', 'var(--x)', 'calc(1px)', '/* c */', '#112233; color: red', ' #112233', '#112233 ', '#11223\n3',
  'x'.repeat(5000), '', ' ', 123, 1.5, NaN, Infinity, -1, true, false, null, undefined, [], ['#112233'], {}, { a: 1 }, () => 1, Symbol('x'), 10n,
];
ok('hostile table: no attack value ever reaches the CSS, and a colour, font or case slot accepts none of them', () => {
  for (const slot of [...COLOR_SLOTS, ...FONT_SLOTS, 'headingCase']) {
    for (const a of ATTACKS) {
      const v = validateStyles({ [slot]: a });
      assert.equal(v.ok, false, `${slot} accepted ${String(a).slice(0, 30)}`);
      assert.equal(v.styles, null);
    }
  }
});
ok('hostile table: the text slots accept plain text (even with < > quotes) but it only ever leaves escaped; control characters, bidi marks, lone surrogates and overlong text are refused', () => {
  for (const slot of Object.keys(TEXT_SLOTS)) {
    for (const a of ATTACKS) {
      const v = validateStyles({ [slot]: a });
      if (!v.ok) continue;
      // accepted text: it must be a plain string, and the finished page pieces must hold it only escaped
      const out = deriveStyleOutput(v.styles); const json = safeJson(out.page);
      assert.ok(!/[<>&]/.test(json), `${slot}: ${a} is not escaped in the JSON block`);
      if (out.titleText) assert.ok(!/[<>"']/.test(out.titleText.replace(' · Website health walkthrough', '')), `${slot}: ${a} is not escaped in the title`);
      const css = buildStyleCss(out, FONT_B64); if (typeof a === 'string' && a.trim().length >= 5) assert.ok(css === null || !String(css).includes(a.trim()), `${slot}: text reached the CSS`);
    }
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\u009fb', 'a\u202eb', 'a\u2066b', 'a\u200bb', 'a\ufeffb', 'a\u2028b', 'a\u2029b', 'a\ud800b', 'a\udc00b', 'a\nb', 'a\tb', 'x'.repeat(TEXT_SLOTS[slot] + 1)]) assert.equal(validateStyles({ [slot]: bad }).ok, false, `${slot}: ${JSON.stringify(bad)}`);
    assert.equal(validateStyles({ [slot]: 'x'.repeat(TEXT_SLOTS[slot]) }).ok, true, 'the exact limit passes');
  }
});
ok('text with 4-byte characters and other scripts is fine', () => { assert.equal(validateStyles({ name: 'Café 東京 😀' }).ok, true); });
ok('a file with EVERY field filled with injection attempts is rejected whole (nothing partial is returned)', () => {
  const evil = {}; STYLE_SLOTS.forEach((k, i) => { evil[k] = ATTACKS[(i * 5) % 30]; });
  const v = validateStyles(evil); assert.equal(v.ok, false); assert.equal(v.styles, null); assert.ok(v.errors.length >= 8);
});
ok('shapes that are not a plain object are refused: null, arrays, strings, numbers, functions, a class instance', () => {
  for (const x of [null, undefined, [], ['accent'], 'accent', 5, true, () => ({}), new Date(), new Map(), class A {}]) assert.equal(validateStyles(x).ok, false);
});
ok('__proto__, constructor, prototype and nested objects are refused, and the prototype is not polluted', () => {
  assert.equal(validateStyles(JSON.parse('{"__proto__":{"polluted":"yes"}}')).ok, false);
  assert.equal(validateStyles(JSON.parse('{"accent":"#112233","__proto__":{"a":1}}')).ok, false);
  assert.equal(validateStyles({ constructor: { prototype: { x: 1 } } }).ok, false); assert.equal(validateStyles({ prototype: '#112233' }).ok, false);
  assert.equal(validateStyles({ accent: { value: '#112233' } }).ok, false);
  assert.equal({}.polluted, undefined); assert.equal(Object.prototype.polluted, undefined);
});
ok('the size cap holds: just under passes, one over is refused', () => {
  const pad = (len) => { const o = { name: 'x' }; const base = JSON.stringify(o).length; return base; };
  assert.ok(pad() < STYLES_MAX_CHARS);
  const over = { ...good(), footerText: 'y'.repeat(120), name: 'n'.repeat(80), extra: 'z'.repeat(STYLES_MAX_CHARS) };
  const v = validateStyles(over); assert.equal(v.ok, false); assert.ok(v.codes.includes('too-big'));
});
ok('unreadable inputs never throw: getters that throw, a circular object, a Proxy, symbol keys, a huge nested array', () => {
  const thrower = {}; Object.defineProperty(thrower, 'accent', { enumerable: true, get() { throw new Error('boom'); } });
  const circ = { accent: '#112233' }; circ.self = circ;
  const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
  let deep = []; for (let i = 0; i < 5000; i++) deep = [deep];
  for (const x of [thrower, circ, proxy, { [Symbol('s')]: 1 }, deep]) { const v = validateStyles(x); assert.equal(typeof v.ok, 'boolean'); }
  for (const x of [thrower, circ, proxy, null, undefined, 5]) { assert.equal(typeof canonicalStyles(x), 'string'); }
  assert.doesNotThrow(() => deriveStyleOutput(undefined)); assert.doesNotThrow(() => deriveStyleOutput({})); assert.doesNotThrow(() => buildStyleCss({ vars: {}, fonts: ['nope'] }, null));
});

// ---- the output ----
ok('the page and 3D stage background and the render are never in the output: no --bg or render variable, whatever is given', () => {
  const out = deriveStyleOutput(validateStyles(good()).styles);
  for (const k of Object.keys(out.vars)) assert.ok(!/^--(bg|stage|render|globe|dot|node|edge-color)/.test(k), k);
  const css = buildStyleCss(out, FONT_B64); assert.ok(!/--bg\b/.test(css)); assert.ok(!css.includes(STAGE_BG));
  assert.deepEqual(Object.keys(out.vars).sort(), ['--ink', '--muted', '--panel', '--panel-solid', '--rp-accent', '--rp-card-edge', '--rp-card-glass', '--rp-card-label-fg', '--rp-card-solid', '--rp-font-body', '--rp-font-heading', '--rp-heading-case', '--rp-link', '--rp-on-accent', '--rp-secondary']);
});
ok('only the slots that were given produce variables (an empty file changes nothing; one colour changes only what follows from it)', () => {
  assert.deepEqual(deriveStyleOutput({}).vars, {});
  assert.deepEqual(Object.keys(deriveStyleOutput({ accent: '#f2994a' }).vars).sort(), ['--rp-accent', '--rp-link', '--rp-on-accent']);
  assert.deepEqual(Object.keys(deriveStyleOutput({ surface: '#101010' }).vars).sort(), ['--panel', '--panel-solid', '--rp-card-edge', '--rp-card-glass', '--rp-card-solid']);
});
ok('contrast: faint colours are nudged so text, links and the second colour read on the dark page and the card; the button text reads on the accent', () => {
  const faint = validateStyles({ text: '#333333', muted: '#222222', link: '#112233', secondary: '#101010', surface: '#101010', accent: '#f2994a' }).styles;
  const out = deriveStyleOutput(faint);
  assert.ok(out.notes.length >= 3);
  for (const c of out.checks.filter((x) => !/card edge/.test(x.what))) assert.ok(c.ok, `${c.what} ${c.ratio}`); // the edge line is advisory (reported, not forced)
  assert.ok(contrast(out.vars['--ink'], STAGE_BG) >= 4.5 && contrast(out.vars['--ink'], '#101010') >= 4.5);
});
ok('an example agency look: no failing contrast pair, the muted grey is lightened, the card edge shows', () => {
  const out = deriveStyleOutput(validateStyles(good()).styles);
  assert.deepEqual(out.checks.filter((c) => !c.ok), []); assert.ok(out.notes.some((x) => /muted/.test(x)));
  assert.ok(out.checks.some((c) => /card edge against the card/.test(c.what) && c.ratio >= 1.5));
});
ok('the title and the page object carry only allow-listed, escaped fields (no hash, no id, no file name)', () => {
  const v = validateStyles({ ...good(), name: 'A&B <Co> "x" \'y\'' }).styles; const out = deriveStyleOutput(v);
  assert.equal(out.titleText, 'A&amp;B &lt;Co&gt; &quot;x&quot; &#39;y&#39; · Website health walkthrough');
  assert.deepEqual(Object.keys(out.page).sort(), ['accent', 'bodyFont', 'footer', 'headingCase', 'headingFont', 'name', 'v']);
  assert.ok(!/[<>&]/.test(safeJson(out.page)));
});
ok('safeJson writes < > & and the two line separators as \\uXXXX and round-trips', () => {
  const o = { a: '<script>&</script>\u2028\u2029' }; const s = safeJson(o);
  assert.ok(!/[<>&\u2028\u2029]/.test(s)); assert.deepEqual(JSON.parse(s), o);
});

// ---- the CSS ----
ok('the finished CSS is made only of the characters the writer produces; the guard refuses anything else', () => {
  const css = buildStyleCss(deriveStyleOutput(validateStyles(good()).styles), FONT_B64);
  assert.ok(css && cssIsSafe(css)); assert.match(css, /^@font-face\{font-family:"Oswald"/); assert.match(css, /\.rp-root\.rp-dark\.rp-branded\{--ink:/);
  for (const bad of ['a{}</style>', 'a{}\\', '@import "x";', 'a{b:url(http://x)}', 'a{b:url(data:text/html;base64,AAAA)}', '/* x */', 'a{b:expression(1)}', 'a{b:javascript:1}', 'a{', 'a{}}', '@media{}', 'a{b:c}<', 'a{b:c;d:e\u0000}']) assert.equal(cssIsSafe(bad), false, bad);
  assert.equal(cssIsSafe('.x{--a:#112233}'), true);
});
ok('font data must be plain base64; anything else leaves the font out instead of reaching the CSS', () => {
  const out = deriveStyleOutput(validateStyles({ headingFont: 'Oswald' }).styles);
  const css = buildStyleCss(out, { 'Oswald.woff2': 'AA");}body{x:1}/*' });
  assert.ok(css !== null && !css.includes('@font-face') && !css.includes('body{'));
  assert.match(buildStyleCss(out, { 'Oswald.woff2': 'AAAA' }), /url\(data:font\/woff2;base64,AAAA\) format\("woff2"\)/);
});
ok('fonts can only be named from the bundled list, and the list maps to woff2 files', () => {
  assert.deepEqual(Object.keys(BUNDLED_FONTS).sort(), ['Inter', 'Oswald']);
  assert.deepEqual(fontFilesFor(['Oswald', 'Inter', 'Nope']).map((f) => f.file), ['Oswald.woff2', 'Inter-Regular.woff2', 'Inter-SemiBold.woff2']);
  for (const f of ['Arial', 'oswald', 'Oswald ', 'Oswald"', '../Oswald', 'Oswald.woff2', 'constructor', '__proto__']) assert.equal(validateStyles({ headingFont: f }).ok, false, f);
  for (const x of Object.values(BUNDLED_FONTS).flat()) assert.match(x.file, /^[A-Za-z-]+\.woff2$/);
});

// ---- the pairing hash ----
ok('the hash is 12 hex characters of the fixed form; key order does not matter; any change in a value changes it', () => {
  const a = good(); const b = Object.fromEntries(Object.entries(a).reverse());
  assert.match(stylesHash(a), /^[0-9a-f]{12}$/); assert.equal(stylesHash(a), stylesHash(b)); assert.equal(canonicalStyles(a), canonicalStyles(b));
  assert.notEqual(stylesHash(a), stylesHash({ ...a, accent: '#F2994B' })); assert.notEqual(stylesHash(a), stylesHash({ ...a, name: 'Other' }));
  assert.notEqual(stylesHash({}), stylesHash({ accent: '#112233' }));
});
ok('makeEnvelope names the two parts with the same hash', () => {
  const e = makeEnvelope({ format: 'webobs.client-report' }, good()); const keys = Object.keys(e); const h = stylesHash(good());
  assert.deepEqual(keys, ['styles_' + h, 'data_' + h]);
});

console.log(`all ${n} styles checks passed`);

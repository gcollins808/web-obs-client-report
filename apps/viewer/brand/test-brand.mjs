// Tests for the optional agency brand: schema checks, the fallback, contrast, safe output, and the built pages (default and branded).
// Synthetic data only. Foreground and self-terminating.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBrand, loadBrand, deriveTokens, contrast, describe, COLOR_KEYS, RESERVED_COLOR_KEYS, STAGE_BG } from './load-brand.mjs';
import { visibleStrings, scan } from './scan-wording.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };

const colors = { primary: '#4aa3df', blue_dark: '#1f6f9f', blue_light: '#7fd0f2', tint: '#eef6fb', accent_orange: '#f0a050', text: '#2b2b2b', text_on_dark: '#c8c8c8', grey_0: '#111111', grey_1: '#1d2027', grey_2: '#262930', muted: '#6d6d6d', grid: '#d6dade' };
const good = () => ({ schema_version: 1, name: 'Sample Agency', colors: { ...colors }, fonts: { heading: { name: 'Oswald', file: 'Oswald.ttf', case: 'uppercase' }, body: { name: 'Inter', regular: 'Inter-Regular.ttf', bold: 'Inter-SemiBold.ttf' } }, attribution: { header_text: 'Sample Agency', footer_text: 'Prepared by Sample Agency' }, voice: ['Positive.'], avoid_words: ['problem'], negation_max_per_100_words: 1.6, preferences: { a: 1 } });

// ---- schema ----
ok('a complete brand is accepted', () => { const v = validateBrand(good()); assert.deepEqual(v.errors, []); assert.equal(v.brand.name, 'Sample Agency'); assert.equal(v.brand.attribution.footer_text, 'Prepared by Sample Agency'); });
ok('the attribution defaults from the name', () => { const b = good(); delete b.attribution; const v = validateBrand(b); assert.equal(v.brand.attribution.header_text, 'Sample Agency'); assert.equal(v.brand.attribution.footer_text, 'Prepared by Sample Agency'); });
ok('schema_version is optional (defaults to 1), newer is accepted with a warning, nonsense is refused', () => {
  const b = good(); delete b.schema_version; assert.equal(validateBrand(b).brand.schema_version, 1);
  const w = validateBrand({ ...good(), schema_version: 2 }); assert.equal(w.errors.length, 0); assert.ok(w.warnings.some((x) => /newer/.test(x)));
  assert.ok(validateBrand({ ...good(), schema_version: 'one' }).errors.length); assert.ok(validateBrand({ ...good(), schema_version: 0 }).errors.length);
});
ok('missing name, missing required colours and bad hex values are refused', () => {
  const noName = good(); delete noName.name; assert.ok(validateBrand(noName).errors.some((e) => /name/.test(e)));
  for (const k of ['primary', 'text_on_dark']) { const b = good(); delete b.colors[k]; assert.ok(validateBrand(b).errors.some((e) => e.includes('colors.' + k)), k); }
  const bad = good(); bad.colors.primary = 'blue'; assert.ok(validateBrand(bad).errors.some((e) => /colors\.primary/.test(e)));
  const bad2 = good(); bad2.colors.accent_orange = '#12'; assert.ok(validateBrand(bad2).errors.length);
  assert.ok(validateBrand(null).errors.length && validateBrand([]).errors.length && validateBrand('x').errors.length);
});
ok('optional colours may be absent', () => { const b = good(); for (const k of COLOR_KEYS) if (!['primary', 'text_on_dark'].includes(k)) delete b.colors[k]; const v = validateBrand(b); assert.deepEqual(v.errors, []); assert.ok(deriveTokens(v.brand).checks.every((c) => c.ok), 'derived values read well'); });
ok('unknown keys are kept and ignored, at the top level and inside colors', () => {
  const b = { ...good(), future_thing: { x: 1 } }; b.colors.future_shade = '#123456'; const v = validateBrand(b);
  assert.deepEqual(v.errors, []); assert.deepEqual(v.brand.extra.future_thing, { x: 1 }); assert.equal(v.brand.extra['colors.future_shade'], '#123456');
});
ok('the supplemental keys are carried when well-formed and ignored with a warning when not', () => {
  const v = validateBrand(good()); for (const k of ['voice', 'avoid_words', 'negation_max_per_100_words', 'preferences']) assert.ok(k in v.brand.supplemental, k);
  const w = validateBrand({ ...good(), avoid_words: 'problem', negation_max_per_100_words: 'x', voice: [1] }); assert.deepEqual(w.errors, []); assert.ok(w.warnings.length >= 3); assert.ok(!('avoid_words' in w.brand.supplemental));
});
ok('font names, file names and case are checked (no folders, no markup, no CSS injection)', () => {
  for (const bad of [{ name: "x'; } body{display:none} .a{", file: 'a.ttf' }, { name: 'Oswald', file: '../../etc/passwd' }, { name: 'Oswald', file: 'a/b.ttf' }, { name: 'Oswald', case: 'shout' }, { name: '<b>' }]) {
    const b = good(); b.fonts.heading = bad; assert.ok(validateBrand(b).errors.length, JSON.stringify(bad));
  }
  const c = good(); c.fonts.body.regular = '..\\x.ttf'; assert.ok(validateBrand(c).errors.length);
});
ok('the logo key is optional and ignored; a wrong type only warns', () => { const b = good(); b.logo = '(path on another machine)'; assert.deepEqual(validateBrand(b).errors, []); b.logo = 5; const w = validateBrand(b); assert.deepEqual(w.errors, []); assert.ok(w.warnings.length); });

// ---- loading and the fallback ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-brand-'));
const dirWith = (name, brand, fonts = {}) => { const d = path.join(tmp, name); fs.mkdirSync(path.join(d, 'fonts'), { recursive: true }); if (brand !== undefined) fs.writeFileSync(path.join(d, 'brand.json'), typeof brand === 'string' ? brand : JSON.stringify(brand)); for (const [f, bytes] of Object.entries(fonts)) fs.writeFileSync(path.join(d, 'fonts', f), bytes); return d; };
const FAKE = Buffer.from('wOF2fake-font-bytes-for-tests');
ok('no brand.json: the built-in look is used and the reason is reported', () => { const r = loadBrand(dirWith('none', undefined), {}); assert.equal(r.used, 'fallback'); assert.match(r.reason, /no brand\.json/); assert.ok(describe(r)[0].includes('built-in look')); });
ok('invalid JSON or an invalid brand falls back and names the problem', () => {
  const a = loadBrand(dirWith('badjson', '{ nope'), {}); assert.equal(a.used, 'fallback'); assert.match(a.reason, /not valid JSON/);
  const b = good(); b.colors.primary = 'red'; const r = loadBrand(dirWith('badcol', b), {}); assert.equal(r.used, 'fallback'); assert.match(r.reason, /colors\.primary/);
});
ok('WEBOBS_BRAND_STRICT=1 turns a refused brand into a build failure; WEBOBS_BRAND=off forces the fallback', () => {
  const b = good(); b.colors.primary = 'red'; assert.throws(() => loadBrand(dirWith('strict', b), { WEBOBS_BRAND_STRICT: '1' }), /colors\.primary/);
  assert.throws(() => loadBrand(dirWith('strict2', undefined), { WEBOBS_BRAND_STRICT: '1' }), /no brand\.json/);
  assert.equal(loadBrand(dirWith('off', good()), { WEBOBS_BRAND: 'off' }).used, 'fallback');
});
ok('a good brand is used: fonts embedded as data, nothing external, tokens set', () => {
  const r = loadBrand(dirWith('good', good(), { 'Oswald.woff2': FAKE, 'Inter-Regular.woff2': FAKE, 'Inter-SemiBold.woff2': FAKE }), {});
  assert.equal(r.used, 'brand'); assert.equal(r.fonts.length, 3); assert.deepEqual(r.warnings.filter((w) => /not found|not a web font/.test(w)), []);
  assert.match(r.css, /@font-face\{font-family:'Oswald'/); assert.match(r.css, /\.rp-root\.rp-dark\.rp-branded\{/); assert.match(r.css, /--rp-accent:#f0a050/); assert.match(r.css, /--rp-heading-case:uppercase/);
  assert.ok(!/https?:|@import|<|\bfile:/i.test(r.css.replace(/base64,[A-Za-z0-9+/=]+/g, '')), 'the css reaches nothing outside the page');
  for (const u of r.css.match(/url\([^)]*\)/g)) assert.ok(u.startsWith('url(data:font/'), u);
  assert.deepEqual(Object.keys(r.page).sort(), ['accent', 'footer', 'header', 'headingCase', 'name', 'titleText']);
  const shipped = JSON.stringify(r.page) + r.css; assert.ok(!/voice|avoid_words|preferences|negation/.test(shipped), 'supplemental keys are not shipped');
});
ok('a missing font file warns and uses the system font; a .ttf works but warns about size', () => {
  const r = loadBrand(dirWith('nofont', good()), {}); assert.equal(r.used, 'brand'); assert.equal(r.fonts.length, 0); assert.ok(r.warnings.some((w) => /not found/.test(w))); assert.match(r.css, /--rp-font-heading:'Oswald', ui-sans-serif/);
  const t = loadBrand(dirWith('ttf', good(), { 'Oswald.ttf': FAKE }), {}); assert.equal(t.fonts[0].file, 'Oswald.ttf'); assert.ok(t.warnings.some((w) => /not a web font/.test(w)));
});
ok('a font name cannot reach the stylesheet unescaped; the title text is escaped', () => {
  const b = good(); b.name = 'A <b>&"Agency'; b.attribution = undefined; delete b.attribution; const r = loadBrand(dirWith('esc', b), {});
  assert.equal(r.used, 'brand'); assert.ok(!/<b>/.test(r.page.titleText)); assert.match(r.page.titleText, /&lt;b&gt;&amp;&quot;Agency/); assert.ok(!/<b>/.test(r.css));
});
ok('the repository example brand is valid', () => { const raw = JSON.parse(fs.readFileSync(path.join(here, 'brand.example.json'), 'utf8')); const v = validateBrand(raw); assert.deepEqual(v.errors, []); assert.equal(raw.name, "Example Agency"); });

// ---- contrast ----
ok('every colour pair the viewer uses reads well (text 4.5:1, accent 3:1) for the sample and the example', () => {
  for (const c of [colors, JSON.parse(fs.readFileSync(path.join(here, 'brand.example.json'), 'utf8')).colors]) {
    const t = deriveTokens(validateBrand({ ...good(), colors: c }).brand); for (const ch of t.checks) assert.ok(ch.ok, `${ch.what}: ${ch.ratio} < ${ch.min}`);
  }
});
ok('faint muted text is lightened; a too-dark primary is lightened for links; the button text is the better of dark and white', () => {
  const t = deriveTokens(validateBrand(good()).brand);
  assert.ok(contrast(t.vars['--muted'], STAGE_BG) >= 4.5 && contrast(t.vars['--muted'], colors.grey_2) >= 4.5); assert.ok(t.notes.some((x) => /muted/.test(x)));
  const dark = good(); dark.colors.primary = '#1a3a5a'; const d = deriveTokens(validateBrand(dark).brand); assert.ok(contrast(d.vars['--rp-link'], STAGE_BG) >= 4.5);
  assert.ok(contrast(t.vars['--rp-on-accent'], t.vars['--rp-accent']) >= 4.5);
});

// ---- reserved for visibility: the stage background and the render palette never change with a brand ----
ok('the page and stage background is fixed: no brand sets --bg or any background on the page', () => {
  assert.equal(STAGE_BG, '#07090f'); assert.deepEqual(RESERVED_COLOR_KEYS, ['grey_0', 'grey_1']);
  const t = deriveTokens(validateBrand(good()).brand); assert.ok(!('--bg' in t.vars), 'no --bg in the brand tokens');
  const r = loadBrand(dirWith('res1', good()), {}); assert.ok(!/--bg\b/.test(r.css) && !/background\s*:/.test(r.css.replace(/@font-face\{[^}]*\}/g, '')), 'the brand css sets no page background');
  assert.ok(!/data-start|html\s*\{|:root\[/.test(r.css.replace(/:root\{[^}]*\}/g, '')), 'no rule on the page element');
});
ok('grey_0 and grey_1 are reserved: valid keys, ignored with a plain message naming them, and changing them changes nothing', () => {
  const a = good(), b = good(); b.colors.grey_0 = '#ff0000'; b.colors.grey_1 = '#00ff00';
  const ra = loadBrand(dirWith('resA', a), {}), rb = loadBrand(dirWith('resB', b), {});
  assert.equal(ra.css, rb.css, 'the generated css is identical whatever grey_0 and grey_1 hold'); assert.deepEqual(ra.page, rb.page);
  assert.ok(ra.notes.some((n) => /colors\.grey_0 and colors\.grey_1 are reserved for visibility/.test(n)), ra.notes.join(' | '));
  assert.ok(describe(rb).some((l) => /reserved for visibility/.test(l)));
  assert.deepEqual(validateBrand(b).errors, [], 'still valid contract keys');
  const noGrey = good(); delete noGrey.colors.grey_0; delete noGrey.colors.grey_1; assert.deepEqual(validateBrand(noGrey).errors, []); assert.equal(loadBrand(dirWith('resC', noGrey), {}).css, ra.css);
  assert.ok(!/--brand-grey-[01]\b/.test(ra.css), 'the reserved greys are not even exposed as brand variables');
});
ok('the render palette is out of reach: the brand css never touches the globe, and a report theme cannot set the stage background', () => {
  const r = loadBrand(dirWith('res2', good(), { 'Oswald.woff2': FAKE }), {}); assert.ok(!/wo-|--wo|canvas|three|globe/i.test(r.css.replace(/base64,[A-Za-z0-9+/=]+/g, '')));
  const pv = fs.readFileSync(path.join(here, '..', 'src', 'components', 'PackageViewer.tsx'), 'utf8'); assert.ok(!/'--bg'/.test(pv), "PackageViewer never sets --bg from a report's theme");
  const srv = fs.readFileSync(path.join(root, 'apps', 'server', 'server.mjs'), 'utf8'); assert.match(srv, /background:#07090f/); assert.ok(!/#10131a/.test(srv), 'the refusal page uses the same page colour');
});
ok('every pair that matters reads well against the ORIGINAL background and the card colour', () => {
  for (const c of [colors, JSON.parse(fs.readFileSync(path.join(here, 'brand.example.json'), 'utf8')).colors]) {
    const t = deriveTokens(validateBrand({ ...good(), colors: c }).brand);
    for (const [what, fg, bg] of [['text on stage', t.vars['--ink'], STAGE_BG], ['muted on stage', t.vars['--muted'], STAGE_BG], ['link on stage', t.vars['--rp-link'], STAGE_BG], ['text on card', t.vars['--ink'], t.vars['--panel-solid']], ['muted on card', t.vars['--muted'], t.vars['--panel-solid']], ['link on card', t.vars['--rp-link'], t.vars['--panel-solid']]]) assert.ok(contrast(fg, bg) >= 4.5, what + ' ' + contrast(fg, bg).toFixed(2));
    assert.ok(contrast(t.vars['--rp-accent'], STAGE_BG) >= 3 && contrast(t.vars['--rp-on-accent'], t.vars['--rp-accent']) >= 4.5);
  }
  const lowGrey = good(); lowGrey.colors.grey_2 = '#303030'; lowGrey.colors.muted = '#555555'; const d = deriveTokens(validateBrand(lowGrey).brand); assert.ok(d.checks.every((x) => x.ok), 'faint colours are nudged until they pass: ' + JSON.stringify(d.checks.filter((x) => !x.ok)));
});

// ---- the optional "surface" colour for cards and panels ----
ok('surface colours cards and panels; without it grey_2 is used; it never touches the stage', () => {
  const a = good(); a.colors.surface = '#101010'; const b = good(); delete b.colors.surface;
  const ta = deriveTokens(validateBrand(a).brand), tb = deriveTokens(validateBrand(b).brand);
  assert.equal(ta.vars['--rp-card-solid'], '#101010'); assert.equal(tb.vars['--rp-card-solid'], colors.grey_2);
  assert.ok(!('--bg' in ta.vars), 'the stage background is still not a brand value');
  const ra = loadBrand(dirWith('sfA', a), {}); assert.match(ra.css, /--rp-card-solid:#101010/); assert.ok(!/--bg\b/.test(ra.css));
  assert.deepEqual(validateBrand({ ...good(), colors: { ...colors, surface: 'dark' } }).errors.some((e) => /colors\.surface/.test(e)), true, 'a bad surface value is refused');
});
ok('a dark card still reads: text, muted text, links and the accent pass on #101010, and the card edge shows against the card and the page', () => {
  const dark = good(); dark.colors.surface = '#101010'; const t2 = deriveTokens(validateBrand(dark).brand);
  for (const c of t2.checks) assert.ok(c.ok, c.what + ' ' + c.ratio);
  assert.ok(contrast(t2.vars['--ink'], '#101010') >= 4.5 && contrast(t2.vars['--muted'], '#101010') >= 4.5 && contrast(t2.vars['--rp-link'], '#101010') >= 4.5);
  assert.ok(t2.checks.some((c) => /card edge against the stage/.test(c.what) && c.ratio >= 1.5) && t2.checks.some((c) => /card edge against the card/.test(c.what) && c.ratio >= 1.5));
  assert.match(loadBrand(dirWith('sfB', dark), {}).css, /--rp-card-edge:rgba\(/);
});

// ---- the wording scan ----
ok('the wording scan finds avoided words and counts negations', () => {
  const src = 'export const A = () => <p title="No luck here">We found a problem on the page.</p>;\nconst x = "Your report is ready to open";';
  const strings = visibleStrings(src); assert.ok(strings.some((s) => /problem/.test(s.text)));
  const tmpf = path.join(tmp, 'x.tsx'); fs.writeFileSync(tmpf, src);
  const r = scan({ dir: tmp, files: [tmpf], avoid: ['problem', 'falls short'], maxNeg: 1.6 });
  assert.equal(r.findings.length, 1); assert.deepEqual(r.findings[0].words, ['problem']); assert.ok(r.negations >= 1); assert.ok(r.overNegation);
});

ok('the client-facing viewer text stays positive: no avoided words and negations under the limit', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(here, 'brand.example.json'), 'utf8')); const src = path.join(here, '..', 'src');
  const files = ['components/PackageViewer.tsx', 'components/Scenes.tsx', 'components/Viewer.tsx', 'components/GlobeStage.tsx', 'components/ToolIcons.tsx', 'main.tsx'].map((f) => path.join(src, f));
  const r = scan({ dir: src, files, avoid: [...ex.avoid_words, 'fail', 'gap', 'cannot', 'unable', 'wrong', 'mistake', 'not enough'], maxNeg: ex.negation_max_per_100_words });
  assert.ok(r.strings > 50, 'the scan reads the client-facing strings'); assert.deepEqual(r.findings.map((f) => f.file + ':' + f.text), []); assert.ok(r.per100 <= 1.6, 'negations per 100 words: ' + r.per100);
});

// ---- the built pages ----
function build(name, env) {
  const out = path.join(tmp, 'dist-' + name);
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--config', path.join(root, 'apps', 'viewer', 'vite.report.config.ts'), '--outDir', out, '--emptyOutDir'], { cwd: root, encoding: 'utf8', env: { ...process.env, WEBOBS_BRAND_DIR: '', WEBOBS_BRAND: '', WEBOBS_BRAND_STRICT: '', ...env }, timeout: 300000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const assets = path.join(out, 'assets');
  const files = [path.join(out, 'index.html'), ...fs.readdirSync(assets).map((f) => path.join(assets, f))];
  return { out, log: r.stdout, text: Object.fromEntries(files.map((f) => [path.basename(f), fs.readFileSync(f, 'utf8')])) };
}
const EXTERNAL = /fonts\.googleapis|fonts\.gstatic|use\.typekit|cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare|@import\s|<link[^>]+href=["']https?:|<script[^>]+src=["']https?:|url\(\s*["']?https?:/i;
const brandDir = dirWith('built', good(), { 'Oswald.woff2': FAKE, 'Inter-Regular.woff2': FAKE, 'Inter-SemiBold.woff2': FAKE });
const def = build('default', { WEBOBS_BRAND_DIR: path.join(tmp, 'nothing-here') });
ok('default build: the built-in look, said so, and no brand in the page', () => {
  assert.match(def.log, /using the built-in look \(fallback\)/);
  const all = Object.values(def.text).join('\n'); assert.ok(!all.includes('brand-tokens')); assert.match(def.text['index.html'], /<title>Website health walkthrough<\/title>/); assert.ok(!/Sample Agency/.test(all));
  assert.ok(!EXTERNAL.test(all), 'no external font, style or script address');
});
const br = build('branded', { WEBOBS_BRAND_DIR: brandDir, WEBOBS_BRAND_STRICT: '1' });
ok('branded build: brand named in the log, tokens and fonts embedded, title built from the brand, nothing external', () => {
  assert.match(br.log, /\[brand\] using: brand "Sample Agency"/); assert.match(br.log, /fonts embedded: Oswald/);
  assert.match(br.text['index.html'], /<style id="brand-tokens">/); assert.match(br.text['index.html'], /<title>Sample Agency · Website health walkthrough<\/title>/);
  assert.match(br.text['index.html'], /font\/woff2;base64,/); assert.match(br.text['index.html'], /rp-branded/);
  const all = Object.values(br.text).join('\n'); assert.ok(!EXTERNAL.test(all), 'no external font, style or script address');
  assert.ok(all.includes('Prepared by Sample Agency') && all.includes('"Sample Agency"') || all.includes('Sample Agency'), 'attribution text is in the page');
  assert.ok(!/avoid_words|negation_max_per_100_words|"voice"/.test(all), 'supplemental keys are not in the page');
});
ok('built pages: the stage background rule is identical with and without a brand, and the brand style never sets it', () => {
  const cssOf = (b) => Object.entries(b.text).filter(([name]) => name.endsWith('.css')).map(([, v]) => v).join(String.fromCharCode(10));
  const bgOf = (b) => { const m = /\.rp-dark\s*\{[^}]*--bg:\s*(#[0-9a-fA-F]{6})/.exec(cssOf(b)); assert.ok(m, 'the .rp-dark rule defines --bg'); return m[1].toLowerCase(); };
  assert.equal(bgOf(def), '#07090f'); assert.equal(bgOf(br), '#07090f');
  const style = /<style id="brand-tokens">([\s\S]*?)<\/style>/.exec(br.text['index.html'])[1].replace(/base64,[A-Za-z0-9+/=]+/g, '');
  assert.ok(!/--bg\b/.test(style) && !/background\s*:/.test(style.replace(/@font-face\{[^}]*\}/g, '')));
  assert.match(cssOf(def), /html\[data-start=.?viewer.?\]\s*\{\s*background:\s*#07090f/); assert.ok(!/#1c1f26|#101010/i.test(style), 'no brand grey in the brand style');
});
ok('the brand folder in the repository ships no agency files (only the example)', () => { assert.ok(!fs.existsSync(path.join(here, 'fonts')) || process.env.WEBOBS_BRAND_DIR); });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`all ${n} brand checks passed`);

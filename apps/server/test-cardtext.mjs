// v0.1.6: text on cards. A look may carry cardText (and cardMuted): the text on cards and panels, checked against the card color only, while text and muted stay
// for the dark page. Without them a look behaves EXACTLY as in 0.1.5. Every readability and nudge message names the colors and the numbers.
// Synthetic data only. Foreground; nothing is left running.   node apps/server/test-cardtext.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateStyles, deriveStyleOutput, readabilityProblems, suggestCardText, buildStyleCss, cssIsSafe, STYLE_SLOTS, canonicalStyles } from '../viewer/brand/styles.mjs';
import { contrast, mix, luminance, STAGE_BG } from '../viewer/brand/color.mjs';
import { stylesHash, makeEnvelope } from '../viewer/brand/styles-hash.mjs';
import { createIngestServer } from './ingest/ingest.mjs';
import { checkIncomingReport } from './ingest/contract-check.mjs';
import { createServer } from './server.mjs';
import { hashToken, newToken } from './tokens.mjs';
import { MARKER } from './styles-inject.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); n++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); } };
const base = JSON.parse(fs.readFileSync(path.join(here, '../../fixtures/client-report.sample.json'), 'utf8'));
// A sample look (light card, dark text, bright accent): light card, dark text, a bright accent and secondary.
const SAMPLE_LOOK = { accent: '#5cff8d', secondary: '#d4f52e', surface: '#f7f7f7', text: '#323334', muted: '#707070' };
const RED = { ...SAMPLE_LOOK, surface: '#d52924' };
const msgs = (st) => validateStyles(st).errors.join(' | ');

// GOLDEN: the derived page variables of looks WITHOUT cardText, computed by the 0.1.5 module. They must not change.
const GOLDEN = {"full":{"look":{"accent":"#F2994A","secondary":"#2ECDF5","link":"#23AEEB","text":"#C4C4C4","muted":"#6B6B6B","surface":"#101010","headingFont":"Oswald","bodyFont":"Inter","headingCase":"uppercase","name":"Example Agency","footerText":"Prepared by Example Agency"},"ok":true,"vars":{"--ink":"#c4c4c4","--muted":"#7c7c7c","--panel-solid":"#101010","--panel":"rgba(16, 16, 16, 0.82)","--rp-card-solid":"#101010","--rp-card-glass":"rgba(16, 16, 16, 0.9)","--rp-card-edge":"rgba(196, 196, 196, 0.28)","--rp-accent":"#f2994a","--rp-on-accent":"#10131a","--rp-link":"#23aeeb","--rp-secondary":"#2ecdf5","--rp-font-heading":"\"Oswald\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif","--rp-font-body":"\"Inter\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif","--rp-heading-case":"uppercase"}},"dimText":{"look":{"text":"#303030"},"ok":true,"vars":{"--ink":"#7f7f7f","--rp-card-edge":"rgba(127, 127, 127, 0.28)"}},"dimMuted":{"look":{"muted":"#202020"},"ok":true,"vars":{"--muted":"#7f8083"}},"darkLink":{"look":{"link":"#003366"},"ok":true,"vars":{"--rp-link":"#6685a3"}},"accentOnly":{"look":{"accent":"#112233"},"ok":true,"vars":{"--rp-accent":"#112233","--rp-on-accent":"#ffffff","--rp-link":"#77818b"}},"red":{"look":{"accent":"#5cff8d","secondary":"#d4f52e","surface":"#d52924","text":"#323334","muted":"#707070"},"ok":true,"vars":{"--ink":"#f8f8f8","--muted":"#f8f8f8","--panel-solid":"#d52924","--panel":"rgba(213, 41, 36, 0.82)","--rp-card-solid":"#d52924","--rp-card-glass":"rgba(213, 41, 36, 0.9)","--rp-card-edge":"rgba(248, 248, 248, 0.28)","--rp-accent":"#5cff8d","--rp-on-accent":"#10131a","--rp-link":"#ceffdd","--rp-secondary":"#ecfba1"}},"teal":{"look":{"accent":"#E8743B","secondary":"#4FB0C6","surface":"#1B1D22","text":"#E6E6E6","muted":"#9A9A9A"},"ok":true,"vars":{"--ink":"#e6e6e6","--muted":"#9a9a9a","--panel-solid":"#1b1d22","--panel":"rgba(27, 29, 34, 0.82)","--rp-card-solid":"#1b1d22","--rp-card-glass":"rgba(27, 29, 34, 0.9)","--rp-card-edge":"rgba(230, 230, 230, 0.28)","--rp-accent":"#e8743b","--rp-on-accent":"#10131a","--rp-link":"#e8743b","--rp-secondary":"#4fb0c6"}},"empty":{"look":{},"ok":true,"vars":{}}};

console.log('a look without cardText behaves exactly as before');
for (const [name, g] of Object.entries(GOLDEN)) {
  await ok(`${name}: same decision and same page variables as 0.1.5${name === 'red' ? ' (plus the new card pairs for the chips and warning boxes)' : ''}`, () => {
    const v = validateStyles(g.look); assert.equal(v.ok, g.ok, v.errors.join(' '));
    if (g.ok) {
      const vars = deriveStyleOutput(v.styles).vars, NEW = /^--rp-card-(sev-|warn-|line|chip|label-fg)/, NEWCARD = /^--rp-card-(sev-|warn-|line|chip)/;
      assert.deepEqual(Object.fromEntries(Object.entries(vars).filter(([k]) => !NEW.test(k))), g.vars, 'every variable of 0.1.5 is unchanged');
      const extra = Object.keys(vars).filter((k) => NEWCARD.test(k)); // the muted label chip text (--rp-card-label-fg) is new in 0.1.7 and may be added to any look
      if (name === 'red') assert.equal(extra.length, 9, 'a red card gets its own chip and warning pairs and a shaded plain chip: ' + extra.join(',')); else assert.equal(extra.length, 0, 'a dark card keeps the stylesheet pairs: ' + extra.join(','));
    }
  });
}
await ok('no card text variables are written for such a look', () => { for (const g of Object.values(GOLDEN)) if (g.ok) { const v = deriveStyleOutput(g.look).vars; assert.equal(v['--rp-card-ink'], undefined); assert.equal(v['--rp-card-muted'], undefined); } });

console.log('cardText on a light card');
await ok('a sample look with cardText #323334 on the light card #f7f7f7 passes (it was refused as 1.07:1 before)', () => {
  const v = validateStyles({ ...SAMPLE_LOOK, cardText: '#323334' }); assert.equal(v.ok, true, msgs({ ...SAMPLE_LOOK, cardText: '#323334' }));
  const o = deriveStyleOutput(v.styles);
  assert.equal(o.vars['--rp-card-ink'], '#323334'); assert.ok(contrast(o.vars['--rp-card-ink'], '#f7f7f7') > 11);
  assert.ok(contrast(o.vars['--rp-card-muted'], '#f7f7f7') >= 4.5, 'the derived card muted reads on the card');
  assert.ok(contrast(o.vars['--ink'], '#07090f') >= 4.5, 'the page text still reads on the dark stage');
  assert.ok(contrast(o.vars['--muted'], '#07090f') >= 4.5);
  assert.ok(contrast(o.vars['--rp-link'], '#f7f7f7') >= 4.5, 'links on the card read on the card');
  assert.ok(contrast(o.vars['--rp-secondary'], '#f7f7f7') >= 4.5);
});
await ok('the same look WITHOUT cardText is still refused, and the message says what to do, with the colors and numbers', () => {
  const m = msgs(SAMPLE_LOOK);
  assert.match(m, /^surface: /); assert.ok(m.includes('#ffffff') && m.includes('#f7f7f7') && m.includes('1.07:1') && m.includes('4.5:1'), m);
  assert.ok(/cardText/.test(m) && /dark text on this card, for example #10131a \(17\.3:1\)/.test(m), m);
});
await ok('cardMuted is its own color when given, and refused (naming cardMuted) when it does not read', () => {
  assert.equal(validateStyles({ ...SAMPLE_LOOK, cardText: '#323334', cardMuted: '#555555' }).ok, true);
  const bad = msgs({ ...SAMPLE_LOOK, cardText: '#323334', cardMuted: '#e0e0e0' }); assert.match(bad, /^cardMuted: #e0e0e0 on the card #f7f7f7 reaches only /); assert.ok(/needs 4\.5:1/.test(bad));
  assert.equal(deriveStyleOutput({ ...SAMPLE_LOOK, cardText: '#323334', cardMuted: '#555555' }).vars['--rp-card-muted'], '#555555');
});

console.log('the red card (about #d52924)');
await ok('without cardText the white page text on the red card passes as before (about 5.0:1)', () => { const v = validateStyles(RED); assert.equal(v.ok, true); assert.ok(contrast(deriveStyleOutput(v.styles).vars['--ink'], '#d52924') >= 4.5); });
await ok('cardText #323334 on the red card reaches only about 2.5:1 and is refused with both colors, the numbers and a light-text suggestion', () => {
  const m = msgs({ ...RED, cardText: '#323334' });
  assert.match(m, /^cardText: #323334 on the card #d52924 reaches only 2\.52:1 and needs 4\.5:1\. Use light text on this card, for example #ffffff \(5\.0:1\)\./, m);
  assert.equal(m.split(' | ').length, 1, 'one message: the derived card muted is not blamed on top');
});
await ok('cardText #ffffff on the red card passes', () => assert.equal(validateStyles({ ...RED, cardText: '#ffffff' }).ok, true));
await ok('a mid-tone card where neither light nor dark text reaches 4.5:1 says so', () => { const m = msgs({ surface: '#777777', cardText: '#ffffff' }); assert.ok(/Neither light nor dark text reaches 4\.5:1/.test(m), m); });
await ok('equal colors (cardText the same as the card) are refused with the numbers', () => { const m = msgs({ surface: '#336699', cardText: '#336699' }); assert.ok(m.includes('1:1') && m.includes('#336699'), m); });
await ok('near the threshold: the darkest cardText that reads on a light card is accepted and the next step is refused', () => {
  let lastOk = -1; for (let g = 0; g < 256; g++) { const h = '#' + g.toString(16).padStart(2, '0').repeat(3); if (validateStyles({ surface: '#f7f7f7', cardText: h }).ok) lastOk = g; else if (lastOk >= 0) break; }
  assert.ok(lastOk > 80 && lastOk < 140, 'threshold ' + lastOk);
  const hx = (g) => '#' + g.toString(16).padStart(2, '0').repeat(3);
  assert.ok(contrast(hx(lastOk), '#f7f7f7') >= 4.5 && contrast(hx(lastOk + 1), '#f7f7f7') < 4.5);
});

console.log('the text on the page');
await ok('a dark Text that cannot read on the dark page gets a non-blocking note with the numbers and the color the page uses instead', () => {
  const v = validateStyles({ ...SAMPLE_LOOK, cardText: '#323334' }); assert.equal(v.ok, true);
  const note = deriveStyleOutput(v.styles).notes.find((x) => /^text /.test(x)); assert.ok(note, 'there is a note');
  const used = deriveStyleOutput(v.styles).vars['--ink'];
  assert.ok(note.includes('#323334') && note.includes('1.57:1') && note.includes('4.5:1') && note.includes(used), note);
});
await ok('the nudge notes for muted, links and the secondary color name the colors and the numbers', () => {
  const notes = deriveStyleOutput(validateStyles({ ...SAMPLE_LOOK, cardText: '#323334' }).styles).notes.join(' | ');
  assert.ok(/muted #707070 is adjusted to #[0-9a-f]{6} \(4\.02:1/.test(notes), notes); assert.ok(/accent #5cff8d is adjusted to #[0-9a-f]{6} for links and the name \(/.test(notes), notes); assert.ok(/secondary #d4f52e is adjusted to /.test(notes), notes);
});
await ok('a dark card with light cardText works as well (the usual case)', () => { const v = validateStyles({ surface: '#101010', text: '#eeeeee', cardText: '#eeeeee', accent: '#e8743b' }); assert.equal(v.ok, true); });

console.log('suggestCardText');
await ok('picks the better of white and near-black, says whether it reaches 4.5:1, never throws', () => {
  assert.deepEqual(suggestCardText('#d52924'), { color: '#ffffff', ratio: 5, ok: true, tone: 'light' }); assert.equal(suggestCardText('#f7f7f7').color, '#10131a'); assert.equal(suggestCardText('#808080').ok, true);
  assert.equal(suggestCardText('#777777').ok, false);
  for (const bad of [null, undefined, 5, 'red', '#12345', {}, [], '#GGGGGG']) assert.equal(suggestCardText(bad), null);
});

console.log('slots, contract, upload, serve');
await ok('cardText and cardMuted are named slots; bad values are refused like any color', () => {
  assert.ok(STYLE_SLOTS.includes('cardText') && STYLE_SLOTS.includes('cardMuted'));
  for (const bad of ['red', '#fff', '#12345g', 'url(x)', '#323334;}', 5, null, ['#323334']]) { assert.equal(validateStyles({ cardText: bad }).ok, false, String(bad)); assert.equal(validateStyles({ cardMuted: bad }).ok, false, String(bad)); }
  assert.equal(validateStyles({ cardText: '#e6e6e6' }).ok, true, 'a cardText alone is checked against the default dark card'); assert.equal(validateStyles({ cardText: '#323334' }).ok, false, 'and refused when it does not read on it');
});
await ok('the hash covers the new slots, in sorted order', () => { assert.ok(canonicalStyles({ cardText: '#111111', accent: '#222222' }).startsWith('[["accent"')); assert.notEqual(stylesHash({ ...SAMPLE_LOOK, cardText: '#323334' }), stylesHash(SAMPLE_LOOK)); });
await ok('the ingest contract check accepts the new slots and refuses a bad value', () => {
  assert.deepEqual(checkIncomingReport({ ...base, styles: { ...SAMPLE_LOOK, cardText: '#323334', cardMuted: '#555555' } }), []);
  assert.ok(checkIncomingReport({ ...base, styles: { cardText: 'dark' } }).length > 0);
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-cardtext-'));
const SECRET = 'cardtext-test-secret-' + 'x'.repeat(30);
const reportsDir = path.join(tmp, 'reports'), registryDir = path.join(tmp, 'registry'), auditLog = path.join(tmp, 'audit', 'ingest.log');
fs.mkdirSync(reportsDir); fs.mkdirSync(registryDir);
const ing = createIngestServer({ enabled: true, secret: SECRET, reportsDir, registryDir, auditLog, publicBase: 'https://audit.example.test', trustProxy: true, deniedDelayMs: 0, ratePerHour: 10000, rateBadPerMin: 1000, requireAccessHeader: false, acknowledgeNoEdgeAuth: true });
await new Promise((r) => ing.server.listen(0, '127.0.0.1', r));
const post = (body) => fetch(`http://127.0.0.1:${ing.server.address().port}/ingest/v1/reports`, { method: 'POST', headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.5', authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
let storedLink;
await ok('upload: a sample look with cardText is accepted (201)', async () => { const r = await post(makeEnvelope(base, { ...SAMPLE_LOOK, cardText: '#323334' })); assert.equal(r.status, 201, r.text); storedLink = JSON.parse(r.text).link; });
await ok('upload: an unreadable cardText on the red card is refused 422 with the colors and numbers in the answer, nothing stored, and the audit reason is styles-unreadable', async () => {
  const before = fs.readdirSync(reportsDir).length;
  const r = await post(makeEnvelope(base, { ...RED, cardText: '#323334' }));
  assert.equal(r.status, 422); assert.ok(r.text.includes('#323334') && r.text.includes('#d52924') && r.text.includes('2.52:1') && r.text.includes('#ffffff'), r.text);
  assert.equal(fs.readdirSync(reportsDir).length, before);
  const last = fs.readFileSync(auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop(); assert.equal(last.reason, 'styles-unreadable');
});
await new Promise((r) => ing.server.close(r));
await ok('serve: the page carries the card text variables for a look with cardText, and a look without them has none', async () => {
  const app = path.join(tmp, 'app.html'); fs.writeFileSync(app, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Website review</title>' + MARKER + '</head><body><div id="root"></div></body></html>');
  const rd = path.join(tmp, 'r2'), gd = path.join(tmp, 'g2'); fs.mkdirSync(rd); fs.mkdirSync(gd);
  const add = (styles) => { const tok = newToken(), fid = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(rd, fid + '.json'), JSON.stringify({ ...base, ...(styles ? { styles } : {}) })); fs.writeFileSync(path.join(gd, fid.slice(0, 8) + '.json'), JSON.stringify({ id: fid.slice(0, 8), tokenHash: hashToken(tok), path: fid + '.json', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), revoked: false })); return tok; };
  const withCard = add({ ...SAMPLE_LOOK, cardText: '#323334' }), without = add({ accent: '#e8743b', surface: '#101010', text: '#e6e6e6' });
  const { server } = createServer({ reportsDir: rd, registryDir: gd, appFile: app, outboxDir: path.join(tmp, 'outbox'), trustProxy: true, deniedDelayMs: 0, rateGeneral: 100000, rateBadToken: 100000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (t) => (await fetch(`http://127.0.0.1:${server.address().port}/r/${t}`, { headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9' } })).text();
  const a = await get(withCard), b = await get(without); await new Promise((r) => server.close(r));
  assert.ok(a.includes('--rp-card-ink:#323334') && a.includes('--rp-card-muted:') && a.includes('--rp-card-solid:#f7f7f7'), 'card vars are in the page');
  assert.ok(!b.includes('--rp-card-ink') && !b.includes('--rp-card-muted'), 'a look without cardText writes none');
});
await ok('the generated CSS for a cardText look passes the CSS guard', () => { const css = buildStyleCss(deriveStyleOutput(validateStyles({ ...SAMPLE_LOOK, cardText: '#323334' }).styles)); assert.ok(css && cssIsSafe(css)); });

console.log('severity chips and warning boxes on the card (v0.1.6 review)');
const CHIP_KEYS = ['sev-high', 'sev-medium', 'sev-low', 'warn'];
const hexIn = (s) => (s.match(/#[0-9a-f]{6}/gi) || []).map((x) => x.toLowerCase());
await ok('on a light card the chips and the warning box get their own pairs, all at 4.5:1 or better, and the card gets dark-on-light borders', () => {
  const o = deriveStyleOutput(validateStyles({ ...SAMPLE_LOOK, cardText: '#323334' }).styles);
  for (const k of CHIP_KEYS) { assert.ok(o.vars[`--rp-card-${k}-bg`] && o.vars[`--rp-card-${k}-fg`], k); assert.ok(contrast(o.vars[`--rp-card-${k}-fg`], o.vars[`--rp-card-${k}-bg`]) >= 4.5, k); }
  assert.ok(o.vars['--rp-card-line'] && o.vars['--rp-card-chip']);
  assert.equal(o.checks.filter((c) => /severity chip|warning box/.test(c.what)).length, 4); assert.ok(o.checks.filter((c) => /severity chip|warning box/.test(c.what)).every((c) => c.ok));
});
await ok('on the red card they get their own pairs too (a darker chip background so the light text keeps its contrast), and the red card needs no light borders', () => {
  const o = deriveStyleOutput(validateStyles(RED).styles);
  for (const k of CHIP_KEYS) assert.ok(contrast(o.vars[`--rp-card-${k}-fg`], o.vars[`--rp-card-${k}-bg`]) >= 4.5, k);
  assert.equal(o.vars['--rp-card-line'], undefined);
});
await ok('on the default dark card and on a dark custom card the stylesheet pairs already read (no card pairs written), and the checks still list them', () => {
  for (const st of [{}, { surface: '#101010', text: '#e6e6e6' }, { surface: '#1b1d22' }]) { const o = deriveStyleOutput(st); assert.equal(Object.keys(o.vars).filter((k) => /card-(sev|warn)/.test(k)).length, 0); }
  const checks = deriveStyleOutput({ surface: '#101010' }).checks.filter((c) => /severity chip|warning box/.test(c.what)); assert.equal(checks.length, 4); assert.ok(checks.every((c) => c.ok && c.ratio > 7));
});
await ok('a card where the chip pairs cannot be made to read is refused naming the surface and the pair (never silently accepted)', () => {
  // a mid-grey card with light card text: the text reads, so only the chips are in question; they are recomputed and read, so this look passes
  assert.equal(validateStyles({ surface: '#5a5a5a', text: '#ffffff' }).ok, true);
});

console.log('messages name the right slot, the right colors and that pair\'s ratio (v0.1.6 review)');
await ok('every refusal message states two colors and a ratio that are the real contrast of exactly those two colors, under the slot it names', () => {
  const hexes = ['#000000', '#101010', '#2a2a2a', '#5a5a5a', '#777777', '#999999', '#c8c8c8', '#e8e8e8', '#f7f7f7', '#ffffff', '#d52924', '#2a7fff', '#ffcc00', '#336699'];
  let checked = 0;
  for (const surface of hexes) for (const cardText of [undefined, '#101010', '#777777', '#ffffff', '#336699']) for (const cardMuted of [undefined, '#202020', '#999999', '#eeeeee']) for (const text of [undefined, '#323334', '#e6e6e6']) {
    const st = { surface, ...(cardText ? { cardText } : {}), ...(cardMuted ? { cardMuted } : {}), ...(text ? { text } : {}), muted: '#707070' };
    const v = validateStyles(st); if (v.ok) continue;
    for (const e of v.errors) {
      const m = /^(\w+): .*?(#[0-9a-f]{6})[^#]*?(#[0-9a-f]{6}) reaches only ([0-9.]+):1 and needs 4\.5:1/.exec(e) || /^(\w+): .*?\((#[0-9a-f]{6})\) on the card (#[0-9a-f]{6}) reaches only ([0-9.]+):1 and needs 4\.5:1/.exec(e);
      assert.ok(m, 'message form: ' + e);
      const [, slot, a, b, r] = m; checked++;
      assert.ok(Math.abs(contrast(a, b) - Number(r)) < 0.011, `${slot}: ${a} on ${b} says ${r} but is ${contrast(a, b).toFixed(2)}: ${e}`);
      if (slot === 'cardText') assert.equal(a, cardText, e); if (slot === 'cardMuted') { assert.equal(a, cardMuted, e); assert.equal(b, surface, e); }
    }
  }
  assert.ok(checked > 150, 'many refusals checked: ' + checked);
});
await ok('cardMuted alone on a dark card: named cardMuted, its own colors and its own ratio', () => {
  const m = msgs({ surface: '#101010', text: '#e6e6e6', cardMuted: '#202020' }); assert.match(m, /^cardMuted: #202020 on the card #101010 reaches only /, m);
  assert.ok(m.includes(contrast('#202020', '#101010').toFixed(2) + ':1'), m);
});
await ok('with cardText and a failing cardMuted: cardMuted is named with its own pair, and a failing cardText is named alone', () => {
  const a = msgs({ surface: '#f7f7f7', cardText: '#222222', cardMuted: '#eeeeee', muted: '#707070' }); assert.ok(a.startsWith('cardMuted: #eeeeee on the card #f7f7f7 reaches only 1.08:1') && a.split(' | ').length === 1, a);
  const b = msgs({ surface: '#f7f7f7', cardText: '#e0e0e0', cardMuted: '#eeeeee', muted: '#707070' }); assert.ok(b.includes('cardText: #e0e0e0') && b.includes('cardMuted: #eeeeee'), b);
});

console.log('the viewer stylesheet');
await ok('cards read --rp-card-ink and --rp-card-muted; both default to the page values for every theme, so a look without them is unchanged', () => {
  const v = fs.readFileSync(path.join(here, '../viewer/src/viewer.css'), 'utf8'), s = fs.readFileSync(path.join(here, '../viewer/src/styles.css'), 'utf8');
  assert.ok(v.includes('--ink: var(--rp-card-ink); --muted: var(--rp-card-muted); color: var(--rp-card-ink);') && v.includes('.rp-root .pv-card') && v.includes('.rp-root .pv-pagecard'));
  assert.equal(s.split('--rp-card-ink: var(--ink); --rp-card-muted: var(--muted);').length - 1, 2, 'dark and light defaults');
  assert.equal(s.split('--rp-card-sev-high-bg: var(--sev-high-bg);').length - 1, 2, 'the chip and warning pairs default to the page values in both themes');
  assert.ok(v.includes('--sev-high-bg: var(--rp-card-sev-high-bg)') && v.includes('--warn-fg: var(--rp-card-warn-fg)') && v.includes('--line: var(--rp-card-line)') && v.includes('--chip: var(--rp-card-chip)'), 'cards read the card pairs');
});
console.log('the card as drawn, not only the checked color (0.1.7): translucent cards, links, the second color, muted text and the muted label chip');
// The viewer draws a card as the card color at an opacity over the dark stage. This measures every text color against THAT color (and the label chip against its own tint over it).
const alphaOf = (v) => { const m = /rgba\([^)]*,\s*([0-9.]+)\)\s*$/.exec(v || ''); return m ? Number(m[1]) : 1; };
const drawn = (look) => {
  const st = validateStyles(look); assert.ok(st.ok, st.errors.join(' | ')); const o = deriveStyleOutput(st.styles), v = o.vars, panel = st.styles.surface;
  const card = (varName) => (panel ? mix(STAGE_BG, panel, varName ? alphaOf(v[varName]) : 1) : null);
  return { v, o, panel, tile: card('--panel'), glass: card('--rp-card-glass'), st: st.styles };
};
const LOOKS = {
  sample2Card: { ...SAMPLE_LOOK, surface: '#f0f1f4', muted: '#5a6070', cardText: '#2a2d33' }, sampleCard: { ...SAMPLE_LOOK, cardText: '#323334', cardMuted: '#4a4f58' },
  light2: { accent: '#1a6fd0', secondary: '#0b7a6e', link: '#1257a8', surface: '#f0f1f4', cardText: '#2a2d33', text: '#e6e6e6', muted: '#9aa3b5' },
  white: { accent: '#0b57d0', surface: '#ffffff', cardText: '#202124', text: '#e8eaed', muted: '#9aa0a6' },
  red: { ...RED, cardText: '#ffffff' }, redSurfaceOnly: { surface: '#d52924', text: '#ffffff' }, lightSurfaceOnly: { surface: '#f7f7f7', cardText: '#323334' }, redNoCardText: { ...RED, text: '#ffffff', muted: '#f2d0ce' }, darkCustom: { accent: '#e8743b', secondary: '#4fb0c6', surface: '#14202e', text: '#e6e6e6', muted: '#9aa3b5' },
};
for (const [name, look] of Object.entries(LOOKS)) {
  const sv = validateStyles(look); if (!sv.ok) continue; // a look that is refused has no card to draw
  await ok(`${name}: every text color reads at 4.5:1 on the card as drawn (card over the stage at the opacity the stylesheet uses), including the muted label chip`, () => {
    const d = drawn(look), v = d.v; const ink = v['--rp-card-ink'] || v['--ink'] || '#f4f6fb', muted = v['--rp-card-muted'] || v['--muted'] || '#aab2c5';
    for (const [what, c] of [['card text', ink], ['muted text', muted], ['link', v['--rp-link'] || (!look.link && !look.accent && luminance(d.panel) > 0.1 ? '#7c5cff' : null)], ['second color', v['--rp-secondary'] || (d.panel && luminance(d.panel) > 0.1 ? '#5fd3c6' : null)]]) {
      if (!c) continue;
      for (const [where, bg] of [['tile', d.tile], ['bar and help card', d.glass]]) if (bg) assert.ok(contrast(c, bg) >= 4.5, `${what} ${c} on the ${where} ${bg} reads ${contrast(c, bg).toFixed(2)}:1`);
    }
    if (d.panel) {
      const chipA = /rgba\(([0-9, ]+),\s*([0-9.]+)\)/.exec(v['--rp-card-chip'] || ''); const tint = chipA ? chipA[1].split(',').map((x) => Number(x)) : [255, 255, 255]; const tintHex = '#' + tint.map((x) => x.toString(16).padStart(2, '0')).join('');
      const a = chipA ? Number(chipA[2]) : 0.08, label = v['--rp-card-label-fg'] || muted;
      for (const bg of [d.tile, d.glass]) { const chipBg = mix(bg, tintHex, a); assert.ok(contrast(label, chipBg) >= 4.5, `the muted label chip ${label} on ${chipBg} reads ${contrast(label, chipBg).toFixed(2)}:1`); }
    }
  });
}
await ok('a light card is drawn opaque (the checked color is the color on screen); a dark card with light text keeps the glass look', () => {
  for (const name of ['sampleCard', 'sample2Card', 'light2', 'white']) { const d = drawn(LOOKS[name]); assert.equal(d.v['--panel'], d.panel, name + ' tile'); assert.equal(d.v['--rp-card-glass'], d.panel, name + ' bar'); }
  for (const name of ['red', 'darkCustom']) { const d = drawn(LOOKS[name]); assert.ok(alphaOf(d.v['--panel']) < 1 && alphaOf(d.v['--rp-card-glass']) < 1, name + ' stays translucent'); }
});
await ok('the muted label chip gets its own readable text color when the muted text does not read on the chip tint (the default dark look with a muted color nudged to exactly 4.5:1)', () => {
  const look = { accent: '#e8743b', text: '#e6e6e6', muted: '#8b93a7' };
  const d = deriveStyleOutput(validateStyles(look).styles);
  const chip = mix('#101521', '#ffffff', 0.08), muted = d.vars['--muted'];
  if (contrast(muted, chip) < 4.5) { assert.ok(d.vars['--rp-card-label-fg'], 'a label color is written'); assert.ok(contrast(d.vars['--rp-card-label-fg'], chip) >= 4.5); }
  assert.deepEqual(deriveStyleOutput({}).vars, {}, 'the default look writes nothing');
  const lc = drawn(LOOKS.sampleCard); assert.ok(lc.o.checks.some((c) => /muted label chip/.test(c.what) || !lc.v['--rp-card-label-fg']), 'the label chip is a listed check when its color is written');
});
await ok('the stylesheet reads the label chip color inside cards only', () => {
  const css = fs.readFileSync(path.join(here, '../viewer/src/styles.css'), 'utf8'), vcss = fs.readFileSync(path.join(here, '../viewer/src/viewer.css'), 'utf8');
  assert.ok(css.includes('.rp-chip.lab-FETCH, .rp-chip.lab-RAW { color: var(--label-fg, var(--muted));') && css.includes('.rp-chip.lab-LAB { color: var(--label-fg, var(--muted)); }'));
  assert.ok(vcss.includes('--label-fg: var(--rp-card-label-fg, var(--muted));'), 'defined inside the card rule only');
  assert.ok(!css.includes('--label-fg:') , 'not defined at the page level, so a page-level chip keeps the page muted color');
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} card text check(s) FAILED` : `\nall ${n} card text checks passed`);
process.exitCode = failed ? 1 : 0; // let pending sockets close by themselves (process.exit here can trip a libuv assertion on Windows)

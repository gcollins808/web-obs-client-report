// Reads, validates and turns an agency brand folder into what the viewer build needs. Plain Node, no packages.
//
// The brand file follows the home brand-profile structure (same key names), so it can later be swapped for that record and the schema
// widened. Keys the viewer uses now: name, colors, fonts, attribution. Carried and checked but not rendered: voice_context, audience,
// source, voice, avoid_words, negation_max_per_100_words, preferences. "logo" is optional and ignored (attribution is text only).
// Unknown keys are kept in `extra` and ignored, so a newer file still builds.
//
// With no brand.json, or one that does not pass, the build uses the CURRENT look (fallback) and says so. With WEBOBS_BRAND_STRICT=1 an
// invalid brand fails the build instead. Nothing in the result is a secret; `source` and the supplemental keys never go into the page.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
// 'surface' is an expansion of the home contract's colours: the background of cards and panels. It lets a brand pick any card colour without touching
// grey_0 / grey_1, which stay reserved for the page and 3D stage. Without it, cards use grey_2, then a derived grey.
export const COLOR_KEYS = ['primary', 'blue_dark', 'blue_light', 'tint', 'accent_orange', 'text', 'text_on_dark', 'grey_0', 'grey_1', 'grey_2', 'surface', 'muted', 'grid'];
const REQUIRED_COLORS = ['primary', 'text_on_dark'];
/** Reserved for visibility: a brand cannot change the page and 3D stage background or the globe's palette. These contract keys stay valid but are not applied. */
export const RESERVED_COLOR_KEYS = ['grey_0', 'grey_1'];
const SUPPLEMENTAL = ['voice_context', 'audience', 'source', 'voice', 'avoid_words', 'negation_max_per_100_words', 'preferences'];
const KNOWN = new Set(['schema_version', 'name', 'colors', 'fonts', 'logo', 'attribution', ...SUPPLEMENTAL]);
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/;
const FILE_BASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SYSTEM_STACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

import { STAGE_BG, rgb, hexOf, luminance, contrast, mix, readableOn, ensureContrast } from './color.mjs';
export { STAGE_BG, rgb, hexOf, luminance, contrast, mix, readableOn, ensureContrast };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Checks a parsed brand object. Returns { errors (structural: the brand is refused), warnings (supplemental or cosmetic), brand }. */
export function validateBrand(raw) {
  const errors = [], warnings = [];
  if (!isObj(raw)) return { errors: ['brand.json is not a JSON object'], warnings, brand: null };
  const b = { extra: {} };
  for (const k of Object.keys(raw)) if (!KNOWN.has(k)) b.extra[k] = raw[k];
  // schema_version
  if (raw.schema_version === undefined) b.schema_version = SCHEMA_VERSION;
  else if (!Number.isInteger(raw.schema_version) || raw.schema_version < 1) errors.push('schema_version must be a whole number, 1 or more');
  else { b.schema_version = raw.schema_version; if (raw.schema_version > SCHEMA_VERSION) warnings.push(`schema_version ${raw.schema_version} is newer than ${SCHEMA_VERSION}: unknown parts are ignored`); }
  // name
  if (!str(raw.name, 80)) errors.push('name must be a text of 1 to 80 characters'); else b.name = raw.name.trim();
  // colors
  b.colors = {};
  if (!isObj(raw.colors)) errors.push('colors must be an object');
  else {
    for (const k of Object.keys(raw.colors)) {
      if (COLOR_KEYS.includes(k)) { if (typeof raw.colors[k] === 'string' && HEX.test(raw.colors[k])) b.colors[k] = raw.colors[k].toLowerCase(); else errors.push(`colors.${k} must be #rrggbb`); }
      else b.extra['colors.' + k] = raw.colors[k];
    }
    for (const k of REQUIRED_COLORS) if (!b.colors[k] && !errors.some((e) => e.startsWith(`colors.${k} `))) errors.push(`colors.${k} is required`);
  }
  // fonts
  b.fonts = {};
  if (raw.fonts !== undefined) {
    if (!isObj(raw.fonts)) errors.push('fonts must be an object');
    else {
      const f = raw.fonts;
      if (f.heading !== undefined) {
        const h = f.heading;
        if (!isObj(h) || !FONT_NAME.test(h.name || '')) errors.push('fonts.heading.name must be a plain font name');
        else if (h.file !== undefined && !FILE_BASE.test(h.file)) errors.push('fonts.heading.file must be a file name without a folder');
        else if (h.case !== undefined && !['uppercase', 'none', 'capitalize', 'lowercase'].includes(h.case)) errors.push('fonts.heading.case must be uppercase, none, capitalize or lowercase');
        else b.fonts.heading = { name: h.name, file: h.file, case: h.case || 'none' };
      }
      if (f.body !== undefined) {
        const o = f.body;
        if (!isObj(o) || !FONT_NAME.test(o.name || '')) errors.push('fonts.body.name must be a plain font name');
        else if ([o.regular, o.bold].some((x) => x !== undefined && !FILE_BASE.test(x))) errors.push('fonts.body.regular and bold must be file names without a folder');
        else b.fonts.body = { name: o.name, regular: o.regular, bold: o.bold };
      }
    }
  }
  // attribution (text only), defaulting from the name
  const a = raw.attribution;
  if (a !== undefined && !isObj(a)) errors.push('attribution must be an object');
  else {
    const header = a?.header_text, footer = a?.footer_text;
    if (header !== undefined && !str(header, 80)) errors.push('attribution.header_text must be a text of 1 to 80 characters');
    if (footer !== undefined && !str(footer, 120)) errors.push('attribution.footer_text must be a text of 1 to 120 characters');
    b.attribution = { header_text: str(header, 80) ? header.trim() : b.name, footer_text: str(footer, 120) ? footer.trim() : (b.name ? `Prepared by ${b.name}` : undefined) };
  }
  // logo: optional, ignored
  if (raw.logo !== undefined && typeof raw.logo !== 'string') warnings.push('logo should be a text (a file path); it is ignored');
  // supplemental: carried, checked, never rendered, never shipped in the page
  b.supplemental = {};
  const sup = (k, ok, what) => { if (raw[k] === undefined) return; if (ok(raw[k])) b.supplemental[k] = raw[k]; else warnings.push(`${k} should be ${what}; it is ignored`); };
  const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  sup('voice_context', (v) => typeof v === 'string', 'a text'); sup('audience', (v) => typeof v === 'string', 'a text'); sup('source', (v) => typeof v === 'string', 'a text');
  sup('voice', strList, 'a list of texts'); sup('avoid_words', strList, 'a list of texts');
  sup('negation_max_per_100_words', (v) => typeof v === 'number' && v >= 0 && v < 100, 'a number from 0 to 100'); sup('preferences', isObj, 'an object');
  return { errors, warnings, brand: errors.length ? null : b };
}

/** Turns a valid brand into CSS custom properties and the small, non-secret object the page uses. */
export function deriveTokens(brand) {
  const c = brand.colors;
  const notes = [];
  const bg = STAGE_BG, panel = c.surface || c.grey_2 || mix(STAGE_BG, '#ffffff', 0.14);
  const ignored = RESERVED_COLOR_KEYS.filter((k) => c[k]);
  if (ignored.length) notes.push(`colors.${ignored.join(' and colors.')} ${ignored.length > 1 ? 'are' : 'is'} reserved for visibility (the page and 3D stage background stay the original dark ${STAGE_BG}) and ${ignored.length > 1 ? 'are' : 'is'} not applied`);
  const ink = c.text_on_dark;
  let muted = c.muted || mix(bg, ink, 0.55);
  const mutedFixed = ensureContrast(ensureContrast(muted, bg, ink, 4.5), panel, ink, 4.5); // reads well on the page and on panels
  if (mutedFixed !== muted) { notes.push(`muted ${muted} reads ${contrast(muted, bg).toFixed(1)}:1 on the dark background, so ${mutedFixed} (${Math.min(contrast(mutedFixed, bg), contrast(mutedFixed, panel)).toFixed(1)}:1 or more) is used for small text on dark`); muted = mutedFixed; }
  const accent = c.accent_orange || c.primary;
  const link = ensureContrast(ensureContrast(c.primary, bg, '#ffffff', 4.5), panel, '#ffffff', 4.5); // reads on the stage and on cards
  if (link !== c.primary) notes.push(`primary ${c.primary} reads ${contrast(c.primary, bg).toFixed(1)}:1 on the dark background, so ${link} is used for links and the name`);
  const secondary = ensureContrast(c.blue_light || link, panel, '#ffffff', 4.5);
  const onAccent = readableOn(accent);
  const rgba = (hex, a) => `rgba(${rgb(hex).join(', ')}, ${a})`;
  const vars = {
    '--ink': ink, '--muted': muted, '--panel-solid': panel, '--panel': rgba(panel, 0.82), '--rp-card-solid': panel, '--rp-card-glass': rgba(panel, 0.9), '--rp-card-edge': rgba(ink, 0.28),
    '--rp-accent': accent, '--rp-on-accent': onAccent, '--rp-link': link, '--rp-secondary': secondary,
  };
  const checks = [
    ['text on the stage background', ink, bg, 4.5], ['muted text on the stage background', muted, bg, 4.5], ['links on the stage background', link, bg, 4.5],
    ['the accent on the stage background', accent, bg, 3], ['text on an accent button', onAccent, accent, 4.5], ['text on a card', ink, panel, 4.5], ['muted text on a card', muted, panel, 4.5],
    ['links on a card', link, panel, 4.5], ['the second colour on a card', secondary, panel, 4.5],
    ['the card edge against the card', mix(panel, ink, 0.28), panel, 1.5], ['the card edge against the stage background', mix(bg, ink, 0.28), bg, 1.5],
  ].map(([what, fg, back, min]) => ({ what, fg, bg: back, ratio: Number(contrast(fg, back).toFixed(2)), min, ok: contrast(fg, back) >= min }));
  const brandVars = Object.fromEntries(Object.entries(c).filter(([k]) => !RESERVED_COLOR_KEYS.includes(k)).map(([k, v]) => [`--brand-${k.replace(/_/g, '-')}`, v]));
  return { vars, brandVars, accent, onAccent, notes, checks };
}

const mimeOf = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
function readFont(dir, base) {
  if (!base) return null;
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
  for (const ext of ['.woff2', '.woff', '.ttf', '.otf']) {
    for (const name of [stem + ext, base.endsWith(ext) ? base : null].filter(Boolean)) {
      const p = path.join(dir, 'fonts', name);
      if (path.dirname(p) === path.join(dir, 'fonts') && fs.existsSync(p)) { const data = fs.readFileSync(p); return { file: name, ext, bytes: data.length, mime: mimeOf[ext], b64: data.toString('base64') }; }
    }
  }
  return null;
}

/**
 * Loads the brand from `dir` (brand.json and fonts/). Returns { used: 'brand' | 'fallback', reason, warnings, errors, ... }.
 * `used === 'brand'` carries css (font faces and token overrides), title pieces and the small `page` object for the viewer.
 */
export function loadBrand(dir, env = process.env) {
  const out = { used: 'fallback', reason: '', warnings: [], errors: [], notes: [], checks: [], fonts: [], css: '', page: null, brand: null, dir };
  const strict = env.WEBOBS_BRAND_STRICT === '1';
  const fail = (why) => { out.reason = why; if (strict) throw new Error(`brand: ${why} (WEBOBS_BRAND_STRICT=1)`); return out; };
  if (env.WEBOBS_BRAND === 'off') { out.reason = 'WEBOBS_BRAND=off'; return out; }
  const file = path.join(dir, 'brand.json');
  if (!fs.existsSync(file)) return fail('no brand.json in ' + dir);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { out.errors.push('brand.json is not valid JSON: ' + e.message); return fail(out.errors[0]); }
  const v = validateBrand(raw);
  out.warnings.push(...v.warnings);
  if (!v.brand) { out.errors.push(...v.errors); return fail('brand.json did not pass: ' + v.errors.join('; ')); }
  const brand = v.brand; out.brand = brand;
  const t = deriveTokens(brand);
  out.notes.push(...t.notes); out.checks = t.checks;
  for (const ch of t.checks) if (!ch.ok) out.warnings.push(`contrast: ${ch.what} is ${ch.ratio}:1 (wanted ${ch.min}:1 or more)`);
  // fonts: files are looked up by the contract's file names, preferring a .woff2 of the same name
  const faces = [];
  const stack = (name, generic) => `'${name}', ${generic}`;
  let headingStack = SYSTEM_STACK, bodyStack = SYSTEM_STACK, headingCase = 'none';
  if (brand.fonts.heading) {
    const h = brand.fonts.heading, f = readFont(dir, h.file);
    headingCase = h.case;
    if (f) { faces.push({ family: h.name, weight: '400 700', f }); out.fonts.push({ role: 'heading', name: h.name, file: f.file, bytes: f.bytes }); } else out.warnings.push(`font file for heading "${h.name}" not found in fonts/: the system font is used unless "${h.name}" is installed`);
    headingStack = stack(h.name, SYSTEM_STACK);
  }
  if (brand.fonts.body) {
    const o = brand.fonts.body;
    for (const [base, weight] of [[o.regular, '400'], [o.bold, '600 700']]) {
      if (!base) continue;
      const f = readFont(dir, base);
      if (f) { faces.push({ family: o.name, weight, f }); out.fonts.push({ role: 'body', name: o.name, file: f.file, bytes: f.bytes }); } else out.warnings.push(`font file "${base}" for "${o.name}" not found in fonts/: the system font is used unless "${o.name}" is installed`);
    }
    bodyStack = stack(o.name, SYSTEM_STACK);
  }
  for (const f of faces) if (f.f.ext === '.ttf' || f.f.ext === '.otf') out.warnings.push(`${f.f.file} is not a web font file (${(f.f.bytes / 1024).toFixed(0)} KB embedded); a Latin-subset .woff2 of the same name is smaller`);
  const fontCss = faces.map(({ family, weight, f }) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:${f.mime};base64,${f.b64}) format('${f.ext === '.woff2' ? 'woff2' : f.ext === '.woff' ? 'woff' : f.ext === '.ttf' ? 'truetype' : 'opentype'}')}`).join('\n');
  const vars = { ...t.brandVars, '--rp-font-heading': headingStack, '--rp-font-body': bodyStack, '--rp-heading-case': headingCase === 'none' ? 'none' : headingCase };
  const rootVars = Object.entries(t.brandVars).map(([k, val]) => `${k}:${val}`).join(';');
  const brandedVars = Object.entries({ ...t.vars, '--rp-font-heading': vars['--rp-font-heading'], '--rp-font-body': vars['--rp-font-body'], '--rp-heading-case': vars['--rp-heading-case'] }).map(([k, val]) => `${k}:${val}`).join(';');
  out.css = `${fontCss}\n:root{${rootVars}}\n.rp-root.rp-dark.rp-branded{${brandedVars}}`;
  const escape = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  out.page = {
    name: brand.name, header: brand.attribution.header_text, footer: brand.attribution.footer_text, accent: t.accent, headingCase,
    titleText: `${escape(brand.name)} · Website health walkthrough`,
  };
  out.used = 'brand'; out.reason = `brand "${brand.name}" from ${file}`;
  return out;
}

/** The lines printed at build time. */
export function describe(r) {
  const lines = [r.used === 'brand' ? `[brand] using: ${r.reason}` : `[brand] using the built-in look (fallback): ${r.reason}`];
  if (r.used === 'brand') {
    lines.push(`[brand] fonts embedded: ${r.fonts.length ? r.fonts.map((f) => `${f.name} ${f.file} (${(f.bytes / 1024).toFixed(1)} KB)`).join(', ') : 'none (system fonts)'}`);
    lines.push(`[brand] contrast: ${r.checks.map((c) => `${c.what} ${c.ratio}:1${c.ok ? '' : ' LOW'}`).join('; ')}`);
    const extra = Object.keys(r.brand.extra); if (extra.length) lines.push(`[brand] unknown keys kept and ignored: ${extra.join(', ')}`);
    const sup = Object.keys(r.brand.supplemental); if (sup.length) lines.push(`[brand] carried, not rendered: ${sup.join(', ')}`);
  }
  for (const n of r.notes) lines.push('[brand] note: ' + n);
  for (const w of r.warnings) lines.push('[brand] warning: ' + w);
  return lines;
}

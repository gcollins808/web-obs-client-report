// Puts a report's validated styles into the viewer page, at serve time, in the first bytes of the HTML (so there is no unstyled flash).
// Everything here is written from VALIDATED values by the shared module (apps/viewer/brand/styles.mjs): the CSS variable lines, the title and one small
// JSON block. Nothing from the styles file is pasted into the page as it was sent. Never throws: any problem returns the page unchanged (the
// neutral look, or the look the build was made with) and a reason code. Fonts come only from the folder bundled in the image, by name.
import fs from 'node:fs';
import path from 'node:path';
import { validateStyles, deriveStyleOutput, buildStyleCss, fontFilesFor, safeJson } from '../viewer/brand/styles.mjs';

/** The dedicated place in the page: directly after <title>. The build adds it; a test fails if it is missing or appears twice. */
export const MARKER = '<!--wo-brand-->';
const BAKED_OPEN = '<style id="brand-tokens">';
const MAX_FONT_BYTES = 200 * 1024;

export function createStyleInjector({ fontsDir = path.join(import.meta.dirname || '.', 'fonts'), log = () => {}, now = () => Date.now() } = {}) {
  const fontCache = new Map(); // file name -> { b64 } or { failedAt }
  const readFont = (file) => {
    const hit = fontCache.get(file);
    if (hit && (hit.b64 || now() - hit.failedAt < 30000)) return hit.b64 || null;
    try {
      const p = path.join(fontsDir, file);
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size < 44 || st.size > MAX_FONT_BYTES) throw new Error('size');
      const data = fs.readFileSync(p);
      if (data.length > MAX_FONT_BYTES || data.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('magic');
      const b64 = data.toString('base64'); fontCache.set(file, { b64 }); return b64;
    } catch { fontCache.set(file, { failedAt: now() }); log('font-unreadable'); return null; }
  };

  /** html: the page text. rawStyles: what the report carries (or undefined). Returns { html, used, codes }. */
  const inject = (html, rawStyles) => {
    try {
      if (rawStyles === undefined || rawStyles === null) return { html, used: false, codes: [] };
      const v = validateStyles(rawStyles);
      if (!v.ok) { log(v.codes.includes('unreadable') ? 'styles-unreadable' : 'styles-invalid'); return { html, used: false, codes: v.codes }; }
      const out = deriveStyleOutput(v.styles);
      const fontData = {};
      for (const f of fontFilesFor(out.fonts)) { const b = readFont(f.file); if (b) fontData[f.file] = b; }
      const css = buildStyleCss(out, fontData);
      if (css === null) { log('css-guard'); return { html, used: false, codes: ['css-guard'] }; }
      if (html.split(MARKER).length !== 2) { log('marker'); return { html, used: false, codes: ['marker'] }; }
      const mi = html.indexOf(MARKER);
      const ti = html.lastIndexOf('<title>', mi), tj = ti < 0 ? -1 : html.indexOf('</title>', ti);
      if (ti < 0 || tj < 0 || tj + 8 !== mi) { log('marker'); return { html, used: false, codes: ['marker'] }; }
      const title = out.titleText ? `<title>${out.titleText}</title>` : html.slice(ti, tj + 8);
      const block = `<style id="wo-styles">${css}</style><script type="application/json" id="wo-brand">${safeJson(out.page)}</script>`;
      let page = html.slice(0, ti) + title + block + html.slice(mi + MARKER.length);
      // A page that was built with its own brand carries that brand's style block later in the head; the report's styles replace it.
      const bi = page.indexOf(BAKED_OPEN);
      if (bi >= 0) { const bj = page.indexOf('</style>', bi); if (bj > bi) page = page.slice(0, bi) + page.slice(bj + 8); }
      return { html: page, used: true, codes: [] };
    } catch { log('inject-error'); return { html, used: false, codes: ['inject-error'] }; }
  };
  return { inject };
}

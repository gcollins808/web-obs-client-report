// The agency brand this build was made with (apps/viewer/brand). null when none was supplied: the built-in look is used.
// The look of this page: first the styles block the report server writes into the first bytes (a report's own styles), then the brand the build was made with,
// then null (the built-in look). The block is data, never HTML: it is parsed as JSON and every value is checked again here.
export interface PageBrand { name: string; footer?: string; accent: string; headingCase: string; headingFont?: string; bodyFont?: string }
const HEXC = /^#[0-9a-f]{6}$/i;
const CASES = ['uppercase', 'none', 'capitalize', 'lowercase'];
const FONTS = ['Oswald', 'Inter'];
const buildBrand = typeof __WEBOBS_BRAND__ === 'undefined' ? null : __WEBOBS_BRAND__;
function readBlock(): PageBrand | null | undefined {
  try {
    const el = document.getElementById('wo-brand');
    if (!el) return undefined;
    const j = JSON.parse(el.textContent || '') as Record<string, unknown>;
    if (!j || typeof j !== 'object' || Array.isArray(j) || Object.keys(j).length === 0) return undefined; // missing or {}: the build's look
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
    return {
      name: text(j.name, 80) ?? '', footer: text(j.footer, 120),
      accent: typeof j.accent === 'string' && HEXC.test(j.accent) ? j.accent : '#7c5cff',
      headingCase: typeof j.headingCase === 'string' && CASES.includes(j.headingCase) ? j.headingCase : 'none',
      headingFont: typeof j.headingFont === 'string' && FONTS.includes(j.headingFont) ? j.headingFont : undefined,
      bodyFont: typeof j.bodyFont === 'string' && FONTS.includes(j.bodyFont) ? j.bodyFont : undefined,
    };
  } catch { return undefined; }
}
const fromBlock = readBlock();
export const BRAND: PageBrand | null = fromBlock !== undefined ? fromBlock : (buildBrand ? { name: buildBrand.name, footer: buildBrand.footer, accent: buildBrand.accent, headingCase: buildBrand.headingCase } : null);

/** Holds the first draw until the report's branded fonts are ready (at most about 1.5 seconds), so the heading never changes face after it appears. */
export function holdForFonts(): Promise<void> {
  try {
    if (!BRAND || !(BRAND.headingFont || BRAND.bodyFont) || !document.fonts || !document.fonts.load) return Promise.resolve();
    const loads: Promise<unknown>[] = [];
    if (BRAND.bodyFont) loads.push(document.fonts.load('400 1em "' + BRAND.bodyFont + '"'), document.fonts.load('600 1em "' + BRAND.bodyFont + '"'));
    if (BRAND.headingFont) loads.push(document.fonts.load('600 1em "' + BRAND.headingFont + '"'));
    return Promise.race([Promise.allSettled(loads).then(() => undefined), new Promise<void>((r) => setTimeout(r, 1500))]);
  } catch { return Promise.resolve(); }
}

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** Whichever of dark or white text reads better on `hex` (WCAG ratio). Used only with a brand; the built-in look keeps its own rule. */
export function readableTextOn(hex: string): string {
  const l = lum(hex), dark = (l + 0.05) / (lum('#10131a') + 0.05), light = 1.05 / (l + 0.05);
  return dark >= light ? '#10131a' : '#ffffff';
}

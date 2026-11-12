// Reads the visible text the viewer ships (JSX text, titles, labels, placeholders, button text, quoted sentences in the components) and
// checks it against the brand's avoid_words and negation_max_per_100_words. It only WARNS: a technical string is never blocked, but every
// finding is listed so a person can decide. Uses the brand folder (default apps/viewer/brand, or WEBOBS_BRAND_DIR).
//   node apps/viewer/brand/scan-wording.mjs [brand-dir] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrand } from './load-brand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NEGATION = /\b(not|no|never|none|nothing|cannot|can't|cant|don't|dont|doesn't|doesnt|isn't|isnt|aren't|arent|won't|wont|couldn't|without|nobody|neither|nor)\b/gi;

/** Visible strings of one source file: { text, line }. Heuristic on purpose; it errs toward listing too much. */
export function visibleStrings(source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    const plain = line.replace(/{[^{}]*}/g, ' '); // expressions inside JSX text are skipped, the words around them are kept
    for (const m of plain.matchAll(/>([^<>{}=]*[A-Za-z]{2,}[^<>{}=]*)</g)) out.push({ text: m[1].trim(), line: i + 1 }); // JSX text between tags
    for (const m of line.matchAll(/\b(?:title|aria-label|placeholder|alt|label|caption|name)=(["'])(.+?)\1/g)) out.push({ text: m[2], line: i + 1 });
    for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).){6,}?)\1/g)) { // sentences in quotes: a capital letter, two or more words, no code characters
      const s = m[2];
      if (/^[A-Z][^{}<>=;|&]*\s[^{}<>=;|&]+$/.test(s) && !/[a-z]-[a-z]/.test(s.split(' ')[0]) && !/^[A-Z_]+$/.test(s)) out.push({ text: s, line: i + 1 });
    }
  });
  return out.filter((x) => x.text.length > 1);
}

export function scan({ dir, files, avoid, maxNeg }) {
  const items = [];
  for (const f of files) for (const s of visibleStrings(fs.readFileSync(f, 'utf8'))) items.push({ file: path.relative(dir, f).replace(/\\/g, '/'), ...s });
  const seen = new Set(), uniq = items.filter((i) => { const k = i.file + '|' + i.text; if (seen.has(k)) return false; seen.add(k); return true; });
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = avoid.length ? new RegExp(`\\b(${avoid.map(esc).join('|')})\\b`, 'gi') : null;
  const findings = [];
  for (const i of uniq) { if (!re) break; const hit = [...i.text.matchAll(re)].map((m) => m[1].toLowerCase()); if (hit.length) findings.push({ ...i, words: [...new Set(hit)] }); }
  const text = uniq.map((i) => i.text).join(' '), words = (text.match(/[A-Za-z']+/g) || []).length, negations = (text.match(NEGATION) || []).length;
  const per100 = words ? (negations / words) * 100 : 0;
  const negationStrings = uniq.filter((i) => (i.text.match(NEGATION) || []).length).map((i) => ({ file: i.file, line: i.line, text: i.text, count: (i.text.match(NEGATION) || []).length }));
  return { negationStrings, strings: uniq.length, words, negations, per100: Number(per100.toFixed(2)), maxNeg, overNegation: maxNeg != null && per100 > maxNeg, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), jsonAt = args.indexOf('--json');
  const dirArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--json');
  const brandDir = dirArg ? path.resolve(dirArg) : process.env.WEBOBS_BRAND_DIR ? path.resolve(process.env.WEBOBS_BRAND_DIR) : here;
  const b = loadBrand(brandDir, { ...process.env, WEBOBS_BRAND_STRICT: '0' });
  const sup = b.brand?.supplemental ?? {};
  const avoid = sup.avoid_words ?? [], maxNeg = sup.negation_max_per_100_words ?? null;
  const comp = path.join(here, '..', 'src', 'components');
  const files = [...fs.readdirSync(comp).filter((f) => f.endsWith('.tsx')).map((f) => path.join(comp, f)), path.join(here, '..', 'src', 'main.tsx')];
  const CLIENT = ['PackageViewer.tsx', 'Scenes.tsx', 'Viewer.tsx', 'GlobeStage.tsx', 'ToolIcons.tsx', 'main.tsx']; // what a client sees (the agency Studio screens are the rest)
  const clientFiles = files.filter((f) => CLIENT.includes(path.basename(f)));
  const shipped = b.page ? [`(brand) ${b.page.header}`, `(brand) ${b.page.footer}`, `(brand) ${b.page.titleText}`] : [];
  const r = scan({ dir: path.join(here, '..', 'src'), files, avoid, maxNeg });
  for (const s of shipped) for (const w of avoid) if (new RegExp(`\\b${w}\\b`, 'i').test(s)) r.findings.push({ file: 'brand', line: 0, text: s, words: [w] });
  console.log(`[wording] brand: ${b.used === 'brand' ? b.brand.name : 'none (built-in look); no avoid_words to check'}`);
  const rc = scan({ dir: path.join(here, '..', 'src'), files: clientFiles, avoid, maxNeg });
  console.log(`[wording] client-facing screens: ${rc.strings} strings, ${rc.words} words; negations ${rc.negations} = ${rc.per100} per 100 words (limit ${rc.maxNeg ?? 'none'})${rc.overNegation ? ' OVER' : ' within the limit'}; avoided words: ${rc.findings.length}`);
  for (const f of rc.negationStrings) console.log('    ' + f.file + ':' + f.line + '  ' + (f.text.length > 100 ? f.text.slice(0, 97) + '...' : f.text));
  console.log(`[wording] all screens including the agency Studio: ${r.strings} visible strings, ${r.words} words; negations ${r.negations} = ${r.per100} per 100 words (limit ${r.maxNeg ?? 'none'})${r.overNegation ? ' OVER' : ''}`);
  console.log(`[wording] ${r.findings.length} string(s) contain avoided words (warnings only):`);
  for (const f of r.findings) console.log(`  ${f.file}:${f.line}  [${f.words.join(', ')}]  ${f.text.length > 110 ? f.text.slice(0, 107) + '...' : f.text}`);
  console.log('[wording] strings with negations (' + r.negationStrings.length + ', most first):');
  for (const f of [...r.negationStrings].sort((x, y) => y.count - x.count).slice(0, 40)) console.log('  ' + f.file + ':' + f.line + '  x' + f.count + '  ' + (f.text.length > 100 ? f.text.slice(0, 97) + '...' : f.text));
  if (jsonAt >= 0) fs.writeFileSync(args[jsonAt + 1], JSON.stringify(r, null, 2));
}

// Checks a styles file (the look a report carries) without sending or storing anything. Same validator and the same page writer as the ingest and the server.
//   node tools/check-styles.mjs <styles.json> [report.html]
// Prints: the pairing hash, what is used, every readability number, what was adjusted, and the size the page grows by. Exit 1 if the file would be refused.
// A styles file is public to everyone who holds a report link: put no private notes or contact details in it. No network, no files are written.
import fs from 'node:fs';
import path from 'node:path';
import { validateStyles, deriveStyleOutput, STYLES_MAX_CHARS } from '../../viewer/brand/styles.mjs';
import { stylesHash } from '../../viewer/brand/styles-hash.mjs';
import { createStyleInjector } from '../styles-inject.mjs';

const file = process.argv[2];
if (!file) { console.error('Usage: node tools/check-styles.mjs <styles.json> [report.html]'); process.exit(2); }
let raw;
try { const text = fs.readFileSync(file, 'utf8'); if (text.length > 64 * 1024) throw new Error('too large'); raw = JSON.parse(text.replace(/^﻿/, '')); } catch { console.error('[styles] the file cannot be read as JSON (or it is larger than 64 KB)'); process.exit(1); }
const v = validateStyles(raw);
if (!v.ok) { console.log('[styles] REFUSED:'); for (const e of v.errors) console.log('  - ' + e); process.exit(1); }
const out = deriveStyleOutput(v.styles);
console.log(`[styles] accepted. Pairing hash: ${stylesHash(raw)} (the part names are styles_${stylesHash(raw)} and data_${stylesHash(raw)})`);
console.log(`[styles] slots used: ${Object.keys(v.styles).join(', ') || 'none'} (file size ${JSON.stringify(raw).length} of ${STYLES_MAX_CHARS} characters)`);
console.log(`[styles] contrast: ${out.checks.map((c) => `${c.what} ${c.ratio}:1${c.ok ? '' : ' LOW'}`).join('; ') || 'nothing to check'}`);
for (const n of out.notes) console.log('[styles] note: ' + n);
const pagePath = process.argv[3] || path.join(import.meta.dirname, '..', 'report.html');
if (fs.existsSync(pagePath)) {
  const html = fs.readFileSync(pagePath, 'utf8'); const r = createStyleInjector({}).inject(html, v.styles);
  if (!r.used) { console.log(`[styles] the page could not take these styles (${r.codes.join(', ') || 'unknown'})`); process.exit(1); }
  console.log(`[styles] the page grows by ${Buffer.byteLength(r.html) - Buffer.byteLength(html)} bytes (fonts included)`);
}
console.log('[styles] reminder: everything in a styles file is visible to anyone who has the report link.');

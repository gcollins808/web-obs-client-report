// Checks vendor/web-obs against the sha256 table in UPSTREAM.md. Fails on a hand-edited, missing or extra file.
// Used by CI, by npm test and by scripts/sync-upstream.mjs.   node scripts/check-vendor-drift.mjs [--root <dir>]
import path from 'node:path';
import { REPO_ROOT, MANIFEST_REL, VENDOR_REL, checkDrift, describeDrift, parseArgs } from './lib/upstream.mjs';

const { opts } = parseArgs(process.argv.slice(2), ['root']);
const root = path.resolve(opts.root || REPO_ROOT);
let d;
try { d = checkDrift(root); } catch (e) { console.error('Vendor drift check FAILED: ' + e.message); process.exit(1); }
if (!d.ok) {
  console.error(`Vendor drift check FAILED: ${VENDOR_REL} does not match ${MANIFEST_REL}:\n  ` + describeDrift(d).join('\n  '));
  console.error('Local changes belong in patches/*.patch, applied by npm run sync:upstream. See UPSTREAM.md, "How to update".');
  process.exit(1);
}
console.log(`Vendor drift check OK: ${d.count} files in ${VENDOR_REL} match ${MANIFEST_REL}, none missing, none extra.`);

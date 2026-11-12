// Remove an old or mistaken scrape from a web-obs vault, safely: nothing is deleted. The capture folder and its history are
// MOVED to a trash folder inside the vault, and can be moved back. The Studio's "Archive capture" button runs the same code.
//
//   node apps/server/scripts/remove-capture.mjs <vault> <domain>                       lists exactly what would be moved (changes nothing)
//   node apps/server/scripts/remove-capture.mjs <vault> <domain> --confirm <domain>    moves it to <vault>/.web-obs/trash/<domain>-<time>/
//
// Moved, if present: sites/<domain>/  (the capture, its notes and files),
//                    .web-obs/history/<domain>/  (the earlier captures kept for safe recapture),
//                    .web-obs/staging/<domain>/  (an unfinished capture).
// Not touched: every other site, and any report or export you made from this capture elsewhere.
import { planRemoval, moveToTrash, CaptureError } from './lib/capture-core.mjs';

const [vault, domain, ...rest] = process.argv.slice(2);
const confirm = rest[0] === '--confirm' ? rest[1] : undefined;
const fail = (m) => { console.error('error: ' + m); process.exit(2); };
if (!vault || !domain) fail('usage: remove-capture.mjs <vault> <domain> [--confirm <domain>]');
try {
  const plan = planRemoval(vault, domain);
  console.log(`Capture to remove: ${domain}`);
  for (const t of plan.items) console.log(`  ${t.label.padEnd(20)} ${t.rel}/   ${t.files} files, ${(t.bytes / 1048576).toFixed(1)} MB`);
  if (confirm !== domain) {
    console.log('\nNothing has been changed. To move this to the trash folder (not delete it), run:');
    console.log(`  node apps/server/scripts/remove-capture.mjs "${vault}" ${domain} --confirm ${domain}`);
  } else {
    const done = moveToTrash(vault, domain, confirm);
    console.log(`\nMoved to ${done.trash}/ . Nothing was deleted; see REMOVED.txt there to restore it.`);
  }
} catch (e) { fail(e instanceof CaptureError ? e.message : 'unexpected error'); }

// Archive ("remove") a scrape from a web-obs vault without deleting anything. Used by apps/server/scripts/remove-capture.mjs and by the Studio's
// Archive capture button (through the local publish helper), so there is one code path. Files are MOVED into
// <vault>/.web-obs/trash/<domain>-<time>/ with a note on how to put them back.
import fs from 'node:fs';
import path from 'node:path';

export class CaptureError extends Error { constructor(message, code = 'failed') { super(message); this.code = code; } }
const DOMAIN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
export const isDomain = (d) => typeof d === 'string' && DOMAIN.test(d) && !d.includes('..') && d.length <= 120;

const stat = (dir) => {
  let files = 0, bytes = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; try { bytes += fs.statSync(p).size; } catch { /* vanished */ } } } };
  walk(dir);
  return { files, bytes };
};
const targetsFor = (domain) => [
  { label: 'capture', rel: ['sites', domain], trash: 'sites' },
  { label: 'history', rel: ['.web-obs', 'history', domain], trash: 'history' },
  { label: 'unfinished capture', rel: ['.web-obs', 'staging', domain], trash: 'staging' },
];

/** The domains that have a capture folder in the vault, with sizes. Read only. */
export function listCaptures(vaultArg) {
  const vault = path.resolve(String(vaultArg || ''));
  const sites = path.join(vault, 'sites');
  if (!fs.existsSync(sites)) throw new CaptureError('There is no "sites" folder in that vault.', 'no-vault');
  return fs.readdirSync(sites, { withFileTypes: true }).filter((e) => e.isDirectory() && isDomain(e.name)).map((e) => ({ domain: e.name, ...stat(path.join(sites, e.name)) })).sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Exactly what would be moved. Read only. */
export function planRemoval(vaultArg, domain) {
  if (!isDomain(domain)) throw new CaptureError('That is not a plain domain name.', 'bad-domain');
  const vault = path.resolve(String(vaultArg || ''));
  if (!fs.existsSync(path.join(vault, 'sites'))) throw new CaptureError('There is no "sites" folder in that vault.', 'no-vault');
  const items = targetsFor(domain).filter((t) => fs.existsSync(path.join(vault, ...t.rel))).map((t) => ({ ...t, rel: t.rel.join('/'), ...stat(path.join(vault, ...t.rel)) }));
  if (!items.length) throw new CaptureError(`Nothing was found for ${domain}.`, 'not-found');
  return { vault, domain, items, files: items.reduce((a, i) => a + i.files, 0), bytes: items.reduce((a, i) => a + i.bytes, 0) };
}

/** Moves the plan's folders to the trash. Needs the domain typed again. A failure puts back anything already moved. */
export function moveToTrash(vaultArg, domain, confirm) {
  const plan = planRemoval(vaultArg, domain);
  if (confirm !== domain) throw new CaptureError('Type the domain again to confirm.', 'not-confirmed');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/[.]\d+Z$/, 'Z');
  const trash = path.join(plan.vault, '.web-obs', 'trash', `${domain}-${stamp}`);
  fs.mkdirSync(trash, { recursive: true });
  const moved = [];
  try {
    for (const t of plan.items) { fs.renameSync(path.join(plan.vault, ...t.rel.split('/')), path.join(trash, t.trash)); moved.push(t); }
  } catch (e) {
    for (const t of moved.reverse()) fs.renameSync(path.join(trash, t.trash), path.join(plan.vault, ...t.rel.split('/')));
    throw new CaptureError(`Could not move everything (${e.code || 'error'}). Nothing was changed.`, 'failed');
  }
  fs.writeFileSync(path.join(trash, 'REMOVED.txt'), `Capture ${domain} was moved here on ${new Date().toISOString()}.\nTo restore it, move the folders back: ${plan.items.map((t) => `${t.trash}/ -> ${t.rel}/`).join('; ')}\nNothing in this folder is deleted until you delete it yourself.\n`);
  return { ...plan, trash: path.relative(plan.vault, trash).split(path.sep).join('/') };
}

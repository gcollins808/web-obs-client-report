// Really remove expired reports. The report server only READS its volume (it stops serving a link at its expiry, but cannot delete),
// so this runs on the host that owns the volume, by hand in dev and on a schedule in production:
//
//   node apps/server/tools/cleanup.mjs --reports /srv/webobs/reports --registry /srv/webobs/registry [--orphan-hours 48] [--dry-run]
//   npm run reports:cleanup            (dev: uses the folder in WEBOBS_PUBLISH_TARGET when it is a local folder)
//
// It deletes: (1) every link entry that has expired or been revoked, together with its report file; (2) link entries whose report file
// is already gone; (3) any report file with no link entry that is older than --orphan-hours (default 48), such as one left by an
// interrupted upload; (4) any link-entry .json.tmp older than an hour. Run it daily (cron or a systemd timer; see docs/SETUP.md, step 9,
// and apps/server/README.md). The image carries it as /app/tools/cleanup.mjs, so with a named volume:
//   docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v webobs-data:/data IMAGE \
//     node tools/cleanup.mjs --reports /data/reports --registry /data/registry [--dry-run]
// (or the optional "cleanup" service in deploy/docker-compose.yml). Try it first with --dry-run. It never touches anything else (not the outbox, not other folders) and prints counts and ids, never a token or a hash.
// Feedback emails already sent are unaffected: they were delivered to your inbox and are not stored here.
import fs from 'node:fs';
import path from 'node:path';

export function cleanup({ reportsDir: rd, registryDir: gd, orphanHours = 48, dry = false, now = Date.now(), log = () => {} }) {
  const reportsDir = path.resolve(rd), registryDir = path.resolve(gd);
  const inside = (rel) => typeof rel === 'string' && rel && !rel.includes('..') && !path.isAbsolute(rel) && path.resolve(reportsDir, rel).startsWith(reportsDir + path.sep);
  const res = { expired: 0, revoked: 0, missingFile: 0, orphans: 0, kept: 0, tmp: 0 };
  const rm = (file) => { if (!dry) fs.rmSync(file, { force: true }); };
  const referenced = new Set();
  const names = fs.existsSync(registryDir) ? fs.readdirSync(registryDir).filter((n) => n.endsWith('.json')) : [];
  for (const n of names) {
    const ef = path.join(registryDir, n);
    let e; try { e = JSON.parse(fs.readFileSync(ef, 'utf8')); } catch { continue; } // not a link entry: leave it alone
    const file = inside(e.path) ? path.resolve(reportsDir, e.path) : null;
    const expired = !e.expiresAt || Date.parse(e.expiresAt) <= now;
    const gone = file && !fs.existsSync(file);
    if (e.revoked || expired || gone || !file) {
      if (e.revoked) res.revoked++; else if (expired) res.expired++; else res.missingFile++;
      log(`${dry ? 'would remove' : 'removing'} link ${e.id} (${e.revoked ? 'revoked' : expired ? 'expired' : 'report file missing'})`);
      if (file) rm(file);
      rm(ef);
    } else { res.kept++; referenced.add(file); }
  }
  // (4) a half-written link entry (name ends in .json.tmp) left by an upload that was interrupted; only if older than an hour, so a live upload is never touched.
  for (const n of fs.existsSync(registryDir) ? fs.readdirSync(registryDir).filter((x) => x.endsWith('.json.tmp')) : []) {
    const f = path.join(registryDir, n);
    if (now - fs.statSync(f).mtimeMs > 3600000) { res.tmp++; log(`${dry ? 'would remove' : 'removing'} an interrupted upload leftover (${n.replace(/[.]json[.]tmp$/, '')})`); rm(f); }
  }
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)])) : []);
  for (const file of walk(reportsDir)) {
    if (!file.endsWith('.json') || referenced.has(file)) continue;
    if (now - fs.statSync(file).mtimeMs > orphanHours * 3600000) { res.orphans++; log(`${dry ? 'would remove' : 'removing'} unreferenced report file ${path.relative(reportsDir, file).split(path.sep).join('/')}`); rm(file); }
  }
  if (!dry) for (const d of fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir, { withFileTypes: true }).filter((x) => x.isDirectory()) : []) { const p = path.join(reportsDir, d.name); if (!fs.readdirSync(p).length) fs.rmdirSync(p); }
  return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  const args = process.argv.slice(2); const f = {};
  for (let i = 0; i < args.length; i++) { if (args[i] === '--dry-run') f.dry = true; else if (args[i].startsWith('--')) { f[args[i].slice(2)] = args[i + 1]; i++; } }
  try { process.loadEnvFile(path.join(path.resolve(import.meta.dirname, '..', '..', '..'), '.env')); } catch { /* no .env: flags only */ }
  const target = (process.env.WEBOBS_PUBLISH_TARGET || '').trim();
  const localTarget = target && path.isAbsolute(target) ? target : '';
  const orphanHours = Number(f['orphan-hours'] ?? 48);
  if ((!f.reports && !localTarget) || !(orphanHours >= 0)) { console.error('usage: cleanup.mjs --reports <dir> --registry <dir> [--orphan-hours 48] [--dry-run]'); process.exit(2); }
  const reportsDir = path.resolve(f.reports || path.join(localTarget, 'reports'));
  const registryDir = path.resolve(f.registry || (localTarget ? path.join(localTarget, 'registry') : path.join(path.dirname(reportsDir), 'registry')));
  const r = cleanup({ reportsDir, registryDir, orphanHours, dry: Boolean(f.dry), log: (m) => console.log(m) });
  console.log(`${f.dry ? 'Dry run: ' : ''}${r.expired} expired, ${r.revoked} revoked, ${r.missingFile} with a missing file, ${r.orphans} unreferenced file(s) ${f.dry ? 'would be ' : ''}removed; ${r.kept} link(s) kept.`);
}

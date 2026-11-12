// Shared by scripts/sync-upstream.mjs, scripts/check-vendor-drift.mjs and scripts/upstream-moved.mjs.
// UPSTREAM.md at the repository root is the manifest of the vendored web-obs globe: where it came from and the sha256 of every
// vendored file. The scripts only read and write that file and vendor/web-obs; they never commit, push or open a pull request.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_URL = 'https://github.com/AgriciDaniel/web-obs';
export const DEFAULT_REF = 'main';
export const VENDOR_REL = 'vendor/web-obs';
export const MANIFEST_REL = 'UPSTREAM.md';
export const PATCHES_REL = 'patches';

/** The files the viewer needs, relative to vendor/web-obs. Each one comes from upstream src/<same path>. */
export const VENDOR_FILES = Object.freeze([
  'components/MapDiscoveryControls.tsx',
  'components/SiteGlobeCanvas3D.tsx',
  'components/ViewGizmo3D.tsx',
  'components/brandBadge.ts',
  'components/mapDiscoveryStyles.ts',
  'data/brandMark.ts',
  'data/globeLayout.ts',
  'data/linkCoverage.ts',
  'data/mapAttention.ts',
  'data/mapDiscovery.ts',
  'data/pillLabel.ts',
  'data/siteAudit.ts',
  'data/sitePresentation.ts',
  'styles/map.css',
  'styles/theme.css',
  'styles/ui.css',
  'types/site.ts',
]);
export const upstreamPath = (f) => 'src/' + f;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Every file below dir, as forward-slash paths relative to dir. */
export function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  })(dir, '');
  return out.sort();
}

export function hashDir(dir) {
  const m = new Map();
  for (const f of listFiles(dir)) m.set(f, sha256(fs.readFileSync(path.join(dir, f))));
  return m;
}

const ROW = /^\|\s*`?([A-Za-z0-9_.\/-]+)`?\s*\|\s*`?([A-Za-z0-9_.\/-]+)`?\s*\|\s*`?([0-9a-f]{64})`?\s*\|\s*$/;
const FIELD = /^- ([A-Za-z][A-Za-z ]*?): (.*)$/;

/** Reads the fields ("- Name: value" lines) and the vendored-file hash table of UPSTREAM.md. */
export function parseManifest(text) {
  const fields = {};
  const files = new Map();
  for (const line of text.split(/\r?\n/)) {
    const r = ROW.exec(line);
    if (r) { files.set(r[1], { upstream: r[2], sha256: r[3] }); continue; }
    const f = FIELD.exec(line);
    if (f && !(f[1] in fields)) fields[f[1]] = f[2].trim();
  }
  return { fields, files };
}

export function readManifest(root) {
  const file = path.join(root, MANIFEST_REL);
  if (!fs.existsSync(file)) throw new Error(`${MANIFEST_REL} not found in ${root}`);
  return parseManifest(fs.readFileSync(file, 'utf8'));
}

export const isFullSha = (s) => /^[0-9a-f]{40}$/.test(String(s || ''));

/** Compares vendor/web-obs with the hash table: changed, missing and extra files. */
export function checkDrift(root) {
  const { files } = readManifest(root);
  const dir = path.join(root, VENDOR_REL);
  const changed = [], missing = [], extra = [];
  if (files.size === 0) return { ok: false, changed, missing, extra, empty: true, count: 0 };
  for (const [f, { sha256: want }] of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) missing.push(f);
    else if (sha256(fs.readFileSync(p)) !== want) changed.push(f);
  }
  for (const f of listFiles(dir)) if (!files.has(f)) extra.push(f);
  return { ok: !changed.length && !missing.length && !extra.length, changed, missing, extra, empty: false, count: files.size };
}

export function describeDrift(d) {
  if (d.empty) return [`${MANIFEST_REL} has no hash table of the vendored files`];
  return [
    ...d.changed.map((f) => `edited by hand (hash differs): ${VENDOR_REL}/${f}`),
    ...d.missing.map((f) => `missing: ${VENDOR_REL}/${f}`),
    ...d.extra.map((f) => `extra file not in ${MANIFEST_REL}: ${VENDOR_REL}/${f}`),
  ];
}

/** Compares two path -> sha256 maps. */
export function diffMaps(before, after) {
  const added = [], removed = [], changed = [], unchanged = [];
  for (const [f, h] of after) { if (!before.has(f)) added.push(f); else if (before.get(f) !== h) changed.push(f); else unchanged.push(f); }
  for (const f of before.keys()) if (!after.has(f)) removed.push(f);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged: unchanged.sort() };
}

export function summaryLines(d) {
  const list = (a) => (a.length ? ': ' + a.join(', ') : '');
  return [
    `added ${d.added.length}${list(d.added)}`,
    `removed ${d.removed.length}${list(d.removed)}`,
    `changed ${d.changed.length}${list(d.changed)}`,
    `unchanged ${d.unchanged.length}`,
  ];
}

export function hashTable(hashes) {
  const rows = [...hashes.keys()].sort().map((f) => `| ${f} | ${upstreamPath(f)} | ${hashes.get(f)} |`);
  return ['| File (under vendor/web-obs/) | Upstream path | sha256 |', '|---|---|---|', ...rows].join('\n');
}

export const HOW_TO_UPDATE = [
  '`npm run sync:upstream -- [ref-or-sha] [--url <git url or local path>] [--dry-run] [--force-drift]` (default ref `main`, default url the source above).',
  '',
  '1. `npm run check:vendor-drift` first. It fails if a vendored file was edited by hand, or a file is missing or extra. Local changes',
  '   belong in `patches/*.patch` (paths `a/vendor/web-obs/...`), never directly in `vendor/web-obs`.',
  '2. `npm run sync:upstream -- <ref> --dry-run` shows which files would change, without writing anything.',
  '3. `npm run sync:upstream -- <ref>` clones the source read-only into a temporary folder (deleted at the end), copies only the files',
  '   listed below byte for byte from `src/`, applies `patches/*.patch` in order (each checked with `git apply --check` first), rewrites',
  '   this file, prints the change summary, and runs `npm run typecheck` and `npm run report:test:safety`.',
  '4. Review the result with `git diff` and commit it yourself. The script never commits, pushes or opens a pull request.',
  '5. `npm run upstream:moved` only reports whether the upstream branch has moved past the commit recorded here.',
].join('\n');

/** UPSTREAM.md as written by a sync. */
export function renderManifest({ url, ref, sha, commitDate, licence, syncDate, patches, diff, hashes }) {
  const patchLines = patches.length
    ? patches.map((p) => `  - \`patches/${p.name}\` (sha256 ${p.sha256})`).join('\n')
    : '';
  return `# Upstream: the vendored web-obs globe

\`vendor/web-obs\` holds the files of the 3D site globe that the viewer needs, copied from web-obs. They keep the upstream MIT
licence (copyright Daniel Agrici); the licence text and credit are in \`NOTICE\`. The files themselves carry no added header.
This file is written by \`scripts/sync-upstream.mjs\`; \`scripts/check-vendor-drift.mjs\` checks the folder against the hash table below.

## Source

- Source: ${url}
- Ref: ${ref}
- Commit: ${sha}
- Commit date: ${commitDate}
- Upstream licence: ${licence}
- Synced: ${syncDate}
- Local patches: ${patches.length ? patches.length + ' (applied in this order after copying)' : 'none'}
${patchLines ? patchLines + '\n' : ''}
## Changes versus the previous vendored copy

${summaryLines(diff).map((l) => '- ' + l).join('\n')}

## Vendored files

Each file is a byte-for-byte copy of the upstream path at the commit above${patches.length ? ', with the local patches applied' : ''}.

${hashTable(hashes)}

## How to update

${HOW_TO_UPDATE}
`;
}

/** Tiny argument parser: positional values plus --flag and --name value. */
export function parseArgs(argv, valueFlags) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (valueFlags.includes(name)) {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
        opts[name] = v;
      } else opts[name] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

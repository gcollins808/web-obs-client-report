# Upstream: the vendored web-obs globe

`vendor/web-obs` holds the files of the 3D site globe that the viewer needs, copied from web-obs. They keep the upstream MIT
licence (copyright Daniel Agrici); the licence text and credit are in `NOTICE`. `scripts/check-vendor-drift.mjs` checks the folder
against the hash table below; `scripts/sync-upstream.mjs` rewrites this file when it updates the folder.

## Source

- Source: https://github.com/AgriciDaniel/web-obs
- Ref: main
- Commit: none (mixed baseline: the current copy is NOT a single upstream commit, see below)
- Compare base: 407de3e
- Upstream licence: MIT
- Synced: not synced by the script yet (the baseline below was assembled by hand)
- Local patches: `patches/0001-report-highlight.patch` (report tour highlight: the `highlightIds` prop in `components/SiteGlobeCanvas3D.tsx` and one selector line in `styles/theme.css`). It is local to this project and may be offered upstream later. The patch is written against the vendored copy of those two files (see below), so it may not apply to a different upstream version; refresh it with `git diff` against the new copy. The current vendored files already CONTAIN the patch, so the baseline hashes below include it. `sync-upstream` still refuses to run without `--force-drift` until a real sync has recorded a commit; after that it re-applies `patches/*.patch` (checked first with `git apply --check`) and records them here.

## What the current copy is based on

The vendored copy was put together from several upstream lines. Compared after stripping the 2-line SPDX header that every
vendored file carries (`SPDX-License-Identifier: MIT` plus a "Vendored from web-obs" line) and normalising line endings:

- **14 of the 17 files** are byte-identical to the upstream `main` at `407de3e`: every file in the table below except the three that follow.
- **`data/globeLayout.ts`** matches the fork branch `clusters-lazy-layout` (`96344ff`); the same file is also contained in
  `instanced-rendering` (`2daa83b`) and `translucent-orbs`.
- **`components/SiteGlobeCanvas3D.tsx`** and **`styles/theme.css`** follow the performance-branch line (closest to `perf-3-visual`,
  `b59db12`, with the pill-label helper moved into `data/pillLabel.ts`), plus LOCAL changes for the report tour highlight:
  - the `highlightIds` prop and its use in `SiteGlobeCanvas3D.tsx`;
  - one extra selector line in `theme.css`: `.wo-shell .wo-css2d-layer.is-highlighting .wo-sector-tag,`
- The upstream pull-request commits `e8727b4`, `be85a36` and `b78df83` could not be compared.

Because of this, `upstream-moved` compares against the `Compare base` above (`407de3e` on `main`) until the first real sync records
a full commit. The hashes below are of the files **as they are now**, header included; that is what `check-vendor-drift` verifies.
A normal sync overwrites these files verbatim with the upstream bytes (no header; the licence statement lives in `NOTICE` and here).

## Vendored files

| File (under vendor/web-obs/) | Upstream path | sha256 |
|---|---|---|
| components/MapDiscoveryControls.tsx | src/components/MapDiscoveryControls.tsx | d19516991548fbdcd69be4891769f5df7a1a0d90b8f38d0172809b2655abd54c |
| components/SiteGlobeCanvas3D.tsx | src/components/SiteGlobeCanvas3D.tsx | 4fbba85557a502f38922af61c4a17f2aa5dc24b80c0a63f2e642e41267b22109 |
| components/ViewGizmo3D.tsx | src/components/ViewGizmo3D.tsx | fef8d7f64ebdea7ddd5b7c7fdf22526294b742851ac9b343974c24d02f40f085 |
| components/brandBadge.ts | src/components/brandBadge.ts | c6c687c65d339147408a4baae2ee74a480ca8b50549a6c6fb70e6f9e4faa5f0d |
| components/mapDiscoveryStyles.ts | src/components/mapDiscoveryStyles.ts | 8b9d61e2204e20294b59c2724e06e4cc69154f848913b5789c4e0b5cc8dc77a6 |
| data/brandMark.ts | src/data/brandMark.ts | f952a626607aa6d61f52d7bc5add3c2914b7704a543a11c3207a341e23a7667f |
| data/globeLayout.ts | src/data/globeLayout.ts | ddc36a073a5bce8f114951174bdaa87cf4ce7d736928bb58ef69c75b4dfda5e1 |
| data/linkCoverage.ts | src/data/linkCoverage.ts | 7d17d65d84e4406584dbf5e29b8ed05873546d95126bedeb32f60ac1c81a8dda |
| data/mapAttention.ts | src/data/mapAttention.ts | b28e7ee2c46ee5148ea944a946c0528068a01f17783f8c1fae480da96d6404c0 |
| data/mapDiscovery.ts | src/data/mapDiscovery.ts | e68009c32e3e8d77f89ed2927a0b071803df3cae712b72ccf20d7cdc4ef3ace4 |
| data/pillLabel.ts | src/data/pillLabel.ts | d3422fe711748a66d636c501adae03e59dd2720b71c8e21d8bd7709ebc0248be |
| data/siteAudit.ts | src/data/siteAudit.ts | 8b8cbdd6a7eb94e6124e826adfe8d8f498a8fa01bd61e875a0385cace0fd3e1a |
| data/sitePresentation.ts | src/data/sitePresentation.ts | 51d2db776619af1c8043711203aebc169c96c4bf63f03fee9ba58bb4ff413d46 |
| styles/map.css | src/styles/map.css | 55e0f91f9c06ace68e91364e52725ce1df5b5496fb2b34b01b5545117cdcba9b |
| styles/theme.css | src/styles/theme.css | cb033ac41f33e75e5a42a44c68036ebd64d9c54e8b6372a6de65d6ebb16af82c |
| styles/ui.css | src/styles/ui.css | db06cb3d1d6184722cddcae6a8d520700544d217a1bc00b6a7ccaf8b4ec1133c |
| types/site.ts | src/types/site.ts | db22fdc04337b36fbb19a55d15eda70ff8676c3f565b1fa704a99565d03cf224 |

## How to update

`npm run sync:upstream -- [ref-or-sha] [--url <git url or local path>] [--dry-run] [--force-drift]` (default ref `main`, default url the source above).

1. `npm run check:vendor-drift` first. It fails if a vendored file was edited by hand, or a file is missing or extra. Local changes
   belong in `patches/*.patch` (paths `a/vendor/web-obs/...`), never directly in `vendor/web-obs`.
2. `npm run sync:upstream -- <ref> --dry-run` shows which files would change, without writing anything.
3. `npm run sync:upstream -- <ref>` clones the source read-only into a temporary folder (deleted at the end), copies only the files
   listed below byte for byte from `src/`, applies `patches/*.patch` in order (each checked with `git apply --check` first), rewrites
   this file, prints the change summary, and runs `npm run typecheck` and `npm run report:test:safety`.
4. Review the result with `git diff` and commit it yourself. The script never commits, pushes or opens a pull request.
5. `npm run upstream:moved` only reports whether the upstream branch has moved past the commit recorded here.

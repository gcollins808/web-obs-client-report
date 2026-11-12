# Client report contract

The one file that joins the agency side (capture, Studio, "Export client JSON") to the client side (the report viewer and the
report server). It is `webobs.client-report`, **version 1.x** (the current files are 1.1). A viewer accepts any `1.*`.

The file is written by the Studio export button (or `apps/server/scripts/export-client-report.mjs`), checked, and sealed with a hash.
The checker is `validateClientReport` in `packages/contract/src/package.ts`; the allowlist lives in `packages/contract/src/contract.ts`.

## What may be in the file

Only these top-level fields: `format`, `version`, `meta`, `client`, `feedback`, `labels`, `summary`, `findings`, `glossary`,
`map`, `assets`, `modes`. Any other field makes the checker refuse the file.

- `meta`: `reportId`, `createdAt`, `generator`, `source` (`siteId`, `capturedAt`, `manifestSha256`), `review`, `integrity`.
- `client`: `name`, `domain`, `accent`, `preparedFor`, `presenter`, `logo`, `theme` (hex colours only).
- `feedback`: `to`, `subject`. The report server removes `to` before it sends the file to a browser.
- `findings`, `modes.guided`, `glossary`: the written report, already resolved to plain text. Each statement may carry
  `nodeIds`, the pages it is about, so the viewer can light them on the map.
- `map.site`: the 3D map, trimmed to an allowlist (below).

### The map allowlist

| Part | Fields kept |
|---|---|
| site | `schemaVersion`, `siteId`, `domain`, `brandName`, `origin`, `capturedAt`, `captureStatus`, `stats`, `brandKit`, `sections`, `nodes`, `edges`, `audit` |
| stats | `pagesCrawled`, `orphanPages`, `unlistedPages`, `brokenOrRedirectPages`, `externalDomains`, `externalEdges`, `internalEdges`, `sitemapUrlsTotal`, `sitemapsFound` |
| brandKit | `localLogoAsset` |
| sections | `id`, `label`, `pageCount` |
| nodes (pages) | `id`, `kind`, `health`, `flags`, `title`, `url`, `path`, `section`, `statusCode`, `inSitemap`, `urlDepth`, `clickDepth`, `wordCount`, `inlinksBody`, `inlinksTotal`, `outlinksBody`, `outlinksTotal`, `externalDomainsOut`, `renderUsed` |
| edges | `id`, `source`, `target`, `kind` |
| audit | only `findings[]` with `id`, `category`, `tone`, `title`, `targets[].url`, so the map can light the pages that need attention |

## What is left out, on purpose

Agency notes and talking points, the Explore Pack (a separate file that never leaves the agency), local file paths and vault
paths, page text and meta descriptions, per-page check detail, page snapshots, link anchors, resource lists, link-health
results, robots and sitemap detail, capture warnings, crawl timings and anything about spend or the capture machine.
Keys such as `notes`, `talk`, `obsidianPath`, `rawPath`, `manifest` or `stories` are refused anywhere in the file. Text is
also scanned for local paths, unresolved `{{bindings}}` and promise language.

## Checks that guard the contract

`npm run report:test:package` runs them on every sample capture, including: unknown top-level field refused, a field outside the
map allowlist refused, no capture internals on the map, no notes or paths on a page, tamper detection on the seal, and a
non-hex theme colour refused.

## Honest limits

- Names AND values are checked, at every level (`packages/contract/src/contractValues.ts`, copied into
  `apps/server/ingest/contract-check.mjs`; a test keeps them identical). Unknown nested keys are refused; every value must have
  its type; names are at most 200 characters, titles 300, sentences 2000, addresses 2048; lists are capped (for example 200
  findings, 20 examples, 60 assets); addresses must be `http:` or `https:` with no spaces or control characters; assets must be
  inline png, jpeg, webp or gif images (never SVG); the feedback address must be a plain single email; the whole file is at most
  2 MB. The viewer shows every value as text, and passes images through `safeImageSrc` (`packages/contract/src/safe.ts`).
- The `url` and `title` of every page are in the file, because the map shows them. A link holder can read them.
- A client can read everything in the file they are sent. Put nothing in a report you would not hand them.

## Where the file lives on the server

`reports/<32 random hex>.json`, never a client name, slug or date. The registry entry for its link holds only a link id, the hash of the token, that file
name and the dates (see `apps/server/README.md`). The mapping from a link to a client name exists only in the operator's local index.

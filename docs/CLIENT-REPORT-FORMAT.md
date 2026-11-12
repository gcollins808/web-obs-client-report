# Client Report Package (`webobs.client-report` 1.1) and Explore Pack (`webobs.explore-pack` 1.0)

Two JSON files come out of an export, for two different audiences:

| File | Audience | What it is |
|---|---|---|
| `<domain>.client-report.json` | **the client** | A guided tour over the 3D map: the top five fixes in plain language, then a feedback step that emails the answers to the agency. Client data only. |
| `<domain>.explore-pack.json` | **the agency only** | The whole scrape, every engine finding and page, the held-back findings and your private notes, for picking through in a client meeting. **Never send it.** |

Extends [AgriciDaniel/web-obs](https://github.com/AgriciDaniel/web-obs). The web-obs capture engine and plugin are not part of this repository and are not modified; the only thing taken from web-obs here is the globe component under `vendor/web-obs`.

1.1 removed the old "presentation" mode (a scripted deck). The agency's live-meeting use is now Explore mode.

## Workflow

```
1 Capture   Web-Obs plugin crawls the site           ->  sites/<domain>/_site-graph.json   (existing)
2 Draft     rule-based, no AI                        ->  walkthrough 0.2 (studio)
3 Review    edit wording; pin the top 5; hold back   ->  validator gates
4 Approve   review state Approved, a named person     ->  required to download
5 Export    studio Export tab, or the CLI            ->  client-report.json (send)  +  explore-pack.json (keep)
6 Deliver   host the viewer (static) and share        ->  the client opens the JSON in the viewer
7 Feedback  client answers, adds notes, presses       ->  their mail app opens, addressed to the agency
            "Email my feedback"
8 Meeting   open explore-pack.json in the viewer      ->  browse the full data on the 3D map
```

Export refuses to write a client file unless the walkthrough validates in client mode and the finished JSON passes `validateClientReport`.

## Where the content comes from (and what is judgment)

1. **The scrape** (`_site-graph.json`): the engine's 46-ish findings with page lists and counts, plus raw fields. All figures come from here via bindings.
2. **A hand-written catalog** (`draft.ts`): groups engine findings into plain-language topics and sets each topic's **severity, effort and owner by hand**, each with a written reason. The engine itself does not rate severity; its only signal is a tone (review / attention / coverage). So severity is a stated judgment, not data.
3. **Plain-language text** (`plain.ts`): the meaning, comparison and "your part" lines. Written by us; not yet reviewed by an SEO professional. No figures in it; "if it stays" lines are general practice with a stated basis, not a measured effect.

Rule behind this: no invented outcomes. Figures are bound to the capture; opinions are labelled "Our view" with a basis; nothing promises traffic or revenue.

## Ranking (the top five)

Priority level first, then **distinct pages affected**. A site-wide issue counts as every page. Item counts are deliberately not used (190 near-duplicate matches are pairs of pages, not 190 pages), and there is no volume or "attention" bonus. Held-back issues sink below everything. The studio lets you pin and reorder the five; unverified findings cannot be pinned. The rule is stated in the file (`modes.guided.top.basis`) and shown to the client.

## Client report shape

```
format, version                  "webobs.client-report", "1.1"
meta        reportId, createdAt, generator, source{siteId,capturedAt,manifestSha256}, review{state,reviewedBy}, integrity{sha256}
client      name, domain, preparedFor?, presenter?, accent?, logo?
feedback?   { to, subject }   where the client's email goes. Set by the agency; absent = copy/download only. Never assumed.
labels, summary
findings[]  id, title, categories[] (engine areas), severity/effort/owner (+basis), horizon, observed[], implications[] (INFER + basis),
            fix[], verify, examples[], evidence?, glossary[], spotlight { kind:'pages', nodeIds, pageCount, filter } | { kind:'sitewide' }
glossary[]  only terms used
map?        { site }: the capture trimmed to what the globe draws (client pages only; no vault paths)
assets      inline image data URIs
styles      optional look for this report (flat, allow-listed slots, see docs/STYLES.md); checked at upload and again at serve
modes.guided  steps[] welcome | orientation | map | finding | plan | limits | decisions | send
              tour[]  step ids in order (ends with "send"), more[] the remaining findings, top { findingIds, picked, basis }
```

A guided **finding** step: what we found -> what it means (plain words + a comparison) -> if it stays as it is (opinion + basis) -> what is yours to do -> how it usually gets fixed / questions for your team -> glossary chips -> a checkpoint and an optional note.

## Feedback email

The last tour step shows exactly what will be sent (their answers, notes, optional name) and offers **Email my feedback**, **Copy as text** and **Download (.json)**.

- It is a `mailto:` link: it opens the client's own mail app, addressed to `feedback.to`; nothing is sent until they press send there. No server, no third party, nothing leaves their device otherwise.
- Long messages are shortened inside the link (limit 1,900 characters; some mail apps cut off sooner) and the full text stays available through Copy/Download.
- Special characters are encoded, and the address is validated, so a name or note cannot add recipients or headers.
- Needs a mail app configured on their device. Where there is none, Copy / Download still work.
- Set the address in the studio (Brand & review tab) or with `--feedback-to`.
- Answers are saved in the browser (localStorage) per report, so a reload keeps them.

## Explore pack

`webobs.explore-pack` 1.0, `audience: "agency-only"`: `stories[]` (all topics, including held-back with `dispositionNote`), `notes`, `ranking`, and `capture` (the whole scrape without `obsidianPath`, `rawPath` or `captureProvenance`). Open it in the viewer (it detects the format). **Client-safe view** is on by default: held-back topics and your notes are hidden until you switch on **Private view** (key `P`), so a screen-share stays safe. You can browse by topic, all engine findings by area, or search pages; each opens detail, flies the globe to the affected pages, and can be added to a **show list** (kept on your computer) to build your talking order.

## Gates

`validateClientReport` rejects: not approved - any forbidden key (`talk`, `notes`, `dispositionNote`, `obsidianPath`, `rawPath`, `targetUrl`, `anchor`, `manifest`, `capture`, `stories`) - unresolved bindings - local paths - promise language - observed claims without sources, `INFER` without basis - findings missing from the tour - a tour that does not end with the feedback step or has more than five findings - no ranking basis - spotlight pages not on the map - vault paths or `captureProvenance` in the globe data - hand-typed figures in explanatory prose - a bad or injectable feedback address or subject - non-image assets - an explore pack passed off as a report. `validateExplorePack` rejects a non-agency-only file or vault paths in the capture. `npm run report:test:package` runs about 50 checks per capture on every site in the vault, including these tamper cases.

## Viewer

`apps/viewer/src/components/PackageViewer.tsx` (tour) and `ExploreViewer.tsx` (agency), on the existing 3D globe, unmodified. Open `report.html?report=<same-origin url>` or `#view` and choose a file; a built file can set `<html data-start="viewer">` to open as the viewer. A plain double-click on a studio build opens the studio, which also recognises a dropped report or explore pack. `client-app/index.html` is a lite fallback (no 3D) for printing and old devices.

**Globe limitation:** the unmodified globe can only dim by its own filters. The camera flies to the affected region, and a filter is used only when at least 80% of the finding's pages fit it; otherwise everything stays lit and the card says how many pages are affected.

## Commands

```bash
npm run report:export-json -- <site>/_site-graph.json --out ./out --approve-as "Reviewer" --feedback-to you@agency.com
#   optional: --walkthrough saved.json  --presenter "X"  --prepared-for "Y"  --accent "#1a56db"  --no-map
npm run report:test:package
npm run report:build && npm run report:serve      # http://localhost:4176
```

`--approve-as` is for unreviewed drafts only; a walkthrough saved from the studio carries its own approval.

## Known gaps

1. The plain-language wording and the severity rules are ours and have not been reviewed by an SEO professional or tried on a real client. The five test exports are stamped "UNREVIEWED test export".
2. Mail: `mailto:` depends on a configured mail app and cannot confirm delivery. A form service or a small worker on your own domain would remove both limits at the cost of hosting something.
3. Checked in headless Chrome (software rendering) on desktop and at 500 px width; not on a real phone or with a screen reader.
4. Package size: about 1.1 MB for a 70-page site, about 2 MB at 2,000 pages. The explore pack is larger (2.7 MB for the 70-page site). The globe's own render lag on 2k+ page sites (perf work on other branches) is not in this copy.
5. No passphrase encryption on the JSON files (the older single-file HTML export still has it). The integrity hash catches accidental edits only.
6. Explore mode has no speaker timer, no second-window sync and no notes editing; notes are the ones written in the studio's Deck tab.
7. Severity for sitewide topics is based on single lab loads of a few sampled pages; the file says so but cannot fix that.

## Configuration (.env files)

Settings come from env files, not source code. Copy `.env.example` to `.env` (git-ignored) and edit:

| Variable | Meaning |
|---|---|
| `WEBOBS_FEEDBACK_TO` | Default address for client feedback (the last tour step). |
| `WEBOBS_FEEDBACK_SUBJECT` | Optional subject template; `{client}` becomes the client's name. |

- **CLI** (`npm run report:export-json`) reads `.env.local` then `.env`. **Order of precedence:** `--feedback-to` flag, then an address set for that report (studio Brand tab, or inside a saved walkthrough), then a real environment variable, then the `.env` file. An invalid address stops the export.
- **Studio** (`npm run report:build`) bakes `WEBOBS_*` values into the app at build time (`apps/viewer/vite.report.config.ts`: `envDir` = project root, `envPrefix` includes `WEBOBS_`). Rebuild after changing `.env`. The Brand tab placeholder shows the default, and a per-report address overrides it.
- **Not secret:** anything in `WEBOBS_*` ends up in the built app and in exported client files. Keep API keys and passwords out of it.
- **Adding an integration later:** put its non-secret setting in `.env.example` with a `WEBOBS_` name, declare it in `apps/viewer/src/env.d.ts`, read it in `buildClientReport` through `BuildOptions` (the package builder stays pure and never reads the environment itself), and put the resolved value in the package. A feedback channel other than email (for example a webhook) would be a new field next to `feedback.to`, validated in `validateClientReport`.

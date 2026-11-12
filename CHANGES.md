# Changes by version (v0.1.7 on top of v0.1.6, v0.1.5, v0.1.4, v0.1.3 and v0.1.2)

Released versions are not overwritten. Newest first. Finding ids (VULN-001, SEC-001, LOGIC-001, IAC-001, DEP-001) refer to the security review of the first 0.1.2 candidate.

## v0.1.7: the card as drawn

The v0.1.6 image is not changed; 0.1.7 fixes the findings of a second review of 0.1.6.

| Change | Files | Test |
|---|---|---|
| **Translucent cards (Low).** The tour card, the bar body and the help card are the card color at 82 to 90 percent over the stage, so a light card was about 10 percent darker on screen than the checked color. Cards are drawn opaque when any text color on them (card text, muted text, links, second color) is darker than the card; light text on a dark or mid-tone card keeps the glass look. | `apps/viewer/brand/styles.mjs` | `test-cardtext.mjs` (the card as drawn, for nine looks), `e2e-styles.mjs` |
| **Muted label chip (Low).** Fetched, Raw and Lab read 3.3 to 4.1:1. They get their own text color (`--rp-card-label-fg`, read as `--label-fg` inside cards only). | `styles.mjs`, `styles.css`, `viewer.css` | `test-cardtext.mjs`, `e2e-styles.mjs` (asserted, no exemption) |
| **Built-in colors on a light or red card.** A card color without a muted text, second color or link/accent left the built-in ones at 2.4 to 2.8:1 on a red card. They are nudged toward the card text on a card that is not dark (a dark card is unchanged). | `styles.mjs` | `test-cardtext.mjs` |
| **Documented (Low):** a mid-tone card that needs dark text gets grey severity chips (last resort). | `docs/STYLES.md` | |
| **Measurement.** The browser test adds links, the second color, the muted text and the muted label chips (Fetched, Lab) to the chips and boxes it measured, for a light card, a red card and the default dark look; the Fetched exemption is gone. | `apps/server/e2e-styles.mjs` | |
| Version 0.1.7: `package.json`, the lockfile, `deploy/Dockerfile`, the stack files, the README, the release notes. | | `npm test` |

Not measured in the browser: the bar body and the help card (they share the glass color of the bar; the unit test covers that color).

## v0.1.6: text on cards, with the review fixes

0.1.6 adds the text-on-cards change (next section) plus these review fixes:

| Change | Files | Test |
|---|---|---|
| **Severity chips, warning chips and warning boxes on a card (Medium).** They use fixed pastel pairs made for the default dark card. When those do not read on the look's card, the card gets its own pairs (`--rp-card-sev-*`, `--rp-card-warn-*`): a light card keeps the tints and pushes the text toward the card text, a red or other mid-tone card gets a darker chip background, and as a last resort the chip is the card itself, so it reads whenever the card text does. A light card also gets dark-on-light `--rp-card-line` and `--rp-card-chip`. The four pairs are added to the checks. The viewer stylesheet defaults these to the page values and cards read them. | `apps/viewer/brand/styles.mjs`, `styles.css`, `viewer.css` | `test-cardtext.mjs` (37), `e2e-styles.mjs` (contrast of each chip, the warning chip, the warning box and the caveat inside a card, for a light card, a red card and the default look, in a real browser) |
| **Messages name the right slot (Low).** Each check now carries the slot to blame, and every message is built from the failing check itself: the slot, the two colors compared and that pair's ratio. Before, a `cardMuted` message could use the ratio of another pair. | `apps/viewer/brand/styles.mjs` | `test-cardtext.mjs` (a grid of about 700 looks: every message's ratio is the real contrast of the two colors it names) |
| **Docs (Low):** the claim that existing looks keep working is corrected: a stored light-card look has been dropped to neutral at serve since 0.1.5. | `docs/STYLES.md`, `docs/RELEASE-NOTES.md`, `CHANGES.md` | n/a |
| **Info:** `readabilityProblems` takes validated input (stated in its comment); an older ingest refuses the new slots and an older viewer drops the whole look (already in the notes). | `apps/viewer/brand/styles.mjs` | n/a |

## v0.1.6: text on cards (the change itself)

| Change | Files | Test |
|---|---|---|
| **Two optional color slots, `cardText` and `cardMuted`.** In `deriveStyleOutput`, `hasCard = Boolean(s.cardText)`. With NO cardText every line takes the old path (same formulas, same output). With cardText: the page text is nudged against the stage only; the card text is used as given, and `--rp-card-ink` / `--rp-card-muted` are written; links and the second color are checked against the card; the card edge uses the card text. | `apps/viewer/brand/styles.mjs` | `apps/server/test-cardtext.mjs` (30), golden comparison with 0.1.5 |
| **Readability messages name the colors and the numbers**, with a suggestion: new `suggestCardText(surface)` (white or near-black, whichever reads better; says when neither reaches 4.5:1). When the card text itself fails, the derived muted, link and second-color failures are not repeated. Nudge notes include the ratios and the color the page uses. | `apps/viewer/brand/styles.mjs` | `test-cardtext.mjs` |
| **Contract copies:** `cardText` and `cardMuted` in the two value specs (the ingest check and the contract values). The ingest and the server use the shared validator, so upload 422 (reason `styles-unreadable`) and serve (look dropped) apply to them too. | `apps/server/ingest/contract-check.mjs`, `packages/contract/src/contractValues.ts` | `test-cardtext.mjs`, `ingest/test-styles.mjs` |
| **Viewer stylesheet:** `--rp-card-ink` / `--rp-card-muted` default to the page values (dark and light themes), and cards redefine `--ink` / `--muted` from them. Without a look they are equal, so nothing changes. | `apps/viewer/src/styles.css`, `viewer.css` | `test-cardtext.mjs`, `e2e-styles.mjs` (real browser: light card with dark text, red card unchanged) |
| Version 0.1.6; docs (STYLES.md, release notes). | `package.json`, `deploy/*`, `docs/*` | `npm test` |

## v0.1.5: review fixes from the 0.1.4 code review

| Change | Files | Test |
|---|---|---|
| **LOGIC-001 (Medium): unreadable looks are refused.** The shared validator now also checks readability after the page's own nudging (`readabilityProblems`): a look whose text, muted, link or second colour cannot reach 4.5:1 (in practice a card that is too light for the light page text) fails with code `unreadable` and a message naming the slot. Upload 422 (`styles-unreadable`), serve drops the look and logs `styles-unreadable`, `check-styles.mjs` exits 1. Nudging stays for fixable cases; accent on the stage and card edges stay advisory. | `apps/viewer/brand/styles.mjs`, `apps/server/server.mjs`, `styles-inject.mjs`, `ingest/envelope.mjs` | `apps/server/test-readability.mjs` (20) |
| **LOGIC-003 (Low): link fallback.** `var(--rp-link, var(--rp-accent))` so back and skip links keep a colour when a look sets neither. | `apps/viewer/src/viewer.css` | `test-readability.mjs` |
| **IAC-001 (Low): docs.** One Portainer stack with both services: one redeploy. Separate stacks: viewer first, then ingest. Do not roll back below 0.1.4 while styled links are live. | `README.md`, `docs/SETUP.md`, `docs/RELEASE-NOTES.md`, `docs/STYLES.md` | n/a |
| **Seal.** `sealReport` hashes the report without `styles`, so the seal survives the two-part upload (it did not: the data part is sent without the look and the merge changes key order). Nothing verifies the seal in production code; documented. | `packages/contract/src/package.ts` | `test-readability.mjs` |
| **Agency name counted one way.** The contract copies allowed 80 UTF-16 units while the validator allowed 80 characters; they now allow twice the characters in units and the validator is the authority. | `ingest/contract-check.mjs`, `packages/contract/src/contractValues.ts` | `test-readability.mjs` |
| **Agency-name allow-list:** not built, documented as a possible later control. | `docs/STYLES.md`, `docs/INGEST-SECURITY.md` | n/a |

## v0.1.5: click a page on the map

| Change | Files | Test |
|---|---|---|
| **Page card.** Clicking a page on the map opens a small card: the page, its path, the findings that touch it, **Jump to this step** (when a tour step covers the page) and **Back to tour**. Focus moves to the card, Escape closes it, the buttons are labelled, and on a phone it is a bottom sheet. The 3D map, the stage background and the render palette are untouched. | `apps/viewer/src/lib/pageCard.ts` (new), `apps/viewer/src/components/GlobeStage.tsx` (reports the click), `PackageViewer.tsx`, `viewer.css` | `apps/viewer/test-pagecard.mjs` (6), `apps/server/e2e-pagecard.mjs` (real browser, 14) |
| Version 0.1.5 (package, Dockerfile, stack files, release notes). | `package.json`, `deploy/*` | `npm test` |

## v0.1.4: a report carries its own look

| Change | Files | Test |
|---|---|---|
| **Shared pure styles module:** flat key allow-list (`accent, secondary, link, text, muted, surface, headingFont, bodyFont, headingCase, name, footerText`), validated values, fresh output object, contrast nudging, generated CSS lines, a guard on the finished CSS, safe JSON for the data block, the pairing hash (first 12 hex of the SHA-256 of the fixed text form). Never throws. The colour helpers moved to `color.mjs` (the build-time brand loader re-exports them). | `apps/viewer/brand/styles.mjs`, `styles-hash.mjs`, `color.mjs`, `styles.d.mts`, `load-brand.mjs` | `apps/viewer/brand/test-styles.mjs` (23 checks: hostile-value table against every slot, whole-file rejection, `__proto__`, size cap, never-throw inputs, reserved stage/render, escaping, CSS guard, hash) |
| **One envelope request with two named parts** `styles_<hash>` and `data_<hash>`; the ingest recomputes the hash, refuses mismatch, duplicate names (counted in the raw text), a missing or third part, a data part that already carries styles; checks both parts; stores ONE file (the report with the checked look inside); audit line `styles=<hash>`, reason codes. Bare reports unchanged. | `apps/server/ingest/envelope.mjs`, `ingest.mjs` | `apps/server/ingest/test-styles.mjs` |
| **`styles` is an optional report field** (three copies of the field list and the value spec: the contract, the ingest's checker, the publish tool's checker); the ingest's checker also runs the shared validator. | `packages/contract/src/contract.ts`, `contractValues.ts`, `package.ts`, `apps/server/ingest/contract-check.mjs`, `apps/server/scripts/lib/publish-core.mjs` | existing contract tests (field lists and value specs equal) and the new tests |
| **Serve-time injection:** the viewer server re-validates the look and writes a generated style, the title and a JSON block into the first bytes of the page (one marker right after the title, function-based splicing, a build style block is replaced); invalid look: dropped, neutral page, reason code logged (one line per code per minute, 30 a minute); the injector cannot break a page; `report.json` no longer carries the look; Content-Length from the bytes; no ETag or conditional handling. Fonts: only the files bundled with the server, by name, checked for size and the `wOF2` marker. | `apps/server/server.mjs`, `styles-inject.mjs`, `apps/server/fonts/` (Oswald, Inter, notices, sources), `apps/viewer/vite.report.config.ts` (the marker) | `apps/server/test-styles-serve.mjs` (42 checks: headers and exact CSP identical with and without a look, byte-identical refusals, no look on refusal pages, non-ASCII title, throwing injector, marker missing/twice/apart, bad fonts, build brand replaced) |
| **The page reads the look from the data block** (checked again in the page; a missing or empty block uses the build brand), holds its first draw for the look's fonts (cap about 1.5 s), `font-display: block`. | `apps/viewer/src/lib/brand.ts`, `main.tsx` | `apps/server/e2e-styles.mjs` (real browser: nothing changes after the card first appears, fonts ready, no policy violations, phone-width header) |
| **Header agency name removed:** the header shows the client name and the client's own logo only; the agency is named once, in the footer. No `headerText` slot exists; the build-time brand's `attribution.header_text` is accepted and ignored. | `PackageViewer.tsx`, `viewer.css`, `apps/viewer/brand/README.md` | `e2e-styles.mjs` (no agency element, header holds the client name) |
| **Tools and Studio:** `check-styles.mjs` (in the image), `make-envelope.mjs`, `export-client-report.mjs --styles`; the https publish wraps a report's look in the envelope and a bad look never leaves the machine; Studio: **Look (styles file)** picker on Brand & review. | `apps/server/tools/`, `apps/server/scripts/`, `apps/viewer/src/components/Admin.tsx` | `ingest/test-styles.mjs` (publish section) |
| **Image:** the shared modules sit at `/viewer/brand/` so the same relative import works in the repository and in the image; fonts at `/app/fonts`; version 0.1.4 everywhere; `FONTS_DIR` documented in `.env.example`. | `deploy/Dockerfile`, stack files, `.env.example`, `docs/` | container smokes |
| **Older server:** when a report with a look is sent to a server older than 0.1.4 (which refuses the two-part request), the publish tool says so plainly and tells you to update the server first; a plain report keeps the ordinary messages. **Docs:** deploy order (server and ingest first, then the tools) in the release notes and SETUP; how to add a font; later items (Studio preview of a look, more fonts, removing the build-time brand folder). | `apps/server/scripts/lib/publish-https.mjs`, `docs/RELEASE-NOTES.md`, `docs/SETUP.md`, `docs/STYLES.md` | `apps/server/ingest/test-styles.mjs` |

Not changed: the stage background and render palette (reserved), the CSP and all security headers, the uniform refusal, the registry, retention, cleanup and revoke.

## v0.1.3: card colour

| Change | Files | Test |
|---|---|---|
| **Optional `colors.surface`** in `brand.json`: the card and panel background (an expansion of the home contract's colours). Without it `grey_2`, then a derived grey. `grey_0`/`grey_1` stay reserved; the stage background and 3D render are untouched. | `apps/viewer/brand/load-brand.mjs`, `brand.example.json`, `apps/viewer/brand/README.md` | `apps/viewer/brand/test-brand.mjs` (surface colours cards only; never the stage; a bad value is refused) |
| **Card edge line:** a new variable `--rp-card-edge` (text colour at 28 percent) used as the border of branded cards, panels, help cards and notes. The build checks the edge against the card and against the page (1.5:1 or more). Example with `#101010` cards: edge 1.89:1 against the card and 1.84:1 against the page; text 10.91:1, muted 4.56:1, links 7.54:1, second colour 10.12:1. | `apps/viewer/brand/load-brand.mjs`, `apps/viewer/src/viewer.css` | `apps/viewer/brand/test-brand.mjs` ("a dark card still reads") |
| **Version 0.1.3:** package, lock file, Dockerfile `VERSION`, every stack file and `docker-compose.yml`, README and SETUP image lines, release notes. | `package.json`, `package-lock.json`, `deploy/*`, `README.md`, `docs/SETUP.md`, `docs/RELEASE-NOTES.md` | image labels checked in the container smokes |

Servers, contract and ingest are unchanged from 0.1.2.

## v0.1.2: look and feel, and the single refusal line

| Change | Files | Test |
|---|---|---|
| **Reserved for visibility.** The page and 3D stage background is always the original dark `#07090f`, in every build (with or without a brand) and on every screen, including the loading and error screens and the server's refusal page (it was `#10131a`). A brand cannot change it: `grey_0` and `grey_1` in `brand.json` stay valid contract keys but are ignored with one plain build message; `grey_1` is no longer required; the reserved greys are not even exposed as brand variables. A report's own `client.theme` background is ignored for the stage. The 3D render (globe, dots, center dot, palette) is out of reach of a brand. | `apps/viewer/brand/load-brand.mjs` (`RESERVED_COLOR_KEYS`, `STAGE_BG`), `apps/viewer/src/components/PackageViewer.tsx`, `apps/viewer/src/viewer.css`, `apps/server/server.mjs` (refusal page colour) | `apps/viewer/brand/test-brand.mjs` (the fixed background, the reserved keys, nothing reaches the render, built pages carry the same stage rule with and without a brand; a brand that sets `--bg` fails it) and `packages/contract/tests/viewer-safety.test.mjs` |
| **Cards and panels stay branded** with their own variables (`--rp-card-solid`, `--rp-card-glass`) instead of being derived from the page colour; contrast is checked against the ORIGINAL background and the card colour (text, muted text, links, accent, text on buttons, the second colour); faint colours are nudged and reported. | `apps/viewer/src/viewer.css`, `apps/viewer/brand/load-brand.mjs` | `apps/viewer/brand/test-brand.mjs` ("every pair that matters ...") |
| **One line for every failure on the viewer:** "This link is not available. Please request a fresh one." replaces the plain "Access denied" panel for a wrong, expired or revoked link, a report that cannot be fetched or read, a newer format, a wrong shape, a network failure and an error while drawing. The server's refusal PAGE carries the same line with the same background; the server's data routes still answer the plain `Access denied` and the audit log reasons (ids only) are unchanged. The panel is a plain solid box. | `apps/viewer/src/main.tsx` (`UNAVAILABLE`), `apps/viewer/src/viewer.css`, `apps/server/server.mjs` | `apps/server/e2e.mjs` (real browser: six failure kinds give identical text and identical page), `apps/server/test.mjs`, `test-hardening.mjs`, `test-tunnel-path.mjs`, `scripts/e2e-studio.mjs`, `tools/docker-smoke.mjs`, `tools/docker-smoke-full.mjs` |
| **Phone layout:** the map help button sits above the tour sheet instead of over its Back button on phone and tablet widths. | `apps/viewer/src/viewer.css` | seen in the real-browser screenshots at 390 and 768 pixels |
| **Release notes corrected:** 0.1.2 changes the servers (`server.mjs`, `ingest/ingest.mjs`, `ingest/contract-check.mjs`) and the Dockerfile; the older sections say that a switched-off ingest exited 0 in those versions and idles from 0.1.2. | `docs/RELEASE-NOTES.md`, `docs/FEATURES.md`, `apps/viewer/brand/README.md` | |

## v0.1.2: the ingest idles when off, and the client-data check

### A switched-off ingest idles instead of exiting (follows from the restart-policy change in VULN-001)

With `restart: unless-stopped`, an ingest that exited 0 because `INGEST_ENABLED` is not 1 would have been restarted every few seconds. Now it keeps running.

| Change | Files | Test |
|---|---|---|
| `createIdleServer()`: a server that answers 503 "The ingest is switched off." to every request (health paths and uploads included), reads no body, stores nothing, needs no secret, answers a plain 400 to malformed HTTP. The start-up code uses it when `INGEST_ENABLED` is not 1, prints one log line (`ingest is switched off (INGEST_ENABLED is not 1); idling on port N ...`) and does not exit; SIGTERM and SIGINT close it and exit 0 so `docker stop` is prompt. The set-up notes say "this process idles (503 on its port) instead of exiting". | `apps/server/ingest/ingest.mjs` | `apps/server/ingest/test.mjs`: the real process, started switched off (and with `INGEST_ENABLED=0` plus a secret), keeps running for more than a second, answers 503 on the health path and on an upload, prints the line, never prints the secret. The same check in `apps/server/tools/docker-smoke.mjs` and `docker-smoke-full.mjs` (inside the images). Both fail when the process is made to exit 0 again ("it exited with 0"). |
| The health check is unchanged and now reports the truth: the stack's check requires an OK answer, an idle ingest answers 503, so Docker shows it as running and `unhealthy` on purpose while the log line says it is switched off. | stack files (comments only) | covered by the 503 assertions above |
| Stack headers, compose comment, README, SETUP, INGEST-SECURITY and the server README say so (the old "Exited (0)" text is gone). | `deploy/VPS-STACK-tunnel-both.yml`, `deploy/VPS-STACK-tunnel-both-bindmount.yml`, `deploy/docker-compose.yml`, `README.md`, `docs/SETUP.md`, `docs/INGEST-SECURITY.md`, `apps/server/README.md` | |

A misconfigured ingest (switched on with a short secret, missing Access names and so on) still exits 1 with a plain reason, so Docker keeps restarting it and the reason stays visible.

### The client-data check is no longer read from a repository secret

| Change | Files | Test |
|---|---|---|
| The CI step that wrote a list from a repository secret is removed, and so is the CI step that ran the check. The check is not part of `npm test` or CI any more (CI has no list and would fail closed). It runs locally before each commit with `npm run check:client-data`, and still fails with a plain message when the list is missing. Why: anyone with write access to the repository can read its secrets through a workflow, so client names must not live there. | `.github/workflows/ci.yml`, `package.json` (the check is out of the `test` chain; `check:client-data` stays), `scripts/check-no-client-data.mjs` (comment), `README.md`, `docs/FEATURES.md`, `docs/RELEASE-NOTES.md` | `scripts/test-check-no-client-data.mjs` (still in `npm test`; it needs no list). `npm test` passes without any list present. |

No file or workflow refers to a repository secret for the list any more (searched).

## v0.1.2: fixes from the security review

These are the fixes from the security review of the first 0.1.2 candidate.

### VULN-001: the servers keep serving through a bad request

| Change | Files | Test |
|---|---|---|
| Each request handler is wrapped: any unexpected error ends that one request with a plain 500 (and the connection is destroyed if headers were already sent); nothing leaks and no process-level handler hides errors. | `apps/server/server.mjs` (`handle`, wrapper), `apps/server/ingest/ingest.mjs` (same) | `apps/server/test-hardening-2.mjs`: "an unexpected error inside a handler ends that request with a plain answer ... nothing leaks" |
| `new URL(req.url, ...)` is guarded: an address such as `//[`, `//%`, `//%zz` gets the uniform refusal (viewer: the page or data refusal; ingest: `wrong-route`). | both servers | "an address that cannot be read as a URL ..." (both servers, raw sockets) |
| The two `for await (const chunk of req)` body loops are wrapped: a client that drops the connection mid-body ends quietly (ingest records `aborted`). | both servers | "a client that drops the connection mid-body ..." (viewer feedback and ingest upload; no unhandled error escapes) |
| `site.audit.findings` in the contract checker is read only when it is a list; the serve-time re-check and the upload check are also wrapped, so a check that cannot run is a refusal. | `apps/server/ingest/contract-check.mjs`, both servers | "a findings entry that is not a list does not crash the checker, on upload or when serving" |
| A missing `report.html` gives a plain 500 for the page route (data routes keep working). | `apps/server/server.mjs` | "a missing page file gives a plain 500 ..." |
| `server.on('clientError')` answers a plain 400 and closes the connection. | both servers | "a request that is not valid HTTP gets a plain 400 ..." |
| Ingest restart policy `on-failure:5` becomes `unless-stopped`. The stack header says what that means when the ingest is switched off. | `deploy/VPS-STACK-tunnel-both.yml`, `...-both-bindmount.yml`, `deploy/docker-compose.yml` | `apps/server/test.mjs` stack assertions |

The new test file has a 90 second watchdog and listens for `unhandledRejection` and `uncaughtException`. Against the previous tree's servers it fails ("unhandledRejection: Invalid URL").

### SEC-001: client names out of the repository

| Change | Files | Test |
|---|---|---|
| Client names are no longer in the script. The check reads a local, git-ignored list (`.client-names`, or the file named by `WEBOBS_CLIENT_NAMES_FILE`) and FAILS with a plain message if the list is missing, empty or invalid. | `scripts/check-no-client-data.mjs`, `.gitignore`, `deploy/Dockerfile.dockerignore` | `scripts/test-check-no-client-data.mjs` (6 checks: no list in the script, missing list fails, empty fails, invalid pattern fails, a match fails and prints the file but not the name, a clean folder passes) |
| In CI the list was first read from a repository secret; that was dropped again (see "The client-data check is no longer read from a repository secret" above). | `.github/workflows/ci.yml` (later removed) | none (workflow) |
| Documented. | `README.md` ("Developing"), `docs/FEATURES.md` | |

### LOGIC-001: a real server-side revoke for ingest links

| Change | Files | Test |
|---|---|---|
| `POST /ingest/v1/links/<id>/revoke` (10 hex characters), behind the same locks as an upload (HTTPS signal, Access JWT, secret, own rate limit), only for an existing entry, atomic write, audit line with the id only. A bad id or the wrong method gets the uniform refusal; an unknown id answers `No such link.` to an authorised caller only. | `apps/server/ingest/ingest.mjs` (`REVOKE_ROUTE`, `revokeLink`) | `apps/server/test-hardening-2.mjs` (revoke, refusals, audit line) |
| `revokeHttps` (the client call), `recordLink` (the local index entry for https links), `revokeAny`, the links list for an https target (from the local index), "extend" is refused with a plain message for ingest links, the helper route `/links/revoke` uses `revokeAny`, and the helper passes its environment to publish. | `apps/server/scripts/lib/publish-https.mjs`, `publish-core.mjs`, `links-core.mjs`, `apps/server/scripts/publish-helper.mjs` | `apps/server/test-revoke-https.mjs` (publish through the helper, listed, revoked from the Studio route, refusals, unknown id) |
| Emergency steps (delete the registry file named by the link id; open the link to confirm "Access denied"). | `docs/SETUP.md` ("Revoking a link"), `README.md` | |
| A test that published to an https target now writes its index to a temporary file. | `apps/server/ingest/test.mjs` | |

### IAC-001: cleanup service and a capped audit log

| Change | Files | Test |
|---|---|---|
| A `cleanup` service (daily, data read-write, no network, read-only root, no capabilities) in both main stack files, with the header saying it is required (or use a scheduled task). | `deploy/VPS-STACK-tunnel-both.yml`, `deploy/VPS-STACK-tunnel-both-bindmount.yml` | `apps/server/test.mjs` (both stacks) |
| Size-based rotation of the ingest audit log inside `audit()`: at `INGEST_AUDIT_MAX_BYTES` (default 1048576) the file shifts to `.1`, up to `INGEST_AUDIT_KEEP` (default 3, at most 20) old files stay in the same folder; the total is bounded. Variable names added to the stack files, compose file and `.env.example`. | `apps/server/ingest/ingest.mjs`, `deploy/*.yml`, `.env.example` | `apps/server/test-hardening-2.mjs` ("the audit log is capped") and `apps/server/tools/check-env.mjs` |
| Documented. | `docs/SETUP.md` ("The audit log is capped") | |

### DEP-001: pinned base image

`deploy/Dockerfile` names `node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8` in both stages (pulled and resolved on 2026-11-08; the plain `node:24-alpine` tag named the same digest then). How to bump it: `docs/SETUP.md` ("Updating the base image"). Not covered by a test (a build-time property).

### Also changed

`docs/RELEASE-NOTES.md`, `docs/FEATURES.md`, `docs/SETUP.md` (image tag in the examples), `package.json` (the new tests in `npm test`).

### Decisions to be aware of

1. (Superseded, see above.) With `unless-stopped`, an ingest that exited 0 when switched off would have been restarted in a loop; a switched-off ingest now idles instead.
2. (Superseded, see above.) CI no longer reads any repository secret; the client-data check runs locally before each commit.
3. Listed, not changed (Low): the local publish helper's own request-body loops (`readJson` and the publish route) are not wrapped like the servers' (a local-only tool); the ingest's store cap is checked per request (concurrent uploads could pass it by a few); after a rotation the VPS doctor reads only the current log file.

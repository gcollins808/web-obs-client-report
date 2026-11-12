# Release notes

## v0.1.7 (beta): the card as drawn

New image tag `v0.1.7`; `v0.1.6` is not overwritten. It changes the shared styles validator and the viewer stylesheet (the plugin's checked copy changes with it), and nothing else: no contract change, no new slot, same deploy order and rollback as 0.1.6.

- **Light cards read as checked.** The cards were drawn slightly transparent over the dark page, so a light card was about 10 percent darker on screen than the color that was checked: links, the second color and the card's muted text that passed at 4.5 to 4.7:1 read about 3.7 to 3.8:1. Cards are now drawn opaque whenever a text color on them is darker than the card; dark and mid-tone cards with light text keep the glass look.
- **The muted label chips (Fetched, Raw, Lab) read.** They had 3.3 to 4.1:1 on some looks. They now get their own readable text color (`--rp-card-label-fg`).
- **Built-in colors on a light or red card.** A look that sets only a card color no longer leaves the built-in muted text, second color or link at about 2.4 to 4.5:1 on it; they are nudged toward the card text. Dark cards are unchanged.
- Documented: a mid-tone card that needs dark text shows grey severity chips (last resort, they still read).
- The browser test now asserts every one of these (links, second color, muted text, label chips) for a light card, a red card and the default dark look.

## v0.1.6 (beta): text on cards

New image tag `v0.1.6`; `v0.1.5` is not overwritten. It changes the shared styles validator, the viewer stylesheet, the ingest check and the contract (two new optional slots), so deploy the image for both the viewer and the ingest, as always. Looks with a dark card render exactly as before. One thing is not "as before": since 0.1.5 a stored look whose card color cannot be read with the page text (for example a light card without `cardText`) is no longer applied, and the report shows the neutral look; add `cardText` to bring it back.

- **A look can set the text on its cards** (`cardText`, optional `cardMuted`). A light card with dark text now works; before, the single text color was lightened for the dark page and then could not be read on a light card (a look was refused as "1.07:1").
- **Messages name the colors and the numbers.** An unreadable card text is refused with both colors, the ratio, and a suggestion (light or dark text, for example `#ffffff (5.0:1)`); the notes about adjusted colors say what the page uses instead.
- **Old looks with a dark card are unchanged.** With no `cardText` the page variables are exactly those of 0.1.5 (checked against a recorded set of eight looks). The exception is a card where the fixed severity and warning colors do not read (a red card, for example): it now gets its own pairs for them.
- **Severity chips, warning chips and warning boxes read on any card.** They had fixed pastel colors made for the default dark card (about 1.2 to 1.6:1 on a light card). A look with its own card color now gets chip and box pairs computed for that card (the checks list them), and a light card gets dark-on-light borders. Measured in a real browser for a light card, a red card and the default look.
- **Refusal messages name the right slot, the two colors and that pair's ratio.** A test checks that every message's ratio is the real contrast of exactly the colors it names.
- Deploy order and rollback as for 0.1.5. Do not roll back below 0.1.4 while styled links are live; a look that uses `cardText` needs 0.1.6 or later (an older ingest refuses the unknown slot and an older viewer would not apply it).

## v0.1.5 (beta): click a page on the map, and a look must be readable

New image tag `v0.1.5`; `v0.1.4` is not overwritten. The image carries both the viewer server and the ingest, so deploy it for both (see "Deploy order" below).

- **Clicking a page on the map opens a page card.** The card names the page, shows its path and the findings that touch it (or says plainly that nothing was flagged there), and has two buttons: **Jump to this step** (when a step of the tour covers that page) and **Back to tour**. Focus moves to the card, Escape closes it and returns focus to the tour card, the buttons are labelled, and on a phone it is a sheet at the bottom of the screen. The 3D map itself, the stage background and the render palette are unchanged.
- **A look that cannot be read is refused.** The page nudges a text, muted, link or second colour that is a little too dim, but it cannot fix a card colour that is too light for the page's light text. Such a look is now refused: at upload with a plain message that names the slot (HTTP 422, audit reason `styles-unreadable`), at serve the look is dropped and the neutral look is shown (log code `styles-unreadable`), and `tools/check-styles.mjs` exits 1. Dim-but-fixable colours are still adjusted, not refused. A dim accent on the stage and a faint card edge stay advisory.
- **Links keep a colour** when a look sets neither a link nor an accent colour (they fall back to the built-in accent).
- **The report's integrity seal no longer depends on the look.** The hash covers the report without its `styles`, so a report sealed with a look still verifies after the two-part upload splits and re-joins them. Nothing in the viewer, the server or the ingest checks the seal today (it is for people and tools that want to see whether a saved file was edited); a file sealed by 0.1.4 with a look in it will not match the new formula, one without a look is unchanged.
- **One way of counting the agency name:** 80 characters for the name and 120 for the footer text, counted as characters by the validator; the contract copies no longer refuse text the validator accepts.
- **Deploy order:**
  - **One Portainer stack with both services (the stack files that ship with the project): redeploy that stack once.** The viewer and the ingest are two services in that one stack and share one image, so one redeploy updates both.
  - **Separate stacks (viewer and ingest deployed on their own): update the viewer first, then the ingest.** An older viewer given a stored report that carries a look refuses it like any report with a field outside its contract.
  - Then the publish tools and the Studio. The plugin copy of the shared validator changes with this release (new plugin build).
- **Do not roll back below 0.1.4 while links that carry a look are live:** an older viewer refuses a stored report that carries a look, and those links would stop working until you return to 0.1.4 or later.

## v0.1.4 (beta): a report carries its own look (styles)

New image tag `v0.1.4`; `v0.1.3` is not overwritten. Compared with `v0.1.3` it changes the viewer page, both servers, the contract (one new optional field), the publish tools, the Studio and the Dockerfile. How to use it: `docs/STYLES.md`.

- **A report can carry a look.** A flat styles file (accent, card surface, text, muted, link, secondary, two bundled fonts, heading case, agency name, footer text) travels with the report in ONE publish request with two named parts, `styles_<hash>` and `data_<hash>`. The ingest recomputes the hash (first 12 hex of the SHA-256 of the styles) and refuses a mismatch, a duplicate or a missing part. A plain report is accepted exactly as before.
- **The image ships neutral.** Nothing is built and no brand sits in the image. The server writes the look into the first bytes of the page when it serves a link (no unstyled flash); fonts are bundled by name (Oswald and Inter, SIL Open Font License, notices beside them). The build-time brand folder still works as a fallback; a report's look replaces it.
- **Checked twice with one shared function** (`apps/viewer/brand/styles.mjs`): at upload and again at serve. A key allow-list, hex-only colours, bundled font names, short plain texts, a 4096-character cap; the server generates every CSS line itself and checks the finished CSS; no text from the file is copied into the page. There is no name for the page and 3D stage background or the map, so a look cannot change them. A look that fails the second check is dropped and the neutral look is served (a reason code is logged, never the contents).
- **No change to the security headers**: the Content-Security-Policy and every other header are the same with and without a look (a test checks the exact value). Refusal pages carry no look. Content-Length is the byte length.
- **The header shows the client's name only.** The agency name no longer appears in the header (for the build-time brand too); it is named once, in the footer line.
- **A short calm hold** (at most about 1.5 seconds) keeps the first draw until the look's fonts are ready.
- **Audit line:** an accepted upload with a look records `styles=<hash>`; refusals record reason codes (`styles-mismatch`, `duplicate-key`, `styles-invalid`, `envelope`).
- **Tools:** `node tools/check-styles.mjs <file>` (in the image and in the repository), `apps/server/tools/make-envelope.mjs`, `export-client-report.mjs --styles <file>`; the Studio has **Look (styles file)** on the Brand & review tab; the https publish sends a report that carries a look as the envelope.
- **Deploy order:** (1) the new image, which carries BOTH the viewer server and the ingest, so deploy them together; (2) then the publish tools and the Studio. A 0.1.4 publish tool that sends a report with a look to an older server is refused by it (the older ingest does not know the two-part request); the tool turns that refusal into a plain message that says to update the server first. A report without a look publishes to any version, as before. An older viewer server given a stored report that carries a look refuses it like any report with a field outside its contract, so never place such a report on a server that is not yet 0.1.4.
- **Fonts:** only Oswald and Inter are bundled. Adding another font needs a new image: see "Adding a font" in `docs/STYLES.md`.
- **Kept for now:** the build-time brand folder still works as a fallback (a report's look replaces it). Removing it is a possible later cleanup.
- **Possible later items:** showing a look in the Studio's own preview (today it shows on the client link only); more bundled fonts.
- New tests: `apps/viewer/brand/test-styles.mjs`, `apps/server/test-styles-serve.mjs`, `apps/server/ingest/test-styles.mjs`, `apps/server/e2e-styles.mjs` (real browser).

## v0.1.3 (beta): card colour for the agency brand

New image tag `v0.1.3`; `v0.1.2` is not overwritten. Compared with `v0.1.2` it changes the viewer page and the brand module only. The servers (`server.mjs`, `ingest/ingest.mjs`, `ingest/contract-check.mjs`), the report contract and the deploy files other than the image version are unchanged.

- **Optional `colors.surface` in `brand.json`.** The background of cards and panels. Without it, cards use `grey_2`, then a derived grey, exactly as in 0.1.2. `grey_0` and `grey_1` stay reserved: the page and 3D stage background (`#07090f`) and the 3D render are never branded.
- **Example:** a brand folder can carry `"surface": "#101010"` for dark cards.
- **A thin edge line on branded cards and panels** (the text colour at 28 percent), so a dark card reads against the dark page. Contrast results for an example brand with `#101010` cards: text on a card 10.91:1, muted text on a card 4.56:1, links on a card 7.54:1, the second colour 10.12:1, the card edge 1.89:1 against the card and 1.84:1 against the page. The build now also checks that the edge shows (1.5:1 or more) and says so if it does not.
- Tests: two new brand tests (surface colours cards only and never the stage; a dark card still reads). Image labels and the viewer stamp read 0.1.3.

## v0.1.2 (beta): optional agency brand for the client viewer

New image tag `v0.1.2`. Compared with `v0.1.1` it changes the viewer page (optional agency brand, quieter refresh) AND the servers: `server.mjs`, `ingest/ingest.mjs` and `ingest/contract-check.mjs` now answer bad requests plainly instead of failing, the ingest has a revoke route, a size-capped audit log and an idle mode when switched off, and the Dockerfile pins its base image by version and digest. `tools/cleanup.mjs` is unchanged.

- **Optional agency brand, chosen at build time.** A folder (`apps/viewer/brand/brand.json` plus `fonts/`, or `WEBOBS_BRAND_DIR`) gives the client viewer an agency's colours, fonts, name in the header and a "Prepared by" line in the footer. With no folder, or one that does not pass, the viewer keeps the current look and the build says so (`WEBOBS_BRAND_STRICT=1` makes an invalid brand fail the build; `WEBOBS_BRAND=off` forces the current look).
- **Text attribution, no logo.** The agency name sits at the left of the header (heading font, uppercase if the brand says so) with the client's name beside it; the client's own logo from the report stays as before. The page title and the tab title name the client and the agency.
- **The file follows an agency brand profile structure** (same key names: `name`, `colors`, `fonts`, `voice`, `avoid_words`, and so on) plus `schema_version` and an optional `attribution`. Unknown keys are kept and ignored, so the schema can grow. The supplemental keys are checked but never put in the page; `avoid_words` and `negation_max_per_100_words` feed a wording report (`apps/viewer/brand/scan-wording.mjs`) that lists strings to review and never blocks a build.
- **Self-hosted fonts only.** Latin-subset woff2 files are embedded in the single HTML page; no font service is called. A check scans the built page for external font, style and script addresses.
- **Contrast is checked at build time** and faint colours are nudged (muted text, links, button text). A client's own colour in a report still wins over the agency brand.
- Tests: `apps/viewer/brand/test-brand.mjs` (schema, fallback, unknown keys, contrast, injection, built pages with and without a brand).
- Not changed: the ingest, the server, the report contract, the Admin studio screens (the brand applies to the client viewer).
- **Servers keep serving through a bad request (VULN-001).** Both servers answer an unreadable address (for example "//[" or "//%") with the uniform refusal, a request that is not valid HTTP with a plain 400, a dropped connection mid-upload quietly, a report whose findings are not a list with a refusal, a missing page file with a plain 500, and any unexpected error in a handler with a plain 500 for that one request. No process-level handler hides errors. The ingest now restarts with `unless-stopped` in the stack and compose files (see the stack header: to switch the ingest off, stop the container).
- **A real revoke for ingest links (LOGIC-001).** `POST /ingest/v1/links/<id>/revoke` behind the same locks as an upload; the Studio's Revoke link button works for an https target; emergency steps are in docs/SETUP.md and the README.
- **Cleanup and a capped audit log (IAC-001).** The two main stack files include the daily cleanup service; the ingest audit log rotates by size (`INGEST_AUDIT_MAX_BYTES`, `INGEST_AUDIT_KEEP`).
- **Pinned base image (DEP-001).** `deploy/Dockerfile` names Node 24.22.2 on Alpine by version and digest; how to bump it is in docs/SETUP.md.
- **Client names out of the repository (SEC-001).** The client-data check reads a local git-ignored list (never a repository secret) and runs locally before each commit; it is not part of CI.
- **Reserved for visibility.** A brand cannot change the page and 3D stage background (always the original dark `#07090f`, on every screen and on the server's refusal page) or the 3D render's palette; `grey_0` and `grey_1` in `brand.json` stay valid but are not applied, and a report's own theme background is ignored for the stage. Panels, cards, text, accents, fonts, header and footer stay branded, with contrast checked against the original background. Tests fail if a brand changes either.
- **Phone layout.** The map help button sits above the tour sheet instead of over its Back button on phone and tablet widths.
- **Quieter refresh.** A browser refresh of a report link no longer shows a dashed box reading "Opening your website review / One moment..." (it looked like a place to drop a file) after a blank flash. Viewer pages now open dark from the first paint and show only a quiet line, after a second, if the report is slow to arrive; the error panel has a plain solid border. The step in the address (for example #step=0) still returns to the same step. Viewer only; the server is unchanged. Tests: apps/viewer/test-refresh-splash.mjs (in npm test) and new checks in apps/server/e2e.mjs (real browser, slow report).

## v0.1.1 (beta)

New image tag `v0.1.1`; `v0.1.0` is not overwritten. Viewer stamp and OCI labels read 0.1.1. Changes since v0.1.0: the ingest can run WITHOUT Cloudflare Access as an explicit opt-in (INGEST_REQUIRE_ACCESS_HEADER=0 plus INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes and a secret of 48 or more characters; not recommended); the client address header is configurable (CLIENT_IP_HEADER); an unset INGEST_REQUIRE_ACCESS_HEADER now means the Access check is ON; cleanup tool inside the image; the ingest exits 0 when switched off (from 0.1.2 it idles instead, see above); /ingest/healthz; the drop-in compose, the both-containers stack, the setup guide (docs/SETUP.md) and the env helper (apps/server/tools/make-stack-env.mjs, not in the image). Details of the v0.1.0 beta follow.

### v0.1.1 beta: what first deployments taught, and the tooling added after it

The image `v0.1.1` is unchanged by this section: the server files, the ingest files, `tools/cleanup.mjs` and the viewer are byte-identical to the image already built and tagged `v0.1.1`. What is new in this tree is tooling and documentation only (the env helper, the VPS doctor, `docs/TROUBLESHOOTING.md`, `docs/SETUP.md`, this file, the stack comments and tests). This is a beta; nothing here promises that a deployment is safe.

**What it is.** A token-gated client report viewer plus an optional HTTPS ingest that the Obsidian plugin's Publish step uploads to. Two ways to protect the ingest, both supported:

- **Cloudflare Access mode (the stronger one, the default).** Cloudflare Access with a service token on `/ingest*`, plus the app secret. The ingest verifies Cloudflare's token itself (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`).
- **Secret-only mode (an option).** `INGEST_REQUIRE_ACCESS_HEADER=0`, `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes`, a secret of 48 or more characters. Only the secret, the identical refusals, the in-app rate limits and the size and store caps protect it; a leaked secret alone is enough to upload. An optional Cloudflare WAF rate-limit rule on `/ingest` helps. See `docs/SETUP.md`.

**Lessons from first deployments** (all recorded in `docs/TROUBLESHOOTING.md`):

- **The AUD tag must come from the `aud` claim of a token Cloudflare issued for a token-authenticated request**, not from the login redirect. With two Access applications on one host, the redirect at the host root named a wider application, and copying its tag made every upload fail as `bad-access-token` while everything else looked right.
- **Portainer keeps the variables of the first deploy.** Loading a file only overwrites the names in it, and an update without re-pull and redeploy leaves old containers. A CRLF env file is a risk too: use LF, no BOM, no quotes.
- **The Access application must not cover the whole host.** If the viewer address redirects to an Access login, clients cannot open their links. The tunnel needs the `ingest/*` route before the catch-all; a missing route shows as a 404 from the viewer.
- **Every ingest refusal looks the same (404) by design.** The reason (`bad-secret`, `bad-access-token`, `not-https`) is only in the audit log, which is why the doctor exists.
- **The VPS doctor** (`scripts/webobs-doctor.sh`, with `make-stack-env.mjs --fingerprints`) compares the running containers' variables with your env file by length and a short fingerprint, never printing a value; it reads the last refusal reasons, the container state and the public probes, and it is aware of both modes.
- Plugin Publish messages now show the HTTP status number only (no secret), with a hint per status (plugin side, not part of this repository).

**Known limits.** The viewer's load step does not run the value check (a hostile file could crash the viewer: a denial of service, not a data leak). There is no Revoke button in the plugin. The highlight patch applies only to the performance-branch version of the globe. Real client data must never go into this repository.

## v0.1.0 (beta; first release)

This is a **beta** for testing, not a finished release.

- What it is: a token-gated client report viewer, an optional HTTPS ingest (off unless switched on), the contract package, and the
  vendored web-obs globe (see UPSTREAM.md). Deploy example: `deploy/VPS-STACK-tunnel-both.yml` (viewer and ingest in one
  stack; guide in `docs/SETUP.md`). The viewer-only `deploy/VPS-STACK-viewer-tunnel.yml` is kept.
- Image tag: `v0.1.0`. Images built from this tree carry OCI labels (version, licenses, source).
- Known limits: the highlight patch applies only to the vendored version of the globe (see UPSTREAM.md); the Obsidian plugin is not part of this repository.

### Changes since the first v0.1.0 beta push

These are in this tree, not in the image first pushed under `v0.1.0`; a rebuilt image is needed to get them.

- **Cleanup tool inside the image.** `tools/cleanup.mjs` is copied into the image, so expired and revoked links are removed with the
  same image and the named volume: `docker run --rm ... -v webobs-data:/data IMAGE node tools/cleanup.mjs --reports /data/reports
  --registry /data/registry [--dry-run]`, daily from host cron or the optional `cleanup` compose service.
- **Ingest switched off exits cleanly.** With `INGEST_ENABLED` not `1` the ingest prints one line and exits 0, so a stack with the
  ingest variables unset deploys cleanly (the ingest container shows `Exited (0)`, not a crash loop; from 0.1.2 a switched-off ingest idles and shows as unhealthy on purpose instead). Switched on but misconfigured
  (missing or short secret, Access names empty) it prints a plain reason (names only) and exits 1.
- **`/ingest/healthz`.** The ingest answers it like `/healthz`, so a health probe through the `ingest/*` tunnel route works (behind Access).
- **Path guide.** `docs/SETUP.md`: volume, registry login (if your image is private), stack, tunnel routes in the right order, the Access application, Cloudflare
  rules, the plugin, verification, cleanup and teardown. A new test (`apps/server/test-tunnel-path.mjs`) checks the one-hostname path
  and what a wrong route order looks like.
- **Drop-in compose and the both-containers stack.** `deploy/docker-compose.yml` (plain compose, profiles `ingest` and `cleanup`,
  with `deploy/.env.example`) and `deploy/VPS-STACK-tunnel-both.yml` (one Portainer stack with both services, the ingest on
  `restart: on-failure:5`; from 0.1.2 it is `unless-stopped`). The named-volume stacks `deploy/VPS-STACK-*-tunnel-volume.yml` are included too.
- `apps/server/tools/make-stack-env.mjs`: a helper the owner runs at their own keyboard to write the production env file (generates INGEST_SECRET without showing it; `--check`, `--rotate`, `--copy-secret`). Not part of the image.

### Changes after the second beta: ingest can run without Cloudflare (opt-in), configurable client address header

In this tree only; a rebuilt image is needed to get them.

- **Ingest without Cloudflare Access (opt-in, not recommended).** `INGEST_REQUIRE_ACCESS_HEADER=0` runs the ingest without the
  Cloudflare Access check, but only together with `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes` (exactly that word) and an `INGEST_SECRET` of
  at least 48 characters; otherwise it prints a plain reason (names only) and exits 1. In this mode it prints a one-line WARNING on
  every start. The secret check, the identical 404 with fixed timing, rate limits, size and store caps, contract-only validation and
  the ids-only audit log are unchanged. What is lost and what the reverse proxy must do: `docs/SETUP.md`, "Running the ingest without
  Cloudflare (not recommended)"; threat row in `docs/INGEST-SECURITY.md`.
- **The Access check is now ON when the variable is unset.** Before, an unset `INGEST_REQUIRE_ACCESS_HEADER` meant off; now only
  exactly `0` turns it off. The stacks already set it to 1, so deployed stacks behave the same; a hand-made environment with the
  ingest on and the variable unset now needs `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (or the no-Cloudflare settings above).
- **Configurable client address header.** `CLIENT_IP_HEADER` (viewer and ingest, default `CF-Connecting-IP`) names the header used
  for rate limits when `TRUST_PROXY=1`. The last comma-separated entry is used, only if it is a plain IPv4 or IPv6 address;
  otherwise the connection address (fail safe). Shared code in `apps/server/clientip.mjs`, copied into the image.
- **Stacks and helper.** The both-containers stack, the two ingest stacks, `deploy/docker-compose.yml` and `deploy/.env.example` carry
  `INGEST_REQUIRE_ACCESS_HEADER` (default 1), `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH` (default empty) and `CLIENT_IP_HEADER` (default
  `CF-Connecting-IP`, on both services). `make-stack-env.mjs` asks "Use Cloudflare Access for the ingest? (recommended) [Y/n]" and,
  on n, writes the no-Cloudflare settings with a plain warning; `--check` knows the new rules.
- **Tests.** New `apps/server/ingest/test-no-edge.mjs` (in `npm test`); `docker-smoke.mjs` has one more check (the ingest switched
  on without Cloudflare Access and without the acknowledgment exits non-zero): 15 checks, 19 locked down.

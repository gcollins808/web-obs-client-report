# Feature register

One row per feature: where it lives, how it is tested, what switches it, its status, whether it could go upstream to web-obs, and
how to remove it. Features sit in their own files or folders, so removing one is a delete plus a settings line, not surgery.
"Upstream" means a pull request to the web-obs project, one idea per branch.

Status words: **done** (built and tested here), **optional** (built, off by default), **fix** (a correction, not a feature),
**planned** (not started), **superseded** (kept only for history, safe to delete).

| # | Feature | Files | Tests | Switch | Status | Upstream? | How to remove it |
|---|---|---|---|---|---|---|---|
| 1 | **Client report contract and builder** (`webobs.client-report` 1.1, strict allowlist, seal) | `packages/contract/src/{contract,package,core,draft,plain}.ts`, `docs/CLIENT-REPORT-{CONTRACT,FORMAT}.md` | `packages/contract/tests/package.test.mjs`, `draft.test.mjs` | none (library) | done | Yes (the core of it) | Everything below depends on it; remove `packages/contract/`, `apps/viewer/` and `apps/server/scripts/export-client-report.mjs`. |
| 2 | **Viewer and guided tour** over the 3D globe (collapsible, finding highlights, clickable steps, "?" help, theme tokens) | `apps/viewer/src/components/{PackageViewer,GlobeStage,Scenes,ToolIcons}.tsx`, `apps/viewer/src/{main.tsx,viewer.css,styles.css}`, `highlightIds` in `vendor/web-obs/components/SiteGlobeCanvas3D.tsx` | `apps/server/e2e.mjs` (real browser), `apps/server/scripts/e2e-studio.mjs` | `client.theme` in the report; none to turn off | done | Yes, the globe part first | Delete the four components and `viewer.css`; `main.tsx` falls back to the Studio. Revert the `highlightIds` prop in the globe. |
| 3 | **Explore pack** (agency only, never uploaded) | `apps/viewer/src/components/{ExploreViewer,Viewer}.tsx`, pack export in `package.ts` | `packages/contract/tests/package.test.mjs` | Studio "Save explore pack" | done | Maybe, as part of #1 | Delete `ExploreViewer.tsx`/`Viewer.tsx` and the Studio button. |
| 4 | **Report Studio** (review, Checks tab, Export, Publish button, Captures and links tab) | `apps/viewer/src/components/{Admin,Manage}.tsx`, `apps/viewer/src/lib/{helperClient,files}.ts`, `apps/viewer/index.html` | `apps/server/scripts/e2e-studio.mjs` | none | done | Unlikely (agency tool) | Delete the Studio files under `apps/viewer/`; the viewer keeps working. |
| 5 | **Publish core and local helper** (one command; helper on 127.0.0.1 with a start token; ssh or local folder) | `apps/server/scripts/lib/{publish-core,capture-core,links-core}.mjs`, `apps/server/scripts/{publish-helper,publish-client-report}.mjs` | `apps/server/scripts/test-publish-and-remove.mjs`, `e2e-studio.mjs` | `WEBOBS_PUBLISH_TARGET`, `WEBOBS_REPORT_BASE`, `WEBOBS_VAULT` | done | No | Delete those scripts; the Studio then saves a file instead. |
| 6 | **Report server** (token-gated, read-only volumes, no framework) | `apps/server/{server,tokens,email}.mjs` | `apps/server/test.mjs`, `apps/server/e2e.mjs` | `.env` (see `.env.example`) | done | No | Delete `apps/server/`. |
| 7 | **Token tool** (create, list, revoke, extend; random 32-hex file names; 72 h default) | `apps/server/tools/make-token.mjs` | `apps/server/test.mjs` | `WEBOBS_REPORT_TTL_HOURS` | done | No | Delete the file; `publish-core.mjs` calls it for ssh and folder targets. |
| 8 | **Cleanup** of expired and revoked links | `apps/server/tools/cleanup.mjs` (the older age-only `retention.mjs` was removed) | `apps/server/test.mjs` | `npm run reports:cleanup` on a schedule | done | No | Delete the file and the cron line. |
| 9 | **Report source adapters** (directory, https read) | `apps/server/source.mjs` | `apps/server/test.mjs` ("report source adapters") | `REPORT_SOURCE`, `REPORT_SOURCE_URL`, `REPORT_SOURCE_TOKEN` | done | No | Replace `makeSource` in `server.mjs` with a directory read; delete the file. |
| 10 | **Access denied** (one refusal for every bad-link case, noindex everywhere) | `apps/server/server.mjs` (`deny`), `apps/viewer/src/main.tsx`, `apps/viewer/index.html` meta tags | `apps/server/test.mjs`, `apps/server/e2e.mjs` | `DENIED_DELAY_MS` | done | No | Not removable without making refusals distinguishable; keep. |
| 11 | **Remove-capture** (moves a capture and its history to a trash folder; never deletes) | `apps/server/scripts/remove-capture.mjs`, archive in `capture-core.mjs` | `apps/server/scripts/test-publish-and-remove.mjs` | none | done | Maybe (the plugin button uses the same rule) | Delete the script and the Studio tab section. |
| 12 | **Resend feedback email** | `apps/server/email.mjs`, `sendMail` in `server.mjs`, `tools/{send-test-email,check-env}.mjs` | `apps/server/test.mjs` | `WEBOBS_FEEDBACK_TO`, `RESEND_API_KEY`, `RESEND_FROM`, `MAIL_MODE` | done | No | Set `MAIL_MODE=outbox` (writes a file instead); delete `send-test-email.mjs`. |
| 13 | **Build stamp** in the viewer help and Studio | `__BUILD_STAMP__` in `apps/viewer/vite.report.config.ts`, `ToolIcons.tsx` | the viewer e2e | none | done | Yes (tiny) | Remove the `define` line and the stamp text. |
| 14 | **Docker packaging** (image, compose with a Cloudflare tunnel network, no ports; ingest service only with `--profile ingest`) | `deploy/Dockerfile`, `deploy/docker-compose.example.yml`, `deploy/Dockerfile.dockerignore`, `apps/server/tools/docker-smoke.mjs` | `docker-smoke.mjs` passes outside a container; the image has not been built yet (Docker was not running) | n/a | done, untested as a container | No | Delete those three files. |
| 15 | **HTTPS ingest** (push a report over HTTPS; two locks; server makes the link) | `apps/server/ingest/{ingest,access-jwt,contract-check,test,test-hardening}.mjs`, `apps/server/scripts/lib/publish-https.mjs`, hooks in `publish-core.mjs`, `docs/INGEST-SECURITY.md` | `node apps/server/ingest/test.mjs`, `test-hardening.mjs` | `INGEST_ENABLED` (off by default; the server refuses to be built off or with a short secret), `INGEST_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (the Access token is verified), `WEBOBS_PUBLISH_TARGET=https://...` | optional | No | Delete `apps/server/ingest/`, `apps/server/scripts/lib/publish-https.mjs`, the `ingest` service in the compose file, and the `https` lines in `publish-core.mjs` (marked "publish-https"). |
| 16 | **Fix: no "browser tests covered" line when the browser step was skipped** | `packages/contract/src/draft.ts` (`sampledPages`) | `packages/contract/tests/draft.test.mjs` | none | fix | Yes (with row 1) | Revert the three lines around `sampledPages`. |
| 17 | **Plugin: Publish audit and Archive audit buttons** | not part of this repository (a separate branch of the web-obs plugin) | n/a | plugin settings for the reports folder, link base, approver name and feedback address | done elsewhere | Yes, as its own PR | Not in this tree. |
| 18 | **Plugin: Publish with push** (https first, ssh second) | not part of this repository | planned | plugin setting for the publish target, empty by default | planned | Yes, as its own pull request after row 17 | Not in this tree. |
| 20 | **Contract value checks and viewer image safety** (types, length caps, http/https urls only, nested keys, image data URIs only) | `packages/contract/src/{contractValues,safe}.ts`, `apps/server/ingest/contract-check.mjs`, `apps/viewer/src/components/{PackageViewer,Scenes,Viewer}.tsx` | `packages/contract/tests/{package,viewer-safety}.test.mjs`, `apps/server/ingest/test.mjs` | none | fix (independent review finding 3) | With #1 | Not removable without reopening the finding. |
| 21 | **Client-data guard** (`.gitignore` patterns and `scripts/check-no-client-data.mjs`; real exports are kept outside this repository) | `.gitignore`, `scripts/check-no-client-data.mjs` | the script itself | none | fix (finding 1) | No | Keep. |

## Notes

* **Data in tests.** All tests read synthetic fixtures from `fixtures/` (invented site `example-shop.test`). Regenerate them with
  `node fixtures/make-synthetic.mjs`; the output is deterministic and committed. No real capture or client data is in this repository.
* **PR rules** for anything that might go to the web-obs project: one idea per branch, a test that fails without the change,
  rebased on a fresh fetch of upstream main, no unrelated formatting, no attribution lines.
* **Not built:** operating-system credential store for the laptop secrets, encryption at rest, a pipeline that builds the image,
  real SSH and real Cloudflare tests.

## Optional agency brand (v0.1.2)

- **What:** colours, fonts, a text attribution (agency name in the header, "Prepared by" in the footer) and the page title for the client viewer, from a build-time brand folder. Default: the current look.
- **Where:** `apps/viewer/brand/` (`load-brand.mjs`, `scan-wording.mjs`, `test-brand.mjs`, `brand.example.json`, `README.md`); wired in `apps/viewer/vite.report.config.ts`, `apps/viewer/src/lib/brand.ts`, `PackageViewer.tsx` and `viewer.css`.
- **Reserved for visibility:** a brand never sets the page and 3D stage background (`#07090f`) or the render palette; `grey_0` and `grey_1` are ignored with a plain build message (`apps/viewer/brand/load-brand.mjs`: `RESERVED_COLOR_KEYS`, `STAGE_BG`).
- **Remove by:** deleting `apps/viewer/brand/`, the plugin and `define` lines in `vite.report.config.ts`, `lib/brand.ts`, and the `BRAND` lines in `PackageViewer.tsx` and `.rp-branded` rules in `viewer.css`.

## Revoke, cleanup and the capped audit log (v0.1.2)

- **Revoke an ingest link:** `apps/server/ingest/ingest.mjs` (`REVOKE_ROUTE`, `revokeLink`), `apps/server/scripts/lib/publish-https.mjs` (`revokeHttps`, `recordLink`), `apps/server/scripts/lib/links-core.mjs` (`revokeAny`), the helper route `/links/revoke`. Remove by deleting those parts; links then expire on their own or are removed by hand.
- **Cleanup service in the stack files** (`deploy/VPS-STACK-tunnel-both*.yml`); **audit log cap** in the ingest (`rotateAudit`).
- **Client-name list:** `scripts/check-no-client-data.mjs` reads `.client-names` or `WEBOBS_CLIENT_NAMES_FILE` (a local, untracked file; never a repository secret, because write access can read secrets through a workflow). Run it with `npm run check:client-data` before each commit; it is not part of CI.

## Click a page on the map (v0.1.5)
A click on a page opens a page card (title, path, the findings that touch it, Jump to this step, Back to tour). Keyboard: focus moves to the card, Escape closes it. Phone: a bottom sheet.

## A report carries its own look (v0.1.4)

- **What:** a flat styles file (colours, two bundled fonts, the agency name and a footer line) is published WITH the report in one request and applied when the link is opened. The image stays neutral and nothing is built.
- **How it is kept safe:** a fixed list of names, hex colours only, bundled fonts by name, short plain text; the server writes every CSS line itself; checked at upload and again at serve; no way to change the stage background or the map; the security headers are the same with and without a look.
- **Use it:** `docs/STYLES.md`.

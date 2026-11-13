# web-obs-client-report

Created by [Garrett Collins](https://cscloud.digital) ([GitHub](https://github.com/gcollins808)).

A private, plain-language website review for your clients. You capture a site with [web-obs](https://github.com/AgriciDaniel/web-obs),
review the findings, approve a report, and the client opens it through a private link: a guided tour over the 3D site globe, with
every finding explained in the client's terms. No login for the client, no account, no tracking.

> **Beta (v0.1.7).** This is a beta. Test with synthetic data only until you have verified the whole path yourself.

This repository is the **front end reporting engine**. It is one container image that runs as two services:

| Service | What it does | Port | Always on |
|---|---|---|---|
| `report` (viewer) | Serves the client viewer page and the report, only to a request that carries a valid token link | 8080 | yes |
| `ingest` (optional) | Lets the web-obs plugin push an approved report over HTTPS and returns the link | 8081 | no, off by default |

**New here? Start with `docs/GUIDE.md`**: what it is, the full stack file, every setting, the plugin steps and daily use.

## What it is

A small self-hosted service for agencies and consultants. You review a website with [web-obs](https://github.com/AgriciDaniel/web-obs),
approve a plain-language report, and publish it. The client opens a private link and takes a guided tour of the findings on a 3D map
of their own site. The report is one JSON file; the server keeps only a hash of each link; there is no tracking and no analytics.

**Who it is for:** a person or small team that can run a Docker container behind HTTPS (for example with a Cloudflare tunnel and
Portainer) and wants to send clients a private, readable review instead of a PDF.

**Who it is not for:**
* Anyone who wants a hosted service or an account system. You run it yourself, and there are no client logins.
* Anyone who needs strong secrecy for a report. A link is a bearer secret until it expires or you revoke it, and reports are plain
  JSON on disk with no encryption at rest.
* Anyone who needs an audited product. This is a beta. There has been no third-party penetration test. Test with synthetic data first.
* A public or anonymous web service. Never publish its ports directly; run it behind your own HTTPS proxy or tunnel.
* A replacement for web-obs. It shows reports; the capture and audit are done by web-obs.

## Pairing with the Web-Obs plugin

The web-obs plugin for Obsidian does the capture, audit and approval. Its Publish action sends an approved report to this server's
optional `ingest` service over HTTPS and gets back the client link. The plugin and this server share two things you set yourself:
the base address (`WEBOBS_REPORT_BASE` here, the Publish target in the plugin) and the application secret (`INGEST_SECRET` here, the
Publish secret in the plugin). Use a report look (`docs/STYLES.md`) to give a report its colours, fonts and agency name; the plugin keeps
a checked copy of the look rules, so use a plugin build and a server release that match. The plugin buttons are not part of this repository. Without a plugin you can
copy a report file into the server's reports folder and create a link with `apps/server/tools/make-token.mjs`. The report format is in
`docs/CLIENT-REPORT-CONTRACT.md`.

## Environment variables (names only)

Names only. Put real values in your host's environment (for example Portainer), never in a file in this repository. Use placeholder
values like these while you read: `WEBOBS_REPORT_BASE=https://audit.example.com`, `INGEST_SECRET=<32 or more random characters>`.

| Group | Names |
|---|---|
| Viewer | `WEBOBS_REPORT_BASE` (required), `RETENTION_DAYS`, `REPORT_SOURCE`, `REPORTS_DIR`, `REGISTRY_DIR`, `TRUST_PROXY`, `REQUIRE_HTTPS`, `DENIED_DELAY_MS`, `PORT` |
| Feedback mail | `MAIL_MODE`, `WEBOBS_FEEDBACK_TO`, `RESEND_API_KEY`, `RESEND_FROM` |
| Ingest (optional) | `INGEST_ENABLED`, `INGEST_SECRET`, `INGEST_PORT`, `INGEST_REQUIRE_ACCESS_HEADER`, `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH`, `CLIENT_IP_HEADER` |
| Cloudflare Access (ingest default) | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` |
| Agency tools (your own machine) | `WEBOBS_INGEST_SECRET`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `WEBOBS_PUBLISH_TARGET` |

The full list with defaults and comments is `.env.example`; the table under "Variables to set in Portainer" says which are secrets.

## How the pieces fit

```
Obsidian + web-obs plugin            this repository (one image, two services)         the client
  capture, audit, approve   --->   ingest (8081)  writes reports/ and registry/
  "Publish" with a target                                |
                                    viewer (8080)  reads them read-only  <---  https://audit.example.com/r/<token>
```

* **The plugin is separate and is not part of this repository.** It works with the public Web-Obs plugin today: its Publish dialog
  sends an approved report to this server (setup in `docs/GUIDE.md`). With no target set the plugin only saves a report file you can
  copy to the server folders yourself. **Brand-forward reports** (a look per client, set in the Publish dialog) are coming soon, through
  an open pull request to the Web-Obs plugin. This server already accepts them (`docs/STYLES.md`); there is no date.
* **web-obs** ([AgriciDaniel/web-obs](https://github.com/AgriciDaniel/web-obs)) supplies the capture and the 3D globe. The viewer in this repository contains a vendored copy of the globe
  component under `vendor/web-obs` (MIT, see `NOTICE`; provenance in `UPSTREAM.md`). It is copied in, not fetched at run time. It is vendored from web-obs
  407de3e plus cluster and render performance changes, with a local highlight option added to the globe.
  Most files are byte-identical to 407de3e; the exact differences are listed in `UPSTREAM.md`.
* A report is one JSON file following the contract in `docs/CLIENT-REPORT-CONTRACT.md`. Nothing private is in it: the builder uses an
  allowlist of fields and only an approved report can be exported.

## Try it locally

See a client report on your own computer in a few minutes, using the invented sample site in `fixtures/` and no real data. You need Docker (Docker Desktop on Windows or Mac) and a copy of this repository. You don't need Node.

```
git clone https://github.com/gcollins808/web-obs-client-report.git
cd web-obs-client-report
docker compose -f deploy/docker-compose.local.yml up
```

The first service, `seed`, copies the sample report into `data/` (git-ignored) and prints a link like `http://127.0.0.1:8080/r/...`. Open that link to take the guided tour as a client would. Ignore the "Next: copy /data to the server volume" line it prints; that is for a real server. Opening `http://127.0.0.1:8080/` with no link shows "This link is not available", which is correct: there is no home page and no listing.

Each `up` makes one new 72-hour link. Feedback a visitor sends at the end of the tour stays inside the container and is gone when it stops; nothing is emailed. Stop with Ctrl+C, then `docker compose -f deploy/docker-compose.local.yml down`. Delete `data/` to start over.

The file, `deploy/docker-compose.local.yml`:

```yaml
name: webobs-local

services:
  seed:
    image: node:24-alpine
    working_dir: /src
    command: ["node", "apps/server/tools/make-token.mjs", "create",
              "--report", "fixtures/client-report.sample.json",
              "--client", "demo", "--out", "/data",
              "--base", "http://127.0.0.1:8080"]
    environment:
      WEBOBS_REPORT_INDEX: /data/.report-index/index.json
    volumes:
      - ../apps/server:/src/apps/server:ro
      - ../fixtures:/src/fixtures:ro
      - ../data:/data

  report:
    image: ghcr.io/gcollins808/web-obs-client-report:v0.1.7
    depends_on:
      seed:
        condition: service_completed_successfully
    ports:
      - "127.0.0.1:8080:8080"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment:
      WEBOBS_REPORT_BASE: http://127.0.0.1:8080
      REQUIRE_HTTPS: "0"
      REPORT_SOURCE: directory
      MAIL_MODE: outbox
      OUTBOX_DIR: /outbox
      WEBOBS_FEEDBACK_TO: team@example.com
    volumes:
      - ../data:/data:ro
    tmpfs:
      - /tmp
      - /outbox:uid=1000,gid=1000
```

It is for testing only. `REQUIRE_HTTPS: "0"` and the port on `127.0.0.1` are not for a live server; for that, see `docs/SETUP.md`.

## Build and run the image yourself (this computer only)

The Portainer stack below (`deploy/VPS-STACK-tunnel-both.yml`, guide in `docs/SETUP.md`) is the recommended deployment, and
`deploy/docker-compose.yml` is the plain compose version. To try it
locally first, with synthetic data only:

```
docker build -f deploy/Dockerfile -t webobs-report:local .
mkdir -p data/reports data/registry data/outbox
docker run --rm --name wo-view -p 127.0.0.1:8080:8080 --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true -v "$PWD/data:/data:ro" -e REQUIRE_HTTPS=0 -e WEBOBS_REPORT_BASE=http://127.0.0.1:8080 webobs-report:local
```

Open `http://127.0.0.1:8080/`. You should see the plain line "This link is not available. Please request a fresh one.", which is correct: there is no home page and no listing.
To make a link for a synthetic report (needs Node 22 or newer on your machine):

```
npm install
node apps/server/tools/make-token.mjs create --report fixtures/client-report.sample.json --client demo --out data --base http://127.0.0.1:8080
```

The tool copies the report into `data/reports` under a random name, writes the link entry into `data/registry`, prints the link once and stores only a hash of its token. See `apps/server/README.md` for the full tool options (list, revoke,
extend). `REQUIRE_HTTPS=0` is for local testing only. The commands use bash syntax; in PowerShell use a full path for the `-v` folder
(for example `-v C:\path\to\data:/data:ro`). The tool also writes a local index folder `.report-index/` (git-ignored) in the current folder.

## Deploy with a Docker Compose stack in Portainer (recommended)

One stack, one image, three services (viewer, ingest, daily cleanup) on one hostname, data in one named Docker volume. Nothing publishes a port: a Cloudflare tunnel
container on the same Docker network is the only way in.

**Follow `docs/SETUP.md`** (step by step, phone friendly). The main stack file is `deploy/VPS-STACK-tunnel-both.yml`: paste it into
Portainer (Stacks, Add stack, Web editor), replace the image account with `ghcr.io/OWNER/web-obs-client-report:v0.1.7`, create the
volume `webobs-data` first, and set the variables below. No published image? Build your own: `docker build -f deploy/Dockerfile -t ghcr.io/OWNER/web-obs-client-report:v0.1.7 .`
and push it to a registry you control. In short:

1. Create the volume `webobs-data`. If your registry needs a login, add it under Portainer > Registries.
2. Deploy the stack with `WEBOBS_REPORT_BASE` = `https://audit.example.com`. The viewer becomes `healthy`; the ingest shows
   running but `unhealthy` because it is switched off (it idles and answers 503). That is the expected state.
3. Tunnel routes on `audit.example.com`, in this order: path `ingest/*` -> `http://ingest:8081`, then the catch-all -> `http://report:8080`.
   In the wrong order every push gets "Access denied" from the viewer and nothing is stored.
4. A Cloudflare Access application on `audit.example.com/ingest*` only, with a service-token policy. **No Access login on the viewer.**
5. Switch the ingest on: `INGEST_ENABLED=1`, `INGEST_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, then update the stack.
   A misconfiguration (short secret, Access names empty) exits 1 with one plain log line (`ingest not started: ...`) that names the setting; Docker keeps restarting it, so the line stays in the log until you fix the variable.
6. Cloudflare rules, the plugin, verification, the daily cleanup and teardown: `docs/SETUP.md`, steps 6 to 10.
7. Something refused or not matching? `docs/TROUBLESHOOTING.md` and `scripts/webobs-doctor.sh` (run on the VPS, prints no secret).

### The stack file (both services)

The stack is `deploy/VPS-STACK-tunnel-both.yml` (three services: `report`, `ingest` and the required daily `cleanup`). Its text with the
comments removed is in `docs/GUIDE.md`, generated from the file, so the two cannot drift apart. Values come from Portainer's
environment variables box, never from the file. Create the volume `webobs-data` and the Docker network that your cloudflared
container is on first, and use your own image path for `OWNER`. Every setting is listed in one table in `docs/GUIDE.md`.

**Plain docker compose** (no Portainer): `deploy/docker-compose.yml` with `deploy/.env.example` copied to `deploy/.env`. The ingest needs
both `INGEST_ENABLED=1` and `COMPOSE_PROFILES=ingest`; profile `cleanup` adds a daily cleanup loop.

Other files in `deploy/`: the viewer-only and ingest-only stacks (`VPS-STACK-viewer*.yml`, `VPS-STACK-ingest*.yml`, host folders or the
named volume) and the older `docker-compose.example.yml` (host folders).

### Variables to set in Portainer

In the stack page, "Environment variables". Names only here; values live in Portainer and never in a file or the image.

| Name | Secret | What it does |
|---|---|---|
| `WEBOBS_REPORT_BASE` | no | Public address the links start with, https, no trailing slash. Required |
| `RETENTION_DAYS` | no | Days a report is served at most (default 90) |
| `MAIL_MODE` | no | `outbox` (keep feedback in the container's memory-backed `/outbox`) or `resend` (email it) |
| `WEBOBS_FEEDBACK_TO` | no | Team address that receives client feedback |
| `RESEND_API_KEY`, `RESEND_FROM` | key is secret | Only for `MAIL_MODE=resend` |
| `INGEST_ENABLED` | no | `1` turns ingest on. Anything else, or unset, keeps it off: the ingest container idles (answers 503, shown as unhealthy on purpose) |
| `INGEST_SECRET` | **yes** | Application secret for ingest, 32 or more characters. The plugin's Publish secret holds the same value |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | no, but keep private | Needed when the ingest is on with Cloudflare Access (the default) |
| `INGEST_REQUIRE_ACCESS_HEADER` | no | Default `1`: the ingest verifies the Cloudflare Access token. `0` runs it without Cloudflare (not recommended, see below) |
| `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH` | no | `yes` only when you deliberately run the ingest without Cloudflare Access; empty otherwise |
| `CLIENT_IP_HEADER` | no | Header naming the caller for rate limits (default `CF-Connecting-IP`); without Cloudflare, the header your reverse proxy sets, e.g. `X-Real-IP` |

`TRUST_PROXY=1` is set in the stack file itself, and `INGEST_REQUIRE_ACCESS_HEADER` defaults to `1` there. Further tuning names (`DENIED_DELAY_MS`, the
`RATE_*` and `INGEST_MAX_*` limits) are listed with their defaults in `.env.example`.

### Cleanup

The viewer mounts the volume read-only and cannot delete. The image carries the cleanup tool; run it daily (dry run first):

```
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v webobs-data:/data \
  ghcr.io/OWNER/web-obs-client-report:v0.1.7 node tools/cleanup.mjs --reports /data/reports --registry /data/registry --dry-run
```

For a host cron entry, or the `cleanup` service in `deploy/docker-compose.yml`, see `docs/SETUP.md`, step 9.

## Security model in plain words

**Checked.** A link is a random 256-bit token; the server keeps only its hash, an expiry (72 hours by default) and a revoked flag.
Every bad, expired, revoked or missing link gets the same plain refusal ("This link is not available. Please request a fresh one.") after the same fixed wait, including when the report source is
slow. Report files are named by the server with random ids, never by the caller. The viewer refuses any file that is not an approved
client report on the contract (field names, value types, lengths, web addresses, embedded images), so one bad file cannot be served.
Ingest has two locks: a Cloudflare Access service token verified in the server, and an application secret compared in constant time.
It cannot read, list, change or delete anything, never overwrites, and is size, rate and count limited. Every response says `noindex, no-store`.
The audit log holds ids and times, never content, tokens, addresses or client names.

**Not checked, or limited.**
* Anyone holding a valid link can read that report until it expires or you revoke it. A link is a bearer secret, like a password.
* If a laptop is stolen, whoever has its environment or Obsidian's stored secrets has both ingest locks. Use disk encryption.
* Reports are plain JSON on disk; there is no encryption at rest.
* `TRUST_PROXY=1` is only safe when nothing but your tunnel (or your own reverse proxy) can reach the container. Never publish the ports.
* A remote report source (`REPORT_SOURCE=https`) needs `DENIED_DELAY_MS` raised above its latency, or refusals can differ in timing.
* The Cloudflare account is part of the trust boundary: use a strong password and two-factor sign-in.
* The image and server were tested locally with automated checks and two independent code reviews; there has been no third-party penetration test.

**Secret-only ingest (an option; the Cloudflare Access mode is stronger).** The default is the Cloudflare Access check plus the app
secret. If you do not want to maintain Access, or are not on Cloudflare, the ingest can run protected by the secret alone (you can
still keep the tunnel and the Cloudflare proxy): set `INGEST_REQUIRE_ACCESS_HEADER=0`,
`INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes`, an `INGEST_SECRET` of 48 or more characters, and `CLIENT_IP_HEADER` to the header your
reverse proxy sets (for example `X-Real-IP`). Without the acknowledgment, or with a shorter secret, it refuses to start; when it
runs it logs a WARNING on every start. Only the secret, the identical refusals, the in-app rate limits and the size and store caps
then protect it: there is no edge authentication or filtering, and a leaked secret alone is enough to upload reports that become
served links. Your proxy must end HTTPS, set `X-Forwarded-Proto: https` and the client-IP header, and be the only way in (no
published ports). Safer alternatives (mTLS, basic auth or an IP allow-list at the proxy, or a VPN) and a checklist are in
`docs/SETUP.md`, "Running the ingest without Cloudflare (not recommended)".

The full threat table is in `docs/INGEST-SECURITY.md`.

## Safe-testing checklist

- [ ] Use synthetic data only (the invented site `example-shop.test` in `fixtures/`). Never a real client capture or report during testing.
- [ ] Keep real captures and `.env` files outside this repository. Run `npm test`, and, if you keep a local list of client names, `npm run check:client-data` before every commit (the client-data check, `scripts/check-no-client-data.mjs`; it fails when the list is missing).
- [ ] Ingest stays off until the Access check, secret length and unpublished ports are confirmed.
- [ ] After a test push, read the audit log (ids only), run the cleanup job with `--dry-run`, and open the viewer address and a wrong link in a browser: both must show "This link is not available. Please request a fresh one." (the ingest address answers 404 "Access denied" without the Access token).
- [ ] Real client reports only after your own verification of the whole path. Revoke test links when done:
  `node apps/server/tools/make-token.mjs revoke <link-id> --out <folder>` for links made with that tool; for links made through the ingest,
  the Studio's Revoke link button, or `POST /ingest/v1/links/<link id>/revoke` (docs/SETUP.md, "Revoking a link"). Then rotate the test secrets.
  Emergency, with only the host: delete the registry file named by the link id on the data folder, then open the link to confirm it shows "This link is not available. Please request a fresh one.".

## Appendix: plain docker run commands (local test only)

Smoke test of the image (runs once, publishes nothing):
```
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -e EXPECT_LOCKED_DOWN=1 \
  -v "$PWD/apps/server/tools:/smoke:ro" webobs-report:local node /smoke/docker-smoke.mjs
```
Ingest on this computer only (synthetic secret, port bound to 127.0.0.1):
```
docker run --rm --name wo-ingest -p 127.0.0.1:8081:8081 --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true -v "$PWD/data:/data" -e INGEST_ENABLED=1 -e INGEST_SECRET \
  -e REQUIRE_HTTPS=0 -e WEBOBS_REPORT_BASE=http://127.0.0.1:8080 webobs-report:local node ingest/ingest.mjs
```
Set `INGEST_SECRET` in your shell first (32 or more characters, for example from `openssl rand -hex 32`); it is not written to any file.

## Agency brand (optional)
A report can also carry its own look (colours, two bundled fonts, an agency name), published with it in one request and applied when the link is opened: see `docs/STYLES.md` (new in 0.1.4; the image stays neutral).

The client viewer can carry an agency's colours, fonts, name in the header and a "Prepared by" line, chosen at build time from a small folder with a `brand.json` (and fonts). With no folder it keeps its current look. See `apps/viewer/brand/README.md`.

## Developing
The client-data check (`npm run check:client-data`, `scripts/check-no-client-data.mjs`) is run locally before every commit; it is not part of `npm test` or CI. It reads a local, git-ignored list of client-name patterns: `.client-names`, one pattern per line, or the file named by `WEBOBS_CLIENT_NAMES_FILE`. It fails with a plain message if the list is missing. The list is a local, untracked file and never a repository secret: anyone with write access to the repository can read its secrets through a workflow.
Node 22 or newer: `npm install`, `npm run build`, `npm test`. See `docs/ARCHITECTURE.md`.

## Privacy
The software sets no cookies, includes no analytics and makes no requests to third parties from the visitor's browser (the page's
content security policy blocks them). The only data a visitor can send is the optional feedback they choose to submit at the end of
the tour. The tour keeps the visitor's own answers in their browser's local storage, on their device only. If you serve it through a
proxy such as Cloudflare, that proxy sees visitor requests and may set its own cookies. If you turn on Resend, the server (not the
browser) sends the feedback email through it.

## License

MIT, matching web-obs. See `LICENSE` and `NOTICE` (the vendored globe keeps its own MIT license and copyright).

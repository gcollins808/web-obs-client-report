# Report server (prototype)

Serves a client report only to someone holding that report's private link. The container image holds no client data.

```
your machine                                 server
  Studio: Export client JSON  ->  .client-report.json
  npm run publish:client      ->  export + link + upload, link printed once   (details below)
                                  /data/reports/<32 random hex>.json           (read-only mount for the server; no client text in the name)
                                  /data/registry/<link-id>.json                (read-only mount; one small file per link: hash, file name, dates)
client opens  https://reports.example.com/r/<token>
```

## Set up the settings (.env)

1. Copy `.env.example` (repository root) to `apps/server/.env` and fill it in. The example lists every setting the server reads, with a
   one-line note on each; an empty value means "use the default". `.env` is git-ignored and must never be committed.
2. The Resend key is a key made **just for this app** in Resend. For go-live, set it (and `RESEND_FROM`) as a secret on the container
   host, not in the image and not in a file in the repo.
3. On start the server reads `.env` and prints a plain-words notice for anything missing, for example
   "RESEND_API_KEY missing: feedback is written to the outbox file instead of being emailed." It never prints a value.
4. `node apps/server/tools/check-env.mjs` checks that no `.env` is tracked or un-ignored, and that the example lists every setting.

## Random file names, expiry and cleanup

- **Random names.** Each report is stored as `reports/<32 random hex characters>.json` (128 random bits). No client name, slug or date is in a file
  name or in the registry. The token that opens a report is separate from that file name (the registry maps the token's hash to the file
  name), so knowing a file name gives no access, and there is no route that lists or serves files by name.
- **Where the client name lives.** Only in a local index on the operator's machine (`.report-index/index.json`, git-ignored; move it with
  `WEBOBS_REPORT_INDEX`). It is never uploaded. The Studio's links list reads client names from it. The report file itself still contains the
  client's name inside, because the client sees it.
- **Expiry.** A link works for 72 hours by default: set `WEBOBS_REPORT_TTL_HOURS` in the project `.env` to change the default. When publishing, the
  Studio's "hours" box (or `--hours`) picks another time, up to 720, and shows the exact expiry time. **Extend** (Studio links list, or
  `make-token.mjs extend <link-id> --hours <n>`) moves the expiry to a new time from now and shows it. Past expiry the server answers the same
  plain 404 as for a wrong link.
- **Real removal.** The web server only reads its volume, so it cannot delete. `npm run reports:cleanup` (or
  `node apps/server/tools/cleanup.mjs --reports <dir> --registry <dir> [--orphan-hours 48] [--dry-run]`) deletes expired and revoked links with
  their report files, link entries whose report is gone, and any report file with no link entry older than 48 hours. Use `--dry-run` first. In dev it
  runs by hand against the folder in `WEBOBS_PUBLISH_TARGET`. Feedback already emailed is unaffected: it sits in your inbox, not on the volume.
- **Scheduling it in production.** Run the cleanup on the host that owns the volume, not inside the web container (which is read-only). For example a
  cron entry that runs hourly: `17 * * * * cd /srv/webobs-app && node apps/server/tools/cleanup.mjs --reports /srv/webobs/reports --registry /srv/webobs/registry >> /var/log/webobs-cleanup.log 2>&1`.
  The image carries the tool as `/app/tools/cleanup.mjs`, so with the named volume a one-off container does it (cron line and the optional
  `cleanup` compose service: `docs/SETUP.md`, step 9):
  `docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v webobs-data:/data IMAGE node tools/cleanup.mjs --reports /data/reports --registry /data/registry [--dry-run]`.
  The log names link ids only, never a token or hash.

## How a link works

- The token is 32 random bytes (43 characters, base64url). It appears only in the link you send.
- The registry is a folder with one small file per link. Each holds a **SHA-256 hash** of the token, an id, the file path, an expiry and a
  revoked flag. Losing the registry does not reveal any link, and adding a link never rewrites another link's file.
- On every request the server hashes the token it was given, compares it in constant time, and checks expiry, revocation,
  that the stored name is a random file id, that the report source has it, and the retention period. Unknown, expired, revoked,
  missing and past-retention links all get the same refusal (see "Access denied" below). The registry is re-read on each request,
  so revoking needs no restart.
- The server never serves an explore pack: a file whose format is not `webobs.client-report` is refused the same way.
- `feedback.to` is removed from the report before it is sent, so the browser never sees the reply address.

## Routes

| Route | What it does |
|---|---|
| `GET /r/<token>` | the viewer page (static; no report inside; told where to fetch by two attributes on `<html>`) |
| `GET /api/r/<token>/report.json` | the report, after the token check |
| `POST /api/r/<token>/feedback` | the client's feedback text; the server emails it to the team |
| `GET /healthz` | `ok` |
| `GET /robots.txt` | `Disallow: /` for crawl politeness only. The protection is the noindex header on every response, not this file. |

Anything else (the home page, a guess, `/sitemap.xml`) is refused like a bad link. There is no home page, no listing and no sitemap.

## Access denied

A request with no valid report gets one plain refusal, whatever the reason: no link, a wrong or malformed link, an expired
or revoked one, a stored name that is not a random id, a report that is missing, or a source that cannot be reached.

- The page route (`/r/...`, `/`, anything that is not `/api/`) answers **403** with a small page that says only
  **Access denied**: no script, no link, no image, no third-party address. The data routes (`/api/...`) answer **404** with the
  same two words as plain text. The answer never redirects and never says which case it was.
- Every refusal, the "too many requests" answer included, is sent at the same fixed time, `DENIED_DELAY_MS` (250 ms) after the request
  arrived, so a missing link, an expired one and a down or slow source cannot be told apart by how long they take. The read of the
  report source is cut off at that same moment: a source that has not answered by then counts as unavailable. With the default folder
  source this never matters. With a remote (https) source, raise `DENIED_DELAY_MS` above the source's normal answer time (for example
  1500), or valid links will be refused when the source is a little slow; all refusals then take that long too.
- A report is checked against the contract's value and shape rules again before it is served (reports can also arrive by folder or
  ssh, which skip the ingest). One that does not fit is refused like any bad link. That check applies the contract's **2 MB** cap and
  requires the **approved** state, so an older report published by folder or ssh that is over 2 MB (the old read cap was 5 MB) or not
  approved is now refused with "Access denied".
- The viewer's error guard (it shows "Access denied" if a report cannot be drawn) is checked by a source test only, not in a browser.
- With a remote https report source, `DENIED_DELAY_MS` must be larger than the source's normal answer time, or valid links are refused.
- The viewer page itself, when it is opened without a report (for example from a file), shows the same single word pair.
- Repeated refusals from one address are slowed down with a 429, as before.

## Where reports are read from

The server reads reports through one small interface (`source.mjs`): `read(id)` returns the text or nothing. The adapter is
chosen only by `REPORT_SOURCE` in the environment, never by a request.

- **`directory`** (default): the folder in `REPORTS_DIR` (a read-only mount such as `/data/reports`). It looks only for `<id>.json`
  directly inside that folder.
- **`https`**: a fixed address in `REPORT_SOURCE_URL` (must be `https://`, with no login, query or fragment). The server does
  `GET <base>/<id>.json`, with `Authorization: Bearer <REPORT_SOURCE_TOKEN>` when a token is set. The host is fixed, TLS is
  required, a redirect is **never** followed (so it cannot lead to another host), there is a time limit
  (`REPORT_SOURCE_TIMEOUT_MS`) and a 5 MB size cap that also holds when the source lies about the size. If the source sends
  `Last-Modified`, the retention period applies to it.

A report is asked for by its **random file id only** (32 lowercase hex characters, from the registry entry): no path, no URL and
no text from a request ever reaches the folder or the address. If the source is down, refuses, redirects, times out, is too
large or returns something that is not a client report, the client sees the same Access denied reply and nothing more.
The token **registry** is separate: it is always read from `REGISTRY_DIR`, never from the report source. There is no
Google Drive or S3 adapter yet; a new one is a small file that returns `read(id)`.

With an https source the server cannot clean up (it only reads), and `cleanup.mjs` works on a local folder, so the owner of the
source removes expired reports. Expiry and revocation in the registry still stop a link at once.

## Safety settings

Every response, including the viewer page, the Access denied page, errors, the health check and `robots.txt`, sends
`X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and denies
framing and sniffing, under a content-security policy that allows no third-party address. The pages repeat the robots and
referrer rules as meta tags. There are no third-party scripts, fonts or analytics, and no sitemap. HSTS is sent whenever HTTPS is
required, and is also expected at your proxy. HTTPS is required: with `TRUST_PROXY=1` the server reads `X-Forwarded-Proto` from the proxy and answers 403 over plain
http (health check excepted). Rate limits, per address in memory: 60 requests a minute, 10 wrong tokens a minute, and 5
feedback messages per link per 10 minutes. Feedback bodies are capped at 20 KB.

## Feedback email

The last step of the tour sends the client's answers and notes to the team. The recipient, subject and sender are decided on the
server, never taken from the browser. The recipient is `WEBOBS_FEEDBACK_TO` (for testing, `feedback@agency.example`);
`WEBOBS_FEEDBACK_SUBJECT` may contain `{client}`. The client sees "Your feedback was sent to the team" when it goes through.

- **No `RESEND_API_KEY` set (default):** each message is written as a JSON file under `OUTBOX_DIR`. Nothing is sent, and no account is needed.
- **`RESEND_API_KEY` set:** the server sends through Resend's HTTP API, from `RESEND_FROM` (a sender you set up and verify in Resend; there is no default).
  The key lives only in the server's environment or `.env`. It is used in one request header and is never logged, echoed or sent to the browser.
- The tests never send a real email: Resend is replaced by a stand-in in `test.mjs`.

## Settings (environment)

`WEBOBS_REPORT_BASE` (the public address of the report app, for example `https://audit.example.com`: the link tools print links from it),
`REPORT_SOURCE` (`directory`, the default, or `https`), `REPORTS_DIR` (/data/reports, for the directory source), `REPORT_SOURCE_URL`, `REPORT_SOURCE_TOKEN`
and `REPORT_SOURCE_TIMEOUT_MS` (5000) for the https source, `DENIED_DELAY_MS` (250), `PORT` (8080), `REGISTRY_DIR` (/data/registry), `APP_FILE` (the built
`report.html`, default `apps/server/app/report.html`), `REQUIRE_HTTPS` (1), `TRUST_PROXY` (1 behind the proxy),
`RETENTION_DAYS` (90, a backstop on the age of a report file; expiry is what normally ends a link), `WEBOBS_FEEDBACK_TO`, `WEBOBS_FEEDBACK_SUBJECT`, `RESEND_API_KEY`, `RESEND_FROM`, `MAIL_MODE` (outbox or resend; chosen from the key if unset), `OUTBOX_DIR`, `RATE_*`.

## Docker with a Cloudflare tunnel

`deploy/Dockerfile` builds an image of the server plus the viewer page. **There is no data in the image**: no reports,
no registry, no key and no `.env` (`.dockerignore` keeps them out; the build stage compiles the viewer from source and only
`report.html` is copied into the final image). `deploy/docker-compose.example.yml` is the setup for a tunnel:

1. The report container joins the Docker network that your `cloudflared` container is on (an external network; the example calls it
   `cloudflared_tunnel`, find yours with `docker network ls`).
2. It **publishes no ports**. Only containers on that network can reach it.
3. In Cloudflare Zero Trust, add a public hostname for the tunnel: `audit.example.com` to service `http://report:8080`.
   Cloudflare ends HTTPS and sends `X-Forwarded-Proto: https` and `CF-Connecting-IP`; the server trusts them (`TRUST_PROXY=1` is
   set in the image) because nothing else can reach it. If you ever publish the port, turn `TRUST_PROXY` off first.
4. Reports and the registry are **read-only mounts** (`/srv/webobs/reports`, `/srv/webobs/registry` in the example), so the
   container cannot change or delete them. The root filesystem is read-only too, all capabilities are dropped, and it runs as an
   unprivileged user.
5. Settings and secrets go in an env file next to your copy of the compose file (copy `.env.example` (repository root)), never in the
   image. Set `WEBOBS_FEEDBACK_TO`, `RESEND_API_KEY` and `RESEND_FROM`; `WEBOBS_REPORT_BASE=https://audit.example.com`.
6. **Cleanup runs on a schedule outside the viewer**, because the viewer cannot delete. The image carries `tools/cleanup.mjs`; run it in a
   one-off container with the data mounted read-write (the command above, under "Scheduling it in production"), from host cron or the
   `cleanup` service in `deploy/docker-compose.yml` (try it first with `--dry-run`).

The current deploy files use one named volume `webobs-data` instead of host folders: `deploy/VPS-STACK-tunnel-both.yml` (Portainer,
both services) and `deploy/docker-compose.yml` (plain compose, with `ingest` and `cleanup` profiles). Guide: `docs/SETUP.md`.

Build and start (you run these; nothing here has been built or run as a container):

```
docker build -f deploy/Dockerfile -t webobs-report:local .
docker compose -f deploy/docker-compose.example.yml up -d
```

Check from another container on the tunnel network, or through the tunnel: `https://audit.example.com/healthz` answers `ok`,
and a wrong link answers **Access denied**.

## HTTPS ingest (optional, off by default)

Instead of dropping files on a volume, the agency's tools can push an approved report to the server over HTTPS and get the link back.
It is a **separate process** (`apps/server/ingest/ingest.mjs`, started with `INGEST_ENABLED=1`) with its own port, reached on the viewer's hostname
through a separate tunnel route for `ingest/*` with its own Cloudflare Access application; the public viewer keeps its read-only mounts. Locks: a Cloudflare Access service token at the edge plus an application secret
(`INGEST_SECRET`) in the server; everything else gets the same plain "Access denied". The server accepts only the contract, picks
the random file name, makes the token (only its hash is stored), and returns the link once. The laptop side is the `https`
publish transport: set `WEBOBS_PUBLISH_TARGET` to the ingest address and `WEBOBS_INGEST_SECRET`, `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` in your environment (not in a file). Threats and limits: `docs/INGEST-SECURITY.md`. Tests:
`node apps/server/ingest/test.mjs`. The compose example has a second, optional `ingest` service.

Started with `INGEST_ENABLED` not `1`, the process prints `ingest is switched off (INGEST_ENABLED is not 1); idling on port ...` and keeps
running: every request answers 503 and the health check shows it as unhealthy on purpose (a stack with the ingest variables unset deploys
cleanly and a restart policy does not loop). Switched on but with a missing or short `INGEST_SECRET`, or with
`INGEST_REQUIRE_ACCESS_HEADER=1` and `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` empty, it prints `ingest not started: <reason>` (names only)
and exits 1. `GET /healthz` and `GET /ingest/healthz` both answer `ok`; the second is reachable through the `ingest/*` tunnel route.

## Moving a report to the server: one command

```
npm run publish:client -- <capture _site-graph.json | name.client-report.json> --client <label> --approve-as "Your Name" --hours 72
```

It (1) exports the allowlisted client JSON from the capture (skipped if you give it an exported file), (2) creates the link,
(3) copies the report and the link entry to the server's data folder, and (4) prints the link **once**. The target comes from
`--to` or `WEBOBS_PUBLISH_TARGET` in `.env` (`user@host:/srv/webobs` over ssh, or a local folder); the link's start from `--base` or
`WEBOBS_REPORT_BASE`. `--dry-run` does everything except the upload, so you can rehearse. The explore pack is made in a temporary folder
only to be thrown away; it is never uploaded. The report is copied first and the link entry last, so a link never points at a
missing report. No password or key is stored anywhere: the upload uses your own ssh keys or agent, with BatchMode so it never waits at a prompt.

### The Studio's Publish button

**Publish** (header and Export tab) builds and checks the client JSON, then runs the same flow as the command, through a small local helper:

1. In a terminal, run `npm run publish:helper`. It prints a one-time start token and listens on `127.0.0.1` only.
2. Paste the token into the Studio's *Publish helper* box and press **Connect**. The token lives in the page's memory only.
3. Press **Publish** (set the hours first if you do not want the default). The helper uploads and the Studio shows the link once, with Copy, and the exact time it stops working. Without a helper (or without
   `WEBOBS_PUBLISH_TARGET` and `WEBOBS_REPORT_BASE` in the helper's `.env`) **Publish saves the file** with the system save dialog instead.

Why a helper: a browser page cannot run ssh and must not hold a secret. The upload credential is your own ssh key on this machine,
used only by the `ssh` and `scp` commands the helper runs; it is never read by the helper, never sent to the page, and not in the built
app (a test checks the built page for it). The helper refuses to start without a terminal (so it cannot run hidden or detached), only
answers `127.0.0.1` and `localhost` (no DNS rebinding), only accepts the Studio's own origins (`WEBOBS_STUDIO_ORIGINS`, default the
local report ports), needs the start token on every call, is rate limited, caps the report size, re-checks the report against the
contract before linking it, and stops itself after 30 idle minutes. Nothing polls it: the Studio calls it only when you press Connect or Publish.
`WEBOBS_PUBLISH_TARGET` and `WEBOBS_REPORT_BASE` are read by the helper and the command only; they are not baked into the page.

### Two ways to upload

| | SSH copy (built) | Upload endpoint with an admin secret (not built) |
|---|---|---|
| How | the script runs ssh and scp with your own keys | the Studio or script sends the file to an admin route on the server with a secret |
| Server volume | stays **read-only** to the web server | the web server needs **write** access to the volume |
| Attack surface | none added; no new route | a public write route guarded by one secret; if it leaks, anyone can publish or overwrite reports |
| Secrets to keep | none in files (ssh keys stay on your machine) | an admin secret on the server and on every machine that publishes |
| Studio button | prepares the file and the command; one paste publishes | a true one-click publish |
| Rate limiting, logging | not needed | needed for the admin route |

Recommendation and what was built: SSH copy, with the local helper above giving the Studio a one-click Publish. The server stays read-only and no new route
or admin secret exists. The upload-endpoint alternative was not built; it would only be worth the risk if the Studio must publish from a machine with no ssh.

Other commands: `node apps/server/tools/make-token.mjs list` (no tokens shown); `make-token.mjs revoke <link-id>` then copy that
link's file in the registry folder to the server again (or delete it there to remove the link). The older age-only
cleanup (`retention.mjs`) was replaced by `reports:cleanup` above.

## Removing an old or mistaken scrape

`node apps/server/scripts/remove-capture.mjs <vault> <domain>` lists exactly what it would move: `sites/<domain>/`, `.web-obs/history/<domain>/` and
an unfinished `.web-obs/staging/<domain>/`, with file counts and sizes, and changes nothing. Adding `--confirm <domain>` moves them to
`<vault>/.web-obs/trash/<domain>-<time>/` with a note on how to restore. It never deletes, and it never touches other sites or reports
you made from the capture. (web-obs 0.2.2 has no delete command; this lives in this project, not in web-obs.)

## Tests (foreground, self-terminating, synthetic data)

- `node apps/server/test.mjs`: token randomness (5,000 tokens), random file names, expiry, extend and cleanup, the token tool, serving, expiry, revocation, retention, rate limits,
  the Access denied reply in every case (status, words, page, timing floor), the headers on every response, both report-source adapters (against a stand-in network), the feedback
  email's content and format, and Resend with a stand-in (no real email), with the server running inside the test process on a random port.
- `node apps/server/test-tunnel-path.mjs`: the one-hostname path through a cloudflared stand-in (ordered routes, full path forwarded): a push
  through `ingest/*` gets a link that opens through the catch-all, viewer paths never reach the ingest, `/ingest/healthz` works, and with
  the routes in the wrong order a push gets "Access denied" and stores nothing.
- `node apps/server/scripts/test-publish-and-remove.mjs <client-report.json>` (or `npm run test:publish`): the one-command publish into a temporary folder, served by the real server, and the safe remove-capture script.
- `node apps/server/e2e.mjs <client-report.json>`: the real viewer in headless Chrome through the server (needs
  `npm run report:build` first). It starts and stops its own server and browser.

## Not done yet

- The container image is built and tested locally (see docs/RELEASE-NOTES.md); there is no automated image build or push pipeline yet.
- Real email: the Resend call is tested only against a stand-in. It needs a Resend key and a sender you verify there.
- Rate limits are per process and in memory; run one instance, or move them to the proxy.
- The registry is a folder of files made by the tool. There is no admin page and no audit log of who opened a link.
- No access log is written, on purpose, because a log line would hold the token in the path. Add logging that redacts it
  before turning anything on.

## A report's look (styles) and the bundled fonts

The ingest accepts a plain report, or ONE request with two named parts (`styles_<hash>` and `data_<hash>`, the hash being the first 12 hex of the SHA-256 of the styles). It checks both, recomputes the hash and stores one file. The viewer server checks the look again and writes it into the first bytes of the page. Fonts come only from `FONTS_DIR` (default: the `fonts` folder beside `server.mjs`); a look can only name `Oswald` or `Inter`. See `docs/STYLES.md`. `node tools/check-styles.mjs <file>` checks a file without sending anything.

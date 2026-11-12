# HTTPS ingest: how it is locked and what happens when something goes wrong

The ingest route lets the agency's tools **push** an approved client report to the server over HTTPS, instead of dropping a file on
a volume. It is optional and **off by default** (`INGEST_ENABLED=1` turns it on). Everything for it lives in
`apps/server/ingest/`, plus the laptop-side transport `apps/server/scripts/lib/publish-https.mjs`. Deleting those removes the feature.

## Shape

```
laptop / Studio / Obsidian plugin
   |  HTTPS  POST /ingest/v1/reports      (Cloudflare Access service token  +  application secret)
   v
Cloudflare edge  --- tunnel --->  ingest container   (the ONLY process with a write mount)  --> reports/ , registry/ , audit log
                                         
client's browser
   |  HTTPS  GET /r/<token>
   v
Cloudflare edge  --- tunnel --->  viewer container   (read-only mounts of the same two folders)
```

* **Write and read are separate processes.** The public viewer has `reports/` and `registry/` mounted read-only and never imports
  the ingest code. The ingest process is the only one that can write, listens on its own internal port, and is reached on the same hostname as the viewer through a separate tunnel route for the path `ingest/*` (to
  `http://ingest:8081`), protected by its own Cloudflare Access application scoped to `/ingest/*`; the viewer's route never reaches it.
* **One route, full path.** The plugin is given only the base address (for example `audit.example.com`) and appends exactly
  `/ingest/v1/reports`. The tunnel forwards the full path unchanged (it does not strip `ingest/`), so the ingest listens on that same
  path. The `ingest/*` route must be listed **above** the catch-all; in the wrong order every push lands on the viewer and gets its
  plain "Access denied", and nothing is stored (`apps/server/test-tunnel-path.mjs` checks both orders).
* **Health checks.** `GET /healthz` (the container probe) and `GET /ingest/healthz` (the same answer, reachable through the
  `ingest/*` route, so behind Access) answer `ok` with no credentials and nothing else.
* **Two locks.** (1) At the Cloudflare edge, a Cloudflare Access policy that accepts only a **service token** for the ingest
  route (`/ingest/*`). The server then also **verifies the Access token** Cloudflare adds (`Cf-Access-Jwt-Assertion`): the RS256 signature
  against your team's public keys, the issuer (`CF_ACCESS_TEAM_DOMAIN`), the audience (`CF_ACCESS_AUD`) and the expiry. A request
  that reaches the container some other way, without a valid token, is refused. If the team's key list cannot be fetched, the
  token counts as invalid (it never fails open). (2) In the server, an **application secret** (`INGEST_SECRET`, at least 32
  characters) sent as a bearer token and compared in constant time. Either one missing or wrong gives the same plain **404
  "Access denied"**, sent at the same fixed time (250 ms) after the request arrived, the rate-limit answer included, with no hint
  which lock failed. The ingest process also refuses to be built switched off, with a short secret, or with the Access check asked
  for but not configured. Started as `node ingest/ingest.mjs`: switched off (`INGEST_ENABLED` is not `1`) it prints one line and
  **idles**: it keeps running and answers 503 to every request, so a stack with the ingest variables unset deploys cleanly and a restart policy does not loop (the container shows running and unhealthy, on purpose); switched on but with a
  missing or short secret, or with the Access check on and `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` empty, it prints a
  plain reason (names only, never a value) and **exits 1**.
* **Two modes.** *Cloudflare mode* (the default; `INGEST_REQUIRE_ACCESS_HEADER` unset or `1`, any value except exactly `0`) is the
  two-lock setup above. *No-edge mode* (`INGEST_REQUIRE_ACCESS_HEADER=0`, **not recommended**) drops lock (1): no Access token is
  checked and nothing at the edge filters callers. It starts only with `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes` (exactly that word) and
  an `INGEST_SECRET` of at least **48** characters; otherwise it prints a plain reason and exits 1, and the server object refuses to be
  built. In this mode it prints `WARNING: ingest running WITHOUT Cloudflare Access: protected only by the app secret, size cap and
  in-app rate limits` on every start. The secret check, the identical 404 with its fixed timing, the rate limits, the size and store
  caps, contract-only validation and the audit log are the same in both modes. Requirements for the reverse proxy and a checklist:
  `docs/SETUP.md`, "Running the ingest without Cloudflare (not recommended)".
* **Only the contract.** The server accepts a `webobs.client-report` with major version 1, review state `approved`, only the
  allowlisted top-level fields and only the allowlisted map fields. It is capped in size (2 MB by default), rate limited, and
  never overwrites a file.
* **The server decides names and secrets.** It picks the random 32-hex file id and the link id, makes the link token, stores only
  the token's SHA-256 hash and the expiry (72 hours by default, at most 720), writes the report first and the link entry last, and
  returns the link **once** in the reply. Nothing from the caller names a file.
* **Audit log.** One JSON line per event with the time, the event, and ids only (link id, file id, size, hours, a reason code). No
  content, no token, no secret, no address, no client name.
* **Credentials on the laptop** come from environment variables (`WEBOBS_INGEST_SECRET`, `CF_ACCESS_CLIENT_ID`,
  `CF_ACCESS_CLIENT_SECRET`) and are never written to the vault's `data.json`, the page, a log or an error message. Reading from
  the operating system's credential store is not built yet.
* **Caller address.** Rate limits (viewer and ingest) use one header, and only when `TRUST_PROXY=1` (not baked into the image; the
  compose file sets it on purpose): `CLIENT_IP_HEADER`, by default `CF-Connecting-IP`, which the tunnel sets itself. Without
  Cloudflare it names the header your reverse proxy sets and overwrites (for example `X-Real-IP`). If the header holds several
  comma-separated entries the **last** one is used (the one the nearest proxy added); it counts only if it is a plain IPv4 or IPv6
  address. Missing or invalid: the connection's address is used (fail safe: behind a proxy all callers then share one bucket,
  which is stricter, never looser). The first entry of `X-Forwarded-For` is never used. The address is never logged
  (`apps/server/clientip.mjs`).
* **HTTPS behind a proxy.** With `TRUST_PROXY=1` both services take the scheme only from `X-Forwarded-Proto` and require exactly
  `https`. Cloudflare sets it; another reverse proxy must set it (replacing any caller value), or every request except the health
  checks is refused. `REQUIRE_HTTPS=0` turns the check off (not recommended).
* **Failed uploads leave nothing behind.** If the last write fails, the report file and the half-written link entry are removed. A
  leftover from a crash is removed by the cleanup tool (`.json.tmp` older than an hour), which should run daily. It is in the image
  as `tools/cleanup.mjs` (see `docs/SETUP.md`, step 9).
* The existing HTTPS **read** adapter (`REPORT_SOURCE=https`) is separate and unchanged.

## What can go wrong, and how each case is limited

| Event | What an attacker gets | What limits it |
|---|---|---|
| **The Cloudflare Access service token leaks** | They pass the edge lock only. They still need the application secret; without it every request is the same 404. | Two independent locks. Rotate the service token in Cloudflare (it takes effect at once); no server change is needed. Keep `INGEST_REQUIRE_ACCESS_HEADER` at its default (`1`) so a request that skipped the edge is also refused. |
| **The application secret leaks** | They clear the server lock but still need to pass the Cloudflare Access policy at the edge. If they can reach the container directly (they should not: it publishes no port), they could upload. | The container publishes no port and sits on the tunnel network only. Rotate `INGEST_SECRET` on the host and the laptop and restart the ingest container. Uploads need the contract, are size and rate capped, and cannot overwrite or read anything. |
| **Both leak** | They can upload contract-shaped reports and get a link back; each upload is a new file with a new random name. They cannot read, list, change or delete anything, and cannot reach existing links. | Rotate both. Review the audit log for unexpected `accepted` lines (ids and times), revoke those link ids (`make-token.mjs revoke`), and remove the files with `cleanup.mjs`. The store has a hard cap (1000 reports), a per-address upload limit (30 per hour) and a 72-hour default life. |
| **Someone floods it** | Wasted CPU and some log lines. | Edge: Cloudflare absorbs volume and Access refuses callers without the token before they reach the server. Server: wrong credentials are rate limited (10 per minute per address, then 429); authorised uploads are rate limited per hour; the body is read only up to the size cap; the store cap (507) stops disk filling. |
| **A bad file is uploaded** | Nothing is stored unless it is a client report on the allowlist. A file with an extra field, a page path, a wrong format, the explore pack, an unapproved report or a wrong version is refused (422) and never written. | The check runs in the server, independent of any client. A test keeps the server's field lists equal to the contract source. The viewer still re-checks the format before it serves anything and never serves anything else. |
| **A report is valid but wrong or embarrassing** | A client sees it through a link. | Reports must be marked `approved` by a person before they leave the laptop, and the link expires (72 hours). Revoke at once with `make-token.mjs revoke <id>`. |
| **Ingest run without Cloudflare Access** (`INGEST_REQUIRE_ACCESS_HEADER=0`, opt-in) | Anyone with network reach to the address can try to guess or brute-force the secret, but only within the rate limits; can flood it within those limits (wasted CPU, log lines, and, if the client-IP header is wrong, a shared bucket that also slows you down); can probe paths and methods and learns nothing (the same 404 at the same time). | `INGEST_SECRET` of 48+ characters, compared in constant time (guessing is not practical); the identical 404 with fixed timing; rate limits per address (10 wrong secrets a minute, 30 uploads an hour); store cap 1000; size cap 2 MB; contract-only validation; start-up refused without `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes`. **Residual risk:** there is no second lock. A leaked secret alone is enough to upload contract-valid reports that become served links, and there is no edge filtering. Prefer a second lock at your proxy (mTLS, basic auth, an IP allow-list) or a VPN (`docs/SETUP.md`). |
| **The ingest route is guessed or scanned** | The same "Access denied" 404 for every path, method and credential failure. | No listing, no error detail, noindex headers, same delay. |
| **The audit log grows** | Disk use. | Lines are small and hold ids only; rotate it with the host's usual log rotation. |
| **The ingest container is compromised** | It can write to `reports/` and `registry/`, which is its job, and could read what is in them. | It runs as an unprivileged user with a read-only root, dropped capabilities and no extra ports. Only the viewer reads the data path to clients. Keep the ingest container off any network except the tunnel. |

## What this does not protect against

* A leaked **laptop**: whoever has the laptop's environment has both secrets. Use disk encryption and keep the secrets out of files.
* Someone who can both reach the container directly **and** knows the secret. Do not publish its port.
* The tunnel account itself: protect the Cloudflare account with a strong password and two-factor sign-in.
* Reports are stored as plain JSON files; encryption at rest is not built.

## Rotating

1. Cloudflare Zero Trust: create a new service token for the ingest application, update `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`
   on the laptop, then delete the old token.
2. New application secret: set `INGEST_SECRET` on the host (restart the ingest container) and `WEBOBS_INGEST_SECRET` on the laptop.

## A look carried by a report (0.1.4)

The ingest now also accepts a styles part. It is checked with the shared validator (fixed names, hex colours, bundled font names, short plain text, 4096 characters at most), the pairing hash is recomputed, and the viewer server checks it again before serving. A leaked ingest secret already allowed uploading reports; it now also allows choosing a look for them. It still cannot run script, load an address from outside or change the stage and map colours, because the look becomes generated CSS variables, an escaped title and a small data block. The worst case is a misleading page, the same as a misleading report text. The audit log records `styles=<hash>` for accepted uploads and reason codes for refusals. Rotate the secret if it leaks (see Rotating).

### 0.1.5 additions

- **Unreadable looks are refused** (422, audit reason `styles-unreadable`), see `docs/STYLES.md`.
- **Agency name and a leaked secret.** Anyone holding the ingest secret can choose the agency name a report shows (title and footer, as plain text). The secret is already the key to uploading reports, so this is not a new kind of access, but it is a new thing the key can do. A possible later control is an optional allow-list of names the ingest accepts. It is not built; rotate the secret if it may have leaked.
- **The integrity seal** (`meta.integrity`) covers the report without its look and is not checked by the ingest, the viewer server or the viewer; it is there for people and tools that want to detect an edited saved file.

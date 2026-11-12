# Setup: VPS, Portainer and a Cloudflare tunnel

For someone with a VPS, Docker with Portainer, and a Cloudflare tunnel (`cloudflared`) already running in a container.
Placeholders: `audit.example.com` is your hostname, `OWNER` your registry account. Synthetic reports only until step 8 passes.

## What you get

- `report` (viewer, port 8080): serves a report only to a valid link `https://audit.example.com/r/<token>`. Public, no login.
- `ingest` (optional, port 8081): the Obsidian plugin pushes approved reports to `https://audit.example.com/ingest/v1/reports`.
  Behind Cloudflare Access (service token) plus an app secret. Off until you switch it on.
- One Docker volume `webobs-data` for reports and links. No published ports: the tunnel is the only way in.

## 1. Create the volume

Portainer: Volumes > Add volume, name `webobs-data`. Or on the VPS:

```
docker volume create webobs-data
```

## 2. The image

Use the public image path you were given in place of `OWNER`, or build your own and push it to a registry you control:
`docker build -f deploy/Dockerfile -t ghcr.io/OWNER/web-obs-client-report:v0.1.7 .` then `docker push` the same name. If your registry needs a login,
add it in Portainer under Registries > Add registry (Custom, or GitHub: registry `ghcr.io`, your user name, and a token that can only read packages).

## 3. Deploy the stack

1. Portainer: Stacks > Add stack, name `webobs`, Web editor.
2. Paste `deploy/VPS-STACK-tunnel-both.yml` (change the `image:` lines to `ghcr.io/OWNER/web-obs-client-report:v0.1.7`).
   Optional helper: instead of typing variables, run  `node apps/server/tools/make-stack-env.mjs`  in your own terminal. It asks where to save the file, then a few questions (the public address you type is remembered, not secret, in a `.last-base` file next to the env file, so next time Enter is enough), makes INGEST_SECRET itself (never shown), and writes a private env file outside any repo or vault. In Portainer choose Environment variables > Load variables from .env file. Check it later with  `--check`, rotate the secret with  `--rotate`, and copy the secret for the plugin with  `--copy-secret` (the plugin's Publish secret must equal INGEST_SECRET). Keep the file private and delete it after deploying.
3. Environment variables: add `WEBOBS_REPORT_BASE` = `https://audit.example.com` (required).
   Optional: `RETENTION_DAYS`, `MAIL_MODE`, `WEBOBS_FEEDBACK_TO`, `RESEND_API_KEY`, `RESEND_FROM`.
4. Leave the ingest OFF for now: do not set `INGEST_ENABLED`.
5. Deploy. After about 30 seconds `webobs-report` shows `healthy`.
6. `webobs-ingest` shows running but `unhealthy`. That is correct while it is switched off: its log says `ingest is switched off (INGEST_ENABLED is not 1); idling on port ...` and every request to it answers 503.

Later, to switch the ingest on (after the tunnel routes in section 4 and the Access application in section 5): set `INGEST_SECRET` (32+ characters), `CF_ACCESS_TEAM_DOMAIN`,
`CF_ACCESS_AUD` and `INGEST_ENABLED` = `1`, then Update the stack. Make the secret with:

```
openssl rand -hex 32
```

If something is wrong (short secret, Access names empty) the ingest exits 1 and Docker keeps restarting it, so its log keeps one plain line
starting `ingest not started:` that names the setting (never its value).

## 4. Tunnel routes, in this order

Zero Trust > Networks > Tunnels > your tunnel > Public hostname. Two routes on the same hostname:

1. `audit.example.com`, path `ingest/*`, service `http://ingest:8081`
2. `audit.example.com`, no path, service `http://report:8080`

The `ingest/*` route must be ABOVE the catch-all. The tunnel forwards the full path, so nothing else is needed.
Wrong order looks like this: every push gets `Access denied` and nothing is stored, because the viewer answered it.

## 5. Cloudflare Access for /ingest only

1. Zero Trust > Access > Service Auth > Create service token. Copy the Client ID and Client Secret now (the secret is shown once).
2. Zero Trust > Access > Applications > Add an application > Self-hosted.
3. Domain `audit.example.com`, path `ingest*`. Nothing else on the hostname.
4. Policy: action Service Auth, include Service Token = the token from 1.
5. Save. Open the application's Overview: copy the `Application Audience (AUD) Tag` into `CF_ACCESS_AUD`.
   **Check it.** If you have more than one Access application on the host, the tag must be the one that accepts the service token on
   `/ingest*`. The login redirect at the host root can show a different (wider) application's tag, so do not copy it from there. The
   truth is the `aud` claim of a token Cloudflare issues for a token-authenticated request to `/ingest/healthz`; the VPS doctor
   (`scripts/webobs-doctor.sh`, `docs/TROUBLESHOOTING.md`) and a failed upload logged as `bad-access-token` tell you when it is wrong.
6. Team domain: Zero Trust > Settings > Custom Pages shows `yourteam.cloudflareaccess.com`. Put that in `CF_ACCESS_TEAM_DOMAIN`.

The viewer has NO Access login: clients open their link with no account.

## 6. Cloudflare rules for the hostname

- Caching > Cache Rules: hostname `audit.example.com`, Bypass cache.
- Rules > Transform Rules > Response Header: set `X-Robots-Tag` = `noindex, nofollow, noarchive`.
- Security > WAF > Rate limiting: for example 60 requests a minute per IP on the hostname, and a much lower one on `/ingest`.
- SSL/TLS > Edge Certificates: Always Use HTTPS on.

## Cloudflare at a glance (the path split)

One hostname, two containers, two protections. Menu names in Zero Trust and the dashboard change from time to time; if a name below is gone, search the dashboard for the setting instead.

| Piece | Value |
|---|---|
| Hostname | `audit.example.com` (your own; the viewer is public here) |
| Tunnel route 1 (first) | path `ingest/*` to `http://ingest:8081` |
| Tunnel route 2 (catch-all) | no path to `http://report:8080` |
| Access application | self-hosted, domain `audit.example.com`, path `ingest*` only |
| Access policy | action Service Auth, include the service token |
| Service token | Client ID and Client Secret (shown once) go to the plugin; never in a file |
| AUD tag | the application's Overview, into `CF_ACCESS_AUD` |
| Team domain | `yourteam.cloudflareaccess.com`, into `CF_ACCESS_TEAM_DOMAIN` |
| Cache rule | bypass cache for the hostname |
| Response header rule | `X-Robots-Tag: noindex, nofollow, noarchive` |
| Rate limit | about 60 requests a minute per IP on the hostname, much lower on `/ingest` |
| HTTPS | Always Use HTTPS on |

## 7. The plugin

1. Publish target: `audit.example.com` (base address only; the plugin adds `/ingest/v1/reports`).
2. Cloudflare Access Client ID and Client Secret: the two values from step 5.1.
3. Publish secret: the same value as `INGEST_SECRET`.
4. These go in Obsidian's secret storage, never in `data.json` or the vault.
5. Publish a SYNTHETIC report (the invented `example-shop.test` fixture). You get a link back once.

## 8. Verify

1. `https://audit.example.com/` shows the plain line "This link is not available. Please request a fresh one."
2. The published link opens the report on your phone.
3. The same link with one letter changed shows the identical refusal.
4. Response headers include `X-Robots-Tag: noindex`:

```
curl -sI https://audit.example.com/ | grep -i x-robots-tag
```

5. The ingest health check without the service token is refused by Access (a login page or 403, never `ok`):

```
curl -si https://audit.example.com/ingest/healthz | head -1
```

## 9. Cleanup (daily)

The viewer cannot delete (read-only volume). The image carries the cleanup tool, and the two main stack files (`deploy/VPS-STACK-tunnel-both.yml` and the bind-mount one) already include a `cleanup` service that runs it once a day: keep it, or run the command below as a scheduled task on the host and delete that service. Without one of the two, expired reports stay on disk. Dry run first:

```
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v webobs-data:/data ghcr.io/OWNER/web-obs-client-report:v0.1.7 node tools/cleanup.mjs --reports /data/reports --registry /data/registry --dry-run
```

Then the same without `--dry-run`. Daily at 03:15 with host cron (`crontab -e`), one line:

```
15 3 * * * docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v webobs-data:/data ghcr.io/OWNER/web-obs-client-report:v0.1.7 node tools/cleanup.mjs --reports /data/reports --registry /data/registry
```

Or use the `cleanup` service in `deploy/docker-compose.yml` (profile `cleanup`, runs once a day).

## Revoking a link

A link made through the ingest can be revoked from the Studio: the links panel lists the links this computer made through the ingest, and **Revoke link** asks the ingest to do it. The viewer then answers the same plain refusal ("This link is not available. Please request a fresh one.") as for any unknown link. Extending an ingest link is not offered; publish a new one.

The same thing without the Studio (the secret is read from the environment; in Access mode add the two Cloudflare headers):

```
curl -s -X POST -H "Authorization: Bearer $INGEST_SECRET" https://audit.example.com/ingest/v1/links/<link id>/revoke
```

**Emergency steps, with nothing but the host.** The link id is the name of the file in the data folder's `registry/` (10 characters, shown in the Studio and in the audit log as `linkId`).

1. On the host, delete that file: `sudo rm <your data folder>/registry/<link id>.json`, or with the named volume: `docker run --rm -v webobs-data:/data alpine rm /data/registry/<link id>.json`.
2. Open the link in a private window. It must show the plain refusal ("This link is not available. Please request a fresh one."). If it still opens, the file you deleted was not the one named by that link id.
3. The report file under `reports/` can stay; the daily cleanup removes files no link points to.

The same steps work for any link, including ones made with `make-token` (see `apps/server/README.md`).

## 10. Teardown

1. Portainer: Stacks > `webobs` > Stop, then Delete.
2. Zero Trust: delete the Access application, the service token, and the `ingest/*` route (and the catch-all if done).
3. Remove the data (this deletes every report and link):

```
docker volume rm webobs-data
```

4. Rotate anything that was used: `INGEST_SECRET`, the service token, `RESEND_API_KEY`.

## Using plain docker compose instead

Use `deploy/docker-compose.yml` with `deploy/.env.example` copied to `deploy/.env`. Viewer only:

```
docker compose -f deploy/docker-compose.yml up -d
```

With the ingest, BOTH `INGEST_ENABLED=1` (in `.env`) and the profile are needed:

```
COMPOSE_PROFILES=ingest docker compose -f deploy/docker-compose.yml up -d
```

## Running the ingest without Cloudflare (not recommended)

This is the **secret-only mode**. It is a supported option, not the stronger one. Everything above assumes Cloudflare: the tunnel, an
Access application on `/ingest*` and the ingest verifying the Access token. That stays the default and the stronger setup. In
secret-only mode the ingest runs without the Access check, but only when you say so in writing, and with less protection. You can
still keep the tunnel and the Cloudflare proxy; what you drop is the Access application (delete or narrow every Access application
that covers `/ingest*`, or uploads are blocked before they reach the ingest). Read this whole section first. Nothing here makes the
setup safe; it describes what is left and what you must do yourself.

Quick path with the helper: answer **n** to "Use Cloudflare Access for the ingest?"; it writes `INGEST_REQUIRE_ACCESS_HEADER=0` and
`INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes` and leaves out the `CF_ACCESS_*` names. Behind the Cloudflare proxy the default
`CLIENT_IP_HEADER` (`CF-Connecting-IP`) is already right. The doctor detects the mode and checks that `GET /ingest/healthz` answers
200 without a token, and names any Access application tag still covering the path.

**Rotating the secret.** Run `node apps/server/tools/make-stack-env.mjs --rotate <file>`, reload the variables in Portainer (clear,
load once, re-pull and redeploy), then put the new value in the plugin's Publish secret box (`--copy-secret <file>` copies it
without showing it). Until both match, uploads are refused. Rotate at once if the secret may have leaked. Links already made keep
working.

**Optional, recommended in this mode:** a Cloudflare WAF rate-limiting rule on the path `/ingest` (for example a few requests a
minute per address) in front of the tunnel. It stops floods before they reach the ingest and costs nothing in the app.

**What protection remains**

- The application secret, `INGEST_SECRET`, at least **48 characters** in this mode (the helper makes 64), sent as a bearer token and
  compared in constant time.
- Identical refusals: every failure (no secret, wrong secret, wrong path or method, plain http) gets the same `404 Access denied`,
  sent at the same fixed time after the request arrived, the rate-limit answer included.
- In-app rate limits per caller address: 10 wrong secrets a minute (then 429), 30 uploads an hour.
- A size cap (2 MB by default) and a store cap (1000 reports by default).
- Contract-only validation: only an approved `webobs.client-report` on the allowlist is stored; nothing is overwritten, read,
  listed or deleted through the ingest.
- The audit log (ids and times only).

**What is lost**

- Cloudflare's edge authentication: there is no Access policy, so anyone who can reach the address can try the secret.
- Edge rate limiting and bot filtering: every request reaches the ingest itself, so floods use its CPU and its limits.
- A second, independent secret: the Access service token is gone. **A leaked `INGEST_SECRET` alone is enough** to upload
  contract-valid reports, which become links the viewer serves.
- Cloudflare's TLS and IP hiding: your server's address is public and your reverse proxy terminates TLS.

**The three variables**

| Name | Value in this mode | Default |
|---|---|---|
| `INGEST_REQUIRE_ACCESS_HEADER` | `0` (exactly; any other value keeps the Access check on) | `1` |
| `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH` | `yes` (exactly; `true` or `1` do not count) | empty |
| `CLIENT_IP_HEADER` | the header your reverse proxy sets, for example `X-Real-IP` (viewer and ingest) | `CF-Connecting-IP` |

Set them like any other variable (Portainer's box, `deploy/.env`, or `node apps/server/tools/make-stack-env.mjs` and answer `n`
to "Use Cloudflare Access for the ingest?"). With `INGEST_REQUIRE_ACCESS_HEADER=0` but no `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes`,
or with a secret shorter than 48 characters, the ingest prints `ingest not started: <reason>` (names only) and exits 1. When it
does start in this mode it prints, on every start:
`WARNING: ingest running WITHOUT Cloudflare Access: protected only by the app secret, size cap and in-app rate limits`.

**Reverse proxy requirements**

- It ends HTTPS with a valid certificate and forwards to `http://report:8080` and, for the path `/ingest/*`, `http://ingest:8081`.
- It **sets** `X-Forwarded-Proto: https` (replacing any value a caller sent). With `TRUST_PROXY=1` both services read only this
  header to decide whether the request came over HTTPS: without it every request except the health checks is refused (the viewer
  answers 403, the ingest its 404). A proxy that appends (`http, https`) is also refused. `REQUIRE_HTTPS=0` switches the check off;
  that is not recommended outside a local test.
- It **sets** the client-IP header named in `CLIENT_IP_HEADER` to the connecting address and overwrites any value a caller sent
  (nginx: `proxy_set_header X-Real-IP $remote_addr;`; Caddy: `header_up X-Real-IP {remote_host}`). The services use the **last**
  comma-separated entry, and only if it is a plain IPv4 or IPv6 address. If the header is missing or not an address, they fall back
  to the connection's address, which is the proxy's: every caller then shares one rate-limit bucket. That is stricter, not looser,
  but a stranger guessing the secret can then lock you out for a minute at a time.
- `TRUST_PROXY=1` (set in the stack files) is only correct when the proxy is the **only** way to reach the containers. **Do not
  publish the ingest port** (8081) or the viewer port: no `ports:` entry; put the proxy on the same Docker network instead.

**Safer alternatives if you are not on Cloudflare**

- Put a second lock in front of `/ingest/*` at your reverse proxy: mutual TLS (a client certificate on the publishing laptop),
  HTTP basic auth, or an IP allow-list of the addresses you publish from. The app secret then stays the second lock.
- Do not expose the ingest to the internet at all: keep port 8081 unpublished and reach it only over a VPN or a private overlay
  network (for example Tailscale or WireGuard), with only the viewer public.
- Or publish by volume or ssh instead of the HTTPS ingest, and leave `INGEST_ENABLED` off.

**Checklist before turning it on**

- [ ] I have read what is lost above and accept that a leaked `INGEST_SECRET` alone allows uploads.
- [ ] `INGEST_SECRET` is at least 48 random characters (the helper's 64), stored only in the host's variables and the plugin's secret storage.
- [ ] `INGEST_REQUIRE_ACCESS_HEADER=0` and `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH=yes` are set, and the ingest log shows the WARNING line.
- [ ] No `ports:` entry for the ingest or the viewer; only the reverse proxy can reach them.
- [ ] The proxy ends HTTPS, sets `X-Forwarded-Proto: https`, and sets and overwrites the header named in `CLIENT_IP_HEADER` on both services.
- [ ] From outside, `https://audit.example.com/ingest/healthz` answers `ok`, and a push with a wrong secret gets `404 Access denied`.
- [ ] Eleven wrong secrets in a minute from one address give a 429 (the rate limit sees separate callers, not just the proxy).
- [ ] If possible, a second lock (mTLS, basic auth, an allow-list or a VPN) is in front of `/ingest/*`.
- [ ] I check the audit log for unexpected `accepted` lines and know how to rotate the secret (`make-stack-env.mjs --rotate`).

## The audit log is capped

The ingest writes one line per event (ids, times and refusal reasons only) to `/data/audit/ingest.log`. So that traffic from the internet cannot fill the volume through log lines, the log rotates by size inside the ingest: at `INGEST_AUDIT_MAX_BYTES` (default 1048576) the file is renamed `ingest.log.1`, older ones shift up, and at most `INGEST_AUDIT_KEEP` old files (default 3) stay in the same folder. The total stays near (keep + 1) times the size. Both names are optional.

## Updating the base image

`deploy/Dockerfile` names its base image by version and digest (both stages the same). To bump it on purpose:

1. `docker pull node:<new version>-alpine` (a Node 24 release, for example `node:24.23.0-alpine`).
2. `docker image inspect node:<new version>-alpine --format '{{index .RepoDigests 0}}'` prints `node@sha256:...`.
3. Put `node:<new version>-alpine@sha256:...` in both `FROM` lines, rebuild, run `npm test` and the container checks, and record the new version and digest in the release notes.

## Updating to 0.1.5 (readable looks, page card)

1. **One Portainer stack with both services (viewer and ingest): redeploy that stack once.** Both services are in the one stack and use the same image (`v0.1.5`), so one redeploy updates both. With `docker compose`, run the same `up -d` once.
2. **Separate stacks: update the viewer first, then the ingest.** An older viewer refuses a stored report that carries a look.
3. **Do not roll back below 0.1.4 while styled links are live.** Version 0.1.3 and earlier refuse a stored report that carries a look, so those links would stop working. Going back to 0.1.4 is fine.
4. A look whose colours cannot be read (for example a very light card colour) is now refused at upload with a message naming the slot. Check a file first with `node tools/check-styles.mjs` (it exits 1 for such a look).

## Updating to 0.1.4 (reports can carry a look)

1. **Server first.** Deploy the new image (`v0.1.4`) for the report viewer AND the ingest together; they share one image. Nothing in the data folder changes, and existing links keep working.
2. **Then the publish tools and the Studio.** A report with a look sent to an older server is refused; the publish tool says so and tells you to update the server. A report without a look goes to any version.
3. Check a styles file before publishing: `docker run --rm -v "$PWD:/work:ro" ghcr.io/OWNER/web-obs-client-report:v0.1.4 node tools/check-styles.mjs /work/my-look.json`. See `docs/STYLES.md`.

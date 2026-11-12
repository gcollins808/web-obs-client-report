# Troubleshooting the report server

Placeholders: `audit.example.com` is your public address, `yourteam.cloudflareaccess.com` your Cloudflare team domain.

## 1. Run the doctor (no secret is ever printed)

On your own computer, from the project folder:

```
node apps/server/tools/make-stack-env.mjs --fingerprints <your env file>
```

It prints, for each variable the stack reads, the name, the length and the first 8 hex characters of its sha256. It also prints a block starting with `cat > ~/webobs-expected.txt`. Paste that block into an ssh session on the VPS. Then copy `scripts/webobs-doctor.sh` to the VPS (paste it with `cat > ~/webobs-doctor.sh` and a heredoc, or scp) and run:

```
sh ~/webobs-doctor.sh
```

It needs only `docker`, `curl` and `sha256sum` on the VPS (no node). Optional: `sh ~/webobs-doctor.sh ~/webobs-expected.txt https://audit.example.com`.

## 2. Reading the output

| Line | Meaning |
|---|---|
| `PASS NAME` | the container holds the same value as your file (same length and fingerprint) |
| `FAIL NAME (container: ... expected: ...)` | the container holds something else. Portainer did not apply your file |
| `SKIP NAME` | the name is not in your file, so nothing to compare |
| `created=` | when the container was made. If it is older than your last stack update, it was not recreated |
| refusal reasons | the last five reasons the ingest wrote to its audit log (times and the reason word only) |
| `GET / -> 302 ... cloudflareaccess.com` | the viewer address is behind Cloudflare Access: clients cannot open links |
| `GET /ingest/healthz -> 403` | blocked without a token, as intended |
| `note: the redirect names an application with another tag` | informational: a wider Access application guards that path. The ingest needs the tag of the application that accepts the service token (the `aud` claim of a real token) |
| `VERDICT` | the first thing to fix |

## 3. The refusal reasons

The ingest answers every refusal with the same `404 Access denied`, so the caller cannot tell why. The audit log (`/data/audit/ingest.log` in the container) holds the reason.

- `bad-secret`: the Publish secret sent differs from `INGEST_SECRET` in the running container. Fix the stack variables (section 4), then put the same value in the plugin's Publish secret box (`node apps/server/tools/make-stack-env.mjs --copy-secret <file>`).
- `bad-access-token`: Cloudflare's token was missing or did not verify. Check `CF_ACCESS_AUD`. It must be the tag of the Access application that ACCEPTS the service token. If two applications exist, the login redirect at the host root can name a different one; the token's `aud` claim is the truth (Application Audience (AUD) Tag: Zero Trust, Access, Applications, the application, Overview) and `CF_ACCESS_TEAM_DOMAIN` (no `https://`). The plugin's Cloudflare Access ID and secret boxes must hold the service token.
- `not-https`: the proxy in front does not send `X-Forwarded-Proto: https`, or `TRUST_PROXY` is not `1`.
- `wrong-route`: the path or method is wrong. The plugin sends `POST /ingest/v1/reports`.

The plugin's own message shows the HTTP status: 3xx means the Access login page answered (token missing or not accepted), 401 a wrong secret, 403 or 404 a Cloudflare block, a wrong route or one of the refusals above.

## 4. Portainer: the clean fix

Portainer keeps the variables of the first deploy. Loading a file adds or overwrites only the names in it, and updating the stack without recreating the containers leaves the old ones running.

1. Stacks, your stack, Editor.
2. Environment variables: switch to Advanced mode and delete everything.
3. Load or paste your env file once. Keep only the names the stack reads (leave out any plugin-only token names). Check every name appears once.
4. Tick **Re-pull image and redeploy**, then **Update the stack**.
5. Run the doctor again. Every line should be `PASS` and `created=` should be new.

## 4b. Secret-only mode

If `INGEST_REQUIRE_ACCESS_HEADER` is `0` in the container, the doctor prints `Mode: secret-only` and does not check `CF_ACCESS_*`. It checks that `INGEST_ACKNOWLEDGE_NO_EDGE_AUTH` is `yes`, that the secret is 48 characters or more, that `GET /ingest/healthz` answers 200 without a token, and that the host root is not an Access login. If `/ingest/healthz` answers 403 or a redirect, another Cloudflare Access application still covers the path: the doctor names the tag in the redirect; delete or narrow that application in Zero Trust, Access, Applications. What protects this mode, what is lost, and how to rotate the secret: `docs/SETUP.md`, "Running the ingest without Cloudflare".

## 5. Cloudflare checklist (Access mode)

**Lesson:** `CF_ACCESS_AUD` must come from the `aud` claim of a token Cloudflare issued for a token-authenticated request to `/ingest/healthz`, not from the login redirect. With two Access applications, the redirect at the host root can name a wider one, and copying its tag makes every upload fail as `bad-access-token` even though everything else is right.

- One Access application whose destination is the host plus the path `ingest*` only, with a **Service Auth** policy that includes your service token. The rest of the host must not be behind Access, or clients cannot open report links.
- The tunnel lists the `ingest/*` route to `http://ingest:8081` before the catch-all to `http://report:8080`.
- `CF_ACCESS_AUD` is the tag of that application. The doctor compares it with the tag named in the Access login redirect.

#!/bin/sh
# webobs-doctor: run on the VPS. Checks that the running containers hold the values you meant, and why the ingest refuses uploads.
# Needs only: docker, curl, sha256sum (or shasum), and a POSIX sh. No node on the host.
# It NEVER prints a secret. For each variable it prints only the name, the length and the first 8 hex of the sha256 (a fingerprint).
#
#   sh webobs-doctor.sh [expected-file] [public-base-url]
#
# expected-file : lines "NAME length fingerprint", made on your laptop by
#                 node apps/server/tools/make-stack-env.mjs --fingerprints <your env file>   (default: ~/webobs-expected.txt)
# public-base-url: default is read from the ingest container (WEBOBS_REPORT_BASE).
# Optional environment: INGEST_C, REPORT_C (container names), AUDIT_LOG (host path of the ingest audit log).
EXPECTED="${1:-$HOME/webobs-expected.txt}"
BASE="${2:-}"
INGEST_C="${INGEST_C:-webobs-ingest}"
REPORT_C="${REPORT_C:-webobs-report}"
AUDIT_LOG="${AUDIT_LOG:-/opt/agency/web-obs/data/audit/ingest.log}"
INGEST_VARS="INGEST_ENABLED INGEST_SECRET CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD WEBOBS_REPORT_BASE"
REPORT_VARS="WEBOBS_REPORT_BASE RETENTION_DAYS MAIL_MODE WEBOBS_FEEDBACK_TO RESEND_API_KEY RESEND_FROM"
NL='
'
PROBLEMS=""
problem() { PROBLEMS="$PROBLEMS$1$NL"; }

if [ ! -r "$EXPECTED" ]; then
  echo "No expected-fingerprints file at $EXPECTED."
  echo "On your laptop run:  node apps/server/tools/make-stack-env.mjs --fingerprints <your env file>  and paste the block it prints here."
  exit 2
fi

sha8() { if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -c1-8; else printf '%s' "$1" | shasum -a 256 | cut -c1-8; fi; }
fp() { printf '%s %s' "${#1}" "$(sha8 "$1")"; }

# Prints "NAME length fingerprint" for each name, computed INSIDE the container. Same maths as the laptop helper.
NODE_FP='const c=require("crypto");for(const n of process.argv.slice(1)){const v=process.env[n]||"";console.log(n,v.length,c.createHash("sha256").update(v).digest("hex").slice(0,8))}'

container_info() { # container
  info=$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}|{{.Created}}|{{.Config.Image}}|{{.Image}}' "$1" 2>/dev/null) || { echo "  $1: NOT FOUND"; problem "Container $1 does not exist: deploy the stack."; return 1; }
  status=${info%%|*}; rest=${info#*|}; health=${rest%%|*}; rest=${rest#*|}; created=${rest%%|*}; rest=${rest#*|}; image=${rest%%|*}; id=${rest#*|}
  digest=$(docker image inspect -f '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}none{{end}}' "$id" 2>/dev/null || echo unknown)
  echo "  $1: status=$status health=$health"
  echo "    created=$created"
  echo "    image=$image"
  echo "    image id=$(printf '%s' "$id" | cut -c1-19)  digest=$digest"
  [ "$status" = "running" ] || problem "Container $1 is $status, not running: look at its logs in Portainer."
  case "$health" in unhealthy) problem "Container $1 reports unhealthy: look at its logs in Portainer.";; esac
  return 0
}

compare_vars() { # container, names
  c=$1; shift
  out=$(docker exec "$c" node -e "$NODE_FP" "$@" 2>/dev/null) || { echo "  cannot run the check inside $c"; return 1; }
  for n in "$@"; do
    want=$(grep "^$n " "$EXPECTED" | head -n 1 | cut -d' ' -f2-)
    got=$(printf '%s\n' "$out" | grep "^$n " | head -n 1 | cut -d' ' -f2-)
    if [ -z "$want" ]; then echo "  SKIP $n (not in the expected file)"; continue; fi
    if [ "$want" = "$got" ]; then echo "  PASS $n"; else
      echo "  FAIL $n   (container: ${got:-unset}   expected: $want)"
      problem "$n in the $c container does not match the file: update the stack in Portainer (clear its variables, load the file once, tick Re-pull image and redeploy)."
    fi
  done
}

echo "== webobs-doctor ($(date -u '+%Y-%m-%d %H:%M UTC')) =="
echo "Containers"
container_info "$INGEST_C" && ING_OK=1 || ING_OK=0
container_info "$REPORT_C" && REP_OK=1 || REP_OK=0

NOEDGE=0
if [ "$ING_OK" = 1 ] && [ "$(docker exec "$INGEST_C" printenv INGEST_REQUIRE_ACCESS_HEADER 2>/dev/null)" = "0" ]; then
  NOEDGE=1; INGEST_VARS="INGEST_ENABLED INGEST_SECRET INGEST_REQUIRE_ACCESS_HEADER INGEST_ACKNOWLEDGE_NO_EDGE_AUTH WEBOBS_REPORT_BASE"
fi
if [ "$NOEDGE" = 1 ]; then echo "Mode: secret-only (no Cloudflare Access on the ingest). The CF_ACCESS_* names are not checked."; elif [ "$ING_OK" = 1 ]; then echo "Mode: Cloudflare Access on the ingest"; fi
if [ "$ING_OK" = 1 ]; then echo "Ingest variables (name, length, fingerprint only)"; compare_vars "$INGEST_C" $INGEST_VARS
  if [ "$NOEDGE" = 1 ]; then
    [ "$(docker exec "$INGEST_C" printenv INGEST_ACKNOWLEDGE_NO_EDGE_AUTH 2>/dev/null)" = "yes" ] || problem "INGEST_ACKNOWLEDGE_NO_EDGE_AUTH is not yes in the ingest container: the ingest refuses to run without Access unless it is yes."
    sl=$(docker exec "$INGEST_C" printenv INGEST_SECRET 2>/dev/null | tr -d '\r\n' | wc -c | tr -d ' ')
    if [ "${sl:-0}" -ge 48 ]; then echo "  PASS secret length is 48 or more"; else problem "INGEST_SECRET is shorter than 48 characters: the secret-only mode needs 48 or more."; fi
  fi
  en=$(docker exec "$INGEST_C" printenv INGEST_ENABLED 2>/dev/null)
  [ "$en" = "1" ] || problem "INGEST_ENABLED is not 1 in the ingest container: set it to 1 in the stack variables and redeploy."
fi
if [ "$REP_OK" = 1 ]; then echo "Viewer variables (name, length, fingerprint only)"; compare_vars "$REPORT_C" $REPORT_VARS; fi

echo "Last refusal reasons (time and reason word only)"
LOGTXT=$(docker exec "$INGEST_C" tail -n 300 /data/audit/ingest.log 2>/dev/null || tail -n 300 "$AUDIT_LOG" 2>/dev/null)
if [ -z "$LOGTXT" ]; then echo "  no audit log found or readable (try sudo, or set AUDIT_LOG)"; else
  printf '%s\n' "$LOGTXT" | sed -n 's/^{"at":"\([^"]*\)","event":"denied","reason":"\([a-z-]*\)".*/  \1  \2/p' | tail -n 5
  printf '%s\n' "$LOGTXT" | grep -q '"event":"denied"' || echo "  none in the last 300 lines"
  last=$(printf '%s\n' "$LOGTXT" | sed -n 's/^{"at":"\([^"]*\)","event":"denied","reason":"\([a-z-]*\)".*/\2/p' | tail -n 1)
  case "$last" in
    bad-secret) problem "The latest refusal was bad-secret: the Publish secret sent differs from the ingest's INGEST_SECRET.";;
    bad-access-token) problem "The latest refusal was bad-access-token: Cloudflare's token was missing or did not match CF_ACCESS_AUD / CF_ACCESS_TEAM_DOMAIN in the container.";;
    not-https) problem "The latest refusal was not-https: the proxy in front does not send X-Forwarded-Proto: https (or TRUST_PROXY is not 1).";;
  esac
fi

if [ -z "$BASE" ] && [ "$ING_OK" = 1 ]; then BASE=$(docker exec "$INGEST_C" printenv WEBOBS_REPORT_BASE 2>/dev/null); fi
echo "Public checks without any token (${BASE:-no address known})"
if [ -z "$BASE" ]; then echo "  skipped: give the public address as the second argument"; elif ! command -v curl >/dev/null 2>&1; then echo "  skipped: curl is not installed"; else
  want_aud=$(grep '^CF_ACCESS_AUD ' "$EXPECTED" | head -n 1 | cut -d' ' -f2-)
  kid_check() { # redirect url
    kid=$(printf '%s' "$1" | sed -n 's/.*[?&]kid=\([0-9a-fA-F]*\).*/\1/p')
    [ -n "$kid" ] || return 0
    if [ -z "$want_aud" ]; then echo "    Access application tag in the redirect: $(fp "$kid") (no expected AUD to compare)"; return 0; fi
    # Informational only: a login redirect names the application guarding THAT path, which may be a wider one than the ingest's.
    # The tag that matters is the aud claim of a token the ingest receives; the plugin's Check publishing reads it from a real token.
    if [ "$(fp "$kid")" = "$want_aud" ]; then echo "    the redirect names the application whose tag is in CF_ACCESS_AUD"; else
      echo "    note: the redirect names an application with another tag (redirect: $(fp "$kid")   CF_ACCESS_AUD: $want_aud). Fine if it is a wider application; the ingest needs the tag of the application that accepts the service token."
    fi
  }
  r=$(curl -s -o /dev/null -m 10 -w '%{http_code} %{redirect_url}' "$BASE/" 2>/dev/null) || r="000 "
  code=${r%% *}; red=${r#* }
  echo "  GET /               -> $code"
  case "$code" in
    30?) case "$red" in *cloudflareaccess.com*) echo "    redirects to the Cloudflare Access login"; kid_check "$red"; problem "The viewer address redirects to the Access login, so clients cannot open report links: scope the Access application to the /ingest* path only (or add a Bypass policy for the rest).";; esac;;
  esac
  r=$(curl -s -o /dev/null -m 10 -w '%{http_code} %{redirect_url}' "$BASE/ingest/healthz" 2>/dev/null) || r="000 "
  code=${r%% *}; red=${r#* }
  echo "  GET /ingest/healthz -> $code"
  case "$code" in
    403|30?) if [ "$NOEDGE" = 1 ]; then
        kid=$(printf '%s' "$red" | sed -n 's/.*[?&]kid=\([0-9a-fA-F]*\).*/\1/p')
        echo "    blocked or redirected although the ingest runs secret-only"
        problem "Another Cloudflare Access application still covers /ingest* (answer $code${kid:+, its tag in the redirect is $kid}): remove or narrow it in Zero Trust > Access > Applications, or Publish is blocked before it reaches the ingest."
      else echo "    blocked without a token, as intended (Cloudflare Access is in front)"; kid_check "$red"; fi;;
    200) if [ "$NOEDGE" = 1 ]; then echo "    answers without a token, as expected in secret-only mode"; else echo "    answers without any token: no Cloudflare Access in front of the ingest path (fine only for the secret-only mode)"; fi;;
    404) problem "GET /ingest/healthz returned 404: the tunnel route for ingest/* is missing or listed after the catch-all (the viewer answered).";;
    000) problem "Could not reach $BASE: check the tunnel and the address.";;
  esac
fi

echo
if [ -z "$PROBLEMS" ]; then echo "VERDICT: PASS. The containers match the file and nothing obvious is wrong. If Publish still fails, check the Publish secret in the plugin against INGEST_SECRET in the file."; exit 0; fi
printf '%s' "$PROBLEMS" | sed 's/^/PROBLEM: /'
first=$(printf '%s' "$PROBLEMS" | head -n 1)
echo "VERDICT: FAIL. First thing to fix: $first"
exit 1

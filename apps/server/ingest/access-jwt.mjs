// Verifies the Cloudflare Access token (the Cf-Access-Jwt-Assertion header) that Cloudflare adds after its policy accepted the caller.
// It checks: the RS256 signature against the team's public keys (JWKS), the issuer (your team domain), the audience (your Access
// application tag), and the expiry / not-before times. Anything wrong, missing or unreachable means "not valid". It never throws.
//
// Names only in the environment (values in your host's env, never in a file):  CF_ACCESS_TEAM_DOMAIN  (for example myteam.cloudflareaccess.com)
//                                                                             CF_ACCESS_AUD          (the application's AUD tag)
import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(s, 'base64url');
const SKEW_S = 60;

/** Keys come from https://<team domain>/cdn-cgi/access/certs, cached; an unknown key id triggers at most one refresh a minute. */
export function makeJwksSource({ teamDomain, fetchImpl = fetch, ttlMs = 3600000, now = () => Date.now(), timeoutMs = 5000 }) {
  let keys = null, at = 0, lastTry = 0;
  const load = async () => {
    lastTry = now();
    try {
      const r = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const j = await r.json();
      if (Array.isArray(j?.keys)) { keys = j.keys; at = now(); }
    } catch { /* unreachable: keep what we had */ }
  };
  return async (kid) => {
    const fresh = keys && now() - at < ttlMs;
    // At most one fetch a minute, whether the list is stale, missing or the last try failed. In between, the keys we have (if any) are used,
    // or none: an unreachable key list means every token is invalid (fail closed), without each request waiting on the network.
    if (!fresh && now() - lastTry > 60000) await load();
    let k = keys?.find((x) => x.kid === kid);
    if (!k && now() - lastTry > 60000) { await load(); k = keys?.find((x) => x.kid === kid); }
    return k || null;
  };
}

/** Returns true only for a valid, unexpired token for this team and this application. */
export async function verifyAccessJwt(token, { teamDomain, audience, getKey, now = () => Date.now() }) {
  try {
    if (typeof token !== 'string' || token.length > 8192) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(b64(parts[0]).toString('utf8'));
    const claims = JSON.parse(b64(parts[1]).toString('utf8'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false; // never "none", never HS256 with a public key
    const jwk = await getKey(header.kid);
    if (!jwk || jwk.kty !== 'RSA') return false;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2]));
    if (!ok) return false;
    const t = Math.floor(now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= t) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > t + SKEW_S)) return false;
    if (claims.iss !== `https://${teamDomain}`) return false;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return aud.includes(audience);
  } catch { return false; }
}

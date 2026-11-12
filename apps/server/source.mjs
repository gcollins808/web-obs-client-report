// Where the server reads client reports from. One small interface, two adapters:
//
//   source.read(id)  ->  { text, mtimeMs }  or  null
//
// `id` is the report's random file id (32 lowercase hex characters) and nothing else: the server never passes a path, a URL or any
// text from a request. The source itself (which folder, which host, which token) comes only from the server's environment.
// "null" means "not available" for every reason (no such report, source down, too large, refused): the caller answers all of
// them with the same access-denied reply, and no detail leaves this file.
//
// The token registry is a different thing: it is read from REGISTRY_DIR and never from the report source.
import fs from 'node:fs';
import path from 'node:path';

export const REPORT_ID = /^[0-9a-f]{32}$/;
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;

/** The file id from a registry entry's stored name ("<32 hex>.json"). Anything else (folders, dots, other names) gives null. */
export function reportIdOf(stored) {
  if (typeof stored !== 'string' || !stored.endsWith('.json')) return null;
  const id = stored.slice(0, -5);
  return REPORT_ID.test(id) ? id : null;
}

/** A folder on this machine or a read-only mount. Looks only for <id>.json directly inside it. */
export function dirSource(dir, { maxBytes = MAX_REPORT_BYTES } = {}) {
  const root = path.resolve(dir);
  return {
    kind: 'directory',
    async read(id) {
      if (!REPORT_ID.test(String(id))) return null;
      const file = path.join(root, id + '.json');
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > maxBytes) return null;
        return { text: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs };
      } catch { return null; }
    },
  };
}

/**
 * A fixed HTTPS address: GET <base>/<id>.json with an optional bearer token. The host is fixed by the configuration: a redirect
 * is never followed (so it can never lead to another host), the connection must be TLS, there is a time limit and a size cap.
 * `fetchImpl` is only for tests.
 */
export function httpsSource({ base, token = '', timeoutMs = 5000, maxBytes = MAX_REPORT_BYTES, fetchImpl = (...a) => fetch(...a) }) {
  let root;
  try { root = new URL(String(base)); } catch { return unavailable('the address is not a valid URL'); }
  if (root.protocol !== 'https:') return unavailable('the address must start with https://');
  if (root.username || root.password || root.search || root.hash) return unavailable('the address must not hold a login, a query or a fragment');
  const prefix = root.origin + root.pathname.replace(/[/]+$/, '');
  return {
    kind: 'https',
    async read(id) {
      if (!REPORT_ID.test(String(id))) return null;
      try {
        const res = await fetchImpl(`${prefix}/${id}.json`, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        });
        if (res.status !== 200) return null; // includes every 3xx: redirects are not followed
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) return null;
        // Read in pieces so a body that lies about its length still cannot pass the cap.
        const chunks = []; let size = 0;
        const reader = res.body?.getReader?.();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
            chunks.push(value);
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxBytes) return null;
          chunks.push(buf);
        }
        const modified = Date.parse(res.headers.get('last-modified') || '');
        return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), mtimeMs: Number.isFinite(modified) ? modified : null };
      } catch { return null; }
    },
  };
}

/** A source that never has anything (a bad setting). `why` is for the start-up notice only, never for a request. */
function unavailable(why) {
  return { kind: 'unavailable', why, async read() { return null; } };
}

/** The adapter named in the configuration. */
export function makeSource(cfg) {
  if (cfg.reportSource === 'https') return httpsSource({ base: cfg.reportSourceUrl, token: cfg.reportSourceToken, timeoutMs: cfg.reportSourceTimeoutMs, fetchImpl: cfg.sourceFetch });
  if (cfg.reportSource === 'directory') return dirSource(cfg.reportsDir);
  return unavailable('REPORT_SOURCE must be "directory" or "https"');
}

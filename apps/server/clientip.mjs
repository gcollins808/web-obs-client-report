// The caller's address, for the in-app rate limits only (it is never logged or stored). Shared by the viewer (server.mjs) and the
// ingest (ingest/ingest.mjs). Plain Node, no imports outside node:.
//
// Rules:
//   * trustProxy false: the address of the TCP connection, nothing else. Headers are ignored.
//   * trustProxy true: ONE configured header (CLIENT_IP_HEADER, default CF-Connecting-IP, matched case-insensitively). Behind
//     Cloudflare the tunnel sets CF-Connecting-IP itself. Behind another reverse proxy, name the header YOUR proxy sets and
//     overwrites (for example X-Real-IP).
//   * If the header holds several comma-separated entries, the LAST one is used: it is the entry added by the nearest proxy, the one
//     you trust. Earlier entries can be text the caller wrote (this is why the first entry of X-Forwarded-For is never used).
//   * The entry is accepted only if it is a plain IPv4 or IPv6 address (no port, no brackets, no spaces, no other text).
//   * Missing or invalid header: FAIL SAFE, the connection's address is used. Behind a proxy that is the proxy's own address, so all
//     callers then share one rate-limit bucket. That only makes the limits stricter, never looser.
import net from 'node:net';

export const DEFAULT_CLIENT_IP_HEADER = 'cf-connecting-ip';

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Hex groups and colons, optionally ending in an embedded IPv4 address; the structure is then confirmed by node:net.
const IPV6 = /^[0-9A-Fa-f:]{2,39}$|^[0-9A-Fa-f:]{2,29}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** True only for a plain IPv4 or IPv6 address. */
export function isIpAddress(s) {
  if (typeof s !== 'string' || s.length < 2 || s.length > 45) return false;
  if (IPV4.test(s)) return true;
  return IPV6.test(s) && s.includes(':') && net.isIPv6(s);
}

/** The header name to read, lower-cased. Empty or not a plain header name: the default (CF-Connecting-IP). */
export function clientIpHeaderName(v) {
  const s = String(v ?? '').trim();
  return HEADER_NAME.test(s) ? s.toLowerCase() : DEFAULT_CLIENT_IP_HEADER;
}

export function clientAddress(req, { trustProxy = false, header = DEFAULT_CLIENT_IP_HEADER } = {}) {
  const socketAddress = req?.socket?.remoteAddress || 'unknown';
  if (!trustProxy) return socketAddress;
  const raw = req.headers?.[clientIpHeaderName(header)];
  if (raw === undefined) return socketAddress;
  const value = Array.isArray(raw) ? raw.join(',') : String(raw);
  const last = value.split(',').pop().trim();
  return isIpAddress(last) ? last : socketAddress;
}

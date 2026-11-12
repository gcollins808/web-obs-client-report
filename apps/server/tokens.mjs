// Link tokens: 32 bytes from the operating system's random source, shown as 43 URL-safe characters. Only the hash is ever stored.
import crypto from 'node:crypto';

export const TOKEN_BYTES = 32;
export const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43,128}$/;

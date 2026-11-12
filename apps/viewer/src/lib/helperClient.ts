// The Studio's connection to the local publish helper (scripts/publish-helper.mjs), which you start yourself in a terminal.
// The start token lives in this page's memory only: never saved, never put in the address. The page asks the helper when you
// press a button; nothing polls it.
import { useSyncExternalStore } from 'react';

export const HELPER_URL = 'http://127.0.0.1:4178';
export interface HelperInfo { targetSet: boolean; target: string | null; baseSet: boolean; vaultSet: boolean; defaultHours: number }

let token = '';
let info = null as HelperInfo | null;
let snap: { token: string; info: HelperInfo | null } = { token, info };
const subs = new Set<() => void>();
const emit = () => { snap = { token, info }; subs.forEach((f) => f()); };
export const useHelper = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => snap);

export function setHelperToken(t: string) { token = t; info = null; emit(); }
export const helperToken = () => token;

/** Calls the helper and returns its JSON. Throws an Error with a plain message. */
export async function helperCall<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T & { ok: true }> {
  let res: Response;
  try {
    res = await fetch(HELPER_URL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token.trim(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('Could not reach the publish helper. Start it yourself in a terminal with: npm run publish:helper');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.message || 'The helper said no.');
  return j;
}

export async function connectHelper(): Promise<HelperInfo> {
  const j = await helperCall<HelperInfo>('/status');
  info = { targetSet: j.targetSet, target: j.target, baseSet: j.baseSet, vaultSet: j.vaultSet, defaultHours: j.defaultHours };
  emit();
  return info;
}
export const helperReady = (h: HelperInfo | null) => Boolean(h?.targetSet && h.baseSet && token.trim());

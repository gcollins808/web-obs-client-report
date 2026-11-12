// Applies one case from bad-values.json to a copy of a report. Shared by the validator test and the ingest test.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const expand = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('$repeat' in v) return (v.prefix ?? '') + v.$repeat.repeat(v.times);
    if ('$list' in v) return Array.from({ length: v.$list }, () => structuredClone(v.of));
    if ('$entries' in v) return Object.fromEntries(Array.from({ length: v.$entries }, (_, i) => [`k${i}`, v.value]));
  }
  return v;
};

const setPath = (root, dotted, value) => {
  const keys = dotted.split('.');
  let o = root;
  keys.slice(0, -1).forEach((k, i) => { if (o[k] === undefined || o[k] === null) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {}; o = o[k]; });
  // defineProperty so that a key named __proto__ becomes a real own key, as JSON.parse would make it
  Object.defineProperty(o, keys[keys.length - 1], { value, enumerable: true, writable: true, configurable: true });
};

export function applyCase(base, c) {
  const r = structuredClone(base);
  setPath(r, c.set, expand(c.value));
  for (const [p, v] of c.also ?? []) setPath(r, p, expand(v));
  return r;
}

export function loadBadValues() {
  return JSON.parse(fs.readFileSync(fileURLToPath(new URL('bad-values.json', import.meta.url)), 'utf8'));
}
export const loadSynthetic = () => JSON.parse(fs.readFileSync(fileURLToPath(new URL('client-report.sample.json', import.meta.url)), 'utf8'));

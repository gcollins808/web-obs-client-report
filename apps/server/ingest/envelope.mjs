// The publish request can carry a report together with a styles file in ONE body: { "styles_<hash>": {...}, "data_<hash>": {...report...} }.
// The two keys are the routing: the part named styles_ is the styles, the part named data_ is the report, and the 12 hex characters must be the
// same in both and must match the hash of the styles (recomputed here from the styles that arrived). A name is a routing hint, never trusted:
// both parts are parsed and checked after routing. A body that is a plain report (no styles_/data_ names at all) is returned untouched, so older
// publishers keep working. Nothing here writes a file.
import { validateStyles } from '../../viewer/brand/styles.mjs';
import { stylesHash, STYLES_KEY, DATA_KEY } from '../../viewer/brand/styles-hash.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEYISH = /^(styles|data)_/;
const KEYISH_IN_TEXT = /"(styles|data)_[0-9a-f]{12}"\s*:/g;

/**
 * Splits a parsed upload body. `text` is the raw body text (to count the names, because JSON.parse silently keeps only the last of two equal names).
 * Returns { kind: 'bare', report } or { kind: 'envelope', report, styles, hash } or { kind: 'error', status, reason, message }.
 */
export function splitEnvelope(parsed, text) {
  try {
    if (!isObj(parsed)) return { kind: 'bare', report: parsed };
    const keys = Object.keys(parsed);
    if (!keys.some((k) => KEYISH.test(k))) return { kind: 'bare', report: parsed };
    const err = (reason, message) => ({ kind: 'error', status: 422, reason, message });
    if (keys.length !== 2) return err('envelope', 'A publish request with styles needs exactly two parts, styles_<hash> and data_<hash>.');
    const sk = keys.find((k) => STYLES_KEY.test(k)), dk = keys.find((k) => DATA_KEY.test(k));
    if (!sk || !dk) return err('envelope', 'A publish request with styles needs exactly two parts, styles_<hash> and data_<hash>.');
    if ((String(text).match(KEYISH_IN_TEXT) || []).length !== 2) return err('duplicate-key', 'A part name appears more than once in the request.');
    const hash = sk.slice(7);
    if (dk.slice(5) !== hash) return err('styles-mismatch', 'The styles part and the data part do not carry the same hash.');
    const v = validateStyles(parsed[sk]);
    if (!v.ok) return err(v.codes.includes('unreadable') ? 'styles-unreadable' : 'styles-invalid', `The styles are not valid: ${v.errors.slice(0, 3).join(' ')}`);
    if (stylesHash(parsed[sk]) !== hash) return err('styles-mismatch', 'The hash in the part names does not match the styles that were sent.');
    const report = parsed[dk];
    if (!isObj(report)) return err('envelope', 'The data part is not a report.');
    if (Object.prototype.hasOwnProperty.call(report, 'styles')) return err('envelope', 'The report must not carry its own styles when a styles part is sent.');
    return { kind: 'envelope', report: { ...report, styles: v.styles }, styles: v.styles, hash };
  } catch { return { kind: 'error', status: 422, reason: 'envelope', message: 'The request could not be read.' }; }
}

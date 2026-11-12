// Types for the plain-JavaScript styles module (so the Studio can import it). The module itself is apps/viewer/brand/styles.mjs.
export function validateStyles(raw: unknown): { ok: boolean; errors: string[]; codes: string[]; styles: Record<string, string> | null };

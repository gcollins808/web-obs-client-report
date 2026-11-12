// Browser-side plumbing: reading a capture from files or a dropped folder, shrinking screenshots, pruning the
// manifest for sharing, and building the self-contained client file (optionally passphrase-encrypted).
import type { SiteGraphManifest } from '../../../../vendor/web-obs/types/site';
import { attentionNodeIds } from '../../../../vendor/web-obs/data/mapAttention';
import { makeCtx, renderText, type Walkthrough } from '../../../../packages/contract/src/core';

export interface LoadedSite {
  manifest: SiteGraphManifest;
  raw: string;
  sha: string;
  /** Files from the site folder keyed by their path relative to it, e.g. "assets/screenshots/full-home-ab12.jpg". */
  files: Map<string, File>;
}

export interface ReportPayload {
  v: 1;
  /** "client" carries no presenter material; "presenter" is your own copy with notes and sync. */
  copy: 'client' | 'presenter';
  createdAt: string;
  walkthrough: Walkthrough;
  manifest: SiteGraphManifest;
  /** Data URIs keyed "logo" or "snap:<nodeId>". */
  images: Record<string, string>;
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Path inside the site folder: strips a leading "sites/<domain>/" or "<domain>/" so manifest paths and folder paths agree. */
export function siteRelative(p: string, domain?: string): string {
  let s = p.replace(/\\/g, '/').replace(/^\/+/, '');
  s = s.replace(/^sites\/[^/]+\//, '');
  if (domain && s.startsWith(domain + '/')) s = s.slice(domain.length + 1);
  return s;
}

export function parseManifest(raw: string): SiteGraphManifest {
  const m = JSON.parse(raw) as SiteGraphManifest;
  if (!m || !Array.isArray(m.nodes) || !Array.isArray(m.edges) || typeof m.domain !== 'string' || !m.stats) {
    throw new Error('This does not look like a Web-Obs _site-graph.json (nodes, edges, domain and stats are required).');
  }
  return m;
}

/** Read a capture from whatever the user gave us: the JSON alone, or the JSON plus (or inside) the site folder. */
export async function loadFromFiles(list: File[]): Promise<LoadedSite> {
  const graph = list.find((f) => f.name === '_site-graph.json') ?? list.find((f) => /\.json$/i.test(f.name) && f.size > 2000);
  if (!graph) throw new Error('No _site-graph.json found. Choose that file, or the site folder that contains it.');
  const bytes = await graph.arrayBuffer();
  const raw = new TextDecoder().decode(bytes);
  const manifest = parseManifest(raw);
  const sha = await sha256Hex(bytes);
  const files = new Map<string, File>();
  const base = (graph as File & { webkitRelativePath?: string }).webkitRelativePath?.replace(/_site-graph\.json$/, '') ?? '';
  for (const f of list) {
    const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name).replace(/\\/g, '/');
    files.set(base && rel.startsWith(base) ? rel.slice(base.length) : (rel.includes('/assets/') ? rel.slice(rel.indexOf('/assets/') + 1) : f.name), f);
  }
  return { manifest, raw, sha, files };
}

/** Flatten a drag-and-drop, including dropped folders. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix + entry.name + '/');
      }
    }
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
  if (entries.length) { for (const e of entries) await walk(e, ''); return out; }
  return [...dt.files];
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
async function toBitmap(blob: Blob): Promise<ImageBitmap> { return createImageBitmap(blob); }

/** Downscale (and optionally crop to the top of a tall page screenshot) into a compact data URI. */
export async function shrinkImage(blob: Blob, o: { maxW: number; cropAspect?: number; quality?: number; type?: 'image/jpeg' | 'image/png' | 'image/webp' }): Promise<string> {
  const bmp = await toBitmap(blob);
  const srcH = o.cropAspect ? Math.min(bmp.height, Math.round(bmp.width * o.cropAspect)) : bmp.height;
  const scale = Math.min(1, o.maxW / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (o.type !== 'image/png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(bmp, 0, 0, bmp.width, srcH, 0, 0, w, h);
  bmp.close?.();
  return canvas.toDataURL(o.type ?? 'image/jpeg', o.quality ?? 0.72);
}

/** The images a walkthrough needs: the brand logo, and the screenshots cited as evidence. */
export async function prepareImages(site: LoadedSite, w: Walkthrough): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const m = site.manifest;
  const find = (p?: string | null) => (p ? site.files.get(siteRelative(p, m.domain)) : undefined);
  const logo = find(m.brandKit?.localLogoAsset);
  if (logo) { try { out.logo = await shrinkImage(logo, { maxW: 360, type: 'image/png' }); } catch { /* undecodable logo: fall back to initials */ } }
  const wanted = new Set<string>();
  for (const i of w.issues) for (const s of i.evidenceShots ?? []) wanted.add(s.nodeId);
  const home = m.nodes.find((n) => n.kind === 'home');
  if (home) wanted.add(home.id);
  for (const id of wanted) {
    const node = m.nodes.find((n) => n.id === id);
    const file = find(node?.snapshot?.screenshot);
    if (!file) continue;
    try { out[`snap:${id}`] = await shrinkImage(file, { maxW: 1000, cropAspect: 0.62, quality: 0.7 }); } catch { /* skip */ }
  }
  return out;
}

export function dataUriToBytes(uri: string): ArrayBuffer {
  const bin = atob(uri.slice(uri.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Pruning: the shared file carries what the globe and the bindings need, not the whole vault manifest.
// ---------------------------------------------------------------------------
export function pruneManifest(m: SiteGraphManifest): SiteGraphManifest {
  const c = structuredClone(m) as SiteGraphManifest & Record<string, unknown>;
  c.nodes = c.nodes.map((n) => {
    const { pageChecks: _p, keywords: _k, simhash: _s, rawPath: _r, externalUrlsSample: _e, ...keep } = n as unknown as Record<string, unknown>;
    return { ...keep, obsidianPath: '', externalUrlsSample: [] } as never;
  });
  c.edges = c.edges.map(({ anchor: _a, targetUrl: _t, rel: _r, ...e }) => e as never);
  if (c.resources) c.resources = c.resources.map((r) => ({ ...r, references: [] })) as never;
  if (c.linkHealth) c.linkHealth = { ...c.linkHealth, results: [], brokenLinks: c.linkHealth.brokenLinks, serverErrors: c.linkHealth.serverErrors, unknownLinks: [] } as never;
  const logos = { localLogoAsset: c.brandKit?.localLogoAsset ?? null, localFaviconAsset: c.brandKit?.localFaviconAsset ?? null, themeColor: c.brandKit?.themeColor ?? null };
  c.brandKit = logos as never;
  delete c.captureProvenance;
  if (c.drift) {
    const d = c.drift as Record<string, unknown>;
    for (const k of ['contentChanges', 'fileChanges', 'wordDeltas']) delete d[k];
  }
  if (c.audit) {
    const a = c.audit as unknown as Record<string, unknown>;
    for (const k of ['linkFixes', 'linkOpportunities', 'duplicates', 'schema', 'keywords', 'paletteContrast']) delete a[k];
  }
  return c;
}

/** The pruned manifest must give identical text and identical globe highlights, or export is refused. */
export function verifyPrune(full: SiteGraphManifest, pruned: SiteGraphManifest, w: Walkthrough): string[] {
  const problems: string[] = [];
  const a = makeCtx(full), b = makeCtx(pruned);
  const texts: string[] = [];
  for (const i of w.issues) { i.whatWeSaw.forEach((c) => texts.push(c.text)); i.whyItMatters.forEach((c) => texts.push(c.text)); i.fix.forEach((s) => texts.push(s)); texts.push(i.title, i.verify, i.severity.basis, i.effort.basis); }
  for (const s of w.scenes) { s.claims?.forEach((c) => texts.push(c.text)); s.tiles?.forEach((t) => texts.push(t.value)); s.stops?.forEach((st) => texts.push(st.caption.text)); if (s.title) texts.push(s.title); }
  for (const t of texts) if (renderText(t, a) !== renderText(t, b)) problems.push(`"${t.slice(0, 60)}" renders differently after pruning`);
  const x = [...attentionNodeIds(full)].sort().join(), y = [...attentionNodeIds(pruned)].sort().join();
  if (x !== y) problems.push('globe attention highlights differ after pruning');
  return problems;
}

// ---------------------------------------------------------------------------
// Export / embed
// ---------------------------------------------------------------------------
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function deriveKey(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 250_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export type Embedded = { enc: false; payload: ReportPayload } | { enc: true; salt: string; iv: string; ct: string };

export async function sealPayload(payload: ReportPayload, passphrase?: string): Promise<Embedded> {
  if (!passphrase) return { enc: false, payload };
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  return { enc: true, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function openEmbedded(e: Embedded, passphrase?: string): Promise<ReportPayload> {
  if (!e.enc) return e.payload;
  if (!passphrase) throw new Error('A passphrase is required.');
  try {
    const key = await deriveKey(passphrase, unb64(e.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) as BufferSource }, key, unb64(e.ct) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as ReportPayload;
  } catch { throw new Error('That passphrase did not open the report.'); }
}

const BS = String.fromCharCode(92);
const escapeJsonForScript = (s: string) => s.split(String.fromCharCode(60)).join(BS + "u003c").split(String.fromCharCode(0x2028)).join(BS + "u2028").split(String.fromCharCode(0x2029)).join(BS + "u2029");
// The built page holds this marker in <body>, after #root. The bundled JS also contains the text (it sits in <head>, before the body), so always use the LAST occurrence.
export const DATA_MARKER = '<!--WO_REPORT_DATA-->';

/** The shell is the app's own HTML (inlined by the build). The embedded data block makes it a client report. */
export function embedIntoShell(shell: string, embedded: Embedded, title: string): string {
  const at = shell.lastIndexOf(DATA_MARKER);
  const anchored = at > 0 && shell.slice(Math.max(0, at - 80), at).includes('id="root"') && shell.indexOf('</body>', at) > at;
  if (!anchored) throw new Error('This page is not the built single-file app, so it cannot be used as an export shell. Run "npm run report:build" and serve dist-report/report.html.');
  const block = '<script id="wo-report-data" type="application/json">' + escapeJsonForScript(JSON.stringify(embedded)) + '</script>';
  const safeTitle = title.split('<').join('').split('&').join('');
  const html = shell.slice(0, at) + block + shell.slice(at + DATA_MARKER.length);
  const t0 = html.indexOf('<title>'), t1 = html.indexOf('</title>');
  return t0 >= 0 && t1 > t0 ? html.slice(0, t0) + '<title>' + safeTitle + html.slice(t1) : html;
}

export async function fetchShell(): Promise<string> {
  const url = location.href.split('#')[0].split('?')[0];
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not read the app shell (${res.status}).`);
  return res.text();
}

export function readEmbedded(): Embedded | null {
  const el = document.getElementById('wo-report-data');
  if (!el?.textContent) return null;
  try { return JSON.parse(el.textContent) as Embedded; } catch { return null; }
}

export function downloadBlob(name: string, data: string | Blob, type = 'text/plain'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export type SaveResult = 'saved' | 'downloaded' | 'cancelled';
interface FileHandleLike { createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }

/**
 * Save a text file. Where the browser supports it (Chrome, Edge) the person chooses the folder and name and the file
 * is written straight there; elsewhere, or if that is blocked, it falls back to a normal download.
 */
export async function saveFile(name: string, data: string, mime = 'application/json'): Promise<SaveResult> {
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileHandleLike> };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'JSON file', accept: { [mime]: ['.json'] } }] });
      const stream = await handle.createWritable();
      await stream.write(data);
      await stream.close();
      return 'saved';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
      /* picker blocked or unavailable here: fall through to a download */
    }
  }
  downloadBlob(name, data, mime);
  return 'downloaded';
}

// The one publish flow, used by both the command (apps/server/scripts/publish-client-report.mjs) and the Studio's Publish button
// (apps/server/scripts/publish-helper.mjs): create the link for an exported client report, copy the report and the link entry to the
// server's data folder, return the link. The upload uses ssh and scp with the agency machine's own keys; nothing secret is read
// from a file or passed in, and nothing here is ever sent to a browser except the finished link.
import { publishHttps, parseHttpsTarget, recordLink, capturedAtOf } from './publish-https.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateStyles } from '../../../viewer/brand/styles.mjs';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export class PublishError extends Error { constructor(message, code = 'failed') { super(message); this.code = code; } }

/** Fields a client report may have at the top level (kept equal to REPORT_FIELDS in packages/contract/src/contract.ts; a test checks it). */
export const REPORT_FIELDS = ['format', 'version', 'meta', 'client', 'feedback', 'labels', 'summary', 'findings', 'glossary', 'map', 'assets', 'modes', 'styles'];

/** The label kept in your local index only; it never reaches the server or a file name. */
export const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const SSH_TARGET = /^([A-Za-z0-9._-]+@[A-Za-z0-9.-]+):(\/[A-Za-z0-9._/~-]*)$/;

export function parseTarget(target) {
  const t = String(target || '').trim();
  if (!t) return null;
  if (/^https?:[/][/]/i.test(t)) { const h = parseHttpsTarget(t); if (h) return h; throw new PublishError('The ingest address must be https://... (plain http only for this machine).', 'bad-target'); }
  const m = SSH_TARGET.exec(t);
  if (m) return { kind: 'ssh', host: m[1], dir: m[2].replace(/[/]+$/, '') };
  if (path.isAbsolute(t)) return { kind: 'local', dir: t };
  throw new PublishError('The upload target must be user@host:/absolute/path or an absolute local folder.', 'bad-target');
}
/** The host part only, safe to show on screen. */
export const describeTarget = (t) => (t.kind === 'ssh' ? t.host : t.kind === 'https' ? new URL(t.url).host : 'a local folder');

/** Checks a client report the same way before it is linked, wherever it came from. */
export function checkReportFile(report) {
  if (!report || typeof report !== 'object') throw new PublishError('That is not a report.', 'bad-report');
  if (report.format === 'webobs.explore-pack') throw new PublishError('That is the agency-only explore pack. It never goes on the server.', 'bad-report');
  if (report.format !== 'webobs.client-report') throw new PublishError('That is not a client report.', 'bad-report');
  if (report.meta?.review?.state !== 'approved') throw new PublishError('The report is not approved yet.', 'not-approved');
  const extra = Object.keys(report).filter((k) => !REPORT_FIELDS.includes(k));
  if (extra.length) throw new PublishError(`The report has fields outside the contract (${extra.slice(0, 3).join(', ')}).`, 'bad-report');
  // A look the report carries is checked here with the same function the upload and the server use, so a bad one never leaves this machine.
  if (report.styles !== undefined) { const v = validateStyles(report.styles); if (!v.ok) throw new PublishError(`The report's styles are not valid: ${v.errors.slice(0, 2).join(' ')}`, 'bad-report'); }
}

const run = (cmd, args, what) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const last = (r.stderr || '').trim().split(String.fromCharCode(10)).slice(-1)[0];
    throw new PublishError(`${what} failed${last ? ': ' + last : ''}`, 'upload-failed');
  }
  return r.stdout;
};

/**
 * @param {{ reportFile: string, slug: string, hours?: number, indexFile?: string, target?: string, base?: string, dry?: boolean }} o
 * @returns {{ link: string, id: string, expires: string, steps: string[] }}
 */
export function publishReport(o) {
  if (!SLUG.test(String(o.slug || ''))) throw new PublishError('The client name must be letters, digits, dot, dash or underscore.', 'bad-slug');
  const hours = Number(o.hours ?? 72);
  if (!(hours > 0 && hours <= 720)) throw new PublishError('Hours must be between 1 and 720.', 'bad-hours');
  const target = parseTarget(o.target);
  if (!target && !o.dry) throw new PublishError('No upload target is set (WEBOBS_PUBLISH_TARGET).', 'no-target');
  const base = String(o.base || 'https://reports.example.com').replace(/[/]+$/, '');
  checkReportFile(JSON.parse(fs.readFileSync(o.reportFile, 'utf8')));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-publish-'));
  const steps = [];
  try {
    const stage = path.join(work, 'stage');
    const made = run(process.execPath, [path.join(root, 'apps', 'server', 'tools', 'make-token.mjs'), 'create', '--report', o.reportFile, '--client', o.slug, '--hours', String(hours), '--out', stage, '--base', base, ...(o.indexFile ? ['--index', o.indexFile] : [])], 'Creating the link');
    const token = /[/]r[/]([A-Za-z0-9_-]+)/.exec(made)?.[1];
    const id = /link id\s+(\w+)/.exec(made)?.[1];
    const expires = /expires\s+(\S+)/.exec(made)?.[1];
    if (!token || !id) throw new PublishError('The link could not be created.', 'failed');
    steps.push(`link created (id ${id}, expires ${expires})`);

    const files = [];
    const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, rel + e.name + '/'); else files.push(rel + e.name); } };
    walk(stage);
    const reports = files.filter((f) => f.startsWith('reports/')), entries = files.filter((f) => f.startsWith('registry/'));
    // The report first and the link entry last, so a link never points at a missing report.
    if (o.dry) steps.push('dry run: nothing uploaded, so the link does not work');
    else if (target.kind === 'ssh') {
      const opts = ['-o', 'BatchMode=yes'];
      run('ssh', [...opts, target.host, 'mkdir', '-p', `${target.dir}/reports`, `${target.dir}/registry`], 'Creating folders on the server over ssh');
      for (const f of reports) run('scp', [...opts, '-q', path.join(stage, f), `${target.host}:${target.dir}/reports/`], 'Copying the report over scp');
      for (const f of entries) run('scp', [...opts, '-q', path.join(stage, f), `${target.host}:${target.dir}/registry/`], 'Copying the link entry over scp');
      steps.push(`uploaded to ${target.host}`);
    } else {
      for (const f of reports.concat(entries)) { const dest = path.join(target.dir, f); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(stage, f), dest); }
      steps.push('copied to a local folder');
    }
    return { link: `${base}/r/${token}`, id, expires, steps };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Publishes over whichever transport the target names. The https transport is async; ssh and local folder finish at once. */
export async function publishAny(o) {
  const target = parseTarget(o.target);
  if (target?.kind === 'https') {
    if (!SLUG.test(String(o.slug || ''))) throw new PublishError('The client name must be letters, digits, dot, dash or underscore.', 'bad-slug');
    if (o.dry) return { link: '', id: '', expires: '', steps: ['dry run: nothing uploaded'] };
    const r = await publishHttps({ reportFile: o.reportFile, target, hours: o.hours, PublishError, checkReportFile, env: o.env, fetchImpl: o.fetchImpl });
    // The server cannot list its links, so the Studio's links panel works from the local index (never uploaded).
    try { recordLink(o.indexFile, { linkId: r.id, fileId: '', client: String(o.slug), capturedAt: capturedAtOf(o.reportFile), createdAt: new Date().toISOString(), expiresAt: r.expires, via: 'https' }, o.env); } catch { /* the link works without an index entry */ }
    return r;
  }
  return publishReport(o);
}

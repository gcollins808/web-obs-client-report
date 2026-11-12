// Agency side: connect the local publish helper, archive a capture, see published links and revoke one.
// Everything that touches files or the server goes through the helper you started in a terminal; this page holds no credential.
// Nothing here deletes: archiving moves a capture to the vault's trash folder, and revoking stops a link from working.
import { useState } from 'react';
import { connectHelper, helperCall, setHelperToken, useHelper } from '../lib/helperClient';

const mb = (b: number) => (b / 1048576).toFixed(1) + ' MB';
interface Capture { domain: string; files: number; bytes: number }
interface Plan { domain: string; items: Array<{ label: string; rel: string; files: number; bytes: number }>; files: number; bytes: number }
interface LinkRow { id: string; client: string; createdAt: string; expiresAt: string; revoked: boolean }

/** The start-token box. Used in the Export tab and in the manage panel; they share one connection. */
export function HelperConnect({ onNotice, onError }: { onNotice: (m: string) => void; onError: (m: string | null) => void }) {
  const h = useHelper();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onError(null);
      const i = await connectHelper();
      onNotice(i.targetSet && i.baseSet ? `Helper connected. Publish will upload to ${i.target}.` : 'Helper connected, but WEBOBS_PUBLISH_TARGET or WEBOBS_REPORT_BASE is not set in its .env, so Publish will save the file instead.');
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="ad-helper">
      <b>Publish helper</b>
      <p className="ad-lead">Start the helper yourself in a terminal (<code>npm run publish:helper</code>) and paste the start token it prints. It runs on this computer only and holds your upload key, so this page never does.</p>
      <div className="ad-row">
        <input type="password" autoComplete="off" spellCheck={false} placeholder="Start token from the terminal" value={h.token} onChange={(e) => setHelperToken(e.target.value)} aria-label="Publish helper start token" />
        <button disabled={!h.token.trim() || busy} onClick={() => void go()}>Connect</button>
      </div>
      <small>{h.info ? (h.info.targetSet && h.info.baseSet ? `Connected: Publish uploads to ${h.info.target}.` : 'Connected, but the helper has no publish target or link address set; Publish will save the file.') : 'Not connected.'}</small>
    </div>
  );
}

export function Manage({ onNotice, onError }: { onNotice: (m: string) => void; onError: (m: string | null) => void }) {
  const h = useHelper();
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [typed, setTyped] = useState('');
  const [revoking, setRevoking] = useState<LinkRow | null>(null);
  const [extending, setExtending] = useState<LinkRow | null>(null);
  const [extendHours, setExtendHours] = useState(72);
  const [busy, setBusy] = useState<string | null>(null);
  const guard = async (what: string, fn: () => Promise<void>) => { setBusy(what); onError(null); try { await fn(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); } };

  const loadCaptures = () => guard('Reading captures…', async () => { setCaptures((await helperCall<{ captures: Capture[] }>('/captures')).captures); });
  const loadLinks = () => guard('Reading links…', async () => { setLinks((await helperCall<{ links: LinkRow[] }>('/links')).links); });
  const preview = (domain: string) => guard('Checking what would move…', async () => { setTyped(''); setPlan((await helperCall<{ plan: Plan }>('/archive/preview', { domain })).plan); });
  const archive = () => plan && guard('Moving to the trash folder…', async () => {
    const r = await helperCall<{ moved: { domain: string; trash: string; files: number } }>('/archive', { domain: plan.domain, confirm: typed });
    onNotice(`Moved ${r.moved.files} files of ${r.moved.domain} to ${r.moved.trash}/. Nothing was deleted; REMOVED.txt there says how to restore it.`);
    setPlan(null); setTyped('');
    setCaptures((await helperCall<{ captures: Capture[] }>('/captures')).captures);
  });
  const revoke = () => revoking && guard('Revoking…', async () => {
    await helperCall('/links/revoke', { id: revoking.id });
    onNotice(`Link ${revoking.id} for ${revoking.client} is revoked. It stops working for the client right away.`);
    setRevoking(null);
    setLinks((await helperCall<{ links: LinkRow[] }>('/links')).links);
  });
  const extend = () => extending && guard('Extending…', async () => {
    const r = await helperCall<{ expiresAt: string }>('/links/extend', { id: extending.id, hours: extendHours });
    onNotice(`Link ${extending.id} for ${extending.client || 'this client'} now works until ${new Date(r.expiresAt).toLocaleString()}.`);
    setExtending(null);
    setLinks((await helperCall<{ links: LinkRow[] }>('/links')).links);
  });
  const status = (l: LinkRow) => (l.revoked ? 'Revoked' : Date.parse(l.expiresAt) <= Date.now() ? 'Expired' : 'Active');

  return (
    <section className="ad-manage">
      <h2>Captures and published links</h2>
      <HelperConnect onNotice={onNotice} onError={onError} />
      {busy && <p className="ad-busy">{busy}</p>}

      <h3>Captures in your vault</h3>
      <p className="ad-lead">Archive an old or mistaken scrape. It is <b>moved</b> to a trash folder inside your vault with a note on how to restore it, never deleted. Needs <code>WEBOBS_VAULT</code> in the helper's .env.</p>
      <div className="ad-row"><button disabled={!h.info || Boolean(busy)} onClick={() => void loadCaptures()}>{captures ? 'Refresh list' : 'Show my captures'}</button></div>
      {captures && (captures.length === 0 ? <p>No captures found.</p> : (
        <table className="ad-table"><thead><tr><th>Site</th><th>Files</th><th>Size</th><th /></tr></thead>
          <tbody>{captures.map((c) => <tr key={c.domain}><td>{c.domain}</td><td>{c.files}</td><td>{mb(c.bytes)}</td><td><button disabled={Boolean(busy)} onClick={() => void preview(c.domain)}>Archive capture…</button></td></tr>)}</tbody></table>
      ))}
      {plan && (
        <div className="ad-confirm" role="alertdialog" aria-label={`Archive ${plan.domain}`}>
          <b>Archive {plan.domain}?</b>
          <p>These folders will be moved to <code>.web-obs/trash/{plan.domain}-&lt;time&gt;/</code> inside your vault. Nothing is deleted.</p>
          <ul>{plan.items.map((i) => <li key={i.rel}><code>{i.rel}/</code> ({i.label}): {i.files} files, {mb(i.bytes)}</li>)}</ul>
          <p className="ad-small">Other sites, and any report you made from this capture, are not touched. In total {plan.files} files, {mb(plan.bytes)}.</p>
          <label>Type <b>{plan.domain}</b> to confirm <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Type the domain to confirm" /></label>
          <div className="ad-row"><button className="ad-primary" disabled={typed !== plan.domain || Boolean(busy)} onClick={() => void archive()}>Move to the trash folder</button><button onClick={() => { setPlan(null); setTyped(''); }}>Cancel</button></div>
        </div>
      )}

      <h3>Published links</h3>
      <p className="ad-lead">Links you have published. Revoking one stops it working for the client straight away; the report file stays on the server until it expires from retention.</p>
      <div className="ad-row"><button disabled={!h.info || Boolean(busy)} onClick={() => void loadLinks()}>{links ? 'Refresh list' : 'Show published links'}</button></div>
      {links && (links.length === 0 ? <p>No links published yet.</p> : (
        <table className="ad-table"><thead><tr><th>Client (this computer only)</th><th>Link id</th><th>Made</th><th>Works until</th><th>Status</th><th /></tr></thead>
          <tbody>{links.map((l) => <tr key={l.id}><td>{l.client || '(not in this computer\'s index)'}</td><td><code>{l.id}</code></td><td>{new Date(l.createdAt).toLocaleString()}</td><td>{new Date(l.expiresAt).toLocaleString()}</td><td>{status(l)}</td>
            <td>{status(l) !== 'Revoked' && <button disabled={Boolean(busy)} onClick={() => { setExtendHours(h.info?.defaultHours ?? 72); setExtending(l); setRevoking(null); }}>Extend…</button>} {status(l) === 'Active' && <button disabled={Boolean(busy)} onClick={() => { setRevoking(l); setExtending(null); }}>Revoke…</button>}</td></tr>)}</tbody></table>
      ))}
      {extending && (
        <div className="ad-confirm" role="alertdialog" aria-label={`Extend link ${extending.id}`}>
          <b>Extend this link?</b>
          <p>Client <b>{extending.client || 'unknown'}</b>, link id <code>{extending.id}</code>, currently works until {new Date(extending.expiresAt).toLocaleString()}.</p>
          <label>Make it work for <input type="number" min={1} max={720} value={extendHours} onChange={(e) => setExtendHours(Math.max(1, Math.min(720, Number(e.target.value) || 72)))} style={{ width: '4.5rem' }} aria-label="Hours to extend" /> hours from now</label>
          <p><b>New expiry: {new Date(Date.now() + extendHours * 3600000).toLocaleString()}</b> (this replaces the old time; the report file is kept until then).</p>
          <div className="ad-row"><button className="ad-primary" disabled={Boolean(busy)} onClick={() => void extend()}>Extend link</button><button onClick={() => setExtending(null)}>Cancel</button></div>
        </div>
      )}
      {revoking && (
        <div className="ad-confirm" role="alertdialog" aria-label={`Revoke link ${revoking.id}`}>
          <b>Revoke this link?</b>
          <p>Client <b>{revoking.client}</b>, link id <code>{revoking.id}</code>, works until {new Date(revoking.expiresAt).toLocaleString()}. The client will see "This link has expired. Please ask your agency for a fresh one." right away. This cannot be undone; you would publish a new link instead.</p>
          <div className="ad-row"><button className="ad-primary" disabled={Boolean(busy)} onClick={() => void revoke()}>Revoke link</button><button onClick={() => setRevoking(null)}>Cancel</button></div>
        </div>
      )}
    </section>
  );
}

import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../vendor/web-obs/styles/theme.css';
import '../../../vendor/web-obs/styles/ui.css';
import '../../../vendor/web-obs/styles/map.css';
import './styles.css';
import './viewer.css';
import { Admin } from './components/Admin';
import { Viewer, type ReportData } from './components/Viewer';
import { openEmbedded, readEmbedded, type Embedded } from './lib/files';
import { PackageViewer } from './components/PackageViewer';
import { ExploreViewer } from './components/ExploreViewer';
import { holdForFonts } from './lib/brand';
import type { ClientReport, ExplorePack } from '../../../packages/contract/src/package';

/** A client file carries its data in the page. Without it, this is the hosted studio. */
function ClientApp({ embedded }: { embedded: Embedded }) {
  const [data, setData] = useState<ReportData | null>(null);
  const [copy, setCopy] = useState<'client' | 'presenter'>('client');
  const [sha, setSha] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unlock = async (p?: string) => {
    setBusy(true); setError(null);
    try {
      const payload = await openEmbedded(embedded, p);
      setCopy(payload.copy === 'presenter' ? 'presenter' : 'client');
      setSha(payload.walkthrough.source.manifestSha256.slice(0, 16));
      setData({ walkthrough: payload.walkthrough, manifest: payload.manifest, images: payload.images });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (!embedded.enc) void unlock(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  if (data) {
    const narrow = window.matchMedia?.('(max-width: 760px)').matches;
    const hash = location.hash.replace('#', '');
    const presenterCopy = copy === 'presenter';
    const clean = hash === 'clean';
    return <Viewer data={data} notes={presenterCopy && !clean} startWithPresenter={presenterCopy && !clean} syncKey={presenterCopy ? `wo-report-${sha}` : undefined}
      initialMode={hash === 'read' || (narrow && hash !== 'present' && !presenterCopy) ? 'read' : 'present'} />;
  }
  if (embedded.enc) {
    return (
      <div className="ad-root ad-lock">
        <form className="ad-lockcard" onSubmit={(e) => { e.preventDefault(); void unlock(pass); }}>
          <h1>Protected website walkthrough</h1>
          <p>This report is protected. Enter the passphrase you were given.</p>
          <input type="password" autoFocus autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Passphrase" />
          <button className="ad-primary" disabled={busy || !pass}>{busy ? 'Opening…' : 'Open report'}</button>
          {error && <p className="ad-error" role="alert">{error}</p>}
        </form>
      </div>
    );
  }
  return <div className="ad-root ad-lock"><p>{error ?? 'Opening…'}</p></div>;
}

/** The one line shown for EVERY failure (a wrong, expired or revoked link, a report that cannot be fetched or read, an error while drawing it). Nothing says which case it was. Same words as the server's refusal page. */
export const UNAVAILABLE = 'This link is not available. Please request a fresh one.';

/** Opens a Client Report Package (.json): from ?report=<same-origin url> or a file the person chooses. */
function PackageApp() {
  const [report, setReport] = useState<ClientReport | null>(null);
  const [pack, setPack] = useState<ExplorePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Served by the report server: the page is told where its report lives and the server has already checked the link.
  const serverReport = document.documentElement.dataset.serverReport;
  const load = (text: string) => {
    try {
      const j = JSON.parse(text) as ClientReport;
      if (serverReport && (j as unknown as { format?: string }).format !== 'webobs.client-report') throw new Error(UNAVAILABLE);
      if ((j as unknown as { format?: string }).format === 'webobs.explore-pack') { setPack(j as unknown as ExplorePack); setError(null); return; }
      if (j.format !== 'webobs.client-report') throw new Error(UNAVAILABLE);
      if (String(j.version).split('.')[0] !== '1') throw new Error(UNAVAILABLE);
      // With a branded look, hold the first draw until its fonts are ready (a short, calm wait; at most about 1.5 seconds).
      void holdForFonts().then(() => { setReport(j); setError(null); });
    } catch (e) { setError(UNAVAILABLE); }
  };
  useEffect(() => {
    if (serverReport) { fetch(serverReport, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); return r.text(); }).then(load).catch(() => setError(UNAVAILABLE)); return; }
    const u = new URLSearchParams(location.search).get('report');
    if (u && /^[\w./-]+$/.test(u)) fetch(u).then((r) => r.text()).then(load).catch(() => setError(UNAVAILABLE));
  }, []);
  if (report) return <RenderGuard><PackageViewer report={report} /></RenderGuard>;
  if (pack) return <RenderGuard><ExploreViewer pack={pack} /></RenderGuard>;
  // A refresh reloads from the same address (the link, or ?report=). With nothing to load, say so plainly: there is no file to drop in.
  const hasSource = Boolean(serverReport) || new URLSearchParams(location.search).has('report');
  return (
    <div className="pv-open rp-root rp-dark">
      {/* One plain refusal for every case: nothing says why. While the report is on its way (a refresh, a slow network) only a quiet line
          appears, after a moment: no box and nothing that looks like a place to drop a file. */}
      {error || !hasSource
        ? <div className="pv-dropbox" role="alert"><h1>{UNAVAILABLE}</h1></div>
        : <p className="pv-loading" role="status">Opening your website review</p>}
    </div>
  );
}

/** If a report has a shape the viewer cannot draw (wrong types), show the same plain refusal as every other failure instead of a blank page. */
class RenderGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="pv-open rp-root rp-dark"><div className="pv-dropbox" role="alert"><h1>{UNAVAILABLE}</h1></div></div>;
  }
}

const wantsViewer = new URLSearchParams(location.search).has('report') || location.hash.startsWith('#view') || document.documentElement.dataset.start === 'viewer';
const embedded = wantsViewer ? null : readEmbedded();
createRoot(document.getElementById('root')!).render(<StrictMode>{wantsViewer ? <PackageApp /> : embedded ? <ClientApp embedded={embedded} /> : <Admin />}</StrictMode>);

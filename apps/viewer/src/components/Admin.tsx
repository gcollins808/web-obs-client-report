import { Manage, HelperConnect } from './Manage';
import { helperCall, helperReady, useHelper } from '../lib/helperClient';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HORIZONS, LABELS, OWNER_LABEL, horizonFor, makeCtx, renderText, stripForClient, validate,
  type Claim, type Issue, type Label, type Level, type Owner, type Problem, type Scene, type Size, type Walkthrough,
} from '../../../../packages/contract/src/core';
import { buildDraft } from '../../../../packages/contract/src/draft';
import {
  DATA_MARKER, sha256Hex, downloadBlob, saveFile, embedIntoShell, fetchShell, filesFromDrop, loadFromFiles, prepareImages, pruneManifest, sealPayload, verifyPrune,
  type LoadedSite, type ReportPayload,
} from '../lib/files';
import { Viewer } from './Viewer';
import { PackageViewer } from './PackageViewer';
import { validateStyles } from '../../brand/styles.mjs';
import { buildClientReport, buildExplorePack, isEmail, sealReport, validateClientReport, validateExplorePack, type ClientReport, type ExplorePack } from '../../../../packages/contract/src/package';
import { ExploreViewer } from './ExploreViewer';

type Tab = 'issues' | 'scenes' | 'brand' | 'check' | 'export' | 'manage';
const storeKey = (sha: string) => `wo-report:wt:${sha}`;
const readStore = (k: string): string | null => { try { return window.localStorage?.getItem(k) ?? null; } catch { return null; } };
const writeStore = (k: string, v: string) => { try { window.localStorage?.setItem(k, v); } catch { /* storage unavailable */ } };

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="ad-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

/** Defaults from the project's .env files, baked in at build time. */
const slugOf = (domain: string) => domain.toLowerCase().split('').map((c) => (/[a-z0-9]/.test(c) ? c : '-')).join('').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'client';
const ENV_FEEDBACK = { to: import.meta.env.WEBOBS_FEEDBACK_TO, subject: import.meta.env.WEBOBS_FEEDBACK_SUBJECT };

export function Admin() {
  const [site, setSite] = useState<LoadedSite | null>(null);
  const [w, setW] = useState<Walkthrough | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('issues');
  const [preview, setPreview] = useState<null | 'present' | 'read'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Publish goes through the local helper you start in a terminal (see lib/helperClient.ts); the link is shown once and kept only in this state.
  const hs = useHelper();
  useEffect(() => { if (hs.info?.defaultHours) setPublishHours(hs.info.defaultHours); }, [hs.info?.defaultHours]);
  const [publishHours, setPublishHours] = useState(72);
  // The look this report will carry (a styles file attached on the Brand & review tab). Kept here, not in the saved walkthrough.
  const [look, setLook] = useState<{ styles: Record<string, string>; file: string } | null>(null);
  const [lookMsg, setLookMsg] = useState<string[]>([]);
  const attachLook = async (f: File | undefined) => {
    setLookMsg([]); if (!f) return;
    try {
      if (f.size > 64 * 1024) { setLookMsg(['That file is larger than 64 KB.']); return; }
      const v = validateStyles(JSON.parse((await f.text()).replace(/^\uFEFF/, '')));
      if (!v.ok || !v.styles) { setLookMsg(v.errors); return; }
      setLook({ styles: v.styles as Record<string, string>, file: f.name.slice(0, 60) }); setLookMsg([`Attached: ${Object.keys(v.styles).length} style settings. They are checked again by the upload and by the report server.`]);
    } catch { setLookMsg(['That file is not valid JSON.']); }
  };
  const [published, setPublished] = useState<{ link: string; expires: string } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [pass, setPass] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [pkgPreview, setPkgPreview] = useState<ClientReport | null>(null);
  const [explorePreview, setExplorePreview] = useState<ExplorePack | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const adopt = useCallback(async (s: LoadedSite) => {
    setError(null); setBusy('Reading the capture…');
    try {
      let next: Walkthrough | null = null;
      const saved = readStore(storeKey(s.sha));
      if (saved) { try { next = JSON.parse(saved) as Walkthrough; setNotice('Resumed your saved edits for this capture.'); } catch { next = null; } }
      if (!next) { next = buildDraft(s.manifest, s.sha); setNotice(null); }
      setSite(s); setW(next); setTab('issues');
      setBusy(null);
      setImages(await prepareImages(s, next));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }, []);

  const ingest = useCallback(async (files: File[]) => {
    try {
      if (files.length === 1 && /[.]json$/i.test(files[0].name) && files[0].size < 64 * 1024 * 1024) {
        const text = await files[0].text();
        let j: { format?: string; version?: string } | null = null;
        try { j = JSON.parse(text) as { format?: string; version?: string }; } catch { /* not JSON: let the capture loader explain */ }
        if (j?.format === 'webobs.explore-pack') { setExplorePreview(JSON.parse(text) as ExplorePack); return; }
        if (j?.format === 'webobs.client-report') {
          if (String(j.version).split('.')[0] !== '1') throw new Error('This report uses a newer format (' + j.version + ') than this viewer understands.');
          setPkgPreview(JSON.parse(text) as ClientReport); return;
        }
      }
      await adopt(await loadFromFiles(files));
    } catch (e) { setError((e as Error).message); }
  }, [adopt]);

  // ?manifest=<url> lets a team host captures next to the app.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const url = q.get('manifest');
    if (!url) return;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`);
        const blob = await res.blob();
        await ingest([new File([blob], '_site-graph.json')]);
      } catch (e) { setError((e as Error).message); }
    })();
  }, [ingest]);

  // Autosave edits per capture.
  useEffect(() => { if (site && w) writeStore(storeKey(site.sha), JSON.stringify(w)); }, [site, w]);

  const edit = useCallback((fn: (draft: Walkthrough) => void) => {
    setW((prev) => { if (!prev) return prev; const c = structuredClone(prev); fn(c); return c; });
  }, []);

  const draftValidation = useMemo(() => (site && w ? validate(w, site.manifest, { manifestSha: site.sha }) : null), [site, w]);
  const problemsFor = (prefix: string): Problem[] => (draftValidation ? [...draftValidation.errors, ...draftValidation.warnings].filter((p) => p.where.startsWith(prefix)) : []);
  const ctx = useMemo(() => (site ? makeCtx(site.manifest) : null), [site]);

  if (pkgPreview) return <PackageViewer report={pkgPreview} onClose={() => setPkgPreview(null)} />;
  if (explorePreview) return <ExploreViewer pack={explorePreview} onClose={() => setExplorePreview(null)} />;
  if (preview && site && w) {
    return <Viewer data={{ walkthrough: w, manifest: site.manifest, images }} initialMode={preview} startWithPresenter onClose={() => setPreview(null)} />;
  }

  // ---------------------------------------------------------------- landing
  if (!site || !w || !ctx) {
    return (
      <div className="ad-root">
        <header className="ad-bar"><strong>Web-Obs Report Studio</strong><span>Turn a captured site into a client walkthrough</span></header>
        <main className="ad-landing">
          <div
            className={`ad-drop${drag ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={async (e) => { e.preventDefault(); setDrag(false); setBusy('Reading files…'); try { await ingest(await filesFromDrop(e.dataTransfer)); } finally { setBusy(null); } }}
          >
            <h1>Drop a capture here</h1>
            <p>Drop <code>_site-graph.json</code> from your vault&rsquo;s <code>sites/&lt;domain&gt;/</code> folder, or the whole site folder to bring along screenshots and the logo.</p>
            <div className="ad-row">
              <button className="ad-primary" onClick={() => fileRef.current?.click()}>Choose _site-graph.json</button>
              <button onClick={() => folderRef.current?.click()}>Open site folder</button>
            </div>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files && void ingest([...e.target.files])} />
            <input ref={folderRef} type="file" hidden {...({ webkitdirectory: '', directory: '', multiple: true } as object)} onChange={(e) => e.target.files && void ingest([...e.target.files])} />
            {busy && <p className="ad-busy">{busy}</p>}
            {error && <p className="ad-error" role="alert">{error}</p>}
          </div>
          {notice && <p className="ad-banner" role="status">{notice}</p>}
          <details className="ad-landing-manage"><summary>Captures and published links</summary><Manage onNotice={setNotice} onError={setError} /></details>
          <ol className="ad-how">
            <li><strong>Load</strong> a capture. Nothing is uploaded: everything runs in this browser tab.</li>
            <li><strong>Review</strong> the draft walkthrough. Every number comes from the capture; every opinion says why.</li>
            <li><strong>Present</strong> it live with presenter notes, or <strong>export</strong> one HTML file for the client.</li>
          </ol>
        </main>
      </div>
    );
  }

  const m = site.manifest;
  const nErr = draftValidation?.errors.length ?? 0, nWarn = draftValidation?.warnings.length ?? 0;
  const issueScene = (id: string) => w.scenes.find((s) => s.type === 'issue' && s.issueId === id && (s.audience ?? 'client') === 'client');

  const setOnDeck = (id: string, on: boolean) => edit((d) => {
    const exists = d.scenes.findIndex((s) => s.type === 'issue' && s.issueId === id && (s.audience ?? 'client') === 'client');
    const issue = d.issues.find((i) => i.id === id)!;
    if (on && exists < 0) {
      let at = -1; d.scenes.forEach((s, i) => { if (s.type === 'issue' && (s.audience ?? 'client') === 'client') at = i; });
      if (at < 0) at = d.scenes.findIndex((s) => s.type === 'map-tour');
      d.scenes.splice(at + 1, 0, { id: `issue-${id}`, type: 'issue', issueId: id });
      const road = d.scenes.find((s) => s.type === 'roadmap');
      if (road && !road.items?.some((it) => it.issueId === id)) road.items = [...(road.items ?? []), { issueId: id, horizon: horizonFor(issue) }];
    } else if (!on && exists >= 0) {
      d.scenes.splice(exists, 1);
      const road = d.scenes.find((s) => s.type === 'roadmap');
      if (road) road.items = (road.items ?? []).filter((it) => it.issueId !== id);
    }
  });
  const moveIssue = (id: string, dir: -1 | 1) => edit((d) => {
    const i = d.issues.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= d.issues.length) return;
    [d.issues[i], d.issues[j]] = [d.issues[j], d.issues[i]];
    // Re-sequence the client issue scenes to follow the issue order.
    const slots = d.scenes.map((s, k) => (s.type === 'issue' && (s.audience ?? 'client') === 'client' ? k : -1)).filter((k) => k >= 0);
    const sceneFor = new Map(slots.map((k) => [d.scenes[k].issueId!, d.scenes[k]]));
    const ordered = d.issues.map((x) => sceneFor.get(x.id)).filter((s): s is Scene => Boolean(s));
    slots.forEach((k, n) => { d.scenes[k] = ordered[n]; });
  });
  const moveScene = (id: string, dir: -1 | 1) => edit((d) => {
    const i = d.scenes.findIndex((s) => s.id === id), j = i + dir;
    if (j >= 0 && j < d.scenes.length) [d.scenes[i], d.scenes[j]] = [d.scenes[j], d.scenes[i]];
  });
  // The guided tour leads with up to five issues. Unset = the five highest-ranked confirmed issues.
  const autoTop = w.issues.filter((i) => i.disposition === 'confirmed').slice(0, 5).map((i) => i.id);
  const tourPicks = (w.tour?.picks ?? []).filter((id) => w.issues.some((i) => i.id === id && i.disposition === 'confirmed'));
  const topNow = tourPicks.length ? tourPicks : autoTop;
  const setPicks = (next: string[] | null) => edit((d) => { if (next === null) delete d.tour; else d.tour = { picks: next }; });
  const togglePick = (id: string) => {
    if (topNow.includes(id)) setPicks(topNow.filter((x) => x !== id));
    else if (topNow.length >= 5) setNotice('The tour leads with five findings. Unpin one first.');
    else setPicks([...topNow, id]);
  };
  const movePick = (id: string, dir: -1 | 1) => { const a = [...topNow], i = a.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setPicks(a); };
  const titleOf = (id: string) => w.issues.find((i) => i.id === id)?.title ?? id;

  const buildPackage = async (forDownload: boolean): Promise<ClientReport> => {
    const shipped = stripForClient(w);
    const res = validate(shipped, m, { manifestSha: site.sha, mode: 'client' });
    if (res.errors.some((e) => e.where !== 'authoring')) { setTab('check'); throw new Error(`${res.errors.length} validation error(s) must be fixed first.`); }
    const imgs = await prepareImages(site, shipped);
    const rep = await sealReport(buildClientReport(w, m, { createdAt: new Date().toISOString(), images: imgs, feedbackDefaults: ENV_FEEDBACK, ...(look ? { styles: look.styles } : {}) }), sha256Hex);
    if (forDownload) {
      const probs = validateClientReport(rep, ctx);
      if (probs.length) { setLog(probs.map((p) => `${p.where}: ${p.message}`)); throw new Error(probs.some((p) => p.where === 'meta.review') ? 'Set the review state to Approved on the Brand & review tab before sending a package to a client.' : `The package failed ${probs.length} check(s); see the list below.`); }
    }
    return rep;
  };
  const previewTour = async () => { setError(null); try { setBusy('Building the tour…'); setPkgPreview(await buildPackage(false)); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const previewExplore = async () => { setError(null); try { setBusy('Building explore mode…'); const rep = await buildPackage(false); setExplorePreview(buildExplorePack(w, m, rep, { createdAt: new Date().toISOString() })); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const fail = (e: unknown) => { const msg = (e as Error).message; if (/Approved/.test(msg)) setTab('brand'); setError(msg); };
  /** Build, check and save the client JSON. The file is only written if every check passes. */
  /** One flow: build and check the client JSON, then either push it through the helper and show the link once, or save it. */
  const publishClientJson = async () => {
    if (!helperReady(hs.info)) {
      await exportClientJson();
      setNotice((n) => (n ? n + ' ' : '') + 'No publish target is connected, so the file was saved here instead of uploaded.');
      return;
    }
    setError(null); setNotice(null); setLog([]); setPublished(null);
    try {
      setBusy('Building and checking the client JSON…');
      const rep = await buildPackage(true);
      setBusy('Publishing…');
      const j = await helperCall<{ link: string; expires: string }>('/publish', { report: rep, client: slugOf(m.domain), hours: publishHours });
      setPublished({ link: j.link, expires: j.expires });
      setNotice(`Published. It works until ${new Date(j.expires).toLocaleString()}. Copy the link now: it is shown once and is not stored anywhere.`);
    } catch (e) { fail(e); }
    finally { setBusy(null); }
  };
  const exportClientJson = async () => {
    setError(null); setNotice(null); setLog([]);
    try {
      setBusy('Building the client JSON…');
      const rep = await buildPackage(true);
      const text = JSON.stringify(rep, null, 2), name = `${m.domain}.client-report.json`;
      const how = await saveFile(name, text);
      if (how === 'cancelled') { setNotice('Export cancelled. Nothing was saved.'); return; }
      setNotice(`${how === 'saved' ? 'Saved' : 'Downloaded'} ${name} (${(text.length / 1024).toFixed(0)} KB). ${rep.feedback ? 'Client feedback goes to ' + rep.feedback.to + '.' : 'No feedback address is set, so the client can only copy or download their feedback.'}`);
      setLog([`To publish it as a private link: npm run publish:client -- "<the saved ${name}>" --client <client-name>   (the upload target comes from WEBOBS_PUBLISH_TARGET or --to)`, `Top five for the tour: ${rep.modes.guided.top.findingIds.map(titleOf).join('; ')}`, `Held back (not in the file): ${w.issues.filter((i) => i.disposition !== 'confirmed').map((i) => i.title).join('; ') || 'none'}`]);
    } catch (e) { fail(e); }
    finally { setBusy(null); }
  };
  const exportExplorePack = async () => {
    setError(null); setNotice(null); setLog([]);
    try {
      setBusy('Building the explore pack…');
      const rep = await buildPackage(false);
      const pack = buildExplorePack(w, m, rep, { createdAt: new Date().toISOString() });
      const bad = validateExplorePack(pack);
      if (bad.length) throw new Error('The explore pack failed its checks: ' + bad[0].message);
      const name = `${m.domain}.explore-pack.json`;
      const how = await saveFile(name, JSON.stringify(pack));
      if (how === 'cancelled') { setNotice('Export cancelled. Nothing was saved.'); return; }
      setNotice(`${how === 'saved' ? 'Saved' : 'Downloaded'} ${name}. This one is for you only (everything from the scrape, held-back findings, your notes). Never send it to a client.`);
    } catch (e) { fail(e); }
    finally { setBusy(null); }
  };

  const resetDraft = () => { if (!confirm('Discard your edits and rebuild the draft from the capture?')) return; edit((d) => { Object.assign(d, buildDraft(m, site.sha)); }); setNotice('Draft rebuilt from the capture.'); };

  const importWalkthrough = async (file: File) => {
    try {
      const j = JSON.parse(await file.text()) as Walkthrough;
      if (j.walkthroughVersion !== '0.2' || !Array.isArray(j.issues) || !Array.isArray(j.scenes)) throw new Error('This is not a Web-Obs walkthrough file (version 0.2).');
      if (j.source?.manifestSha256 !== site.sha) setNotice('This walkthrough was written for a different capture. Validation will list what no longer matches.');
      setW(j); setImages(await prepareImages(site, j));
    } catch (e) { setError((e as Error).message); }
  };

  const exportHtml = async (copy: 'client' | 'presenter') => {
    setLog([]); setError(null);
    const say = (s: string) => setLog((l) => [...l, s]);
    try {
      setBusy('Exporting…');
      const shipped = copy === 'client' ? stripForClient(w) : w;
      const res = validate(shipped, m, { manifestSha: site.sha, mode: 'client' });
      if (res.errors.some((e) => e.where !== 'authoring')) { setTab('check'); throw new Error(`${res.errors.length} validation error(s) must be fixed first.`); }
      say(`Validated: ${res.errors.length} blocking, ${res.warnings.length} warning(s).`);
      const pruned = pruneManifest(m);
      const bad = verifyPrune(m, pruned, shipped);
      if (bad.length) throw new Error('Shrinking the capture would change the report: ' + bad[0]);
      say(`Shrunk the capture for sharing: ${(JSON.stringify(m).length / 1024).toFixed(0)} KB → ${(JSON.stringify(pruned).length / 1024).toFixed(0)} KB, text and globe checked identical.`);
      if (copy === 'client') say(`Client copy: ${w.scenes.length - shipped.scenes.length} presenter-only scene(s), every presenter note and ${w.issues.length - shipped.issues.length} unverified finding(s) removed from the data itself.`);
      const imgs = await prepareImages(site, shipped);
      say(`Embedded ${Object.keys(imgs).length} image(s).`);
      const payload: ReportPayload = { v: 1, copy, createdAt: new Date().toISOString(), walkthrough: shipped, manifest: pruned, images: imgs };
      const sealed = await sealPayload(payload, pass || undefined);
      say(pass ? 'Encrypted with your passphrase (AES-GCM). Keep the passphrase separate from the file.' : 'Not encrypted: anyone with the file can open it.');
      const shell = await fetchShell();
      if (!shell.includes(DATA_MARKER)) throw new Error('Export needs the built single-file app. Serve dist-report/report.html over http (npm run report:build, then npm run report:serve) and open it from there.');
      const html = embedIntoShell(shell, sealed, sealed.enc ? 'Protected website walkthrough' : `${w.brand.name} website health walkthrough`);
      const name = `${m.domain}-walkthrough-${new Date().toISOString().slice(0, 10)}${copy === 'presenter' ? '-PRESENTER' : w.authoring.reviewState === 'approved' ? '' : '-DRAFT'}.html`;
      downloadBlob(name, html, 'text/html');
      say(`Saved ${name} (${(html.length / 1024 / 1024).toFixed(2)} MB). Open it in any modern browser; no server is needed.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const T = (s: string) => renderText(s, ctx);
  const nOnDeck = w.scenes.filter((s) => s.type === 'issue' && (s.audience ?? 'client') === 'client' && !s.hidden).length;

  // ---------------------------------------------------------------- editor
  return (
    <div className="ad-root">
      <header className="ad-bar">
        <strong>Web-Obs Report Studio</strong> <small className="ad-stamp" title="Which build this is">{__BUILD_STAMP__}</small>
        <span className="ad-site">{m.brandName || m.domain} <small>{m.domain} · {m.nodes.length} nodes · captured {new Date(m.capturedAt).toLocaleDateString()}</small></span>
        <div className="ad-actions">
          <button className="ad-primary" disabled={Boolean(busy)} onClick={() => void publishClientJson()} title="Build, check and publish the client JSON as a private link (needs a connected publish helper); without one it saves the file">Publish</button>
          <button disabled={Boolean(busy)} onClick={() => void exportClientJson()} title="Build, check and save the client JSON (needs review state Approved)">Export client JSON</button>
          <button onClick={() => setPreview('present')}>Present ▸</button>
          <button onClick={() => setPreview('read')}>Read view</button>
          <button onClick={() => { setSite(null); setW(null); }}>Close capture</button>
        </div>
      </header>
      <nav className="ad-tabs" role="tablist">
        {([['issues', `Findings (${w.issues.length})`], ['scenes', 'Deck'], ['brand', 'Brand & review'], ['check', `Checks${nErr ? ` · ${nErr} error${nErr > 1 ? 's' : ''}` : nWarn ? ` · ${nWarn}` : ''}`], ['export', 'Export'], ['manage', 'Captures & links']] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {published && (
        <div className="ad-banner ad-published" role="status">
          <b>Client link</b> <code>{published.link}</code> <small>works until {new Date(published.expires).toLocaleString()}</small>
          <button onClick={() => void navigator.clipboard?.writeText(published.link)}>Copy link</button>
          <button onClick={() => setPublished(null)} aria-label="Hide the link">Hide</button>
        </div>
      )}
      {(notice || error) && <div className={error ? 'ad-banner err' : 'ad-banner'} role="status">{error ?? notice}<button onClick={() => { setError(null); setNotice(null); }} aria-label="Dismiss">×</button></div>}

      <main className="ad-main">
        {tab === 'issues' && (
          <section>
            <p className="ad-lead">{w.issues.length === 0 ? 'The generator found nothing to turn into stories.' : <>The generator grouped {ctx.F.size} engine findings into {w.issues.length} stories.</>} {w.issues.length > 0 && <> {nOnDeck} are on the deck as their own slide; the rest appear under &ldquo;Everything else&rdquo;. Edit anything: figures stay tied to the capture.</>}</p>
            {w.issues.length > 0 && (
              <div className="ad-tourbox">
                <b>Guided tour: fix these first</b> <small>{tourPicks.length ? 'Your selection' : 'Automatic: the five highest-ranked'}. Pin or unpin with the star on any finding.</small>
                <ol>{topNow.map((id, n) => (
                  <li key={id}><span className="ad-grow">{titleOf(id)}</span>
                    <button onClick={() => movePick(id, -1)} disabled={n === 0} aria-label="Move earlier in the tour">↑</button>
                    <button onClick={() => movePick(id, 1)} disabled={n === topNow.length - 1} aria-label="Move later in the tour">↓</button>
                    <button onClick={() => togglePick(id)} aria-label="Remove from the tour">×</button></li>
                ))}</ol>
                {tourPicks.length > 0 && <button onClick={() => setPicks(null)}>Back to automatic</button>}
              </div>
            )}
            {w.issues.map((i, idx) => {
              const probs = problemsFor(`issue "${i.id}"`);
              const on = Boolean(issueScene(i.id));
              const isOpen = open === i.id;
              return (
                <article key={i.id} className={`ad-issue${isOpen ? ' open' : ''}`}>
                  <div className="ad-issue-row">
                    <label className="ad-switch" title={on ? 'Shown as a slide' : 'Not a slide of its own'}><input type="checkbox" checked={on} onChange={(e) => setOnDeck(i.id, e.target.checked)} /><span /></label>
                    <button className="ad-issue-title" onClick={() => setOpen(isOpen ? null : i.id)} aria-expanded={isOpen}>
                      <span>{i.title}</span>
                      <small>
                        <b className={`pill sev-${i.severity.level}`}>{i.severity.level}</b> effort {i.effort.size} · {OWNER_LABEL[i.owner]} · {i.findings.length} finding type{i.findings.length === 1 ? '' : 's'}
                        {i.disposition !== 'confirmed' && <b className="pill warn">{i.disposition}</b>}
                        {probs.some((p) => p.level === 'error') && <b className="pill err">{probs.filter((p) => p.level === 'error').length} error</b>}
                      </small>
                    </button>
                    <button onClick={() => togglePick(i.id)} disabled={i.disposition !== 'confirmed'} aria-pressed={topNow.includes(i.id)} title={topNow.includes(i.id) ? 'In the guided tour. Click to unpin' : 'Pin to the guided tour'} aria-label="Pin to the guided tour">{topNow.includes(i.id) ? '★' : '☆'}</button>
                    <button onClick={() => moveIssue(i.id, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
                    <button onClick={() => moveIssue(i.id, 1)} disabled={idx === w.issues.length - 1} aria-label="Move down">↓</button>
                  </div>
                  {isOpen && <IssueEditor issue={i} probs={probs} T={T} edit={(fn) => edit((d) => fn(d.issues.find((x) => x.id === i.id)!))} />}
                </article>
              );
            })}
            {w.issues.length === 0 && <p className="ad-empty">This capture has no audit findings (it predates schema 1.3.0 or ran without the audit). The deck will show the map, at-a-glance numbers, scope and next steps only.</p>}
          </section>
        )}

        {tab === 'scenes' && (
          <section>
            <p className="ad-lead">The order of the deck. Hidden scenes are skipped; presenter-only scenes appear only in the studio preview and never in the client file.</p>
            {w.scenes.map((s, k) => (
              <article key={s.id} className={`ad-scene${s.hidden ? ' off' : ''}`}>
                <div className="ad-issue-row">
                  <label className="ad-switch"><input type="checkbox" checked={!s.hidden} onChange={(e) => edit((d) => { d.scenes[k].hidden = !e.target.checked; })} /><span /></label>
                  <div className="ad-scene-title"><b>{s.type}</b> {s.issueId ? w.issues.find((i) => i.id === s.issueId)?.title : s.title}{s.audience === 'presenter' && <b className="pill warn">presenter only</b>}</div>
                  <button onClick={() => moveScene(s.id, -1)} disabled={k === 0} aria-label="Move up">↑</button>
                  <button onClick={() => moveScene(s.id, 1)} disabled={k === w.scenes.length - 1} aria-label="Move down">↓</button>
                </div>
                <div className="ad-scene-body">
                  {s.title !== undefined && s.type !== 'issue' && <Field label="Title"><input value={s.title} onChange={(e) => edit((d) => { d.scenes[k].title = e.target.value; })} /></Field>}
                  {s.subtitle !== undefined && <Field label="Subtitle"><input value={s.subtitle} onChange={(e) => edit((d) => { d.scenes[k].subtitle = e.target.value; })} /></Field>}
                  {s.type === 'roadmap' && (s.items ?? []).map((it, n) => (
                    <div key={it.issueId} className="ad-row"><span className="ad-grow">{w.issues.find((i) => i.id === it.issueId)?.title ?? it.issueId}</span>
                      <select value={it.horizon} onChange={(e) => edit((d) => { d.scenes[k].items![n].horizon = e.target.value as never; })}>{HORIZONS.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</select></div>
                  ))}
                  {s.type === 'glance' && (s.tiles ?? []).map((tile, n) => (
                    <div key={n} className="ad-row"><input value={tile.label} onChange={(e) => edit((d) => { d.scenes[k].tiles![n].label = e.target.value; })} /><input value={tile.value} onChange={(e) => edit((d) => { d.scenes[k].tiles![n].value = e.target.value; })} /><code className="ad-prev">{T(tile.value)}</code></div>
                  ))}
                  {s.type === 'map-tour' && (s.stops ?? []).map((st, n) => (
                    <Field key={n} label={`Stop ${n + 1} · ${st.view}${st.focus.health ? ' · ' + st.focus.health : ''}`}>
                      <textarea rows={2} value={st.caption.text} onChange={(e) => edit((d) => { d.scenes[k].stops![n].caption.text = e.target.value; })} />
                      <small>{T(st.caption.text)}</small>
                    </Field>
                  ))}
                  {(s.type === 'limits' || s.type === 'next-steps' || s.type === 'since-last-capture') && (s.claims ?? []).map((c, n) => (
                    <Field key={n} label={`Line ${n + 1}`}><textarea rows={2} value={c.text} onChange={(e) => edit((d) => { d.scenes[k].claims![n].text = e.target.value; })} /><small>{T(c.text)}</small></Field>
                  ))}
                  <Field label="Presenter notes (one per line)"><textarea rows={3} value={(s.talk ?? []).join('\n')} onChange={(e) => edit((d) => { d.scenes[k].talk = e.target.value.split('\n').filter(Boolean); })} /></Field>
                </div>
              </article>
            ))}
          </section>
        )}

        {tab === 'brand' && (
          <section className="ad-form">
            <Field label="Client / brand name"><input value={w.brand.name} onChange={(e) => edit((d) => { d.brand.name = e.target.value; })} /></Field>
            <Field label="Prepared for" hint="Shown on the cover, e.g. the contact or company."><input value={w.brand.preparedFor ?? ''} onChange={(e) => edit((d) => { d.brand.preparedFor = e.target.value || undefined; })} /></Field>
            <Field label="Send client feedback to" hint={ENV_FEEDBACK.to ? `Leave blank to use the default from the .env file (${ENV_FEEDBACK.to}).` : "The last step of the guided tour opens the client's email app addressed here. Leave blank and they can only copy or download their feedback. A default can be set in the .env file."}><input type="email" placeholder={ENV_FEEDBACK.to ?? 'you@agency.com'} value={w.brand.feedbackEmail ?? ''} onChange={(e) => edit((d) => { d.brand.feedbackEmail = e.target.value.trim() || undefined; })} />{w.brand.feedbackEmail && !isEmail(w.brand.feedbackEmail) && <small className="ad-error">That does not look like an email address.</small>}</Field>
            <Field label="Presented by"><input value={w.brand.presenter ?? ''} onChange={(e) => edit((d) => { d.brand.presenter = e.target.value || undefined; })} /></Field>
            <Field label="Accent colour" hint="The capture's own colours are guesses, so you choose. Leave unset for the default.">
              <div className="ad-row"><input type="color" value={w.brand.accent.hex ?? '#7c5cff'} onChange={(e) => edit((d) => { d.brand.accent.hex = e.target.value; })} />
                <input placeholder="Approved by (name)" value={w.brand.accent.approvedBy ?? ''} onChange={(e) => edit((d) => { d.brand.accent.approvedBy = e.target.value || null; })} /></div>
            </Field>
            <Field label="Look (styles file)" hint="Optional. A small JSON file of colours, fonts and the agency name for this report; without one the report keeps the built-in look. The look shows on the client link, not in this preview. Everything in it is visible to anyone with the link.">
              <div className="ad-row"><input type="file" accept=".json,application/json" onChange={(e) => void attachLook(e.target.files?.[0])} />
                {look && <button onClick={() => { setLook(null); setLookMsg([]); }}>Remove look ({look.file})</button>}</div>
              {lookMsg.map((x, i) => <p key={i} className="ad-hint" role="status">{x}</p>)}
            </Field>
            <Field label="Review state" hint="The client file is stamped DRAFT until this is Approved.">
              <select value={w.authoring.reviewState} onChange={(e) => edit((d) => { d.authoring.reviewState = e.target.value as never; })}><option value="draft">Draft</option><option value="reviewed">Reviewed</option><option value="approved">Approved for the client</option></select>
            </Field>
            <Field label="Reviewed by"><input value={w.authoring.reviewedBy ?? ''} onChange={(e) => edit((d) => { d.authoring.reviewedBy = e.target.value || null; })} /></Field>
            <p className="ad-fact">Images found in the folder: <b>{Object.keys(images).length}</b> {images.logo ? '(logo found)' : '(no logo: the globe shows initials)'}. Screenshots and the logo are read only if you opened the site folder.</p>
            <div className="ad-row"><button onClick={resetDraft}>Rebuild draft from capture</button></div>
          </section>
        )}

        {tab === 'check' && draftValidation && (
          <section>
            <p className="ad-lead">{draftValidation.ok ? 'No blocking problems.' : `${nErr} blocking problem${nErr === 1 ? '' : 's'}.`} The rules: every figure is a binding to the capture, every observation cites its source, every opinion states its basis, nothing promises results, and a client slide never shows an unverified finding.</p>
            {[...draftValidation.errors, ...draftValidation.warnings].map((p, i) => <div key={i} className={`ad-prob ${p.level}`}><b>{p.level === 'error' ? 'Error' : 'Note'}</b><code>{p.where}</code>{p.message}</div>)}
            {nErr + nWarn === 0 && <p className="ad-empty">All clear.</p>}
          </section>
        )}

        {tab === 'manage' && <Manage onNotice={setNotice} onError={setError} />}
        {tab === 'export' && (
          <section className="ad-form">
            <h2>Share with the client</h2>
            <p className="ad-lead"><b>Client copy:</b> presenter notes, presenter-only slides and unverified findings are removed from the file itself, not just hidden. <b>Presenter copy:</b> your own file, with the notes and a second, synced window for screen-sharing. Each is one HTML file with the walkthrough, the map, the numbers and the screenshots inside it. It opens by double-click, needs no server and makes no network requests.</p>
            <Field label="Passphrase (optional)" hint="Encrypts the file in your browser. Send the passphrase by a different channel."><input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
            <p className="ad-fact">Review state: <b>{w.authoring.reviewState}</b>. {w.authoring.reviewState === 'approved' ? 'The file will be a clean client copy.' : 'The file will carry a DRAFT badge until you approve it on the Brand & review tab.'}</p>
            <div className="ad-row">
              <button className="ad-primary" disabled={Boolean(busy) || nErr > 0} onClick={() => void exportHtml('client')}>{w.authoring.reviewState === 'approved' ? 'Download client report' : 'Download draft report'}</button>
              <button disabled={Boolean(busy) || nErr > 0} onClick={() => void exportHtml('presenter')} title="Your own copy: keeps presenter notes, presenter-only slides and a synced second window">Download presenter copy</button>
              <button onClick={() => downloadBlob(`${m.domain}.walkthrough.json`, JSON.stringify(w, null, 2), 'application/json')}>Save walkthrough JSON</button>
              <button onClick={() => document.getElementById('wt-import')?.click()}>Load walkthrough JSON</button>
              <input id="wt-import" type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && void importWalkthrough(e.target.files[0])} />
            </div>
            <h2>Client package (JSON)</h2>
            <p className="ad-lead"><b>Client package:</b> one data file for the client, a <b>guided tour</b> that explains the top five fixes in plain language over the 3D map and ends with an email-your-feedback step. It carries no notes and no unverified findings. <b>Explore pack:</b> your own file with everything from the scrape, held-back findings and your notes, for walking a client through live. Never send it.</p>
            <div className="ad-row">
              <button className="ad-primary" disabled={Boolean(busy) || nErr > 0} onClick={() => void previewTour()}>Preview the guided tour ▸</button>
              <button disabled={Boolean(busy) || nErr > 0} onClick={() => void previewExplore()}>Open explore mode ▸</button>
              <button className="ad-primary" disabled={Boolean(busy) || nErr > 0} onClick={() => void publishClientJson()} title="Publishes through the connected helper, or saves the file if none is connected">Publish</button>
              <button disabled={Boolean(busy) || nErr > 0} onClick={() => void exportClientJson()} title="Needs review state Approved">Save client JSON</button>
              <button disabled={Boolean(busy) || nErr > 0} onClick={() => void exportExplorePack()} title="Agency only: never send it to a client">Save explore pack (agency only)</button>
            </div>
            <HelperConnect onNotice={setNotice} onError={setError} />
            <p className="ad-row"><label>A published link works for <input type="number" min={1} max={720} value={publishHours} onChange={(e) => setPublishHours(Math.max(1, Math.min(720, Number(e.target.value) || 72)))} style={{ width: '4.5rem' }} /> hours (until {new Date(Date.now() + publishHours * 3600000).toLocaleString()})</label></p>
            {nErr > 0 && <p className="ad-error">Fix the {nErr} blocking problem{nErr === 1 ? '' : 's'} on the Checks tab to export.</p>}
            {busy && <p className="ad-busy">{busy}</p>}
            <ul className="ad-log">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </section>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
function IssueEditor({ issue, probs, T, edit }: { issue: Issue; probs: Problem[]; T: (s: string) => string; edit: (fn: (i: Issue) => void) => void }) {
  const [refsText, setRefsText] = useState<Record<string, string>>({});
  const claimEd = (list: 'whatWeSaw' | 'whyItMatters', c: Claim, n: number) => {
    const key = `${list}${n}`;
    return (
      <div key={key} className="ad-claim">
        <div className="ad-row">
          <select value={c.label} onChange={(e) => edit((i) => { i[list][n].label = e.target.value as Label; })}>{LABELS.map((l) => <option key={l}>{l}</option>)}</select>
          <button onClick={() => edit((i) => { i[list].splice(n, 1); })} aria-label="Remove">Remove</button>
        </div>
        <textarea rows={2} value={c.text} onChange={(e) => edit((i) => { i[list][n].text = e.target.value; })} />
        <small className="ad-prev">{T(c.text)}</small>
        {c.label === 'INFER' && <input placeholder="Basis (required for opinions)" value={c.basis ?? ''} onChange={(e) => edit((i) => { i[list][n].basis = e.target.value; })} />}
        {list === 'whatWeSaw' && (
          <details><summary>Sources ({c.refs?.length ?? 0})</summary>
            <textarea rows={3} className="mono" value={refsText[key] ?? JSON.stringify(c.refs ?? [], null, 1)}
              onChange={(e) => { setRefsText((r) => ({ ...r, [key]: e.target.value })); try { const v = JSON.parse(e.target.value); if (Array.isArray(v)) edit((i) => { i[list][n].refs = v; }); } catch { /* keep typing */ } }} />
          </details>
        )}
      </div>
    );
  };
  return (
    <div className="ad-issue-body">
      {probs.length > 0 && <div className="ad-probs">{probs.map((p, k) => <div key={k} className={`ad-prob ${p.level}`}><b>{p.level === 'error' ? 'Error' : 'Note'}</b>{p.message}</div>)}</div>}
      <Field label="Title (plain language)"><input value={issue.title} onChange={(e) => edit((i) => { i.title = e.target.value; })} /></Field>
      <div className="ad-grid">
        <Field label="Priority"><select value={issue.severity.level} onChange={(e) => edit((i) => { i.severity.level = e.target.value as Level; })}><option>high</option><option>medium</option><option>low</option></select></Field>
        <Field label="Effort"><select value={issue.effort.size} onChange={(e) => edit((i) => { i.effort.size = e.target.value as Size; })}><option value="S">Small</option><option value="M">Medium</option><option value="L">Large</option></select></Field>
        <Field label="Owner"><select value={issue.owner} onChange={(e) => edit((i) => { i.owner = e.target.value as Owner; })}>{(Object.keys(OWNER_LABEL) as Owner[]).map((o) => <option key={o} value={o}>{OWNER_LABEL[o]}</option>)}</select></Field>
        <Field label="Status"><select value={issue.disposition} onChange={(e) => edit((i) => { i.disposition = e.target.value as never; })}><option value="confirmed">Confirmed</option><option value="needs-verification">Needs verification</option><option value="likely-false-positive">Likely false positive</option><option value="context-only">Context only</option></select></Field>
      </div>
      {issue.disposition !== 'confirmed' && <Field label="Why it is not confirmed"><textarea rows={2} value={issue.dispositionNote ?? ''} onChange={(e) => edit((i) => { i.dispositionNote = e.target.value; })} /></Field>}
      <Field label="Why this priority"><input value={issue.severity.basis} onChange={(e) => edit((i) => { i.severity.basis = e.target.value; })} /></Field>
      <Field label="Why this effort"><input value={issue.effort.basis} onChange={(e) => edit((i) => { i.effort.basis = e.target.value; })} /></Field>
      <h4>What we saw</h4>
      {issue.whatWeSaw.map((c, n) => claimEd('whatWeSaw', c, n))}
      <button onClick={() => edit((i) => { i.whatWeSaw.push({ text: '', label: 'FETCH', refs: [] }); })}>Add an observation</button>
      <h4>Why it matters</h4>
      {issue.whyItMatters.map((c, n) => claimEd('whyItMatters', c, n))}
      <button onClick={() => edit((i) => { i.whyItMatters.push({ text: '', label: 'INFER', basis: '' }); })}>Add an implication</button>
      <Field label="Keep in mind (caveat)"><textarea rows={2} value={issue.caveat ?? ''} onChange={(e) => edit((i) => { i.caveat = e.target.value || undefined; })} /></Field>
      <Field label="How it gets fixed (one step per line)"><textarea rows={4} value={issue.fix.join('\n')} onChange={(e) => edit((i) => { i.fix = e.target.value.split('\n').filter(Boolean); })} /></Field>
      <Field label="How we will know it is fixed"><input value={issue.verify} onChange={(e) => edit((i) => { i.verify = e.target.value; })} /></Field>
      <Field label="Presenter notes (one per line)"><textarea rows={2} value={(issue.talk ?? []).join('\n')} onChange={(e) => edit((i) => { i.talk = e.target.value.split('\n').filter(Boolean); })} /></Field>
    </div>
  );
}

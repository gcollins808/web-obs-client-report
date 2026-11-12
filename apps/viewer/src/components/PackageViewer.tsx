// Client-facing viewer for a Client Report Package (webobs.client-report 1.1).
// The existing 3D globe is the stage; a guided tour (popover card) sits on top of it, led by the top five fixes
// and ending with a feedback step that opens the client's own mail app. All text reaches the DOM through React
// text nodes (never innerHTML).
import { BRAND, readableTextOn } from '../lib/brand';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SiteGraphManifest } from '../../../../vendor/web-obs/types/site';
import { attentionNodeIds } from '../../../../vendor/web-obs/data/mapAttention';
import { THEME_HEX, type Stop } from '../../../../packages/contract/src/core';
import { composeFeedback, type ClientReport, type GuidedStep, type MapFocus, type RClaim, type RFinding, type Spotlight } from '../../../../packages/contract/src/package';
import { safeImageSrc } from '../../../../packages/contract/src/safe';
import { FullscreenButton, MapHelp } from './ToolIcons';
import { GlobeStage, focusFromStop, type GlobeFocus } from './GlobeStage';
import { pageCardInfo } from '../lib/pageCard';

type GFinding = Extract<GuidedStep, { kind: 'finding' }>;

const SEV: Record<string, string> = { high: 'High priority', medium: 'Medium priority', low: 'Lower priority' };
const EFFORT: Record<string, string> = { S: 'Small effort', M: 'Medium effort', L: 'Large effort' };
/** Short button labels; the full sentence is what goes into the feedback email. */
const SHORT_ANSWER: Record<string, string> = { 'This is what I expected': 'Expected', 'This surprises me': 'Surprising', 'I would like to discuss this': 'Discuss' };
const read = (k: string): string | null => { try { return window.localStorage?.getItem(k) ?? null; } catch { return null; } };
const write = (k: string, v: string) => { try { window.localStorage?.setItem(k, v); } catch { /* storage unavailable */ } };

function onAccent(hex: string): string {
  if (BRAND) return readableTextOn(hex);
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.6 ? '#10131a' : '#ffffff';
}

/** The globe wants a SiteGraphManifest; the package carries it trimmed, without vault paths. */
export function hydrate(site: Record<string, unknown>): SiteGraphManifest {
  const nodes = (site.nodes as Array<Record<string, unknown>>).map((n) => ({ ...n, obsidianPath: '' }));
  return { ...site, nodes } as unknown as SiteGraphManifest;
}

export function focusOf(f: MapFocus | null | undefined, key: string): GlobeFocus {
  if (!f) return { view: 'globe', filter: 'all', fly: null, key: 'default' };
  const stop = { view: f.view, focus: { ...(f.health ? { health: f.health } : {}), ...(f.filter ? { filter: f.filter } : {}), ...(f.nodeIds ? { nodeIds: f.nodeIds } : {}), ...(f.section ? { section: f.section } : {}) }, caption: { text: '', label: 'SCOPE' } } as unknown as Stop;
  const g = focusFromStop({ nodes: [] } as unknown as SiteGraphManifest, stop);
  return { ...g, key };
}

/** The pages a map view is about, so the globe can bring them forward and fade the rest (the dimming) instead of hiding the others. */
export function highlightForMap(m: SiteGraphManifest, f: MapFocus | null | undefined): Set<string> | null {
  if (!f) return null;
  if (f.nodeIds?.length) return new Set(f.nodeIds);
  const by = (pred: (n: SiteGraphManifest['nodes'][number]) => boolean) => new Set(m.nodes.filter((n) => n.kind !== 'external-domain' && pred(n)).map((n) => n.id));
  if (f.health === 'orphan' || f.health === 'unlisted' || (!f.health && f.filter === 'orphans')) return by((n) => n.health === 'orphan' || n.health === 'unlisted');
  if (f.health) return by((n) => n.health === f.health);
  if (f.filter === 'issues') { const a = attentionNodeIds(m); return by((n) => a.has(n.id)); }
  return null;
}

function Claims({ claims, limit, picked, onPick, known }: { claims: RClaim[]; limit?: number; picked?: number | null; onPick?: (i: number | null) => void; known?: ReadonlySet<string> }) {
  const [all, setAll] = useState(false);
  const list = all || !limit ? claims : claims.slice(0, limit);
  const count = (c: RClaim) => (c.nodeIds ?? []).filter((id) => !known || known.has(id)).length;
  return (
    <>
      <ul className="pv-claims">
        {list.map((c, i) => (
          <li key={i} className={picked === i ? 'on' : ''}>
            {onPick && count(c) > 0
              ? <button className="pv-claim" aria-pressed={picked === i} onClick={() => onPick(picked === i ? null : i)} title={picked === i ? 'Show the whole map again' : `Show ${count(c) === 1 ? 'this page' : 'these ' + count(c) + ' pages'} on the map`}>{c.label === 'INFER' && <><span className="rp-chip lab-INFER">{c.labelText}</span> </>}{c.text}{picked === i && <small> · showing on the map, click to clear</small>}</button>
              : <>{c.label === 'INFER' && <><span className="rp-chip lab-INFER">{c.labelText}</span> </>}{c.text}</>}
            {c.basis && <details className="rp-basis"><summary>Why we say this</summary><p>{c.basis}</p></details>}
          </li>
        ))}
      </ul>
      {limit && claims.length > limit && !all && <button className="pv-link" onClick={() => setAll(true)}>Show {claims.length - limit} more</button>}
    </>
  );
}

interface Saved { answers: Record<string, string>; comments: Record<string, string>; general: string; name: string }
const emptySaved = (): Saved => ({ answers: {}, comments: {}, general: '', name: '' });

export function PackageViewer({ report, onClose }: { report: ClientReport; onClose?: () => void }) {
  const r = report;
  const manifest = useMemo(() => (r.map ? hydrate(r.map.site) : null), [r]);
  const fById = useMemo(() => new Map(r.findings.map((f) => [f.id, f])), [r]);
  const gById = useMemo(() => new Map(r.modes.guided.steps.map((s) => [s.id, s])), [r]);
  const tour = useMemo(() => r.modes.guided.tour.map((id) => gById.get(id)).filter((s): s is GuidedStep => Boolean(s)), [r, gById]);

  const hash = typeof location !== 'undefined' ? location.hash : '';
  const theme = 'dark' as const; // one scheme: the map is designed for dark, and a light mode did not flow with it
  const [idx, setIdx] = useState(() => Number(/step=([0-9]+)/.exec(hash)?.[1] ?? 0));
  const [explore, setExplore] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /** Which statement on the current step is lit on the map (index into the finding's list), or null for the whole map. */
  const [pickRaw, setPick] = useState<number | null | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const [stopIdx, setStopIdx] = useState(0);
  const key = `wo-answers:${r.meta.reportId}`;
  const [saved, setSaved] = useState<Saved>(() => { try { return { ...emptySaved(), ...JSON.parse(read(key) ?? '{}') }; } catch { return emptySaved(); } });
  const cardRef = useRef<HTMLDivElement>(null);
  // A page the visitor clicked on the map: the page card shows what we found there and can jump to the step that covers it.
  const [pagePick, setPagePick] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement>(null);

  const accent = r.client.accent && THEME_HEX.test(r.client.accent) ? r.client.accent : (BRAND ? BRAND.accent : '#7c5cff'); // the client's own colour wins; then the agency brand; then the built-in purple
  // Agency colours (optional) override the built-in scheme for the current light or dark mode. Hex only, so nothing else can reach the stylesheet.
  const tone = r.client.theme?.[theme] ?? {};
  const style = {
    '--rp-accent': accent, '--rp-on-accent': onAccent(accent),
    ...(r.client.theme?.secondary && THEME_HEX.test(r.client.theme.secondary) ? { '--rp-secondary': r.client.theme.secondary } : {}),
    // The page and 3D stage background is reserved for visibility: a report's client.theme.bg is ignored.
    ...(tone.ink && THEME_HEX.test(tone.ink) ? { '--ink': tone.ink } : {}),
    ...(tone.muted && THEME_HEX.test(tone.muted) ? { '--muted': tone.muted } : {}),
  } as React.CSSProperties;
  const logo = r.client.logo ? safeImageSrc(r.assets[r.client.logo]) : undefined;

  const total = tour.length;
  const cur = Math.max(0, Math.min(idx, total - 1));
  const go = useCallback((d: number) => { setStopIdx(0); setIdx((i) => Math.max(0, Math.min(total - 1, i + d))); }, [total]);
  const update = (fn: (s: Saved) => Saved) => setSaved((s) => { const n = fn(s); write(key, JSON.stringify(n)); return n; });
  const finish = () => { setExplore(true); setOpenId(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && pagePick) { e.preventDefault(); setPagePick(null); return; }
      if (explore) { if (e.key === 'Escape') { if (openId) setOpenId(null); else onClose?.(); } return; }
      if (['ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); go(1); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key.toLowerCase() === 'c') setCollapsed((x) => !x);
      else if (e.key.toLowerCase() === 'f') { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }
      else if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setPick(undefined), [idx, openId, explore]);
  // With an agency brand, the tab title names the client and the agency. (Set through the DOM title, never as markup.)
  useEffect(() => { if (BRAND && BRAND.name) document.title = `${r.client.name}: Website health walkthrough · ${BRAND.name}`; }, [r.client.name]);
  // Keep the step in the address, so a refresh comes back to the same place in the same report.
  useEffect(() => { try { if (!explore) history.replaceState(null, '', location.pathname + location.search + '#step=' + cur); } catch { /* not allowed here */ } }, [cur, explore]);

  // The page card takes focus when it opens, so keyboard and screen-reader users land on it; closing returns focus to the tour card.
  useEffect(() => { if (pagePick) pageRef.current?.focus({ preventScroll: true }); else cardRef.current?.focus({ preventScroll: true }); }, [pagePick]);
  // Move focus to the card when the step changes, so keyboard and screen-reader users follow the tour.
  useEffect(() => { cardRef.current?.focus({ preventScroll: true }); }, [cur, explore, openId]);

  // ---- what the globe should do for the current step -------------------------------------------
  const known = useMemo(() => (manifest ? new Set(manifest.nodes.map((n) => n.id)) : undefined), [manifest]);
  const step = openId ? gById.get(openId) : tour[cur];
  let focus: GlobeFocus = focusOf(null, 'default');
  let veil = 0, rotate = true, spotlight: Spotlight | null = null;
  let highlight: ReadonlySet<string> | null = null;
  let pick: number | null = null;
  if (step?.kind === 'finding') {
    const f = fById.get(step.findingId);
    spotlight = f?.spotlight ?? null; rotate = false;
    // Default: the whole map, every page lit. Choosing a statement brings its pages forward and fades the rest.
    // Default: the first statement that points at pages is already lit, and the camera is already there. Clear it to see the whole map.
    const first = step.beats.found.findIndex((c) => c.nodeIds?.some((id) => known?.has(id)));
    pick = pickRaw === undefined ? (first >= 0 ? first : null) : pickRaw;
    const claim = pick === null ? undefined : step.beats.found[pick];
    const ids = claim?.nodeIds?.filter((id) => known?.has(id)) ?? [];
    focus = { ...focusOf({ view: step.view ?? 'globe', filter: 'all' }, `f:${step.findingId}:${pick ?? 'all'}`), fly: ids[0] ?? null };
    if (ids.length) highlight = new Set(ids);
  } else if (step?.kind === 'map') {
    const st = step.stops[Math.min(stopIdx, step.stops.length - 1)];
    if (st) {
      focus = focusOf(st.focus, `m:${stopIdx}`); rotate = stopIdx === 0;
      highlight = manifest ? highlightForMap(manifest, st.focus) : null;
      if (highlight) focus = { ...focus, filter: 'all' };
    }
  } else if (step && step.kind !== 'welcome') veil = 0.35;


  const pageInfo = useMemo(() => (pagePick && manifest ? pageCardInfo(r, manifest.nodes as unknown as Array<{ id: string; title?: string; path?: string }>, tour, pagePick) : null), [pagePick, manifest, r, tour]);
  const jumpToStep = () => { if (!pageInfo?.jump) return; setExplore(false); setOpenId(null); setCollapsed(false); setIdx(pageInfo.jump.tourIndex); setStopIdx(pageInfo.jump.stopIdx); setPagePick(null); };

  const header = (
    <header className="rp-top">
      <span className="rp-brand-mini">{logo ? <img src={logo} alt="" /> : null}{r.client.name}{r.meta.review.state !== 'approved' && <span className="rp-draft">Draft</span>}</span>
      <div className="rp-tools">
        <FullscreenButton />
        {onClose && <button onClick={onClose}>Close</button>}
      </div>
    </header>
  );

  const showCard = !explore || openId;
  return (
    <div className={`rp-root rp-${theme} pv-root${BRAND ? ' rp-branded' : ''}${showCard && !collapsed ? ' split' : ''}`} style={style}>
      <div className="rp-globe-layer">
        {manifest ? <GlobeStage manifest={manifest} focus={focus} theme={theme} logoDataUri={logo} autoRotate={rotate} interactive highlightIds={highlight} onPickNode={setPagePick} pickedId={pagePick} /> : <div className="pv-noglobe">This report is a guided read, and a map appears when the report includes one.</div>}
      </div>
      <div className="rp-veil" style={{ opacity: veil }} />
      {manifest && <MapHelp />}
      {header}
      {BRAND && BRAND.footer && <footer className="pv-footer">{BRAND.footer}</footer>}
      {pagePick && pageInfo && (
        <aside ref={pageRef} tabIndex={-1} role="dialog" aria-modal="false" aria-label={`Page: ${pageInfo.title}`} className="pv-pagecard" data-testid="page-card">
          <h2>{pageInfo.title}</h2>
          {pageInfo.path && <p className="pv-pagepath">{pageInfo.path}</p>}
          {pageInfo.findings.length > 0
            ? <><h3>What we found here</h3><ul className="pv-bullets">{pageInfo.findings.map((f) => <li key={f.id}>{f.title}</li>)}</ul></>
            : <p className="pv-small">We did not flag anything on this page.</p>}
          <div className="pv-pagenav">
            {pageInfo.jump && <button type="button" className="pv-btn primary" onClick={jumpToStep}>Jump to this step</button>}
            <button type="button" className="pv-btn" onClick={() => setPagePick(null)}>Back to tour</button>
          </div>
        </aside>
      )}
      {showCard && step && collapsed && <button className="pv-reopen pv-btn primary" onClick={() => setCollapsed(false)} aria-label="Show the tour panel">Show tour · step {cur + 1} of {tour.length}</button>}
      {showCard && step && !collapsed && (
        <aside ref={cardRef} tabIndex={-1} role="dialog" aria-modal="false" aria-label={`Guided tour, step ${cur + 1} of ${tour.length}`} className="pv-card">
          <div className="pv-card-head">
            {openId ? <button className="pv-link" onClick={() => setOpenId(null)}>← Back to the list</button> : <span className="pv-step">Step {cur + 1} of {tour.length}</span>}
            <span className="pv-head-actions">{!openId && step.kind !== 'send' && <button className="pv-link" onClick={finish}>Skip tour</button>}<button className="pv-link" onClick={() => setCollapsed(true)} aria-label="Hide the tour panel" title="Hide the tour panel (C)">Hide</button></span>
          </div>
          <div className="pv-card-body">
            <StepBody step={step} r={r} fById={fById} stopIdx={stopIdx} setStopIdx={setStopIdx} saved={saved} update={update} spotlight={spotlight} pick={pick} setPick={setPick} known={known} />
          </div>
          {!openId && (
            <div className="pv-card-nav">
              <button className="pv-btn" onClick={() => go(-1)} disabled={cur === 0}>Back</button>
              <div className="pv-dots" role="group" aria-label="Steps">{tour.map((t, i) => { const name = (t as { title?: string }).title ?? (t.kind === 'send' ? 'Your feedback' : `Step ${i + 1}`); return <button key={t.id} type="button" className={i === cur ? 'on' : i < cur ? 'done' : ''} data-title={name} aria-label={`Go to step ${i + 1}: ${name}`} aria-current={i === cur ? 'step' : undefined} onClick={() => { setStopIdx(0); setIdx(i); }} />; })}</div>
              {cur < tour.length - 1 ? <button className="pv-btn primary" onClick={() => go(1)}>{step.kind === 'welcome' ? 'Start the tour' : 'Next'}</button> : <button className="pv-btn primary" onClick={finish}>Finish</button>}
            </div>
          )}
        </aside>
      )}
      {explore && !openId && !collapsed && (
        <aside ref={cardRef} tabIndex={-1} role="dialog" aria-label="All findings" className="pv-card">
          <div className="pv-card-head"><span className="pv-step">You have finished the tour</span><button className="pv-link" onClick={() => { setExplore(false); setIdx(0); }}>Replay the tour</button></div>
          <div className="pv-card-body">
            <h2>Everything we found</h2>
            <p className="pv-lead">Explore the map freely, or open any finding to read it again.</p>
            <h3>Fix these first</h3>
            <p className="pv-small">{r.modes.guided.top.basis}</p>
            <ol className="pv-list">{r.modes.guided.top.findingIds.map((id) => <li key={id}><button className="pv-link big" onClick={() => setOpenId(`g-${id}`)}>{fById.get(id)?.title}</button></li>)}</ol>
            {r.modes.guided.more.length > 0 && <><h3>Also worth knowing</h3>
              <ul className="pv-list">{r.modes.guided.more.map((id) => { const s = gById.get(id) as GFinding | undefined; return s ? <li key={id}><button className="pv-link big" onClick={() => setOpenId(id)}>{s.title}</button></li> : null; })}</ul></>}
            <h3>Your feedback</h3>
            <button className="pv-btn" onClick={() => { setExplore(false); setIdx(tour.length - 1); }}>Review and send</button>
          </div>
        </aside>
      )}
    </div>
  );
}

function Horizons({ hz, fById }: { hz: Array<{ id: string; label: string; findingIds: string[] }>; fById: Map<string, RFinding> }) {
  return <div className="pv-hz">{hz.map((h) => <div key={h.id}><h3>{h.label}</h3><ul className="pv-bullets">{h.findingIds.map((id) => <li key={id}>{fById.get(id)?.title}<small> · {fById.get(id)?.owner.label}</small></li>)}</ul></div>)}</div>;
}

interface BodyProps {
  step: GuidedStep; r: ClientReport; fById: Map<string, RFinding>; stopIdx: number; setStopIdx: (n: number) => void;
  saved: Saved; update: (fn: (s: Saved) => Saved) => void; spotlight: Spotlight | null;
  pick: number | null; setPick: (i: number | null) => void; known?: ReadonlySet<string>;
}

function SendStep({ r, saved, update, body }: { r: ClientReport; saved: Saved; update: BodyProps['update']; body: string[] }) {
  const fb = composeFeedback(r, saved);
  const [note, setNote] = useState<string | null>(null);
  // Served by the report server: the message goes through the server, which holds the address and sends the email to the team.
  const serverFb = typeof document !== 'undefined' ? document.documentElement.dataset.serverFeedback : undefined;
  const [sent, setSent] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const sendViaServer = async () => {
    setSent('sending');
    try {
      const res = await fetch(serverFb!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: saved.answers, comments: saved.comments, general: saved.general, name: saved.name }) });
      setSent(res.ok ? 'sent' : 'error');
    } catch { setSent('error'); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText([fb.subject, fb.body].join(String.fromCharCode(10, 10))); setNote('Copied. Paste it into an email to us.'); }
    catch { setNote('To copy the text, select it in the box above and copy it with your keyboard.'); }
  };
  const answered = Object.keys(saved.answers).length + Object.values(saved.comments).filter((x) => x.trim()).length;
  return (
    <>
      <h2>Tell us what you think</h2>
      {body.map((p, i) => <p key={i}>{p}</p>)}
      <label className="pv-field"><span>Your name (optional)</span><input value={saved.name} maxLength={120} onChange={(e) => update((s) => ({ ...s, name: e.target.value }))} autoComplete="name" /></label>
      <label className="pv-field"><span>Anything else you want us to know?</span><textarea rows={3} maxLength={1500} value={saved.general} onChange={(e) => update((s) => ({ ...s, general: e.target.value }))} /></label>
      <h3>What will be sent</h3>
      <pre className="pv-preview" aria-label="Message preview">{fb.body}</pre>
      {answered === 0 && <p className="pv-note">Ready when you are. You can go back to answer a few findings, or send just your notes.</p>}
      <div className="pv-opts">
        {serverFb
          ? <button className="pv-btn primary" disabled={sent === 'sending' || sent === 'sent' || (answered === 0 && !saved.general.trim())} onClick={() => void sendViaServer()}>{sent === 'sending' ? 'Sending…' : sent === 'sent' ? 'Sent to the team' : 'Send my feedback to the team'}</button>
          : fb.mailto
          ? <a className="pv-btn primary" href={fb.mailto}>Email my feedback to the team</a>
          : <button className="pv-btn primary" onClick={() => void copy()}>Copy my feedback</button>}
      </div>
      {serverFb && sent === 'sent' && <p className="pv-note" role="status">Thank you. Your feedback was sent to the team. We will be in touch.</p>}
      {serverFb && sent === 'error' && <p className="pv-note" role="alert">Please try sending again in a few minutes. Your answers stay on this device.</p>}
      {serverFb && sent !== 'sent' && <p className="pv-small">Pressing send delivers your answers and notes to your agency's team.</p>}
      {!serverFb && fb.mailto && <p className="pv-small">This opens your own email app with the message ready to go, addressed to {r.feedback?.to}. Your message goes out when you press send there.</p>}
      {!serverFb && !fb.mailto && <p className="pv-note">To share your feedback, copy it and send it to your agency.</p>}
      {fb.truncated && <p className="pv-note">The message is long, so the email will hold a shortened version.</p>}
      {note && <p className="pv-note" role="status">{note}</p>}
    </>
  );
}

function StepBody({ step, r, fById, stopIdx, setStopIdx, saved, update, pick, setPick, known }: BodyProps) {
  const [term, setTerm] = useState<string | null>(null);
  useEffect(() => setTerm(null), [step.id]);
  if (step.kind === 'welcome') return <><h2>{step.title}</h2>{step.body.map((p, i) => <p key={i}>{p}</p>)}<p className="pv-note">About {r.modes.guided.estimatedMinutes} minutes. Your answers stay on this device unless you choose to send them.</p></>;
  if (step.kind === 'orientation') return <><h2>{step.title}</h2>{step.body.map((p, i) => <p key={i}>{p}</p>)}<div className="pv-tiles">{step.tiles.map((t, i) => <div key={i} className="pv-tile"><b>{t.value}</b><span>{t.label}</span><small>{t.meaning}</small></div>)}</div></>;
  if (step.kind === 'map') {
    const st = step.stops[Math.min(stopIdx, step.stops.length - 1)];
    return <><h2>{step.title}</h2>{step.body.map((p, i) => <p key={i}>{p}</p>)}<p className="pv-caption">{st?.caption.text}</p>
      {step.stops.length > 1 && <div className="pv-stops">{step.stops.map((_, i) => <button key={i} className={`pv-btn${i === stopIdx ? ' primary' : ''}`} onClick={() => setStopIdx(i)} aria-label={`Map view ${i + 1}`}>{i + 1}</button>)}</div>}</>;
  }
  if (step.kind === 'plan') return <><h2>{step.title}</h2>{step.body.map((p, i) => <p key={i}>{p}</p>)}<Horizons hz={step.horizons} fById={fById} /></>;
  if (step.kind === 'limits') return <><h2>{step.title}</h2>{step.body.map((p, i) => <p key={i}>{p}</p>)}<Claims claims={step.claims} /></>;
  if (step.kind === 'decisions') return <><h2>{step.title}</h2>{step.body.map((p, i) => <p key={i}>{p}</p>)}<ul className="pv-bullets">{step.questions.map((q, i) => <li key={i}>{q.question}</li>)}</ul></>;
  if (step.kind === 'send') return <SendStep r={r} saved={saved} update={update} body={step.body} />;
  const f = fById.get(step.findingId);
  const b = step.beats, cur = saved.answers[step.checkpoint.id];
  const shot = f?.evidence ? safeImageSrc(r.assets[f.evidence.image]) : undefined;
  return (
    <>
      <div className="rp-chips">
        {step.tier === 'top' && <span className="rp-chip pv-top" title={r.modes.guided.top.basis}>Fix first · {step.rank} of {r.modes.guided.top.findingIds.length}</span>}
        {f && <><span className={`rp-chip sev-${f.severity.level}`} title={f.severity.basis}>{SEV[f.severity.level]}</span><span className="rp-chip" title={f.effort.basis}>{EFFORT[f.effort.size]}</span></>}
      </div>
      {f && <p className="pv-small pv-meta">{f.categories.length > 0 && <>Area: {f.categories.map((c) => c.label).join(', ')}</>}{f.categories.length > 0 && ' · '}Usually handled by: {f.owner.label}</p>}
      <h2>{step.title}</h2>
      {b.found.some((c) => c.nodeIds?.length) ? <p className="pv-note">Choose any finding below to see the pages it affects on the map.</p> : <p className="pv-note">This applies to the whole site, so the map as a whole is the place to look.</p>}
      <h3>What we found</h3><Claims claims={b.found} picked={pick} onPick={setPick} known={known} />
      <div className="pv-brief">
        <p><b>What it means</b> {b.meaning.inPlain}</p>
        {b.meaning.picture && <p className="pv-picture"><em>{b.meaning.picture}</em></p>}
        {b.ifIgnored && <p><b>If it stays</b> {b.ifIgnored.text}</p>}
        {b.ifIgnored && <details className="rp-basis"><summary>Our view, and why</summary><p>{b.ifIgnored.basis}</p></details>}
        <p><b>Your part</b> {b.yourPart}</p>
      </div>
      {b.howFixed.length > 0 && <details><summary>How it usually gets fixed</summary><ul className="pv-bullets">{b.howFixed.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}
      {b.askYourTeam.length > 0 && <details><summary>Questions to ask your team</summary><ul className="pv-bullets">{b.askYourTeam.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}
      {step.terms.length > 0 && <><h3>Words used here</h3><div>{step.terms.map((id) => { const g = r.glossary.find((x) => x.id === id); return g ? <button key={id} className="pv-term" aria-expanded={term === id} onClick={() => setTerm(term === id ? null : id)}>{g.term}</button> : null; })}</div>
        {term && <p className="pv-def"><b>{r.glossary.find((x) => x.id === term)?.term}: </b>{r.glossary.find((x) => x.id === term)?.plain}</p>}</>}
      {shot && f?.evidence && <figure className="pv-shot"><img src={shot} alt={f.evidence.caption} /><figcaption>{f.evidence.caption}</figcaption></figure>}
      <h3>{step.checkpoint.question}</h3>
      <div className="pv-opts pv-answers" role="group" aria-label={step.checkpoint.question}>{step.checkpoint.options.map((o) => <button key={o} className="pv-btn" aria-pressed={cur === o} title={o} onClick={() => update((s) => ({ ...s, answers: { ...s.answers, [step.checkpoint.id]: o } }))}>{SHORT_ANSWER[o] ?? o}</button>)}</div>
      <label className="pv-field"><span>Anything to add about this? (optional)</span>
        <textarea rows={2} maxLength={600} value={saved.comments[step.findingId] ?? ''} onChange={(e) => update((s) => ({ ...s, comments: { ...s.comments, [step.findingId]: e.target.value } }))} /></label>
    </>
  );
}

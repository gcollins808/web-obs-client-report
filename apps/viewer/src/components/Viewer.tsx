import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SiteGraphManifest } from '../../../../vendor/web-obs/types/site';
import { makeCtx, renderText, sceneActive, type Issue, type Scene, type Walkthrough } from '../../../../packages/contract/src/core';
import { GlobeStage, focusFromStop } from './GlobeStage';
import { safeImageSrc } from '../../../../packages/contract/src/safe';
import {
  Cover, Glance, Inventory, IssueView, MapCaption, Notes, ReadMap, Roadmap, Since, type SceneEnv,
} from './Scenes';

export interface ReportData { walkthrough: Walkthrough; manifest: SiteGraphManifest; images: Record<string, string> }

interface Step { scene: Scene; sub: number; count: number }

function subCount(s: Scene): number {
  if (s.type === 'map-tour') return Math.max(1, s.stops?.length ?? 1);
  if (s.type === 'issue') return 3;
  return 1;
}

export function buildSteps(w: Walkthrough, m: SiteGraphManifest, presenter: boolean): Step[] {
  const out: Step[] = [];
  for (const scene of w.scenes) {
    if (!sceneActive(scene, m)) continue;
    if ((scene.audience ?? 'client') === 'presenter' && !presenter) continue;
    const count = subCount(scene);
    for (let sub = 0; sub < count; sub++) out.push({ scene, sub, count });
  }
  return out;
}

const readStore = (k: string): string | null => { try { return window.localStorage?.getItem(k) ?? null; } catch { return null; } };
const writeStore = (k: string, v: string) => { try { window.localStorage?.setItem(k, v); } catch { /* storage unavailable */ } };

/** Black or white text, whichever reads better on the accent colour. */
function onAccent(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? '#10131a' : '#ffffff';
}

const DIM: Partial<Record<Scene['type'], number>> = { cover: 0.5, glance: 0.82, issue: 0.88, 'since-last-capture': 0.88, inventory: 0.92, roadmap: 0.9, limits: 0.9, 'next-steps': 0.86, 'map-tour': 0 };

interface ViewerProps {
  data: ReportData;
  initialMode?: 'present' | 'read';
  /** Admin preview: lets the author see presenter-only content straight away. */
  startWithPresenter?: boolean;
  /** False in the client copy: no notes panel, no key to reveal one. */
  notes?: boolean;
  /** Same key in two windows keeps them on the same slide. */
  syncKey?: string;
  onClose?: () => void;
}

export function Viewer({ data, initialMode = 'present', startWithPresenter = false, notes = true, syncKey, onClose }: ViewerProps) {
  const { walkthrough: w, manifest: m, images } = data;
  const ctx = useMemo(() => makeCtx(m), [m]);
  const issues = useMemo(() => new Map<string, Issue>(w.issues.map((i) => [i.id, i])), [w]);
  const [mode, setMode] = useState<'present' | 'read'>(initialMode);
  const [presenter, setPresenter] = useState(notes && startWithPresenter);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (readStore('wo-report:theme') === 'light' ? 'light' : 'dark'));
  const [idx, setIdx] = useState(0);
  const [menu, setMenu] = useState(false);
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const steps = useMemo(() => buildSteps(w, m, presenter), [w, m, presenter]);
  const cur = steps[Math.min(idx, steps.length - 1)];
  useEffect(() => { if (idx > steps.length - 1) setIdx(Math.max(0, steps.length - 1)); }, [steps.length, idx]);
  useEffect(() => { if (!presenter) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [presenter]);

  // Two windows on one slide: the shared one for the screen, the presenter one for the notes.
  const chan = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (!syncKey || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(syncKey);
    chan.current = ch;
    ch.onmessage = (e: MessageEvent<{ sceneId?: string; sub?: number }>) => {
      const d = e.data;
      if (!d || typeof d.sceneId !== 'string') return;
      const i = steps.findIndex((s) => s.scene.id === d.sceneId && s.sub === d.sub);
      if (i >= 0) setIdx(i);
    };
    return () => { ch.close(); chan.current = null; };
  }, [syncKey, steps]);
  const here = steps[Math.min(idx, steps.length - 1)];
  useEffect(() => { if (here) chan.current?.postMessage({ sceneId: here.scene.id, sub: here.sub }); }, [here?.scene.id, here?.sub]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((d: number) => setIdx((i) => Math.max(0, Math.min(steps.length - 1, i + d))), [steps.length]);
  const jumpScene = (id: string) => { const i = steps.findIndex((s) => s.scene.id === id); if (i >= 0) { setIdx(i); setMenu(false); } };
  const toggleTheme = () => setTheme((x) => { const n = x === 'dark' ? 'light' : 'dark'; writeStore('wo-report:theme', n); return n; });
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (mode === 'present') {
        if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); go(1); }
        else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); go(-1); }
        else if (e.key === 'Home') setIdx(0);
        else if (e.key === 'End') setIdx(steps.length - 1);
        else if (e.key.toLowerCase() === 'g') setMenu((x) => !x);
      }
      if (e.key.toLowerCase() === 'p' && notes) setPresenter((x) => !x);
      else if (e.key.toLowerCase() === 'r') setMode((x) => (x === 'present' ? 'read' : 'present'));
      else if (e.key.toLowerCase() === 't') toggleTheme();
      else if (e.key.toLowerCase() === 'f') fullscreen();
      else if (e.key === 'Escape') { if (menu) setMenu(false); else onClose?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, go, steps.length, menu, onClose]);

  const accent = w.brand.accent.hex && /^#[0-9a-f]{6}$/i.test(w.brand.accent.hex) ? w.brand.accent.hex : '#7c5cff';
  const style = { '--rp-accent': accent, '--rp-on-accent': onAccent(accent) } as React.CSSProperties;
  const env: SceneEnv = { w, m, ctx, images, issues, full: mode === 'read', presenter, theme };
  const t = (s: string) => renderText(s, ctx);
  const sceneLabel = (s: Scene) => t(s.title ?? (s.issueId ? issues.get(s.issueId)?.title ?? s.id : s.id));
  const uniqueScenes = steps.filter((s, i) => steps.findIndex((x) => x.scene.id === s.scene.id) === i);

  // ----- read / print mode -----
  if (mode === 'read') {
    const list = w.scenes.filter((s) => sceneActive(s, m) && (s.audience ?? 'client') === 'client');
    return (
      <div className={`rp-root rp-${theme} rp-read`} style={style}>
        <header className="rp-top rp-top-read">
          <span className="rp-brand-mini">{w.brand.name}{w.authoring.reviewState !== 'approved' && <span className="rp-draft" title="Review in progress">Draft</span>}</span>
          <div className="rp-tools">
            <button onClick={() => setMode('present')} title="Walkthrough mode (R)">Walkthrough</button>
            <button onClick={() => window.print()} title="Print or save as PDF">Print / PDF</button>
            <button onClick={toggleTheme} title="Theme (T)">{theme === 'dark' ? 'Light' : 'Dark'}</button>
            {onClose && <button onClick={onClose}>Close</button>}
          </div>
        </header>
        <main className="rp-readpage">
          {list.map((s) => (
            <section key={s.id} className={`rp-readsec t-${s.type}`}>
              {s.type === 'cover' && <Cover env={env} scene={s} />}
              {s.type === 'glance' && <Glance env={env} scene={s} active />}
              {s.type === 'map-tour' && <ReadMap env={env} scene={s} />}
              {s.type === 'issue' && issues.get(s.issueId ?? '') && <IssueView env={env} issue={issues.get(s.issueId!)!} sub={2} />}
              {s.type === 'since-last-capture' && <Since env={env} scene={s} />}
              {s.type === 'inventory' && <Inventory env={env} scene={s} />}
              {s.type === 'roadmap' && <Roadmap env={env} scene={s} />}
              {s.type === 'limits' && <Notes env={env} scene={s} kicker="Scope" />}
              {s.type === 'next-steps' && <Notes env={env} scene={s} kicker="Next" />}
            </section>
          ))}
          <footer className="rp-readfoot">Generated from a capture taken {new Date(m.capturedAt).toLocaleString()}. {w.authoring.reviewState === 'approved' ? 'Reviewed' : 'Draft, review in progress'}.</footer>
        </main>
      </div>
    );
  }

  // ----- walkthrough mode -----
  if (!cur) return <div className={`rp-root rp-${theme}`} style={style}><p className="rp-empty">Scenes will appear here once this walkthrough has some.</p></div>;
  const scene = cur.scene;
  const stop = scene.type === 'map-tour' ? scene.stops?.[Math.min(cur.sub, (scene.stops?.length ?? 1) - 1)] : undefined;
  const focus = focusFromStop(m, stop);
  const dim = DIM[scene.type] ?? 0.85;
  const issue = scene.issueId ? issues.get(scene.issueId) : undefined;
  const talk = [...new Set([...(scene.talk ?? []), ...(issue?.talk ?? []), ...(stop?.talk ?? [])].map(t))];
  const next = steps[idx + 1];
  const elapsed = Math.floor((now - t0) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className={`rp-root rp-${theme}${presenter ? ' with-notes' : ''}`} style={style}>
      <div className="rp-globe-layer" style={{ ['--dim' as string]: dim }} data-blurred={dim > 0.5}>
        <GlobeStage manifest={m} focus={focus} theme={theme} logoDataUri={safeImageSrc(images.logo)} autoRotate={scene.type !== 'map-tour' || cur.sub === 0} interactive={scene.type === 'map-tour'} />
      </div>
      <div className="rp-veil" style={{ opacity: dim }} />
      <header className="rp-top">
        <span className="rp-brand-mini">{safeImageSrc(images.logo) ? <img src={safeImageSrc(images.logo)} alt="" /> : null}{w.brand.name}{w.authoring.reviewState !== 'approved' && <span className="rp-draft" title="Review in progress">Draft</span>}</span>
        <div className="rp-tools">
          <button onClick={() => setMenu((x) => !x)} title="Jump to a section (G)">Sections</button>
          {notes && <button onClick={() => setPresenter((x) => !x)} aria-pressed={presenter} title="Presenter notes (P)">Notes</button>}
          <button onClick={() => setMode('read')} title="Read mode (R)">Read</button>
          <button onClick={toggleTheme} title="Theme (T)">{theme === 'dark' ? 'Light' : 'Dark'}</button>
          <button onClick={fullscreen} title="Full screen (F)">Full screen</button>
          {onClose && <button onClick={onClose}>Close</button>}
        </div>
      </header>

      <main className="rp-stage" key={`${scene.id}`}>
        {scene.type === 'cover' && <Cover env={env} scene={scene} />}
        {scene.type === 'glance' && <Glance env={env} scene={scene} active />}
        {scene.type === 'map-tour' && <MapCaption env={env} scene={scene} sub={cur.sub} />}
        {scene.type === 'issue' && issue && <div className="rp-issue-wrap"><IssueView env={env} issue={issue} sub={cur.sub} /></div>}
        {scene.type === 'since-last-capture' && <Since env={env} scene={scene} />}
        {scene.type === 'inventory' && <Inventory env={env} scene={scene} />}
        {scene.type === 'roadmap' && <Roadmap env={env} scene={scene} />}
        {scene.type === 'limits' && <Notes env={env} scene={scene} kicker="Scope" />}
        {scene.type === 'next-steps' && <Notes env={env} scene={scene} kicker="Next" />}
      </main>

      <footer className="rp-nav">
        <button className="rp-navbtn" onClick={() => go(-1)} disabled={idx === 0} aria-label="Previous">‹</button>
        <div className="rp-progress" role="tablist" aria-label="Progress">
          {steps.map((s, i) => <button key={i} role="tab" aria-selected={i === idx} aria-label={`${sceneLabel(s.scene)} ${s.count > 1 ? s.sub + 1 : ''}`} className={`seg${i === idx ? ' on' : i < idx ? ' done' : ''}${s.sub === 0 ? ' first' : ''}`} onClick={() => setIdx(i)} />)}
        </div>
        <span className="rp-where">{sceneLabel(scene)}</span>
        <button className="rp-navbtn" onClick={() => go(1)} disabled={idx >= steps.length - 1} aria-label="Next">›</button>
      </footer>

      {menu && (
        <nav className="rp-menu" aria-label="Sections">
          {uniqueScenes.map((s) => <button key={s.scene.id} className={s.scene.id === scene.id ? 'on' : ''} onClick={() => jumpScene(s.scene.id)}>{sceneLabel(s.scene)}{(s.scene.audience === 'presenter') ? ' (presenter only)' : ''}</button>)}
        </nav>
      )}

      {notes && presenter && (
        <aside className="rp-notes" aria-label="Presenter notes">
          <div className="rp-notes-head"><strong>Presenter notes</strong><span>{mm}:{ss}</span></div>
          <p className="rp-notes-where">{sceneLabel(scene)}{cur.count > 1 ? ` · step ${cur.sub + 1} of ${cur.count}` : ''}</p>
          {(scene.audience === 'presenter') && <p className="rp-notes-warn">This scene is for the presenter and stays out of the client file.</p>}
          {issue && issue.disposition !== 'confirmed' && <p className="rp-notes-warn"><strong>{issue.disposition}:</strong> {t(issue.dispositionNote ?? '')}</p>}
          {talk.length ? <ul>{talk.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="rp-muted">Notes for this step will appear here.</p>}
          {issue && <div className="rp-notes-basis"><h4>Why these ratings</h4><p><strong>Priority:</strong> {t(issue.severity.basis)}</p><p><strong>Effort:</strong> {t(issue.effort.basis)}</p></div>}
          {next && <p className="rp-notes-next">Next: {sceneLabel(next.scene)}{next.count > 1 ? ` (${next.sub + 1}/${next.count})` : ''}</p>}
          {syncKey && <p className="rp-muted"><button className="rp-linkbtn" onClick={() => window.open(location.href.split('#')[0] + '#clean', 'wo-clean', 'popup,width=1280,height=800')}>Open a clean window to share</button><br />It follows this one. Share that window and keep this one for yourself.</p>}
          <p className="rp-keys">← → move · G sections · P notes · R read mode · T theme · F full screen</p>
        </aside>
      )}
    </div>
  );
}

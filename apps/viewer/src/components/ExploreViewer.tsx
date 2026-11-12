// Explore mode: the agency's own tool for a client meeting. The whole scrape on the 3D globe, a browser for every
// engine finding and every page, and a "show list" you build as you go. Loaded from an explore pack, which is never
// sent to a client. By default it hides held-back findings and private notes so a screen-share stays safe.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SiteGraphManifest } from '../../../../vendor/web-obs/types/site';
import { AUDIT_CATEGORIES } from '../../../../vendor/web-obs/data/siteAudit';
import { attentionNodeIds } from '../../../../vendor/web-obs/data/mapAttention';
import { makeCtx, nodesAffected } from '../../../../packages/contract/src/core';
import { spotlightFilter, type ExplorePack, type ExploreStory } from '../../../../packages/contract/src/package';
import { FullscreenButton, MapHelp } from './ToolIcons';
import { GlobeStage, type GlobeFocus } from './GlobeStage';
import { focusOf, hydrate } from './PackageViewer';

type Tab = 'points' | 'findings' | 'pages' | 'show';
interface Pin { kind: 'story' | 'finding' | 'page'; id: string }
interface EngineFinding { id: string; category: string; tone: string; title: string; explanation?: string; targets?: Array<{ url?: string; label?: string; detail?: string }>; targetCount?: number }

const SEV: Record<string, string> = { high: 'High priority', medium: 'Medium priority', low: 'Lower priority' };
const read = (k: string): string | null => { try { return window.localStorage?.getItem(k) ?? null; } catch { return null; } };
const write = (k: string, v: string) => { try { window.localStorage?.setItem(k, v); } catch { /* storage unavailable */ } };
const countOf = (f: EngineFinding) => (typeof f.targetCount === 'number' ? f.targetCount : f.targets?.length ?? 0);

export function ExploreViewer({ pack, onClose }: { pack: ExplorePack; onClose?: () => void }) {
  const manifest = useMemo<SiteGraphManifest>(() => hydrate(pack.capture), [pack]);
  const ctx = useMemo(() => makeCtx(manifest), [manifest]);
  const attention = useMemo(() => attentionNodeIds(manifest), [manifest]);
  const findings = useMemo(() => ((manifest.audit?.findings ?? []) as unknown as EngineFinding[]), [manifest]);
  const nodeById = useMemo(() => new Map(manifest.nodes.map((n) => [n.id, n])), [manifest]);
  const stories = pack.stories;
  const storyById = useMemo(() => new Map(stories.map((s) => [s.id, s])), [stories]);

  const pinKey = `wo-pins:${pack.meta.reportId}`;
  const theme = 'dark' as const;
  const [tab, setTab] = useState<Tab>('points');
  const [sel, setSel] = useState<Pin | null>(null);
  const [q, setQ] = useState('');
  const [privateOn, setPrivateOn] = useState(false);
  const [pins, setPins] = useState<Pin[]>(() => { try { return JSON.parse(read(pinKey) ?? '[]') as Pin[]; } catch { return []; } });
  const [focus, setFocus] = useState<GlobeFocus>(focusOf(null, 'default'));
  const panelRef = useRef<HTMLElement>(null);
  const seq = useRef(0);

  const accent = pack.client.accent && /^#[0-9a-f]{6}$/i.test(pack.client.accent) ? pack.client.accent : '#7c5cff';
  const style = { '--rp-accent': accent, '--rp-on-accent': '#fff' } as React.CSSProperties;
  const savePins = (n: Pin[]) => { setPins(n); write(pinKey, JSON.stringify(n)); };
  const pinned = (p: Pin) => pins.some((x) => x.kind === p.kind && x.id === p.id);
  const togglePin = (p: Pin) => savePins(pinned(p) ? pins.filter((x) => !(x.kind === p.kind && x.id === p.id)) : [...pins, p]);
  const movePin = (i: number, d: -1 | 1) => { const a = [...pins], j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; savePins(a); };

  const flyTo = (ids: string[], filter: 'all' | 'issues' | 'orphans' = 'all') => setFocus(focusOf({ view: 'globe', filter, nodeIds: ids }, `x:${++seq.current}`));
  const showFinding = (id: string) => { const ids = nodesAffected(manifest, ctx, [id]); if (ids.length) flyTo(ids, spotlightFilter(manifest, ids, attention)); };
  const open = (p: Pin) => {
    setSel(p);
    if (p.kind === 'page') flyTo([p.id]);
    else if (p.kind === 'finding') showFinding(p.id);
    else { const s = storyById.get(p.id); if (s?.spotlight.kind === 'pages') flyTo(s.spotlight.nodeIds, s.spotlight.filter); else setFocus(focusOf(null, `x:${++seq.current}`)); }
  };
  useEffect(() => { panelRef.current?.scrollTo?.({ top: 0 }); }, [sel, tab]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'p') setPrivateOn((x) => !x);
      else if (e.key === 'Escape') { if (sel) setSel(null); else onClose?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, onClose]);

  const visibleStories = stories.filter((s) => privateOn || s.disposition === 'confirmed');
  const topStories = pack.ranking.topFindingIds.map((id) => storyById.get(id)).filter((s): s is ExploreStory => Boolean(s));
  const byCategory = useMemo(() => {
    const g = new Map<string, EngineFinding[]>();
    for (const f of findings) (g.get(f.category) ?? g.set(f.category, []).get(f.category)!).push(f);
    return AUDIT_CATEGORIES.map((c) => ({ ...c, list: (g.get(c.id) ?? []).sort((a, b) => countOf(b) - countOf(a)) })).filter((c) => c.list.length);
  }, [findings]);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return manifest.nodes.filter((n) => n.kind !== 'external-domain' && (!t || `${n.title ?? ''} ${n.path ?? ''} ${n.url ?? ''}`.toLowerCase().includes(t))).slice(0, 80);
  }, [manifest, q]);

  const label = (p: Pin) => (p.kind === 'story' ? storyById.get(p.id)?.title : p.kind === 'finding' ? findings.find((f) => f.id === p.id)?.title : nodeById.get(p.id)?.title || nodeById.get(p.id)?.path) ?? p.id;

  const PinBtn = ({ p }: { p: Pin }) => <button className="pv-btn" aria-pressed={pinned(p)} onClick={() => togglePin(p)}>{pinned(p) ? '★ In show list' : '☆ Add to show list'}</button>;

  const StoryView = ({ s }: { s: ExploreStory }) => (
    <article>
      <div className="rp-chips">
        <span className={`rp-chip sev-${s.severity.level}`} title={s.severity.basis}>{SEV[s.severity.level]}</span><span className="rp-chip">Effort {s.effort.size}</span><span className="rp-chip">{s.owner.label}</span>
        {s.disposition !== 'confirmed' && <span className="rp-chip warn">Held back: {s.disposition}</span>}
      </div>
      <h2>{s.title}</h2>
      <p className="pv-small">{s.categories.map((c) => c.label).join(', ')} · {s.scope === 'sitewide' ? 'whole site' : `${s.pagesAffected} page${s.pagesAffected === 1 ? '' : 's'} affected`}</p>
      {privateOn && s.dispositionNote && <p className="pv-note">{s.dispositionNote}</p>}
      {privateOn && pack.notes[s.id] && <div className="pv-notes-inline"><b>Your notes</b><ul>{pack.notes[s.id].map((n, i) => <li key={i}>{n}</li>)}</ul></div>}
      <h3>What we saw</h3>
      <ul className="pv-claims">{s.observed.map((c, i) => <li key={i}><span className={`rp-chip lab-${c.label}`}>{c.labelText}</span> {c.text}</li>)}</ul>
      {s.implications.length > 0 && <><h3>Why it matters (our view)</h3><ul className="pv-claims">{s.implications.map((c, i) => <li key={i}>{c.text}<details className="rp-basis"><summary>Basis</summary><p>{c.basis}</p></details></li>)}</ul></>}
      {s.caveat && <p className="pv-note">{s.caveat}</p>}
      {s.fix.length > 0 && <><h3>How it gets fixed</h3><ul className="pv-bullets">{s.fix.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      <h3>Engine findings behind this</h3>
      <ul className="pv-bullets">{s.findings.map((id) => <li key={id}><button className="pv-link" onClick={() => { setTab('findings'); open({ kind: 'finding', id }); }}>{findings.find((f) => f.id === id)?.title ?? id}</button></li>)}</ul>
      <div className="pv-opts"><PinBtn p={{ kind: 'story', id: s.id }} /></div>
    </article>
  );

  const FindingView = ({ f }: { f: EngineFinding }) => {
    const ids = nodesAffected(manifest, ctx, [f.id]);
    return (
      <article>
        <div className="rp-chips"><span className="rp-chip">{AUDIT_CATEGORIES.find((c) => c.id === f.category)?.label ?? f.category}</span><span className={`rp-chip${f.tone === 'attention' ? ' warn' : ''}`}>{f.tone}</span><span className="rp-chip">{countOf(f)} item{countOf(f) === 1 ? '' : 's'}</span></div>
        <h2>{f.title}</h2>
        {f.explanation && <p>{f.explanation}</p>}
        <div className="pv-opts">
          {ids.length > 0 && <button className="pv-btn primary" onClick={() => showFinding(f.id)}>Show {ids.length} page{ids.length === 1 ? '' : 's'} on the map</button>}
          <PinBtn p={{ kind: 'finding', id: f.id }} />
        </div>
        <h3>Where</h3>
        <ul className="pv-list2">{(f.targets ?? []).slice(0, 40).map((t, i) => {
          const n = manifest.nodes.find((x) => x.url === t.url);
          return <li key={i}>{n ? <button className="pv-link" onClick={() => open({ kind: 'page', id: n.id })}>{t.label || n.title || t.url}</button> : <span>{t.label || t.url}</span>}{t.detail && <small> · {t.detail}</small>}</li>;
        })}</ul>
        {(f.targets?.length ?? 0) > 40 && <p className="pv-small">Showing 40 of {f.targets!.length}.</p>}
      </article>
    );
  };

  const PageView = ({ id }: { id: string }) => {
    const n = nodeById.get(id) as unknown as Record<string, unknown> | undefined;
    if (!n) return <p>Choose a page from the list to see its details.</p>;
    const row = (k: string, v: unknown) => (v === undefined || v === null || v === '' ? null : <tr key={k}><th>{k}</th><td>{String(v)}</td></tr>);
    const issues = (n.seoIssues as unknown[] | undefined) ?? [];
    return (
      <article>
        <div className="rp-chips"><span className="rp-chip">{String(n.health)}</span><span className="rp-chip">{String(n.kind)}</span>{attention.has(id) && <span className="rp-chip warn">needs attention</span>}</div>
        <h2>{String(n.title || n.path)}</h2>
        <p className="pv-small">{String(n.url)}</p>
        <table className="pv-table"><tbody>
          {row('Status', n.statusCode)}{row('Clicks from home', n.clickDepth)}{row('Words', n.wordCount)}{row('Response ms', n.responseTimeMs)}{row('Links in', n.inlinksTotal)}{row('Links out', n.outlinksTotal)}
          {row('Meta description', n.metaDescription)}{row('Canonical', n.canonical)}{row('Robots', n.metaRobots)}{row('Section', n.section)}{row('In sitemap', n.inSitemap)}
        </tbody></table>
        {issues.length > 0 && <><h3>Flagged on this page</h3><ul className="pv-bullets">{issues.map((x, i) => <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>)}</ul></>}
        <div className="pv-opts"><PinBtn p={{ kind: 'page', id }} /></div>
      </article>
    );
  };

  const detail = sel && (sel.kind === 'story' ? (storyById.get(sel.id) && <StoryView s={storyById.get(sel.id)!} />) : sel.kind === 'finding' ? (findings.find((f) => f.id === sel.id) && <FindingView f={findings.find((f) => f.id === sel.id)!} />) : <PageView id={sel.id} />);

  return (
    <div className={`rp-root rp-${theme} pv-root`} style={style}>
      <div className="rp-globe-layer"><GlobeStage manifest={manifest} focus={focus} theme={theme} autoRotate={!sel && tab === 'points'} interactive /></div>
      <MapHelp />
      <header className="rp-top">
        <span className="rp-brand-mini">{pack.client.name}<span className="rp-draft" title="This file holds everything from the scrape, including held-back findings. Do not send it to a client.">Agency only</span></span>
        <div className="rp-tools">
          <button aria-pressed={privateOn} onClick={() => setPrivateOn((x) => !x)} title="Show held-back findings and your private notes (P). Leave off while screen-sharing.">{privateOn ? 'Private view ON' : 'Client-safe view'}</button>
          <FullscreenButton />
          {onClose && <button onClick={onClose}>Close</button>}
        </div>
      </header>
      <aside ref={panelRef as React.RefObject<HTMLElement>} className="pv-card pv-xp" aria-label="Explore the scrape">
        <nav className="pv-tabs" role="tablist">
          {([['points', 'Top 5'], ['findings', `Findings (${findings.length})`], ['pages', 'Pages'], ['show', `Show list (${pins.length})`]] as Array<[Tab, string]>).map(([id, l]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); setSel(null); }}>{l}</button>
          ))}
        </nav>
        <div className="pv-card-body">
          {sel ? <><button className="pv-link" onClick={() => setSel(null)}>← Back</button>{detail}</> : (
            <>
              {tab === 'points' && <>
                <p className="pv-small">{pack.ranking.basis}</p>
                <ol className="pv-list">{topStories.map((s) => <li key={s.id}><button className="pv-link big" onClick={() => open({ kind: 'story', id: s.id })}>{s.title}</button><span className={`rp-chip sev-${s.severity.level}`}>{s.severity.level}</span></li>)}</ol>
                {visibleStories.filter((s) => !pack.ranking.topFindingIds.includes(s.id)).length > 0 && <><h3>Other topics</h3>
                  <ul className="pv-list">{visibleStories.filter((s) => !pack.ranking.topFindingIds.includes(s.id)).map((s) => <li key={s.id}><button className="pv-link big" onClick={() => open({ kind: 'story', id: s.id })}>{s.title}</button>{s.disposition !== 'confirmed' && <span className="rp-chip warn">held back</span>}</li>)}</ul></>}
              </>}
              {tab === 'findings' && byCategory.map((c) => <div key={c.id}><h3>{c.label}</h3>
                <ul className="pv-list">{c.list.map((f) => <li key={f.id}><button className="pv-link big" onClick={() => open({ kind: 'finding', id: f.id })}>{f.title}</button> <small>{countOf(f)} · {f.tone}</small></li>)}</ul></div>)}
              {tab === 'pages' && <>
                <label className="pv-field"><span>Find a page</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="title or address" /></label>
                <ul className="pv-list">{matches.map((n) => <li key={n.id}><button className="pv-link big" onClick={() => open({ kind: 'page', id: n.id })}>{n.title || n.path}</button> <small>{n.path}{attention.has(n.id) ? ' · needs attention' : ''}</small></li>)}</ul>
              </>}
              {tab === 'show' && (pins.length === 0 ? <p>Start by opening a topic, finding or page and choosing "Add to show list". The list stays on this computer.</p> :
                <ol className="pv-list">{pins.map((p, i) => <li key={`${p.kind}:${p.id}`}><button className="pv-link big" onClick={() => open(p)}>{label(p)}</button> <small>{p.kind}</small>
                  <button className="pv-btn" onClick={() => movePin(i, -1)} disabled={i === 0} aria-label="Move up">↑</button><button className="pv-btn" onClick={() => movePin(i, 1)} disabled={i === pins.length - 1} aria-label="Move down">↓</button><button className="pv-btn" onClick={() => togglePin(p)} aria-label="Remove">×</button></li>)}</ol>)}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

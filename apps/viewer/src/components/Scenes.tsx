import { useEffect, useMemo, useRef, useState } from 'react';
import type { SiteGraphManifest } from '../../../../vendor/web-obs/types/site';
import { AUDIT_CATEGORIES } from '../../../../vendor/web-obs/data/siteAudit';
import {
  HORIZONS, LABEL_TEXT, OWNER_LABEL, renderText, countOf, type Claim, type Ctx, type Issue, type Scene, type Walkthrough,
} from '../../../../packages/contract/src/core';
import { GlobeStage, focusFromStop } from './GlobeStage';
import { safeImageSrc } from '../../../../packages/contract/src/safe';

export interface SceneEnv {
  w: Walkthrough;
  m: SiteGraphManifest;
  ctx: Ctx;
  images: Record<string, string>;
  issues: Map<string, Issue>;
  /** Read mode and print show everything at once. */
  full: boolean;
  presenter: boolean;
  theme: 'dark' | 'light';
}

const t = (env: SceneEnv, s: string) => renderText(s, env.ctx);
const SEV: Record<string, string> = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };
const EFFORT: Record<string, string> = { S: 'Small effort', M: 'Medium effort', L: 'Large effort' };

export function ClaimList({ env, claims, tone }: { env: SceneEnv; claims: Claim[]; tone?: 'plain' }) {
  return (
    <ul className={`rp-claims${tone === 'plain' ? ' plain' : ''}`}>
      {claims.map((c, i) => (
        <li key={i} className="rp-claim">
          <span className={`rp-chip lab-${c.label}`} title={LABEL_TEXT[c.label]}>{LABEL_TEXT[c.label]}</span>
          <span className="rp-claim-text">{t(env, c.text)}
            {c.basis && <details className="rp-basis"><summary>Why we say this</summary><p>{t(env, c.basis)}</p></details>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function pathOf(url: string): string { try { const u = new URL(url); return (u.pathname + u.search) || '/'; } catch { return url; } }

export function IssueView({ env, issue, sub, compact }: { env: SceneEnv; issue: Issue; sub: number; compact?: boolean }) {
  const showWhy = env.full || sub >= 1;
  const showFix = env.full || sub >= 2;
  const f = issue.exampleFinding ? env.ctx.F.get(issue.exampleFinding) : undefined;
  const examples = (f?.targets as Array<{ url: string; detail?: string; sourceUrl?: string }> | undefined)?.slice(0, 3) ?? [];
  const shot = safeImageSrc(issue.evidenceShots?.map((s) => env.images[`snap:${s.nodeId}`]).find(Boolean));
  return (
    <article className={`rp-issue${compact ? ' compact' : ''}`}>
      <header className="rp-issue-head">
        <div className="rp-chips">
          <span className={`rp-chip sev-${issue.severity.level}`} title={t(env, issue.severity.basis)}>{SEV[issue.severity.level]}</span>
          <span className="rp-chip neutral" title={t(env, issue.effort.basis)}>{EFFORT[issue.effort.size]}</span>
          <span className="rp-chip neutral">{OWNER_LABEL[issue.owner]}</span>
          {issue.disposition !== 'confirmed' && <span className="rp-chip warn">Needs verification</span>}
        </div>
        <h2>{t(env, issue.title)}</h2>
      </header>
      <div className="rp-issue-body">
        <div className="rp-col-a">
          <section>
            <h3>What we saw</h3>
            <ClaimList env={env} claims={issue.whatWeSaw} />
            {issue.caveat && <p className="rp-caveat"><strong>Keep in mind:</strong> {t(env, issue.caveat)}</p>}
          </section>
          {!compact && examples.length > 0 && (
            <div className="rp-examples">
              <h4>Examples from the capture</h4>
              <ul>{examples.map((e, i) => <li key={i}><code>{pathOf(e.sourceUrl || e.url)}</code>{e.detail ? <span>{e.detail.length > 80 ? e.detail.slice(0, 78) + '…' : e.detail}</span> : null}</li>)}</ul>
            </div>
          )}
        </div>
        <div className="rp-col-b">
          {!compact && shot && <figure className="rp-shot"><img src={shot} alt="Captured screenshot of the page" /><figcaption>Captured screenshot</figcaption></figure>}
          {showWhy && issue.whyItMatters.length > 0 && (
            <section className="rp-reveal">
              <h3>Why it matters</h3>
              <ClaimList env={env} claims={issue.whyItMatters} />
            </section>
          )}
          {showFix && issue.fix.length > 0 && (
            <section className="rp-reveal">
              <h3>How it gets fixed</h3>
              <ol className="rp-steps">{issue.fix.map((x, i) => <li key={i}>{t(env, x)}</li>)}</ol>
              <p className="rp-verify"><strong>How we will know:</strong> {t(env, issue.verify)}</p>
            </section>
          )}
        </div>
      </div>
    </article>
  );
}

function CountUp({ value, run }: { value: string; run: boolean }) {
  const m = /^(\d[\d,]*)(.*)$/.exec(value);
  const target = m ? Number(m[1].replace(/,/g, '')) : NaN;
  const [shown, setShown] = useState(run && !Number.isNaN(target) ? 0 : target);
  useEffect(() => {
    if (Number.isNaN(target) || !run || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(target); return; }
    let raf = 0; const start = performance.now(), dur = 900;
    const tick = (now: number) => { const p = Math.min(1, (now - start) / dur); setShown(Math.round(target * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run]);
  if (!m) return <>{value}</>;
  return <>{shown.toLocaleString('en-US')}{m[2].trim() && <span className="rp-unit">{m[2]}</span>}</>;
}

export function Cover({ env, scene }: { env: SceneEnv; scene: Scene }) {
  const logo = safeImageSrc(env.images.logo);
  const when = new Date(env.m.capturedAt);
  return (
    <div className="rp-cover">
      {logo ? <img className="rp-cover-logo" src={logo} alt={`${env.w.brand.name} logo`} /> : <div className="rp-cover-mark" aria-hidden>{env.w.brand.name.slice(0, 2).toUpperCase()}</div>}
      <p className="rp-kicker">{env.w.brand.preparedFor ? `Prepared for ${env.w.brand.preparedFor}` : env.m.domain}</p>
      <h1>{t(env, scene.title ?? 'Website health walkthrough')}</h1>
      {scene.subtitle && <p className="rp-sub">{t(env, scene.subtitle)}</p>}
      <p className="rp-meta">{env.m.domain} · captured {Number.isNaN(when.getTime()) ? env.m.capturedAt : when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}{env.w.brand.presenter ? ` · ${env.w.brand.presenter}` : ''}</p>
    </div>
  );
}

export function Glance({ env, scene, active }: { env: SceneEnv; scene: Scene; active: boolean }) {
  return (
    <div className="rp-glance">
      <h1>{t(env, scene.title ?? '')}</h1>
      <div className="rp-tiles">
        {(scene.tiles ?? []).map((tile, i) => (
          <div key={i} className="rp-tile" style={{ animationDelay: `${i * 70}ms` }}>
            <div className="rp-tile-value"><CountUp value={t(env, tile.value)} run={active} /></div>
            <div className="rp-tile-label">{tile.label}</div>
            {tile.note && <div className="rp-tile-note">{tile.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MapCaption({ env, scene, sub }: { env: SceneEnv; scene: Scene; sub: number }) {
  const stops = scene.stops ?? [];
  const stop = stops[Math.min(sub, stops.length - 1)];
  if (!stop) return null;
  return (
    <div className="rp-mapcap">
      <p className="rp-kicker">{scene.title} · {Math.min(sub, stops.length - 1) + 1} of {stops.length}</p>
      <p className="rp-mapcap-text">{t(env, stop.caption.text)}</p>
      <span className={`rp-chip lab-${stop.caption.label}`}>{LABEL_TEXT[stop.caption.label]}</span>
    </div>
  );
}

/** Read mode: the map as an inline, explorable block with its stops as buttons. */
export function ReadMap({ env, scene }: { env: SceneEnv; scene: Scene }) {
  const stops = scene.stops ?? [];
  const [k, setK] = useState(0);
  const stop = stops[k];
  const focus = useMemo(() => focusFromStop(env.m, stop), [env.m, stop]);
  return (
    <div className="rp-readmap">
      <h2>{scene.title}</h2>
      <div className="rp-readmap-stage"><GlobeStage manifest={env.m} focus={focus} theme={env.theme} logoDataUri={env.images.logo} autoRotate={k === 0} /></div>
      <div className="rp-readmap-steps" role="tablist">
        {stops.map((s, i) => (
          <button key={i} role="tab" aria-selected={i === k} className={i === k ? 'on' : ''} onClick={() => setK(i)}>
            <span>{i + 1}</span>{t(env, s.caption.text)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Since({ env, scene }: { env: SceneEnv; scene: Scene }) {
  return (
    <div className="rp-simple">
      <p className="rp-kicker">Progress</p>
      <h1>{t(env, scene.title ?? '')}</h1>
      <ul className="rp-wins">{(scene.claims ?? []).map((c, i) => <li key={i}><span className="rp-tick" aria-hidden>✓</span>{t(env, c.text)}</li>)}</ul>
    </div>
  );
}

export function Inventory({ env, scene }: { env: SceneEnv; scene: Scene }) {
  const shown = new Set(env.w.scenes.filter((s) => s.type === 'issue' && !s.hidden && (s.audience ?? 'client') === 'client').map((s) => s.issueId));
  const rest = env.w.issues.filter((i) => i.disposition === 'confirmed' && !i.hidden && !shown.has(i.id));
  const covered = new Set(env.w.issues.flatMap((i) => i.findings));
  const cat = new Map<string, { findings: Array<{ title: string; n: number }> }>();
  for (const [id, f] of env.ctx.F) {
    if (covered.has(id)) continue;
    const key = String(f.category ?? 'other');
    if (!cat.has(key)) cat.set(key, { findings: [] });
    cat.get(key)!.findings.push({ title: String(f.title), n: countOf(env.ctx, id) });
  }
  const label = (id: string) => AUDIT_CATEGORIES.find((c) => c.id === id)?.label ?? id.replace(/^./, (x) => x.toUpperCase());
  return (
    <div className="rp-inventory">
      <p className="rp-kicker">The rest of the picture</p>
      <h1>{t(env, scene.title ?? '')}</h1>
      {rest.length > 0 && (
        <div className="rp-more">
          {rest.map((i) => <details key={i.id} className="rp-more-item">
            <summary><span className={`rp-chip sev-${i.severity.level}`}>{SEV[i.severity.level]}</span> {t(env, i.title)}</summary>
            <IssueView env={{ ...env, full: true }} issue={i} sub={2} compact />
          </details>)}
        </div>
      )}
      <div className="rp-cats">
        {[...cat.entries()].map(([id, c]) => (
          <details key={id} className="rp-cat">
            <summary><strong>{label(id)}</strong><span>{c.findings.length} {c.findings.length === 1 ? 'check' : 'checks'}</span></summary>
            <ul>{c.findings.map((f, i) => <li key={i}>{f.title}<em>{f.n}</em></li>)}</ul>
          </details>
        ))}
        {cat.size === 0 && rest.length === 0 && <p className="rp-muted">That covers everything we found.</p>}
      </div>
    </div>
  );
}

export function Roadmap({ env, scene }: { env: SceneEnv; scene: Scene }) {
  return (
    <div className="rp-roadmap">
      <p className="rp-kicker">Plan</p>
      <h1>{t(env, scene.title ?? '')}</h1>
      <div className="rp-cols">
        {HORIZONS.map((h) => {
          const items = (scene.items ?? []).filter((it) => it.horizon === h.id).map((it) => env.issues.get(it.issueId)).filter((x): x is Issue => Boolean(x));
          return (
            <section key={h.id} className="rp-col">
              <h3>{h.label}</h3>
              {items.length === 0 && <p className="rp-muted">Room to plan this together.</p>}
              {items.map((i) => (
                <div key={i.id} className="rp-road-item">
                  <strong>{t(env, i.title)}</strong>
                  <div className="rp-road-meta"><span className={`rp-chip sev-${i.severity.level}`}>{SEV[i.severity.level]}</span><span>{EFFORT[i.effort.size]} · {OWNER_LABEL[i.owner]}</span></div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function Notes({ env, scene, kicker }: { env: SceneEnv; scene: Scene; kicker: string }) {
  return (
    <div className="rp-simple">
      <p className="rp-kicker">{kicker}</p>
      <h1>{t(env, scene.title ?? '')}</h1>
      <ul className="rp-limits">{(scene.claims ?? []).map((c, i) => <li key={i}><span className="rp-dot" aria-hidden />{t(env, c.text)}</li>)}</ul>
      {scene.type === 'next-steps' && env.w.brand.presenter && <p className="rp-sign">{env.w.brand.presenter}</p>}
    </div>
  );
}

export const useStable = <T,>(v: T) => { const r = useRef(v); r.current = v; return r; };

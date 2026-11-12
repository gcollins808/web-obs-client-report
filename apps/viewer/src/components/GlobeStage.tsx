// The Web-Obs 3D globe, unmodified, driven by a walkthrough "stop": view mode, a node filter and an optional fly-to.
import { useEffect, useMemo, useState } from 'react';
import { SiteGlobeCanvas3D } from '../../../../vendor/web-obs/components/SiteGlobeCanvas3D';
import type { GlobeViewMode, NodeFilter, SiteGraphManifest } from '../../../../vendor/web-obs/types/site';
import type { Stop } from '../../../../packages/contract/src/core';
import { dataUriToBytes } from '../lib/files';

export interface GlobeFocus { view: GlobeViewMode; filter: NodeFilter; fly?: string | null; key: string }

export function focusFromStop(m: SiteGraphManifest, stop?: Stop): GlobeFocus {
  if (!stop) return { view: 'globe', filter: 'all', fly: null, key: 'default' };
  const f = stop.focus ?? {};
  const filter = (f.filter as NodeFilter | undefined) ?? (f.health === 'orphan' || f.health === 'unlisted' ? 'orphans' : f.health ? 'issues' : 'all');
  const target = f.nodeIds?.[0] ?? (f.health ? m.nodes.find((n) => n.health === f.health)?.id : undefined) ?? null;
  return { view: stop.view, filter, fly: target, key: JSON.stringify([stop.view, f]) };
}

interface Props {
  manifest: SiteGraphManifest;
  focus: GlobeFocus;
  theme: 'dark' | 'light';
  logoDataUri?: string;
  autoRotate?: boolean;
  interactive?: boolean;
  /** Pages to bring forward; every other page fades (the dimming). */
  highlightIds?: ReadonlySet<string> | null;
  /** When set, a click on a page is reported to the parent (which shows the page card) and the parent owns the selection. */
  onPickNode?: (id: string | null) => void;
  pickedId?: string | null;
}

export function GlobeStage({ manifest, focus, theme, logoDataUri, autoRotate = false, interactive = true, highlightIds = null, onPickNode, pickedId = null }: Props) {
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const selectedId = onPickNode ? pickedId : ownSelected;
  const setSelectedId = (id: string | null) => { if (onPickNode) onPickNode(id); else setOwnSelected(id); };
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [fly, setFly] = useState<{ nodeId: string; seq: number } | null>(null);

  // A new stop re-frames the camera and flies to its target.
  useEffect(() => {
    if (onPickNode) onPickNode(null); else setOwnSelected(null);
    setResetSignal((n) => n + 1);
    if (focus.fly) setFly((prev) => ({ nodeId: focus.fly as string, seq: (prev?.seq ?? 0) + 1 }));
  }, [focus.key, focus.fly]);

  // The globe draws the home badge from the capture's logo path; serve it from the embedded data.
  const readAssetBytes = useMemo(() => {
    const path = manifest.brandKit?.localLogoAsset;
    if (!logoDataUri || !path) return undefined;
    return async (p: string) => (p === path ? dataUriToBytes(logoDataUri) : null);
  }, [manifest, logoDataUri]);

  return (
    <div className={`wo-shell wo-theme-${theme} rp-globe${interactive ? '' : ' rp-globe-static'}`} aria-label="3D map of the website">
      <SiteGlobeCanvas3D
        manifest={manifest}
        viewMode={focus.view}
        theme={theme}
        selectedId={selectedId}
        hoveredId={hoveredId}
        filter={focus.filter}
        searchQuery=""
        highlightIds={highlightIds}
        showExternal={focus.filter === 'external'}
        showChromeLinks={false}
        showAllLinks={false}
        showPulses
        autoRotate={autoRotate}
        inspectorOpen={false}
        resetSignal={resetSignal}
        flyRequest={fly}
        axisSnapRequest={null}
        onSelectNode={setSelectedId}
        onHoverNode={setHoveredId}
        readAssetBytes={readAssetBytes}
      />
    </div>
  );
}

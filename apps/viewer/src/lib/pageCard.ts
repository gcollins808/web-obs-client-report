// What the page card shows when a visitor clicks a page on the map (v0.1.5). Pure: no DOM, never throws.
// A page "belongs" to a step when one of the step's statements, or one of a map step's views, names that page.
import type { ClientReport, GuidedStep } from '../../../../packages/contract/src/package';

export interface PageCardInfo {
  id: string;
  title: string;
  path: string;
  /** The findings that touch this page, in tour order first, then the rest. */
  findings: Array<{ id: string; title: string }>;
  /** The first tour step that references the page, and the map view inside it; null when no step does. */
  jump: { tourIndex: number; stopIdx: number } | null;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

export function pageCardInfo(
  report: ClientReport,
  nodes: ReadonlyArray<{ id: string; title?: string; path?: string }>,
  tour: ReadonlyArray<GuidedStep>,
  id: string,
): PageCardInfo | null {
  try {
    const node = nodes.find((n) => n.id === id);
    if (!node) return null;
    const fById = new Map(report.findings.map((f) => [f.id, f]));
    const findings: PageCardInfo['findings'] = [];
    const seen = new Set<string>();
    let jump: PageCardInfo['jump'] = null;
    const touch = (fid: string) => { const f = fById.get(fid); if (f && !seen.has(fid)) { seen.add(fid); findings.push({ id: fid, title: str(f.title, 160) }); } };
    const allSteps: GuidedStep[] = [...tour, ...report.modes.guided.steps.filter((s) => !tour.includes(s))];
    allSteps.forEach((s) => {
      const tourIndex = tour.indexOf(s);
      if (s.kind === 'finding') {
        if ((s.beats?.found ?? []).some((c) => c.nodeIds?.includes(id))) {
          touch(s.findingId);
          if (!jump && tourIndex >= 0) jump = { tourIndex, stopIdx: 0 };
        }
      } else if (s.kind === 'map') {
        const k = (s.stops ?? []).findIndex((st) => st.focus?.nodeIds?.includes(id));
        if (k >= 0 && !jump && tourIndex >= 0) jump = { tourIndex, stopIdx: k };
      }
    });
    return { id, title: str(node.title, 160) || str(node.path, 160) || 'This page', path: str(node.path, 300), findings: findings.slice(0, 12), jump };
  } catch { return null; }
}

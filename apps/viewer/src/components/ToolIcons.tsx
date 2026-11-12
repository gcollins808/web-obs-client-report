// Small shared controls for the viewers: a full-screen icon button and a "how to move the map" help button.
import { useEffect, useState } from 'react';

const toggleFullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); };

export function FullscreenButton() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const f = () => setOn(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  return (
    <button className="pv-icon" onClick={toggleFullscreen} title={on ? 'Exit full screen (F)' : 'Full screen (F)'} aria-label={on ? 'Exit full screen' : 'Full screen'}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {on ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  );
}

const CONTROLS: Array<[string, string]> = [
  ['Scroll', 'zoom in and out'],
  ['Click and drag', 'rotate the map'],
  ['Ctrl-click and drag', 'move the map across the screen'],
  ['Click a page', 'highlight it and the pages it links to'],
];

/** A small "?" in the corner of the map. It opens a short list of the 3D controls and closes again with a click or Esc. */
export function MapHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  return (
    <div className="pv-help">
      {open && (
        <div className="pv-help-card" role="dialog" aria-label="How to move the map">
          <b>Moving around the map</b>
          <dl>{CONTROLS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <small className="pv-stamp">{__BUILD_STAMP__}</small>
        </div>
      )}
      <button className="pv-icon" aria-expanded={open} aria-label="How to move the map" title="How to move the map" onClick={() => setOpen((x) => !x)}>?</button>
    </div>
  );
}

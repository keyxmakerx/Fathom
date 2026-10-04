// A small tool strip over the canvas: Select and Pan (where the view has a marquee), and what the wheel does.

import { useEffect } from 'react';
import type { WheelMode } from './canvasPrefs';

export type CanvasTool = 'pan' | 'select';

interface CanvasToolsProps {
  /** Present where the view has a selection box: shows Select and Pan. */
  tool?: CanvasTool;
  onTool?: (tool: CanvasTool) => void;
  wheel: WheelMode;
  onWheel: (mode: WheelMode) => void;
}

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return el != null && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

const ICON = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round', 'aria-hidden': true } as const;

export function CanvasTools({ tool, onTool, wheel, onWheel }: CanvasToolsProps) {
  useEffect(() => {
    if (!onTool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'v' || e.key === 'V') onTool('select');
      else if (e.key === 'h' || e.key === 'H') onTool('pan');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onTool]);

  return (
    <div className="canvas-tools" role="toolbar" aria-label="Canvas tools">
      {tool && onTool ? (
        <>
          <button type="button" className="canvas-tool" aria-pressed={tool === 'select'} aria-label="Select" aria-keyshortcuts="V" title="Select: drag to box-select (V)" onClick={() => onTool('select')}>
            <svg {...ICON}><path d="M3 2l9 5-4 1.2L6.5 12z" /></svg>
          </button>
          <button type="button" className="canvas-tool" aria-pressed={tool === 'pan'} aria-label="Pan" aria-keyshortcuts="H" title="Pan: drag to move the view (H)" onClick={() => onTool('pan')}>
            <svg {...ICON}><path d="M5 8V3.5a1 1 0 012 0V7M7 7V2.5a1 1 0 012 0V7M9 7V3.5a1 1 0 012 0V9M5 8L3.8 6.8a1 1 0 00-1.5 1.3L5.5 13a3 3 0 002.4 1.2H9a3 3 0 003-3V9" /></svg>
          </button>
          <span className="canvas-tools__rule" aria-hidden="true" />
        </>
      ) : null}
      <button
        type="button"
        className="canvas-tool"
        aria-pressed={wheel === 'zoom'}
        aria-label="Wheel zooms"

        title={wheel === 'zoom' ? 'Wheel zooms (Ctrl+wheel always zooms). Click to scroll instead.' : 'Wheel scrolls (Ctrl+wheel always zooms). Click to zoom instead.'}
        onClick={() => onWheel(wheel === 'zoom' ? 'scroll' : 'zoom')}
      >
        {wheel === 'zoom' ? (
          <svg {...ICON}><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5M5.5 7h3M7 5.5v3" /></svg>
        ) : (
          <svg {...ICON}><path d="M8 2.5v11M5.5 5L8 2.5 10.5 5M5.5 11L8 13.5 10.5 11" /></svg>
        )}
      </button>
    </div>
  );
}

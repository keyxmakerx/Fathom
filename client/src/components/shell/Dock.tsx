import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

import '../../styles/dock.css';
import { clampWidth, keyedWidth, PANEL_MIN, type PanelId } from './panelSizing';

/** How long a panel takes to slide shut before it is taken out of the page. Matches dock.css. */
export const DOCK_EXIT_MS = 160;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The width of the row the panels and the canvas share, followed as the window changes. */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) return undefined;
    const read = () => setWidth(el.clientWidth || window.innerWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  useEffect(() => {
    const read = () => setWidth(window.innerWidth);
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return width;
}

export interface ResizeHandleProps {
  /** Which edge of the panel the handle sits on: the inner edge, toward the canvas. */
  edge: 'left' | 'right';
  label: string;
  width: number;
  max: number;
  /** Called while dragging (`commit` false) and when the drag or key press is done (`commit` true). */
  onResize: (width: number, commit: boolean) => void;
  onReset: () => void;
  onDragging: (dragging: boolean) => void;
}

/** The drag handle on a panel's inner edge. Arrow keys move it, Home and End go to the limits,
 * and a double click puts the width back. */
export function ResizeHandle({ edge, label, width, max, onResize, onReset, onDragging }: ResizeHandleProps) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: latest.current };
    onDragging(true);
    e.preventDefault();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (s == null) return;
    const dx = e.clientX - s.x;
    const next = clampWidth(edge === 'left' ? s.w - dx : s.w + dx, max);
    latest.current = next;
    onResize(next, false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current == null) return;
    start.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onDragging(false);
    onResize(latest.current, true);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyedWidth(width, e.key, e.shiftKey, edge === 'left' ? 'ArrowLeft' : 'ArrowRight', max);
    if (next == null) return;
    e.preventDefault();
    onResize(next, true);
  };

  return (
    <div
      className={`dock-handle dock-handle--${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double click to reset."
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={onReset}
    />
  );
}

export interface DockSlotProps {
  side: 'left' | 'right';
  open: boolean;
  width: number;
  /** The name that goes with this panel's drag handle ("Equipment", "Trail"). */
  name: string;
  panel: PanelId;
  max: number;
  onResize: (panel: PanelId, width: number, commit: boolean) => void;
  onReset: (panel: PanelId) => void;
  onDragging: (dragging: boolean) => void;
  /** What the panel holds. Kept on screen while the panel slides shut. */
  children: ReactNode;
}

/** One side panel's slot: slides open and shut, holds a fixed-width panel so its contents do not
 * reflow as the slot grows, and carries the drag handle. Drawn only while open or sliding shut. */
export function DockSlot({ side, open, width, name, panel, max, onResize, onReset, onDragging, children }: DockSlotProps) {
  const [mounted, setMounted] = useState(open);
  // The content is held while closing: the parent may already have dropped it.
  const held = useRef<ReactNode>(children);
  if (open) held.current = children;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const done = setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : DOCK_EXIT_MS);
    return () => clearTimeout(done);
  }, [open]);

  if (!open && (!mounted || prefersReducedMotion())) return null;
  return (
    <div
      className={`dock-slot dock-slot--${side}`}
      data-state={open ? 'open' : 'closing'}
      style={{ width }}
      aria-hidden={open ? undefined : true}
    >
      <div className="dock-panel" style={{ width }}>
        <ResizeHandle
          edge={side === 'right' ? 'left' : 'right'}
          label={`Resize the ${name.toLowerCase()} panel`}
          width={width}
          max={max}
          onResize={(w, commit) => onResize(panel, w, commit)}
          onReset={() => onReset(panel)}
          onDragging={onDragging}
        />
        {open ? children : held.current}
      </div>
    </div>
  );
}

export interface DockTabProps {
  label: string;
  /** The accessible name; defaults to the label. */
  name?: string;
  open: boolean;
  /** Something about this tab is going on that is not visible while it is folded. */
  marked?: boolean;
  testId?: string;
  onClick: () => void;
}

/** One labelled button on a folded edge. */
export function DockTab({ label, name, open, marked, testId, onClick }: DockTabProps) {
  const text = name ?? (open ? `Close ${label.toLowerCase()}` : `Open ${label.toLowerCase()}`);
  return (
    <button
      type="button"
      className={`dock-tab${open ? ' dock-tab--on' : ''}${marked ? ' dock-tab--marked' : ''}`}
      aria-label={text}
      title={text}
      aria-expanded={open}
      data-testid={testId}
      onClick={onClick}
    >
      <span className="dock-tab__word" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

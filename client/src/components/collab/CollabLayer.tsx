import { useContext, useEffect, useRef, useState } from 'react';
import { ViewportPortal, useReactFlow, useStore, type ReactFlowInstance } from '@xyflow/react';

import { outlineSelectors } from '../../document/historyDiff';
import { glideOptions } from '../drawing/motion';
import '../../styles/collab.css';
import type { ChangedThing } from './changesSince';
import { CollabContext, type CollabApi } from './CollabContext';
import { glowThings } from './glow';
import { pointerOpacity, trackMoves, type Tracked } from './pointers';

type Changes = NonNullable<CollabApi['changes']>;

/**
 * Drawn inside the canvas: other people's pointers, and the bar that says what they changed while you
 * were away. Renders nothing outside a design.
 */
export function CollabLayer() {
  const collab = useContext(CollabContext);
  if (collab === null) return null;
  return (
    <>
      <PointerLayer collab={collab} />
      {collab.changes !== null && <ChangesBar collab={collab} changes={collab.changes} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pointers

/** How often a pointer's fade is looked at while any is showing. */
const FADE_TICK_MS = 500;

function PointerLayer({ collab }: { collab: CollabApi }) {
  const rf = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const domNode = useStore((s) => s.domNode);
  const [tracked, setTracked] = useState<ReadonlyMap<string, Tracked>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  // Ours: sent while it moves over the canvas, cleared when it leaves or the tab is hidden.
  useEffect(() => {
    if (domNode === null) return undefined;
    const move = (e: PointerEvent) => collab.setPointer(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    const leave = () => collab.setPointer(null);
    const hidden = () => {
      if (document.visibilityState === 'hidden') collab.setPointer(null);
    };
    domNode.addEventListener('pointermove', move);
    domNode.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      domNode.removeEventListener('pointermove', move);
      domNode.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', hidden);
      collab.setPointer(null);
    };
  }, [collab, rf, domNode]);

  // Theirs.
  useEffect(
    () =>
      collab.subscribePointers((list) => {
        const at = Date.now();
        setNow(at);
        setTracked((before) => trackMoves(before, list, at));
      }),
    [collab],
  );

  // A pointer that has stopped fades; look again while any is showing.
  const showing = tracked.size > 0;
  useEffect(() => {
    if (!showing) return undefined;
    const id = setInterval(() => setNow(Date.now()), FADE_TICK_MS);
    return () => clearInterval(id);
  }, [showing]);

  const visible = [...tracked.values()].filter((p) => pointerOpacity(p.movedAt, now) > 0);
  if (visible.length === 0) return null;
  return (
    <ViewportPortal>
      {visible.map((p) => (
        <div key={p.account} className="collab-pointer" style={{ transform: `translate(${p.x}px, ${p.y}px)`, opacity: pointerOpacity(p.movedAt, now) }} aria-hidden="true">
          {/* The arrow keeps its size at any zoom; only its place follows the canvas. */}
          <div className="collab-pointer__inner" style={{ transform: `scale(${1 / zoom})` }}>
            <svg className="collab-pointer__arrow" width="14" height="18" viewBox="0 0 14 18">
              <path d="M1 1 L1 15 L4.6 11.6 L7.4 17 L9.6 16 L6.9 10.7 L12 10.4 Z" />
            </svg>
            <span className="collab-pointer__tag">{p.name.trim() === '' ? p.initials : p.name}</span>
          </div>
        </div>
      ))}
    </ViewportPortal>
  );
}

// ---------------------------------------------------------------------------
// What changed

/** The least the camera zooms in to when it goes to a changed thing: its place is the point, not its detail. */
const STEP_MIN_ZOOM = 0.6;

/** The middle of a changed thing in canvas coordinates: its box if it is one, else wherever it is drawn. */
function centreOf(rf: ReactFlowInstance, id: string): { x: number; y: number } | null {
  for (const nodeId of [`chassis:${id}`, `free:${id}`, `rack:${id}`, `surface:${id}`, `shelf:${id}`, `label:${id}`, id]) {
    const node = rf.getInternalNode(nodeId);
    if (node !== undefined) {
      const { x, y } = node.internals.positionAbsolute;
      return { x: x + (node.measured.width ?? 0) / 2, y: y + (node.measured.height ?? 0) / 2 };
    }
  }
  // A cable, or a box drawn inside another: read where it is on screen.
  for (const selector of outlineSelectors([id])) {
    const el = document.querySelector(selector);
    if (el === null) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }
  return null;
}

function ChangesBar({ collab, changes }: { collab: CollabApi; changes: Changes }) {
  const rf = useReactFlow();
  const [step, setStep] = useState<number | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const { things } = changes;

  // Everything that changed glows once, when the person comes back. Not tied to `changes` itself: that is
  // rebuilt whenever someone arrives or leaves, which must not cut the glow short.
  const { glowed } = changes;
  const thingsRef = useRef(things);
  thingsRef.current = things;
  useEffect(() => {
    if (glowed.current || thingsRef.current.length === 0) return undefined;
    glowed.current = true;
    return glowThings(thingsRef.current.map((t) => t.id));
  }, [glowed]);

  const goTo = (index: number) => {
    const thing: ChangedThing = things[(index + things.length) % things.length]!;
    setStep((index + things.length) % things.length);
    const centre = centreOf(rf, thing.id);
    if (centre !== null) void rf.setCenter(centre.x, centre.y, { zoom: Math.max(rf.getZoom(), STEP_MIN_ZOOM), ...glideOptions() });
    if (thing.kind !== null) collab.select({ kind: thing.kind, id: thing.id });
    glowThings([thing.id]);
  };

  // Esc closes while stepping.
  useEffect(() => {
    if (step === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') changes.dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, changes]);

  useEffect(() => {
    if (step === 0) nextRef.current?.focus();
  }, [step]);

  return (
    <div className="collab-changes" role="status" aria-live="polite" data-testid="changes-bar">
      <span className="collab-changes__words">{changes.sentence}</span>
      {step === null && things.length > 0 && (
        <button type="button" className="collab-changes__button" onClick={() => goTo(0)}>
          Step through
        </button>
      )}
      {step !== null && (
        <>
          <button type="button" className="collab-changes__icon" aria-label="Previous change" onClick={() => goTo(step - 1)}>
            &lsaquo;
          </button>
          <span className="collab-changes__count">
            {step + 1} of {things.length}
          </span>
          <button type="button" ref={nextRef} className="collab-changes__icon" aria-label="Next change" onClick={() => goTo(step + 1)}>
            &rsaquo;
          </button>
        </>
      )}
      <button type="button" className="collab-changes__icon" aria-label="Close and mark as seen" title="Close (Esc)" onClick={changes.dismiss}>
        &times;
      </button>
    </div>
  );
}

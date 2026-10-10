// The port peek: point at a port (or tab to it) and a small frosted card says where it goes, which VLAN it
// carries and which cable is in it. One listener for the whole canvas, so the ports themselves stay as
// they are: it watches for any element marked `data-port-id` (rack, shelf and wall plates) or
// `data-jot-port` (an opened device). The card never takes a click and stays away while a cable or a
// device is being dragged. What it says is `portPeek.ts`.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../styles/canvas-aids.css';

import type { Document } from '../../document/model';
import type { ClosetView } from './contract';
import { portPeek, type PortPeekCard } from './portPeek';

const PORT_SELECTOR = '[data-port-id], [data-jot-port]';
const CANVAS_SELECTOR = '.shell__drawing';
/** Pointing at a port this long shows the card. */
export const PEEK_DELAY_MS = 300;
/** A tab to a port is deliberate, so the card comes sooner. */
const FOCUS_DELAY_MS = 120;
const GAP = 8;
const EDGE = 8;

interface Shown {
  card: PortPeekCard;
  /** Centre of the port, and its top and bottom edges, in window pixels. */
  x: number;
  top: number;
  bottom: number;
}

function portOf(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(PORT_SELECTOR) : null;
  return el != null && el.closest(CANVAS_SELECTOR) != null ? el : null;
}

const idOf = (el: HTMLElement): string | undefined => el.dataset.portId ?? el.dataset.jotPort;

/** A cable is being drawn or a device dragged: no card now. */
function busy(): boolean {
  return document.querySelector('.react-flow__connectionline, .react-flow__node.dragging, .jot__wire') != null;
}

function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

export function PortPeek({ doc, view }: { doc: Document | null; view: ClosetView }) {
  const latest = useRef({ doc, view });
  latest.current = { doc, view };
  const [shown, setShown] = useState<Shown | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    let savedTitle: string | null = null;

    const release = () => {
      if (current != null) {
        current.removeAttribute('data-peeking');
        if (savedTitle != null) current.setAttribute('title', savedTitle);
      }
      current = null;
      savedTitle = null;
    };
    const hide = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
      release();
      setShown(null);
    };
    const schedule = (el: HTMLElement, delay: number) => {
      if (el === current) return;
      hide();
      current = el;
      // The browser's own tooltip would say the same thing a second later; ours replaces it while pointed at.
      savedTitle = el.getAttribute('title');
      if (savedTitle != null) el.removeAttribute('title');
      el.setAttribute('data-peeking', '');
      timer = setTimeout(() => {
        timer = null;
        const id = idOf(el);
        if (id == null || !el.isConnected || busy()) return;
        const card = portPeek(latest.current.doc, latest.current.view, id);
        if (card == null) return;
        const r = el.getBoundingClientRect();
        setShown({ card, x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
      }, delay);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = portOf(e.target);
      if (el == null || e.buttons !== 0) return;
      schedule(el, PEEK_DELAY_MS);
    };
    const onOut = (e: PointerEvent) => {
      const el = portOf(e.target);
      if (el == null || el !== current) return;
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = portOf(e.target);
      if (el != null && focusVisible(el)) schedule(el, FOCUS_DELAY_MS);
    };
    const onFocusOut = (e: FocusEvent) => {
      const el = portOf(e.target);
      if (el != null && el === current) hide();
    };
    const onAnyAction = () => {
      if (current != null || timer != null) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAnyAction();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onAnyAction, true);
    document.addEventListener('wheel', onAnyAction, { capture: true, passive: true });
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onAnyAction, true);
      document.removeEventListener('wheel', onAnyAction, true);
      document.removeEventListener('keydown', onKey, true);
      if (timer != null) clearTimeout(timer);
      release();
    };
  }, []);

  // Below the port, centred on it; kept inside the window, and above the port when there is no room below.
  useLayoutEffect(() => {
    if (shown == null) {
      setPos(null);
      return;
    }
    const card = cardRef.current;
    const w = card?.offsetWidth ?? 0;
    const h = card?.offsetHeight ?? 0;
    const left = Math.max(EDGE, Math.min(shown.x - w / 2, window.innerWidth - w - EDGE));
    const below = shown.bottom + GAP;
    const top = below + h > window.innerHeight - EDGE ? Math.max(EDGE, shown.top - GAP - h) : below;
    setPos({ left, top });
  }, [shown]);

  if (shown == null) return null;
  return createPortal(
    <div
      ref={cardRef}
      className="port-peek"
      role="tooltip"
      data-testid="port-peek"
      data-print-omit=""
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos == null ? 'hidden' : 'visible' }}
    >
      <div className="port-peek__title">{shown.card.title}</div>
      <dl className="port-peek__rows">
        {shown.card.rows.map((row) => (
          <div key={row.key} className="port-peek__row">
            <dt>{row.key}</dt>
            <dd className={row.empty ? 'port-peek__value port-peek__value--empty' : 'port-peek__value'}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>,
    document.body,
  );
}

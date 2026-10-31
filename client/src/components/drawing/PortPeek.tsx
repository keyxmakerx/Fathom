// The port peek: point at a port (or tab to it) and a small frosted card says where it goes, which VLAN it
// carries and which cable is in it. One listener for the whole canvas, so the ports themselves stay as
// they are: it watches for any element marked `data-port-id` (rack, shelf and wall plates) or
// `data-jot-port` (an opened device). The card never takes a click and stays away while a cable or a
// device is being dragged. What it says is `portPeek.ts`.
//
// Sign-off r59: the same card for a device, a rack, a shelf and a cable (`thingPeek.ts`), in place of the
// callout a click on a device's name used to draw. A click always opens the panel; a pause says what it is.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../styles/canvas-aids.css';

import type { Document } from '../../document/model';
import type { ClosetView } from './contract';
import { portPeek } from './portPeek';
import { thingPeek, type PeekTarget } from './thingPeek';

const PORT_SELECTOR = '[data-port-id], [data-jot-port]';
const CANVAS_SELECTOR = '.shell__drawing';
/** Pointing at a port this long shows the card. */
export const PEEK_DELAY_MS = 300;
/** A tab to a port is deliberate, so the card comes sooner. */
const FOCUS_DELAY_MS = 120;
/** A rack or a shelf is large and pointed across on the way to something else, so it waits longer. */
const BIG_DELAY_MS = 600;
const GAP = 8;
const EDGE = 8;

interface PeekCard {
  title: string;
  rows: readonly { key: string; value: string; empty: boolean }[];
}

interface Shown {
  card: PeekCard;
  kind: 'port' | PeekTarget['kind'];
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

/** The things besides ports, most specific first: a device inside a shelf before the shelf, and so on. */
const THINGS: readonly { kind: PeekTarget['kind']; selector: string; id: (el: HTMLElement) => string | undefined }[] = [
  { kind: 'device', selector: '[data-device-chassis]', id: (el) => el.dataset.deviceChassis },
  { kind: 'device', selector: '.react-flow__node-chassis', id: (el) => after(el.dataset.id, 'chassis:') },
  { kind: 'device', selector: '.react-flow__node-freeBox', id: (el) => after(el.dataset.id, 'free:') },
  { kind: 'cable', selector: '[data-cable-id]', id: (el) => el.dataset.cableId },
  { kind: 'shelf', selector: '.react-flow__node-shelf', id: (el) => after(el.dataset.id, 'shelf:') },
  { kind: 'rack', selector: '.react-flow__node-rack', id: (el) => after(el.dataset.id, 'rack:') },
];

function after(value: string | undefined, prefix: string): string | undefined {
  return value != null && value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

export type Target = { el: HTMLElement; kind: 'port' } | { el: HTMLElement; kind: PeekTarget['kind']; id: string };

/** What the pointer is over, on the canvas: a port first, then the most specific thing. */
export function targetOf(target: EventTarget | null): Target | null {
  const port = portOf(target);
  if (port != null) return { el: port, kind: 'port' };
  return thingOf(target);
}

/** The most specific thing (not a port) at or around `target`, on the canvas. */
export function thingOf(target: EventTarget | null): Exclude<Target, { kind: 'port' }> | null {
  if (!(target instanceof Element) || target.closest(CANVAS_SELECTOR) == null) return null;
  for (const t of THINGS) {
    const el = target.closest<HTMLElement>(t.selector);
    const id = el != null ? t.id(el) : undefined;
    if (el != null && id != null) return { el, kind: t.kind, id };
  }
  return null;
}

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
    const schedule = (t: Target, delay: number, at?: { x: number; y: number }) => {
      const el = t.el;
      if (el === current) return;
      hide();
      current = el;
      // The browser's own tooltip would say the same thing a second later; ours replaces it while pointed at.
      savedTitle = el.getAttribute('title');
      if (savedTitle != null) el.removeAttribute('title');
      el.setAttribute('data-peeking', '');
      timer = setTimeout(() => {
        timer = null;
        if (!el.isConnected || busy()) return;
        if (t.kind === 'port') {
          const id = idOf(el);
          const card = id != null ? portPeek(latest.current.doc, latest.current.view, id) : null;
          if (card == null) return;
          const r = el.getBoundingClientRect();
          setShown({ card, kind: 'port', x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
          return;
        }
        const card = thingPeek(latest.current.view, { kind: t.kind, id: t.id });
        if (card == null) return;
        // A rack is tall and a cable long: the card goes by the pointer, not the middle of the thing.
        const r = el.getBoundingClientRect();
        const x = at?.x ?? r.left + r.width / 2;
        const y = at?.y ?? r.top + r.height / 2;
        setShown({ card, kind: t.kind, x, top: y - 12, bottom: y + 12 });
      }, delay);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = targetOf(e.target);
      if (t == null || e.buttons !== 0) return;
      // The quick card is already up for this thing (`QuickCard.tsx`): a peek would say the same again.
      if (t.el.hasAttribute('data-quick')) return;
      schedule(t, t.kind === 'rack' || t.kind === 'shelf' ? BIG_DELAY_MS : PEEK_DELAY_MS, { x: e.clientX, y: e.clientY });
    };
    const onOut = (e: PointerEvent) => {
      if (current == null) return;
      const el = current;
      if (!(e.target instanceof Node) || !el.contains(e.target)) return;
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      // Into a thing inside this one (a device in a shelf): `pointerover` there takes over.
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = portOf(e.target);
      if (el != null && focusVisible(el)) schedule({ el, kind: 'port' }, FOCUS_DELAY_MS);
    };
    const onFocusOut = (e: FocusEvent) => {
      const el = portOf(e.target);
      if (el != null && el === current) hide();
    };
    const onAnyAction = () => {
      if (current != null || timer != null) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A card in view is the top thing: Escape puts it away and nothing else (sign-off r60).
      if (document.querySelector('.port-peek') != null) {
        e.preventDefault();
        e.stopPropagation();
      }
      onAnyAction();
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
      data-fathom-layer=""
      className={shown.kind === 'port' ? 'port-peek' : 'port-peek port-peek--thing'}
      role="tooltip"
      data-testid={shown.kind === 'port' ? 'port-peek' : 'thing-peek'}
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

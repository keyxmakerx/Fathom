// The quick card (Key Maker, 31 October): click a device, rack, shelf or cable on the canvas and a small card
// comes out beside it, joined by a dotted line, with what it is, its name and its management address ready
// to copy. The right panel opens as before; the card is the short answer and the panel the long one.
//
// It brings back the callout r59 took out, without the rule that hid it: any click on the thing shows it,
// not only a click on a racked device's name. Like the hover peek it is one listener for the whole canvas,
// so the things themselves stay as they are; a click on a port counts as a click on its device. It follows the thing as the camera moves, and goes on Escape,
// a click on empty canvas, a double-click (which opens the device) or a drag. What it says is `quickCard.ts`.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../styles/canvas-aids.css';

import { copyText } from '../firmware/parts';
import { SHOW_DETAILS_EVENT } from '../shell/useRightTab';
import type { ClosetView } from './contract';
import { thingOf } from './PortPeek';
import { quickCard, type QuickCardFacts } from './quickCard';
import type { PeekTarget } from './thingPeek';

const CANVAS_SELECTOR = '.shell__drawing';
/** A press that moves further than this is a drag or a pan, not a click. */
const CLICK_SLOP_PX = 4;
/** The dotted line between the thing and the card. */
const LEADER_PX = 28;
const EDGE = 8;

interface Pinned {
  target: PeekTarget;
  el: HTMLElement;
  /** Where on the thing the click landed, as fractions of its box: a rack is tall and a cable long. */
  fx: number;
  fy: number;
}

interface Placed {
  /** The leader's two ends and the card's corner, in window pixels. */
  ax: number;
  ay: number;
  bx: number;
  left: number;
  top: number;
  hidden: boolean;
}

/** The element for a target, found again when the canvas has redrawn the one that was clicked. */
function refind(target: PeekTarget): HTMLElement | null {
  const id = CSS.escape(target.id);
  const selectors =
    target.kind === 'device'
      ? [`[data-device-chassis="${id}"]`, `.react-flow__node[data-id="chassis:${id}"]`, `.react-flow__node[data-id="free:${id}"]`]
      : target.kind === 'cable'
        ? [`[data-cable-id="${id}"]`]
        : [`.react-flow__node[data-id="${target.kind}:${id}"]`];
  for (const s of selectors) {
    const el = document.querySelector<HTMLElement>(`${CANVAS_SELECTOR} ${s}`);
    if (el != null) return el;
  }
  return null;
}

/** A device, shelf or rack hangs the card off its right edge (a rack at the height it was clicked, being
 * tall); a cable, which has no edge to speak of, from where it was clicked. */
function anchorOf(p: Pinned, r: DOMRect): { x: number; y: number; left: number; right: number } {
  if (p.target.kind === 'cable') {
    const x = r.left + p.fx * r.width;
    return { x, y: r.top + p.fy * r.height, left: x, right: x };
  }
  const y = p.target.kind === 'rack' ? r.top + p.fy * r.height : r.top + r.height / 2;
  return { x: r.right, y, left: r.left, right: r.right };
}

export function QuickCard({ view }: { view: ClosetView }) {
  const latest = useRef(view);
  latest.current = view;
  const [pinned, setPinned] = useState<Pinned | null>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const cardRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Mark the thing, so the hover peek leaves it alone while the card speaks for it.
  useEffect(() => {
    const el = pinned?.el;
    if (el == null) return;
    el.setAttribute('data-quick', '');
    return () => el.removeAttribute('data-quick');
  }, [pinned]);

  useEffect(() => {
    let down: { x: number; y: number } | null = null;
    const close = () => setPinned(null);
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      const at = down;
      down = null;
      if (!(e.target instanceof Element)) return;
      if (cardRef.current?.contains(e.target)) return;
      if (e.target.closest(CANVAS_SELECTOR) == null) return;
      if (at != null && Math.hypot(e.clientX - at.x, e.clientY - at.y) > CLICK_SLOP_PX) return;
      // Shift, Ctrl or Cmd picks several things: one card cannot speak for all of them.
      if (e.shiftKey || e.ctrlKey || e.metaKey) return close();
      // A port's click lands on its device: at the rack's zoom the ports cover most of the plate.
      const t = thingOf(e.target);
      if (t == null) return close();
      const r = t.el.getBoundingClientRect();
      const fx = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5;
      const fy = r.height > 0 ? (e.clientY - r.top) / r.height : 0.5;
      setCopied(null);
      setPinned({ target: { kind: t.kind, id: t.id }, el: t.el, fx, fy });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pinnedRef.current == null) return;
      // The card is the top thing: Escape puts it away and nothing else (sign-off r60).
      if (document.querySelector('.port-peek') != null) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick);
    document.addEventListener('dblclick', close);
    document.addEventListener('contextmenu', close, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick);
      document.removeEventListener('dblclick', close);
      document.removeEventListener('contextmenu', close, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const facts: QuickCardFacts | null = pinned != null ? quickCard(view, pinned.target) : null;

  // Follow the thing while the camera moves: one read of its box a frame, only while the card is up.
  useLayoutEffect(() => {
    if (pinned == null || facts == null) {
      setPlaced(null);
      return;
    }
    let frame = 0;
    let last = '';
    const tick = () => {
      frame = requestAnimationFrame(tick);
      let el = pinned.el;
      if (!el.isConnected) {
        const again = refind(pinned.target);
        if (again == null) {
          setPinned(null);
          return;
        }
        el = again;
        setPinned({ ...pinned, el });
        return;
      }
      const busy = document.querySelector('.react-flow__node.dragging, .react-flow__connectionline') != null;
      const canvas = el.closest(CANVAS_SELECTOR)?.getBoundingClientRect();
      const card = cardRef.current;
      if (canvas == null || card == null) return;
      const r = el.getBoundingClientRect();
      const a = anchorOf(pinned, r);
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      // Right of the thing, or left of it when the canvas has no room on the right.
      const right = a.right + LEADER_PX + w <= canvas.right - EDGE;
      const left = right ? a.right + LEADER_PX : Math.max(canvas.left + EDGE, a.left - LEADER_PX - w);
      const top = Math.max(canvas.top + EDGE, Math.min(a.y - h / 2, canvas.bottom - h - EDGE));
      const off = busy || a.y < canvas.top || a.y > canvas.bottom || a.x < canvas.left || a.x > canvas.right;
      const next: Placed = { ax: right ? a.right : a.left, ay: a.y, bx: right ? left : left + w, left, top, hidden: off };
      const key = `${next.ax}|${next.ay}|${next.bx}|${next.left}|${next.top}|${next.hidden}`;
      if (key !== last) {
        last = key;
        setPlaced(next);
      }
    };
    tick();
    return () => cancelAnimationFrame(frame);
    // `facts` is recomputed every render; only whether there is a card matters here.
  }, [pinned, facts != null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pinned == null || facts == null) return null;
  const showDetails = () => window.dispatchEvent(new CustomEvent(SHOW_DETAILS_EVENT));
  const copy = async () => {
    if (facts.address == null) return;
    setCopied((await copyText(facts.address)) ? 'Copied' : 'Select it and copy');
    window.setTimeout(() => setCopied(null), 2000);
  };
  const hidden = placed == null || placed.hidden;
  return createPortal(
    <>
      {!hidden && (
        <svg className="quick-card__leader" aria-hidden="true">
          <path d={`M ${placed.ax} ${placed.ay} L ${placed.bx} ${placed.ay}`} className="quick-card__line" />
          <circle cx={placed.ax} cy={placed.ay} r={2.5} className="quick-card__dot" />
        </svg>
      )}
      <div
        ref={cardRef}
        className="quick-card"
        role="dialog"
        aria-label={`${facts.title}, in short`}
        data-testid="quick-card"
        data-print-omit=""
        style={{ left: placed?.left ?? 0, top: placed?.top ?? 0, visibility: hidden ? 'hidden' : 'visible' }}
      >
        <div className="quick-card__head">
          <span className="quick-card__kind">{facts.kind}</span>
          <button type="button" className="quick-card__close" aria-label="Close" title="Close (Esc)" onClick={() => setPinned(null)}>
            ×
          </button>
        </div>
        <div className="quick-card__title">{facts.title}</div>
        {pinned.target.kind === 'device' && (
          <div className="quick-card__address">
            {facts.address != null ? (
              <>
                <span className="quick-card__ip" title="Management address">
                  {facts.address}
                </span>
                <button type="button" className="quick-card__copy" onClick={() => void copy()}>
                  {copied ?? 'Copy'}
                </button>
              </>
            ) : (
              <span className="quick-card__none">No management address</span>
            )}
          </div>
        )}
        <dl className="port-peek__rows">
          {facts.rows.map((row) => (
            <div key={row.key} className="port-peek__row">
              <dt>{row.key}</dt>
              <dd className={row.empty ? 'port-peek__value port-peek__value--empty' : 'port-peek__value'}>{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="quick-card__foot">
          <button type="button" className="quick-card__details" onClick={showDetails}>
            Details
          </button>
          {facts.opens && <span className="quick-card__hint">Double-click to open inside</span>}
        </div>
      </div>
    </>,
    document.body,
  );
}

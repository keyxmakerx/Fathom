// The Checks panel (ADR-0061 §5, mockup r4-checks-a): docked right, draggable, folds to a count in the bar.
// Severity is a word and a glyph, never a colour.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { CheckFinding } from '../../engine/engine';
import { anchorName, clampOffset, findingKey, panelNotes, SEVERITY, sourceView, summaryText, totalCount, UNCHECKED_SOURCE } from './checksModel';
import type { ChecksController } from './useChecksController';
import { RefusalCard } from './RefusalCard';
import './checks.css';

/** The bar's "Checks 2": toggles the panel. */
export function ChecksBarChip({ controller }: { controller: ChecksController }) {
  const n = controller.result != null ? totalCount(controller.result) : 0;
  return (
    <button
      type="button"
      className="shell-chip shell-chip--ink checks-chip"
      aria-pressed={controller.open}
      aria-label={n > 0 ? `Checks, ${n}` : 'Checks'}
      title={controller.open ? 'Fold the Checks panel' : 'Open the Checks panel'}
      onClick={() => controller.setOpen(!controller.open)}
      data-testid="checks-chip"
    >
      Checks{n > 0 ? ` ${n}` : ''}
    </button>
  );
}

/** Room left between the panel and the canvas's right edge, beside the panel itself, px. */
const DOCK_GAP = 16;

export function WhyCard({ finding, onClose }: { finding: CheckFinding; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const src = sourceView(finding);
  // Opened by a click: bring it into view and put focus on it.
  useEffect(() => {
    const el = ref.current;
    if (el == null) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <section ref={ref} tabIndex={-1} className="checks-why" aria-label="Why" data-testid="checks-why">
      <h3 className="checks-why__title">{finding.title}</h3>
      <p>{finding.why}</p>
      <p>
        <strong>Fix:</strong> {finding.fix}
      </p>
      <div className="checks-why__source" data-testid="checks-source">
        <span className="checks-why__label">{src.label}</span>
        {src.unchecked && <p className="checks-why__note">{UNCHECKED_SOURCE}</p>}
        {src.title !== '' && (
          <p className="checks-why__src-title">
            {src.linked ? (
              <a href={finding.source.url} target="_blank" rel="noopener noreferrer">
                {src.title}
              </a>
            ) : (
              src.title
            )}
          </p>
        )}
        {src.note !== '' && <p className="checks-why__note">{src.note}</p>}
      </div>
      <button type="button" className="checks-link" onClick={onClose}>
        Close
      </button>
    </section>
  );
}

function Row({ finding, controller, canShow }: { finding: CheckFinding; controller: ChecksController; canShow: boolean }) {
  const sev = SEVERITY[finding.severity];
  const name = anchorName(finding);
  const key = findingKey(finding);
  const shown = controller.showKey === key;
  return (
    <li className={`checks-row checks-row--${finding.severity}`} data-testid="checks-row" data-rule={finding.rule}>
      <div className="checks-row__head">
        {name !== '' && <span className="checks-row__name">{name}</span>}
        <span className="checks-row__sev">
          <span aria-hidden="true">{sev.glyph}</span> {sev.word}
        </span>
      </div>
      <p className="checks-row__title">{finding.title}</p>
      <p className="checks-row__links">
        <button type="button" className="checks-link" onClick={(e) => controller.openWhy(finding, e.currentTarget)}>
          Why?
        </button>
        {canShow && (
          <>
            {' · '}
            <button type="button" className="checks-link" aria-pressed={shown} onClick={() => controller.toggleShow(finding)}>
              Show
            </button>
          </>
        )}
      </p>
    </li>
  );
}

/** `canShow` is false while the open-device view covers the canvas: Show would change nothing anyone can see. */
export function ChecksPanel({ controller, canShow = true }: { controller: ChecksController; canShow?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const { result, unavailable, prefs, setOffset, api } = controller;
  // The saved offset as it applies to this canvas now: the saved one is kept, this is what is drawn.
  const [applied, setApplied] = useState({ x: prefs.x, y: prefs.y });
  const appliedRef = useRef(applied);
  appliedRef.current = applied;

  // The panel's rect with no offset (offsetLeft and friends ignore the transform), against its parent.
  const measure = () => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent || el.offsetParent !== parent) return null;
    return {
      parent: { left: 0, top: 0, width: parent.clientWidth, height: parent.clientHeight },
      docked: { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight },
    };
  };
  const clamp = (want: { x: number; y: number }) => {
    const m = measure();
    return m == null ? want : clampOffset(m.parent, m.docked, want);
  };

  // On open, on a new saved offset, and whenever the canvas or the panel changes size (the window, the rail or
  // the editor opening, more findings): clamp again, and tell Show how much of the right edge the panel covers.
  const settle = () => {
    const m = measure();
    if (m == null) return;
    const next = clampOffset(m.parent, m.docked, { x: prefs.x, y: prefs.y });
    setApplied((p) => (p.x === next.x && p.y === next.y ? p : next));
    const inset = next.x === 0 ? m.parent.width - m.docked.left + DOCK_GAP : 0;
    if (api.store.get().panelInset !== inset) api.store.set({ panelInset: inset });
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useLayoutEffect(() => {
    settleRef.current();
  }, [prefs.x, prefs.y]);
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    const again = () => settleRef.current();
    window.addEventListener('resize', again);
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again);
    if (el) watch?.observe(el);
    if (parent) watch?.observe(parent);
    return () => {
      window.removeEventListener('resize', again);
      watch?.disconnect();
      if (api.store.get().panelInset !== 0) api.store.set({ panelInset: 0 });
    };
  }, [api]);

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const at = appliedRef.current;
    drag.current = { px: e.clientX, py: e.clientY, ox: at.x, oy: at.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const place = (d: { px: number; py: number; ox: number; oy: number }, e: ReactPointerEvent<HTMLElement>) => {
    const next = clamp({ x: d.ox + e.clientX - d.px, y: d.oy + e.clientY - d.py });
    if (ref.current) ref.current.style.transform = `translate(${next.x}px, ${next.y}px)`;
    return next;
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current) place(drag.current, e);
  };
  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const next = place(d, e);
    setApplied(next);
    if (next.x !== d.ox || next.y !== d.oy) setOffset(next.x, next.y);
  };

  const notes = result != null ? panelNotes(result) : [];
  const summary = result != null ? summaryText(result) : '';
  return (
    <aside
      ref={ref}
      className="checks-panel"
      style={{ transform: `translate(${applied.x}px, ${applied.y}px)` }}
      aria-label="Checks"
      data-testid="checks-panel"
    >
      <header className="checks-panel__head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <h2 className="checks-panel__title">Checks</h2>
        <button type="button" className="checks-link" aria-label="Fold the Checks panel" onClick={() => controller.setOpen(false)}>
          Fold
        </button>
      </header>
      <div className="checks-panel__body">
        {unavailable && <p className="checks-panel__note">Checks are not running</p>}
        {!unavailable && result == null && <p className="checks-panel__note">Checking…</p>}
        {summary !== '' && <p className="checks-panel__summary">{summary}</p>}
        {notes.map((n) => (
          <p className="checks-panel__note" key={n} data-testid="checks-note">
            {n}
          </p>
        ))}
        {controller.why != null && <WhyCard key={controller.whyToken} finding={controller.why} onClose={controller.closeWhy} />}
        {result != null && result.findings.length > 0 && (
          <ul className="checks-list">
            {result.findings.map((f) => (
              <Row key={findingKey(f)} finding={f} controller={controller} canShow={canShow} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** The panel when open, and the card a refused gesture raises. */
export function ChecksSurface({ controller, canShow = true }: { controller: ChecksController; canShow?: boolean }) {
  const probe = useRef<HTMLSpanElement>(null);
  const { setCanvasWidth, api } = controller;

  // The canvas area is this component's parent: how wide it is decides whether the panel starts folded.
  useLayoutEffect(() => {
    const parent = probe.current?.parentElement;
    if (!parent) return undefined;
    const read = () => setCanvasWidth(parent.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(read);
    watch.observe(parent);
    return () => watch.disconnect();
  }, [setCanvasWidth]);

  useEffect(() => {
    if (!canShow) api.clearShow();
  }, [canShow, api]);

  return (
    <>
      <span ref={probe} className="checks-probe" aria-hidden="true" />
      {controller.open && <ChecksPanel controller={controller} canShow={canShow} />}
      {controller.refusal != null && (
        <RefusalCard
          finding={controller.refusal.finding}
          x={controller.refusal.x}
          y={controller.refusal.y}
          onWhy={() => {
            controller.openWhy(controller.refusal!.finding, null);
            controller.dismissRefusal();
          }}
          onDismiss={controller.dismissRefusal}
        />
      )}
    </>
  );
}

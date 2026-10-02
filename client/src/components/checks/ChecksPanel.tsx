// The Checks panel (ADR-0061 §5, mockup r4-checks-a): docked right, draggable, folds to a count in the bar.
// Severity is a word and a glyph, never a colour.
import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { CheckFinding } from '../../engine/engine';
import { anchorName, clampOffset, findingKey, hasSourceLink, panelNotes, SEVERITY, summaryText, totalCount } from './checksModel';
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

export function WhyCard({ finding, onClose }: { finding: CheckFinding; onClose: () => void }) {
  const { source } = finding;
  return (
    <section className="checks-why" aria-label="Why" data-testid="checks-why">
      <h3 className="checks-why__title">{finding.title}</h3>
      <p>{finding.why}</p>
      <p>
        <strong>Fix:</strong> {finding.fix}
      </p>
      <div className="checks-why__source" data-testid="checks-source">
        <span className="checks-why__label">{source.title !== '' ? 'Source' : 'Basis'}</span>
        {source.title !== '' && (
          <p className="checks-why__src-title">
            {hasSourceLink(finding) ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title}
              </a>
            ) : (
              source.title
            )}
          </p>
        )}
        {source.note !== '' && <p className="checks-why__note">{source.note}</p>}
      </div>
      <button type="button" className="checks-link" onClick={onClose}>
        Close
      </button>
    </section>
  );
}

function Row({ finding, controller }: { finding: CheckFinding; controller: ChecksController }) {
  const sev = SEVERITY[finding.severity];
  const name = anchorName(finding);
  const key = findingKey(finding);
  const shown = controller.showKey === key;
  return (
    <li className={`checks-row checks-row--${finding.severity}`} data-testid="checks-row" data-rule={finding.rule}>
      <span className="checks-row__sev">
        <span aria-hidden="true">{sev.glyph}</span> {sev.word}
        {name !== '' && <span className="checks-row__name"> · {name}</span>}
      </span>
      <p className="checks-row__title">{finding.title}</p>
      <p className="checks-row__links">
        <button type="button" className="checks-link" onClick={() => controller.openWhy(finding)}>
          Why?
        </button>
        {' · '}
        <button type="button" className="checks-link" aria-pressed={shown} onClick={() => controller.toggleShow(finding)}>
          Show
        </button>
      </p>
    </li>
  );
}

export function ChecksPanel({ controller }: { controller: ChecksController }) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const { result, unavailable, prefs, setOffset } = controller;

  // Offsets are clamped against the parent, on drag and when the window changes size.
  const clamp = (want: { x: number; y: number }) => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return want;
    const r = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    const docked = { left: r.left - prefs.x, top: r.top - prefs.y, width: r.width, height: r.height };
    return clampOffset(p, docked, want);
  };
  useEffect(() => {
    const onResize = () => {
      const next = clamp({ x: prefs.x, y: prefs.y });
      if (next.x !== prefs.x || next.y !== prefs.y) setOffset(next.x, next.y);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { px: e.clientX, py: e.clientY, ox: prefs.x, oy: prefs.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const next = clamp({ x: d.ox + e.clientX - d.px, y: d.oy + e.clientY - d.py });
    el.style.transform = `translate(${next.x}px, ${next.y}px)`;
  };
  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const next = clamp({ x: d.ox + e.clientX - d.px, y: d.oy + e.clientY - d.py });
    if (next.x !== d.ox || next.y !== d.oy) setOffset(next.x, next.y);
  };

  const notes = result != null ? panelNotes(result) : [];
  const summary = result != null ? summaryText(result) : '';
  return (
    <aside
      ref={ref}
      className="checks-panel"
      style={{ transform: `translate(${prefs.x}px, ${prefs.y}px)` }}
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
        {controller.why != null && <WhyCard finding={controller.why} onClose={controller.closeWhy} />}
        {result != null && result.findings.length > 0 && (
          <ul className="checks-list">
            {result.findings.map((f) => (
              <Row key={findingKey(f)} finding={f} controller={controller} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** The panel when open, and the card a refused gesture raises. */
export function ChecksSurface({ controller }: { controller: ChecksController }) {
  return (
    <>
      {controller.open && <ChecksPanel controller={controller} />}
      {controller.refusal != null && (
        <RefusalCard
          finding={controller.refusal.finding}
          x={controller.refusal.x}
          y={controller.refusal.y}
          onWhy={() => {
            controller.openWhy(controller.refusal!.finding);
            controller.dismissRefusal();
          }}
          onDismiss={controller.dismissRefusal}
        />
      )}
    </>
  );
}

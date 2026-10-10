// The path panel (mockups/r4-path-a.png): from -> to, the flow, then the hops numbered, a firewall hop listing
// every policy it reads in order with this flow's match state. Ink only; a row that could affect the flow takes
// a heavier rule and the words "could affect". Never a verdict.
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { TraceHop, TracePolicy } from '../../engine/engine';
import { endLine, hiddenCount, readingAs, untiedStop, visiblePolicies } from './traceModel';
import { hopPhase } from './tracePlayback';
import { useTraceRevealed } from './traceStore';
import { prefersReducedMotion } from '../drawing/motion';
import type { TraceController } from './useTraceController';
import './trace.css';

const FLOW_HINT = 'Write it as TCP 445 or UDP 53.';

function WhyCard({ lines, onClose }: { lines: string[]; onClose: () => void }): JSX.Element {
  return (
    <div className="trace-why" role="note" data-testid="trace-why">
      {lines.filter((l) => l !== '').map((l) => (
        <p key={l}>{l}</p>
      ))}
      <button type="button" className="trace-link" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function PolicyRow({ p }: { p: TracePolicy }): JSX.Element {
  const [why, setWhy] = useState(false);
  const affect = p.couldAffect;
  return (
    <li className={`trace-policy${affect ? ' trace-policy--affect' : ''}`} data-testid="trace-policy" data-state={p.state}>
      <span className="trace-policy__line">
        <span className="trace-policy__ord">#{Number(p.ordinal) + 1}</span> {p.name} <span className="trace-muted">· {p.action}</span>
        <span className="trace-policy__state"> · {affect ? `could affect: ${p.state}` : p.state}</span>
      </span>
      <button type="button" className="trace-link" aria-expanded={why} aria-label={`Why: ${p.name}`} onClick={() => setWhy((w) => !w)}>
        Why?
      </button>
      {why && <WhyCard lines={[p.reason]} onClose={() => setWhy(false)} />}
    </li>
  );
}

function Hop({ hop, only, phase }: { hop: TraceHop; only: boolean; phase: 'done' | 'now' | 'later' | null }): JSX.Element {
  const [why, setWhy] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  // The row being played scrolls into view if the list is longer than the panel.
  useEffect(() => {
    if (phase === 'now') row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [phase]);
  const placed = visiblePolicies(hop.policies, only);
  const unplaced = visiblePolicies(hop.unplaced, only);
  const hidden = hiddenCount(hop, only);
  return (
    <li ref={row} className={`trace-hop trace-hop--${hop.kind}${phase != null ? ` trace-hop--${phase}` : ''}`} data-testid="trace-hop" data-kind={hop.kind}>
      <div className="trace-hop__head">
        {hop.kind !== 'stop' && <span className="trace-hop__n">{hop.n}</span>}
        <span className="trace-hop__title">{hop.title}</span>
        {hop.scope !== '' && <span className="trace-muted"> · {hop.scope}{placed.length > 0 ? ' reads, in order:' : ''}</span>}
      </div>
      {hop.detail.map((d) => (
        <p key={d} className="trace-hop__detail">
          {d}
        </p>
      ))}
      {placed.length > 0 && (
        <ol className="trace-policies" aria-label="Policies, in the order the device reads them">
          {placed.map((p) => (
            <PolicyRow key={p.id} p={p} />
          ))}
        </ol>
      )}
      {unplaced.length > 0 && (
        <>
          <p className="trace-hop__detail trace-muted">Not placed: {hop.unplacedWhy}.</p>
          <ol className="trace-policies">
            {unplaced.map((p) => (
              <PolicyRow key={p.id} p={p} />
            ))}
          </ol>
        </>
      )}
      {hidden > 0 && <p className="trace-hop__detail trace-muted">{hidden === 1 ? '1 row' : `${hidden} rows`} that don't match hidden.</p>}
      <p className="trace-hop__links">
        {hop.source !== '' && <span className="trace-muted">{hop.source}</span>}
        {hop.source !== '' && ' · '}
        <button type="button" className="trace-link" aria-expanded={why} aria-label={`Why: ${hop.title}`} onClick={() => setWhy((w) => !w)}>
          Why?
        </button>
      </p>
      {why && <WhyCard lines={[hop.why, hop.source !== '' ? `Source: ${hop.source}.` : '']} onClose={() => setWhy(false)} />}
    </li>
  );
}

export function TracePanel({ controller, onTie }: { controller: TraceController; onTie?: (deviceId: string) => void }): JSX.Element | null {
  const [only, setOnly] = useState(false);
  const { from, result, query, target } = controller;
  const revealed = useTraceRevealed();
  if (from == null) return null;
  const untied = result != null && onTie != null ? untiedStop(result) : null;
  const reading = readingAs(query, target?.label ?? null);
  return (
    <aside
      className="trace-panel"
      aria-label="Path trace"
      data-testid="trace-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          controller.close();
        }
      }}
    >
      <div className="trace-panel__head">
        <h2 className="trace-panel__title">
          {from.label} → {target?.label ?? (result != null ? result.to : '…')}
        </h2>
        <button type="button" className="trace-link" onClick={controller.close} aria-label="Close the trace">
          Close
        </button>
      </div>

      <label className="trace-field">
        <span className="trace-muted">To</span>
        <input
          type="text"
          className="trace-input"
          value={query}
          placeholder="A device or an address"
          onChange={(e) => controller.setQuery(e.target.value)}
          data-testid="trace-to"
          autoFocus
        />
      </label>
      {reading !== '' && (
        <p className="trace-muted trace-reading" data-testid="trace-reading">
          {reading}
        </p>
      )}
      {controller.suggestions.length > 0 && (
        <ul className="trace-suggest" aria-label="Devices">
          {controller.suggestions.map((s) => (
            <li key={s.deviceId}>
              <button type="button" className="trace-link" onClick={() => controller.pick(s)}>
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="trace-field">
        <span className="trace-muted">Flow (optional)</span>
        <input
          type="text"
          className="trace-input"
          value={controller.flowText}
          placeholder="TCP 445"
          onChange={(e) => controller.setFlowText(e.target.value)}
          data-testid="trace-flow"
          aria-invalid={controller.flowBad}
          aria-describedby={controller.flowBad ? 'trace-flow-hint' : undefined}
        />
      </label>
      {controller.flowBad && (
        <p id="trace-flow-hint" className="trace-muted">
          {FLOW_HINT}
        </p>
      )}

      {controller.error !== '' && <p role="alert">The trace could not run. {controller.error}</p>}
      {result == null && controller.error === '' && controller.pending && <p className="trace-muted">Tracing…</p>}

      {result != null && (
        <>
          <label className="trace-only">
            <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} data-testid="trace-only" /> Only what could affect this
          </label>
          {result.hops.length > 1 && !prefersReducedMotion() && (
            <button type="button" className="trace-link trace-replay" onClick={controller.replay} data-testid="trace-replay">
              Play again
            </button>
          )}
          <ol className="trace-hops" data-testid="trace-hops">
            {result.hops.map((h, i) => (
              <Hop key={h.n} hop={h} only={only} phase={hopPhase(i, revealed)} />
            ))}
          </ol>
          {result.stopped === '' && <p className="trace-end">{endLine(result)}</p>}
          {untied != null && (
            <p className="trace-end">
              Not tied to a port ·{' '}
              <button type="button" className="trace-link" onClick={() => onTie?.(untied)} data-testid="trace-tie">
                Tie ports
              </button>
            </p>
          )}
        </>
      )}
    </aside>
  );
}

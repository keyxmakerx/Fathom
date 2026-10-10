// The tie list as a card over the canvas: after a paste onto a drawn device, and from a trace or troubleshooting
// stop that reads "not tied to a port".
import { useEffect, useMemo, useRef, type JSX } from 'react';

import type { Document } from '../../document/model';
import { TieRefusal, addPortsFromConfig, tiePlan, tiePorts, type TiePair } from '../../document/portTies';
import { TieList } from './TieList';

export interface TieCardProps {
  doc: Document;
  deviceId: string;
  actor?: string;
  onApply: (next: Document) => void;
  onClose: () => void;
}

/** A write's refusal as a sentence; anything else is not ours to swallow. */
export function tieAttempt(write: () => Document, apply: (next: Document) => void): string | void {
  try {
    apply(write());
  } catch (e) {
    if (e instanceof TieRefusal) return e.message;
    throw e;
  }
}

export function TieCard({ doc, deviceId, actor, onApply, onClose }: TieCardProps): JSX.Element {
  const plan = useMemo(() => tiePlan(doc, deviceId), [doc, deviceId]);
  const ref = useRef<HTMLDivElement>(null);
  // Focus moves into the card and back to where it was; Escape closes the card alone, not the canvas under it.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => before?.focus?.();
  }, [deviceId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const opts = actor !== undefined ? { actor } : undefined;
  const done = (next: Document) => {
    onApply(next);
    onClose();
  };

  return (
    <div className="paste-card" role="dialog" aria-label="Tie interfaces to ports" data-testid="tie-card" ref={ref}>
      {plan === null || plan.rows.length === 0 ? (
        <>
          <p className="paste-card__note">{plan === null ? 'This device is no longer in the design.' : 'Every interface on this device is tied to a port.'}</p>
          <div className="paste-card__actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </>
      ) : (
        <TieList
          key={deviceId}
          plan={plan}
          onTie={(pairs: TiePair[]) => tieAttempt(() => tiePorts(doc, deviceId, pairs, opts), done)}
          onAddPorts={() => tieAttempt(() => addPortsFromConfig(doc, deviceId, opts), done)}
          onSkip={onClose}
        />
      )}
    </div>
  );
}

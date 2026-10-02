// The card a refused gesture raises at the pointer (ADR-0061 §5). It states the fact and the fix; nothing is drawn.
import { useEffect } from 'react';

import type { CheckFinding } from '../../engine/engine';
import './checks.css';

export const REFUSAL_HEADING = "That isn't how this works";
const WIDTH = 320;

export function RefusalCard({
  finding,
  x,
  y,
  onWhy,
  onDismiss,
}: {
  finding: CheckFinding;
  x: number;
  y: number;
  onWhy: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    // Capture, and stop: the Esc that closes the card must not also leave the open device.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onDismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDismiss]);
  const left = Math.max(8, Math.min(x + 12, (typeof window === 'undefined' ? 1024 : window.innerWidth) - WIDTH - 8));
  const top = Math.max(8, Math.min(y + 12, (typeof window === 'undefined' ? 768 : window.innerHeight) - 200));
  return (
    <div className="checks-refusal" role="group" aria-label="Refused" style={{ left, top, width: WIDTH }} data-testid="checks-refusal">
      <h3 className="checks-refusal__heading">{REFUSAL_HEADING}</h3>
      <p className="checks-refusal__sentence">{finding.title}</p>
      <p className="checks-refusal__fix">
        <strong>Fix:</strong> {finding.fix}
      </p>
      <p className="checks-refusal__actions">
        <button type="button" className="checks-btn" onClick={onWhy}>
          Why?
        </button>
        <button type="button" className="checks-btn" onClick={onDismiss}>
          Dismiss
        </button>
      </p>
    </div>
  );
}

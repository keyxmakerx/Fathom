// The card a refused gesture raises at the pointer (ADR-0061 §5). It states the fact and the fix; nothing is drawn.
// Non-modal: a live region, so assistive tech announces it; Esc (Checks' own handler) or a press elsewhere closes it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { CheckFinding } from '../../engine/engine';
import { placeCard } from './checksModel';
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
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const width = Math.min(WIDTH, (typeof window === 'undefined' ? 1024 : window.innerWidth) - 16);

  // Placed from the card's real size, before it is first painted.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) return;
    setAt(placeCard({ x, y }, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [x, y, finding]);

  // A press anywhere outside the card puts it away.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current != null && e.target instanceof Node && ref.current.contains(e.target)) return;
      onDismiss();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      className="checks-refusal"
      role="alert"
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, width, opacity: at == null ? 0 : 1 }}
      data-testid="checks-refusal"
    >
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

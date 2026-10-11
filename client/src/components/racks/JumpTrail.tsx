// Back and Forward over the canvas, like a browser's: "← BACK TO R1" says where Back goes, and a small
// arrow goes forward again. It stays out of the way: nothing shows until there is somewhere to go.

import '../../styles/canvas-aids.css';

import { shortcutText } from '../shell/shortcuts';
import { canGoBack, canGoForward, type Trail } from './jumpBack';

export interface JumpTrailProps {
  trail: Trail;
  backLabel: string | null;
  onBack: () => void;
  onForward: () => void;
}

export function JumpTrail({ trail, backLabel, onBack, onForward }: JumpTrailProps) {
  const canBack = canGoBack(trail) && backLabel != null;
  const canForward = canGoForward(trail);
  if (!canBack && !canForward) return null;
  const forwardLabel = canForward ? trail.steps[trail.index + 1]!.label : null;
  return (
    <nav className="jump-trail" aria-label="Back and forward" data-print-omit="">
      <div className="jump-trail__bar">
        {canBack && (
          <button type="button" className="jump-trail__nav" onClick={onBack} title={`Go back (${shortcutText('go-back')})`} data-testid="jump-back">
            <span aria-hidden="true">←</span> Back to {backLabel}
          </button>
        )}
        {forwardLabel != null && (
          <button
            type="button"
            className="jump-trail__nav jump-trail__nav--icon"
            onClick={onForward}
            aria-label={`Forward to ${forwardLabel}`}
            title={`Forward to ${forwardLabel} (${shortcutText('go-forward')})`}
            data-testid="jump-forward"
          >
            <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    </nav>
  );
}

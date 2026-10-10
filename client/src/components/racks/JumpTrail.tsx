// The trail of where you have been, over the top of the canvas: "← BACK TO R1", the steps as small caps
// chips with the current one outlined, and "FORWARD →". Click a chip to go straight there. It stays out of
// the way: nothing shows until there is somewhere to go back to.

import '../../styles/canvas-aids.css';

import { shortcutText } from '../shell/shortcuts';
import { canGoForward, chipWindow, type Trail } from './jumpBack';

export interface JumpTrailProps {
  trail: Trail;
  backLabel: string | null;
  onBack: () => void;
  onForward: () => void;
  onGoTo: (index: number) => void;
}

export function JumpTrail({ trail, backLabel, onBack, onForward, onGoTo }: JumpTrailProps) {
  if (trail.steps.length < 2) return null;
  const { chips, before, after } = chipWindow(trail);
  const canForward = canGoForward(trail);
  return (
    <nav className="jump-trail" aria-label="Where you have been" data-print-omit="">
      <div className="jump-trail__bar">
        <button type="button" className="jump-trail__nav" disabled={backLabel == null} onClick={onBack} title={`Go back (${shortcutText('go-back')})`} data-testid="jump-back">
          <span aria-hidden="true">←</span> Back{backLabel != null ? ` to ${backLabel}` : ''}
        </button>
        <ol className="jump-trail__chips">
          {before > 0 && (
            <li className="jump-trail__more" aria-hidden="true">
              …
            </li>
          )}
          {chips.map((c) => (
            <li key={c.index} className="jump-trail__item">
              <button
                type="button"
                className={c.current ? 'jump-chip jump-chip--current' : 'jump-chip'}
                aria-current={c.current ? 'step' : undefined}
                onClick={() => !c.current && onGoTo(c.index)}
              >
                {c.label}
              </button>
            </li>
          ))}
          {after > 0 && (
            <li className="jump-trail__more" aria-hidden="true">
              …
            </li>
          )}
        </ol>
        <button type="button" className="jump-trail__nav" disabled={!canForward} onClick={onForward} title={`Go forward (${shortcutText('go-forward')})`} data-testid="jump-forward">
          Forward <span aria-hidden="true">→</span>
        </button>
      </div>
    </nav>
  );
}

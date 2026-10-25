import { useState } from 'react';

import { Popover, usePopoverClose } from '../shell/Popover';

/** The bar's "Sample" chip (r30-small): says this design is the sample, a copy of the person's own, and offers to
 * put it back as it came. Reset is one new save, so History still holds everything done before it. */
export function SampleChip({ onReset }: { onReset?: () => Promise<void> }) {
  return (
    <Popover
      align="right"
      renderTrigger={({ open, triggerProps, triggerRef }) => (
        <button
          type="button"
          className="shell-chip"
          data-testid="sample-chip"
          aria-pressed={open}
          ref={(el) => {
            triggerRef.current = el;
          }}
          {...triggerProps}
        >
          Sample
        </button>
      )}
    >
      <SampleBody onReset={onReset} />
    </Popover>
  );
}

function SampleBody({ onReset }: { onReset?: () => Promise<void> }) {
  const close = usePopoverClose();
  const [state, setState] = useState<'idle' | 'confirm' | 'busy' | { error: string }>('idle');
  return (
    <div className="sample-chip">
      <p>This is the sample home lab, a copy of your own. Change anything; nothing else is touched.</p>
      {onReset == null ? null : state === 'confirm' || state === 'busy' ? (
        <div className="sample-chip__confirm" role="alertdialog" aria-label="Reset the sample">
          <p>Put the sample back as it came? What you changed stays in History.</p>
          <span className="btn-group">
            <button
              type="button"
              disabled={state === 'busy'}
              onClick={() => {
                setState('busy');
                onReset().then(
                  () => {
                    setState('idle');
                    close();
                  },
                  (error: unknown) => setState({ error: error instanceof Error ? error.message : String(error) }),
                );
              }}
            >
              {state === 'busy' ? 'Resetting…' : 'Reset'}
            </button>
            <button type="button" disabled={state === 'busy'} onClick={() => setState('idle')}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <button type="button" className="btn-quiet" data-testid="sample-reset" onClick={() => setState('confirm')}>
          Reset sample
        </button>
      )}
      {typeof state === 'object' ? (
        <p className="sample-chip__error" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

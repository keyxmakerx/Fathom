// The band under the bar while a maintenance plan is open (mockups r6-maint-*): the stage in a word and a colour
// (indigo planning, teal doing, ink recorded), the plan's title and window, a picker, and the list-view toggle.
import { useId, useState } from 'react';

import { STAGE_WORD, bandSentence } from './plansModel';
import type { PlansController } from './usePlansController';
// The stage tokens (--m-plan, --m-do and their washes) live with the canvas marks.
import '../drawing/plans-canvas.css';
import './plans.css';

/** The bar's "Plans": shows or hides the band. */
export function PlansBarChip({ controller }: { controller: PlansController }) {
  return (
    <button
      type="button"
      className="shell-chip shell-chip--ink plans-chip"
      aria-pressed={controller.bandOpen}
      title={controller.bandOpen ? 'Close the plans band' : 'Open a maintenance plan'}
      onClick={() => controller.setBandOpen(!controller.bandOpen)}
      data-testid="plans-chip"
    >
      Plans
    </button>
  );
}

function NewPlanForm({ controller, onDone }: { controller: PlansController; onDone: () => void }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="plans-new"
      data-testid="plans-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() === '' || busy) return;
        setBusy(true);
        void controller.create({ title, windowStart: start, windowEnd: end }).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <label htmlFor={`${id}-t`}>What is changing</label>
      <input id={`${id}-t`} className="plans-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Move NAS to Building B" autoFocus required />
      <label htmlFor={`${id}-s`}>From</label>
      <input id={`${id}-s`} className="plans-input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      <label htmlFor={`${id}-e`}>To</label>
      <input id={`${id}-e`} className="plans-input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
      <button type="submit" className="plans-btn plans-btn--ink" disabled={title.trim() === '' || busy}>
        Make plan
      </button>
      <button type="button" className="plans-btn" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

export function PlanBand({ controller }: { controller: PlansController }) {
  const { plan, plans } = controller;
  const [creating, setCreating] = useState(false);
  const pickId = useId();
  const stage = plan?.stage ?? 'none';
  return (
    <section className="plans-band" data-stage={stage} aria-label="Maintenance plan" data-testid="plans-band">
      <div className="plans-band__row">
        <span className="plans-band__pill">{plan ? STAGE_WORD[plan.stage] : 'PLANS'}</span>
        <span className="plans-band__text" aria-live="polite">
          {plan ? (
            <>
              <strong className="plans-band__title">{plan.title}</strong>
              {bandSentence(plan) !== '' && <span className="plans-band__sentence"> · {bandSentence(plan)}</span>}
            </>
          ) : (
            'No plan open. Plans mark changes before they are made.'
          )}
        </span>
        <span className="plans-band__tools">
          <label className="plans-band__pick" htmlFor={pickId}>
            <span className="plans-band__pick-label">Plan</span>
            <select
              id={pickId}
              className="plans-select"
              value={plan?.id ?? ''}
              onChange={(e) => controller.openPlan(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">{plans.length === 0 ? 'No plans yet' : 'Choose a plan'}</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({STAGE_WORD[p.stage].toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          {controller.canEdit && (
            <button type="button" className="plans-btn" aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
              New plan
            </button>
          )}
          {plan && (
            <>
              <button type="button" className="plans-btn" aria-pressed={controller.listMode} onClick={() => controller.setListMode(!controller.listMode)} data-testid="plans-list-toggle">
                List view
              </button>
              {!controller.listMode && !controller.panelOpen && (
                <button type="button" className="plans-btn" onClick={() => controller.setPanelOpen(true)}>
                  Open panel
                </button>
              )}
              <button type="button" className="plans-btn" onClick={() => controller.openPlan(null)}>
                Close plan
              </button>
            </>
          )}
        </span>
      </div>
      {creating && <NewPlanForm controller={controller} onDone={() => setCreating(false)} />}
      {controller.notice != null && controller.plan == null && (
        <p className="plans-notice" role="alert">
          {controller.notice}
        </p>
      )}
    </section>
  );
}

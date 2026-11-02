// The band under the bar while a maintenance plan is open (mockups r6-maint-*): the stage in a word and a colour
// (indigo planning, teal doing, ink recorded), the plan's title and window, a picker, and the list-view toggle.
import { useEffect, useId, useRef, useState } from 'react';

import { TypedSentence, usePasteMark } from './PlanParts';
import { LIST_TOGGLE_ID, STAGE_WORD, bandSentence } from './plansModel';
import type { Plan } from '../../document/plans';
import type { PlansController } from './usePlansController';
// The stage tokens (--m-plan, --m-do and their washes) live with the canvas marks.
import '../drawing/plans-canvas.css';
import './plans.css';

/** The bar's "Plans": shows or hides the band. */
export function PlansBarChip({ controller }: { controller: PlansController }) {
  return (
    <button
      type="button"
      className="shell-chip shell-chip--ink plans-bar-chip"
      aria-pressed={controller.bandOpen}
      title={controller.bandOpen ? 'Close the plans band' : 'Open a maintenance plan'}
      onClick={() => controller.setBandOpen(!controller.bandOpen)}
      data-testid="plans-chip"
    >
      Plans
    </button>
  );
}

/** Makes a plan; given `editing`, changes that plan's title and window instead (it is still being planned). */
function NewPlanForm({ controller, onDone, editing }: { controller: PlansController; onDone: () => void; editing?: Plan }) {
  const id = useId();
  const [title, setTitle] = useState(editing?.title ?? '');
  const [start, setStart] = useState(editing?.windowStart ?? '');
  const [end, setEnd] = useState(editing?.windowEnd ?? '');
  const [busy, setBusy] = useState(false);
  const paste = usePasteMark();
  return (
    <form
      className="plans-new"
      data-testid={editing ? 'plans-edit' : 'plans-new'}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() === '' || busy) return;
        setBusy(true);
        const head = { title, windowStart: start, windowEnd: end };
        void (editing ? controller.editHead(head, paste.pasted) : controller.create(head, paste.pasted)).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <label htmlFor={`${id}-t`}>What is changing</label>
      <input id={`${id}-t`} className="plans-input" value={title} onChange={(e) => setTitle(e.target.value)} onPaste={paste.onPaste} placeholder="Move NAS to Building B" autoFocus required />
      <TypedSentence />
      <label htmlFor={`${id}-s`}>From</label>
      <input id={`${id}-s`} className="plans-input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      <label htmlFor={`${id}-e`}>To</label>
      <input id={`${id}-e`} className="plans-input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
      <button type="submit" className="plans-btn btn-main" disabled={title.trim() === '' || busy}>
        {editing ? 'Save' : 'Make plan'}
      </button>
      <button type="button" className="plans-btn" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

/**
 * `onOpenAiIdeas`: there is no AI mode to switch to. A person makes a plan with New plan; an AI app drafts one
 * as an AI idea, which a person accepts. With no plan open the band says so, and this opens the ideas.
 */
export function PlanBand({ controller, onOpenAiIdeas }: { controller: PlansController; onOpenAiIdeas?: () => void }) {
  const { plan, plans } = controller;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const pickId = useId();
  const newBtn = useRef<HTMLButtonElement>(null);
  const openBtn = useRef<HTMLButtonElement>(null);
  // A control that had focus has just gone (Fold, Cancel, Make plan): focus goes to the nearest one left.
  const wasPanelOpen = useRef(controller.panelOpen);
  useEffect(() => {
    if (wasPanelOpen.current && !controller.panelOpen && !controller.listMode && document.activeElement === document.body) openBtn.current?.focus();
    wasPanelOpen.current = controller.panelOpen;
  }, [controller.panelOpen, controller.listMode]);
  const wasCreating = useRef(false);
  useEffect(() => {
    if (wasCreating.current && !creating && document.activeElement === document.body) {
      const panel = document.querySelector<HTMLElement>('[data-testid=plans-panel] .plans-panel__body');
      (panel ?? newBtn.current)?.focus({ preventScroll: true });
    }
    wasCreating.current = creating;
  }, [creating]);
  const stage = plan?.stage ?? 'none';
  const sentence = plan ? bandSentence(plan, controller.doc, controller.canon) : '';
  return (
    <section className="plans-band" data-stage={stage} aria-label="Maintenance plan" data-testid="plans-band">
      <div className="plans-band__row">
        <span className="plans-band__pill">{plan ? STAGE_WORD[plan.stage] : 'PLANS'}</span>
        <span className="plans-band__text" aria-live="polite">
          {plan ? (
            <>
              <strong className="plans-band__title">{plan.title}</strong>
              {sentence !== '' && <span className="plans-band__sentence"> · {sentence}</span>}
            </>
          ) : (
            <>
              No plan open. Make one yourself with New plan, or right-click a device and choose Plan a change. A plan an AI app drafts
              arrives as an AI idea for you to accept.
              {onOpenAiIdeas && (
                <>
                  {' '}
                  <button type="button" className="plans-link" onClick={onOpenAiIdeas} data-testid="plans-ai-ideas">
                    AI ideas
                  </button>
                </>
              )}
            </>
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
            <button
              ref={newBtn}
              type="button"
              className="plans-btn"
              aria-expanded={creating}
              onClick={() => {
                setEditing(false);
                setCreating((c) => !c);
              }}
            >
              New plan
            </button>
          )}
          {/* With no plan open there is no Exit in the bar, so the band says how to put it away. */}
          {!plan && (
            <button type="button" className="plans-btn" onClick={() => controller.setBandOpen(false)} data-testid="plans-band-close">
              Close
            </button>
          )}
          {plan && plan.stage === 'planned' && controller.canEdit && (
            <button
              type="button"
              className="plans-btn"
              aria-expanded={editing}
              onClick={() => {
                setCreating(false);
                setEditing((v) => !v);
              }}
              data-testid="plans-edit-head"
            >
              Edit title and time
            </button>
          )}
          {plan && (
            <>
              <button type="button" className="plans-btn" aria-pressed={controller.listMode} onClick={() => controller.setListMode(!controller.listMode)} data-testid="plans-list-toggle" id={LIST_TOGGLE_ID}>
                List view
              </button>
              {!controller.listMode && !controller.panelOpen && (
                <button ref={openBtn} type="button" className="plans-btn" onClick={() => controller.setPanelOpen(true)}>
                  Open panel
                </button>
              )}
              <button
                type="button"
                className="plans-btn"
                onClick={() => {
                  // The picker stays; the plan's own buttons go.
                  document.getElementById(pickId)?.focus();
                  controller.openPlan(null);
                }}
              >
                Close plan
              </button>
            </>
          )}
        </span>
      </div>
      {creating && <NewPlanForm controller={controller} onDone={() => setCreating(false)} />}
      {editing && plan && plan.stage === 'planned' && !creating && (
        <NewPlanForm key={plan.id} controller={controller} editing={plan} onDone={() => setEditing(false)} />
      )}
      {controller.notice != null && controller.plan == null && (
        <p className="plans-notice" role="alert">
          {controller.notice}
        </p>
      )}
    </section>
  );
}

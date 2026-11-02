// Where a plan goes next (sign-off r94-plan-next, schema 0.37). Every plan says the way it runs (Plan, the maintenance,
// the checks after, Record), and while it is still being planned it offers its two endings side by side: start the
// maintenance, or call it off because it is not needed, was done another way, or troubleshooting comes first.
import { useId, useState } from 'react';

import { CALL_OFF_REASONS, CALL_OFF_WORD, calledOffWhy, type CallOffReason, type Plan } from '../../document/plans';
import { TypedSentence, usePasteMark } from './PlanParts';
import { firstLine, planRoute } from './plansModel';
import type { PlansController } from './usePlansController';

const AT_WORD = { done: 'done', now: 'now', next: 'to come', skipped: 'not done' } as const;

/** The way the plan runs, with where it is now marked. */
export function PlanRoute({ plan }: { plan: Plan }) {
  const stops = planRoute(plan);
  return (
    <ol className="plans-route" aria-label="Where this plan goes" data-testid="plans-route">
      {stops.map((s) => (
        <li key={s.key} className="plans-route__stop" data-at={s.at} data-key={s.key} aria-current={s.at === 'now' ? 'step' : undefined}>
          <span className="plans-route__word">{s.word}</span>
          <span className="plans-route__detail">{s.detail}</span>
          <span className="plans-sr"> ({AT_WORD[s.at]})</span>
        </li>
      ))}
    </ol>
  );
}

const REASON_HINT: Record<CallOffReason, string> = {
  not_needed: 'The change turned out not to be wanted.',
  done_another_way: 'It was fixed some other way, or by another plan.',
  troubleshoot: "Something is wrong first. Opens It's down on this plan's device.",
};

/** While planning: start the maintenance, or call the plan off. Replaces the lone Start work. */
export function WhatNext({ controller, plan, onStart, held = false }: { controller: PlansController; plan: Plan; onStart: () => void; held?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<CallOffReason>('not_needed');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const paste = usePasteMark();
  const id = useId();
  if (!controller.canEdit) return null;
  const opensTrouble = reason === 'troubleshoot' && controller.canTroubleshoot && controller.troubleshootDevice != null;
  return (
    <section className="plans-next" aria-labelledby={`${id}-h`} data-testid="plans-next">
      <h3 className="plans-label" id={`${id}-h`}>
        What happens next
      </h3>
      {!asking ? (
        <>
          <p className="plans-step__actions">
            <button type="button" className="plans-btn btn-main" disabled={plan.steps.length === 0 || held} onClick={onStart} data-testid="plans-start">
              Start the maintenance
            </button>
            <button type="button" className="plans-btn" onClick={() => setAsking(true)} data-testid="plans-call-off">
              Call it off…
            </button>
          </p>
          <p className="plans-note">
            {plan.steps.length === 0
              ? 'Add a step before the maintenance can start.'
              : held
                ? 'It can start once this version of the plan is approved.'
                : plan.windowStart === ''
                ? 'No window is set, so it can start whenever you are ready.'
                : 'Starting turns the plan into the maintenance: the steps become a checklist, one at a time.'}
          </p>
        </>
      ) : (
        <form
          className="plans-form plans-calloff"
          aria-label="Call the plan off"
          data-testid="plans-call-off-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            void controller.callOff(reason, note, paste.pasted).then((ok) => {
              setBusy(false);
              if (ok) {
                setAsking(false);
                setNote('');
                paste.reset();
              }
            });
          }}
        >
          <fieldset className="plans-calloff__reasons">
            <legend className="plans-label">Why it stops here</legend>
            {CALL_OFF_REASONS.map((r) => (
              <label key={r} className="plans-calloff__reason">
                <input type="radio" name={`${id}-why`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                <span>
                  <b>{CALL_OFF_WORD[r]}</b>
                  <span className="plans-note"> {REASON_HINT[r]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label htmlFor={`${id}-note`}>Anything to keep with it (optional)</label>
          <textarea
            id={`${id}-note`}
            className="plans-input plans-input--area"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onPaste={paste.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setAsking(false);
              }
            }}
          />
          <TypedSentence />
          <p className="plans-note">Nothing in the design changes. The plan stays in the list as called off, and can be planned again.</p>
          {reason === 'troubleshoot' && !opensTrouble && (
            <p className="plans-note">This plan names no device, so It&apos;s down will not open. Right-click the device and choose It&apos;s down.</p>
          )}
          <p className="plans-step__actions">
            <button type="submit" className="plans-btn btn-main" disabled={busy}>
              {opensTrouble ? "Call it off and open It's down" : 'Call it off'}
            </button>
            <button type="button" className="plans-btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </p>
        </form>
      )}
    </section>
  );
}

/** A plan called off before any work: why, what it would have done, and the way back to planning. */
export function CalledOffMode({ controller, plan }: { controller: PlansController; plan: Plan }) {
  const why = calledOffWhy(plan);
  return (
    <>
      <h3 className="plans-label">Why it stopped</h3>
      <p data-testid="plans-called-off-why">
        <strong>{why?.reason || 'Called off'}</strong>
      </p>
      {why != null && why.note !== '' && <p className="plans-record">{why.note}</p>}
      <p className="plans-note">Called off before any work, so nothing in the design was changed.</p>
      {controller.canEdit && (
        <p>
          <button type="button" className="plans-btn" onClick={() => void controller.planAgain()} data-testid="plans-plan-again">
            Plan it again
          </button>
        </p>
      )}
      {plan.steps.length > 0 && (
        <>
          <h3 className="plans-label">What it would have done</h3>
          <ol className="plans-checklist plans-checklist--read">
            {plan.steps.map((s) => (
              <li key={s.id} className="plans-step plans-step--recorded" data-state="called_off">
                <p className="plans-step__head">
                  {s.label} · {firstLine(s.change)}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

// Where a plan goes next (sign-off r94-plan-next, schema 0.37). Every plan says the way it runs (Plan, the maintenance,
// the checks after, Record), and while it is still being planned it offers its two endings side by side: start the
// maintenance, or call it off because it is not needed, was done another way, or troubleshooting comes first.
import { useId, useState } from 'react';

import { CALL_OFF_REASONS, CALL_OFF_WORD, calledOffWhy, type CallOffReason, type Plan } from '../../document/plans';
import { clashNote, windowWords, type WorkClash } from './clashes';
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

const CLASH_STAGE: Record<string, string> = { planned: 'planned', doing: 'under way', open: 'open issue' };

/** One clash as a line: what it is, where, when and whose, with a shared port in bold (sign-off r105 "what" A), and
 * Let them know, which leaves the other work a note offering a time (r105, from the owner's note). */
function ClashLine({ clash, onOpen, onOffer }: { clash: WorkClash; onOpen: ((c: WorkClash) => void) | null; onOffer: ((c: WorkClash) => void) | null }) {
  const what = clash.kind === 'issue' ? `It's down: ${clash.title}` : clash.kind === 'order' ? `Order ${clash.title}` : clash.title;
  const when = clash.kind === 'plan' ? windowWords(clash.window) : '';
  return (
    <li className="plans-clash" data-kind={clash.kind} data-testid="plans-clash">
      {onOpen ? (
        <button type="button" className="plans-link" onClick={() => onOpen(clash)}>
          {what}
        </button>
      ) : (
        <span>{what}</span>
      )}
      <span className="plans-note">
        {' · '}
        {clash.devices.map((d) => d.name).join(', ')} · {clash.kind === 'order' ? 'held while the order is open, on the Work tab' : (CLASH_STAGE[clash.stage] ?? clash.stage)}
        {when !== '' && ` · ${when}`}
        {clash.author !== '' && ` · by ${clash.author}`}
      </span>
      {clash.ports.length > 0 && (
        <>
          {' · '}
          <strong>same port {clash.ports.map((p) => p.name).join(', ')}</strong>
        </>
      )}
      {onOffer && (
        <button
          type="button"
          className="btn-small plans-clash__offer"
          onClick={() => onOffer(clash)}
          title={clash.theirsAfterMine ? `Suggests ${windowWords(clash.theirsAfterMine)}, after this plan` : 'Leaves them a note naming the clash'}
          data-testid="plans-clash-offer"
        >
          Let them know
        </button>
      )}
    </li>
  );
}

/** Other open work on the devices this plan touches (sign-off r105). Shown while planning and during the work. The
 * engine finds it, and the first free time for this plan; Move mine takes that time, while the plan is still planned. */
export function PlanClashes({ controller }: { controller: PlansController }) {
  const { clashes, mineFree, plan } = controller;
  const [told, setTold] = useState<ReadonlySet<string>>(new Set());
  if (clashes.length === 0) return null;
  const open = (c: WorkClash): void => {
    if (c.kind === 'plan') controller.openPlan(c.id);
    else controller.openIssue?.(c.id);
  };
  const canOpen = (c: WorkClash): boolean => c.kind === 'plan' || (c.kind === 'issue' && controller.openIssue != null);
  const offer = (c: WorkClash): void => {
    void controller.offer(c).then((ok) => ok && setTold((t) => new Set(t).add(c.id)));
  };
  const canMove = controller.canEdit && mineFree != null && plan?.stage === 'planned';
  return (
    <section className="plans-clashes" aria-label="Also on these devices" data-testid="plans-clashes">
      <h3 className="plans-label">Also on these devices</h3>
      <ul className="plans-clashes__list">
        {clashes.map((c) => (
          <ClashLine key={c.id} clash={c} onOpen={canOpen(c) ? open : null} onOffer={controller.canEdit && c.kind !== 'order' && !told.has(c.id) ? offer : null} />
        ))}
      </ul>
      {told.size > 0 && (
        <p className="plans-note" role="status">
          Note left. It changes nothing of theirs; they decide.
        </p>
      )}
      {canMove && (
        <div className="plans-clashes__move">
          <button type="button" className="btn-small" onClick={() => void controller.moveMine()} data-testid="plans-clash-move">
            Move mine to {windowWords(mineFree)}
          </button>
          <span className="plans-note"> the first time no other plan here takes, the same length</span>
        </div>
      )}
    </section>
  );
}

/** While planning: start the maintenance, or call the plan off. Replaces the lone Start work. With other work open on
 * the same devices, Start asks once more, and Start anyway leaves a note on the plan naming it (sign-off r105 "act" A). */
export function WhatNext({ controller, plan, onStart, held = false }: { controller: PlansController; plan: Plan; onStart: (note?: string) => void; held?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
      {confirming && controller.clashes.length > 0 ? (
        <div className="plans-clash-confirm" role="group" aria-label="Start anyway?" data-testid="plans-clash-confirm">
          <p>
            <strong>
              {controller.clashes.length === 1 ? 'Other work touches these devices' : `${controller.clashes.length} other pieces of work touch these devices`}
            </strong>
          </p>
          <p className="plans-note">Starting anyway leaves a note on this plan naming them, with who and when.</p>
          <p className="plans-step__actions">
            <button
              type="button"
              className="plans-btn btn-main"
              data-testid="plans-start-anyway"
              onClick={() => {
                setConfirming(false);
                onStart(clashNote(controller.clashes));
              }}
            >
              Start anyway
            </button>
            <button type="button" className="plans-btn" onClick={() => setConfirming(false)}>
              Not yet
            </button>
          </p>
        </div>
      ) : !asking ? (
        <>
          <p className="plans-step__actions">
            <button
              type="button"
              className="plans-btn btn-main"
              disabled={plan.steps.length === 0 || held}
              onClick={() => (controller.clashes.length > 0 ? setConfirming(true) : onStart())}
              data-testid="plans-start"
            >
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

// The plan's side panel (mockups r6-maint-*): Plan lists the steps and what they touch, Do is the checklist with
// only the current step live, Record takes the outcome. Docked right, draggable, folds, like the Checks panel.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { OUTCOMES, currentStep, type Plan, type PlanOutcome, type PlanStep } from '../../document/plans';
import { clampOffset } from '../checks/checksModel';
import { AddStepForm } from './AddStepForm';
import { Touches, WhySlot } from './PlanParts';
import { OUTCOME_WORD, outcomeSentence, progress, stepHead, stepIsLive, touchedDevices } from './plansModel';
import type { PlansController } from './usePlansController';
import './plans.css';

/** Words under a step: before → after, as typed. */
function BeforeAfter({ step }: { step: PlanStep }) {
  if (step.before === '' && step.after === '') return null;
  return (
    <p className="plans-step__change">
      {step.before !== '' && <span className="plans-mono">{step.before}</span>}
      {step.before !== '' && step.after !== '' && <span aria-label="becomes"> → </span>}
      {step.after !== '' && <span className="plans-mono">{step.after}</span>}
    </p>
  );
}

/** The kind as a badge, unless the change already opens with it. */
function StepHead({ step }: { step: PlanStep }) {
  const { badge, text } = stepHead(step);
  return (
    <>
      {badge != null && <strong>{badge}</strong>} {text}
    </>
  );
}

function Notice({ controller }: { controller: PlansController }) {
  if (controller.notice == null) return null;
  return (
    <p className="plans-notice" role="alert" data-testid="plans-notice">
      {controller.notice}{' '}
      <button type="button" className="plans-link" onClick={controller.clearNotice}>
        Dismiss
      </button>
    </p>
  );
}

function PlanMode({ controller, plan }: { controller: PlansController; plan: Plan }) {
  const { canEdit } = controller;
  return (
    <>
      <h3 className="plans-label">The plan</h3>
      {plan.steps.length === 0 && <p className="plans-note">No steps yet. Add the first one below.</p>}
      <ol className="plans-steps">
        {plan.steps.map((s, i) => (
          <li key={s.id} className="plans-step plans-step--planned" data-testid="plans-step">
            <p className="plans-step__head">
              <StepHead step={s} />
            </p>
            <BeforeAfter step={s} />
            {canEdit && (
              <p className="plans-step__tools">
                <button type="button" className="plans-link" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => void controller.moveStep(s.id, i - 1)}>
                  Up
                </button>
                {' · '}
                <button type="button" className="plans-link" aria-label={`Move step ${i + 1} down`} disabled={i === plan.steps.length - 1} onClick={() => void controller.moveStep(s.id, i + 1)}>
                  Down
                </button>
                {' · '}
                <button type="button" className="plans-link" aria-label={`Remove step ${i + 1}`} onClick={() => void controller.removeStep(s.id)}>
                  Remove
                </button>
              </p>
            )}
          </li>
        ))}
      </ol>
      <h3 className="plans-label">What it touches</h3>
      <Touches controller={controller} plan={plan} />
      {canEdit && (
        <p>
          <button type="button" className="plans-btn plans-btn--ink" disabled={plan.steps.length === 0} onClick={() => void controller.start()}>
            Start work
          </button>
          {plan.steps.length === 0 && <span className="plans-note"> Add a step first.</span>}
        </p>
      )}
      {canEdit && <AddStepForm controller={controller} stepCount={plan.steps.length} />}
    </>
  );
}

function DoStep({ controller, plan, step }: { controller: PlansController; plan: Plan; step: PlanStep }) {
  const live = stepIsLive(plan, step, controller.canEdit);
  const [differently, setDifferently] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const ref = useRef<HTMLLIElement>(null);
  const refused = controller.refused?.stepId === step.id ? controller.refused.finding : null;
  const mountedLive = useRef(live);
  const differentlyBtn = useRef<HTMLButtonElement>(null);
  const backToButton = useRef(false);

  // Cancel, or Esc in the note: the form goes, and focus goes back to the button that opened it.
  const closeForm = () => {
    backToButton.current = true;
    setDifferently(false);
  };
  useEffect(() => {
    if (!differently && backToButton.current) {
      backToButton.current = false;
      differentlyBtn.current?.focus();
    }
  }, [differently]);

  // The step before this one was just marked: the buttons it had are gone, so focus comes here.
  useEffect(() => {
    if (live && !mountedLive.current) ref.current?.focus();
    if (live) mountedLive.current = true;
  }, [live]);

  if (step.state !== 'planned') {
    return (
      <li className="plans-step plans-step--marked" data-testid="plans-step" data-state={step.state}>
        <p className="plans-step__head">
          {step.state === 'done' ? '✓' : '≠'} {step.ordinal + 1} · {step.change}
        </p>
        {step.note !== '' && <p className="plans-step__note">{step.note}</p>}
      </li>
    );
  }
  if (!live) {
    return (
      <li className="plans-step plans-step--later" data-testid="plans-step" data-state="later">
        <p className="plans-step__head">
          … {step.ordinal + 1} · {step.change}
        </p>
      </li>
    );
  }
  return (
    <li ref={ref} tabIndex={-1} className="plans-step plans-step--current" data-testid="plans-step" data-state="current" aria-current="step">
      <p className="plans-step__title">{step.change}</p>
      <BeforeAfter step={step} />
      <Touches controller={controller} plan={plan} stepId={step.id} />
      {refused != null && (
        <div className="plans-refused" role="alert" data-testid="plans-refused">
          <p>
            <strong>The checks refuse this step.</strong> {refused.title}
          </p>
          <p>
            <strong>Fix:</strong> {refused.fix}{' '}
            <button type="button" className="plans-link" onClick={(e) => controller.openWhy(refused, e.currentTarget)}>
              Why?
            </button>
          </p>
          <p>If it went another way on the day, mark it Went differently.</p>
        </div>
      )}
      {differently ? (
        <form
          className="plans-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim() === '') return;
            void controller.wentDifferently(step.id, note).then((ok) => {
              if (ok) {
                setDifferently(false);
                setNote('');
              }
            });
          }}
        >
          <label htmlFor={noteId}>What happened instead (required)</label>
          <textarea
            id={noteId}
            className="plans-input plans-input--area"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeForm();
              }
            }}
            autoFocus
            required
          />
          <p className="plans-step__actions">
            <button type="submit" className="plans-btn plans-btn--ink" disabled={note.trim() === ''}>
              Save, went differently
            </button>
            <button type="button" className="plans-btn" onClick={closeForm}>
              Cancel
            </button>
          </p>
        </form>
      ) : (
        <p className="plans-step__actions">
          <button type="button" className="plans-btn plans-btn--ink" onClick={() => void controller.done(step.id)}>
            Mark done
          </button>
          <button ref={differentlyBtn} type="button" className="plans-btn" onClick={() => setDifferently(true)}>
            Went differently
          </button>
        </p>
      )}
    </li>
  );
}

function DoMode({ controller, plan }: { controller: PlansController; plan: Plan }) {
  const p = progress(plan);
  return (
    <>
      <h3 className="plans-label">
        Step {p.at} of {p.total}
      </h3>
      <ol className="plans-checklist">
        {plan.steps.map((s) => (
          <DoStep key={s.id} controller={controller} plan={plan} step={s} />
        ))}
      </ol>
    </>
  );
}

function RecordMode({ controller, plan }: { controller: PlansController; plan: Plan }) {
  const recorded = plan.stage === 'recorded';
  const [outcome, setOutcome] = useState<PlanOutcome | null>(plan.outcome);
  const [text, setText] = useState(plan.record);
  const textId = useId();
  const names = controller.doc ? touchedDevices(controller.doc, controller.canon, plan).map((d) => d.name) : [];
  return (
    <>
      <h3 className="plans-label" id={`${textId}-o`}>
        Outcome
      </h3>
      <div className="plans-chips" role="group" aria-labelledby={`${textId}-o`}>
        {OUTCOMES.map((o) => (
          <button
            key={o}
            type="button"
            className="plans-chip"
            aria-pressed={outcome === o}
            disabled={recorded || !controller.canEdit}
            onClick={() => setOutcome(o)}
          >
            {OUTCOME_WORD[o]}
          </button>
        ))}
      </div>
      <p>{outcomeSentence(plan)}</p>
      <label className="plans-label" htmlFor={textId}>
        What went wrong
      </label>
      {recorded ? (
        <p className="plans-record" id={textId}>
          {plan.record === '' ? 'Nothing was written.' : plan.record}
        </p>
      ) : (
        <textarea id={textId} className="plans-input plans-input--area" value={text} onChange={(e) => setText(e.target.value)} disabled={!controller.canEdit} />
      )}
      {recorded ? (
        <p>
          <button type="button" className="plans-btn" aria-pressed={controller.showChanges} onClick={controller.toggleShowChanges} data-testid="plans-show-changes">
            Show these changes
          </button>
        </p>
      ) : (
        controller.canEdit && (
          <p>
            <button type="button" className="plans-btn plans-btn--ink" disabled={outcome == null} onClick={() => outcome != null && void controller.record(outcome, text)}>
              Record
            </button>
            {outcome == null && <span className="plans-note"> Choose an outcome.</span>}
          </p>
        )
      )}
      {recorded && names.length > 0 && (
        <p className="plans-note plans-mono" data-testid="plans-history">
          Saved to the history of {names.join(', ')}
        </p>
      )}
      <ol className="plans-checklist plans-checklist--read">
        {plan.steps.map((s) => (
          <li key={s.id} className="plans-step plans-step--recorded" data-state={s.state}>
            <p className="plans-step__head">
              {s.state === 'done' ? '✓' : '≠'} {s.ordinal + 1} · {s.change}
            </p>
            {s.note !== '' && <p className="plans-step__note">{s.note}</p>}
          </li>
        ))}
      </ol>
    </>
  );
}

/** What the panel is for now. */
export function panelMode(plan: Plan): 'plan' | 'do' | 'record' {
  if (plan.stage === 'planned') return 'plan';
  if (plan.stage === 'doing' && currentStep(plan) != null) return 'do';
  return 'record';
}

const HEADING = { plan: 'Plan', do: 'Do', record: 'Record' } as const;

export function PlanPanel({ controller, plan, besideChecks }: { controller: PlansController; plan: Plan; besideChecks: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const { prefs, setOffset } = controller;
  const [applied, setApplied] = useState({ x: prefs.x, y: prefs.y });
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const mode = panelMode(plan);
  const body = useRef<HTMLDivElement>(null);
  const lastMode = useRef(`${mode}|${plan.stage}`);
  // Start work, the last Done or Record replaced the buttons that had focus: focus the panel's body instead.
  useEffect(() => {
    const now = `${mode}|${plan.stage}`;
    if (lastMode.current !== now) body.current?.focus({ preventScroll: true });
    lastMode.current = now;
  }, [mode, plan.stage]);

  // Same dock, clamp and fold as the Checks panel: the offset is kept, what is drawn stays inside the canvas.
  const measure = () => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent || el.offsetParent !== parent) return null;
    return {
      parent: { left: 0, top: 0, width: parent.clientWidth, height: parent.clientHeight },
      docked: { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight },
    };
  };
  const clamp = (want: { x: number; y: number }) => {
    const m = measure();
    return m == null ? want : clampOffset(m.parent, m.docked, want);
  };
  const settle = () => {
    const m = measure();
    if (m == null) return;
    const next = clampOffset(m.parent, m.docked, { x: prefs.x, y: prefs.y });
    setApplied((p) => (p.x === next.x && p.y === next.y ? p : next));
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useLayoutEffect(() => {
    settleRef.current();
  }, [prefs.x, prefs.y, besideChecks]);
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    const again = () => settleRef.current();
    window.addEventListener('resize', again);
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again);
    if (el) watch?.observe(el);
    if (parent) watch?.observe(parent);
    return () => {
      window.removeEventListener('resize', again);
      watch?.disconnect();
    };
  }, []);

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const at = appliedRef.current;
    drag.current = { px: e.clientX, py: e.clientY, ox: at.x, oy: at.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const place = (d: { px: number; py: number; ox: number; oy: number }, e: ReactPointerEvent<HTMLElement>) => {
    const next = clamp({ x: d.ox + e.clientX - d.px, y: d.oy + e.clientY - d.py });
    if (ref.current) ref.current.style.transform = `translate(${next.x}px, ${next.y}px)`;
    return next;
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current) place(drag.current, e);
  };
  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const next = place(d, e);
    setApplied(next);
    if (next.x !== d.ox || next.y !== d.oy) setOffset(next.x, next.y);
  };

  return (
    <aside
      ref={ref}
      className={`plans-panel${besideChecks ? ' plans-panel--beside-checks' : ''}`}
      data-stage={plan.stage}
      data-mode={mode}
      style={{ transform: `translate(${applied.x}px, ${applied.y}px)` }}
      aria-label="Maintenance plan"
      data-testid="plans-panel"
    >
      <header className="plans-panel__head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <h2 className="plans-panel__title">{HEADING[mode]}</h2>
        <button type="button" className="plans-link" aria-label="Fold the plan panel" onClick={() => controller.setPanelOpen(false)}>
          Fold
        </button>
      </header>
      <div ref={body} tabIndex={-1} className="plans-panel__body">
        <Notice controller={controller} />
        <WhySlot controller={controller} />
        {mode === 'plan' && <PlanMode controller={controller} plan={plan} />}
        {mode === 'do' && <DoMode controller={controller} plan={plan} />}
        {mode === 'record' && <RecordMode key={plan.stage} controller={controller} plan={plan} />}
      </div>
    </aside>
  );
}

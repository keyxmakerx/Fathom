// The plan as a page (mockup r6-maint-a-review): a table of steps, what it touches, notes. Print and Back to
// canvas. On a phone the table stacks into cards; the print stylesheet in plans.css prints this alone.
import { useEffect, useRef } from 'react';

import { currentStep, missingTargets, planProblems, type Plan } from '../../document/plans';
import { Touches, WhySlot } from './PlanParts';
import { KIND_WORD, LIST_TOGGLE_ID, holdSiblings, OUTCOME_WORD, bandSentence, stateText, windowText } from './plansModel';
import type { PlansController } from './usePlansController';
import './plans.css';

export function PlanListPage({ controller, plan }: { controller: PlansController; plan: Plan }) {
  const ref = useRef<HTMLElement>(null);
  // The page covers the canvas: make what is beneath inert, and keep keys from reaching its shortcuts
  // (Delete, undo), so nothing can act on a device nobody can see.
  useEffect(() => {
    const page = ref.current;
    if (!page) return undefined;
    const release = holdSiblings(page);
    const swallow = (e: KeyboardEvent) => {
      if (!page.contains(e.target as Node | null)) e.stopPropagation();
    };
    document.addEventListener('keydown', swallow, true);
    return () => {
      document.removeEventListener('keydown', swallow, true);
      release();
    };
  }, []);
  const back = () => {
    // The list toggle stays in the band: focus goes there before this page goes.
    document.getElementById(LIST_TOGGLE_ID)?.focus();
    controller.setListMode(false);
  };
  const cur = currentStep(plan);
  const notes = plan.steps.filter((s) => s.note !== '');
  const problems = planProblems(plan);
  const missing = controller.doc ? missingTargets(controller.doc, plan) : [];
  const win = windowText(plan.windowStart, plan.windowEnd);
  const meta = [win, plan.author, `${plan.steps.length} ${plan.steps.length === 1 ? 'change' : 'changes'}`].filter((x) => x !== '').join(' · ');
  return (
    <article ref={ref} className="plans-page" onKeyDown={(e) => e.stopPropagation()} data-stage={plan.stage} aria-label={`Plan: ${plan.title}`} data-testid="plans-page">
      <header className="plans-page__head">
        <div>
          <h1 className="plans-page__title">{plan.title}</h1>
          <p className="plans-page__meta plans-mono">{meta}</p>
          <p className="plans-page__meta">{bandSentence(plan, controller.doc, controller.canon)}</p>
        </div>
        <p className="plans-page__tools no-print">
          <button type="button" className="plans-btn" onClick={() => window.print()} data-testid="plans-print">
            Print
          </button>
          <button type="button" className="plans-btn" onClick={back} data-testid="plans-back">
            Back to canvas
          </button>
        </p>
      </header>

      {controller.notice != null && (
        <p className="plans-notice" role="alert">
          {controller.notice}
        </p>
      )}
      <div className="no-print">
        <WhySlot controller={controller} />
      </div>

      <table className="plans-table">
        <thead>
          <tr>
            <th scope="col" className="plans-table__stripe">
              <span className="plans-sr">Step</span>
            </th>
            <th scope="col">Kind</th>
            <th scope="col">Change</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {plan.steps.map((s) => (
            <tr key={s.id} data-state={s.state}>
              <td className="plans-table__stripe">
                <span className="plans-sr">{s.ordinal + 1}</span>
              </td>
              <td data-label="Kind">{KIND_WORD[s.kind]}</td>
              <td data-label="Change">{s.change}</td>
              <td data-label="Before" className="plans-mono">
                {s.before}
              </td>
              <td data-label="After" className="plans-mono">
                {s.after}
              </td>
              <td data-label="State">{plan.stage === 'planned' ? 'Planned' : stateText(s, cur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan.steps.length === 0 && <p className="plans-note">This plan has no steps yet.</p>}

      <div className="plans-page__grid">
        <section className="plans-box" aria-labelledby="plans-page-touches">
          <h2 className="plans-label" id="plans-page-touches">
            What it touches
          </h2>
          <Touches controller={controller} plan={plan} />
          {missing.length > 0 && <p className="plans-note">{missing.length} of the things named here are no longer in the design.</p>}
        </section>
        <section className="plans-box" aria-labelledby="plans-page-notes">
          <h2 className="plans-label" id="plans-page-notes">
            Notes
          </h2>
          {notes.length === 0 && plan.record === '' && <p className="plans-note">No notes yet.</p>}
          {notes.map((s) => (
            <p key={s.id}>
              Step {s.ordinal + 1}: {s.note}
            </p>
          ))}
          {plan.stage === 'recorded' && (
            <p>
              {plan.outcome ? `${OUTCOME_WORD[plan.outcome]}. ` : ''}
              {plan.record}
            </p>
          )}
        </section>
      </div>
      {problems.length > 0 && (
        <p className="plans-note">
          This plan is out of order: {problems.join('; ')}.
        </p>
      )}
    </article>
  );
}

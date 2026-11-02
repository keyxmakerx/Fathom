// The plan-to-maintenance flow (sign-off r73-plan-flow, schema 0.33): an If path under a step, the release notes on a
// plan, Troubleshoot from a step that went differently, and the checks after the work. The pieces the panel places.
import { useId, useMemo, useState } from 'react';

import {
  CHECK_ANSWERS,
  checksLeft,
  markedNoteLines,
  noteWords,
  type CheckAnswer,
  type Plan,
  type PlanStep,
} from '../../document/plans';
import { SEVERITY } from '../checks/checksModel';
import { AddStepForm } from './AddStepForm';
import { TypedSentence, usePasteMark } from './PlanParts';
import { firstLine, nameOf, stepHead } from './plansModel';
import type { PlansController } from './usePlansController';

export const CHECK_WORD: Record<CheckAnswer, string> = { open: 'Not answered', ok: 'OK', not_ok: 'Not OK', cant_tell: "Can't tell" };
const CHECK_GLYPH: Record<CheckAnswer, string> = { open: '○', ok: '✓', not_ok: '✗', cant_tell: '?' };

// ---------------------------------------------------------------------------
// If paths

/** Under a main-line step while planning: its If path, or the way to give it one. One level only. */
export function IfPath({ controller, plan, step }: { controller: PlansController; plan: Plan; step: PlanStep }) {
  const { canEdit } = controller;
  const path = plan.ifPaths[step.id] ?? [];
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(step.ifWhen);
  const paste = usePasteMark();
  const whenId = useId();
  const has = step.ifWhen !== '' || path.length > 0;

  if (editing) {
    return (
      <form
        className="plans-form plans-if__form"
        aria-label={`If path for step ${step.label}`}
        onSubmit={(e) => {
          e.preventDefault();
          void controller.setIfWhen(step.id, when, paste.pasted).then((ok) => {
            if (ok) {
              setEditing(false);
              paste.reset();
            }
          });
        }}
      >
        <label htmlFor={whenId}>If this happens on the night</label>
        <input
          id={whenId}
          className="plans-input"
          value={when}
          placeholder="It isn't back in 15 minutes"
          onChange={(e) => setWhen(e.target.value)}
          onPaste={paste.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
          autoFocus
        />
        <TypedSentence />
        <p className="plans-step__actions">
          <button type="submit" className="plans-btn btn-main">
            {when.trim() === '' ? 'Take the If path away' : 'Save'}
          </button>
          <button type="button" className="plans-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </p>
      </form>
    );
  }
  if (!has) {
    return canEdit ? (
      <p className="plans-step__tools">
        <button
          type="button"
          className="plans-link"
          data-testid="plans-add-if"
          onClick={() => {
            setWhen('');
            setEditing(true);
          }}
        >
          Add an If path
        </button>
      </p>
    ) : null;
  }
  return (
    <div className="plans-if" data-testid="plans-if" role="group" aria-label={`Step ${step.label}'s If path`}>
      <p className="plans-if__when">
        <span className="plans-if__tag">If</span> {step.ifWhen !== '' ? step.ifWhen : 'no reason written yet'}
        {canEdit && (
          <>
            {' '}
            <button
              type="button"
              className="plans-link"
              onClick={() => {
                setWhen(step.ifWhen);
                setEditing(true);
              }}
            >
              Change
            </button>
          </>
        )}
      </p>
      {path.length > 0 && (
        <ol className="plans-if__steps">
          {path.map((b) => (
            <li key={b.id} className="plans-if__step" data-testid="plans-if-step">
              <span className="plans-if__no">{b.label}</span> <IfStepHead step={b} />
              {canEdit && (
                <>
                  {' '}
                  <button type="button" className="plans-link" aria-label={`Remove step ${b.label}`} onClick={() => void controller.removeStep(b.id)}>
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {path.length === 0 && <p className="plans-note">No steps on it yet.</p>}
      <IfTouches controller={controller} path={path} />
      {canEdit && <AddStepForm controller={controller} stepCount={1} branch={{ stepId: step.id, label: step.label }} />}
    </div>
  );
}

function IfStepHead({ step }: { step: PlanStep }) {
  const { badge, text } = stepHead(step);
  return (
    <>
      {badge != null && <strong>{badge}</strong>} {text}
    </>
  );
}

/** What the bad night would change: the things the If path's steps name, by name. */
function IfTouches({ controller, path }: { controller: PlansController; path: readonly PlanStep[] }) {
  const doc = controller.doc;
  const names = useMemo(() => {
    if (doc == null) return [];
    const ids = [...new Set(path.flatMap((s) => s.targets.map(controller.canon)))];
    return ids.map((id) => nameOf(doc, controller.canon, id));
  }, [doc, path, controller.canon]);
  if (path.length === 0) return null;
  return <p className="plans-note">Touches: {names.length === 0 ? 'nothing named' : names.join(', ')}</p>;
}

/** On the night, under a step that went differently: take its If path, if it has one and nothing after is marked. */
export function TakeIfPath({ controller, plan, step }: { controller: PlansController; plan: Plan; step: PlanStep }) {
  const path = plan.ifPaths[step.id] ?? [];
  if (step.state !== 'went_differently' || step.branchOf !== '' || path.length === 0) return null;
  if (step.ifTaken) return <p className="plans-note" data-testid="plans-if-taken">Took the If path: {path.map((b) => b.label).join(', ')}.</p>;
  const after = plan.steps.slice(plan.steps.indexOf(step) + 1);
  if (plan.stage !== 'doing' || !controller.canEdit || after.some((s) => s.state !== 'planned')) return null;
  return (
    <div className="plans-if plans-if--offer" data-testid="plans-take-if">
      <p className="plans-if__when">
        <span className="plans-if__tag">If</span> {step.ifWhen !== '' ? step.ifWhen : 'this step goes wrong'}
      </p>
      <ol className="plans-if__steps">
        {path.map((b) => (
          <li key={b.id} className="plans-if__step">
            <span className="plans-if__no">{b.label}</span> {firstLine(b.change)}
          </li>
        ))}
      </ol>
      <p>
        <button type="button" className="plans-btn btn-main" onClick={() => void controller.takeIfPath(step.id)}>
          Take the If path
        </button>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Troubleshoot from a step

/** Under a step that went differently: what the release notes say about it, Troubleshoot, and the issue it opened. */
export function StepFollowUp({ controller, plan, step }: { controller: PlansController; plan: Plan; step: PlanStep }) {
  const doc = controller.doc;
  const said = useMemo(() => {
    if (doc == null || plan.releaseNotes === '' || step.state !== 'went_differently') return [];
    const lines = plan.releaseNotes.split('\n');
    return markedNoteLines(plan.releaseNotes, noteWords(doc, { ...plan, steps: [step], ifPaths: {} })).map((m) => lines[m.line]);
  }, [doc, plan, step]);
  if (step.state !== 'went_differently') return null;
  return (
    <>
      {said.length > 0 && (
        <div className="plans-notes-hit" data-testid="plans-notes-hit">
          <p className="plans-label">The release notes mention this</p>
          {said.slice(0, 3).map((l, i) => (
            <p key={i} className="plans-mono">
              {l}
            </p>
          ))}
        </div>
      )}
      {step.issue !== '' ? (
        <p className="plans-note" data-testid="plans-step-issue">
          Troubleshooting is saved as an issue.{' '}
          {controller.openIssue != null && (
            <button type="button" className="plans-link" onClick={() => controller.openIssue?.(step.issue)}>
              Open it
            </button>
          )}
        </p>
      ) : (
        controller.canTroubleshoot &&
        plan.stage !== 'recorded' && (
          <p className="plans-step__actions">
            <button type="button" className="plans-btn" data-testid="plans-troubleshoot" onClick={() => controller.troubleshoot(step.id)}>
              Troubleshoot
            </button>
            <span className="plans-note">Opens It&apos;s down on this step&apos;s device, with what you wrote.</span>
          </p>
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Release notes

/** The release notes or changelog on a plan: pasted through the redaction gate, lines naming what it touches marked. */
export function ReleaseNotes({ controller, plan }: { controller: PlansController; plan: Plan }) {
  const doc = controller.doc;
  const canChange = controller.canEdit && plan.stage !== 'recorded';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const paste = usePasteMark();
  const areaId = useId();
  const marked = useMemo(() => (doc == null ? [] : markedNoteLines(plan.releaseNotes, noteWords(doc, plan))), [doc, plan]);
  const hits = new Map(marked.map((m) => [m.line, m.words]));

  if (editing) {
    return (
      <form
        className="plans-form"
        aria-label="Release notes"
        onSubmit={(e) => {
          e.preventDefault();
          void controller.setReleaseNotes(draft, paste.pasted).then((ok) => {
            if (ok) {
              setEditing(false);
              paste.reset();
            }
          });
        }}
      >
        <label className="plans-label" htmlFor={areaId}>
          Release notes or changelog
        </label>
        <textarea
          id={areaId}
          className="plans-input plans-input--area plans-input--notes"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={paste.onPaste}
          onInput={paste.onInput}
          placeholder="Paste the vendor's release notes, or the known issues."
          autoFocus
        />
        <p className="plans-note">Pasted text goes through the password check in this browser before it is saved.</p>
        <p className="plans-step__actions">
          <button type="submit" className="plans-btn btn-main">
            {draft.trim() === '' ? 'Take them off' : 'Save'}
          </button>
          <button type="button" className="plans-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </p>
      </form>
    );
  }
  if (plan.releaseNotes === '') {
    return canChange ? (
      <p>
        <button
          type="button"
          className="plans-btn"
          data-testid="plans-notes-add"
          onClick={() => {
            setDraft('');
            setEditing(true);
          }}
        >
          Paste release notes…
        </button>
      </p>
    ) : null;
  }
  const lines = plan.releaseNotes.split('\n');
  return (
    <section className="plans-notes" aria-label="Release notes" data-testid="plans-notes">
      <h3 className="plans-label">Release notes</h3>
      <div className="plans-notes__text plans-mono">
        {lines.map((l, i) => (
          <p key={i} className={hits.has(i) ? 'plans-notes__line plans-notes__line--hit' : 'plans-notes__line'} data-hit={hits.has(i) ? 'true' : undefined}>
            {l === '' ? ' ' : l}
            {hits.has(i) && <span className="plans-sr"> (names {hits.get(i)!.join(', ')}, which this plan touches)</span>}
          </p>
        ))}
      </div>
      <p className="plans-note" data-testid="plans-notes-count">
        {marked.length === 0
          ? 'No line names something this plan touches.'
          : `${marked.length === 1 ? '1 line names' : `${marked.length} lines name`} something this plan touches: ${[...new Set(marked.flatMap((m) => m.words))].join(', ')}.`}{' '}
        {canChange && (
          <button
            type="button"
            className="plans-link"
            onClick={() => {
              setDraft(plan.releaseNotes);
              setEditing(true);
            }}
          >
            Change
          </button>
        )}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Checks after the work

/** While planning: the typed checks to answer after the work, and a box to add one. */
export function PlanChecks({ controller, plan }: { controller: PlansController; plan: Plan }) {
  return (
    <section aria-labelledby="plans-checks-after" data-testid="plans-checks-plan">
      <h3 className="plans-label" id="plans-checks-after">
        Checks after the work
      </h3>
      <p className="plans-note">Fathom&apos;s own Checks run on what the plan touched. Add what only a person can see.</p>
      {plan.checks.length > 0 && (
        <ul className="plans-after">
          {plan.checks.map((c, i) => (
            <li key={`${i}|${c.text}`} className="plans-after__item" data-testid="plans-check">
              {c.text}
              {controller.canEdit && (
                <>
                  {' '}
                  <button type="button" className="plans-link" aria-label={`Remove the check ${c.text}`} onClick={() => void controller.removeCheck(i)}>
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {controller.canEdit && <AddCheck controller={controller} />}
    </section>
  );
}

function AddCheck({ controller }: { controller: PlansController }) {
  const [text, setText] = useState('');
  const paste = usePasteMark();
  const id = useId();
  return (
    <form
      className="plans-form plans-form--inline"
      aria-label="Add a check"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() === '') return;
        void controller.addCheck(text, paste.pasted).then((ok) => {
          if (ok) {
            setText('');
            paste.reset();
          }
        });
      }}
    >
      <label htmlFor={id} className="plans-sr">
        A check after the work
      </label>
      <input id={id} className="plans-input" value={text} placeholder="BGP to the ISP is Established" onChange={(e) => setText(e.target.value)} onPaste={paste.onPaste} data-testid="plans-check-input" />
      <button type="submit" className="plans-btn" disabled={text.trim() === ''}>
        Add check
      </button>
    </form>
  );
}

/** Once every step is marked: Fathom's Checks on what was touched, then each typed check answered. Record waits. */
export function AfterTheWork({ controller, plan }: { controller: PlansController; plan: Plan }) {
  const recorded = plan.stage === 'recorded';
  const found = controller.touchedFindings;
  const left = checksLeft(plan);
  return (
    <section className="plans-afterwork" aria-labelledby="plans-afterwork" data-testid="plans-after-work">
      <h3 className="plans-label" id="plans-afterwork">
        After the work
      </h3>
      {!recorded && (
        <div className="plans-after__fathom" data-testid="plans-after-fathom">
          <p className="plans-after__head">Fathom&apos;s checks on what this plan touched</p>
          {found == null ? (
            <p className="plans-note">Checks have not run yet.</p>
          ) : found.length === 0 ? (
            <p className="plans-note">No findings.</p>
          ) : (
            <ul className="plans-touches">
              {found.slice(0, 6).map((f) => (
                <li key={`${f.rule}|${f.elements.map((e) => e.id).join(',')}`} className={`plans-touches__item plans-touches__item--${f.severity}`}>
                  <span className="plans-touches__sev">{SEVERITY[f.severity].word}</span> {f.title}{' '}
                  <button type="button" className="plans-link" onClick={(e) => controller.openWhy(f, e.currentTarget)}>
                    Why?
                  </button>
                </li>
              ))}
              {found.length > 6 && <li className="plans-note">And {found.length - 6} more in Checks.</li>}
            </ul>
          )}
        </div>
      )}
      {plan.checks.length > 0 && (
        <ul className="plans-after">
          {plan.checks.map((c, i) => (
            <AfterItem key={`${i}|${c.text}`} controller={controller} plan={plan} index={i} />
          ))}
        </ul>
      )}
      {!recorded && controller.canEdit && <AddCheck controller={controller} />}
      {!recorded && left > 0 && (
        <p className="plans-note" data-testid="plans-checks-left">
          {left === 1 ? '1 check' : `${left} checks`} to answer before Record.
        </p>
      )}
    </section>
  );
}

function AfterItem({ controller, plan, index }: { controller: PlansController; plan: Plan; index: number }) {
  const c = plan.checks[index]!;
  const recorded = plan.stage === 'recorded';
  const [seen, setSeen] = useState(c.seen);
  const paste = usePasteMark();
  const groupId = useId();
  const can = controller.canEdit && !recorded;
  return (
    <li className="plans-after__item" data-testid="plans-check" data-answer={c.answer}>
      <p id={groupId} className="plans-after__text">
        <span aria-hidden="true">{CHECK_GLYPH[c.answer]}</span> {c.text}
        {recorded && <span className="plans-note"> · {CHECK_WORD[c.answer]}</span>}
      </p>
      {recorded ? (
        c.seen !== '' && <p className="plans-step__note">{c.seen}</p>
      ) : (
        <>
          <div className="plans-chips" role="group" aria-labelledby={groupId}>
            {CHECK_ANSWERS.map((a) => (
              <button
                key={a}
                type="button"
                className="plans-chip"
                aria-pressed={c.answer === a}
                disabled={!can}
                onClick={() => void controller.answerCheck(index, a, seen, paste.pasted)}
              >
                {CHECK_WORD[a]}
              </button>
            ))}
          </div>
          {c.answer !== 'open' && c.answer !== 'ok' && (
            <input
              className="plans-input"
              aria-label={`What you saw: ${c.text}`}
              value={seen}
              placeholder="What you saw (optional)"
              disabled={!can}
              onChange={(e) => setSeen(e.target.value)}
              onPaste={paste.onPaste}
              onBlur={() => {
                if (seen !== c.seen) void controller.answerCheck(index, c.answer, seen, paste.pasted);
              }}
            />
          )}
          {c.answer === 'not_ok' && controller.canTroubleshoot && (
            <p className="plans-step__actions">
              <button type="button" className="plans-btn" data-testid="plans-check-troubleshoot" onClick={() => controller.troubleshootCheck(index)}>
                Troubleshoot
              </button>
            </p>
          )}
        </>
      )}
    </li>
  );
}

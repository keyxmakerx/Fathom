// The "It's down" side panel (mockups r8-trouble-a-*): the device's chain as a checklist, nearest first. A step is
// answered OK / Not OK / Can't tell; the current one is open with its question, detail, a Why? card and a note;
// later ones are dimmed. Below: where the answers point, what else is affected, and Plan a fix / Save as an issue.
// Drawn in ink: the answers are the glyphs ✓ ✗ ? ○, never colours.
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { Answer, Issue } from '../../document/issues';
import { isTypingTarget } from '../checks/checksModel';
import { TypedSentence, isPasteInput, usePasteMark } from '../plans/PlanParts';
import { ANSWER_WORD, GLYPH, answerForKey, answered, headerText, planFixState, pointOf, whenText, type Draft, type DraftStepState } from './troubleModel';
import type { TroubleController } from './useTroubleController';
import '../plans/plans.css';
import './trouble.css';

const ANSWERS: readonly Answer[] = ['ok', 'not_ok', 'cant_tell'];
const KEY_OF: Record<string, string> = { ok: '1', not_ok: '2', cant_tell: '3' };

function Notice({ controller }: { controller: TroubleController }) {
  if (controller.notice == null) return null;
  return (
    <p className="trouble-notice" role="alert" data-testid="trouble-notice">
      {controller.notice}{' '}
      <button type="button" className="trouble-link" onClick={controller.clearNotice}>
        Dismiss
      </button>
    </p>
  );
}

function WhyCard({ step, onClose }: { step: { why: readonly string[]; question: string }; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <section ref={ref} tabIndex={-1} className="trouble-why" aria-label="Why" data-testid="trouble-why">
      {step.why.map((w) => (
        <p key={w}>{w}</p>
      ))}
      <button type="button" className="trouble-link" onClick={onClose}>
        Close
      </button>
    </section>
  );
}

function AnswerButtons({ step, index, controller }: { step: DraftStepState; index: number; controller: TroubleController }) {
  const group = useRef<HTMLDivElement>(null);
  const locked = !controller.canEdit || controller.draft?.savedId != null;
  // Left and Right move between the three; Enter or Space answers (a button's own keys).
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const buttons = [...(group.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    buttons[(at + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return (
    <div ref={group} className="trouble-answers" role="group" aria-label={`Answer step ${index + 1}`} onKeyDown={onKey}>
      {ANSWERS.map((a) => (
        <button
          key={a}
          type="button"
          className={`trouble-btn${a === 'cant_tell' ? ' trouble-btn--quiet' : ''}`}
          aria-pressed={step.answer === a}
          aria-keyshortcuts={KEY_OF[a]}
          disabled={locked}
          data-answer={a}
          onClick={() => controller.answer(index, a)}
        >
          {ANSWER_WORD[a]}
        </button>
      ))}
    </div>
  );
}

function Note({ step, index, controller }: { step: DraftStepState; index: number; controller: TroubleController }) {
  const id = useId();
  const paste = usePasteMark();
  const area = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(step.note !== '');
  const locked = !controller.canEdit || controller.draft?.savedId != null;
  if (locked && step.note === '') return null;
  if (!open) {
    return (
      <button
        type="button"
        className="trouble-link trouble-add-note"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => area.current?.focus());
        }}
      >
        Add what you saw
      </button>
    );
  }
  return (
    <div className="trouble-note">
      <label htmlFor={id} className="trouble-label">
        What you saw (optional)
      </label>
      <textarea
        ref={area}
        id={id}
        className="trouble-input"
        value={step.note}
        disabled={locked}
        placeholder="Add what you saw…"
        autoFocus
        onChange={(e) => controller.setNote(index, e.target.value, paste.pasted || isPasteInput(e.nativeEvent as { inputType?: string }))}
        onInput={paste.onInput}
        onPaste={(e) => {
          paste.onPaste(e);
          controller.setNote(index, step.note, true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // The first Esc leaves the note; the next closes the card, then the panel.
            e.stopPropagation();
            (e.currentTarget.closest('li') as HTMLElement | null)?.focus();
          }
        }}
      />
      {!locked && <TypedSentence />}
    </div>
  );
}

function Step({ step, index, controller }: { step: DraftStepState; index: number; controller: TroubleController }) {
  const current = controller.focus === index;
  const li = useRef<HTMLLIElement>(null);
  const wasCurrent = useRef(current);
  // The step before this one was just answered: focus comes to the one now open, so the keys keep working.
  useEffect(() => {
    if (current && !wasCurrent.current) {
      const at = document.activeElement as HTMLElement | null;
      if (at == null || at === document.body || at.closest('.trouble-panel') != null) li.current?.focus({ preventScroll: true });
    }
    wasCurrent.current = current;
  }, [current]);
  const glyph = GLYPH[step.answer];
  const state = current ? 'current' : step.answer === 'unanswered' ? 'later' : 'answered';
  const whyOpen = controller.why === index;
  return (
    <li
      ref={li}
      tabIndex={-1}
      className={`trouble-step trouble-step--${state}`}
      data-testid="trouble-step"
      data-state={state}
      data-answer={step.answer}
      data-topic={step.topic}
      aria-current={current ? 'step' : undefined}
    >
      {current ? (
        <>
          <p className="trouble-step__title">
            <span className="trouble-step__no">{index + 1} ·</span> {step.question}{' '}
            <button type="button" className="trouble-link trouble-why-btn" aria-expanded={whyOpen} onClick={(e) => (whyOpen ? controller.closeWhy() : controller.openWhy(index, e.currentTarget))}>
              Why?
            </button>
          </p>
          {step.detail !== '' && <p className="trouble-step__detail">{step.detail}</p>}
          {whyOpen && <WhyCard step={step} onClose={controller.closeWhy} />}
          <AnswerButtons step={step} index={index} controller={controller} />
          <Note step={step} index={index} controller={controller} />
        </>
      ) : (
        <>
          <div className="trouble-step__row">
            <button type="button" className="trouble-step__head" onClick={() => controller.focusStep(index)} aria-label={`Step ${index + 1}, ${ANSWER_WORD[step.answer]}: ${step.question}`}>
              <span className="trouble-glyph" aria-hidden="true">
                {glyph}
              </span>{' '}
              <span className="trouble-step__no">{index + 1} ·</span> {step.question}
            </button>
            <button
              type="button"
              className="trouble-link trouble-why-btn"
              aria-label={`Why? Step ${index + 1}`}
              onClick={(e) => {
                controller.focusStep(index);
                controller.openWhy(index, e.currentTarget);
              }}
            >
              Why?
            </button>
          </div>
          {step.note !== '' && <p className="trouble-step__noted">{step.note}</p>}
        </>
      )}
    </li>
  );
}

function PointBlock({ draft }: { draft: Draft }) {
  const p = pointOf(draft);
  if (p === null) return null;
  return (
    <section className="trouble-point" aria-label="Where your answers point" data-testid="trouble-point">
      <p className="trouble-point__sentence" aria-live="polite">
        {p.sentence} {p.note}
      </p>
      {p.tests.length > 0 && (
        <ul className="trouble-tests">
          {p.tests.map((t) => (
            <li key={t} className="trouble-test">
              {t}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Footer({ draft, controller }: { draft: Draft; controller: TroubleController }) {
  const plan = planFixState(draft, controller.canEdit);
  const reasonId = useId();
  if (!controller.canEdit || answered(draft.steps) === 0) return null;
  return (
    <>
      <div className="trouble-footer">
        <button type="button" className="trouble-btn trouble-btn--ink" aria-disabled={!plan.ok} aria-describedby={plan.ok ? undefined : reasonId} onClick={() => void controller.planAFix()} data-testid="trouble-plan">
          Plan a fix
        </button>
        {draft.savedId === null && (
          <button type="button" className="trouble-btn" onClick={() => void controller.save()} data-testid="trouble-save">
            Save as an issue
          </button>
        )}
      </div>
      {!plan.ok && (
        <p className="trouble-hint" id={reasonId}>
          {plan.reason}
        </p>
      )}
      {draft.savedId !== null ? (
        <p className="trouble-note-line" data-testid="trouble-saved">
          Saved to {draft.deviceName}'s history.{' '}
          <button type="button" className="trouble-link" onClick={() => void controller.markClosed().then((ok) => ok && controller.close(true))}>
            Mark closed
          </button>
        </p>
      ) : (
        <p className="trouble-note-line">Either way it is saved to {draft.deviceName}'s history. Until then, nothing is kept.</p>
      )}
    </>
  );
}

function DraftBody({ draft, controller }: { draft: Draft; controller: TroubleController }) {
  return (
    <>
      <ol className="trouble-steps" data-testid="trouble-steps">
        {draft.steps.map((s, i) => (
          <Step key={`${draft.openedAt}|${i}`} step={s} index={i} controller={controller} />
        ))}
      </ol>
      <PointBlock draft={draft} />
      <Footer draft={draft} controller={controller} />
      <h3 className="trouble-label">Also affected</h3>
      {draft.affected.map((l) => (
        <p key={l} className="trouble-affected">
          {l}
        </p>
      ))}
    </>
  );
}

function SavedBody({ issue, controller }: { issue: Issue; controller: TroubleController }) {
  return (
    <>
      <p className="trouble-hint" data-testid="trouble-saved-head">
        Saved {whenText(issue.openedAt)}
        {issue.author !== '' ? ` by ${issue.author}` : ''} · {issue.stage}
      </p>
      <ol className="trouble-steps trouble-steps--saved">
        {issue.steps.map((s) => (
          <li key={s.id} className="trouble-step trouble-step--answered" data-testid="trouble-step" data-answer={s.answer}>
            <p className="trouble-step__head trouble-step__head--read">
              <span className="trouble-glyph" aria-hidden="true">
                {GLYPH[s.answer]}
              </span>{' '}
              <span className="trouble-step__no">{s.ordinal + 1} ·</span> {s.question} <span className="trouble-sr">{ANSWER_WORD[s.answer]}</span>
            </p>
            {s.detail !== '' && <p className="trouble-step__detail">{s.detail}</p>}
            {s.note !== '' && <p className="trouble-step__noted">{s.note}</p>}
          </li>
        ))}
      </ol>
      {issue.outcome !== '' && (
        <p className="trouble-point__sentence" data-testid="trouble-outcome">
          {issue.outcome}
        </p>
      )}
      {issue.stage === 'open' && controller.canEdit && (
        <p className="trouble-footer">
          <button type="button" className="trouble-btn" onClick={() => void controller.markClosed()} data-testid="trouble-close-issue">
            Mark closed
          </button>
        </p>
      )}
    </>
  );
}

export function TroublePanel({ controller, besideChecks, besidePlans = false }: { controller: TroubleController; besideChecks: boolean; besidePlans?: boolean }) {
  const { draft, viewing } = controller;
  const body = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  // Opened with nothing holding focus: the open step takes it, so the keys work at once.
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    if (document.activeElement === document.body || document.activeElement == null) {
      const target = body.current?.querySelector<HTMLElement>('[aria-current="step"]') ?? body.current;
      target?.focus({ preventScroll: true });
    }
  }, []);
  // Folded with focus inside (Esc): the bar's Open button takes it, so focus is never left on the body.
  const openBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!controller.panelOpen && (document.activeElement == null || document.activeElement === document.body)) openBtn.current?.focus();
  }, [controller.panelOpen]);
  // The open step closed on a Not OK: the card it held is gone, so the panel's body keeps focus.
  useEffect(() => {
    if (controller.focus === -1 && controller.panelOpen && (document.activeElement == null || document.activeElement === document.body)) body.current?.focus({ preventScroll: true });
  }, [controller.focus, controller.panelOpen]);
  // 1, 2, 3 answer the open step, anywhere in the panel but a typing field.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (draft == null || !controller.canEdit || draft.savedId !== null || controller.focus < 0) return;
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target as HTMLElement)) return;
    // A key on a later row is not an answer to the open step.
    const row = (e.target as HTMLElement).closest('li');
    if (row != null && row.getAttribute('aria-current') !== 'step') return;
    const a = answerForKey(e.key);
    if (a === null) return;
    e.preventDefault();
    controller.answer(controller.focus, a);
  };
  const title = draft ? headerText(draft, controller.focus) : viewing ? `${viewing.title}` : '';
  const placed = `trouble-panel${besideChecks ? ' trouble-panel--beside-checks' : ''}${besidePlans ? ' trouble-panel--beside-plans' : ''}`;
  if (!controller.panelOpen) {
    return (
      <div className="trouble-folded" data-testid="trouble-folded">
        <button ref={openBtn} type="button" className="trouble-btn trouble-btn--ink" onClick={() => controller.setPanelOpen(true)}>
          Open "{title}"
        </button>
        <button type="button" className="trouble-btn" onClick={() => controller.close()}>
          Stop
        </button>
      </div>
    );
  }
  return (
    <aside className={placed} aria-label="It's down" data-testid="trouble-panel" onKeyDown={onKeyDown}>
      <header className="trouble-panel__head">
        <h2 className="trouble-panel__title" data-testid="trouble-title">
          {title}
        </h2>
        <span className="trouble-panel__tools">
          <button type="button" className="trouble-link" aria-label="Fold the panel" onClick={() => controller.setPanelOpen(false)}>
            Fold
          </button>
          <button type="button" className="trouble-link" aria-label="Close" onClick={() => controller.close()} data-testid="trouble-close">
            Close
          </button>
        </span>
      </header>
      <div ref={body} tabIndex={-1} className="trouble-panel__body">
        <Notice controller={controller} />
        {controller.confirmingClose && (
          <p className="trouble-notice" role="alert" data-testid="trouble-confirm">
            Close without saving? Your answers are not kept.{' '}
            <button type="button" className="trouble-link" onClick={() => controller.close(true)}>
              Close anyway
            </button>{' '}
            <button type="button" className="trouble-link" onClick={controller.keepGoing}>
              Keep going
            </button>
          </p>
        )}
        {draft != null && <DraftBody draft={draft} controller={controller} />}
        {draft == null && viewing != null && <SavedBody issue={viewing} controller={controller} />}
      </div>
    </aside>
  );
}

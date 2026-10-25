// The lesson runner (ADR-0066 §2): one step at a time, beside the canvas, each checked by Fathom from the design.
// A step passes on its own once the design, the selection, the trace or Checks says so; "Next" moves on, so the
// learner has time to read why.
import { useEffect, useMemo, useState } from 'react';

import { safeUrl } from '../../document/docs';
import type { Document } from '../../document/model';
import type { TraceResult } from '../../engine/engine';
import { useLearn } from '../learn/context';
import type { TraceEnd } from '../trace/useTraceController';
import {
  checkChange,
  checkClick,
  checkTrace,
  KIND_WORDS,
  traceArgs,
  type Lesson,
  type LessonStep,
  type StepCheck,
} from './lessonModel';
import { bootLessonMirror, useLessonChecks, type BootMirror } from './useLessonChecks';
import './lessons.css';

export interface LessonTraceAsk {
  from: TraceEnd;
  to: TraceEnd;
  flowText: string;
}

export interface LessonPanelProps {
  lesson: Lesson;
  /** Steps passed so far. */
  step: number;
  doc: Document | null;
  selectedId: string | null;
  onAdvance: (step: number) => void;
  /** Shows a trace on the canvas, the way the trace panel does. */
  onTrace: (ask: LessonTraceAsk) => void;
  boot?: BootMirror;
  /** Inventory keeps its list of kinds on the left, so there the panel sits on the right. */
  side?: 'left' | 'right';
}

function Prose({ text }: { text: string }) {
  // `like this` is a command or a name, set as code; everything else is plain text.
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

export function LessonPanel({ lesson, step, doc, selectedId, onAdvance, onTrace, boot = bootLessonMirror, side = 'left' }: LessonPanelProps) {
  const [folded, setFolded] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const done = step >= lesson.steps.length;
  const current: LessonStep | null = done ? null : lesson.steps[step]!;
  const engine = useLessonChecks(doc, current?.kind === 'change', boot);
  const learn = useLearn();

  // A trace step's answer, once the learner has asked for it; it follows the design as it changes.
  const [traced, setTraced] = useState<{ step: number; result: TraceResult } | null>(null);
  const [traceError, setTraceError] = useState('');
  const [asked, setAsked] = useState<number | null>(null);
  useEffect(() => {
    if (current?.kind !== 'trace' || asked !== step || doc == null) return undefined;
    const args = traceArgs(doc, current);
    if (args == null) {
      setTraceError('The two ends of this trace are no longer in this copy of the design.');
      return undefined;
    }
    let cancelled = false;
    engine
      .trace(args.from, args.to, args.flow)
      .then((result) => {
        if (!cancelled) {
          setTraced({ step, result });
          setTraceError('');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setTraceError(e instanceof Error ? e.message : 'The trace could not run.');
      });
    return () => {
      cancelled = true;
    };
    // `engine.trace` is stable; `doc` re-runs it after a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, asked, step, doc]);

  const live: StepCheck = useMemo(() => {
    if (current == null || doc == null) return { state: 'waiting' };
    switch (current.kind) {
      case 'read':
        return { state: 'passed' };
      case 'click':
        return checkClick(doc, current, selectedId);
      case 'trace':
        return traced?.step === step ? checkTrace(current.expect, traced.result) : { state: 'waiting' };
      case 'change':
        return checkChange(current, engine.checks);
    }
  }, [current, doc, selectedId, traced, step, engine.checks]);

  // A pass stays passed until the learner moves on: deselecting the answer, say, does not take it back.
  const [passedAt, setPassedAt] = useState<number | null>(null);
  useEffect(() => {
    if (live.state === 'passed' && passedAt !== step) setPassedAt(step);
  }, [live.state, passedAt, step]);
  const check: StepCheck = passedAt === step ? { state: 'passed' } : live;

  function askTrace() {
    if (current?.kind !== 'trace' || doc == null) return;
    const args = traceArgs(doc, current);
    if (args == null) {
      setTraceError('The two ends of this trace are no longer in this copy of the design.');
      return;
    }
    setAsked(step);
    onTrace({ from: { deviceId: args.from, label: args.fromLabel }, to: { deviceId: args.to, label: args.toLabel }, flowText: args.flowText });
  }

  return (
    <aside className={`lesson-panel lesson-panel--${side}${folded ? ' lesson-panel--folded' : ''}`} aria-label={`Lesson: ${lesson.title}`} data-testid="lesson-panel">
      <div className="lesson-panel__head">
        <div className="lesson-panel__kicker">
          Lesson · {done ? 'done' : `step ${step + 1} of ${lesson.steps.length}`}
        </div>
        <button type="button" className="lesson-panel__fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
          {folded ? 'Show' : 'Hide'}
        </button>
      </div>
      <div className="lesson-panel__title">{lesson.title}</div>
      {!folded && (
        <>
          <ol className="lesson-panel__dots" aria-label="Steps">
            {lesson.steps.map((s, i) => (
              <li
                key={i}
                className={i < step ? 'lesson-panel__dot lesson-panel__dot--done' : i === step ? 'lesson-panel__dot lesson-panel__dot--on' : 'lesson-panel__dot'}
                title={`${i + 1}. ${s.title}`}
              >
                <span className="lessons-sr">
                  {i + 1}. {s.title}
                  {i < step ? ', done' : i === step ? ', current' : ''}
                </span>
              </li>
            ))}
          </ol>

          {current == null ? (
            <div className="lesson-step">
              <p className="lesson-step__text">
                Lesson done. This copy of the sample is yours to keep or delete; your other designs were never touched.
              </p>
            </div>
          ) : (
            <div className="lesson-step" data-testid="lesson-step" data-kind={current.kind}>
              <div className="lesson-step__kind">{KIND_WORDS[current.kind]}</div>
              <div className="lesson-step__title">{current.title}</div>
              <p className="lesson-step__text">
                <Prose text={current.kind === 'read' ? current.body : current.prompt} />
              </p>

              {current.kind === 'read' && current.explainer != null && learn != null && (
                <button type="button" className="lesson-step__link" onClick={() => learn.openExplainer(current.explainer!)}>
                  Read more
                </button>
              )}
              {current.kind === 'click' && check.state === 'waiting' && <p className="lesson-step__status">Pick it on the canvas.</p>}
              {current.kind === 'trace' && check.state !== 'passed' && (
                <button type="button" className="lesson-step__act" onClick={askTrace}>
                  Trace it
                </button>
              )}
              {current.kind === 'trace' && traceError !== '' && <p className="lesson-step__status lesson-step__status--wrong">{traceError}</p>}
              {current.kind === 'change' && check.state === 'waiting' && (
                <p className="lesson-step__status">{engine.failed ? 'Checks could not run, so this step cannot be checked.' : 'Watching Checks…'}</p>
              )}
              {(check.state === 'wrong' || check.state === 'broken') && (
                <p className="lesson-step__status lesson-step__status--wrong" role="status">
                  {current.kind === 'click' && check.state === 'wrong' ? `Not that one. ${check.detail}` : check.detail}
                </p>
              )}
              {check.state === 'passed' && current.kind !== 'read' && (
                <p className="lesson-step__after" role="status">
                  <span className="lesson-step__tick" aria-hidden="true">
                    ✓
                  </span>{' '}
                  <Prose text={current.after} />
                </p>
              )}
              <div className="lesson-step__foot">
                {step > 0 && (
                  <button type="button" className="lesson-step__back" onClick={() => onAdvance(step - 1)}>
                    Back
                  </button>
                )}
                <button type="button" className="lesson-step__next" disabled={check.state !== 'passed'} onClick={() => onAdvance(step + 1)}>
                  {step + 1 === lesson.steps.length ? 'Finish' : 'Next'}
                </button>
              </div>
            </div>
          )}

          <button type="button" className="lesson-step__link lesson-panel__sources-toggle" aria-expanded={showSources} onClick={() => setShowSources(!showSources)}>
            Sources
          </button>
          {showSources && (
            <ul className="lesson-panel__sources">
              {lesson.sources.map((s) => {
                const url = safeUrl(s.url);
                return (
                  <li key={s.url + s.claim}>
                    {url != null ? (
                      <a href={url.href} target="_blank" rel="noreferrer noopener">
                        {s.cite}
                      </a>
                    ) : (
                      s.cite
                    )}
                    , read {s.read_on}. <span className="lesson-panel__claim">{s.claim}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

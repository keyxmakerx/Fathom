// The lesson builder (ADR-0066 §2, frame b1): a lesson written on the person's own design, one step at a time, using
// the canvas selection for answers and trace ends, a trace run now for what a trace step should show, and the Checks
// rules for a change step. Publishing makes a frozen copy of the design for learners; this design is never theirs.
import { useEffect, useMemo, useState } from 'react';

import {
  addLessonStep,
  createLesson,
  listLessons,
  moveLessonStep,
  removeLessonStep,
  setLessonText,
  stepProblem,
  TYPED_AS_WRITTEN,
  updateLessonStep,
  type DesignLesson,
  type DesignLessonStep,
  type LessonStepInput,
  type LessonStepKind,
} from '../../document/lessons';
import type { Document } from '../../document/model';
import { parseNodeId } from '../../document/model';
import type { TraceResult } from '../../engine/engine';
import { parseFlow } from '../trace/traceModel';
import { deviceByHostname, KIND_WORDS, nameOf, selected } from './lessonModel';
import { bootLessonMirror, useLessonChecks, type BootMirror } from './useLessonChecks';
import './lessons.css';

const ruleFiles = import.meta.glob('../../../../corpus/rules/*/rule.yaml', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export interface RuleChoice {
  id: string;
  title: string;
}

/** Every Checks rule Fathom ships, by id and title, read from the rule files. */
export function ruleChoices(): RuleChoice[] {
  return Object.values(ruleFiles)
    .map((yaml) => {
      const id = /^id:\s*(\S+)/m.exec(yaml)?.[1] ?? '';
      const title = /^title:\s*"?(.*?)"?\s*$/m.exec(yaml)?.[1] ?? id;
      return { id, title };
    })
    .filter((r) => r.id !== '')
    .sort((a, b) => a.title.localeCompare(b.title));
}

export interface LessonBuilderProps {
  doc: Document | null;
  selectedId: string | null;
  canDraw: boolean;
  /** Applies a change to the design, as any other edit does. Returns a refusal to show, if any. */
  apply: (next: Document) => string | void;
  /** Publishes a frozen copy for learners; resolves with the copy's name. */
  onPublish: (lessonId: string) => Promise<string>;
  onClose: () => void;
  boot?: BootMirror;
  side?: 'left' | 'right';
}

const BLANK: Record<LessonStepKind, LessonStepInput> = {
  read: { kind: 'read', title: '', body: '' },
  click: { kind: 'click', title: '', body: '', answer: '', hint: '', after: '' },
  trace: { kind: 'trace', title: '', body: '', traceFrom: '', traceTo: '', flow: '', after: '' },
  change: { kind: 'change', title: '', body: '', expectRule: '', after: '' },
};

function inputOf(s: DesignLessonStep): LessonStepInput {
  return {
    ...s,
    expectTrace: s.expectTrace === '' ? undefined : s.expectTrace,
    expectNow: s.expectNow === '' ? undefined : s.expectNow,
  };
}

/** The expectation a trace run now supports: where it stops, which devices it crosses, the first policy it matches. */
export function recordTrace(
  doc: Document,
  result: TraceResult,
  ends: readonly string[] = [],
): Pick<LessonStepInput, 'expectTrace' | 'expectCrosses' | 'expectStop' | 'expectFirstMatch'> {
  // The two ends are not crossings; a port end counts as its device.
  const endDevices = new Set(ends.map((e) => { const s = selected(doc, e); return s != null && 'device' in s ? s.device : e; }));
  const titles = result.hops.filter((h) => h.kind === 'device' || h.kind === 'switch').map((h) => h.title);
  const ids = titles.map((t) => deviceByHostname(doc, t)).filter((id): id is string => id != null && !endDevices.has(id));
  const first = result.hops.flatMap((h) => h.policies).find((p) => p.state === 'matches');
  if (result.stopped !== '') {
    const last = result.hops.filter((h) => h.kind === 'device' || h.kind === 'switch' || h.kind === 'end').at(-1);
    const stop = last != null ? deviceByHostname(doc, last.title) : null;
    return { expectTrace: 'stops', expectStop: stop ?? '', expectFirstMatch: first?.name ?? '' };
  }
  return { expectTrace: 'reaches', expectCrosses: ids, expectFirstMatch: first?.name ?? '' };
}

function StepEditor({
  doc,
  draft,
  onDraft,
  selectedId,
  engine,
  rules,
}: {
  doc: Document;
  draft: LessonStepInput;
  onDraft: (d: LessonStepInput) => void;
  selectedId: string | null;
  engine: ReturnType<typeof useLessonChecks>;
  rules: RuleChoice[];
}) {
  const [traceNote, setTraceNote] = useState('');
  const set = (patch: Partial<LessonStepInput>) => onDraft({ ...draft, ...patch });
  const picked = selectedId != null ? selected(doc, selectedId) : null;
  const pickedId = picked == null ? null : 'device' in picked ? picked.device : picked.cable;
  // A trace may start at a port; anything else on a device is the device.
  const pickedEnd = selectedId != null && parseNodeId(selectedId).kind === 'PhysicalPort' ? selectedId : picked != null && 'device' in picked ? picked.device : null;
  const firing = new Set((engine.checks?.findings ?? []).map((f) => f.rule));

  async function recordNow() {
    if (!draft.traceFrom || !draft.traceTo) return;
    const flow = parseFlow(draft.flow ?? '');
    try {
      const result = await engine.trace(draft.traceFrom, draft.traceTo, flow != null && flow !== 'none' ? flow : undefined);
      const got = recordTrace(doc, result, [draft.traceFrom, draft.traceTo]);
      set(got);
      setTraceNote(result.stopped !== '' ? `It stops: ${result.stopped}` : 'It reaches the far end.');
    } catch (e) {
      setTraceNote(e instanceof Error ? e.message : 'The trace could not run.');
    }
  }

  const field = (label: string, value: string | undefined, on: (v: string) => void, long = false) => (
    <label className="lesson-build__field">
      <span>{label}</span>
      {long ? <textarea rows={3} value={value ?? ''} onChange={(e) => on(e.target.value)} /> : <input value={value ?? ''} onChange={(e) => on(e.target.value)} />}
    </label>
  );
  const pick = (label: string, value: string | undefined, on: (v: string) => void, from: string | null, what: string) => (
    <div className="lesson-build__pick">
      <span>{label}</span>
      <span className="lesson-build__picked">{value ? nameOf(doc, value) || 'something not named' : 'nothing yet'}</span>
      <button type="button" disabled={from == null} title={from == null ? `Select ${what} on the canvas first` : undefined} onClick={() => from != null && on(from)}>
        Use the selection
      </button>
    </div>
  );

  return (
    <div className="lesson-step lesson-build__editor" data-testid="lesson-build-editor">
      <div className="lesson-step__kind">{KIND_WORDS[draft.kind]}</div>
      {field('Title', draft.title, (v) => set({ title: v }))}
      {field(draft.kind === 'read' ? 'What to read' : 'What to ask', draft.body, (v) => set({ body: v }), true)}
      {draft.kind === 'click' && (
        <>
          {pick('Answer', draft.answer, (v) => set({ answer: v }), pickedId, 'a device or a cable')}
          {field('Hint after a wrong pick', draft.hint, (v) => set({ hint: v }))}
        </>
      )}
      {draft.kind === 'trace' && (
        <>
          {pick('From', draft.traceFrom, (v) => set({ traceFrom: v, expectTrace: undefined }), pickedEnd, 'a device or a port')}
          {pick('To', draft.traceTo, (v) => set({ traceTo: v, expectTrace: undefined }), picked != null && 'device' in picked ? picked.device : null, 'a device')}
          {field('Flow (optional, e.g. TCP 554)', draft.flow, (v) => set({ flow: v, expectTrace: undefined }))}
          <button type="button" className="lesson-step__act" disabled={!draft.traceFrom || !draft.traceTo} onClick={() => void recordNow()}>
            Record what it shows now
          </button>
          {traceNote !== '' && <p className="lesson-step__status">{traceNote}</p>}
          {draft.expectTrace != null && (
            <fieldset className="lesson-build__choice">
              <legend>The learner should see</legend>
              <label>
                <input type="radio" checked={draft.expectTrace === 'reaches'} onChange={() => set({ expectTrace: 'reaches' })} /> it reaches
                {draft.expectCrosses && draft.expectCrosses.length > 0 ? `, crossing ${draft.expectCrosses.map((c) => nameOf(doc, c)).join(', ')}` : ''}
              </label>
              <label>
                <input type="radio" checked={draft.expectTrace === 'stops'} onChange={() => set({ expectTrace: 'stops' })} /> it stops
                {draft.expectStop ? ` at ${nameOf(doc, draft.expectStop)}` : ''}
              </label>
              <label>
                <input type="radio" checked={draft.expectTrace === 'first_match'} onChange={() => set({ expectTrace: 'first_match' })} /> the first policy that matches is
                <input
                  className="lesson-build__inline"
                  aria-label="Policy name"
                  value={draft.expectFirstMatch ?? ''}
                  onChange={(e) => set({ expectTrace: 'first_match', expectFirstMatch: e.target.value })}
                />
              </label>
            </fieldset>
          )}
        </>
      )}
      {draft.kind === 'change' && (
        <>
          <label className="lesson-build__field">
            <span>Check to watch</span>
            <select
              value={draft.expectRule ?? ''}
              onChange={(e) => set({ expectRule: e.target.value, expectNow: firing.has(e.target.value) ? 'clears' : 'fires' })}
            >
              <option value="">Choose a check…</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {firing.has(r.id) ? ' (finds something now)' : ''}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="lesson-build__choice">
            <legend>Once the learner has made the change, it should</legend>
            <label>
              <input type="radio" checked={draft.expectNow === 'fires'} onChange={() => set({ expectNow: 'fires' })} /> find something
            </label>
            <label>
              <input type="radio" checked={draft.expectNow === 'clears'} onChange={() => set({ expectNow: 'clears' })} /> find nothing
            </label>
          </fieldset>
        </>
      )}
      {draft.kind !== 'read' && field('Said once it passes: why it is so', draft.after, (v) => set({ after: v }), true)}
    </div>
  );
}

export function LessonBuilder({ doc, selectedId, canDraw, apply, onPublish, onClose, boot = bootLessonMirror, side = 'left' }: LessonBuilderProps) {
  const drafts = useMemo(() => (doc == null ? [] : listLessons(doc).filter((l) => l.publishedAt === '')), [doc]);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const lesson: DesignLesson | null = drafts.find((l) => l.id === lessonId) ?? drafts[0] ?? null;
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [editing, setEditing] = useState<{ stepId: string | null; draft: LessonStepInput } | null>(null);
  const [error, setError] = useState('');
  const [published, setPublished] = useState('');
  const [busy, setBusy] = useState(false);
  const [folded, setFolded] = useState(false);
  const rules = useMemo(ruleChoices, []);
  const engine = useLessonChecks(doc, editing?.draft.kind === 'change', boot);

  useEffect(() => {
    if (lesson != null) {
      setTitle(lesson.title);
      setSummary(lesson.summary);
    }
    // Only when another lesson is shown; typing keeps its own text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.id]);

  function run(change: (d: Document) => Document) {
    if (doc == null) return false;
    try {
      const refused = apply(change(doc));
      if (typeof refused === 'string') {
        setError(refused);
        return false;
      }
      setError('');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That was refused.');
      return false;
    }
  }

  function start() {
    let made: string | null = null;
    if (
      run((d) => {
        const r = createLesson(d, { title, summary, gate: TYPED_AS_WRITTEN });
        made = r.id;
        return r.doc;
      })
    )
      setLessonId(made);
  }

  function saveStep() {
    if (editing == null || lesson == null) return;
    const ok = run((d) =>
      editing.stepId == null ? addLessonStep(d, lesson.id, editing.draft, { gate: TYPED_AS_WRITTEN }).doc : updateLessonStep(d, editing.stepId, editing.draft, { gate: TYPED_AS_WRITTEN }),
    );
    if (ok) setEditing(null);
  }

  async function publish() {
    if (lesson == null) return;
    setBusy(true);
    setError('');
    try {
      setPublished(await onPublish(lesson.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publishing was refused.');
    } finally {
      setBusy(false);
    }
  }

  const unfinished = lesson?.steps.findIndex((s) => stepProblem(s) !== null) ?? -1;

  return (
    <aside className={`lesson-panel lesson-panel--${side} lesson-build${folded ? ' lesson-panel--folded' : ''}`} aria-label="Build a lesson" data-testid="lesson-builder">
      <div className="lesson-panel__head">
        <div className="lesson-panel__kicker">Build a lesson</div>
        <span>
          <button type="button" className="lesson-panel__fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
            {folded ? 'Show' : 'Hide'}
          </button>{' '}
          <button type="button" className="lesson-panel__fold" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      {!folded && doc != null && (
        <>
          {!canDraw && <p className="lesson-step__status">You can read this design but not change it, so a lesson cannot be written here.</p>}
          {canDraw && lesson == null && (
            <div className="lesson-step">
              <p className="lesson-step__text">
                A lesson is written on this design, step by step. Publishing makes a copy for learners, so what they try never touches this design.
              </p>
              <label className="lesson-build__field">
                <span>Title</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="lesson-build__field">
                <span>What it teaches (optional)</span>
                <input value={summary} onChange={(e) => setSummary(e.target.value)} />
              </label>
              <div className="lesson-step__foot">
                <button type="button" className="lesson-step__next" disabled={title.trim() === ''} onClick={start}>
                  Start writing
                </button>
              </div>
            </div>
          )}
          {canDraw && lesson != null && (
            <>
              {drafts.length > 1 && (
                <label className="lesson-build__field">
                  <span>Lesson</span>
                  <select value={lesson.id} onChange={(e) => setLessonId(e.target.value)}>
                    {drafts.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="lesson-build__field">
                <span>Title</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => title.trim() !== '' && title !== lesson.title && run((d) => setLessonText(d, lesson.id, { title }, { gate: TYPED_AS_WRITTEN }))}
                />
              </label>
              <label className="lesson-build__field">
                <span>What it teaches</span>
                <input
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  onBlur={() => summary !== lesson.summary && run((d) => setLessonText(d, lesson.id, { summary }, { gate: TYPED_AS_WRITTEN }))}
                />
              </label>

              <ol className="lesson-build__steps" aria-label="Steps">
                {lesson.steps.map((s, i) => {
                  const problem = stepProblem(s);
                  return (
                    <li key={s.id} className="lesson-build__step" data-testid="lesson-build-step">
                      <div>
                        <span className="lesson-step__kind">{KIND_WORDS[s.kind]}</span> {s.title}
                        {problem != null && <div className="lesson-step__status lesson-step__status--wrong">{problem}</div>}
                      </div>
                      <div className="lesson-build__step-acts">
                        <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => run((d) => moveLessonStep(d, s.id, -1))}>
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move step ${i + 1} down`}
                          disabled={i === lesson.steps.length - 1}
                          onClick={() => run((d) => moveLessonStep(d, s.id, 1))}
                        >
                          ↓
                        </button>
                        <button type="button" onClick={() => setEditing({ stepId: s.id, draft: inputOf(s) })}>
                          Edit
                        </button>
                        <button type="button" onClick={() => run((d) => removeLessonStep(d, s.id))}>
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {editing == null ? (
                <div className="lesson-build__add">
                  <span className="lesson-panel__kicker">Add a step</span>
                  {(['read', 'click', 'trace', 'change'] as const).map((k) => (
                    <button key={k} type="button" onClick={() => setEditing({ stepId: null, draft: { ...BLANK[k] } })}>
                      {KIND_WORDS[k]}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <StepEditor doc={doc} draft={editing.draft} onDraft={(draft) => setEditing({ ...editing, draft })} selectedId={selectedId} engine={engine} rules={rules} />
                  <p className="lesson-step__status">{stepProblem(editing.draft) ?? 'Ready.'}</p>
                  <div className="lesson-step__foot">
                    <button type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button type="button" className="lesson-step__next" disabled={editing.draft.title.trim() === ''} onClick={saveStep}>
                      {editing.stepId == null ? 'Add the step' : 'Save the step'}
                    </button>
                  </div>
                </>
              )}

              {editing == null && (
                <div className="lesson-build__publish">
                  <button
                    type="button"
                    className="lesson-step__next"
                    disabled={busy || lesson.steps.length === 0 || unfinished >= 0}
                    title={unfinished >= 0 ? `Step ${unfinished + 1} is not finished` : undefined}
                    onClick={() => void publish()}
                  >
                    {busy ? 'Publishing…' : 'Publish a copy for learners'}
                  </button>
                  {published !== '' && (
                    <p className="lesson-step__after" role="status">
                      Published as “{published}”. Anyone who can open this folder starts it from Home. Publishing again makes a new copy.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {error !== '' && (
            <p className="lesson-step__status lesson-step__status--wrong" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </aside>
  );
}

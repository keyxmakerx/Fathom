// Home's list of guided lessons (round 10, lessons B): each with its sample network and where the learner got to.
import { sample } from '../home/sampleNetwork';
import type { Lesson, LessonRun, WrittenLesson } from './lessonModel';
import './lessons.css';

export interface LessonsListProps {
  lessons: readonly Lesson[];
  runs: readonly LessonRun[];
  /** Designs this person may open, by id: a run whose copy is gone starts again. */
  openable: ReadonlySet<string>;
  busyId: string | null;
  error: string | null;
  disabled: boolean;
  onStart: (lesson: Lesson) => void;
  onContinue: (run: LessonRun) => void;
  /** Lessons people here wrote and published (ADR-0066 §2). */
  written?: readonly WrittenLesson[];
  onStartWritten?: (lesson: WrittenLesson) => void;
}

const networkName = (l: Lesson): string => sample(l.sample).name.replace(/^Sample /, '').replace(/^./, (c) => c.toUpperCase());

export function LessonsList({ lessons, runs, openable, busyId, error, disabled, onStart, onContinue, written = [], onStartWritten }: LessonsListProps) {
  return (
    <section className="home__section lessons-list" aria-labelledby="lessons-list-title">
      <div className="home__label" id="lessons-list-title">
        Lessons
      </div>
      <table className="lessons-list__table">
        <thead>
          <tr>
            <th scope="col">Lesson</th>
            <th scope="col">Network</th>
            <th scope="col">Steps</th>
            <th scope="col">
              <span className="visually-hidden">Progress</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lessons.map((l) => {
            const found = runs.find((r) => r.lessonId === l.id);
            const run = found != null && openable.has(found.designId) ? found : null;
            const done = run != null && run.step >= l.steps.length;
            const busy = busyId === l.id;
            return (
              <tr key={l.id} className={run != null && !done ? 'lessons-list__row lessons-list__row--on' : 'lessons-list__row'} data-testid={`lesson-${l.id}`}>
                <td>
                  <div className="lessons-list__title">{l.title}</div>
                  <div className="lessons-list__summary">{l.summary}</div>
                </td>
                <td>{networkName(l)}</td>
                <td className="m">{l.steps.length}</td>
                <td className="lessons-list__act">
                  {done && <span className="lessons-list__done">done</span>}
                  {run != null && !done ? (
                    <button type="button" className="home__btn btn-small lessons-list__continue" disabled={disabled} onClick={() => onContinue(run)}>
                      Continue · {run.step + 1} of {l.steps.length}
                    </button>
                  ) : (
                    <button type="button" className="home__btn btn-small" disabled={disabled || busyId != null} onClick={() => onStart(l)}>
                      {busy ? 'Opening…' : done ? 'Again' : 'Start'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {written.map((w) => {
            const found = runs.find((r) => r.lessonId === w.lessonId);
            const run = found != null && openable.has(found.designId) ? found : null;
            const of = run?.of ?? 0;
            const done = run != null && run.step >= of;
            return (
              <tr key={w.lessonId} className={run != null && !done ? 'lessons-list__row lessons-list__row--on' : 'lessons-list__row'} data-testid={`lesson-${w.designId}`}>
                <td>
                  <div className="lessons-list__title">{w.title}</div>
                </td>
                <td>Written here</td>
                <td className="m">{run != null ? of : ''}</td>
                <td className="lessons-list__act">
                  {done && <span className="lessons-list__done">done</span>}
                  {run != null && !done ? (
                    <button type="button" className="home__btn btn-small lessons-list__continue" disabled={disabled} onClick={() => onContinue(run)}>
                      Continue · {run.step + 1} of {of}
                    </button>
                  ) : (
                    <button type="button" className="home__btn btn-small" disabled={disabled || busyId != null} onClick={() => onStartWritten?.(w)}>
                      {busyId === w.lessonId ? 'Opening…' : done ? 'Again' : 'Start'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="home__error">{error}</p>}
      <p className="home__muted">
        Each lesson opens its own copy of a sample network, or of the design it was written on, so nothing you try touches your real designs.
        To write one, open a design and choose Build a lesson from the search bar.
      </p>
    </section>
  );
}

// r15-start (mockup r15-f4.png): the "New here?" sample card for Home's centre, and the five first steps for its
// right panel. The steps tick themselves (firstSteps.ts); hidden, they live under Help.
import { FIRST_STEPS, type StepId } from './firstSteps';

export interface SampleCardProps {
  summary: string;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onOpen: () => void;
}

export function SampleCard({ summary, busy, disabled, error, onOpen }: SampleCardProps) {
  return (
    <section className="home-sample" aria-labelledby="home-sample-title">
      <div className="home-sample__text">
        <div className="home__label home-sample__kicker">New here?</div>
        <h2 id="home-sample-title" className="home-sample__title">
          Open the sample home lab
        </h2>
        <p className="home-sample__body">{summary} Poke anything; your own designs aren't touched.</p>
        <button type="button" className="home__btn home-sample__open" onClick={onOpen} disabled={busy || disabled}>
          {busy ? 'Opening…' : 'Open sample'}
        </button>
        {error && <p className="home__error">{error}</p>}
      </div>
      <svg className="home-sample__picture" viewBox="0 0 220 150" aria-hidden="true">
        <rect x="80" y="4" width="60" height="26" />
        <path d="M110 30 V122 M35 52 H185 M35 52 V68 M185 52 V68" />
        <rect x="5" y="68" width="60" height="26" />
        <rect x="155" y="68" width="60" height="26" />
        <rect x="80" y="122" width="60" height="26" />
      </svg>
    </section>
  );
}

export interface GettingStartedProps {
  done: readonly StepId[];
  onHide: () => void;
}

export function GettingStarted({ done, onHide }: GettingStartedProps) {
  const count = FIRST_STEPS.filter((s) => done.includes(s.id)).length;
  return (
    <section className="first-steps" aria-label="Getting started">
      <div className="home__label">
        Getting started · {count} of {FIRST_STEPS.length}
      </div>
      <div
        className="first-steps__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={FIRST_STEPS.length}
        aria-valuenow={count}
        aria-label={`${count} of ${FIRST_STEPS.length} first steps done`}
      >
        <span style={{ width: `${(100 * count) / FIRST_STEPS.length}%` }} />
      </div>
      <ol className="first-steps__list">
        {FIRST_STEPS.map((step, i) => {
          const ticked = done.includes(step.id);
          return (
            <li key={step.id} className={ticked ? 'first-steps__step first-steps__step--done' : 'first-steps__step'}>
              <span className="first-steps__n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="first-steps__label">
                {step.label}
                {ticked && <span className="first-steps__sr"> (done)</span>}
              </span>
              {step.note && <span className="first-steps__note">{step.note}</span>}
            </li>
          );
        })}
      </ol>
      <p className="first-steps__foot">
        Hide it any time; it lives under Help after that.{' '}
        <button type="button" className="first-steps__hide" onClick={onHide}>
          Hide
        </button>
      </p>
    </section>
  );
}

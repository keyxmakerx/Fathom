// r15-start (mockup r15-f4.png): the "New here?" sample card for Home's centre, and the five first steps for its
// right panel. The steps tick themselves (firstSteps.ts); hidden, they live under Help. A step not yet done says
// how when pressed, and the next one says it without being asked.
import { useState } from 'react';

import { FIRST_STEPS, howTo, nextStep, type StartsWith, type StepId } from './firstSteps';

export interface SampleCardProps {
  summary: string;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onOpen: () => void;
  /** The practice lab (card nu-why A): the same network with mistakes planted for Checks to find. */
  practice?: { summary: string; onOpen: () => void };
}

export function SampleCard({ summary, busy, disabled, error, onOpen, practice }: SampleCardProps) {
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
        {practice && (
          <div className="home-sample__practice">
            <p className="home-sample__body">
              <strong>Practice home lab.</strong> {practice.summary}
            </p>
            <button type="button" className="home__btn btn-small" onClick={practice.onOpen} disabled={busy || disabled}>
              Open practice lab
            </button>
          </div>
        )}
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
  /** Steps ticked since the list was last drawn: each ticks itself, once. */
  fresh?: readonly StepId[];
  /** Which button on this Home starts a design of one's own; the first step names it. */
  startsWith?: StartsWith;
  onHide: () => void;
}

export function GettingStarted({ done, fresh = [], startsWith = 'new-design', onHide }: GettingStartedProps) {
  const count = FIRST_STEPS.filter((s) => done.includes(s.id)).length;
  const next = nextStep(done);
  // One step says how at a time: the next one to begin with, then whichever the person presses.
  const [open, setOpen] = useState<StepId | null>(next);
  const before = count - FIRST_STEPS.filter((s) => fresh.includes(s.id)).length;
  const share = (n: number) => `${(100 * n) / FIRST_STEPS.length}%`;
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
        <span className={before < count ? 'first-steps__fill first-steps__fill--grow' : 'first-steps__fill'} style={{ width: share(count), ['--from' as string]: share(before) }} />
      </div>
      <ol className="first-steps__list">
        {FIRST_STEPS.map((step, i) => {
          const ticked = done.includes(step.id);
          const turn = fresh.indexOf(step.id);
          const shown = !ticked && open === step.id;
          const words = (
            <>
              <span className="first-steps__n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="first-steps__label">
                <span className="first-steps__text">{step.label}</span>
                {ticked && <span className="first-steps__sr"> (done)</span>}
              </span>
              {step.note && <span className="first-steps__note">{step.note}</span>}
            </>
          );
          return (
            <li
              key={step.id}
              className={['first-steps__step', ticked ? 'first-steps__step--done' : '', turn >= 0 ? 'first-steps__step--fresh' : '', step.id === next ? 'first-steps__step--next' : ''].filter(Boolean).join(' ')}
              style={turn >= 0 ? { ['--turn' as string]: turn } : undefined}
            >
              {ticked ? (
                <div className="first-steps__row">{words}</div>
              ) : (
                <button type="button" className="first-steps__row first-steps__row--ask" aria-expanded={shown} onClick={() => setOpen(shown ? null : step.id)}>
                  {words}
                </button>
              )}
              {!ticked && (
                <div className={shown ? 'first-steps__how first-steps__how--open' : 'first-steps__how'} aria-hidden={!shown}>
                  <div className="first-steps__how-clip">
                    <p>{howTo(step, startsWith)}</p>
                  </div>
                </div>
              )}
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

// ADR-0069 (card nu-firstrun A, mockup r30-firstrun-no-org.png): Home for the person who set the server up and belongs
// to no organisation. They look after the server; organisations look after their own designs. So the one thing offered
// is a practice space of their own, and creating an organisation is a quiet line pointing at Admin, never a step.
import type { ReactNode } from 'react';

export interface PracticeOffer {
  /** Makes the practice space and answers its organisation id, or null when it could not (the error says why). */
  onMake: () => Promise<string | null>;
  busy: boolean;
  error: string | null;
  /** Admin's verification-code prompt, when making the space is waiting on it. */
  codePrompt: ReactNode;
  /** The practice space just made, to open onto the home lab; held by the caller because making it signs in to
   * Admin, and Home may be drawn afresh meanwhile. */
  justMade: string | null;
  onOpened: () => void;
}

export function PracticeWelcome({ address, offer, onOpen }: { address: string; offer: PracticeOffer; onOpen: () => void }) {
  return (
    <section className="home__section practice-welcome" data-testid="practice-welcome">
      <p className="home__muted practice-welcome__lead">Welcome, {address}. You set this server up.</p>
      <div className="home-sample practice-welcome__card">
        <div className="home-sample__text">
          <div className="home__label home-sample__kicker">Look around first</div>
          <h2 className="home-sample__title">Open the practice home lab</h2>
          <p className="home-sample__body">
            A router, two switches, Wi-Fi, a NAS and two cameras, already cabled. It lives in your own practice space: no
            organisation to run, nothing to manage, and only you can see it. Break anything you like.
          </p>
          <button type="button" className="home__btn home-sample__open" onClick={onOpen} disabled={offer.busy}>
            {offer.busy ? 'Making your practice space…' : 'Open practice lab'}
          </button>
          {offer.codePrompt}
          {offer.error && <p className="home__error">{offer.error}</p>}
        </div>
      </div>
      <div className="practice-welcome__later">
        <div className="home__label">When people are ready to draw for real</div>
        <p className="home__muted">
          Create an organisation under Admin, then Organisations, and hand its claim to whoever will run it. That can be
          you, or a colleague. Nothing here asks you to do it.
        </p>
      </div>
    </section>
  );
}

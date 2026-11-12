// ADR-0069 (card nu-firstrun A, mockup r30-firstrun-no-org.png): Home for the person who set the server up and belongs
// to no organisation. They look after the server; organisations look after their own designs. So the one thing offered
// is a practice space of their own, and creating an organisation is a quiet line pointing at Admin, never a step.
import { useState, type FormEvent, type ReactNode } from 'react';

import {
  OWN_NETWORK_DEFAULT_NAME,
  OWN_NETWORK_NAME_MAX,
  ownNetworkName,
  prepareOwnNetwork,
  type PreparedOwnNetwork,
} from './ownNetwork';
import { downloadRecoveryKey } from '../claim/ClaimOrganisation';

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

/** Sign-off r123: an organisation of the person's own, with a site and an empty design, offered beside the practice
 * lab and never asked for. */
export interface OwnNetworkOffer {
  /** Makes the network from the saved key and opens its empty design; answers false when it could not (the error says
   * why, and pressing again carries on from where it stopped). */
  onMake: (name: string, prepared: PreparedOwnNetwork) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  /** Admin's verification-code prompt, when making the network is waiting on it. */
  codePrompt: ReactNode;
}

export function PracticeWelcome({
  address,
  offer,
  onOpen,
  own,
}: {
  address: string;
  offer: PracticeOffer;
  onOpen: () => void;
  own?: OwnNetworkOffer;
}) {
  return (
    <section className="home__section practice-welcome" data-testid="practice-welcome">
      <p className="home__muted practice-welcome__lead">Welcome, {address}. You set this server up.</p>
      <div className={own ? 'practice-welcome__pair' : undefined}>
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
      {own && <OwnNetworkCard offer={own} />}
      </div>
      <div className="practice-welcome__later">
        {own ? (
          <>
            <div className="home__label">Running this for a team?</div>
            <p className="home__muted">
              Make each organisation under Admin, then Organisations, and hand its claim to whoever will run it. Nothing
              here asks you to.
            </p>
          </>
        ) : (
          <>
            <div className="home__label">When people are ready to draw for real</div>
            <p className="home__muted">
              Create an organisation under Admin, then Organisations, and hand its claim to whoever will run it. That can
              be you, or a colleague. Nothing here asks you to do it.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Two moments in one card: the name, then the recovery key, made in this browser and sent nowhere until it is saved
 * (ADR-0057 decision 5, kept). */
export function OwnNetworkCard({ offer }: { offer: OwnNetworkOffer }) {
  const [name, setName] = useState(OWN_NETWORK_DEFAULT_NAME);
  const [prepared, setPrepared] = useState<PreparedOwnNetwork | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sendable = ownNetworkName(name);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendable === null) {
      setProblem(`Give it a name, up to ${OWN_NETWORK_NAME_MAX} characters.`);
      return;
    }
    setProblem(null);
    setPreparing(true);
    try {
      setPrepared(await prepareOwnNetwork());
    } catch {
      setProblem('This browser could not make a key. Reload the page and try again.');
    } finally {
      setPreparing(false);
    }
  }

  if (prepared === null || sendable === null) {
    return (
      <form className="home-sample practice-welcome__card practice-welcome__card--own" data-testid="own-network" onSubmit={(e) => void start(e)}>
        <div className="home-sample__text">
          <div className="home__label home-sample__kicker">Draw your own</div>
          <h2 className="home-sample__title">Start your own network</h2>
          <p className="home-sample__body">
            For a server only you use. One press makes an organisation of your own with one site in it, and opens an
            empty design to draw in. You can invite people to it later.
          </p>
          <label className="home__label practice-welcome__field-label" htmlFor="own-network-name">
            Name
          </label>
          <input
            id="own-network-name"
            className="home__scope-form-input practice-welcome__field"
            value={name}
            maxLength={OWN_NETWORK_NAME_MAX}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="home__btn home-sample__open practice-welcome__go" disabled={preparing}>
            {preparing ? 'Making its key…' : 'Start drawing'}
          </button>
          {problem && <p className="home__error">{problem}</p>}
        </div>
      </form>
    );
  }

  return (
    <div className="home-sample practice-welcome__card practice-welcome__card--own" data-testid="own-network">
      <div className="home-sample__text">
        <div className="home__label home-sample__kicker">Draw your own · one thing first</div>
        <h2 className="home-sample__title">Save {sendable}&apos;s recovery key</h2>
        <p className="home-sample__body">
          Fathom can&apos;t use it for anything yet; a future recovery will need it. It can&apos;t be shown again.
          Nothing is made until you press Start drawing.
        </p>
        <p className="signin__mono signin__mono--wrap practice-welcome__key" data-testid="own-network-recovery-key">
          {prepared.recoveryKeyText}
        </p>
        <div className="claim__row">
          <button type="button" className="signin__switch" onClick={() => downloadRecoveryKey(prepared.recoveryKeyText)} disabled={offer.busy}>
            Download
          </button>
          <button type="button" className="signin__switch" onClick={() => window.print()} disabled={offer.busy}>
            Print
          </button>
        </div>
        <button
          type="button"
          role="checkbox"
          aria-checked={saved}
          className={saved ? 'signin__toggle signin__toggle--on' : 'signin__toggle'}
          onClick={() => setSaved(!saved)}
          disabled={offer.busy}
        >
          <span className="signin__toggle-box" aria-hidden="true">
            {saved ? '✓' : ''}
          </span>
          <span>I have saved this.</span>
        </button>
        <button
          type="button"
          className="home__btn home-sample__open practice-welcome__go"
          disabled={!saved || offer.busy}
          onClick={() => void offer.onMake(sendable, prepared)}
        >
          {offer.busy ? `Making ${sendable}…` : 'Start drawing'}
        </button>
        {offer.codePrompt}
        {offer.error && <p className="home__error">{offer.error}</p>}
      </div>
    </div>
  );
}

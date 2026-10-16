import '../styles/enrol.css';

export interface InviteWhileSignedInProps {
  /** Who this browser is signed in as. */
  address: string;
  /** Put the link aside and carry on as this person. */
  onBack: () => void;
  /** Sign out, so the enrolment door can take the link. */
  onSignOutAndUse: () => void;
  busy?: boolean;
}

/**
 * What a signed-in person sees on opening someone else's `/invite#inv_…` link.
 *
 * An invitation is for the person it was made for, to set up their own
 * sign-in. Opened by somebody who is already signed in (the owner, trying the
 * link he had just sent to a colleague) it used to land on Home with no
 * explanation at all: "i got lost when i tried to accept her invite"
 * (owner, 2026-10-12). So this says what the link is, who this browser is
 * signed in as, and offers the two honest ways on. Signing out is the person's
 * choice, never done for them: the link may not be theirs.
 */
export function InviteWhileSignedIn({ address, onBack, onSignOutAndUse, busy }: InviteWhileSignedInProps) {
  return (
    <div className="enrol">
      <div className="enrol__card">
        <h1 className="enrol__title">This is an invitation link</h1>
        <p className="enrol__body">
          An invitation is for the person who was invited, to set up their own sign-in. You are signed in as{' '}
          <strong>{address}</strong>. If this link is meant for someone else, send it to them rather than opening it
          here.
        </p>
        <button type="button" className="enrol__submit" onClick={onBack} disabled={busy}>
          Back to Fathom
        </button>
        <button type="button" className="enrol__switch" onClick={onSignOutAndUse} disabled={busy}>
          Sign out and use it
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';

import { invitationAddress } from './invitationAddress';

// The address beside the token, on the board that minted it (ADR-0056
// decision 6). Written 2026-09-22.

export interface InvitationHandoverProps {
  /** The token as the board shows it, prefix and all. */
  token: string;
  /** `window.location.origin` at the call site, or `''` where there is no
   * window. */
  origin: string;
}

/**
 * What the operator actually hands over: the full address, with a copy
 * button, and one sentence about why the token is after the `#`.
 *
 * The bare token stays on the board beside this — some people paste a token
 * into the enrolment screen and some people follow a link, and an invitation
 * that has been read out over a telephone is still an invitation.
 */
export function InvitationHandover({ token, origin }: InvitationHandoverProps) {
  const [copied, setCopied] = useState(false);
  const address = invitationAddress(origin, token);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard is not an error state: the
      // address is on the screen and can be selected by hand.
      setCopied(false);
    }
  }

  return (
    <div className="console__handover">
      <div className="console__handover-label">Address to hand over</div>
      <code className="console__handover-address" data-testid="invitation-address">
        {address}
      </code>
      <button type="button" className="console__btn console__btn--quiet" onClick={copy}>
        {copied ? 'Copied.' : 'Copy the address'}
      </button>
      <p className="console__note">
        The token is after the <code>#</code>, so it stays in the browser: it is not sent with the request and does
        not reach a server log. Send this address the way you would send anything else that opens an account.
      </p>
    </div>
  );
}

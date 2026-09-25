import { useState, type FormEvent } from 'react';

import { formatRecoveryKey, randomIdSalt, redeemOrganisationClaim } from '../../api/claim';
import { MalformedTokenError, parseToken } from '../../api/enrolment';
import { ApiRefusal } from '../../api/errors';
import {
  exportPrivateScalar,
  exportPublicKeyRaw,
  generateExtractableKeyPair,
  getEnrolledKeyPair,
} from '../../crypto/keys';
import { toHex } from '../../crypto/bytes';
import '../../styles/signin.css';
import './claim.css';

export interface ClaimOrganisationProps {
  /** The signed-in steward's own address and account id. The claimed
   * organisation's founding steward is always this account. */
  accountAddress: string;
  accountId: string;
  /** Pre-filled and disabled when "Claim it now" (`App.tsx`) hands the claim
   * over already; both absent for Home's own "Claim an organisation". */
  initialToken?: Uint8Array;
  initialNoticeAddress?: string;
  /** Called once the claim is redeemed and "Continue" is pressed on the
   * recovery-key screen. */
  onDone: (organisationId: string) => void;
  onCancel: () => void;
}

/** A claim generated but not yet sent: the root keypair and its recovery
 * text, held only in this component's state until `onDone`. */
interface PreparedClaim {
  token: Uint8Array;
  noticeAddress: string;
  rootKeyPair: CryptoKeyPair;
  rootPubkey: Uint8Array;
  idSalt: Uint8Array;
  subjectPubkey: Uint8Array;
  recoveryKeyText: string;
}

type Stage =
  | { kind: 'form' }
  | { kind: 'generating' }
  | { kind: 'recovery'; claim: PreparedClaim };

/** ADR-0057 decision 5: shows the root keypair once as the recovery key,
 * and sends the claim only once "I have saved this" is confirmed. */
export function ClaimOrganisation({
  accountAddress,
  accountId,
  initialToken,
  initialNoticeAddress,
  onDone,
  onCancel,
}: ClaimOrganisationProps) {
  const [tokenText, setTokenText] = useState(initialToken ? toHex(initialToken) : '');
  const [noticeAddress, setNoticeAddress] = useState(initialNoticeAddress ?? '');
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [answerLost, setAnswerLost] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let token: Uint8Array;
    if (initialToken) {
      token = initialToken;
    } else {
      try {
        token = parseToken(tokenText).bytes;
      } catch (e) {
        setError(e instanceof MalformedTokenError ? e.message : 'That does not look like a token.');
        return;
      }
    }
    const address = noticeAddress.trim();
    if (address.length === 0) {
      setError("This deployment's notice address is needed too.");
      return;
    }

    setStage({ kind: 'generating' });
    try {
      const accountKeyPair = await getEnrolledKeyPair(accountAddress);
      if (!accountKeyPair) {
        throw new Error('This browser holds no key for this account. Sign in again and retry.');
      }
      const subjectPubkey = await exportPublicKeyRaw(accountKeyPair.publicKey);
      const rootKeyPair = await generateExtractableKeyPair();
      const rootPubkey = await exportPublicKeyRaw(rootKeyPair.publicKey);
      const idSalt = randomIdSalt();
      // Nothing has been sent yet -- the claim goes out only from Continue.
      const scalar = await exportPrivateScalar(rootKeyPair.privateKey);
      const recoveryKeyText = await formatRecoveryKey(scalar);
      setStage({
        kind: 'recovery',
        claim: { token, noticeAddress: address, rootKeyPair, rootPubkey, idSalt, subjectPubkey, recoveryKeyText },
      });
    } catch (e) {
      setError(describeClaimError(e));
      setStage({ kind: 'form' });
    }
  }

  /** A definite refusal returns to the form for a fresh key; a lost
   * answer does not, since the claim may have gone through. */
  async function confirmAndSend(claim: PreparedClaim) {
    setSending(true);
    setError(null);
    try {
      const organisationId = await redeemOrganisationClaim(
        claim.token,
        claim.noticeAddress,
        claim.rootKeyPair,
        claim.rootPubkey,
        claim.idSalt,
        accountId,
        claim.subjectPubkey,
      );
      onDone(organisationId);
    } catch (e) {
      const { message, lostAnswer } = describeSendFailure(e);
      setError(message);
      if (lostAnswer) {
        setAnswerLost(true);
      } else {
        setStage({ kind: 'form' });
        setSaved(false);
      }
    } finally {
      setSending(false);
    }
  }

  if (stage.kind === 'recovery') {
    return (
      <RecoveryKeyStage
        recoveryKeyText={stage.claim.recoveryKeyText}
        saved={saved}
        onSavedChange={setSaved}
        busy={sending}
        locked={answerLost}
        notice={error}
        onContinue={() => void confirmAndSend(stage.claim)}
      />
    );
  }

  const busy = stage.kind === 'generating';

  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">Fathom</h1>
        <p className="signin__subtitle">Claim an organisation, as {accountAddress}.</p>
        <form onSubmit={(e) => void submit(e)}>
          <div className="signin__field">
            <label className="signin__label" htmlFor="claim-token">
              Claim token
            </label>
            <input
              id="claim-token"
              className="signin__input signin__input--mono"
              value={tokenText}
              onChange={(e) => setTokenText(e.target.value)}
              disabled={Boolean(initialToken) || busy}
              autoComplete="off"
              placeholder="org_…"
              required
            />
          </div>
          <div className="signin__field">
            <label className="signin__label" htmlFor="claim-notice-address">
              Notice address
            </label>
            <input
              id="claim-notice-address"
              className="signin__input"
              value={noticeAddress}
              onChange={(e) => setNoticeAddress(e.target.value)}
              disabled={Boolean(initialNoticeAddress) || busy}
              autoComplete="off"
              required
            />
            <p className="signin__hint">The deployment's own notice address, from whoever handed you the token.</p>
          </div>
          {error && (
            <p className="signin__refusal" role="alert">
              {error}
            </p>
          )}
          <button className="signin__submit" type="submit" disabled={busy}>
            {busy ? 'Preparing…' : 'Claim'}
          </button>
          <button type="button" className="signin__switch" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}

export interface RecoveryKeyStageProps {
  recoveryKeyText: string;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  /** True while the claim is being sent -- disables the controls so a
   * second press cannot start a second send. */
  busy?: boolean;
  /** A message about the last send attempt, if any. */
  notice?: string | null;
  /** True once a lost answer means Continue must not be pressed again. */
  locked?: boolean;
  onContinue: () => void;
}

/** The recovery key, shown once, before the claim it belongs to is sent. */
export function RecoveryKeyStage({
  recoveryKeyText,
  saved,
  onSavedChange,
  busy = false,
  locked = false,
  notice = null,
  onContinue,
}: RecoveryKeyStageProps) {
  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">Fathom</h1>
        <h2 className="signin__heading">Save the organisation's recovery key</h2>
        <p className="signin__body">
          This is your organisation&apos;s root key. Fathom cannot use it for anything yet; a future recovery
          process will need it. Save it now: it cannot be shown again. The downloaded file is plain text, so store
          it somewhere as safe as you would store any other password.
        </p>
        <p className="signin__mono signin__mono--wrap" data-testid="recovery-key">
          {recoveryKeyText}
        </p>
        {notice && (
          <p className="signin__refusal" role="alert">
            {notice}
          </p>
        )}
        <div className="claim__row">
          <button
            type="button"
            className="signin__switch"
            onClick={() => downloadRecoveryKey(recoveryKeyText)}
            disabled={busy}
          >
            Download
          </button>
          <button type="button" className="signin__switch" onClick={() => window.print()} disabled={busy}>
            Print
          </button>
        </div>
        <button
          type="button"
          role="checkbox"
          aria-checked={saved}
          className={saved ? 'signin__toggle signin__toggle--on' : 'signin__toggle'}
          onClick={() => onSavedChange(!saved)}
          disabled={busy}
        >
          <span className="signin__toggle-box" aria-hidden="true">
            {saved ? '✓' : ''}
          </span>
          <span>I have saved this.</span>
        </button>
        <button
          className="signin__submit"
          type="button"
          disabled={!saved || busy || locked}
          onClick={onContinue}
        >
          {busy ? 'Claiming…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}

/** What the downloaded file says. The surrounding sentences are the same
 * ones the screen shows. */
function recoveryKeyFile(text: string): string {
  return [
    "Fathom organisation recovery key",
    "This is your organisation's root key. Fathom cannot use it for anything yet; a future",
    'recovery process will need it. This file is plain text -- store it somewhere as safe as',
    'you would store any other password.',
    '',
    text,
    '',
  ].join('\n');
}

/** Saves the recovery key as a file, from this browser, with no server
 * round trip. */
function downloadRecoveryKey(text: string): void {
  const blob = new Blob([recoveryKeyFile(text)], { type: 'text/plain;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = 'fathom-organisation-recovery-key.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** The server's own sentence where the failure was a refusal it sent, or
 * this screen's honest statement where it was not. */
function describeClaimError(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'That claim did not complete.';
}

/** A refusal the server sent (a 4xx) versus no answer at all -- a network
 * failure or a 5xx, either of which may have followed a real commit. */
function describeSendFailure(error: unknown): { message: string; lostAnswer: boolean } {
  if (error instanceof ApiRefusal && error.status < 500) {
    return {
      message: `The claim was refused: ${describeClaimError(error)} You can try again with a new key.`,
      lostAnswer: false,
    };
  }
  return {
    message:
      'There was no answer. If the claim went through, this key already stewards the organisation ' +
      'it created -- reload this page to check before doing anything else.',
    lostAnswer: true,
  };
}

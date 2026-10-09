import { useState, type FormEvent } from 'react';

import type { Asked, IssuedInvitation } from '../../api/invitations';
import type { Scope } from '../../api/scopes';
import { invitationAddress } from '../console/invitationAddress';
import { CAPABILITY_HELP, CAPABILITY_WORD, dateLabel } from './model';

export interface InviteFormProps {
  /** Folders the signed-in person stewards, which are the only ones they can invite into. */
  folders: readonly Scope[];
  organisationName: string;
  busy: boolean;
  error: string | null;
  onSubmit: (request: { name: string; email: string; capability: Asked; scopeId: string | null }) => void;
  onCancel: () => void;
}

const CAPABILITIES: Asked[] = ['read', 'draw', 'steward'];

/** Invite someone: who, what they can do, and where. Nothing is granted by this. */
export function InviteForm({ folders, organisationName, busy, error, onSubmit, onCancel }: InviteFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [capability, setCapability] = useState<Asked>('draw');
  const [scope, setScope] = useState<string>(folders[0]?.scopeId ?? '');

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ name: name.trim(), email: email.trim(), capability, scopeId: scope === '' ? null : scope });
  }

  return (
    <form className="org-form" onSubmit={submit}>
      <div className="org-form__title">Invite someone</div>
      <label className="org-field">
        <span className="org-field__label">Name</span>
        <input className="org-input" value={name} maxLength={100} required autoFocus onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="org-field">
        <span className="org-field__label">Email (optional)</span>
        <input className="org-input" type="text" inputMode="email" value={email} maxLength={254} aria-describedby="invite-email-hint" onChange={(e) => setEmail(e.target.value)} />
        <span className="org-field__hint" id="invite-email-hint">
          A note for you and the other stewards. Fathom does not send anything to it and the person does not sign in
          with it.
        </span>
      </label>
      <fieldset className="org-field org-field--set">
        <legend className="org-field__label">What they can do</legend>
        {CAPABILITIES.map((c) => (
          <label key={c} className="org-radio">
            <input type="radio" name="capability" checked={capability === c} onChange={() => setCapability(c)} />
            <span>
              <strong>{CAPABILITY_WORD[c]}</strong>
              <span className="org-field__hint"> {CAPABILITY_HELP[c].replace(/^\w+: /, '')}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="org-field">
        <span className="org-field__label">Where</span>
        <select className="org-input" value={scope} aria-describedby="invite-where-hint" onChange={(e) => setScope(e.target.value)}>
          {folders.map((f) => (
            <option key={f.scopeId} value={f.scopeId}>
              {f.displayName}
            </option>
          ))}
          <option value="">Whole organisation ({organisationName})</option>
        </select>
        <span className="org-field__hint" id="invite-where-hint">
          It covers the folder and everything in it. Whole organisation needs you to be a steward of all of it.
        </span>
      </label>
      <p className="org-note">
        This only makes an invitation. The person gets access after they join and you confirm them, under Waiting for you.
      </p>
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}
      <div className="org-actions">
        <button type="submit" className="org-btn org-btn--primary" disabled={busy || name.trim() === ''}>
          {busy ? 'Making the link…' : 'Make the link'}
        </button>
        <button type="button" className="org-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export interface LinkCardProps {
  invitation: IssuedInvitation;
  /** What they were invited to, in words: `Draw · LON1`. */
  access: string;
  name: string;
  origin: string;
  onDone: () => void;
  onAnother: () => void;
}

/** The one-time link. The server keeps no copy, so this is the only time it can be shown. */
export function LinkCard({ invitation, access, name, origin, onDone, onAnother }: LinkCardProps) {
  const [copied, setCopied] = useState<'link' | 'name' | null>(null);
  const link = invitationAddress(origin, invitation.token);

  async function copy(what: 'link' | 'name', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
    } catch {
      setCopied(null); // the text is on screen to select by hand
    }
  }

  return (
    <div className="org-form" data-testid="invite-link-card">
      <div className="org-form__title">Send this to {name}</div>
      <p className="org-note">
        <strong>Fathom does not email this.</strong> You send it yourself, by a message or a call you trust. Send the
        link and the sign-in name together.
      </p>
      <div className="org-field">
        <span className="org-field__label">Link</span>
        <code className="org-code" data-testid="invite-link">
          {link}
        </code>
        <button type="button" className="org-btn" onClick={() => void copy('link', link)}>
          {copied === 'link' ? 'Copied.' : 'Copy the link'}
        </button>
      </div>
      <div className="org-field">
        <span className="org-field__label">Sign-in name</span>
        <code className="org-code" data-testid="invite-sign-in-name">
          {invitation.signInName}
        </code>
        <button type="button" className="org-btn" onClick={() => void copy('name', invitation.signInName)}>
          {copied === 'name' ? 'Copied.' : 'Copy the name'}
        </button>
      </div>
      <ul className="org-list">
        <li>
          Asked for: <strong>{access}</strong>. Nothing is granted until they have joined and you have confirmed them.
        </li>
        <li>
          The link works once, and stops working on {dateLabel(invitation.expiresAtUnix)}. If it is lost or used by
          someone else, cancel the invitation and make a new one.
        </li>
        <li>You will not be shown this link again. Fathom keeps no copy of it.</li>
        <li>
          The sign-in name is not their email. They use it, not an email, to sign in.
        </li>
      </ul>
      <div className="org-actions">
        <button type="button" className="org-btn org-btn--primary" onClick={onDone}>
          Done
        </button>
        <button type="button" className="org-btn" onClick={onAnother}>
          Invite someone else
        </button>
      </div>
    </div>
  );
}

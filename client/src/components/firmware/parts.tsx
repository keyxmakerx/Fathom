import { useEffect, useState } from 'react';

import type { FetchLink, FirmwareCommands } from '../../api/firmware';
import { MAX_REASON, STATE_WORD, type FwState } from '../../document/firmware';
import type { FirmwareApi } from './context';
import { commandWithLink, maskedLink } from './upgradePlan';

/** Puts text on the clipboard. Returns false when the browser would not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copy', className = 'fw-btn' }: { text: string | (() => string | Promise<string>); label?: string; className?: string }) {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const value = typeof text === 'string' ? text : await text();
        setSaid((await copyText(value)) ? 'Copied' : 'Select and copy it by hand');
        window.setTimeout(() => setSaid(null), 2500);
      }}
    >
      {said ?? label}
    </button>
  );
}

/** The state as the mockup draws it: a green square on the chosen version, amber behind, hollow otherwise. */
export function StateMark({ state, word }: { state: FwState; word?: string }) {
  const tone = state === 'current' ? 'current' : state === 'behind' ? 'behind' : 'none';
  return (
    <span>
      <span className={`fw-square fw-square--${tone}`} aria-hidden="true" />
      {word ?? STATE_WORD[state]}
    </span>
  );
}

/** Asks why a device is held. Nothing is written until a reason is given. */
export function HoldForm({ onHold, onCancel }: { onHold: (reason: string) => string | void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="fw-hold-form"
      onSubmit={(e) => {
        e.preventDefault();
        const refused = onHold(reason);
        if (typeof refused === 'string') setError(refused);
      }}
    >
      <input className="fw-input" value={reason} maxLength={MAX_REASON} placeholder="Why it stays on this version" aria-label="Why it is held" autoFocus onChange={(e) => setReason(e.currentTarget.value)} />
      <button type="submit" className="fw-btn">
        Hold
      </button>
      <button type="button" className="fw-btn fw-btn--quiet" onClick={onCancel}>
        Cancel
      </button>
      {error ? (
        <span className="fw-error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

/** What the server could not write: no steps for the platform, and what the vendor's pages did not settle. */
export function CommandNotes({ commands }: { commands: FirmwareCommands | null | undefined }) {
  if (!commands) return null;
  return (
    <>
      {commands.steps.length === 0 ? (
        <p className="fw-muted" data-testid="fw-no-steps">
          No steps are written for this platform yet.
        </p>
      ) : null}
      {commands.couldNotEstablish.map((line) => (
        <p key={line} className="fw-muted fw-not-established">{`Not established: ${line}`}</p>
      ))}
    </>
  );
}

/** "https://host/fw/fetch/••••" with the commands under it. The link is held in this component only. */
export function LinkView({ link, detail }: { link: FetchLink; detail?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const left = link.expiresAtUnix * 1000 - now;
  const ends = new Date(link.expiresAtUnix * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const steps = link.commands?.steps ?? [];
  const all = steps.map((s) => commandWithLink(s.command, link.url)).join('\n');
  return (
    <div className="fw-link-box" data-testid="fw-link">
      <div className="fw-link-box__url">{maskedLink(link.url)}</div>
      <div className="fw-link-box__row">
        <CopyButton text={link.url} label="Copy link" />
        {detail ? <CopyButton text={commandWithLink(detail, link.url)} label="Copy command" /> : null}
        {all ? <CopyButton text={all} label="Copy all commands" className="fw-btn fw-btn--quiet" /> : null}
      </div>
      <p className="fw-muted" role="status">
        {left > 0 ? `Works once, then expires: 15 minutes, until ${ends}.` : 'This link has expired. Get another.'} Fathom never logs in to the device.
      </p>
      <p className="fw-muted">
        Expected SHA-256 <span className="fw-mono">{link.sha256}</span> <CopyButton text={link.sha256} label="Copy" className="fw-btn fw-btn--quiet" />
      </p>
      {steps.length > 0 ? (
        <pre className="fw-link-box__cmd">{steps.map((s) => `${s.step}\n  ${commandWithLink(s.command, link.url)}`).join('\n')}</pre>
      ) : null}
      <CommandNotes commands={link.commands} />
    </div>
  );
}

/** Get a one-time link for an image. Asks the server each time; the link is never stored. */
export function GetLink({ api, imageId, detail, label = 'Get a one-time link' }: { api: FirmwareApi; imageId: string; detail?: string; label?: string }) {
  const [link, setLink] = useState<FetchLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        className="fw-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const got = await api.issueLink(imageId);
          setBusy(false);
          if ('refused' in got) {
            setLink(null);
            setError(got.refused);
          } else setLink(got);
        }}
      >
        {busy ? 'Getting…' : link ? 'Get another' : label}
      </button>
      {error ? (
        <p className="fw-error" role="alert">
          {error}
        </p>
      ) : null}
      {link ? <LinkView link={link} detail={detail} /> : null}
    </div>
  );
}

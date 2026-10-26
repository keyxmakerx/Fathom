// Letting Fathom use a login (ADR-0071 part two; storage design §13.4 and §13.5). The consent
// screen shows the design's sentences word for word, and the person ticks that they read them
// before their account key signs. Turning it off is cheap and says what it cannot undo.

import { useState } from 'react';

import type { VaultEntry, VaultOverview } from '../../api/vault';
import {
  FATHOM_CONSENT_TEXT,
  FATHOM_OFF_TEXT,
  FATHOM_PROTECTS_TEXT,
  countersignFathomUse,
  fathomCopyStale,
  holderAccounts,
  letFathomUse,
  stopFathomUse,
} from '../../vault/session';
import { describeError } from '../design/useDesignSession';
import { VaultModal } from './Modal';
import { ago } from './parts';

export type FathomAct = 'on' | 'off' | 'countersign';

/** The tag on a login's card and its row: how Fathom keeps it. */
export function keptText(entry: VaultEntry): string {
  const f = entry.fathom;
  if (!f || f.state === 'off') return 'Only people';
  if (f.state === 'waiting') return 'Waiting for an admin';
  return fathomCopyStale(entry) ? 'Fathom’s copy is out of date' : 'Fathom can use it';
}

/** "Fathom used it 3 times · last 2 days ago, for Auto-populate", or nothing. */
export function fathomUseText(entry: VaultEntry): string | null {
  const f = entry.fathom;
  if (!f || f.state === 'off') return null;
  if (f.reads === 0 || f.lastRead == null) return f.state === 'on' ? 'Fathom has not used it yet' : null;
  const purpose = f.lastPurpose === 'autopopulate' ? ', for Auto-populate' : f.lastPurpose === 'check' ? ', to check it still works' : '';
  return `Fathom used it ${f.reads === 1 ? 'once' : `${f.reads} times`} · last ${ago(f.lastRead)}${purpose}`;
}

/** The people besides its owner who hold it now, by name. */
function othersHolding(entry: VaultEntry): string[] {
  const others = new Set(holderAccounts(entry).filter((a) => a !== entry.owner));
  return entry.holders.filter((h) => h.kind === 'person' && !h.revoked && h.account && others.has(h.account)).map((h) => h.name);
}

export function FathomDialog({
  organisation,
  overview,
  entry,
  act,
  devicesText,
  onClose,
  onDone,
}: {
  organisation: string;
  overview: VaultOverview;
  entry: VaultEntry;
  act: FathomAct;
  devicesText: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work().then(onDone, (e: unknown) => {
      setError(describeError(e));
      setBusy(false);
    });
  };
  const failed = error && (
    <p className="vault-error" role="alert">
      {error}
    </p>
  );

  if (act === 'off') {
    return (
      <VaultModal title={`Stop Fathom using ${entry.name}?`} onClose={onClose} testId="vault-fathom-off">
        <p>Fathom’s copy is emptied now, and Fathom signs in with this login no more. The people who hold it keep it.</p>
        <p className="vault-note vault-note--caution">{FATHOM_OFF_TEXT}</p>
        {failed}
        <div className="vault-actions">
          <button type="button" className="vault-btn vault-btn--solid" disabled={busy} onClick={() => run(() => stopFathomUse(organisation, entry.id))} data-testid="vault-fathom-off-go">
            {busy ? 'Stopping…' : 'Stop Fathom using it'}
          </button>
          <button type="button" className="vault-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </VaultModal>
    );
  }

  const others = othersHolding(entry);
  if (act === 'countersign') {
    const f = entry.fathom;
    const changed = f != null && f.copyEpoch !== entry.epoch;
    return (
      <VaultModal title={`Sign for Fathom to use ${entry.name}`} onClose={onClose} testId="vault-fathom-countersign">
        <p>
          {f?.consentedByName ?? 'Its owner'} asked {f ? ago(f.consentAt * 1000) : ''} for Fathom to keep a copy of this login it can open
          itself. Other people hold it too, so a second admin signs before Fathom uses it.
        </p>
        <div className="vault-note vault-note--caution">
          <p>{FATHOM_CONSENT_TEXT}</p>
          <p>{FATHOM_PROTECTS_TEXT}</p>
        </div>
        <p className="vault-small">Your account key signs the same statement they signed. It is written to the organisation’s history.</p>
        {changed && <p className="vault-note vault-note--danger">This login changed after it was asked, so it cannot be signed. Its owner asks again.</p>}
        <label className="vault-check">
          <input type="checkbox" checked={read} onChange={() => setRead((r) => !r)} data-testid="vault-fathom-read" /> I have read what this means
        </label>
        {failed}
        <div className="vault-actions">
          <button type="button" className="vault-btn vault-btn--solid" disabled={busy || !read || changed} onClick={() => run(() => countersignFathomUse(organisation, entry))} data-testid="vault-fathom-countersign-go">
            {busy ? 'Signing…' : 'Sign'}
          </button>
          <button type="button" className="vault-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </VaultModal>
    );
  }

  return (
    <VaultModal title={`Let Fathom use ${entry.name}?`} onClose={onClose} wide testId="vault-fathom-consent">
      <p>
        Fathom keeps a copy of this login it can open itself, so that it can sign in to the device for you, for example to read its
        configuration for Auto-populate. Only on the devices it is marked on: {devicesText === '—' ? 'none yet, so Fathom will not use it until one is marked' : devicesText}.
        Every time Fathom opens it is written to the organisation’s history and shown on this login.
      </p>
      <div className="vault-note vault-note--caution">
        <p>
          <strong>{FATHOM_CONSENT_TEXT}</strong>
        </p>
        <p>{FATHOM_PROTECTS_TEXT}</p>
      </div>
      <p className="vault-small">
        It is shared again first under a fresh key, so the people holding it are named again now.
        {others.length > 0 ? ` ${others.join(', ')} ${others.length === 1 ? 'holds' : 'hold'} it too, so another admin signs before Fathom uses it.` : ''}{' '}
        Fathom’s copy is sealed under the server’s vault key {overview.fathomKeyId}; a backup restored without that key file loses only Fathom’s copies.
      </p>
      <label className="vault-check">
        <input type="checkbox" checked={read} onChange={() => setRead((r) => !r)} data-testid="vault-fathom-read" /> I have read this. Fathom’s
        server can read this login while this is on.
      </label>
      {failed}
      <div className="vault-actions">
        <button type="button" className="vault-btn vault-btn--solid" disabled={busy || !read} onClick={() => run(() => letFathomUse(organisation, overview, entry))} data-testid="vault-fathom-on-go">
          {busy ? 'Signing…' : 'Let Fathom use it'}
        </button>
        <button type="button" className="vault-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </VaultModal>
  );
}

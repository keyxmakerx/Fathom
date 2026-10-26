// The breach-check policy on Organisation › Passwords (ADR-0071 part three; owner's round-32
// answer: "make sure the checks can be per org, or even like per type of passwords"). Three levels,
// the most specific winning: a login marked critical, a kind of login, the organisation.

import { useState } from 'react';

import { KIND_LABELS, LOGIN_KINDS, setBreachPolicy, type BreachLevel, type BreachPolicy, type LoginKind, type VaultEntry } from '../../api/vault';
import { CRITICAL_INTERVAL_DAYS, DEFAULT_INTERVAL_DAYS, checkDue, effectivePolicy } from '../../vault/breach';
import { describeError } from '../design/useDesignSession';
import { ago } from './parts';

const INTERVALS = [1, 7, 30, 90];

/** The table's "Breach list" cell and the card's line. */
export function breachText(entry: VaultEntry, policy: BreachPolicy): { text: string; tone: 'muted' | 'danger' | 'plain' } {
  const { level } = effectivePolicy(policy, entry.kind, entry.critical);
  if (entry.breach?.found) return { text: 'Found in a breach', tone: 'danger' };
  if (!level.enabled) return { text: 'Checks off', tone: 'muted' };
  if (!entry.breach) return { text: 'Not checked yet', tone: 'muted' };
  return { text: `Not found · ${ago(entry.breach.checkedAt)}${checkDue(entry, policy) ? ', due again' : ''}`, tone: 'plain' };
}

function LevelEditor({ level, onChange, testId }: { level: BreachLevel; onChange: (l: BreachLevel) => void; testId: string }) {
  return (
    <span className="vault-inline" data-testid={testId}>
      <label className="vault-check">
        <input type="checkbox" checked={level.enabled} onChange={(e) => onChange({ ...level, enabled: e.target.checked })} /> Check
      </label>
      <select className="vault-input vault-input--small" value={level.intervalDays} disabled={!level.enabled} onChange={(e) => onChange({ ...level, intervalDays: Number(e.target.value) })} aria-label="How often">
        {INTERVALS.map((d) => (
          <option key={d} value={d}>
            {d === 1 ? 'daily' : d === 7 ? 'weekly' : `every ${d} days`}
          </option>
        ))}
      </select>
      <select className="vault-input vault-input--small" value={level.action} disabled={!level.enabled} onChange={(e) => onChange({ ...level, action: e.target.value as BreachLevel['action'] })} aria-label="When one is found">
        <option value="warn">warn</option>
        <option value="refuse">refuse</option>
      </select>
    </span>
  );
}

export function BreachPolicyCard({ organisation, policy, onSaved }: { organisation: string; policy: BreachPolicy; onSaved: () => void }) {
  const off: BreachLevel = { enabled: false, intervalDays: DEFAULT_INTERVAL_DAYS, action: 'warn' };
  const [org, setOrg] = useState<BreachLevel>(policy.organisation ?? off);
  const [kinds, setKinds] = useState<BreachPolicy['kinds']>(policy.kinds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setKind = (k: LoginKind, l: BreachLevel | undefined) => {
    setKinds((all) => {
      const next = { ...all };
      if (l) next[k] = l;
      else delete next[k];
      return next;
    });
  };
  const save = () => {
    setBusy(true);
    setError(null);
    setBreachPolicy(organisation, { organisation: org, kinds }).then(
      () => {
        setBusy(false);
        onSaved();
      },
      (e: unknown) => {
        setBusy(false);
        setError(describeError(e));
      },
    );
  };
  return (
    <section className="vault-card vault-recovery" data-testid="vault-breach-policy">
      <div className="vault-card__head">
        <span className="vault-card__name">Breach checks</span>
      </div>
      <p className="vault-small">
        A browser that holds a password asks Have I Been Pwned about the first five characters of its hash and compares the rest
        itself. The password never leaves it. Checks run when someone who holds the password unlocks, and when one is saved.
      </p>
      <div className="vault-policy">
        <span className="vault-field__label">The organisation</span>
        <LevelEditor
          level={org}
          onChange={(l) => {
            setOrg(l);
          }}
          testId="vault-policy-org"
        />
        {LOGIN_KINDS.map((k) => {
          const own = kinds[k];
          return (
            <div key={k} className="vault-policy__row" data-testid={`vault-policy-${k}`}>
              <span>{KIND_LABELS[k]}</span>
              <select className="vault-input vault-input--small" value={own ? 'own' : 'same'} onChange={(e) => setKind(k, e.target.value === 'own' ? { ...org } : undefined)} aria-label={`${KIND_LABELS[k]} policy`}>
                <option value="same">Same as the organisation</option>
                <option value="own">Its own</option>
              </select>
              {own && <LevelEditor level={own} onChange={(l) => setKind(k, l)} testId={`vault-policy-${k}-level`} />}
            </div>
          );
        })}
      </div>
      <p className="vault-small">
        A login marked critical is always checked, every {CRITICAL_INTERVAL_DAYS} days, and a breached password is refused, whatever is
        set here. Refusing happens in the browser that saves the password: Fathom’s server never sees a password, so it cannot check one
        itself.
      </p>
      {error && (
        <p className="vault-error" role="alert">
          {error}
        </p>
      )}
      <div className="vault-actions">
        <button type="button" className="vault-btn vault-btn--solid" disabled={busy} onClick={save} data-testid="vault-policy-save">
          {busy ? 'Saving…' : 'Save the policy'}
        </button>
      </div>
    </section>
  );
}

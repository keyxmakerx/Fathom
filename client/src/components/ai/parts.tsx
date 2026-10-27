// Pieces the AI screens share (ADR-0072): what a connection may see, which folders, how
// long, and the plain-words box. Each one is the same on the "Connect an AI app" page, on
// Organisation › AI and on a key's own page, so a person reads one vocabulary everywhere.

import { useState, type ReactNode } from 'react';

import { ApiRefusal } from '../../api/errors';
import { KEY_DAYS, TIERS, type Tier } from '../../api/ai';
import type { Scope } from '../../api/scopes';
import './ai.css';

export const TIER_WORDS: Record<Tier, string> = {
  layout: 'Devices, ports, cables, racks, places, tags and spares on hand (never a serial number)',
  addresses: 'Addresses, VLANs and what pasted configs set',
  notes: "Notes, and a spare's custom fields such as its price and supplier",
};

export const DAY_WORDS: Record<number, string> = { 30: '30 days', 90: '90 days', 365: '1 year' };

/** The server's own sentence for an AI refusal, which is written to be read. */
export function aiError(e: unknown): string {
  if (e instanceof ApiRefusal) {
    const text = e.message.trim();
    if (text !== '' && text !== 'refused') return text.charAt(0).toUpperCase() + text.slice(1);
    if (e.status === 401) return 'Your sign-in has ended. Sign in again.';
    return 'Fathom refused that.';
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export function Ticks({
  sees,
  ceiling,
  onChange,
  disabled,
}: {
  sees: Tier[];
  /** What the organisation allows at most; the rest show, unticked and off. */
  ceiling: Tier[];
  onChange: (next: Tier[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ai-ticks">
      {TIERS.map((tier) => {
        const allowed = tier === 'layout' || ceiling.includes(tier);
        return (
          <label key={tier} className={allowed ? 'ai-tick' : 'ai-tick ai-tick--off'}>
            <input
              type="checkbox"
              checked={sees.includes(tier)}
              disabled={disabled || tier === 'layout' || !allowed}
              onChange={(e) => onChange(e.target.checked ? [...sees, tier] : sees.filter((t) => t !== tier))}
            />
            <span>
              {TIER_WORDS[tier]}
              {!allowed && <span className="ai-tick__why"> · not allowed in this organisation</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function DayChoice({ days, maxDays, onChange }: { days: number; maxDays: number; onChange: (d: number) => void }) {
  return (
    <div className="ai-seg" role="radiogroup" aria-label="Stops working after">
      {KEY_DAYS.map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={d === days}
          disabled={d > maxDays}
          className={d === days ? 'ai-seg__item ai-seg__item--on' : 'ai-seg__item'}
          onClick={() => onChange(d)}
        >
          {DAY_WORDS[d]}
        </button>
      ))}
    </div>
  );
}

/** Folder chips: none chosen means every folder the person can read. */
export function FolderChips({
  chosen,
  folders,
  onChange,
  everyLabel = 'Every folder you can read',
}: {
  chosen: string[];
  folders: Scope[];
  onChange?: (next: string[]) => void;
  everyLabel?: string;
}) {
  const [adding, setAdding] = useState(false);
  const name = (id: string) => folders.find((f) => f.scopeId === id)?.displayName ?? 'A folder';
  const left = folders.filter((f) => !chosen.includes(f.scopeId));
  return (
    <div className="ai-chips">
      {chosen.length === 0 && <span className="ai-chip ai-chip--plain">{everyLabel}</span>}
      {chosen.map((id) => (
        <span key={id} className="ai-chip">
          {name(id)}
          {onChange && (
            <button type="button" className="ai-chip__x" aria-label={`Remove ${name(id)}`} onClick={() => onChange(chosen.filter((c) => c !== id))}>
              ×
            </button>
          )}
        </span>
      ))}
      {onChange && left.length > 0 && !adding && (
        <button type="button" className="ai-chip ai-chip--add" onClick={() => setAdding(true)}>
          + Folder
        </button>
      )}
      {onChange && adding && (
        <select
          className="ai-select"
          autoFocus
          defaultValue=""
          aria-label="Add a folder"
          onBlur={() => setAdding(false)}
          onChange={(e) => {
            if (e.target.value) onChange([...chosen, e.target.value]);
            setAdding(false);
          }}
        >
          <option value="" disabled>
            Choose a folder
          </option>
          {left.map((f) => (
            <option key={f.scopeId} value={f.scopeId}>
              {f.path || f.displayName}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function PlainWords({ lines }: { lines: string[] }) {
  return (
    <div className="ai-plain" data-testid="ai-plain-words">
      <div className="ai-plain__title">In plain words</div>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The "i" the owner asked for (sign-off r31 ai-reach, "a well made i that is easy to
 * understand"): a small round button beside a heading that opens a short explanation in
 * place, and closes again. Nothing hides behind a hover.
 */
export function Info({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={open ? 'ai-info__i ai-info__i--on' : 'ai-info__i'}
        aria-expanded={open}
        aria-label={open ? `Close: ${label}` : label}
        title={label}
        onClick={() => setOpen(!open)}
      >
        i
      </button>
      {open && (
        <span className="ai-info__body" role="note">
          {children}
        </span>
      )}
    </>
  );
}

export function ago(unix: number | null, now = Date.now() / 1000): string {
  if (unix === null) return 'never';
  const s = Math.max(0, now - unix);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function until(unix: number, now = Date.now() / 1000): string {
  const days = Math.ceil((unix - now) / 86400);
  if (days <= 0) return 'ended';
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}

// Admin › Firmware (sign-off r71, every pick approved). The settings file gives the starting
// values; a value saved here wins over it until it is reset, and an empty box means the file's.
// Below them, each organisation's ceiling (the most its Stewards may set) and the lock, which
// keeps the Stewards' own values from counting and shows them the reason. Every change is sealed
// on the site chain, and an organisation's also on its own, so its Stewards see it.

import { useCallback, useEffect, useState } from 'react';

import type { OrganisationRow } from '../../api/console';
import {
  bytesFromGb,
  changeWords,
  fetchAdminSettings,
  gbWords,
  GB,
  saveAdminSettings,
  setOrganisationCeiling,
  type AdminFirmwareSettings,
  type AdminOrganisationRow,
  type SavedValues,
  type ServerValues,
} from '../../api/firmwareSettings';
import { describeConsoleError } from './describeConsoleError';
import { SkeletonRows } from '../ui/Skeleton';

type On = Extract<AdminFirmwareSettings, { on: true }>;
type Key = keyof ServerValues;
type Unit = 'gb' | 'count' | 'seconds' | 'url';

/** The server's values, in the order a person reads them, with how each is typed. */
export const SERVER_FIELDS: { key: Key; label: string; unit: Unit; hint: string }[] = [
  { key: 'maxImageBytes', label: 'Largest image', unit: 'gb', hint: 'The most one uploaded image may be.' },
  { key: 'totalMaxBytes', label: 'All firmware on this server', unit: 'gb', hint: 'Every organisation’s images together.' },
  {
    key: 'organisationMaxBytes',
    label: 'Each organisation, unless set below',
    unit: 'gb',
    hint: 'The ceiling for an organisation that has none of its own.',
  },
  { key: 'uploadsPerServer', label: 'Uploads at once, on the server', unit: 'count', hint: 'From 1 to 64.' },
  { key: 'uploadsPerOrganisation', label: 'Uploads at once, each organisation', unit: 'count', hint: 'At most the server’s.' },
  {
    key: 'uploadIdleSeconds',
    label: 'Stop an upload that stalls for, in seconds',
    unit: 'seconds',
    hint: 'From 10 to 3600.',
  },
  {
    key: 'fetchBaseUrl',
    label: 'Address devices download from',
    unit: 'url',
    hint: 'An organisation’s Stewards may set their own, unless you lock it.',
  },
];

const shown = (unit: Unit, v: number | string): string =>
  unit === 'gb' ? gbWords(v as number) : unit === 'seconds' ? `${v} s` : String(v);

const typedOf = (unit: Unit, v: number | string | null): string =>
  v === null ? '' : unit === 'gb' ? String((v as number) / GB) : String(v);

/** A box's text as the value to save: null for empty, NaN for anything that is not one. */
export function valueOf(unit: Unit, text: string): number | string | null {
  const t = text.trim();
  if (t === '') return null;
  if (unit === 'url') return t;
  if (unit === 'gb') return bytesFromGb(t);
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

const bad = (v: number | string | null) => typeof v === 'number' && Number.isNaN(v);

/** What the rows of the organisation table are: every organisation, with its ceiling when it has one. */
export function organisationRows(names: OrganisationRow[], rows: AdminOrganisationRow[]): { id: string; name: string; row: AdminOrganisationRow | null }[] {
  const byId = new Map(rows.map((r) => [r.organisation, r]));
  const out = names.map((n) => ({ id: n.id, name: n.displayName, row: byId.get(n.id) ?? null }));
  for (const r of rows) if (!names.some((n) => n.id === r.organisation)) out.push({ id: r.organisation, name: r.organisation, row: r });
  return out;
}

function ServerForm({ s, busy, onSave }: { s: On; busy: boolean; onSave: (v: SavedValues) => void }) {
  const [text, setText] = useState<Record<Key, string>>(
    () => Object.fromEntries(SERVER_FIELDS.map((f) => [f.key, typedOf(f.unit, s.saved[f.key])])) as Record<Key, string>,
  );
  const values = Object.fromEntries(SERVER_FIELDS.map((f) => [f.key, valueOf(f.unit, text[f.key])])) as unknown as SavedValues;
  const anyBad = SERVER_FIELDS.some((f) => bad(values[f.key]));
  return (
    <div className="console__form" data-testid="admin-firmware-server">
      <table className="console__table">
        <thead>
          <tr>
            <th>setting</th>
            <th>settings file</th>
            <th>saved here</th>
            <th>in use</th>
          </tr>
        </thead>
        <tbody>
          {SERVER_FIELDS.map((f) => (
            <tr key={f.key}>
              <td>
                <label htmlFor={`fw-${f.key}`}>{f.label}</label>
                <div className="console__note">{f.hint}</div>
              </td>
              <td>
                <code>{shown(f.unit, s.file[f.key])}</code>
              </td>
              <td>
                <input
                  id={`fw-${f.key}`}
                  className={f.unit === 'url' ? 'console__input console__input--mono' : 'console__input'}
                  inputMode={f.unit === 'url' ? undefined : f.unit === 'gb' ? 'decimal' : 'numeric'}
                  value={text[f.key]}
                  placeholder="the file’s"
                  aria-invalid={bad(values[f.key])}
                  disabled={busy}
                  maxLength={300}
                  data-testid={`admin-firmware-${f.key}`}
                  onChange={(e) => setText((t) => ({ ...t, [f.key]: e.target.value }))}
                />
              </td>
              <td>
                <code>{shown(f.unit, s.limits[f.key])}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="console__note">Sizes are in GB. An empty box uses the settings file’s value; Reset empties them all.</p>
      <div className="console__row">
        <button type="button" className="console__btn" data-testid="admin-firmware-save" disabled={busy || anyBad} onClick={() => onSave(values)}>
          Save
        </button>
        <button
          type="button"
          className="console__btn"
          data-testid="admin-firmware-reset"
          disabled={busy}
          onClick={() => {
            setText(Object.fromEntries(SERVER_FIELDS.map((f) => [f.key, ''])) as Record<Key, string>);
          }}
        >
          Reset to the file
        </button>
      </div>
    </div>
  );
}

function OrganisationLine({
  id,
  name,
  row,
  fallback,
  busy,
  onSave,
}: {
  id: string;
  name: string;
  row: AdminOrganisationRow | null;
  fallback: number;
  busy: boolean;
  onSave: (ceiling: number | null, locked: boolean, reason: string, version: number) => void;
}) {
  const [cap, setCap] = useState(row?.ceilingBytes == null ? '' : String(row.ceilingBytes / GB));
  const [locked, setLocked] = useState(row?.locked ?? false);
  const [reason, setReason] = useState(row?.lockReason ?? '');
  const typed = bytesFromGb(cap);
  const needsReason = locked && reason.trim() === '';
  return (
    <tr data-testid={`admin-firmware-org-${id}`}>
      <td>
        {name}
        {row && !row.verifies && (
          <div className="console__error" role="alert">
            Its saved values do not match their seal. Save them again to replace them.
          </div>
        )}
      </td>
      <td>
        {row?.own.maxBytes != null ? gbWords(row.own.maxBytes) : 'the ceiling'}
        <div className="console__note">{row?.own.fetchBaseUrl ?? 'the server’s address'}</div>
      </td>
      <td>
        <input
          className="console__input"
          inputMode="decimal"
          value={cap}
          placeholder={String(Number((fallback / GB).toFixed(1)))}
          aria-label={`Ceiling for ${name}, in GB`}
          aria-invalid={Number.isNaN(typed)}
          disabled={busy}
          onChange={(e) => setCap(e.target.value)}
        />
      </td>
      <td>
        <label>
          <input type="checkbox" checked={locked} disabled={busy} onChange={(e) => setLocked(e.target.checked)} /> Locked
        </label>
        {locked && (
          <input
            className="console__input"
            value={reason}
            maxLength={200}
            placeholder="Why, shown to its Stewards"
            aria-label={`Why ${name} is locked`}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </td>
      <td>
        <button
          type="button"
          className="console__btn"
          disabled={busy || Number.isNaN(typed) || needsReason}
          data-testid={`admin-firmware-org-save-${id}`}
          onClick={() => onSave(typed, locked, locked ? reason.trim() : '', row?.version ?? 0)}
        >
          Save
        </button>
      </td>
    </tr>
  );
}

/** The section, given what the server answered. Separate so a test can render it without a server. */
export function FirmwareSectionView({
  settings,
  organisations,
  busy,
  error,
  notice,
  onSaveServer,
  onSaveOrganisation,
}: {
  settings: AdminFirmwareSettings;
  organisations: OrganisationRow[];
  busy: boolean;
  error: string | null;
  notice: string | null;
  onSaveServer: (v: SavedValues, version: number) => void;
  onSaveOrganisation: (organisation: string, ceiling: number | null, locked: boolean, reason: string, version: number) => void;
}) {
  if (!settings.on) {
    return (
      <p className="console__note" data-testid="admin-firmware-off">
        Firmware is off on this server. It turns on when FATHOM_FIRMWARE_FETCH_BASE_URL is set in .env (docs/RUNNING-IT.md); after that, its limits are set here.
      </p>
    );
  }
  const names = new Map(organisations.map((o) => [o.id, o.displayName]));
  const rows = organisationRows(organisations, settings.organisations);
  return (
    <div data-testid="admin-firmware">
      <p className="console__note">
        The settings file gives the starting values. A value saved here wins over the file’s, and every change is recorded with the values
        before and after.
      </p>
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="console__note" role="status">
          {notice}
        </p>
      )}
      <ServerForm s={settings} busy={busy} onSave={(v) => onSaveServer(v, settings.version)} />

      <h3 className="console__form-title">Organisations</h3>
      <p className="console__note">
        The ceiling is the most an organisation’s Stewards may set for themselves; empty means {gbWords(settings.limits.organisationMaxBytes)},
        the server’s. Locking keeps their own total and download address from counting, and shows them your reason.
      </p>
      {rows.length === 0 ? (
        <p className="console__note">No organisation exists yet.</p>
      ) : (
        <table className="console__table">
          <thead>
            <tr>
              <th>organisation</th>
              <th>its own</th>
              <th>ceiling, GB</th>
              <th>lock</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <OrganisationLine
                key={`${r.id}:${r.row?.version ?? 0}`}
                id={r.id}
                name={r.name}
                row={r.row}
                fallback={settings.limits.organisationMaxBytes}
                busy={busy}
                onSave={(c, l, why, v) => onSaveOrganisation(r.id, c, l, why, v)}
              />
            ))}
          </tbody>
        </table>
      )}

      <h3 className="console__form-title">Changes</h3>
      {settings.history.length === 0 ? (
        <p className="console__note">No changes yet: the settings file’s values are in use.</p>
      ) : (
        <ul className="console__minted" data-testid="admin-firmware-history">
          {settings.history.map((c) => (
            <li key={c.seq} className="console__note">
              {new Date(c.atUnix * 1000).toLocaleString()} · {changeWords(c)}
              {c.organisation ? ` (${names.get(c.organisation) ?? c.organisation})` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FirmwareSection({ organisations }: { organisations: OrganisationRow[] }) {
  const [settings, setSettings] = useState<AdminFirmwareSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);

  const load = useCallback(() => {
    fetchAdminSettings().then(
      (v) => {
        setSettings(v);
        setLoadError(null);
        setRound((r) => r + 1);
      },
      (e: unknown) => setLoadError(describeConsoleError(e)),
    );
  }, []);
  useEffect(load, [load]);

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    work().then(
      () => {
        setNotice('Saved, and recorded.');
        setBusy(false);
        load();
      },
      (e: unknown) => {
        setError(describeConsoleError(e));
        setBusy(false);
      },
    );
  };

  if (loadError) {
    return (
      <p className="console__error" role="alert">
        {loadError}
      </p>
    );
  }
  if (!settings) return <SkeletonRows label="Loading firmware settings…" rows={4} />;
  return (
    <FirmwareSectionView
      key={round}
      settings={settings}
      organisations={organisations}
      busy={busy}
      error={error}
      notice={notice}
      onSaveServer={(v, version) => run(() => saveAdminSettings(v, version))}
      onSaveOrganisation={(org, c, l, why, version) => run(() => setOrganisationCeiling(org, c, l, why, version))}
    />
  );
}

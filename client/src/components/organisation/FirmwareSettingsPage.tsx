// Steward › Firmware (sign-off r71). The organisation's own firmware total, under the ceiling the
// server's admin sets, and the address this organisation's devices download from. While the admin
// has the organisation locked, both read-only with the admin's reason. The newest changes, the
// admin's included, are listed below with who made each.

import { useCallback, useEffect, useState } from 'react';

import { describeError } from '../../api/invitations';
import {
  bytesFromGb,
  changeWords,
  fetchStewardSettings,
  gbWords,
  GB,
  saveStewardSettings,
  type StewardFirmwareSettings,
} from '../../api/firmwareSettings';
import { dateTimeLabel } from './model';

type Load = { status: 'loading' } | { status: 'off' } | { status: 'error'; message: string } | { status: 'ready'; value: StewardFirmwareSettings };

/** The page, given what the server answered. Separate so a test can render it without a server. */
export function FirmwareSettingsView({
  settings,
  busy,
  error,
  notice,
  onSave,
}: {
  settings: StewardFirmwareSettings;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onSave: (maxBytes: number | null, fetchBaseUrl: string | null) => void;
}) {
  const { limits, ceiling, own, history } = settings;
  const locked = ceiling?.locked === true;
  const [total, setTotal] = useState(own.maxBytes === null ? '' : String(own.maxBytes / GB));
  const [address, setAddress] = useState(own.fetchBaseUrl ?? '');
  const serverAddress = settings.server.fetchBaseUrl ?? settings.file.fetchBaseUrl;
  const typed = bytesFromGb(total);
  const badTotal = typed !== null && (Number.isNaN(typed) || typed > limits.organisationCeiling);

  return (
    <section className="org-page" data-testid="steward-firmware">
      <div className="org-page__title">Firmware</div>
      <p className="org-field__hint">
        How much firmware this organisation may keep on the server, and where its devices download it from. The server’s admin sets the
        most it may have. Every change is recorded with who made it.
      </p>
      {locked && (
        <p className="home__error" role="status" data-testid="steward-firmware-locked">
          The server’s admin has locked these settings{ceiling?.lockReason ? `: “${ceiling.lockReason}”` : '.'} Ask them to change them.
        </p>
      )}
      <dl className="org-facts">
        <dt>In use now</dt>
        <dd>
          {gbWords(limits.organisationMaxBytes)} in all, images up to {gbWords(limits.maxImageBytes)} each
        </dd>
        <dt>The most allowed</dt>
        <dd>{gbWords(limits.organisationCeiling)}, set by the server’s admin</dd>
        <dt>Devices download from</dt>
        <dd className="org-mono">{limits.fetchBaseUrl}</dd>
      </dl>
      <label className="org-field">
        <span className="org-field__label">This organisation’s total, in GB</span>
        <input
          className="org-input"
          inputMode="decimal"
          value={total}
          disabled={locked || busy}
          placeholder={`${Number((limits.organisationCeiling / GB).toFixed(1))} (the most allowed)`}
          aria-invalid={badTotal}
          onChange={(e) => setTotal(e.target.value)}
        />
        <span className="org-field__hint">
          Empty means as much as the admin allows. {badTotal ? `It can be at most ${gbWords(limits.organisationCeiling)}.` : ''}
        </span>
      </label>
      <label className="org-field">
        <span className="org-field__label">Address your devices download from</span>
        <input
          className="org-input org-mono"
          value={address}
          disabled={locked || busy}
          placeholder={serverAddress}
          maxLength={300}
          onChange={(e) => setAddress(e.target.value)}
        />
        <span className="org-field__hint">
          An address your switches can reach, such as http://10.0.0.5:8080 on the management network. Empty means the server’s,{' '}
          {serverAddress}. Each download link still names one image, so devices don’t need a port each.
        </span>
      </label>
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="org-field__hint" role="status">{notice}</p>}
      <div>
        <button
          type="button"
          className="home__btn"
          data-testid="steward-firmware-save"
          disabled={locked || busy || badTotal}
          onClick={() => onSave(typed, address.trim() === '' ? null : address.trim())}
        >
          Save
        </button>
      </div>
      <div className="org-field__label">Changes</div>
      {history.length === 0 ? (
        <p className="org-field__hint">No changes yet. These are the server’s settings.</p>
      ) : (
        <ul className="org-history" data-testid="steward-firmware-history">
          {history.map((c) => (
            <li key={c.seq}>
              <span className="org-field__hint">{dateTimeLabel(c.atUnix)}</span> {changeWords(c)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function FirmwareSettingsPage({ organisationId }: { organisationId: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  const reload = useCallback(() => {
    fetchStewardSettings(organisationId).then(
      (value) => setLoad(value === null ? { status: 'off' } : { status: 'ready', value }),
      (e: unknown) => setLoad({ status: 'error', message: describeError(e) }),
    );
  }, [organisationId]);
  useEffect(reload, [reload]);

  if (load.status === 'loading') return <p className="home__muted">Loading…</p>;
  if (load.status === 'off') {
    return (
      <section className="org-page">
        <div className="org-page__title">Firmware</div>
        <p className="org-field__hint">Firmware is off on this server. The server’s admin turns it on.</p>
      </section>
    );
  }
  if (load.status === 'error') {
    return (
      <section className="org-page">
        <div className="org-page__title">Firmware</div>
        <p className="home__error" role="alert">
          {load.message}
        </p>
      </section>
    );
  }
  return (
    <FirmwareSettingsView
      key={round}
      settings={load.value}
      busy={busy}
      error={error}
      notice={notice}
      onSave={(maxBytes, fetchBaseUrl) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        saveStewardSettings(organisationId, maxBytes, fetchBaseUrl).then(
          (value) => {
            setLoad({ status: 'ready', value });
            setRound((r) => r + 1);
            setNotice('Saved, and recorded.');
            setBusy(false);
          },
          (e: unknown) => {
            setError(describeError(e));
            setBusy(false);
          },
        );
      }}
    />
  );
}

// Steward › Device reading (ADR-0082 §4.4; ADR-0088 places it in the Estate group after Firmware).
// The organisation's switch and the management ranges a read may reach, each with its SNMP and SSH
// ports. Reading needs the server's operator to allow it first (FATHOM_DEVICE_READ=on) and its
// reader to be running; until then the page says so and the switch cannot be turned on.

import { useCallback, useEffect, useState } from 'react';

import { describeError } from '../../api/invitations';
import {
  approveEngines,
  fetchDeviceReading,
  fetchEngines,
  lastEight,
  rangeProblem,
  saveDeviceReading,
  type DeviceReading,
  type ReadEngine,
  type ReadRange,
} from '../../api/deviceRead';
import { SNMP_AUTH_LABELS, type VaultEntry } from '../../api/vault';
import { forgetReadSettings } from '../reading/store';
import { inRange } from '../reading/ranges';
import { useVault } from '../vault/useVault';
import { dateTimeLabel } from './model';
import '../reading/reading.css';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: DeviceReading };

interface Row {
  cidr: string;
  snmpPort: string;
  sshPort: string;
  /** A read-only SNMP login for the whole range (a vault entry id), or ''. */
  login?: string;
}

const toRow = (r: ReadRange): Row => ({ cidr: r.cidr, snmpPort: String(r.snmpPort), sshPort: String(r.sshPort), login: r.login ?? '' });

/** A login a Steward may set for a range: SNMP, ticked read-only, its authentication said, and copied for Fathom to use. */
export interface RangeLogin {
  id: string;
  name: string;
  auth: string;
}

export function rangeLogins(entries: readonly VaultEntry[]): RangeLogin[] {
  return entries
    .filter((e) => e.kind === 'snmp' && e.readOnly && e.snmpAuth !== null && e.fathom?.state === 'on')
    .map((e) => ({ id: e.id, name: e.name, auth: e.snmpAuth ? SNMP_AUTH_LABELS[e.snmpAuth] : '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function portOf(text: string, fallback: number): number | null {
  const t = text.trim();
  if (t === '') return fallback;
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Pure: the ranges a set of rows means, or the first problem. Empty rows are dropped. */
export function rowsToRanges(rows: readonly Row[]): { ranges: ReadRange[] } | { problem: string } {
  const ranges: ReadRange[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.cidr.trim() === '' && row.snmpPort.trim() === '' && row.sshPort.trim() === '' && !row.login) continue;
    const problem = rangeProblem(row.cidr);
    if (problem) return { problem: `Range ${i + 1}: ${problem}` };
    const snmpPort = portOf(row.snmpPort, 161);
    const sshPort = portOf(row.sshPort, 22);
    if (snmpPort === null || sshPort === null) return { problem: `Range ${i + 1}: a port is 1 to 65535.` };
    ranges.push({ cidr: row.cidr.trim(), snmpPort, sshPort, login: row.login ? row.login : null });
  }
  return { ranges };
}

/** Why reading cannot be turned on here, or null. */
export function notReadyWords(v: DeviceReading): string | null {
  if (!v.server) return 'This server does not read devices. Its operator turns that on with FATHOM_DEVICE_READ=on and the reader profile.';
  if (!v.reader) return 'This server allows reading, but its reader is not answering. Ask the server’s operator to start it.';
  return null;
}

/** The page, given what the server answered. Separate so a test can render it without a server. */
export function DeviceReadingView({
  settings,
  busy,
  error,
  notice,
  onSave,
  logins = [],
}: {
  settings: DeviceReading;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onSave: (on: boolean, ranges: ReadRange[]) => void;
  /** Logins that may be set for a range; a login already set stays listed even when it no longer fits. */
  logins?: readonly RangeLogin[];
}) {
  const [on, setOn] = useState(settings.on);
  const [rows, setRows] = useState<Row[]>(() => (settings.ranges.length > 0 ? settings.ranges.map(toRow) : [{ cidr: '', snmpPort: '', sshPort: '' }]));
  const notReady = notReadyWords(settings);
  const parsed = rowsToRanges(rows);
  const problem = 'problem' in parsed ? parsed.problem : null;
  const noRanges = 'ranges' in parsed && parsed.ranges.length === 0;
  // Turning off is always allowed; turning on needs the server, its reader and a range.
  const cannotTurnOn = on && !settings.on && notReady !== null;
  const edit = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section className="org-page" data-testid="steward-device-reading">
      <div className="org-page__title">Device reading</div>
      <p className="org-field__hint">
        Fathom can read a device with a read-only login you chose, over SNMPv3 or SSH. It never changes one, and everything it reads is a
        suggestion someone accepts. A read goes only to a device’s management address inside a range listed here. Every change is recorded
        with who made it.
      </p>
      {notReady && (
        <p className="home__error" role="status" data-testid="device-reading-not-ready">
          {notReady}
        </p>
      )}
      <label className="org-radio">
        <input
          type="checkbox"
          data-testid="device-reading-on"
          checked={on}
          disabled={busy || (notReady !== null && !settings.on)}
          onChange={(e) => setOn(e.target.checked)}
        />
        <span>Let people with Draw read devices in this organisation</span>
      </label>
      <div className="org-field__label">Management ranges</div>
      <p className="org-field__hint">
        Such as 10.20.0.0/24. Ports are 161 for SNMP and 22 for SSH unless you change them. This machine’s own addresses, link-local and
        multicast are never read, whatever is listed. A login set for a range can read every device in it; only SNMP logins ticked
        read-only and copied for Fathom to use are offered.
      </p>
      <table className="org-table" data-testid="device-reading-ranges">
        <thead>
          <tr>
            <th>Range</th>
            <th>SNMP port</th>
            <th>SSH port</th>
            <th>Read-only login</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <input
                  className="org-input org-mono"
                  aria-label={`Range ${i + 1}`}
                  value={row.cidr}
                  placeholder="10.20.0.0/24"
                  maxLength={64}
                  disabled={busy}
                  onChange={(e) => edit(i, { cidr: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="org-input org-mono"
                  aria-label={`SNMP port for range ${i + 1}`}
                  inputMode="numeric"
                  value={row.snmpPort}
                  placeholder="161"
                  disabled={busy}
                  onChange={(e) => edit(i, { snmpPort: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="org-input org-mono"
                  aria-label={`SSH port for range ${i + 1}`}
                  inputMode="numeric"
                  value={row.sshPort}
                  placeholder="22"
                  disabled={busy}
                  onChange={(e) => edit(i, { sshPort: e.target.value })}
                />
              </td>
              <td>
                <select
                  className="org-input"
                  aria-label={`Read-only login for range ${i + 1}`}
                  value={row.login ?? ''}
                  disabled={busy}
                  onChange={(e) => edit(i, { login: e.target.value })}
                >
                  <option value="">None: marked on each device</option>
                  {logins.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} · SNMPv3 {l.auth}
                    </option>
                  ))}
                  {row.login && !logins.some((l) => l.id === row.login) ? <option value={row.login}>A login no longer offered</option> : null}
                </select>
              </td>
              <td className="org-table__actions">
                <button type="button" className="home__btn btn-small" disabled={busy} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <button
          type="button"
          className="home__btn btn-small"
          disabled={busy || rows.length >= 64}
          onClick={() => setRows((rs) => [...rs, { cidr: '', snmpPort: '', sshPort: '', login: '' }])}
        >
          Add a range
        </button>
      </div>
      {problem && (
        <p className="home__error" role="alert" data-testid="device-reading-problem">
          {problem}
        </p>
      )}
      {on && noRanges && !problem && <p className="org-field__hint">With no range listed, nothing can be read yet.</p>}
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
          data-testid="device-reading-save"
          disabled={busy || problem !== null || cannotTurnOn}
          onClick={() => 'ranges' in parsed && onSave(on, parsed.ranges)}
        >
          Save
        </button>
      </div>
      {settings.setAt !== null && (
        <p className="org-field__hint" data-testid="device-reading-last">
          Last changed {dateTimeLabel(Math.floor(settings.setAt / 1000))}.
        </p>
      )}
    </section>
  );
}

/** Agents waiting for a Steward, grouped by the range they answered in (sign-off r100, r90 "keys bulk per range"). */
export function EnginesView({
  engines,
  ranges,
  busy,
  error,
  onApprove,
}: {
  engines: readonly ReadEngine[];
  ranges: readonly ReadRange[];
  busy: boolean;
  error: string | null;
  onApprove: (addresses: string[]) => void;
}) {
  const waiting = engines.filter((e) => e.state !== 'approved');
  const groups = new Map<string, ReadEngine[]>();
  for (const e of waiting) {
    const cidr = ranges.find((r) => inRange(e.address, r.cidr))?.cidr ?? 'Outside the listed ranges';
    groups.set(cidr, [...(groups.get(cidr) ?? []), e]);
  }
  return (
    <section className="org-page" data-testid="device-reading-engines">
      <div className="org-field__label">Waiting for approval</div>
      <p className="org-field__hint">
        The first time an address answers, Fathom keeps the agent it answered with (its SNMP engine ID) and sends no login until someone
        confirms it. Someone with Draw confirms one device by typing; you can approve a whole range here. One entry goes in the
        organisation’s log for each batch.
      </p>
      {waiting.length === 0 ? <p className="org-field__hint">Nothing is waiting.</p> : null}
      {[...groups.entries()].map(([cidr, list]) => {
        const fresh = list.filter((e) => e.state === 'seen');
        const changed = list.filter((e) => e.state === 'changed');
        return (
          <div className="engines" key={cidr} data-testid="engine-range">
            <div className="engines__head">
              <span>
                <b>{cidr}</b>
              </span>
              <span className="muted">
                {fresh.length} answered for the first time{changed.length ? `, ${changed.length} changed` : ''}
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Engine ID</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.address}>
                    <td className="m">{e.address}</td>
                    <td className="m">…{lastEight(e.engineId)}</td>
                    <td>
                      {e.state === 'changed' ? (
                        <span>
                          <span className="chg">changed since last read{e.previous ? ` (was …${lastEight(e.previous)})` : ''}</span>{' '}
                          <button type="button" className="home__btn btn-small" disabled={busy} onClick={() => onApprove([e.address])}>
                            Approve this one
                          </button>
                        </span>
                      ) : (
                        <span className="muted">new</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="engines__foot">
              <span className="muted">{changed.length ? 'A changed one is never approved with the rest. It is listed on its own.' : ''}</span>
              {fresh.length ? (
                <button type="button" className="home__btn" disabled={busy} onClick={() => onApprove(fresh.map((e) => e.address))} data-testid="approve-new">
                  Approve {fresh.length} new
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Engines({ organisationId, ranges }: { organisationId: string; ranges: readonly ReadRange[] }) {
  const [engines, setEngines] = useState<ReadEngine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    fetchEngines(organisationId).then(setEngines, (e: unknown) => setError(describeError(e)));
  }, [organisationId]);
  useEffect(reload, [reload]);
  if (engines === null) return error ? <p className="home__error">{error}</p> : null;
  return (
    <EnginesView
      engines={engines}
      ranges={ranges}
      busy={busy}
      error={error}
      onApprove={(addresses) => {
        setBusy(true);
        setError(null);
        approveEngines(organisationId, addresses).then(
          () => {
            setBusy(false);
            reload();
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

export function DeviceReadingPage({ organisationId }: { organisationId: string }) {
  const vault = useVault(organisationId);
  const logins = vault.load.status === 'ready' ? rangeLogins(vault.load.value.entries) : [];
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  const reload = useCallback(() => {
    fetchDeviceReading(organisationId).then(
      (value) => setLoad({ status: 'ready', value }),
      (e: unknown) => setLoad({ status: 'error', message: describeError(e) }),
    );
  }, [organisationId]);
  useEffect(reload, [reload]);

  if (load.status === 'loading') return <p className="home__muted">Loading…</p>;
  if (load.status === 'error') {
    return (
      <section className="org-page">
        <div className="org-page__title">Device reading</div>
        <p className="home__error" role="alert">
          {load.message}
        </p>
      </section>
    );
  }
  return (
    <>
    <DeviceReadingView
      key={round}
      logins={logins}
      settings={load.value}
      busy={busy}
      error={error}
      notice={notice}
      onSave={(on, ranges) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        saveDeviceReading(organisationId, on, ranges).then(
          (changed) => {
            setNotice(changed ? 'Saved, and recorded.' : 'Nothing had changed.');
            setBusy(false);
            setRound((r) => r + 1);
            forgetReadSettings(organisationId);
            reload();
          },
          (e: unknown) => {
            setError(describeError(e));
            setBusy(false);
          },
        );
      }}
    />
    {load.value.on ? <Engines organisationId={organisationId} ranges={load.value.ranges} /> : null}
    </>
  );
}

// Device reading in the device panel (ADR-0082 §5; sign-off r100, all A): Read now in the head
// beside ⋯, a chip and a line under the name, and a Readings tab after Ports with what differs,
// each answered on its own or all at once as one undo step. A dismissed difference stays dismissed
// until the device says something else. Nothing is drawn on the canvas.

import { useContext, useMemo, useState, type ReactNode } from 'react';

import { dismissDifference, enginePairs, lastEight, type DeviceReading, type KeptReading, type ReadKind, type ReadRange } from '../../api/deviceRead';
import { SNMP_AUTH_LABELS, type VaultEntry } from '../../api/vault';
import { asString, fieldValue, findNode } from '../../document/model';
import { DEVICE_WORDS } from '../drawing/contextMenuItems';
import { VaultModal } from '../vault/Modal';
import { useVault } from '../vault/useVault';
import { acceptAll, acceptable, againstPlan, compare, withWork, type Comparison, type Difference } from './differences';
import { asCsv, macRows, matches } from './macTable';
import { inRange } from './ranges';
import {
  ReadingContext,
  closeDialog,
  openDialog,
  reloadPanel,
  runRead,
  stopWaiting,
  useDeviceReading,
  useReadSettings,
  type DeviceState,
  type ReadingPlace,
} from './store';
import { NO_WORK, plannedWords, workOnDevice, type WorkOnDevice } from './workOnDevice';
import '../vault/vault.css';
import './reading.css';

/** Where the panel says to go when something is missing; matches the tab ids in `Editor.tsx`. */
const SHOW_PANEL_TAB = 'fathom:panel-tab';

/** Why Read now can't be pressed, in two parts: a short head and the one thing to do. */
export interface Off {
  head: string;
  todo: string;
}

export interface UsableLogin {
  entry: VaultEntry;
  /** "Marked on this device" or "Set for the range 10.20.0.0/24". */
  from: string;
}

/** Read-only SNMP logins this device may be read with: marked on it, or set for its range, and copied for Fathom to use. */
export function usableLogins(entries: readonly VaultEntry[], design: string, element: string, range: ReadRange | null): UsableLogin[] {
  const out: UsableLogin[] = [];
  for (const e of entries) {
    if (e.kind !== 'snmp' || !e.readOnly || e.snmpAuth === null || e.fathom?.state !== 'on') continue;
    if (e.usedOn.some((u) => u.design === design && u.element === element)) out.push({ entry: e, from: 'Marked on this device' });
    else if (range?.login === e.id) out.push({ entry: e, from: `Set for the range ${range.cidr}` });
  }
  return out;
}

/** The first reason Read now can't be pressed, or null when it can. */
export function whyOff(settings: DeviceReading, address: string | null, logins: readonly UsableLogin[]): Off | null {
  if (!settings.on) return { head: 'Reading is off', todo: 'A Steward turns reading on for the organisation on Device reading.' };
  if (!address) return { head: 'No management address', todo: 'Add one on Details › Management.' };
  if (!settings.ranges.some((r) => inRange(address, r.cidr))) return { head: 'Address outside the ranges', todo: `${address} isn't in a range a Steward has listed.` };
  if (logins.length === 0)
    return {
      head: 'No read-only login',
      todo: 'Mark an SNMP login on this device, or a Steward sets one for its range. It must be ticked "This is a read-only account" and copied for Fathom to use.',
    };
  if (!settings.reader) return { head: "The reader isn't answering", todo: "This server's device reader did not answer just now. Its operator can check it." };
  return null;
}

/** Everything the head and the tab need about one device. */
function useDevice(deviceId: string) {
  const place = useContext(ReadingContext);
  const settings = useReadSettings(place?.organisation ?? null);
  const shown = place != null && settings?.status === 'ready' && settings.value.server;
  const state = useDeviceReading(place, deviceId, shown);
  const vault = useVault(shown ? place.organisation : '');
  const doc = place?.doc ?? null;
  const work = useMemo(() => (doc ? workOnDevice(doc, deviceId) : NO_WORK), [doc, deviceId]);
  if (!shown || !state) return null;
  const s = settings.value;
  const node = findNode(place.doc, deviceId);
  const address = node ? (asString(fieldValue(node.fields, 'Device.management_address')) ?? null) : null;
  const hostname = node ? (asString(fieldValue(node.fields, 'Device.hostname')) ?? null) : null;
  const range = address ? (s.ranges.find((r) => inRange(address, r.cidr)) ?? null) : null;
  const logins = vault.load.status === 'ready' ? usableLogins(vault.load.value.entries, place.design, deviceId, range) : [];
  const off = vault.load.status === 'loading' ? { head: 'Loading logins', todo: '' } : whyOff(s, address, logins);
  const latest = state.panel.status === 'ready' ? (state.panel.value.readings[0] ?? null) : null;
  const dismissed = state.panel.status === 'ready' ? state.panel.value.dismissed : [];
  const comparison = withWork(compare(place.doc, deviceId, latest?.reading ?? null, dismissed), work);
  return { place, settings: s, state, address, hostname, logins, off, latest, comparison, work };
}

/** True when this device's panel has a Readings tab: a saved design on a server that reads devices. */
export function useReadingShown(): boolean {
  const place = useContext(ReadingContext);
  const settings = useReadSettings(place?.organisation ?? null);
  return place != null && settings?.status === 'ready' && settings.value.server;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "today at 20:14", "yesterday at 09:02", "28 Oct at 16:40". */
export function when(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= start) return `today at ${clock(ms)}`;
  if (ms >= start - 86_400_000) return `yesterday at ${clock(ms)}`;
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} at ${clock(ms)}`;
}

function who(r: KeptReading): string {
  return r.readByName ?? 'someone';
}

/** Reads with the login used last, when it is still offered; otherwise asks which one. */
function startRead(d: NonNullable<ReturnType<typeof useDevice>>, deviceId: string, kind: ReadKind) {
  const last = d.logins.find((l) => l.entry.id === d.state.login);
  const only = d.logins.length === 1 ? d.logins[0] : undefined;
  const login = last ?? (d.latest ? only : undefined);
  if (login) void readThen(d.place, deviceId, kind, login.entry.id, null);
  else openDialog(d.place, deviceId, kind);
}

async function readThen(place: ReadingPlace, deviceId: string, kind: ReadKind, login: string, confirm: string | null) {
  const answer = await runRead(place, deviceId, kind, login, confirm);
  if (answer?.outcome === 'confirm') openDialog(place, deviceId, kind);
}

/** The head's button, beside ⋯, and the Read dialog it opens. */
export function ReadNow({ deviceId }: { deviceId: string }) {
  const d = useDevice(deviceId);
  if (!d || !d.place.canDraw) return null;
  const busy = d.state.busy !== null;
  return (
    <>
      <button
        type="button"
        className="btn-main read-now"
        disabled={busy || d.off !== null}
        title={d.off ? `${d.off.head}. ${d.off.todo}` : `Reads it over SNMPv3. Nothing on the device is changed.${d.work.running.length ? ` ${underWay(d.work)} is under way on it; what it reads may be half way through.` : ''}`}
        onClick={() => startRead(d, deviceId, 'device')}
        data-testid="read-now"
      >
        {busy ? 'Reading…' : 'Read now'}
      </button>
    </>
  );
}

/** The Read dialog, when open. Placed outside the head's small-capitals kind line so its text keeps its own case. */
export function ReadDialogHost({ deviceId }: { deviceId: string }) {
  const d = useDevice(deviceId);
  if (!d || !d.place.canDraw || !d.state.dialog) return null;
  return <ReadDialog d={d} deviceId={deviceId} kind={d.state.dialog} />;
}

/** "4 differ from drawing", beside the firmware chip. Nothing when nothing differs. */
export function ReadingChip({ deviceId }: { deviceId: string }) {
  const d = useDevice(deviceId);
  const n = d?.comparison.differs.length ?? 0;
  if (n === 0) return null;
  return (
    <span className="dev-tag dev-tag--differs" data-testid="reading-chip">
      <span className="dev-tag__dot" aria-hidden="true" />
      {n} differ{n === 1 ? 's' : ''} from drawing
    </span>
  );
}

/** The one line under the chips: a read under way, or when it was last read and by whom. */
export function ReadLine({ deviceId }: { deviceId: string }) {
  const d = useDevice(deviceId);
  if (!d) return null;
  if (d.state.busy) return <div className="read-line" data-testid="read-line">Reading {d.address} over SNMPv3…</div>;
  if (!d.latest) return d.state.panel.status === 'ready' ? <div className="read-line" data-testid="read-line">Never read</div> : null;
  return (
    <div className="read-line" data-testid="read-line">
      Read <b>{when(d.latest.readAt)}</b> by <b>{who(d.latest)}</b>
      {d.work.running.length ? <span className="read-line__work" data-testid="read-line-work">{underWay(d.work)} under way</span> : null}
    </div>
  );
}

/** “Core swap”, or “Core swap” and 1 more. */
function underWay(w: WorkOnDevice): string {
  const [first, ...rest] = w.running;
  if (!first) return '';
  return `Plan “${first.title || 'Untitled'}”${rest.length ? ` and ${rest.length} more` : ''}`;
}

/** Other work on this device, at the top of the Readings tab (r106). Nothing when there is none. */
function WorkNote({ work }: { work: WorkOnDevice }) {
  if (work.running.length === 0 && work.issues.length === 0) return null;
  const issue = work.issues[0];
  return (
    <div className="work-note" data-testid="work-note">
      {work.running.length ? (
        <div>
          <span className="q">Plan under way</span>
          {underWay(work)} is under way on this device. Read now still reads and changes nothing on it, but what it reads may be half way
          through the plan.
        </div>
      ) : null}
      {issue ? (
        <div>
          <span className="q">{DEVICE_WORDS.itsDown}</span>“{issue.title || 'Untitled'}” is open on this device{work.issues.length > 1 ? ` with ${work.issues.length - 1} more` : ''}. A
          reading may help answer its steps.
        </div>
      ) : null}
    </div>
  );
}

export function ReadingsTabLabel({ deviceId }: { deviceId: string }) {
  const d = useDevice(deviceId);
  const n = d?.comparison.differs.length ?? 0;
  return (
    <>
      Readings{n > 0 ? <span className="tab-count">{n}</span> : null}
    </>
  );
}

function DiffRow({ diff, place, deviceId, canDraw }: { diff: Difference; place: ReadingPlace; deviceId: string; canDraw: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const accept = () => {
    if (!diff.accept) return;
    const r = place.onEdit(diff.accept.change);
    setError(r ? r.refused : null);
  };
  const dismiss = async () => {
    setDismissing(true);
    try {
      await dismissDifference(place.organisation, place.design, deviceId, diff.field, diff.read);
      reloadPanel(place, deviceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That was refused.');
    } finally {
      setDismissing(false);
    }
  };
  return (
    <div className="diff" data-testid="reading-diff">
      <span className="diff__what">{diff.what}</span>
      <span className="diff__vals">
        <span className="diff__now">{diff.read}</span>
        <span className="diff__was">
          Drawing: {diff.drawn ?? <i>none</i>} · <span className="diff__why">{diff.why}</span>
        </span>
        {canDraw ? (
          <span className="diff__acts">
            {diff.accept ? (
              <button type="button" className="btn-small" onClick={accept}>
                {diff.accept.label}
              </button>
            ) : null}
            <button type="button" className="btn-small btn-quiet" onClick={() => void dismiss()} disabled={dismissing}>
              Dismiss
            </button>
          </span>
        ) : null}
        {diff.planned ? (
          <span className="diff__plan" data-testid="diff-plan">
            {plannedWords(diff.planned)}{' '}
            {againstPlan(diff) ? 'Accepting it here would put back what the plan changes.' : 'The device already says this.'}
          </span>
        ) : null}
        {error ? <span className="diff__error" role="alert">{error}</span> : null}
      </span>
    </div>
  );
}

function matchWords(c: Comparison): string {
  const m = c.matches.map((x) => (x === 'name' ? 'Name' : x === 'serial' ? 'serial' : x === 'firmware' ? 'firmware' : x));
  return m.join(', ');
}

function Refusal({ d, deviceId }: { d: NonNullable<ReturnType<typeof useDevice>>; deviceId: string }) {
  const halt = d.state.halt;
  if (!halt || halt.kind !== 'failed') return null;
  const again = () => startRead(d, deviceId, halt.read);
  if (halt.code === 'engine_changed' && halt.engineId) {
    return (
      <div className="read-fail" role="alert" data-testid="read-fail">
        <b>Not read: this isn't the device Fathom read before</b>
        <span>
          Its engine ID changed{halt.previous ? ` from …${lastEight(halt.previous)}` : ''} to …{lastEight(halt.engineId)}. It may have been replaced or reset. Nothing was sent to it.
        </span>
        {d.place.canDraw ? (
          <span>
            <button
              type="button"
              className="btn-small"
              onClick={() => openDialog(d.place, deviceId, halt.read, { kind: 'confirm', engineId: halt.engineId!, state: 'changed', previous: halt.previous })}
            >
              Confirm the new one
            </button>
          </span>
        ) : null}
      </div>
    );
  }
  const refusedLogin = halt.code === 'login_refused';
  const busyElsewhere = halt.code === 'already_reading';
  return (
    <div className="read-fail" role="alert" data-testid="read-fail">
      <b>{refusedLogin ? 'Not read: the login was refused' : busyElsewhere ? 'Not read: someone is reading it now' : 'Not read'}</b>
      <span>{refusedLogin ? 'The device answered SNMP but not this login. Check its privacy password and authentication on the login.' : halt.message}</span>
      {d.place.canDraw ? (
        <span>
          <button type="button" className="btn-small" onClick={again}>
            Try again
          </button>{' '}
          {refusedLogin ? (
            <button type="button" className="btn-small btn-quiet" onClick={() => window.dispatchEvent(new CustomEvent(SHOW_PANEL_TAB, { detail: { tab: 'logins' } }))}>
              Open the login
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** At most this many MAC rows before Find narrows them. */
const MAC_ROWS = 40;

function MacArp({ d, deviceId }: { d: NonNullable<ReturnType<typeof useDevice>>; deviceId: string }) {
  const [find, setFind] = useState('');
  const [copied, setCopied] = useState(false);
  const panel = d.state.panel.status === 'ready' ? d.state.panel.value : null;
  const kept = panel?.macArp ?? null;
  const busy = d.state.busy?.kind === 'macarp';
  const readButton = (label: string) =>
    d.place.canDraw ? (
      <button type="button" className="btn-small" disabled={d.state.busy !== null || d.off !== null} onClick={() => startRead(d, deviceId, 'macarp')}>
        {busy ? 'Reading…' : label}
      </button>
    ) : null;
  if (!kept?.reading) {
    return (
      <>
        <div className="small muted">Not read yet. Read them when you're looking for something plugged in here.</div>
        <div>{readButton('Read MAC and ARP')}</div>
      </>
    );
  }
  const { rows, arp } = macRows(kept.reading);
  const shown = find.trim() ? rows.filter((r) => matches(r, find)) : rows.slice(0, MAC_ROWS);
  const changes = panel?.macArpChanges;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asCsv(rows));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <div className="read-meta">
        Read <b>{when(kept.readAt)}</b> by <b>{who(kept)}</b>. {rows.length} MAC{rows.length === 1 ? '' : 's'} on edge ports.
        {kept.macLeftOut ? ` ${kept.macLeftOut} on ports facing another switch or router are left out.` : ' Ports facing another switch or router are left out.'} {arp} ARP entr{arp === 1 ? 'y' : 'ies'}.
      </div>
      <div className="find">
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a MAC, IP or port" aria-label="Find a MAC, IP or port" data-testid="mac-find" />
        {find ? (
          <button type="button" className="btn-small" onClick={() => setFind('')}>
            Clear
          </button>
        ) : null}
      </div>
      <table className="macs" data-testid="mac-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>MAC</th>
            <th>VLAN</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={`${r.port}|${r.mac}|${r.vlan ?? ''}`} className={find.trim() ? 'hit' : undefined}>
              <td>{r.port}</td>
              <td className="m">{r.mac}</td>
              <td>{r.vlan ?? '—'}</td>
              <td className="m">{r.ip || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {find.trim() && shown.length === 0 ? <div className="small muted">Nothing here matches.</div> : null}
      {!find.trim() && rows.length > MAC_ROWS ? <div className="small muted">And {rows.length - MAC_ROWS} more. Find narrows them.</div> : null}
      {changes ? (
        <div className="small muted" data-testid="mac-changes">
          Since the reading before: {changes.mac.new} MAC{changes.mac.new === 1 ? '' : 's'} new, {changes.mac.gone} gone.
        </div>
      ) : null}
      <div>
        {readButton('Read again')}{' '}
        <button type="button" className="btn-small btn-quiet" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy as CSV'}
        </button>
      </div>
    </>
  );
}

/** The Readings tab. */
export function ReadingsTab({ deviceId }: { deviceId: string }) {
  const d = useDevice(deviceId);
  if (!d) return null;
  const { place, state, latest, comparison } = d;
  const panel = state.panel;
  const all = acceptAll(comparison.differs);
  const allCount = acceptable(comparison.differs).length;
  const leftOut = comparison.differs.filter(againstPlan).length;
  let body: ReactNode;
  if (panel.status === 'loading') body = <div className="small muted">Loading readings…</div>;
  else if (panel.status === 'error') body = <div className="read-fail">{panel.message}</div>;
  else if (!latest)
    body = (
      <div className="small muted" data-testid="never-read">
        Never read. Read now asks the device what it is over SNMPv3 and compares that with the drawing. Nothing on the device is changed.
      </div>
    );
  else {
    const missing = [...latest.failed, ...latest.incomplete];
    body = (
      <>
        <div className="read-meta" data-testid="read-meta">
          Read {when(latest.readAt)} by <b>{who(latest)}</b>, over SNMPv3 <span className="read-ro">(read-only)</span>.
          {latest.durationMs !== null ? ` Took ${(latest.durationMs / 1000).toFixed(1)} s.` : ''}
          {comparison.up + comparison.down > 0 ? ` ${comparison.up} ports up, ${comparison.down} down.` : ''}
          {missing.length ? ` Not all read: ${missing.join(', ')}.` : ''}
          {latest.withheld ? ` ${latest.withheld} value${latest.withheld === 1 ? '' : 's'} that looked like a password ${latest.withheld === 1 ? 'was' : 'were'} withheld.` : ''}
        </div>
        {comparison.differs.length ? (
          <>
            <div className="dev-panel__h">Differs from the drawing · {comparison.differs.length}</div>
            {comparison.differs.map((x) => (
              <DiffRow key={x.field} diff={x} place={place} deviceId={deviceId} canDraw={place.canDraw} />
            ))}
            {all && allCount > 1 && place.canDraw ? (
              <div className="group-acts">
                <button type="button" className="btn-small btn-quiet" onClick={() => place.onEdit(all)} data-testid="accept-all">
                  Accept all {allCount}
                </button>
                {leftOut ? (
                  <span className="small muted" data-testid="accept-all-leaves">
                    Leaves out {leftOut} a plan changes.
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className="small muted">Nothing differs from the drawing.</div>
        )}
        {comparison.matches.length ? (
          <>
            <div className="dev-panel__h">Matches the drawing</div>
            <div className="fold">
              <b>{matchWords(comparison)}</b>
            </div>
          </>
        ) : null}
      </>
    );
  }
  const earlier = panel.status === 'ready' ? panel.value.readings.slice(1) : [];
  return (
    <div className="reading-tab" data-testid="readings-tab">
      {state.busy ? (
        <div className="progress" data-testid="read-progress">
          <span className="now">{state.busy.kind === 'macarp' ? 'Reading the MAC and ARP tables.' : 'Reading system, inventory, interfaces and LLDP neighbours.'}</span>
          <span className="wait">Usually a few seconds. It gives up after 50 seconds and says what it got.</span>
          <span>
            <button type="button" className="btn-small btn-quiet" onClick={() => stopWaiting(place, deviceId)} title="Stops waiting here. What the device answers is still kept.">
              Stop waiting
            </button>
          </span>
        </div>
      ) : null}
      <WorkNote work={d.work} />
      <Refusal d={d} deviceId={deviceId} />
      {d.off && d.off.todo && place.canDraw ? (
        <div className="why-off" data-testid="why-off">
          <div>
            <span className="q">{d.off.head}</span>
            {d.off.todo}
          </div>
        </div>
      ) : null}
      {body}
      {panel.status === 'ready' ? (
        <>
          <div className="dev-panel__h">MAC and ARP</div>
          <MacArp d={d} deviceId={deviceId} />
        </>
      ) : null}
      {earlier.length ? (
        <>
          <div className="dev-panel__h">Earlier readings</div>
          <div className="earlier">
            {earlier.map((r) => (
              <span key={r.id} className="earlier__row">
                <span>{when(r.readAt)}</span>
                <span>by {who(r)}</span>
              </span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ReadDialog({ d, deviceId, kind }: { d: NonNullable<ReturnType<typeof useDevice>>; deviceId: string; kind: ReadKind }) {
  const halt = d.state.halt?.kind === 'confirm' ? d.state.halt : null;
  const [login, setLogin] = useState<string | null>(d.logins.find((l) => l.entry.id === d.state.login)?.entry.id ?? d.logins[0]?.entry.id ?? null);
  const [typed, setTyped] = useState('');
  const close = () => closeDialog(d.place, deviceId);
  const confirmed = halt ? typed.trim().toUpperCase() === lastEight(halt.engineId) : true;
  const read = () => {
    if (!login || !confirmed) return;
    close();
    void readThen(d.place, deviceId, kind, login, halt ? typed.trim().toUpperCase() : null);
  };
  const pairs = halt ? enginePairs(halt.engineId) : [];
  const mark = Math.max(0, pairs.length - 4);
  return (
    <VaultModal title={`Read ${d.hostname ?? 'this device'}`} onClose={close} testId="read-dialog">
      <div className="read-dialog">
        <div className="muted">
          {kind === 'macarp'
            ? `Fathom reads the MAC and ARP tables of ${d.address} over SNMPv3 and changes nothing on it.`
            : `Fathom reads ${d.address} over SNMPv3 and changes nothing on it. What it reads comes back as suggestions here.`}
        </div>
        <div>
          <div className="lbl">Login</div>
          {d.logins.map((l) => (
            <label key={l.entry.id} className={`opt${login === l.entry.id ? ' on' : ''}`}>
              <input type="radio" name="read-login" checked={login === l.entry.id} onChange={() => setLogin(l.entry.id)} />
              <span>
                <b>{l.entry.name}</b> · SNMPv3, {l.entry.snmpAuth ? SNMP_AUTH_LABELS[l.entry.snmpAuth] : ''}, AES <span className="read-ro">· read-only</span>
                <br />
                <span className="sub">{l.from}</span>
              </span>
            </label>
          ))}
          <div className="small muted" style={{ marginTop: 6 }}>
            Only read-only logins, marked on this device or set for its range, are offered.
          </div>
        </div>
        {halt ? (
          <div>
            <div className="lbl">Is this the device you mean?</div>
            <div>
              {halt.state === 'changed'
                ? `This address answered with a different engine ID${halt.previous ? ` than before (…${lastEight(halt.previous)})` : ''}. It may have been replaced or reset. It answered with`
                : "It's the first time Fathom has read this address. It answered with engine ID"}
            </div>
            <div className="engine" data-testid="read-engine">
              {pairs.slice(0, mark).join(' ')} <mark>{pairs.slice(mark).join(' ')}</mark>
            </div>
            <div>
              Type its last 8 characters to confirm:{' '}
              <input className="type8" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Last 8 characters" maxLength={8} data-testid="read-type8" />{' '}
              {confirmed ? <span className="okline">matches</span> : null}
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              A Steward can approve a whole range at once on Device reading.
            </div>
          </div>
        ) : null}
        <div className="acts">
          <button type="button" className="btn-quiet" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn-main" disabled={!login || !confirmed} onClick={read} data-testid="read-go">
            Read
          </button>
        </div>
      </div>
    </VaultModal>
  );
}

export type { DeviceState };

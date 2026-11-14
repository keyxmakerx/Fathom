// Device reading in the device panel (ADR-0082 §5; sign-off r100, all A): Read now in the head
// beside ⋯, a chip and a line under the name, and a Readings tab after Ports with what differs,
// each answered on its own or all at once as one undo step. A dismissed difference stays dismissed
// until the device says something else. Nothing is drawn on the canvas.

import { useContext, useMemo, useState, type ReactNode } from 'react';

import {
  SSH_READ_PLATFORMS,
  configOutputs,
  dismissDifference,
  identityGroups,
  lastEight,
  protocolOf,
  typedEight,
  type DeviceReading,
  type KeptReading,
  type ReadKind,
  type ReadProtocol,
  type ReadRange,
} from '../../api/deviceRead';
import { SNMP_AUTH_LABELS, type VaultEntry } from '../../api/vault';
import { asString, fieldValue, findNode } from '../../document/model';
import { DEVICE_WORDS } from '../drawing/contextMenuItems';
import { VaultModal } from '../vault/Modal';
import { useVault } from '../vault/useVault';
import { acceptAll, acceptable, againstPlan, compare, withWork, type Comparison, type Difference } from './differences';
import { asCsv, macRows, matches } from './macTable';
import { inRange } from './ranges';
import {
  READ_AS_PASTE,
  ReadingContext,
  chooseSshPlatform,
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

/**
 * Read-only logins this device may be read with: marked on it, or set for its range, and copied for Fathom
 * to use. Over SNMP, SNMP logins that name their authentication; over SSH, logins.
 */
export function usableLogins(
  entries: readonly VaultEntry[],
  design: string,
  element: string,
  range: ReadRange | null,
  protocol: ReadProtocol = 'snmp',
): UsableLogin[] {
  const out: UsableLogin[] = [];
  for (const e of entries) {
    if (!e.readOnly || e.fathom?.state !== 'on') continue;
    if (protocol === 'snmp' ? e.kind !== 'snmp' || e.snmpAuth === null : e.kind !== 'login') continue;
    if (e.usedOn.some((u) => u.design === design && u.element === element)) out.push({ entry: e, from: 'Marked on this device' });
    else if (range?.login === e.id) out.push({ entry: e, from: `Set for the range ${range.cidr}` });
  }
  return out;
}

/** The first reason a read can't be pressed, or null when it can. */
export function whyOff(settings: DeviceReading, address: string | null, logins: readonly UsableLogin[], protocol: ReadProtocol = 'snmp'): Off | null {
  if (!settings.on) return { head: 'Reading is off', todo: 'A Steward turns reading on for the organisation on Device reading.' };
  if (!address) return { head: 'No management address', todo: 'Add one on Details › Management.' };
  if (!settings.ranges.some((r) => inRange(address, r.cidr))) return { head: 'Address outside the ranges', todo: `${address} isn't in a range a Steward has listed.` };
  if (logins.length === 0)
    return {
      head: 'No read-only login',
      todo:
        protocol === 'snmp'
          ? 'Mark an SNMP login on this device, or a Steward sets one for its range. It must be ticked "This is a read-only account" and copied for Fathom to use.'
          : 'Mark a login on this device, or a Steward sets one for its range. It must be ticked "This is a read-only account" and copied for Fathom to use.',
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
  // The design's platform; for a device drawn by hand, none until someone chooses one for a configuration read.
  const drawnPlatform = node ? (asString(fieldValue(node.fields, 'Device.platform')) ?? null) : null;
  const platform = drawnPlatform ?? state.sshPlatform;
  const range = address ? (s.ranges.find((r) => inRange(address, r.cidr)) ?? null) : null;
  const entries = vault.load.status === 'ready' ? vault.load.value.entries : [];
  const logins = usableLogins(entries, place.design, deviceId, range);
  const sshLogins = usableLogins(entries, place.design, deviceId, range, 'ssh');
  const loading = vault.load.status === 'loading' ? { head: 'Loading logins', todo: '' } : null;
  const off = loading ?? whyOff(s, address, logins);
  const sshOff = loading ?? whyOff(s, address, sshLogins, 'ssh');
  const latest = state.panel.status === 'ready' ? (state.panel.value.readings[0] ?? null) : null;
  const dismissed = state.panel.status === 'ready' ? state.panel.value.dismissed : [];
  const comparison = withWork(compare(place.doc, deviceId, latest?.reading ?? null, dismissed), work);
  return { place, settings: s, state, address, hostname, platform, drawnPlatform, logins, sshLogins, off, sshOff, latest, comparison, work };
}

type Device = NonNullable<ReturnType<typeof useDevice>>;

/** The logins offered for a kind of read, and why it can't be pressed. */
function forKind(d: Device, kind: ReadKind): { logins: UsableLogin[]; off: Off | null } {
  return protocolOf(kind) === 'ssh' ? { logins: d.sshLogins, off: d.sshOff } : { logins: d.logins, off: d.off };
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
function startRead(d: Device, deviceId: string, kind: ReadKind) {
  const { logins } = forKind(d, kind);
  const last = logins.find((l) => l.entry.id === d.state.login);
  const only = logins.length === 1 ? logins[0] : undefined;
  const readBefore = kind === 'config' ? configsOf(d).length > 0 : d.latest !== null;
  const login = last ?? (readBefore ? only : undefined);
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
  if (d.state.busy)
    return (
      <div className="read-line" data-testid="read-line">
        Reading {d.address} over {d.state.busy.kind === 'config' ? 'SSH' : 'SNMPv3'}…
      </div>
    );
  // The newest read of any kind: the device's details, or its configuration over SSH.
  const config = configsOf(d)[0] ?? null;
  const newest = d.latest && (!config || d.latest.readAt >= config.readAt) ? d.latest : config;
  if (!newest) return d.state.panel.status === 'ready' ? <div className="read-line" data-testid="read-line">Never read</div> : null;
  return (
    <div className="read-line" data-testid="read-line">
      Read <b>{when(newest.readAt)}</b> by <b>{who(newest)}</b>
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

/** "14:05", in this person's own time. */
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Refusal({ d, deviceId }: { d: Device; deviceId: string }) {
  const halt = d.state.halt;
  if (!halt || halt.kind !== 'failed') return null;
  const again = () => startRead(d, deviceId, halt.read);
  const identity = halt.identity;
  if ((halt.code === 'engine_changed' || halt.code === 'host_key_changed') && identity) {
    const p = identity.protocol;
    return (
      <div className="read-fail" role="alert" data-testid="read-fail">
        <b>Not read: this isn't the device Fathom read before</b>
        <span>
          Its {p === 'ssh' ? 'SSH host key' : 'engine ID'} changed{halt.previous ? ` from …${lastEight(p, halt.previous)}` : ''} to …
          {lastEight(p, identity.value)}. It may have been replaced or reset{p === 'ssh' ? ', or something else is answering at its address' : ''}. Nothing was
          sent to it.
        </span>
        {d.place.canDraw ? (
          <span>
            <button
              type="button"
              className="btn-small"
              onClick={() => openDialog(d.place, deviceId, halt.read, { kind: 'confirm', identity, state: 'changed', previous: halt.previous })}
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
  const waiting = halt.code === 'cooling_down';
  // A refused login waits before Fathom sends it to this device again (r117, finding 10).
  const at = halt.retryAt != null ? clockTime(halt.retryAt) : null;
  return (
    <div className="read-fail" role="alert" data-testid="read-fail">
      <b>
        {refusedLogin
          ? 'Not read: the login was refused'
          : busyElsewhere
            ? 'Not read: someone is reading it now'
            : waiting
              ? 'Not read: waiting after a refused login'
              : 'Not read'}
      </b>
      <span>
        {refusedLogin
          ? protocolOf(halt.read) === 'ssh'
            ? 'The device answered SSH but refused this login. It was tried once and not again. Check the user and the password or key on the login.'
            : 'The device answered SNMP but not this login. Check its privacy password and authentication on the login.'
          : halt.message}
      </span>
      {(refusedLogin || waiting) && at ? (
        <span className="small muted" data-testid="read-wait">
          {refusedLogin
            ? `So repeated tries cannot lock the device’s account, Fathom sends this login to it again after ${at}, or straight away once the login is changed in the vault.`
            : `Nothing was sent. Fathom sends this login to it again after ${at}.`}
        </span>
      ) : null}
      {d.place.canDraw ? (
        <span>
          {waiting ? null : (
            <>
              <button type="button" className="btn-small" onClick={again}>
                Try again
              </button>{' '}
            </>
          )}
          {refusedLogin || waiting ? (
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

function MacArp({ d, deviceId }: { d: Device; deviceId: string }) {
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

/** The configurations read over SSH, newest first. */
function configsOf(d: Device): KeptReading[] {
  return d.state.panel.status === 'ready' ? d.state.panel.value.configs : [];
}

/** The platforms Fathom reads a configuration from, as a person says them: "Juniper SRX, Juniper EX and Arista EOS". */
function sshPlatformWords(): string {
  const w = Object.values(SSH_READ_PLATFORMS).map((p) => p.words);
  return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}` : (w[0] ?? '');
}

/** The configuration, read over SSH with the platform's fixed commands (ADR-0082 §4.1), and read by the paste readers on request. */
function Configuration({ d, deviceId }: { d: Device; deviceId: string }) {
  const [copied, setCopied] = useState(false);
  const known = d.platform ? SSH_READ_PLATFORMS[d.platform] : undefined;
  const configs = configsOf(d);
  const latest = configs[0] ?? null;
  const busy = d.state.busy?.kind === 'config';
  if (d.drawnPlatform && !known) {
    return (
      <div className="small muted" data-testid="config-unknown">
        Fathom reads a configuration over SSH from {sshPlatformWords()} so far. There is no fixed list of commands for {d.drawnPlatform} yet.
      </div>
    );
  }
  // A device drawn by hand says no platform: the person says which, for this read. A pasted one carries its own.
  const choose =
    !d.drawnPlatform && d.place.canDraw ? (
      <div className="config-platform" data-testid="config-platform">
        <span className="lbl">What is it?</span>
        {Object.entries(SSH_READ_PLATFORMS).map(([id, p]) => (
          <label key={id} className={`opt-inline${d.platform === id ? ' on' : ''}`}>
            <input type="radio" name={`ssh-platform-${deviceId}`} checked={d.platform === id} onChange={() => chooseSshPlatform(d.place, deviceId, id)} />
            {p.words}
          </label>
        ))}
        <span className="small muted">It decides which read-only command runs. A pasted configuration says it for itself.</span>
      </div>
    ) : null;
  if (!known) {
    return (
      <>
        {choose ?? (
          <div className="small muted" data-testid="config-unknown">
            Fathom reads a configuration over SSH from {sshPlatformWords()} so far. This device doesn't say which it is yet.
          </div>
        )}
      </>
    );
  }
  const commands = known.commands.map((c) => `“${c}”`).join(' and ');
  const readButton = (label: string) =>
    d.place.canDraw ? (
      <button type="button" className="btn-small" disabled={d.state.busy !== null || d.sshOff !== null} onClick={() => startRead(d, deviceId, 'config')} data-testid="read-config">
        {busy ? 'Reading…' : label}
      </button>
    ) : null;
  const off =
    d.sshOff && d.sshOff.todo && d.place.canDraw && !d.off ? (
      <div className="why-off" data-testid="why-off-ssh">
        <div>
          <span className="q">{d.sshOff.head}</span>
          {d.sshOff.todo}
        </div>
      </div>
    ) : null;
  const outputs = configOutputs(latest?.reading ?? null);
  if (!latest || outputs.length === 0) {
    return (
      <>
        {choose}
        {off}
        <div className="small muted" data-testid="config-never">
          Not read yet. Fathom logs in over SSH once and runs only {commands}. Nothing on the device is changed, and passwords in it are removed
          before it leaves the reader.
        </div>
        <div>{readButton('Read the configuration')}</div>
      </>
    );
  }
  const text = outputs.map((o) => o.text).join('\n');
  const drops = outputs.reduce((n, o) => n + o.drops, 0);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const compare = () => window.dispatchEvent(new CustomEvent(READ_AS_PASTE, { detail: { text, platform: d.platform } }));
  return (
    <>
      {off}
      <div className="read-meta" data-testid="config-meta">
        Read <b>{when(latest.readAt)}</b> by <b>{who(latest)}</b>, over SSH <span className="read-ro">(read-only)</span>
        {latest.hostKey ? (
          <>
            , host key <span className="m">…{lastEight('ssh', latest.hostKey)}</span>
          </>
        ) : null}
        .{drops ? ` ${drops} password${drops === 1 ? '' : 's'} removed before it left the reader.` : ''}
        {latest.withheld ? ` ${latest.withheld} more line${latest.withheld === 1 ? '' : 's'} withheld by the second check.` : ''}
      </div>
      {outputs.map((o) => (
        <div key={o.command} className="config-out">
          <div className="config-out__cmd">
            <span className="m">{o.command}</span>
            {o.incomplete ? <span className="muted"> · cut short: the device printed more than Fathom keeps, or the connection ended early</span> : null}
            {o.exit !== null && o.exit !== 0 ? <span className="muted"> · the device said it did not finish (exit {o.exit})</span> : null}
          </div>
          <pre className="config-text" data-testid="config-text">
            {o.text}
          </pre>
        </div>
      ))}
      <div>
        {readButton('Read again')}{' '}
        {d.place.canDraw ? (
          <button type="button" className="btn-small btn-quiet" onClick={compare} data-testid="config-compare" title="Reads it as a pasted configuration: the same card, nothing changed until you choose.">
            Compare with the drawing
          </button>
        ) : null}{' '}
        <button type="button" className="btn-small btn-quiet" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {configs.length > 1 ? (
        <div className="small muted" data-testid="config-earlier">
          Read before {configs
            .slice(1)
            .map((c) => when(c.readAt))
            .join(', ')}
          .
        </div>
      ) : null}
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
        {configsOf(d).length ? "Its details haven't been read yet." : 'Never read.'} Read now asks the device what it is over SNMPv3 and compares that with the drawing. Nothing on the device is changed.
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
          <span className="now">
            {state.busy.kind === 'macarp'
              ? 'Reading the MAC and ARP tables.'
              : state.busy.kind === 'config'
                ? 'Reading the configuration over SSH.'
                : 'Reading system, inventory, interfaces and LLDP neighbours.'}
          </span>
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
          <div className="dev-panel__h">Configuration</div>
          <Configuration d={d} deviceId={deviceId} />
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

function ReadDialog({ d, deviceId, kind }: { d: Device; deviceId: string; kind: ReadKind }) {
  const protocol = protocolOf(kind);
  // A confirmation is for this kind's protocol only: an SNMP agent is never confirmed from an SSH read.
  const halt = d.state.halt?.kind === 'confirm' && d.state.halt.identity.protocol === protocol ? d.state.halt : null;
  const { logins } = forKind(d, kind);
  const [login, setLogin] = useState<string | null>(logins.find((l) => l.entry.id === d.state.login)?.entry.id ?? logins[0]?.entry.id ?? null);
  const [typed, setTyped] = useState('');
  const close = () => closeDialog(d.place, deviceId);
  const confirmed = halt ? typedEight(protocol, typed) === lastEight(protocol, halt.identity.value) : true;
  const read = () => {
    if (!login || !confirmed) return;
    close();
    void readThen(d.place, deviceId, kind, login, halt ? typedEight(protocol, typed) : null);
  };
  const groups = halt ? identityGroups(halt.identity) : [];
  // The last 8 characters: four pairs of an engine id, two groups of four of a host key.
  const mark = Math.max(0, groups.length - (protocol === 'ssh' ? 2 : 4));
  const what = protocol === 'ssh' ? 'SSH host key' : 'engine ID';
  return (
    <VaultModal title={`Read ${d.hostname ?? 'this device'}`} onClose={close} testId="read-dialog">
      <div className="read-dialog">
        <div className="muted">
          {kind === 'macarp'
            ? `Fathom reads the MAC and ARP tables of ${d.address} over SNMPv3 and changes nothing on it.`
            : kind === 'config'
              ? `Fathom logs in to ${d.address} over SSH once and runs only ${(d.platform ? (SSH_READ_PLATFORMS[d.platform]?.commands ?? []) : []).map((c) => `“${c}”`).join(' and ')}. It changes nothing on it, and passwords in what it prints are removed before it leaves the reader.`
              : `Fathom reads ${d.address} over SNMPv3 and changes nothing on it. What it reads comes back as suggestions here.`}
        </div>
        <div>
          <div className="lbl">Login</div>
          {logins.map((l) => (
            <label key={l.entry.id} className={`opt${login === l.entry.id ? ' on' : ''}`}>
              <input type="radio" name="read-login" checked={login === l.entry.id} onChange={() => setLogin(l.entry.id)} />
              <span>
                <b>{l.entry.name}</b> ·{' '}
                {protocol === 'ssh' ? 'SSH login' : `SNMPv3, ${l.entry.snmpAuth ? SNMP_AUTH_LABELS[l.entry.snmpAuth] : ''}, AES`}{' '}
                <span className="read-ro">· read-only</span>
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
                ? `This address answered with a different ${what}${halt.previous ? ` than before (…${lastEight(protocol, halt.previous)})` : ''}. It may have been replaced or reset. It answered with`
                : `It's the first time Fathom has read this address${protocol === 'ssh' ? ' over SSH' : ''}. It answered with ${what}`}
              {protocol === 'ssh' && halt.identity.keyType ? ` (${halt.identity.keyType})` : ''}
            </div>
            <div className="engine" data-testid="read-engine">
              {groups.slice(0, mark).join(' ')} <mark>{groups.slice(mark).join(' ')}</mark>
            </div>
            {protocol === 'ssh' ? (
              <div className="small muted">
                Check it against the device itself, for example from its console. No login was sent and nothing ran.
              </div>
            ) : null}
            <div>
              Type its last 8 characters to confirm{protocol === 'ssh' ? ', capitals as shown' : ''}:{' '}
              <input
                className="type8"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label="Last 8 characters"
                maxLength={8}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-testid="read-type8"
              />{' '}
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

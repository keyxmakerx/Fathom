// The pages beside the Prefixes and VLANs tables (brief: round 9, r9-ipam-a). A prefix page is a
// picture of the range over a list of its addresses; both are read off the devices, and anything
// typed here is written to a device interface (document/ipam-write.ts). No risk colours: a full
// range is just full.

import { useMemo, useState, type ReactNode } from 'react';

import { GRID_CELLS, buildGrid, formatIpv4, freeRuns, parseCidr, prefixText, rangeOf, usedIn, vlanLabel, type AddressEntry, type PrefixRow, type VlanKindRow } from '../../document/ipam';
import { IpamRefusal, NEEDS_OWNER, addAddress, addVlanOnDevice, deviceChoices, interfaceChoices, type OwnerChoice } from '../../document/ipam-write';
import type { Document } from '../../document/model';
import { detachAddress } from '../../document/networks';

type Actor = { actor: string } | undefined;

const LIST_CAP = 300;

function refusalText(e: unknown): string {
  return e instanceof Error ? e.message : 'That was refused.';
}

// ---------------------------------------------------------------------------
// Choosing where something lives

interface OwnerState {
  deviceId: string;
  ownerValue: string;
}

const NO_OWNER: OwnerState = { deviceId: '', ownerValue: '' };

function OwnerFields({ doc, state, onChange, needInterface }: { doc: Document; state: OwnerState; onChange: (s: OwnerState) => void; needInterface: boolean }) {
  const devices = useMemo(() => deviceChoices(doc), [doc]);
  const choices = useMemo(() => (state.deviceId ? interfaceChoices(doc, state.deviceId) : []), [doc, state.deviceId]);
  return (
    <>
      <label className="ipam-form__field">
        <span>Device</span>
        <select value={state.deviceId} onChange={(e) => onChange({ deviceId: e.currentTarget.value, ownerValue: '' })}>
          <option value="">Choose a device</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {needInterface ? (
        <label className="ipam-form__field">
          <span>Interface</span>
          <select value={state.ownerValue} disabled={!state.deviceId} onChange={(e) => onChange({ ...state, ownerValue: e.currentTarget.value })}>
            <option value="">{state.deviceId && choices.length === 0 ? 'No interface or port on this device' : 'Choose an interface'}</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}

function ownerOf(doc: Document, s: OwnerState): OwnerChoice | null {
  return s.deviceId && s.ownerValue ? (interfaceChoices(doc, s.deviceId).find((c) => c.value === s.ownerValue) ?? null) : null;
}

/** A bare host like 10.0.20.17 takes the mask of the prefix it goes in. */
function withMask(address: string, len: number | undefined): string {
  const a = address.trim();
  return len !== undefined && a !== '' && !a.includes('/') ? `${a}/${len}` : a;
}

// ---------------------------------------------------------------------------
// Add forms

export function AddPrefixForm(props: { doc: Document; actor: Actor; onDone: (doc: Document, key: string) => void; onCancel: () => void }) {
  const { doc, actor, onDone, onCancel } = props;
  const [prefix, setPrefix] = useState('');
  const [address, setAddress] = useState('');
  const [owner, setOwner] = useState<OwnerState>(NO_OWNER);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    try {
      const typed = parseCidr(prefix);
      if (!typed || !prefix.includes('/')) throw new IpamRefusal('Write the prefix like 10.0.40.0/24.');
      const choice = ownerOf(doc, owner);
      if (!choice) throw new IpamRefusal(NEEDS_OWNER);
      if (!address.trim()) throw new IpamRefusal(`${NEEDS_OWNER} Give the address it has there.`);
      const canonical = prefixText(rangeOf(typed.ip, typed.len));
      const next = addAddress(doc, { prefix: canonical, address: withMask(address, typed.len), owner: choice }, actor);
      onDone(next, `prefix:${canonical}`);
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <aside className="shell-editor inv-page ipam-page" aria-label="Add a prefix">
      <div className="inv-page__head">
        <span className="inv-page__title">Add a prefix</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <form
        className="inv-page__body ipam-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="inv-page__muted">A prefix is the addresses on devices. Give it the first one and where it lives.</p>
        <label className="ipam-form__field">
          <span>Prefix</span>
          <input value={prefix} placeholder="10.0.40.0/24" onChange={(e) => setPrefix(e.currentTarget.value)} autoFocus />
        </label>
        <label className="ipam-form__field">
          <span>Address</span>
          <input value={address} placeholder="10.0.40.1" onChange={(e) => setAddress(e.currentTarget.value)} />
        </label>
        <OwnerFields doc={doc} state={owner} onChange={setOwner} needInterface />
        {error ? (
          <p className="ipam-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <button type="submit">Add prefix</button>
        </div>
      </form>
    </aside>
  );
}

export function AddVlanForm(props: { doc: Document; actor: Actor; onDone: (doc: Document) => void; onCancel: () => void }) {
  const { doc, actor, onDone, onCancel } = props;
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState<OwnerState>(NO_OWNER);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    try {
      if (!/^\d+$/.test(id.trim())) throw new IpamRefusal('A VLAN number is 1 to 4094.');
      onDone(addVlanOnDevice(doc, { vlanId: Number(id), name: name.trim(), deviceId: owner.deviceId || null }, actor));
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <aside className="shell-editor inv-page ipam-page" aria-label="Add a VLAN">
      <div className="inv-page__head">
        <span className="inv-page__title">Add a VLAN</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <form
        className="inv-page__body ipam-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="inv-page__muted">A VLAN is kept on a device. Ports join it from the canvas or Networks.</p>
        <label className="ipam-form__field">
          <span>VLAN number</span>
          <input value={id} placeholder="30" inputMode="numeric" onChange={(e) => setId(e.currentTarget.value)} autoFocus />
        </label>
        <label className="ipam-form__field">
          <span>Name</span>
          <input value={name} placeholder="Cameras" onChange={(e) => setName(e.currentTarget.value)} />
        </label>
        <OwnerFields doc={doc} state={owner} onChange={setOwner} needInterface={false} />
        {error ? (
          <p className="ipam-form__error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <button type="submit">Add VLAN</button>
        </div>
      </form>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The prefix page

export interface PrefixPageProps {
  doc: Document;
  row: PrefixRow;
  actor: Actor;
  canDraw: boolean;
  applyDocChange: (next: Document) => void;
  /** HOOK (#97): the duplicate-address "Why?" card plugs in here; nothing is drawn until it exists. */
  renderWhy?: (entry: AddressEntry, row: PrefixRow) => ReactNode;
}

type ListItem = { kind: 'address'; at: number; entry: AddressEntry } | { kind: 'free'; at: number; from: number; to: number; first: boolean };

function listItems(row: PrefixRow): ListItem[] {
  const range = row.range;
  const items: ListItem[] = row.entries.map((entry) => ({ kind: 'address' as const, at: entry.ipNum ?? 0, entry }));
  if (range) {
    const used = usedIn(range, row.entries.flatMap((e) => (e.ipNum === undefined ? [] : [e.ipNum])));
    freeRuns(range, used).forEach((r, i) => items.push({ kind: 'free', at: r.from - 0.5, from: r.from, to: r.to, first: i === 0 }));
  }
  return items.sort((a, b) => a.at - b.at);
}

function freeText(from: number, to: number): string {
  if (from === to) return formatIpv4(from);
  const a = formatIpv4(from).split('.');
  const b = formatIpv4(to).split('.');
  // 10.0.20.17–254 when only the last number differs, else both ends in full.
  return a.slice(0, 3).join('.') === b.slice(0, 3).join('.') ? `${formatIpv4(from)}–${b[3]}` : `${formatIpv4(from)}–${formatIpv4(to)}`;
}

export function PrefixPage(props: PrefixPageProps) {
  const { doc, row, actor, canDraw, applyDocChange, renderWhy } = props;
  const [showAll, setShowAll] = useState(false);
  const [address, setAddress] = useState('');
  const [owner, setOwner] = useState<OwnerState>(NO_OWNER);
  const [error, setError] = useState<string | null>(null);

  const range = row.range;
  const grid = useMemo(() => {
    if (!range) return null;
    const ips = row.entries.flatMap((e) => (e.ipNum === undefined ? [] : [e.ipNum]));
    const onTwo = new Set(row.entries.flatMap((e) => (e.alsoOn.length > 0 && e.ipNum !== undefined ? [e.ipNum] : [])));
    return buildGrid(range, usedIn(range, ips), onTwo);
  }, [range, row.entries]);
  const items = useMemo(() => listItems(row), [row]);
  const shown = showAll ? items : items.slice(0, LIST_CAP);

  const fullNote = row.readable && row.nextFree === null && row.total > 0 ? ` All ${row.total} are in use.` : '';
  const vlan = row.vlan ? `VLAN ${vlanLabel(row.vlan)}` : null;
  const sub = [vlan, row.sites.join(', ')].filter(Boolean).join(' · ');

  const submit = () => {
    try {
      const choice = ownerOf(doc, owner);
      applyDocChange(addAddress(doc, { prefix: row.prefix, address: withMask(address, range?.len), owner: choice }, actor));
      setAddress('');
      setError(null);
    } catch (e) {
      setError(refusalText(e));
    }
  };

  return (
    <aside className="shell-editor inv-page ipam-page" aria-label={`${row.prefix} page`}>
      <div className="inv-page__head">
        <span className="inv-page__title">{row.prefix}</span>
      </div>
      <div className="inv-page__body">
        {sub ? <p className="inv-page__muted ipam-sub">{sub}</p> : null}
        {!range ? (
          <p className="inv-page__muted">Fathom reads IPv4 ranges only so far. This address is listed as written.</p>
        ) : (
          <>
            <p className="ipam-summary">
              <b>
                {row.used}/{row.total}
              </b>{' '}
              used{row.nextFree ? ` · next free ${row.nextFree}` : ''}.{fullNote}
            </p>
            {grid ? (
              <>
                <div
                  className="ipam-grid"
                  role="img"
                  aria-label={`${row.prefix}: ${row.used} of ${row.total} addresses used`}
                  data-cells={grid.cells.length}
                  style={{ gridTemplateColumns: `repeat(${grid.cells.length <= 64 ? 16 : 32}, 1fr)` }}
                >
                  {grid.cells.map((c) => (
                    <span
                      key={c.start}
                      className={`ipam-grid__cell ipam-grid__cell--${c.state}`}
                      data-state={c.state}
                      title={
                        grid.perCell === 1
                          ? `${formatIpv4(c.start)}${c.state === 'free' ? ' · free' : c.state === 'shared' ? ' · on two devices' : ' · used'}`
                          : `${formatIpv4(c.start)}+${grid.perCell - 1} · ${c.used} of ${c.covers} used`
                      }
                    />
                  ))}
                </div>
                <p className="inv-page__muted ipam-legend">
                  <span className="ipam-grid__cell ipam-grid__cell--used" /> used <span className="ipam-grid__cell ipam-grid__cell--free" /> free{' '}
                  <span className="ipam-grid__cell ipam-grid__cell--shared" /> on two devices
                  {grid.perCell > 1 ? ` · each square is ${grid.perCell.toLocaleString('en-GB')} addresses (${GRID_CELLS} squares)` : ''}
                </p>
              </>
            ) : null}
          </>
        )}

        <h3 className="ipam-h">Addresses</h3>
        <ul className="ipam-list" aria-label="Addresses">
          <li className="ipam-list__head" aria-hidden="true">
            <span>Address</span>
            <span>On</span>
            <span>From</span>
          </li>
          {shown.map((it) =>
            it.kind === 'free' ? (
              <li key={`free-${it.from}`} className="ipam-list__row ipam-list__row--free">
                <span className="inv-page__mono">{freeText(it.from, it.to)}</span>
                <span>free{it.first && row.nextFree ? ` · next free ${row.nextFree}` : ''}</span>
                <span />
              </li>
            ) : (
              <li key={it.entry.addressNodeId} className="ipam-list__row">
                <span className="inv-page__mono">{it.entry.ip}</span>
                <span>
                  {it.entry.deviceName} {it.entry.interfaceLabel}
                  {it.entry.alsoOn.length > 0 ? (
                    <>
                      {' · '}
                      <b>also on {it.entry.alsoOn.join(', ')}</b>
                    </>
                  ) : null}
                </span>
                <span>
                  {it.entry.alsoOn.length > 0 ? (
                    <>
                      Check: same address twice{renderWhy ? <> · {renderWhy(it.entry, row)}</> : null}
                    </>
                  ) : (
                    it.entry.source
                  )}
                  {canDraw ? (
                    <button
                      type="button"
                      className="ipam-list__remove"
                      aria-label={`Remove ${it.entry.ip} from ${it.entry.deviceName}`}
                      onClick={() => applyDocChange(detachAddress(doc, it.entry.addressNodeId, actor))}
                    >
                      Remove
                    </button>
                  ) : null}
                </span>
              </li>
            ),
          )}
        </ul>
        {items.length > shown.length ? (
          <button type="button" onClick={() => setShowAll(true)}>
            Show all {items.length}
          </button>
        ) : null}

        {canDraw && range ? (
          <form
            className="ipam-form ipam-form--inline"
            aria-label="Add an address"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <h3 className="ipam-h">Add an address</h3>
            <label className="ipam-form__field">
              <span>Address</span>
              <input value={address} placeholder={row.nextFree ?? 'no free address'} onChange={(e) => setAddress(e.currentTarget.value)} />
            </label>
            <OwnerFields doc={doc} state={owner} onChange={setOwner} needInterface />
            {error ? (
              <p className="ipam-form__error" role="alert">
                {error}
              </p>
            ) : null}
            <div>
              <button type="submit">Add address</button>
            </div>
          </form>
        ) : null}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The VLAN page

export function VlanPage(props: { doc: Document; row: VlanKindRow; actor: Actor; canDraw: boolean; applyDocChange: (next: Document) => void }) {
  const { doc, row, actor, canDraw, applyDocChange } = props;
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const others = useMemo(() => deviceChoices(doc).filter((d) => !row.deviceIds.includes(d.id)), [doc, row.deviceIds]);
  const title = row.name ? `VLAN ${row.vlanId} · ${row.name}` : `VLAN ${row.vlanId}`;
  const add = () => {
    try {
      applyDocChange(addVlanOnDevice(doc, { vlanId: row.vlanId, name: row.name, deviceId: deviceId || null }, actor));
      setDeviceId('');
      setError(null);
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <aside className="shell-editor inv-page ipam-page" aria-label={`${title} page`}>
      <div className="inv-page__head">
        <span className="inv-page__title">{title}</span>
      </div>
      <div className="inv-page__body">
        {row.description ? <p className="inv-page__muted">{row.description}</p> : null}
        <p className="ipam-summary">
          {row.prefixes.length > 0 ? (
            <>
              Prefixes: <span className="inv-page__mono">{row.prefixes.join(', ')}</span>
            </>
          ) : (
            'No prefix is on this VLAN yet.'
          )}
          {row.sites.length > 0 ? ` · ${row.sites.join(', ')}` : ''}
        </p>
        <h3 className="ipam-h">On devices</h3>
        <ul className="inv-page__list">
          {row.deviceNames.map((n, i) => (
            <li key={`${n}-${i}`}>{n}</li>
          ))}
        </ul>
        <h3 className="ipam-h">Members</h3>
        <ul className="inv-page__list">
          {row.members.length === 0 ? <li className="inv-page__muted">No port is on this VLAN yet.</li> : null}
          {row.members.map((m, i) => (
            <li key={i}>
              <span>
                {m.deviceName} {m.interfaceLabel}
              </span>
              <span className="inv-page__muted">{m.mode === 'trunk' ? 'tagged' : m.mode === 'access' ? 'untagged' : ''}</span>
            </li>
          ))}
        </ul>
        {canDraw && others.length > 0 ? (
          <form
            className="ipam-form ipam-form--inline"
            aria-label="Put this VLAN on another device"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <h3 className="ipam-h">Put it on another device</h3>
            <label className="ipam-form__field">
              <span>Device</span>
              <select value={deviceId} onChange={(e) => setDeviceId(e.currentTarget.value)}>
                <option value="">Choose a device</option>
                {others.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {error ? (
              <p className="ipam-form__error" role="alert">
                {error}
              </p>
            ) : null}
            <div>
              <button type="submit">Add to device</button>
            </div>
          </form>
        ) : null}
      </div>
    </aside>
  );
}

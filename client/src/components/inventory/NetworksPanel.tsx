// ADR-0058 — the Networks kind in Inventory: the list per board A
// (`design/proposals/networks/A-inventory-list.dc.html`) and the Add network
// editor for VLAN and Subnet. Docker is present as a chip but writes nothing
// (Docker networks: not yet, ADR-0058 A2) — its section renders an honest
// empty state rather than a grid with nothing behind it.
//
// The grid is a CSS grid of flat children (`networks.css`'s header note),
// board A's technique — never an HTML `<table>`, whose column widths a
// grouped list's colSpan header row breaks. The editor's rows use
// `.networks-editor__*` classes, the table `.networks-grid__*` — kept
// separate: sharing one class caused a layout bug.
//
// This panel calls `document/networks.ts` directly and hands the result to
// `applyDocChange` — it does not go through `EditorChange`/`EditorActions`
// (`drawing/contract.ts`): a network row is not a `Selection` (it can span
// several nodes, or none yet), and Undo/Redo already work off any batch in
// `doc.batches` regardless of which module wrote it (ADR-0053), so nothing
// here needs wiring for either.
//
// Attaching a SECOND device to an established VLAN id or subnet prefix
// reuses `addVlan`/`addSubnet` directly, called again with the new device —
// neither refuses an id/prefix that already exists elsewhere, only a
// duplicate on the SAME device — so this panel's one "Add network" action
// covers both "create" and "attach another device." `attachToVlan`/
// `attachToSubnet` exist as library functions (tested) for a caller that
// wants the stronger "refuse unless it already exists" reading; no separate
// UI control calls them yet.

import { useMemo, useState } from 'react';

import { UNNAMED_HOSTNAME } from '../drawing/contract';
import { edgesOut, findNode, parseNodeId, readDeviceFields, readPhysicalPortFields, type Document } from '../../document/model';
import type { ClosetView } from '../../document/view';
import {
  NetworkRefusalError,
  addSubnet,
  addVlan,
  detachAddress,
  detachVlanMember,
  removeSubnetNetwork,
  removeVlanNetwork,
  type NetworkAttachTarget,
} from '../../document/networks';
import { trunkVlanIdsOf, type NetworksDerived, type SubnetRow, type VlanMemberRow, type VlanRow } from '../../document/networks-derive';
import { getSession } from '../../state/sessionState';
import { formatLastChange } from './rows';
import './networks.css';

export interface NetworksPanelProps {
  doc: Document;
  derived: NetworksDerived;
  /** A cable's "· R1 U5" comes from its near member's rack placement, the
   * same `ClosetView` `InventoryPlace.tsx` already builds for every other
   * kind (free here, never recomputed). */
  view: ClosetView;
  applyDocChange: (next: Document) => void;
  canDraw: boolean;
}

type Chip = 'all' | 'vlan' | 'subnet' | 'docker' | 'unattached';

/** ADR-0053 §3's "you undo your own changes" — every write below is
 * stamped with the signed-in account's ulid, the same read `useDesignSession.ts`'s
 * `handleEdit` makes for every `EditorChange`, so `document/undo.ts`'s
 * `undoable` finds a batch this panel wrote. Without this every write here
 * would fall back to `LOCAL_ACTOR` and never appear as "mine" to undo. */
function actorOpts(): { actor: string } | undefined {
  const accountId = getSession()?.accountId;
  return accountId !== undefined ? { actor: accountId } : undefined;
}

function deviceHostname(doc: Document, deviceId: string): string {
  const n = findNode(doc, deviceId);
  return (n && readDeviceFields(n).hostname) || UNNAMED_HOSTNAME;
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** `view.racks`, once per lookup — no index built for it: a Networks list
 * only ever renders the cable text of whichever member rows are actually
 * open on screen, never the whole document at once. */
function rackPositionOf(view: ClosetView, deviceId: string | undefined): string | undefined {
  if (!deviceId) return undefined;
  for (const rack of view.racks) {
    const chassis = rack.chassis.find((c) => c.deviceId === deviceId);
    if (chassis && chassis.placement.kind === 'rack') return `${rack.label} U${chassis.placement.positionU}`;
  }
  return undefined;
}

/** The board's words for a member's cable — its type and colour, sentence
 * case ("Blue Cat6"), with the near member's rack position where known
 * ("· R1 U5") — else the bare word "cable". Never the raw node id: a `Cable`
 * rarely carries `Cable.label` at all, and an unlabelled cable would
 * otherwise show as "cable:01M3…" in open rows. */
function cableText(doc: Document, view: ClosetView, cableId: string | undefined, nearDeviceId: string | undefined): string | undefined {
  if (!cableId) return undefined;
  const n = findNode(doc, cableId);
  if (!n || n.absentSince !== undefined) return undefined;
  const sheath = n.fields['Cable.sheath'];
  const media = n.fields['Cable.media'];
  const parts: string[] = [];
  if (sheath && sheath.presence === 'set' && typeof sheath.value === 'string') parts.push(capitalizeFirst(sheath.value));
  if (media && media.presence === 'set' && typeof media.value === 'string') parts.push(capitalizeFirst(media.value));
  const base = parts.length > 0 ? parts.join(' ') : 'cable';
  const where = rackPositionOf(view, nearDeviceId);
  return where ? `${base} · ${where}` : base;
}

/** The board's "switch port" / "trunk · 10, 20" role text for a VLAN
 * member's role column. */
function roleText(doc: Document, m: VlanMemberRow): string {
  if (m.mode === 'trunk') {
    const ids = trunkVlanIdsOf(doc, m.unitId);
    return ids.length > 0 ? `trunk · ${ids.join(', ')}` : 'trunk';
  }
  if (m.mode === 'access') return 'switch port';
  return m.isGateway ? 'gateway' : '—';
}

interface PortOption {
  id: string;
  label: string;
}

function liveDevices(doc: Document): Array<{ id: string; hostname: string }> {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device')
    .map((n) => ({ id: n.id, hostname: deviceHostname(doc, n.id) }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function portsOfDevice(doc: Document, deviceId: string): PortOption[] {
  const chassisId = edgesOut(doc, deviceId, 'HasChassis')[0]?.to;
  if (!chassisId) return [];
  return edgesOut(doc, chassisId, 'HasPort')
    .map((e) => findNode(doc, e.to))
    .filter((n): n is NonNullable<typeof n> => n !== undefined && n.absentSince === undefined)
    .map((n) => ({ id: n.id, label: readPhysicalPortFields(n).label ?? n.id }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The Add network editor — closed until "Add network" is clicked; multiple
// attach rows per action ("Attach interfaces · N chosen", "+ another
// interface"), board A's picture.

interface AttachRow {
  key: number;
  deviceId: string;
  portId: string;
  interfaceName: string;
  tagged: boolean;
  gateway: boolean;
  addressText: string;
}

function blankAttachRow(key: number): AttachRow {
  return { key, deviceId: '', portId: '', interfaceName: '', tagged: false, gateway: false, addressText: '' };
}

interface FormState {
  kind: 'vlan' | 'subnet';
  name: string;
  vlanIdText: string;
  subnetText: string;
  gatewayAddressText: string;
  rows: AttachRow[];
}

function emptyForm(): FormState {
  return { kind: 'vlan', name: '', vlanIdText: '', subnetText: '', gatewayAddressText: '', rows: [blankAttachRow(0)] };
}

function AddNetworkEditor(props: { doc: Document; applyDocChange: (next: Document) => void; onClose: () => void }) {
  const { doc, applyDocChange, onClose } = props;
  const [form, setForm] = useState<FormState>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const nextKey = useState(() => ({ n: 1 }))[0];

  const devices = useMemo(() => liveDevices(doc), [doc]);
  const chosen = form.rows.filter((r) => r.deviceId).length;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function updateRow(rowKey: number, patch: Partial<AttachRow>) {
    setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === rowKey ? { ...r, ...patch } : r)) }));
  }

  function addRow() {
    setForm((f) => ({ ...f, rows: [...f.rows, blankAttachRow(nextKey.n++)] }));
  }

  function removeRow(rowKey: number) {
    setForm((f) => ({ ...f, rows: f.rows.length > 1 ? f.rows.filter((r) => r.key !== rowKey) : f.rows }));
  }

  function choosePort(rowKey: number, doc2: Document, deviceId: string, portId: string) {
    const port = portsOfDevice(doc2, deviceId).find((p) => p.id === portId);
    updateRow(rowKey, { portId, interfaceName: port ? port.label : '' });
  }

  function submit() {
    setError(null);
    try {
      const used = form.rows.filter((r) => r.deviceId && r.portId);
      if (form.kind === 'vlan') {
        const vlanId = Number(form.vlanIdText);
        if (used.length === 0) throw new Error('attach at least one interface, or choose "on" with no port for a bare VLAN');
        const target = (r: AttachRow): NetworkAttachTarget => ({ kind: 'port', portId: r.portId, interfaceName: r.interfaceName || r.portId });
        const next = addVlan(
          doc,
          {
            vlanId,
            name: form.name || undefined,
            attach: used.map((r) => ({ target: target(r), tagged: r.tagged, gateway: r.gateway })),
            subnet: used.some((r) => r.gateway) && form.subnetText ? form.subnetText : undefined,
            gatewayAddress: used.some((r) => r.gateway) ? form.gatewayAddressText || undefined : undefined,
          },
          actorOpts(),
        );
        applyDocChange(next);
      } else {
        if (used.length === 0) throw new Error('attach at least one interface');
        const next = addSubnet(
          doc,
          {
            prefix: form.subnetText,
            attach: used.map((r) => ({
              target: { kind: 'port', portId: r.portId, interfaceName: r.interfaceName || r.portId },
              address: r.addressText,
              name: form.name || undefined,
            })),
          },
          actorOpts(),
        );
        applyDocChange(next);
      }
      setForm(emptyForm());
      onClose();
    } catch (e) {
      setError(e instanceof NetworkRefusalError || e instanceof Error ? e.message : 'That did not work.');
    }
  }

  return (
    <div className="networks-panel__side">
      <div className="networks-editor__header">
        <span>Add network</span>
        <span className="networks-editor__sub">network · new</span>
      </div>

      <div className="networks-editor__row">
        <span className="networks-editor__k">kind</span>
        <span className="networks-editor__fchips">
          <button type="button" className={form.kind === 'vlan' ? 'networks-panel__fchip' : 'networks-panel__fchip networks-panel__fchip--off'} onClick={() => set('kind', 'vlan')}>
            VLAN
          </button>
          <button type="button" className={form.kind === 'subnet' ? 'networks-panel__fchip' : 'networks-panel__fchip networks-panel__fchip--off'} onClick={() => set('kind', 'subnet')}>
            Subnet
          </button>
          <button type="button" className="networks-panel__fchip networks-panel__fchip--off" disabled title="Docker networks come in A2">
            Docker
          </button>
        </span>
      </div>

      <div className="networks-editor__row">
        <span className="networks-editor__k">name</span>
        <input className="networks-editor__field" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Cameras" />
      </div>

      {form.kind === 'vlan' ? (
        <div className="networks-editor__row">
          <span className="networks-editor__k">vlan id</span>
          <input className="networks-editor__field" value={form.vlanIdText} onChange={(e) => set('vlanIdText', e.target.value)} placeholder="50" />
        </div>
      ) : null}

      <div className="networks-editor__row">
        <span className="networks-editor__k">{form.kind === 'vlan' ? 'subnet (optional)' : 'subnet'}</span>
        <input className="networks-editor__field" value={form.subnetText} onChange={(e) => set('subnetText', e.target.value)} placeholder="10.0.50.0/24" />
      </div>

      {form.kind === 'vlan' && form.rows.some((r) => r.gateway) ? (
        <div className="networks-editor__row">
          <span className="networks-editor__k">gateway addr</span>
          <input className="networks-editor__field" value={form.gatewayAddressText} onChange={(e) => set('gatewayAddressText', e.target.value)} placeholder="10.0.50.1/24" />
        </div>
      ) : null}

      <div className="networks-editor__attach-label">Attach interfaces · {chosen} chosen</div>
      {form.rows.map((row, i) => {
        const ports = row.deviceId ? portsOfDevice(doc, row.deviceId) : [];
        return (
          <div key={row.key} className="networks-editor__attach-row">
            <div className="networks-editor__attach-row-head">
              <span>interface {i + 1}</span>
              {form.rows.length > 1 ? (
                <button type="button" className="networks-grid__link" onClick={() => removeRow(row.key)}>
                  remove
                </button>
              ) : null}
            </div>
            <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
              <span className="networks-editor__k">on</span>
              <select className="networks-editor__field" value={row.deviceId} onChange={(e) => updateRow(row.key, { deviceId: e.target.value, portId: '', interfaceName: '' })}>
                <option value="">choose a device</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname}
                  </option>
                ))}
              </select>
            </div>
            <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
              <span className="networks-editor__k">port</span>
              <select className="networks-editor__field" value={row.portId} onChange={(e) => choosePort(row.key, doc, row.deviceId, e.target.value)} disabled={!row.deviceId}>
                <option value="">choose a port</option>
                {ports.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {form.kind === 'vlan' ? (
              <div className="networks-editor__row--checks" style={{ padding: 0 }}>
                <label>
                  <input type="checkbox" checked={row.tagged} onChange={(e) => updateRow(row.key, { tagged: e.target.checked })} /> tagged
                </label>
                <label>
                  <input type="checkbox" checked={row.gateway} onChange={(e) => updateRow(row.key, { gateway: e.target.checked })} /> gateway
                </label>
              </div>
            ) : (
              <div className="networks-editor__row" style={{ padding: 0 }}>
                <span className="networks-editor__k">address</span>
                <input className="networks-editor__field" value={row.addressText} onChange={(e) => updateRow(row.key, { addressText: e.target.value })} placeholder="10.8.0.1/24" />
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="networks-editor__add-attach" onClick={addRow}>
        + another interface
      </button>

      {error ? <div className="networks-editor__error">{error}</div> : null}

      <div className="networks-editor__actions">
        <button type="button" className="networks-editor__save" onClick={submit}>
          Save
        </button>
        <button
          type="button"
          className="networks-editor__cancel"
          onClick={() => {
            setForm(emptyForm());
            setError(null);
            onClose();
          }}
        >
          Cancel
        </button>
      </div>

      <div className="networks-editor__note">
        A VLAN is written on the device that carries it; a subnet is an address on a unit. Attaching writes the unit — a trunk is never made here.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The grid

function vlanIdCell(row: VlanRow): string {
  return row.cidr ? `${row.vlanId} · ${row.cidr}` : String(row.vlanId);
}

function matchesFilter(text: string, filter: string): boolean {
  return filter.trim() === '' || text.toLowerCase().includes(filter.trim().toLowerCase());
}

export function NetworksPanel(props: NetworksPanelProps) {
  const { doc, derived, view, applyDocChange, canDraw } = props;
  const [chip, setChip] = useState<Chip>('all');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const hostnameOf = (id: string) => deviceHostname(doc, id);

  const totalCount = derived.vlanRows.length + derived.subnetRows.length;

  const vlanRows = derived.vlanRows.filter((r) => {
    if (chip === 'subnet' || chip === 'docker') return false;
    if (chip === 'unattached' && r.members.length !== 0) return false;
    return matchesFilter(`VLAN ${r.vlanId} ${r.name ?? ''} ${r.devices.map(hostnameOf).join(' ')}`, filter);
  });
  const subnetRows = derived.subnetRows.filter((r) => {
    if (chip === 'vlan' || chip === 'docker') return false;
    if (chip === 'unattached' && r.members.length !== 0) return false;
    return matchesFilter(`${r.prefix} ${r.label}`, filter);
  });
  const showDockerSection = chip === 'all' || chip === 'docker';

  const vlanDevices = [...new Set(derived.vlanRows.flatMap((r) => r.devices))].map(hostnameOf);

  function removeVlanRow(row: VlanRow) {
    applyDocChange(removeVlanNetwork(doc, row.vlanNodeIds, actorOpts()));
    setOpen(null);
  }
  function removeSubnetRow(row: SubnetRow) {
    applyDocChange(removeSubnetNetwork(doc, row.addressNodeIds, actorOpts()));
    setOpen(null);
  }

  return (
    <div className="networks-panel">
      <div className="networks-panel__grid-area">
        <div className="networks-panel__toolbar">
          <span className="networks-panel__summary">
            {plural(totalCount, 'network')} · {plural(derived.vlanRows.length, 'VLAN')} · {plural(derived.subnetRows.length, 'subnet')} · {plural(0, 'Docker network')}
          </span>
          <input className="networks-panel__filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${plural(totalCount, 'network')}`} />
          <span style={{ flexGrow: 1 }} />
          {canDraw ? (
            <button type="button" className="networks-panel__add" onClick={() => setAdding(true)}>
              Add network
            </button>
          ) : null}
        </div>

        <div className="networks-panel__chips">
          {(['all', 'vlan', 'subnet', 'docker', 'unattached'] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={chip === c ? 'networks-panel__fchip' : 'networks-panel__fchip networks-panel__fchip--off'}
              onClick={() => setChip(c)}
            >
              {c === 'all' ? 'All' : c === 'vlan' ? 'VLANs' : c === 'subnet' ? 'Subnets' : c === 'docker' ? 'Docker networks' : 'Unattached'}
            </button>
          ))}
        </div>

        <div className="networks-grid networks-grid--header">
          <div />
          <div>network</div>
          <div>kind</div>
          <div>id · cidr</div>
          <div>on</div>
          <div>members</div>
          <div>last change</div>
        </div>

        <div className="networks-grid">
          {vlanRows.length > 0 ? (
            <>
              <div className="networks-grid__group">VLANs{vlanDevices.length > 0 ? ` · ${vlanDevices.join(', ')}` : ''}</div>
              {vlanRows.map((row) => (
                <VlanRowGroup
                  key={row.key}
                  row={row}
                  open={open === row.key}
                  onToggle={() => setOpen(open === row.key ? null : row.key)}
                  onRemove={() => removeVlanRow(row)}
                  onDetach={(edgeId) => applyDocChange(detachVlanMember(doc, edgeId, actorOpts()))}
                  canDraw={canDraw}
                  hostnameOf={hostnameOf}
                  doc={doc}
                  view={view}
                />
              ))}
            </>
          ) : null}

          {subnetRows.length > 0 ? (
            <>
              <div className="networks-grid__group">Subnets with no VLAN</div>
              {subnetRows.map((row) => (
                <SubnetRowGroup
                  key={row.key}
                  row={row}
                  open={open === row.key}
                  onToggle={() => setOpen(open === row.key ? null : row.key)}
                  onRemove={() => removeSubnetRow(row)}
                  onDetach={(addrId) => applyDocChange(detachAddress(doc, addrId, actorOpts()))}
                  canDraw={canDraw}
                  hostnameOf={hostnameOf}
                />
              ))}
            </>
          ) : null}

          {showDockerSection ? <div className="networks-grid__group">Docker networks — comes in A2, none read yet</div> : null}

          {vlanRows.length === 0 && subnetRows.length === 0 && !showDockerSection ? (
            <div className="networks-panel__muted" style={{ gridColumn: '1 / -1' }}>
              No networks match this filter.
            </div>
          ) : null}
        </div>

        <div className="networks-panel__footnote">
          A network is a VLAN, a subnet or a Docker network. Its members are interfaces; a container is a member through its host. A member is an
          interface — a switch port, an OPNsense unit and a host&rsquo;s bond are the same kind of row.
        </div>
      </div>

      {adding && canDraw ? <AddNetworkEditor doc={doc} applyDocChange={applyDocChange} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/** "VLAN 10 and VLAN 20 meet through sw-x" — or "meet directly" when no
 * blank bridge sits between the two access ports. */
function conflictText(ownVlanId: number, c: VlanRow['conflicts'][number], hostnameOf: (id: string) => string): string {
  const where = c.viaDeviceId ? `through ${hostnameOf(c.viaDeviceId)}` : 'directly';
  return `VLAN ${ownVlanId} and VLAN ${c.otherVlanId} meet ${where}`;
}

function VlanRowGroup(props: {
  row: VlanRow;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onDetach: (vlanMemberEdgeId: string) => void;
  canDraw: boolean;
  hostnameOf: (id: string) => string;
  doc: Document;
  view: ClosetView;
}) {
  const { row, open, onToggle, onRemove, onDetach, canDraw, hostnameOf, doc, view } = props;
  return (
    <>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {open ? '⌄' : '›'}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__cell--name networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--name'} onClick={onToggle}>
        VLAN {row.vlanId}
        {row.name ? ` · ${row.name}` : ''}
        {row.joined ? '' : ' (same id, not joined)'}
        {row.conflicts.length > 0 ? ' ⚠' : ''}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__cell--mute networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--mute'} onClick={onToggle}>
        vlan
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {vlanIdCell(row)}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.devices.map(hostnameOf).join(', ')}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.members.length}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.lastChangeMs != null ? formatLastChange(row.lastChangeMs) : '—'}
      </div>

      {open ? (
        <div className="networks-grid__open">
          {row.conflicts.map((c) => (
            <div key={`${c.otherVlanId}:${c.viaDeviceId ?? ''}`} className="networks-grid__warning">
              {conflictText(row.vlanId, c, hostnameOf)} — a real misconfiguration, not merged here.
            </div>
          ))}
          {row.members.map((m) => (
            <div key={m.unitId} className="networks-grid__member">
              <div className="networks-grid__member-rail" />
              <div className="networks-grid__member-name">
                {hostnameOf(m.deviceId)} · {m.interfaceLabel}
                {m.portRemoved ? ' (port removed)' : m.interfaceLabelIsFallback ? ' (inferred)' : ''}
              </div>
              <div>{m.mode === 'trunk' ? 'tagged' : m.mode === 'access' ? 'untagged' : '—'}</div>
              <div>
                {m.address ? m.address : m.farDeviceId ? `→ ${m.farIsSameDevice ? 'itself' : hostnameOf(m.farDeviceId)}${m.farInterfaceLabel ? ` · ${m.farInterfaceLabel}` : ''}` : '—'}
              </div>
              <div>{roleText(doc, m)}</div>
              <div>
                {m.isGateway ? 'gateway · ' : ''}
                {cableText(doc, view, m.cableId, m.deviceId) ?? ''}
              </div>
            </div>
          ))}
          {row.members.length === 0 ? <div className="networks-editor__empty">No members yet.</div> : null}
          {canDraw ? (
            <div className="networks-grid__open-actions">
              {row.members.map((m) =>
                m.vlanMemberEdgeId ? (
                  <button key={m.unitId} type="button" className="networks-grid__link" onClick={() => onDetach(m.vlanMemberEdgeId!)}>
                    detach {hostnameOf(m.deviceId)} · {m.interfaceLabel}
                  </button>
                ) : null,
              )}
              <button type="button" className="networks-grid__link" onClick={onRemove}>
                remove network
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function SubnetRowGroup(props: {
  row: SubnetRow;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onDetach: (addressNodeId: string) => void;
  canDraw: boolean;
  hostnameOf: (id: string) => string;
}) {
  const { row, open, onToggle, onRemove, onDetach, canDraw, hostnameOf } = props;
  return (
    <>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {open ? '⌄' : '›'}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__cell--name networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--name'} onClick={onToggle}>
        {row.label}
        {row.roleHintDeviceId ? ' ⚠' : ''}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__cell--mute networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--mute'} onClick={onToggle}>
        subnet
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.prefix}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {[...new Set(row.members.map((m) => m.deviceId))].map(hostnameOf).join(', ')}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.members.length}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.lastChangeMs != null ? formatLastChange(row.lastChangeMs) : '—'}
      </div>

      {open ? (
        <div className="networks-grid__open">
          {row.roleHintDeviceId ? (
            <div className="networks-grid__warning">
              {hostnameOf(row.roleHintDeviceId)} has no role; set it to switch to join its ports.
            </div>
          ) : null}
          {row.members.map((m) => (
            <div key={m.addressNodeId} className="networks-grid__member">
              <div className="networks-grid__member-rail" />
              <div className="networks-grid__member-name">
                {hostnameOf(m.deviceId)} · {m.interfaceLabel}
                {m.portRemoved ? ' (port removed)' : m.interfaceLabelIsFallback ? ' (inferred)' : ''}
              </div>
              <div>subnet</div>
              <div>{m.address}</div>
              <div>{m.description ?? ''}</div>
            </div>
          ))}
          {canDraw ? (
            <div className="networks-grid__open-actions">
              {row.members.map((m) => (
                <button key={m.addressNodeId} type="button" className="networks-grid__link" onClick={() => onDetach(m.addressNodeId)}>
                  detach {hostnameOf(m.deviceId)} · {m.interfaceLabel}
                </button>
              ))}
              <button type="button" className="networks-grid__link" onClick={onRemove}>
                remove network
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

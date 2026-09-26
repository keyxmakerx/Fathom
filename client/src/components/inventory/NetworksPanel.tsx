// ADR-0058 — the Networks kind in Inventory: the list per board A
// (`design/proposals/networks/A-inventory-list.dc.html`), the Add network
// editor for VLAN, Subnet and Docker, and the Docker networks group — drawn
// collapsed only by board A; the open row is this panel's own design.
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
import { edgesIn, edgesOut, findNode, parseNodeId, readDeviceFields, readPhysicalPortFields, type Document } from '../../document/model';
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
import {
  DockerRefusalError,
  addContainerNetwork,
  addPublishedPort,
  attachContainerToNetwork,
  detachContainerFromNetwork,
  removeContainer,
  removeContainerNetwork,
  removePublishedPort,
  type AttachContainerTarget,
  type DockerDriver,
} from '../../document/docker';
import {
  trunkVlanIdsOf,
  type DockerContainerRow,
  type DockerNetworkRow,
  type DockerUnattachedContainerRow,
  type NetworksDerived,
  type SubnetRow,
  type VlanMemberRow,
  type VlanRow,
} from '../../document/networks-derive';
import { getSession } from '../../state/sessionState';
import { formatLastChange } from './rows';
import './networks.css';

const DOCKER_DRIVERS: readonly DockerDriver[] = ['bridge', 'host', 'none', 'macvlan', 'ipvlan', 'overlay', 'other'];
const DOCKER_PROTOCOLS = ['tcp', 'udp', 'sctp'] as const;

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
  if (m.container) return 'container';
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
  kind: 'vlan' | 'subnet' | 'docker';
  name: string;
  vlanIdText: string;
  subnetText: string;
  gatewayAddressText: string;
  rows: AttachRow[];
  /** Docker only, from here down — a network takes one host, and (for
   * macvlan/ipvlan only) one parent port on that same host. */
  dockerDriver: DockerDriver;
  dockerSubnetsText: string;
  dockerGatewaysText: string;
  dockerHostDeviceId: string;
  dockerParentPortId: string;
  dockerParentInterfaceName: string;
}

function emptyForm(): FormState {
  return {
    kind: 'vlan',
    name: '',
    vlanIdText: '',
    subnetText: '',
    gatewayAddressText: '',
    rows: [blankAttachRow(0)],
    dockerDriver: 'bridge',
    dockerSubnetsText: '',
    dockerGatewaysText: '',
    dockerHostDeviceId: '',
    dockerParentPortId: '',
    dockerParentInterfaceName: '',
  };
}

/** The Docker kind's own fields — one host, a driver, subnets/gateways as
 * comma-separated text, and (macvlan/ipvlan only) one parent port. */
function DockerNetworkFields(props: { doc: Document; form: FormState; set: <K extends keyof FormState>(key: K, value: FormState[K]) => void }) {
  const { doc, form, set } = props;
  const devices = useMemo(() => liveDevices(doc), [doc]);
  const needsParent = form.dockerDriver === 'macvlan' || form.dockerDriver === 'ipvlan';
  const ports = form.dockerHostDeviceId ? portsOfDevice(doc, form.dockerHostDeviceId) : [];
  return (
    <>
      <div className="networks-editor__row" style={{ alignItems: 'center' }}>
        <span className="networks-editor__k">driver</span>
        <select className="networks-editor__field" value={form.dockerDriver} onChange={(e) => set('dockerDriver', e.target.value as DockerDriver)}>
          {DOCKER_DRIVERS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <div className="networks-editor__row">
        <span className="networks-editor__k">on</span>
        <select
          className="networks-editor__field"
          value={form.dockerHostDeviceId}
          onChange={(e) => set('dockerHostDeviceId', e.target.value)}
        >
          <option value="">choose a host</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.hostname}
            </option>
          ))}
        </select>
      </div>
      <div className="networks-editor__row">
        <span className="networks-editor__k">subnets</span>
        <input className="networks-editor__field" value={form.dockerSubnetsText} onChange={(e) => set('dockerSubnetsText', e.target.value)} placeholder="172.18.0.0/16" />
      </div>
      <div className="networks-editor__row">
        <span className="networks-editor__k">gateways</span>
        <input className="networks-editor__field" value={form.dockerGatewaysText} onChange={(e) => set('dockerGatewaysText', e.target.value)} placeholder="172.18.0.1" />
      </div>
      {needsParent ? (
        <div className="networks-editor__row">
          <span className="networks-editor__k">parent port</span>
          <select
            className="networks-editor__field"
            value={form.dockerParentPortId}
            disabled={!form.dockerHostDeviceId}
            onChange={(e) => {
              const port = ports.find((p) => p.id === e.target.value);
              set('dockerParentPortId', e.target.value);
              set('dockerParentInterfaceName', port ? port.label : '');
            }}
          >
            <option value="">choose a port on this host</option>
            {ports.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </>
  );
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
      if (form.kind === 'docker') {
        if (!form.dockerHostDeviceId) throw new Error('choose a host device');
        const needsParent = form.dockerDriver === 'macvlan' || form.dockerDriver === 'ipvlan';
        if (needsParent && !form.dockerParentPortId) throw new Error('macvlan/ipvlan needs a parent interface on the same host');
        const subnets = form.dockerSubnetsText.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        const gateways = form.dockerGatewaysText.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        const next = addContainerNetwork(
          doc,
          {
            hostDeviceId: form.dockerHostDeviceId,
            name: form.name,
            driver: form.dockerDriver,
            subnets: subnets.length > 0 ? subnets : undefined,
            gateways: gateways.length > 0 ? gateways : undefined,
            parent: needsParent
              ? { kind: 'port', portId: form.dockerParentPortId, interfaceName: form.dockerParentInterfaceName || form.dockerParentPortId }
              : undefined,
          },
          actorOpts(),
        );
        applyDocChange(next);
      } else if (form.kind === 'vlan') {
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
          <button type="button" className={form.kind === 'docker' ? 'networks-panel__fchip' : 'networks-panel__fchip networks-panel__fchip--off'} onClick={() => set('kind', 'docker')}>
            Docker
          </button>
        </span>
      </div>

      <div className="networks-editor__row">
        <span className="networks-editor__k">name</span>
        <input className="networks-editor__field" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={form.kind === 'docker' ? 'app_net' : 'Cameras'} />
      </div>

      {form.kind === 'vlan' ? (
        <div className="networks-editor__row">
          <span className="networks-editor__k">vlan id</span>
          <input className="networks-editor__field" value={form.vlanIdText} onChange={(e) => set('vlanIdText', e.target.value)} placeholder="50" />
        </div>
      ) : null}

      {form.kind !== 'docker' ? (
        <div className="networks-editor__row">
          <span className="networks-editor__k">{form.kind === 'vlan' ? 'subnet (optional)' : 'subnet'}</span>
          <input className="networks-editor__field" value={form.subnetText} onChange={(e) => set('subnetText', e.target.value)} placeholder="10.0.50.0/24" />
        </div>
      ) : null}

      {form.kind === 'vlan' && form.rows.some((r) => r.gateway) ? (
        <div className="networks-editor__row">
          <span className="networks-editor__k">gateway addr</span>
          <input className="networks-editor__field" value={form.gatewayAddressText} onChange={(e) => set('gatewayAddressText', e.target.value)} placeholder="10.0.50.1/24" />
        </div>
      ) : null}

      {form.kind === 'docker' ? (
        <DockerNetworkFields doc={doc} form={form} set={set} />
      ) : null}

      {form.kind !== 'docker' ? (
        <>
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
        </>
      ) : null}

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
        {form.kind === 'docker'
          ? "A Docker network is written on its host. macvlan/ipvlan takes a parent port on that same host; a bridge network's containers reach out only through published ports."
          : 'A VLAN is written on the device that carries it; a subnet is an address on a unit. Attaching writes the unit — a trunk is never made here.'}
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

  const totalCount = derived.vlanRows.length + derived.subnetRows.length + derived.dockerNetworkRows.length;

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
  const dockerRows = derived.dockerNetworkRows.filter((r) => {
    if (chip === 'vlan' || chip === 'subnet') return false;
    if (chip === 'unattached' && r.containers.length !== 0) return false;
    return matchesFilter(`${r.name} ${r.driver} ${hostnameOf(r.hostDeviceId)}`, filter);
  });
  // A container with no network at all is "unattached" by definition — the
  // chip shows it regardless of that filter.
  const unattachedContainerRows = derived.dockerUnattachedContainers.filter((r) => {
    if (chip === 'vlan' || chip === 'subnet') return false;
    return matchesFilter(`${r.name} ${hostnameOf(r.hostDeviceId)}`, filter);
  });

  const vlanDevices = [...new Set(derived.vlanRows.flatMap((r) => r.devices))].map(hostnameOf);
  const dockerHosts = [...new Set(derived.dockerNetworkRows.map((r) => r.hostDeviceId))].map(hostnameOf);

  function removeVlanRow(row: VlanRow) {
    applyDocChange(removeVlanNetwork(doc, row.vlanNodeIds, actorOpts()));
    setOpen(null);
  }
  function removeSubnetRow(row: SubnetRow) {
    applyDocChange(removeSubnetNetwork(doc, row.addressNodeIds, actorOpts()));
    setOpen(null);
  }
  function removeDockerRow(row: DockerNetworkRow) {
    // The button is only shown once `row.containers.length === 0`, so the
    // "refused while containers are attached" case never fires from here.
    applyDocChange(removeContainerNetwork(doc, row.containerNetworkId, actorOpts()));
    setOpen(null);
  }

  return (
    <div className="networks-panel">
      <div className="networks-panel__grid-area">
        <div className="networks-panel__toolbar">
          <span className="networks-panel__summary">
            {plural(totalCount, 'network')} · {plural(derived.vlanRows.length, 'VLAN')} · {plural(derived.subnetRows.length, 'subnet')} ·{' '}
            {plural(derived.dockerNetworkRows.length, 'Docker network')}
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

          {dockerRows.length > 0 ? (
            <>
              <div className="networks-grid__group">Docker networks{dockerHosts.length > 0 ? ` · ${dockerHosts.join(', ')}` : ''}</div>
              {dockerRows.map((row) => (
                <DockerNetworkRowGroup
                  key={row.key}
                  row={row}
                  open={open === row.key}
                  onToggle={() => setOpen(open === row.key ? null : row.key)}
                  onRemove={() => removeDockerRow(row)}
                  canDraw={canDraw}
                  hostnameOf={hostnameOf}
                  doc={doc}
                  applyDocChange={applyDocChange}
                />
              ))}
            </>
          ) : null}

          {unattachedContainerRows.length > 0 ? (
            <>
              {dockerRows.length === 0 ? <div className="networks-grid__group">Docker networks</div> : null}
              {unattachedContainerRows.map((row) => (
                <DockerUnattachedContainerRowGroup
                  key={row.key}
                  row={row}
                  open={open === row.key}
                  onToggle={() => setOpen(open === row.key ? null : row.key)}
                  onRemove={() => {
                    applyDocChange(removeContainer(doc, row.containerId, actorOpts()));
                    setOpen(null);
                  }}
                  canDraw={canDraw}
                  hostnameOf={hostnameOf}
                />
              ))}
            </>
          ) : null}

          {vlanRows.length === 0 && subnetRows.length === 0 && dockerRows.length === 0 && unattachedContainerRows.length === 0 ? (
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
                {m.container ? `└ ${m.container.name}` : `${hostnameOf(m.deviceId)} · ${m.interfaceLabel}`}
                {m.portRemoved ? ' (port removed)' : m.interfaceLabelIsFallback ? ' (inferred)' : ''}
              </div>
              <div>{m.container ? 'via macvlan/ipvlan' : m.mode === 'trunk' ? 'tagged' : m.mode === 'access' ? 'untagged' : '—'}</div>
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
                {m.container ? `└ ${m.container.name}` : `${hostnameOf(m.deviceId)} · ${m.interfaceLabel}`}
                {m.portRemoved ? ' (port removed)' : m.interfaceLabelIsFallback ? ' (inferred)' : ''}
              </div>
              <div>{m.container ? 'container · via macvlan/ipvlan' : 'subnet'}</div>
              <div>{m.address}</div>
              <div>{m.description ?? ''}</div>
            </div>
          ))}
          {canDraw ? (
            <div className="networks-grid__open-actions">
              {row.members
                .filter((m) => m.container === undefined)
                .map((m) => (
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

// ---------------------------------------------------------------------------
// Docker network rows (ADR-0058) — board A draws this group collapsed only;
// its open state follows the VLAN row's own pattern: member rows are data
// only, one action line at the bottom.

function protocolName(n: number): string {
  return n === 6 ? 'tcp' : n === 17 ? 'udp' : n === 132 ? 'sctp' : `#${n}`;
}

function publishedPortText(p: DockerContainerRow['publishedPorts'][number]): string {
  const proto = protocolName(p.protocolNumber);
  const host = p.hostPort !== undefined ? `${p.hostAddress ? `${p.hostAddress}:` : ''}${p.hostPort}:` : '';
  // Another container on this host with the same protocol/host port at the
  // same (or an all-addresses) address is a real bind-time conflict
  // (networks-derive.ts); "likely" flags a wildcard-vs-specific case whose
  // kernel conflict is not fully sourced.
  const mark = p.conflict === 'certain' ? ' ⚠' : p.conflict === 'likely' ? ' likely ⚠' : '';
  return `${host}${p.containerPort}/${proto}${mark}`;
}

/** The members cell's own text, board A's own wording: "published
 * 8080:80/tcp" (comma-separated for several) or "not published". */
function publishedPortsCellText(ports: readonly DockerContainerRow['publishedPorts'][number][]): string {
  return ports.length === 0 ? 'not published' : `published ${ports.map(publishedPortText).join(', ')}`;
}

/** A container's "+ publish a port" inline form — DNAT held exactly as
 * `docker run -p` states it (ADR-0058 decision 4). */
function AddPublishedPortForm(props: { doc: Document; applyDocChange: (next: Document) => void; containerId: string; onClose: () => void }) {
  const { doc, applyDocChange, containerId, onClose } = props;
  const [protocol, setProtocol] = useState<(typeof DOCKER_PROTOCOLS)[number]>('tcp');
  const [containerPort, setContainerPort] = useState('');
  const [hostPort, setHostPort] = useState('');
  const [hostAddress, setHostAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    try {
      const next = addPublishedPort(
        doc,
        {
          containerId,
          protocol,
          containerPort: Number(containerPort),
          hostPort: hostPort ? Number(hostPort) : undefined,
          hostAddress: hostAddress || undefined,
        },
        actorOpts(),
      );
      applyDocChange(next);
      onClose();
    } catch (e) {
      setError(e instanceof DockerRefusalError ? e.message : 'That did not work.');
    }
  }

  return (
    <div className="networks-editor__attach-row">
      <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
        <span className="networks-editor__k">protocol</span>
        <select className="networks-editor__field" value={protocol} onChange={(e) => setProtocol(e.target.value as (typeof DOCKER_PROTOCOLS)[number])}>
          {DOCKER_PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
        <span className="networks-editor__k">container port</span>
        <input className="networks-editor__field" value={containerPort} onChange={(e) => setContainerPort(e.target.value)} placeholder="80" />
      </div>
      <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
        <span className="networks-editor__k">host port</span>
        <input className="networks-editor__field" value={hostPort} onChange={(e) => setHostPort(e.target.value)} placeholder="8080 (optional)" />
      </div>
      <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
        <span className="networks-editor__k">host addr</span>
        <input className="networks-editor__field" value={hostAddress} onChange={(e) => setHostAddress(e.target.value)} placeholder="optional" />
      </div>
      {error ? <div className="networks-editor__error">{error}</div> : null}
      <div className="networks-editor__actions">
        <button type="button" className="networks-editor__save" onClick={submit}>
          Publish
        </button>
        <button type="button" className="networks-editor__cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface AttachCandidate {
  containerId: string;
  name: string;
  hostDeviceId: string;
}

/** Every live, unattached container this network could take: this host's
 * own, unless the driver is `overlay`, which spans hosts — any host's. */
function attachCandidatesFor(doc: Document, row: DockerNetworkRow): AttachCandidate[] {
  const attached = new Set(row.containers.map((c) => c.containerId));
  const result: AttachCandidate[] = [];
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || parseNodeId(n.id).kind !== 'Container' || attached.has(n.id)) continue;
    const hc = edgesIn(doc, n.id, 'HasContainer')[0];
    if (!hc) continue;
    if (row.driver !== 'overlay' && hc.from !== row.hostDeviceId) continue;
    const name = n.fields['Container.name']?.value;
    result.push({ containerId: n.id, name: typeof name === 'string' ? name : n.id, hostDeviceId: hc.from });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Attaches a container to this network — an existing one or a new one,
 * named right here — either way, one `attachContainerToNetwork` call. */
function AttachContainerForm(props: { doc: Document; applyDocChange: (next: Document) => void; row: DockerNetworkRow; onClose: () => void }) {
  const { doc, applyDocChange, row, onClose } = props;
  const candidates = useMemo(() => attachCandidatesFor(doc, row), [doc, row]);
  const [mode, setMode] = useState<'existing' | 'new'>(candidates.length > 0 ? 'existing' : 'new');
  const [existingId, setExistingId] = useState(candidates[0]?.containerId ?? '');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    try {
      const container: AttachContainerTarget =
        mode === 'existing' ? { kind: 'existing', containerId: existingId } : { kind: 'new', hostDeviceId: row.hostDeviceId, name };
      const next = attachContainerToNetwork(doc, { networkId: row.containerNetworkId, container, address: address || undefined }, actorOpts());
      applyDocChange(next);
      onClose();
    } catch (e) {
      setError(e instanceof DockerRefusalError ? e.message : 'That did not work.');
    }
  }

  return (
    <div className="networks-editor__attach-row">
      <div className="networks-editor__row--checks" style={{ padding: 0, marginBottom: 4 }}>
        <label>
          <input type="radio" name="attach-mode" checked={mode === 'existing'} disabled={candidates.length === 0} onChange={() => setMode('existing')} />{' '}
          existing container
        </label>
        <label>
          <input type="radio" name="attach-mode" checked={mode === 'new'} onChange={() => setMode('new')} /> new container
        </label>
      </div>
      {mode === 'existing' ? (
        <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
          <span className="networks-editor__k">container</span>
          <select className="networks-editor__field" value={existingId} onChange={(e) => setExistingId(e.target.value)}>
            {candidates.length === 0 ? <option value="">no unattached container to pick</option> : null}
            {candidates.map((c) => (
              <option key={c.containerId} value={c.containerId}>
                {c.name} · {c.hostDeviceId === row.hostDeviceId ? 'this host' : c.hostDeviceId}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
          <span className="networks-editor__k">name</span>
          <input className="networks-editor__field" value={name} onChange={(e) => setName(e.target.value)} placeholder="gitea" />
        </div>
      )}
      <div className="networks-editor__row" style={{ padding: 0, marginBottom: 4 }}>
        <span className="networks-editor__k">address</span>
        <input className="networks-editor__field" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="172.18.0.3/16 (optional)" />
      </div>
      {error ? <div className="networks-editor__error">{error}</div> : null}
      <div className="networks-editor__actions">
        <button type="button" className="networks-editor__save" onClick={submit}>
          Attach
        </button>
        <button type="button" className="networks-editor__cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One member row — data only, five columns under the rail, the VLAN row's
 * own `.networks-grid__member` shape and widths. */
function DockerMemberRow(props: { container: DockerContainerRow; hostnameOf: (id: string) => string }) {
  const { container: c, hostnameOf } = props;
  return (
    <div className="networks-grid__member">
      <div className="networks-grid__member-rail" />
      <div className="networks-grid__member-name">{c.name}</div>
      <div>container</div>
      <div>{c.address ?? '—'}</div>
      <div>{hostnameOf(c.deviceId)}</div>
      <div>{publishedPortsCellText(c.publishedPorts)}</div>
    </div>
  );
}

function DockerNetworkRowGroup(props: {
  row: DockerNetworkRow;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  canDraw: boolean;
  hostnameOf: (id: string) => string;
  doc: Document;
  applyDocChange: (next: Document) => void;
}) {
  const { row, open, onToggle, onRemove, canDraw, hostnameOf, doc, applyDocChange } = props;
  const [addingContainer, setAddingContainer] = useState(false);
  const [addingPortFor, setAddingPortFor] = useState<string | null>(null);
  return (
    <>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {open ? '⌄' : '›'}
      </div>
      <div
        className={open ? 'networks-grid__cell networks-grid__cell--name networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--name'}
        onClick={onToggle}
      >
        {row.name}
        {row.parentSameHost ? '' : ' ⚠'}
      </div>
      <div
        className={open ? 'networks-grid__cell networks-grid__cell--mute networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--mute'}
        onClick={onToggle}
      >
        {row.driver}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.idCidr}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {hostnameOf(row.hostDeviceId)}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.containers.length}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.lastChangeMs != null ? formatLastChange(row.lastChangeMs) : '—'}
      </div>

      {open ? (
        <div className="networks-grid__open">
          {row.parentSameHost ? null : (
            <div className="networks-grid__warning">
              {row.name}&rsquo;s parent interface is on a different host than {hostnameOf(row.hostDeviceId)} — parentunit.same-host is broken here,
              not merged or guessed.
            </div>
          )}
          {row.containers
            .filter((c) => !c.sameHost)
            .map((c) => (
              <div key={c.containerId} className="networks-grid__warning">
                {c.name} is on a different host than {hostnameOf(row.hostDeviceId)} — attachedto.same-host is broken here, not merged or guessed.
              </div>
            ))}
          {row.containers.map((c) => (
            <DockerMemberRow key={c.containerId} container={c} hostnameOf={hostnameOf} />
          ))}
          {row.containers.length === 0 ? <div className="networks-editor__empty">No containers yet.</div> : null}
          {addingContainer ? (
            <AttachContainerForm doc={doc} applyDocChange={applyDocChange} row={row} onClose={() => setAddingContainer(false)} />
          ) : null}
          {addingPortFor ? (
            <AddPublishedPortForm doc={doc} applyDocChange={applyDocChange} containerId={addingPortFor} onClose={() => setAddingPortFor(null)} />
          ) : null}
          {canDraw ? (
            <div className="networks-grid__open-actions">
              {!addingContainer ? (
                <button type="button" className="networks-grid__link" onClick={() => setAddingContainer(true)}>
                  + attach a container
                </button>
              ) : null}
              {row.containers.map((c) => (
                <span key={c.containerId} style={{ display: 'contents' }}>
                  {addingPortFor !== c.containerId ? (
                    <button type="button" className="networks-grid__link" onClick={() => setAddingPortFor(c.containerId)}>
                      publish a port on {c.name}
                    </button>
                  ) : null}
                  {c.publishedPorts.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="networks-grid__link"
                      onClick={() => applyDocChange(removePublishedPort(doc, p.id, actorOpts()))}
                    >
                      unpublish {c.name} {publishedPortText(p)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="networks-grid__link"
                    onClick={() => applyDocChange(detachContainerFromNetwork(doc, c.attachedToEdgeId, actorOpts()))}
                  >
                    detach {c.name}
                  </button>
                  <button type="button" className="networks-grid__link" onClick={() => applyDocChange(removeContainer(doc, c.containerId, actorOpts()))}>
                    remove {c.name}
                  </button>
                </span>
              ))}
              {row.containers.length === 0 ? (
                <button type="button" className="networks-grid__link" onClick={onRemove}>
                  remove network
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** An unattached container's own row — collapsed like every other row, its
 * open state one member line (`DockerMemberRow`, reused) and a "remove". */
function DockerUnattachedContainerRowGroup(props: {
  row: DockerUnattachedContainerRow;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  canDraw: boolean;
  hostnameOf: (id: string) => string;
}) {
  const { row, open, onToggle, onRemove, canDraw, hostnameOf } = props;
  const asMember: DockerContainerRow = {
    containerId: row.containerId,
    name: row.name,
    deviceId: row.hostDeviceId,
    attachedToEdgeId: '',
    publishedPorts: row.publishedPorts,
    sameHost: true,
  };
  return (
    <>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {open ? '⌄' : '›'}
      </div>
      <div
        className={open ? 'networks-grid__cell networks-grid__cell--name networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--name'}
        onClick={onToggle}
      >
        {row.name}
      </div>
      <div
        className={open ? 'networks-grid__cell networks-grid__cell--mute networks-grid__row--open' : 'networks-grid__cell networks-grid__cell--mute'}
        onClick={onToggle}
      >
        container
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        —
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {hostnameOf(row.hostDeviceId)}
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        not attached
      </div>
      <div className={open ? 'networks-grid__cell networks-grid__row--open' : 'networks-grid__cell'} onClick={onToggle}>
        {row.lastChangeMs != null ? formatLastChange(row.lastChangeMs) : '—'}
      </div>

      {open ? (
        <div className="networks-grid__open">
          <DockerMemberRow container={asMember} hostnameOf={hostnameOf} />
          {canDraw ? (
            <div className="networks-grid__open-actions">
              <button type="button" className="networks-grid__link" onClick={onRemove}>
                remove {row.name}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

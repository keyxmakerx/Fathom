// Steward › IP plan (ADR-0083 decision 7; sign-off alpha v2, 2026-11-14). The organisation's
// address plan on the server: the address tree with each block's use and free stretches, VLAN
// groups, AS numbers, VRFs and route targets. Add, change and delete each; ask a block, group or
// range for its next free, and reserve it under a key so asking again gives the same answer
// (decision 5). The store's own sentence is shown when it refuses. Nothing here writes to a design.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { describeError } from '../../api/invitations';
import {
  cleanFields,
  createRecord,
  deleteRecord,
  fetchPlan,
  lookNext,
  planRefusal,
  takeNext,
  updateRecord,
  type PlanFields,
  type PlanKind,
  type PlanList,
  type PlanRecord,
  type PlanValue,
  type Want,
} from '../../api/ipPlan';
import { downloadBytes } from '../../print/download';
import {
  addressTree,
  flag,
  headline,
  isBlock,
  KIND_WORDS,
  nameOfVrf,
  netboxFiles,
  netboxGaps,
  parseCidrBig,
  subline,
  text,
  texts,
  usableWords,
  usedWords,
  vrfOf,
  vrfsInUse,
  type TreeRow,
} from './ipPlanModel';

export type PlanTab = 'addresses' | 'vlans' | 'asns' | 'vrfs';
const TABS: readonly [PlanTab, string][] = [
  ['addresses', 'Addresses'],
  ['vlans', 'VLANs'],
  ['asns', 'AS numbers'],
  ['vrfs', 'VRFs and route targets'],
];

export interface PlanFolder {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// What each kind's form asks for, in the schema's names (schema/schema.yaml, plan layer)

type FieldType = 'text' | 'flag' | 'choice' | 'vrf' | 'folder' | 'group' | 'asnRange' | 'targets' | 'list' | 'date';
interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  choices?: readonly string[];
  placeholder?: string;
  hint?: string;
  /** Picked when a new record is made. */
  start?: PlanValue;
}

const NOTE: FieldSpec = { name: 'note', label: 'Note', type: 'text' };
const FOLDER: FieldSpec = { name: 'folder', label: 'Folder', type: 'folder', hint: 'The site, building or closet it belongs to. None is the whole organisation.' };
const VRF: FieldSpec = { name: 'vrf', label: 'VRF', type: 'vrf' };

/** The form for a reservation names what it holds in one box; `held` is not a store field. */
const HELD = 'held';

export const FORMS: Record<PlanKind, readonly FieldSpec[]> = {
  aggregate: [
    { name: 'prefix', label: 'Prefix', type: 'text', required: true, placeholder: '10.0.0.0/8' },
    { name: 'rir', label: 'Where it came from', type: 'text', placeholder: 'RFC 1918', hint: 'An RIR such as RIPE NCC, or RFC 1918 for private space.' },
    FOLDER,
    NOTE,
  ],
  prefix: [
    { name: 'prefix', label: 'Prefix', type: 'text', required: true, placeholder: '10.20.1.0/24' },
    VRF,
    { name: 'status', label: 'Status', type: 'choice', required: true, choices: ['container', 'active', 'reserved', 'deprecated'], start: 'active' },
    { name: 'role', label: 'Role', type: 'text', placeholder: 'Users' },
    { name: 'vlan', label: 'VLAN ID', type: 'text', placeholder: '120' },
    { name: 'is_pool', label: 'Every address is usable (a pool)', type: 'flag', start: false },
    { name: 'mark_utilised', label: 'Count it as full', type: 'flag', start: false },
    FOLDER,
    NOTE,
  ],
  range: [
    { name: 'range', label: 'Range', type: 'text', required: true, placeholder: '10.20.1.100-10.20.1.199' },
    VRF,
    { name: 'status', label: 'Status', type: 'choice', required: true, choices: ['active', 'reserved', 'deprecated'], start: 'active' },
    { name: 'role', label: 'Role', type: 'text', placeholder: 'DHCP' },
    { name: 'populated', label: 'Populated: next free never hands out an address in it', type: 'flag', start: false },
    { name: 'mark_utilised', label: 'Count it as full', type: 'flag', start: false },
    FOLDER,
    NOTE,
  ],
  address: [
    { name: 'address', label: 'Address with its length', type: 'text', required: true, placeholder: '10.20.1.1/24' },
    VRF,
    { name: 'status', label: 'Status', type: 'choice', required: true, choices: ['active', 'reserved', 'deprecated', 'dhcp', 'slaac'], start: 'active' },
    { name: 'role', label: 'Role', type: 'choice', choices: ['loopback', 'secondary', 'anycast', 'vip', 'vrrp', 'hsrp', 'glbp', 'carp'] },
    { name: 'meant_for', label: 'Meant for', type: 'text', placeholder: 'core-sw1 ge-0/0/1', hint: 'The device and interface, in words, until it is drawn.' },
    { name: 'dns_name', label: 'DNS name', type: 'text', placeholder: 'gw.branch.example.net', hint: 'Kept here only. Fathom never looks it up.' },
    FOLDER,
    NOTE,
  ],
  reservation: [
    { name: HELD, label: 'What it holds', type: 'text', required: true, placeholder: '10.20.1.8/29', hint: 'A prefix, a range written first-last, or one address.' },
    VRF,
    { name: 'reason', label: 'Reason', type: 'text', required: true, placeholder: 'WAN for the new branch' },
    { name: 'work', label: 'Piece of work', type: 'text', placeholder: 'W-1042', hint: 'Leave empty and you hold it yourself.' },
    { name: 'ends', label: 'Ends', type: 'date', hint: 'Empty is 30 days from today.' },
    { name: 'dns_name', label: 'DNS name', type: 'text' },
    FOLDER,
    NOTE,
  ],
  vrf: [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'CUSTOMER-A', hint: 'Matched against a routing instance of the same name in a design.' },
    { name: 'route_distinguisher', label: 'Route distinguisher', type: 'text', placeholder: '65000:100' },
    { name: 'enforce_unique', label: 'Refuse the same network twice in it', type: 'flag', start: false },
    { name: 'import_targets', label: 'Imports', type: 'targets' },
    { name: 'export_targets', label: 'Exports', type: 'targets' },
    NOTE,
  ],
  route_target: [{ name: 'value', label: 'Route target', type: 'text', required: true, placeholder: '65000:100' }, NOTE],
  vlan_group: [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Campus' },
    { name: 'vid_ranges', label: 'VLAN IDs', type: 'list', required: true, placeholder: '100-199, 300-399', hint: 'Ranges inside 1-4094, separated by commas. They may not overlap.' },
    FOLDER,
    NOTE,
  ],
  vlan: [
    { name: 'group', label: 'Group', type: 'group', required: true },
    { name: 'vid', label: 'VLAN ID', type: 'text', required: true, placeholder: '120' },
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Staff' },
    { name: 'status', label: 'Status', type: 'choice', required: true, choices: ['active', 'reserved', 'deprecated'], start: 'active' },
    FOLDER,
    NOTE,
  ],
  asn_range: [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Private 4-byte' },
    { name: 'first', label: 'First', type: 'text', required: true, placeholder: '4200000000' },
    { name: 'last', label: 'Last', type: 'text', required: true, placeholder: '4200000999' },
    { name: 'rir', label: 'RIR', type: 'text', placeholder: 'RFC 6996' },
    FOLDER,
    NOTE,
  ],
  asn: [
    { name: 'asn', label: 'ASN', type: 'text', required: true, placeholder: '4200000001' },
    { name: 'range', label: 'Range', type: 'asnRange' },
    { name: 'meant_for', label: 'Meant for', type: 'text', placeholder: 'Branch 12 edge' },
    FOLDER,
    NOTE,
  ],
};

/** The words a form shows for a typed reservation box: which store field it fills. */
export function heldSlot(value: string): 'prefix' | 'range' | 'address' {
  if (value.includes('-')) return 'range';
  return value.includes('/') ? 'prefix' : 'address';
}

type Draft = Record<string, PlanValue>;

function draftFor(kind: PlanKind, record: PlanRecord | null, preset: Draft = {}): Draft {
  const d: Draft = {};
  for (const spec of FORMS[kind]) {
    if (spec.name === HELD) {
      d[HELD] = record ? (text(record.fields, 'prefix') ?? text(record.fields, 'range') ?? text(record.fields, 'address') ?? '') : '';
      continue;
    }
    const v = record?.fields[spec.name];
    if (spec.type === 'flag') d[spec.name] = v === true || (v === undefined && spec.start === true);
    else if (spec.type === 'targets' || spec.type === 'list') d[spec.name] = record ? texts(record.fields, spec.name) : [];
    else d[spec.name] = typeof v === 'string' ? v : record ? '' : typeof spec.start === 'string' ? spec.start : '';
  }
  return { ...d, ...preset };
}

/** The fields to send: the record's own, with what the form changed laid over them. */
export function fieldsFromDraft(kind: PlanKind, draft: Draft, record: PlanRecord | null): PlanFields {
  const out: Record<string, PlanValue | null> = record ? { ...record.fields } : {};
  for (const spec of FORMS[kind]) {
    const v = draft[spec.name];
    if (spec.name === HELD) {
      for (const slot of ['prefix', 'range', 'address']) delete out[slot];
      const held = typeof v === 'string' ? v.trim() : '';
      if (held !== '') out[heldSlot(held)] = held;
      continue;
    }
    if (spec.type === 'list' && typeof v === 'string') out[spec.name] = v.split(',');
    else out[spec.name] = v ?? null;
  }
  return cleanFields(out);
}

// ---------------------------------------------------------------------------
// The page, loading and writing

export interface IpPlanPageProps {
  organisationId: string;
  folders: readonly PlanFolder[];
  /** Account id to display name, for who holds a reservation. */
  names: ReadonlyMap<string, string>;
  you: string | null;
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: PlanList };

const sentence = (e: unknown) => planRefusal(e) ?? describeError(e);

export function IpPlanPage({ organisationId, folders, names, you }: IpPlanPageProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const reload = useCallback(() => {
    fetchPlan(organisationId).then(
      (value) => setLoad({ status: 'ready', value }),
      (e: unknown) => setLoad({ status: 'error', message: sentence(e) }),
    );
  }, [organisationId]);
  useEffect(() => {
    setLoad({ status: 'loading' });
    reload();
  }, [reload]);

  if (load.status === 'loading') return <p className="home__muted">Loading…</p>;
  if (load.status === 'error') {
    return (
      <section className="org-page" data-testid="ip-plan">
        <div className="org-page__title">IP plan</div>
        <p className="home__error" role="alert">
          {load.message}
        </p>
      </section>
    );
  }
  const org = organisationId;
  return (
    <IpPlanView
      plan={load.value}
      folders={folders}
      names={names}
      you={you}
      onSave={async (kind, record, fields) => {
        const saved = record ? await updateRecord(org, record.id, record.version, fields) : await createRecord(org, kind, fields);
        reload();
        return saved;
      }}
      onDelete={async (record) => {
        await deleteRecord(org, record.id);
        reload();
      }}
      onLook={(parent, want) => lookNext(org, parent.id, want)}
      onTake={async (parent, want, key, hold) => {
        const taken = await takeNext(org, parent.id, want, key, hold);
        reload();
        return taken;
      }}
      onDownload={(name, csv) => downloadBytes(name, new TextEncoder().encode(csv), 'text/csv')}
    />
  );
}

// ---------------------------------------------------------------------------
// The view: everything drawn, with what the page does handed in

export interface IpPlanViewProps {
  plan: PlanList;
  folders: readonly PlanFolder[];
  names: ReadonlyMap<string, string>;
  you: string | null;
  onSave: (kind: PlanKind, record: PlanRecord | null, fields: PlanFields) => Promise<PlanRecord>;
  onDelete: (record: PlanRecord) => Promise<void>;
  onLook: (parent: PlanRecord, want: Want) => Promise<string>;
  onTake: (parent: PlanRecord, want: Want, key: string, hold: PlanFields) => Promise<{ record: PlanRecord; again: boolean }>;
  onDownload: (name: string, csv: string) => void;
  /** For a test or a screenshot: where the page opens. */
  initialTab?: PlanTab;
  initialSelected?: string | null;
  initialForm?: { kind: PlanKind; id: string | null } | null;
}

type Side = { mode: 'none' } | { mode: 'record'; id: string } | { mode: 'form'; kind: PlanKind; id: string | null; preset?: Draft };

export function IpPlanView(props: IpPlanViewProps) {
  const { plan, folders, names, you, initialTab = 'addresses', initialSelected = null, initialForm = null } = props;
  const records = plan.records;
  const [tab, setTab] = useState<PlanTab>(initialTab);
  const [side, setSide] = useState<Side>(initialForm ? { mode: 'form', ...initialForm } : initialSelected ? { mode: 'record', id: initialSelected } : { mode: 'none' });
  const [vrf, setVrf] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  // Where the panel sits above the list, bring it into view when it opens or changes.
  const sideRef = useRef<HTMLElement | null>(null);
  const sideKey = side.mode === 'none' ? '' : side.mode === 'record' ? side.id : `${side.kind}-${side.id ?? 'new'}`;
  useEffect(() => {
    if (sideKey !== '') sideRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [sideKey]);
  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const folderName = useCallback((id: string | null) => (id === null ? '' : (folders.find((f) => f.id === id)?.label ?? 'A folder you cannot see')), [folders]);

  const selected = side.mode === 'record' ? (byId.get(side.id) ?? null) : null;
  const open = (id: string) => {
    setNotice(null);
    setSide({ mode: 'record', id });
  };
  const add = (kind: PlanKind, preset?: Draft) => {
    setNotice(null);
    setSide({ mode: 'form', kind, id: null, preset });
  };

  const vrfs = vrfsInUse(records);
  const shownVrf = vrfs.includes(vrf) ? vrf : '';
  const tree = addressTree(records, shownVrf);
  const rowFor = (record: PlanRecord): TreeRow | undefined => addressTree(records, vrfOf(record)).find((r) => r.record.id === record.id);

  const pick = (id: string) => ({
    'aria-pressed': side.mode === 'record' && side.id === id,
    className: `ipplan__pick${side.mode === 'record' && side.id === id ? ' ipplan__pick--on' : ''}`,
    onClick: () => open(id),
    type: 'button' as const,
  });

  const addressesTab = (
    <>
      <div className="ipplan__bar">
        {vrfs.length > 1 && (
          <label className="org-field__inline">
            VRF
            <select className="org-input" value={shownVrf} onChange={(e) => setVrf(e.target.value)} data-testid="ip-plan-vrf">
              {vrfs.map((id) => (
                <option key={id} value={id}>
                  {nameOfVrf(records, id)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="org-actions">
          {(['aggregate', 'prefix', 'range', 'address', 'reservation'] as const).map((k) => (
            <button key={k} type="button" className="org-btn btn-small" onClick={() => add(k, k === 'aggregate' || shownVrf === '' ? {} : { vrf: shownVrf })}>
              Add {KIND_WORDS[k].toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      {tree.length === 0 ? (
        <p className="home__muted" data-testid="ip-plan-empty">
          Nothing is planned in {nameOfVrf(records, shownVrf).toLowerCase() === 'global table' ? 'the global table' : nameOfVrf(records, shownVrf)} yet. Start with an aggregate: the space
          the organisation holds, such as 10.0.0.0/8.
        </p>
      ) : (
        <div className="ipplan__scroll">
          <table className="org-table ipplan__tree" data-testid="ip-plan-tree">
            <thead>
              <tr>
                <th>Block</th>
                <th>Used</th>
                <th>Free</th>
              </tr>
            </thead>
            <tbody>
              {tree.map((row) => (
                <tr key={row.record.id} className={row.record.kind === 'reservation' && row.record.lapsed ? 'ipplan__row--lapsed' : undefined}>
                  <td style={{ paddingLeft: `calc(var(--s2) + ${row.depth} * var(--s4))` }}>
                    <button {...pick(row.record.id)}>
                      <span className="org-mono">{headline(row.record)}</span>
                      <span className="org-sub">{[subline(row.record, names, you), folderName(text(row.record.fields, 'folder'))].filter((x) => x !== '').join(' · ')}</span>
                    </button>
                  </td>
                  <td>
                    {isBlock(row.record.kind) && row.span && (
                      <span className="ipplan__meter">
                        <span className="ipplan__gauge" aria-hidden="true">
                          <span style={{ width: `${row.percent}%` }} />
                        </span>
                        <span className="org-sub">{usedWords(row)}</span>
                      </span>
                    )}
                  </td>
                  <td className="org-sub">{freeWords(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  const groups = records.filter((r) => r.kind === 'vlan_group');
  const vlansTab = (
    <>
      <div className="ipplan__bar">
        <div className="org-actions">
          <button type="button" className="org-btn btn-small" onClick={() => add('vlan_group')}>
            Add VLAN group
          </button>
          <button type="button" className="org-btn btn-small" onClick={() => add('vlan')} disabled={groups.length === 0}>
            Add VLAN
          </button>
        </div>
      </div>
      {groups.length === 0 && <p className="home__muted">No VLAN groups yet. A group holds the VLAN IDs handed out together, such as 100-199 for a campus.</p>}
      {groups.map((g) => {
        const vlans = records
          .filter((r) => r.kind === 'vlan' && text(r.fields, 'group') === g.id)
          .sort((a, b) => Number(text(a.fields, 'vid')) - Number(text(b.fields, 'vid')));
        return (
          <section key={g.id} className="ipplan__group">
            <button {...pick(g.id)}>
              <span className="ipplan__group-name">{text(g.fields, 'name')}</span>
              <span className="org-sub">
                IDs {texts(g.fields, 'vid_ranges').join(', ')} · {vlans.length} of {vidCount(texts(g.fields, 'vid_ranges'))} used
                {text(g.fields, 'folder') ? ` · ${folderName(text(g.fields, 'folder'))}` : ''}
              </span>
            </button>
            {vlans.length > 0 && (
              <table className="org-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Folder</th>
                  </tr>
                </thead>
                <tbody>
                  {vlans.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <button {...pick(v.id)}>
                          <span className="org-mono">{text(v.fields, 'vid')}</span>
                        </button>
                      </td>
                      <td>{text(v.fields, 'name')}</td>
                      <td className="org-sub">{text(v.fields, 'status')}</td>
                      <td className="org-sub">{folderName(text(v.fields, 'folder'))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </>
  );

  const asnRanges = records.filter((r) => r.kind === 'asn_range');
  const asnRows = (list: PlanRecord[]) =>
    list.length === 0 ? null : (
      <table className="org-table">
        <thead>
          <tr>
            <th>ASN</th>
            <th>Meant for</th>
            <th>Folder</th>
          </tr>
        </thead>
        <tbody>
          {list
            .sort((a, b) => Number(text(a.fields, 'asn')) - Number(text(b.fields, 'asn')))
            .map((a) => (
              <tr key={a.id}>
                <td>
                  <button {...pick(a.id)}>
                    <span className="org-mono">{text(a.fields, 'asn')}</span>
                  </button>
                </td>
                <td>{text(a.fields, 'meant_for')}</td>
                <td className="org-sub">{folderName(text(a.fields, 'folder'))}</td>
              </tr>
            ))}
        </tbody>
      </table>
    );
  const loose = records.filter((r) => r.kind === 'asn' && !asnRanges.some((g) => g.id === text(r.fields, 'range')));
  const asnsTab = (
    <>
      <div className="ipplan__bar">
        <div className="org-actions">
          <button type="button" className="org-btn btn-small" onClick={() => add('asn_range')}>
            Add ASN range
          </button>
          <button type="button" className="org-btn btn-small" onClick={() => add('asn')}>
            Add ASN
          </button>
        </div>
      </div>
      {asnRanges.length === 0 && loose.length === 0 && <p className="home__muted">No AS numbers yet. A range such as 4200000000-4200000999 (private, 4-byte) lets Fathom hand out the next free one.</p>}
      {asnRanges.map((g) => {
        const inside = records.filter((r) => r.kind === 'asn' && text(r.fields, 'range') === g.id);
        return (
          <section key={g.id} className="ipplan__group">
            <button {...pick(g.id)}>
              <span className="ipplan__group-name">{text(g.fields, 'name')}</span>
              <span className="org-sub">
                {text(g.fields, 'first')}–{text(g.fields, 'last')}
                {text(g.fields, 'rir') ? ` · ${text(g.fields, 'rir')}` : ''} · {inside.length} used
              </span>
            </button>
            {asnRows(inside)}
          </section>
        );
      })}
      {loose.length > 0 && (
        <section className="ipplan__group">
          <span className="ipplan__group-name">Not in a range</span>
          {asnRows(loose)}
        </section>
      )}
    </>
  );

  const vrfList = records.filter((r) => r.kind === 'vrf');
  const targets = records.filter((r) => r.kind === 'route_target');
  const targetNames = (ids: readonly string[]) => ids.map((id) => text(byId.get(id)?.fields ?? {}, 'value') ?? '?').join(', ');
  const vrfsTab = (
    <>
      <div className="ipplan__bar">
        <div className="org-actions">
          <button type="button" className="org-btn btn-small" onClick={() => add('vrf')}>
            Add VRF
          </button>
          <button type="button" className="org-btn btn-small" onClick={() => add('route_target')}>
            Add route target
          </button>
        </div>
      </div>
      <p className="org-field__hint">Without a VRF a block is in the global table. A VRF is matched to a routing instance of the same name in a design.</p>
      {vrfList.length > 0 && (
        <table className="org-table">
          <thead>
            <tr>
              <th>VRF</th>
              <th>Route distinguisher</th>
              <th>Same network twice</th>
              <th>Imports</th>
              <th>Exports</th>
            </tr>
          </thead>
          <tbody>
            {vrfList.map((v) => (
              <tr key={v.id}>
                <td>
                  <button {...pick(v.id)}>
                    <span>{text(v.fields, 'name')}</span>
                  </button>
                </td>
                <td className="org-mono">{text(v.fields, 'route_distinguisher')}</td>
                <td className="org-sub">{flag(v.fields, 'enforce_unique') ? 'Refused' : 'Allowed'}</td>
                <td className="org-mono">{targetNames(texts(v.fields, 'import_targets'))}</td>
                <td className="org-mono">{targetNames(texts(v.fields, 'export_targets'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {targets.length > 0 && (
        <table className="org-table">
          <thead>
            <tr>
              <th>Route target</th>
              <th>Used by</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id}>
                <td>
                  <button {...pick(t.id)}>
                    <span className="org-mono">{text(t.fields, 'value')}</span>
                  </button>
                </td>
                <td className="org-sub">
                  {vrfList
                    .filter((v) => texts(v.fields, 'import_targets').includes(t.id) || texts(v.fields, 'export_targets').includes(t.id))
                    .map((v) => text(v.fields, 'name'))
                    .join(', ')}
                </td>
                <td className="org-sub">{text(t.fields, 'note')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );

  const body = tab === 'addresses' ? addressesTab : tab === 'vlans' ? vlansTab : tab === 'asns' ? asnsTab : vrfsTab;

  let aside: ReactNode = null;
  if (side.mode === 'form') {
    const record = side.id ? (byId.get(side.id) ?? null) : null;
    aside = (
      <RecordForm
        key={`${side.kind}-${side.id ?? 'new'}`}
        kind={side.kind}
        record={record}
        preset={side.preset}
        records={records}
        folders={folders}
        onCancel={() => setSide(record ? { mode: 'record', id: record.id } : { mode: 'none' })}
        onSave={async (fields) => {
          const saved = await props.onSave(side.kind, record, fields);
          setNotice(record ? 'Saved.' : `${KIND_WORDS[side.kind]} added.`);
          setSide({ mode: 'record', id: saved.id });
        }}
      />
    );
  } else if (selected) {
    aside = (
      <RecordPanel
        key={selected.id}
        record={selected}
        row={rowFor(selected)}
        records={records}
        today={plan.today}
        names={names}
        you={you}
        folderName={folderName}
        notice={notice}
        onEdit={() => setSide({ mode: 'form', kind: selected.kind, id: selected.id })}
        onClose={() => setSide({ mode: 'none' })}
        onDelete={async () => {
          await props.onDelete(selected);
          setNotice(null);
          setSide({ mode: 'none' });
        }}
        onLook={(want) => props.onLook(selected, want)}
        onTake={async (want, key, hold) => {
          const taken = await props.onTake(selected, want, key, hold);
          setNotice(taken.again ? `That key was answered before: ${headline(taken.record)}, unchanged.` : `${headline(taken.record)} is yours until you release it.`);
          setSide({ mode: 'record', id: taken.record.id });
          if (taken.record.kind === 'vlan') setTab('vlans');
          if (taken.record.kind === 'asn') setTab('asns');
        }}
        onAddInside={(preset) => add('address', preset)}
      />
    );
  }

  return (
    <section className="org-page ipplan" data-testid="ip-plan">
      <div className="ipplan__head">
        <div className="org-page__title">IP plan</div>
        <NetboxDownload records={records} onDownload={props.onDownload} />
      </div>
      <p className="org-field__hint">
        The organisation’s address plan: blocks, VLANs and AS numbers, kept on the server beside your designs. Nothing here changes a design. Next free skips what any
        design already uses.
      </p>
      <div className="org-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" className="org-tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={`ip-plan-tab-${id}`}>
            {label}
          </button>
        ))}
      </div>
      <div className={`ipplan__body${aside ? ' ipplan__body--open' : ''}`}>
        <div className="ipplan__main">{body}</div>
        {aside && (
          <aside className="ipplan__side" ref={sideRef}>
            {aside}
          </aside>
        )}
      </div>
    </section>
  );
}

function freeWords(row: TreeRow): string {
  if (row.record.kind !== 'aggregate' && row.record.kind !== 'prefix') return '';
  if (row.used === row.size) return 'None';
  if (row.children.length === 0) return 'All of it';
  return row.free.join(', ') + (row.freeMore ? ', and more' : '');
}

function vidCount(ranges: readonly string[]): number {
  return ranges.reduce((n, r) => {
    const [a, b] = r.split('-').map((x) => Number(x.trim()));
    return n + (Number.isFinite(a) ? (Number.isFinite(b) ? b - a + 1 : 1) : 0);
  }, 0);
}

// ---------------------------------------------------------------------------
// NetBox files

function NetboxDownload({ records, onDownload }: { records: readonly PlanRecord[]; onDownload: (name: string, csv: string) => void }) {
  const files = netboxFiles(records);
  const gaps = netboxGaps(records);
  return (
    <details className="ipplan__netbox" data-testid="ip-plan-netbox">
      <summary className="org-btn btn-small">Download for NetBox</summary>
      <div className="ipplan__netbox-pop">
        {files.length === 0 ? (
          <p className="org-sub">Nothing to download yet.</p>
        ) : (
          <>
            <p className="org-sub">One file for each of NetBox’s import pages. Load them in this order, so each finds what it names.</p>
            <ul className="org-rows">
              {files.map((f) => (
                <li key={f.name} className="org-row">
                  <span>
                    {f.netbox} <span className="org-sub">({f.count})</span>
                  </span>
                  <button type="button" className="org-link" onClick={() => onDownload(f.name, f.csv)}>
                    {f.name}
                  </button>
                </li>
              ))}
            </ul>
            {gaps.map((g) => (
              <p key={g} className="org-sub">
                {g}
              </p>
            ))}
          </>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// One record: its facts, its actions, and next free

const FACT_SKIP = new Set(['note']);

function factValue(spec: FieldSpec, record: PlanRecord, records: readonly PlanRecord[], folderName: (id: string | null) => string): string {
  const f = record.fields;
  const name = (id: string, field: string) => text(records.find((r) => r.id === id)?.fields ?? {}, field) ?? '?';
  switch (spec.type) {
    case 'flag':
      return flag(f, spec.name) ? 'Yes' : '';
    case 'vrf':
      return text(f, 'vrf') ? nameOfVrf(records, text(f, 'vrf') as string) : 'Global table';
    case 'folder':
      return text(f, 'folder') ? folderName(text(f, 'folder')) : 'The whole organisation';
    case 'group':
    case 'asnRange':
      return text(f, spec.name) ? name(text(f, spec.name) as string, 'name') : '';
    case 'targets':
      return texts(f, spec.name)
        .map((id) => name(id, 'value'))
        .join(', ');
    case 'list':
      return texts(f, spec.name).join(', ');
    default:
      return spec.name === HELD ? '' : (text(f, spec.name) ?? '');
  }
}

interface RecordPanelProps {
  record: PlanRecord;
  row: TreeRow | undefined;
  records: readonly PlanRecord[];
  today: string;
  names: ReadonlyMap<string, string>;
  you: string | null;
  folderName: (id: string | null) => string;
  notice: string | null;
  onEdit: () => void;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onLook: (want: Want) => Promise<string>;
  onTake: (want: Want, key: string, hold: PlanFields) => Promise<void>;
  onAddInside: (preset: Draft) => void;
}

function RecordPanel({ record, row, records, today, names, you, folderName, notice, onEdit, onClose, onDelete, onLook, onTake, onAddInside }: RecordPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReservation = record.kind === 'reservation';
  const facts: [string, string][] = [];
  if (isReservation) {
    facts.push(['Held by', holderLine(record, names, you)]);
    facts.push(['Ends', `${text(record.fields, 'ends') ?? '?'}${record.lapsed ? ' (lapsed: still held until it is released)' : ''}`]);
    if (text(record.fields, 'allocation_key')) facts.push(['Asked for by', text(record.fields, 'allocation_key') as string]);
  }
  for (const spec of FORMS[record.kind]) {
    if (FACT_SKIP.has(spec.name) || (isReservation && (spec.name === 'work' || spec.name === 'ends'))) continue;
    const v = factValue(spec, record, records, folderName);
    if (v !== '') facts.push([spec.type === 'flag' ? 'Set' : spec.label, spec.type === 'flag' ? spec.label : v]);
  }
  const usable = usableWords(record);
  if (usable) facts.push(['Addresses', usable]);
  if (row && isBlock(record.kind) && row.span) facts.push(['In use', usedWords(row)]);
  if (row && (record.kind === 'aggregate' || record.kind === 'prefix')) facts.push(['Free', freeWords(row)]);
  const inside = row ? row.children.length : 0;

  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(sentence(e));
      setBusy(false);
      setConfirming(false);
    }
  };
  const verb = isReservation ? 'Release' : 'Delete';

  return (
    <div className="ipplan__panel" data-testid="ip-plan-panel">
      <div className="ipplan__panel-head">
        <div>
          <div className="org-tag ipplan__kind">{KIND_WORDS[record.kind]}</div>
          <div className="ipplan__panel-title org-mono">{headline(record)}</div>
        </div>
        <button type="button" className="org-link" onClick={onClose}>
          Close
        </button>
      </div>
      {notice && (
        <p className="org-note" role="status">
          {notice}
        </p>
      )}
      <dl className="org-facts">
        {facts.map(([k, v]) => (
          <FactRow key={`${k}-${v}`} k={k} v={v} />
        ))}
      </dl>
      {text(record.fields, 'note') && <p className="org-sub">{text(record.fields, 'note')}</p>}
      <div className="org-actions">
        <button type="button" className="org-btn btn-small" onClick={onEdit} disabled={busy}>
          Edit
        </button>
        {record.kind === 'prefix' && (
          <button type="button" className="org-btn btn-small" onClick={() => onAddInside(addInsidePreset(record))} disabled={busy}>
            Add an address in it
          </button>
        )}
        {!confirming && (
          <button type="button" className="org-btn btn-small btn-danger" onClick={() => setConfirming(true)} disabled={busy} data-testid="ip-plan-delete">
            {verb}
          </button>
        )}
      </div>
      {confirming && (
        <div className="ipplan__confirm" role="group" aria-label={`${verb} ${headline(record)}`}>
          <p>
            {verb} {headline(record)}?{' '}
            {isReservation
              ? 'It goes back to being free.'
              : inside > 0
                ? `What is inside it stays in the plan and moves up a level.`
                : 'This cannot be undone, though the plan’s history keeps it.'}
          </p>
          <div className="org-actions">
            <button type="button" className="org-btn btn-small btn-danger" onClick={() => void del()} disabled={busy} data-testid="ip-plan-delete-yes">
              {verb}
            </button>
            <button type="button" className="org-btn btn-small" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}
      <NextFree key={record.id} record={record} today={today} onLook={onLook} onTake={onTake} />
    </div>
  );
}

function FactRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function holderLine(record: PlanRecord, names: ReadonlyMap<string, string>, you: string | null): string {
  const work = text(record.fields, 'work');
  const holder = text(record.fields, 'holder');
  const person = holder ? (holder === you ? 'you' : (names.get(holder) ?? 'someone no longer here')) : null;
  if (work && person) return `${work}, reserved by ${person}`;
  return work ?? person ?? 'nobody named';
}

/** A new address inside a prefix starts in its VRF and folder, with its length. */
function addInsidePreset(record: PlanRecord): Draft {
  const p = parseCidrBig(text(record.fields, 'prefix') ?? '');
  const preset: Draft = {};
  if (text(record.fields, 'vrf')) preset.vrf = text(record.fields, 'vrf') as string;
  if (text(record.fields, 'folder')) preset.folder = text(record.fields, 'folder') as string;
  if (p) preset.address = `/${p.len}`;
  return preset;
}

/** What next free can be asked of this record, if anything. */
export function wantsFor(record: PlanRecord): ('prefix' | 'address' | 'vlan' | 'asn')[] {
  switch (record.kind) {
    case 'aggregate':
      return ['prefix'];
    case 'prefix':
      return ['prefix', 'address'];
    case 'range':
      return ['address'];
    case 'vlan_group':
      return ['vlan'];
    case 'asn_range':
      return ['asn'];
    default:
      return [];
  }
}

function plusDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function NextFree({ record, today, onLook, onTake }: { record: PlanRecord; today: string; onLook: (want: Want) => Promise<string>; onTake: (want: Want, key: string, hold: PlanFields) => Promise<void> }) {
  const wants = wantsFor(record);
  const span = parseCidrBig(text(record.fields, 'prefix') ?? '');
  const defaultLength = span ? Math.min(span.v6 ? 64 : 29, Math.max(span.len + 1, span.v6 ? 48 : 24)) : 29;
  const [want, setWant] = useState(wants[0] ?? 'prefix');
  const [length, setLength] = useState(String(defaultLength));
  const [found, setFound] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [reason, setReason] = useState('');
  const [work, setWork] = useState('');
  const [ends, setEnds] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (wants.length === 0) return null;

  const asked = (): Want => (want === 'prefix' ? { want: 'prefix', length: Number(length) } : want === 'vlan' ? { want: 'vlan', name } : { want });
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch (e) {
      setError(sentence(e));
    } finally {
      setBusy(false);
    }
  };
  const look = () =>
    void run(async () => {
      setFound(await onLook(asked()));
    });
  const take = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const hold: Record<string, PlanValue> = want === 'asn' ? cleanFields({ meant_for: name }) : want === 'vlan' ? {} : cleanFields({ reason, work, ends });
      await onTake(asked(), key, hold);
      setFound(null);
    });
  };
  const maxLength = span ? (span.v6 ? 128 : 32) : 32;
  const lengths: number[] = [];
  if (span) for (let l = span.len + 1; l <= maxLength; l += 1) lengths.push(l);
  const needsReason = want === 'prefix' || want === 'address';
  const canTake = key.trim() !== '' && (!needsReason || reason.trim() !== '') && (want !== 'vlan' || name.trim() !== '');
  const thing = want === 'prefix' ? `a /${length}` : want === 'address' ? 'an address' : want === 'vlan' ? 'a VLAN ID' : 'an ASN';

  return (
    <form className="ipplan__next" onSubmit={take} data-testid="ip-plan-next">
      <div className="ipplan__next-title">Next free</div>
      <div className="org-inline">
        {wants.length > 1 && (
          <label className="org-field">
            <span className="org-field__label">What</span>
            <select
              className="org-input"
              value={want}
              onChange={(e) => {
                setWant(e.target.value as typeof want);
                setFound(null);
              }}
            >
              {wants.map((w) => (
                <option key={w} value={w}>
                  {w === 'prefix' ? 'A smaller prefix' : 'One address'}
                </option>
              ))}
            </select>
          </label>
        )}
        {want === 'prefix' && (
          <label className="org-field">
            <span className="org-field__label">Length</span>
            <select
              className="org-input"
              value={length}
              onChange={(e) => {
                setLength(e.target.value);
                setFound(null);
              }}
              data-testid="ip-plan-length"
            >
              {lengths.map((l) => (
                <option key={l} value={l}>
                  /{l}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="org-btn btn-small" onClick={look} disabled={busy} data-testid="ip-plan-look">
          Find {thing}
        </button>
      </div>
      {found !== null && (
        <>
          <p className="ipplan__found" role="status" data-testid="ip-plan-found">
            Next free: <span className="org-mono">{found}</span>
          </p>
          <label className="org-field">
            <span className="org-field__label">Key</span>
            <input className="org-input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="W-1042/wan" data-testid="ip-plan-key" />
            <span className="org-field__hint">What asked for it. Asking again with the same key gives the same answer, never a second one.</span>
          </label>
          {needsReason && (
            <>
              <label className="org-field">
                <span className="org-field__label">Reason</span>
                <input className="org-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="WAN for the new branch" data-testid="ip-plan-reason" />
              </label>
              <label className="org-field">
                <span className="org-field__label">Piece of work</span>
                <input className="org-input" value={work} onChange={(e) => setWork(e.target.value)} placeholder="W-1042" />
                <span className="org-field__hint">Leave empty and you hold it yourself.</span>
              </label>
              <label className="org-field">
                <span className="org-field__label">Ends</span>
                <input className="org-input" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
                <span className="org-field__hint">Empty is 30 days from today ({plusDays(today, 30)}).</span>
              </label>
            </>
          )}
          {want === 'vlan' && (
            <label className="org-field">
              <span className="org-field__label">Name</span>
              <input className="org-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Guests" />
            </label>
          )}
          {want === 'asn' && (
            <label className="org-field">
              <span className="org-field__label">Meant for</span>
              <input className="org-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Branch 12 edge" />
            </label>
          )}
          <div className="org-actions">
            <button type="submit" className="org-btn btn-main btn-small" disabled={busy || !canTake} data-testid="ip-plan-take">
              {needsReason ? 'Reserve it' : 'Take it'}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="home__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Adding and changing a record

interface RecordFormProps {
  kind: PlanKind;
  record: PlanRecord | null;
  preset?: Draft;
  records: readonly PlanRecord[];
  folders: readonly PlanFolder[];
  onCancel: () => void;
  onSave: (fields: PlanFields) => Promise<void>;
}

function RecordForm({ kind, record, preset, records, folders, onCancel, onSave }: RecordFormProps) {
  const [draft, setDraft] = useState<Draft>(() => {
    const d = draftFor(kind, record, preset);
    for (const spec of FORMS[kind]) if (spec.type === 'list' && Array.isArray(d[spec.name])) d[spec.name] = (d[spec.name] as string[]).join(', ');
    return d;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (name: string, v: PlanValue) => setDraft((d) => ({ ...d, [name]: v }));
  const missing = FORMS[kind].filter((s) => s.required && (typeof draft[s.name] !== 'string' || (draft[s.name] as string).trim() === '' || (s.name === 'address' && (draft[s.name] as string).trim().startsWith('/'))));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(fieldsFromDraft(kind, draft, record));
    } catch (err) {
      setError(sentence(err));
      setBusy(false);
    }
  };
  const options = (k: PlanKind, field: string) => records.filter((r) => r.kind === k).map((r) => [r.id, text(r.fields, field) ?? '?'] as const);

  const control = (spec: FieldSpec) => {
    const v = draft[spec.name];
    const id = `ipplan-${kind}-${spec.name}`;
    if (spec.type === 'flag') {
      return (
        <label key={spec.name} className="org-field__inline">
          <input type="checkbox" checked={v === true} onChange={(e) => set(spec.name, e.target.checked)} />
          {spec.label}
        </label>
      );
    }
    let input: ReactNode;
    const str = typeof v === 'string' ? v : '';
    const select = (choices: readonly (readonly [string, string])[], none: string | null) => (
      <select id={id} className="org-input" value={str} onChange={(e) => set(spec.name, e.target.value)}>
        {none !== null && <option value="">{none}</option>}
        {choices.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    );
    if (spec.type === 'choice') input = select((spec.choices ?? []).map((c) => [c, c] as const), spec.required ? null : 'None');
    else if (spec.type === 'vrf') input = select(options('vrf', 'name'), 'Global table');
    else if (spec.type === 'folder') input = select(folders.map((f) => [f.id, f.label] as const), 'The whole organisation');
    else if (spec.type === 'group') input = select(options('vlan_group', 'name'), record ? null : 'Pick a group');
    else if (spec.type === 'asnRange') input = select(options('asn_range', 'name'), 'Not in a range');
    else if (spec.type === 'targets') {
      const chosen = Array.isArray(v) ? v : [];
      const all = options('route_target', 'value');
      input =
        all.length === 0 ? (
          <span className="org-field__hint">No route targets yet. Add them under VRFs and route targets.</span>
        ) : (
          <span className="ipplan__ticks">
            {all.map(([rid, label]) => (
              <label key={rid} className="org-field__inline">
                <input type="checkbox" checked={chosen.includes(rid)} onChange={(e) => set(spec.name, e.target.checked ? [...chosen, rid] : chosen.filter((x) => x !== rid))} />
                <span className="org-mono">{label}</span>
              </label>
            ))}
          </span>
        );
    } else input = <input id={id} className="org-input" type={spec.type === 'date' ? 'date' : 'text'} value={str} placeholder={spec.placeholder} onChange={(e) => set(spec.name, e.target.value)} />;
    return (
      <div key={spec.name} className="org-field">
        <label className="org-field__label" htmlFor={id}>
          {spec.label}
          {spec.required ? '' : ' (optional)'}
        </label>
        {input}
        {spec.hint && <span className="org-field__hint">{spec.hint}</span>}
      </div>
    );
  };

  const fields = FORMS[kind].filter((s) => !(kind === 'aggregate' && s.name === 'vrf'));
  return (
    <form className="ipplan__panel ipplan__form" onSubmit={(e) => void submit(e)} data-testid="ip-plan-form">
      <div className="ipplan__panel-head">
        <div className="ipplan__panel-title">{record ? `Change ${headline(record)}` : `Add ${KIND_WORDS[kind].toLowerCase()}`}</div>
      </div>
      {fields.map(control)}
      {error && (
        <p className="home__error" role="alert" data-testid="ip-plan-form-error">
          {error}
        </p>
      )}
      <div className="org-actions">
        <button type="submit" className="org-btn btn-main btn-small" disabled={busy || missing.length > 0} data-testid="ip-plan-save">
          {record ? 'Save' : 'Add'}
        </button>
        <button type="button" className="org-btn btn-small" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

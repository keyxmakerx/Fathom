// Who is plugged in where (round 29, card r29-fill; mockup r29-autofill-a). The suggestions card's other half: a
// switch's MAC table, and optionally a router's ARP table or DHCP leases for the addresses and names. Each port that learned one address
// becomes a ticked suggestion, a cable to a drawn port with that MAC or a new sketch device; the rest are listed
// with why they are left. "Add" is the only write, one undo step. Skip writes nothing, and the text is never kept.
import { useContext, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';

import { asString, fieldValue, parseNodeId, type Document } from '../../document/model';
import { acceptHosts, readAddresses, readMacTable, suggestHosts, type ArpRow, type HostSuggestion, type MacTable } from '../../document/hosts';
import { deviceOf } from '../../document/portTies';
import { SuggestContext } from './suggestStore';
import '../paste/paste.css';
import './suggest.css';

export interface HostsCardProps {
  doc: Document;
  deviceId: string | null;
  /** The MAC table, already pasted. */
  text: string;
  actor?: string;
  /** Where the first new device is pinned; the rest follow in a row. */
  spot?: () => { x: number; y: number };
  onApply: (next: Document, deviceId: string) => void;
  onClose: () => void;
}

export const HOSTS_LINE = "Fathom read a MAC table: which hardware address each port has seen. A port that has seen one becomes a suggested device or cable; you accept them, all or one by one.";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function namedDevices(doc: Document): { id: string; name: string }[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device')
    .map((n) => ({ id: n.id, name: asString(fieldValue(n.fields, 'Device.hostname')) ?? '' }))
    .filter((d) => d.name.trim() !== '')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function HostsCard({ doc, deviceId, text, actor, spot, onApply, onClose }: HostsCardProps): JSX.Element {
  const [device, setDevice] = useState<string | null>(() => (deviceId === null ? null : deviceOf(doc, deviceId)));
  const table: MacTable = useMemo(() => readMacTable(text) ?? { format: 'cisco', rows: [] }, [text]);
  // An ARP table pasted with the MAC table counts; a second box takes one from the router.
  const [arp, setArp] = useState<ArpRow[]>(() => readAddresses(text));
  const [box, setBox] = useState('');
  const [unread, setUnread] = useState(false);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [refusal, setRefusal] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const headId = useId();
  const store = useContext(SuggestContext);

  const devices = useMemo(() => namedDevices(doc), [doc]);
  const rows: HostSuggestion[] = useMemo(() => (device !== null ? suggestHosts(doc, device, table, arp) : []), [doc, device, table, arp]);
  const ready = rows.filter((r) => r.state === 'ready');
  const ticked = ready.filter((r) => !unticked.has(r.key));
  const cabled = rows.filter((r) => r.state === 'cabled').length;
  const shown = rows.filter((r) => r.state !== 'cabled');
  const left = shown.filter((r) => r.state !== 'ready');
  const fresh = ticked.filter((r) => r.kind === 'new').length;
  const cables = ticked.length;

  // Cables to drawn ports are dashed lines; a device not drawn yet has nowhere to draw one.
  const lineKey = ticked.map((r) => r.key).join(',');
  useEffect(() => {
    store?.set(ticked.filter((r) => r.kind === 'cable').map((r) => ({ key: r.key, ends: [r.localPortId!, r.remotePortId!] as const })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys say when the lines changed
  }, [store, lineKey]);
  useEffect(() => () => store?.set([]), [store]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('select, button')?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const readMore = () => {
    const more = readAddresses(box);
    if (more.length === 0) {
      setUnread(true);
      return;
    }
    setUnread(false);
    setBox('');
    setArp([...arp, ...more]);
  };

  const add = () => {
    if (device === null) return;
    try {
      const origin = spot?.() ?? { x: 40, y: 40 };
      onApply(acceptHosts(doc, device, table, arp, new Set(ticked.map((r) => r.key)), origin, actor !== undefined ? { actor } : undefined), device);
      onClose();
    } catch {
      setRefusal('Something could not be added, so nothing was changed. Read the table again.');
    }
  };

  const switchName = device !== null ? (devices.find((d) => d.id === device)?.name ?? 'This switch') : '';
  const addWord = fresh > 0 ? `Add ${plural(fresh, 'device', 'devices')} and ${plural(cables, 'cable', 'cables')}` : cables > 0 ? `Add ${plural(cables, 'cable', 'cables')}` : 'Add';

  return (
    <div className="paste-card suggest-card" role="dialog" aria-labelledby={headId} data-testid="hosts-card" ref={ref}>
      <div className="paste-card__head" id={headId}>
        {`Who is plugged in · ${shown.length}`}
      </div>
      <p className="suggest-card__line">{HOSTS_LINE}</p>

      <label className="suggest-card__from">
        <span>From</span>
        <select value={device ?? ''} onChange={(e) => setDevice(e.target.value === '' ? null : e.target.value)} aria-label="The switch the table was read on">
          <option value="">Choose the switch</option>
          {device !== null && !devices.some((d) => d.id === device) && <option value={device}>This switch</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      {device === null ? (
        <p className="paste-card__note">Choose the switch this table was read on, and what it has seen appears here.</p>
      ) : (
        <>
          {shown.length > 0 && (
            <ul className="suggest-card__rows">
              {shown.map((r) => {
                const on = r.state === 'ready' && !unticked.has(r.key);
                return (
                  <li key={r.key} className={r.state === 'ready' ? '' : 'suggest-card__left'}>
                    <label>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={r.state !== 'ready'}
                        onChange={(e) => {
                          const next = new Set(unticked);
                          if (e.target.checked) next.delete(r.key);
                          else next.add(r.key);
                          setUnticked(next);
                        }}
                      />
                      <span className="suggest-card__end">
                        {switchName} <span className="suggest-card__port">{r.port}</span>
                      </span>
                      <span className="suggest-card__end suggest-card__far">
                        {r.state === 'several' ? `${r.macs.length} addresses` : r.kind === 'new' ? `new: ${r.name}` : r.name}{' '}
                        <span className="suggest-card__port">{r.state === 'several' ? '' : (r.ip ?? r.macs[0])}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {left.map((r) => (
            <p key={r.key} className="paste-card__note suggest-card__why">{r.why}</p>
          ))}
          {cabled > 0 && <p className="paste-card__note suggest-card__why">{plural(cabled, 'cable in the table is', 'cables in the table are')} already drawn.</p>}
          {rows.length === 0 && <p className="paste-card__note">The table names no port with an address on it.</p>}

          <p className="paste-card__note suggest-card__how">
            {arp.length > 0 ? `${plural(arp.length, 'address', 'addresses')} read. ` : ''}
            For addresses and names, run <code>show ip arp</code> (Cisco), <code>show arp</code> (Juniper) or <code>ip neigh</code> (Linux) on the router, or paste its DHCP leases (<code>dhcpd.leases</code>, <code>dnsmasq.leases</code>, Kea's <code>kea-leases4.csv</code>), here.
          </p>
          <textarea className="paste-card__box" rows={3} value={box} onChange={(e) => setBox(e.target.value)} placeholder="paste an ARP table or DHCP leases (optional)" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" aria-label="ARP table or DHCP leases" />
          {unread && <p className="paste-card__refusal" role="alert">That does not read as an ARP table or DHCP leases. Paste the whole table or file.</p>}
          {refusal !== '' && <p className="paste-card__refusal" role="alert">{refusal}</p>}
          <div className="paste-card__actions suggest-card__actions">
            <button type="button" onClick={readMore} disabled={box.trim() === ''}>Read addresses</button>
            <button type="button" onClick={onClose}>Skip</button>
            <button type="button" className="suggest-card__add" disabled={ticked.length === 0} onClick={add}>
              {addWord}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

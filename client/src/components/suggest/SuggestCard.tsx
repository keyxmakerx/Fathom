// Cable suggestions from a neighbour list (round 15, card r15-cables; mockup r15-f3). The card sits at the right
// so the dashed lines on the canvas stay in view. It says in one line what it does and how to get the list, reads
// the pasted list, and ticks every cable it can name for certain; the rest are listed with why they are left.
// "Add" is the only write: ordinary cables, one undo step. Skip writes nothing, and the text is never kept.
import { useContext, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';

import { asString, fieldValue, parseNodeId, type Document } from '../../document/model';
import { acceptSuggestions, readNeighbours, suggestCables, type CableSuggestion, type NeighbourList } from '../../document/neighbours';
import { deviceOf } from '../../document/portTies';
import { SuggestContext } from './suggestStore';
import '../paste/paste.css';
import './suggest.css';

export interface SuggestCardProps {
  doc: Document;
  /** The device (or its chassis) the list was read on; null asks. */
  deviceId: string | null;
  /** Text already pasted onto the canvas, read at once; absent shows the box. */
  text?: string;
  actor?: string;
  /** Writes the cables; `deviceId` is the switch, so the caller can show its ports. */
  onApply: (next: Document, deviceId: string) => void;
  onClose: () => void;
}

export const SUGGEST_LINE = "Paste a switch's neighbour list (LLDP). Fathom suggests each cable as a dashed line; you accept them, all or one by one.";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Named devices to pick from, by name. */
function namedDevices(doc: Document): { id: string; name: string }[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device')
    .map((n) => ({ id: n.id, name: asString(fieldValue(n.fields, 'Device.hostname')) ?? '' }))
    .filter((d) => d.name.trim() !== '')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function SuggestCard({ doc, deviceId, text, actor, onApply, onClose }: SuggestCardProps): JSX.Element {
  const [device, setDevice] = useState<string | null>(() => (deviceId === null ? null : deviceOf(doc, deviceId)));
  const [list, setList] = useState<NeighbourList | null>(() => (text === undefined ? null : readNeighbours(text)));
  const [box, setBox] = useState('');
  const [unread, setUnread] = useState(text !== undefined && (readNeighbours(text)?.rows.length ?? 0) === 0);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [refusal, setRefusal] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const headId = useId();
  const store = useContext(SuggestContext);

  const devices = useMemo(() => namedDevices(doc), [doc]);
  const rows: CableSuggestion[] = useMemo(() => (device !== null && list !== null ? suggestCables(doc, device, list) : []), [doc, device, list]);
  const ready = rows.filter((r) => r.state === 'ready');
  const ticked = ready.filter((r) => !unticked.has(r.key));
  const cabled = rows.filter((r) => r.state === 'cabled').length;
  const shown = rows.filter((r) => r.state !== 'cabled');
  const left = shown.filter((r) => r.state !== 'ready');

  // The ticked cables are the dashed lines; closing the card takes them away.
  const lineKey = ticked.map((r) => r.key).join(',');
  useEffect(() => {
    store?.set(ticked.map((r) => ({ key: r.key, ends: [r.localPortId!, r.remotePortId!] as const })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys say when the lines changed
  }, [store, lineKey]);
  useEffect(() => () => store?.set([]), [store]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('select, textarea, input, button')?.focus();
  }, [list === null]);
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

  const read = () => {
    const parsed = readNeighbours(box);
    if (parsed === null || parsed.rows.length === 0) {
      setUnread(true);
      return;
    }
    setUnread(false);
    setBox('');
    setUnticked(new Set());
    setList(parsed);
  };

  const add = () => {
    if (device === null || list === null) return;
    try {
      onApply(acceptSuggestions(doc, device, list, new Set(ticked.map((r) => r.key)), actor !== undefined ? { actor } : undefined), device);
      onClose();
    } catch {
      setRefusal('A cable could not be added, so nothing was changed. Read the list again.');
    }
  };

  const localName = device !== null ? (devices.find((d) => d.id === device)?.name ?? 'This device') : '';

  return (
    <div className="paste-card suggest-card" role="dialog" aria-labelledby={headId} data-testid="suggest-card" ref={ref}>
      <div className="paste-card__head" id={headId}>
        {list === null ? 'Suggest cables' : `Suggested cables · ${shown.length}`}
      </div>
      <p className="suggest-card__line">{SUGGEST_LINE}</p>

      <label className="suggest-card__from">
        <span>From</span>
        <select value={device ?? ''} onChange={(e) => setDevice(e.target.value === '' ? null : e.target.value)} aria-label="The switch the list was read on">
          <option value="">Choose the switch</option>
          {device !== null && !devices.some((d) => d.id === device) && <option value={device}>This device</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      {list === null ? (
        <>
          <p className="paste-card__note suggest-card__how">
            On the switch, run <code>show lldp neighbors</code> (Juniper, Cisco, Arista) or <code>lldpcli show neighbors</code> (Linux), then paste what it prints.
          </p>
          <textarea className="paste-card__box" rows={7} value={box} onChange={(e) => setBox(e.target.value)} placeholder="paste the neighbour list" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" aria-label="Neighbour list" />
          {unread && <p className="paste-card__refusal" role="alert">That does not read as a neighbour list. Paste the whole table, with its header line.</p>}
          <div className="paste-card__actions">
            <button type="button" onClick={read} disabled={box.trim() === ''}>Read it</button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : device === null ? (
        <p className="paste-card__note">Choose the switch this list was read on, and its cables appear here.</p>
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
                        {localName} <span className="suggest-card__port">{r.row.local}</span>
                      </span>
                      <span className="suggest-card__end suggest-card__far">
                        {r.remoteName} <span className="suggest-card__port">{r.state === 'no-port' && r.localPortId !== null ? '?' : r.row.port}</span>
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
          {cabled > 0 && <p className="paste-card__note suggest-card__why">{plural(cabled, 'cable in the list is', 'cables in the list are')} already drawn.</p>}
          {rows.length === 0 && <p className="paste-card__note">Nothing in the list names another device.</p>}
          {refusal !== '' && <p className="paste-card__refusal" role="alert">{refusal}</p>}
          <div className="paste-card__actions suggest-card__actions">
            <button type="button" onClick={onClose}>Skip</button>
            <button type="button" className="suggest-card__add" disabled={ticked.length === 0} onClick={add}>
              {ticked.length === 0 ? 'Add cables' : `Add ${plural(ticked.length, 'cable', 'cables')}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

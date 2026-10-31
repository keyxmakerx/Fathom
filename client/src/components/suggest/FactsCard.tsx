// What a device says about itself (round 29, card r29-fill): the suggestions card's third half, opened by a pasted
// `show version`, `show inventory` or `show chassis hardware`. What the drawing lacks is ticked; where it differs, the
// row is offered unticked; the model and the hostname are only said. "Save" is the only write, one undo step.
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';

import { acceptFacts, readFacts, suggestFacts, type FactKey } from '../../document/facts';
import { asString, fieldValue, parseNodeId, type Document } from '../../document/model';
import { deviceOf } from '../../document/portTies';
import { Reasons } from './Reasons';
import '../paste/paste.css';
import './suggest.css';

export interface FactsCardProps {
  doc: Document;
  deviceId: string | null;
  text: string;
  actor?: string;
  onApply: (next: Document, deviceId: string) => void;
  onClose: () => void;
}

export const FACTS_LINE = 'Fathom read what the device says about itself. Tick what to keep; nothing changes until you save.';

function namedDevices(doc: Document): { id: string; name: string }[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device')
    .map((n) => ({ id: n.id, name: asString(fieldValue(n.fields, 'Device.hostname')) ?? '' }))
    .filter((d) => d.name.trim() !== '')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function FactsCard({ doc, deviceId, text, actor, onApply, onClose }: FactsCardProps): JSX.Element {
  const facts = useMemo(() => readFacts(text), [text]);
  const devices = useMemo(() => namedDevices(doc), [doc]);
  // A pasted hostname that names a drawn device picks it when nothing was selected.
  const [device, setDevice] = useState<string | null>(() => {
    if (deviceId !== null) return deviceOf(doc, deviceId);
    const named = facts?.hostname?.toLowerCase();
    return named !== undefined ? (devices.find((d) => d.name.toLowerCase() === named)?.id ?? null) : null;
  });
  const rows = useMemo(() => (device !== null && facts !== null ? suggestFacts(doc, device, facts) : []), [doc, device, facts]);
  const [ticks, setTicks] = useState<ReadonlySet<FactKey> | null>(null);
  const ticked = ticks ?? new Set(rows.filter((r) => r.state === 'fill').map((r) => r.key));
  const [refusal, setRefusal] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const headId = useId();

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

  const writable = rows.filter((r) => r.state === 'fill' || r.state === 'differs');
  const chosen = writable.filter((r) => ticked.has(r.key));
  const said = rows.filter((r) => r.state === 'note');
  const same = rows.filter((r) => r.state === 'same');

  const save = () => {
    if (device === null || facts === null) return;
    try {
      onApply(acceptFacts(doc, device, facts, new Set(chosen.map((r) => r.key)), actor !== undefined ? { actor } : undefined), device);
      onClose();
    } catch {
      setRefusal('That could not be saved, so nothing was changed.');
    }
  };

  return (
    <div className="paste-card suggest-card" role="dialog" aria-labelledby={headId} data-testid="facts-card" ref={ref}>
      <div className="paste-card__head" id={headId}>
        What the device says
      </div>
      <p className="suggest-card__line">{FACTS_LINE}</p>

      <label className="suggest-card__from">
        <span>Device</span>
        <select value={device ?? ''} onChange={(e) => { setDevice(e.target.value === '' ? null : e.target.value); setTicks(null); }} aria-label="The device this was read on">
          <option value="">Choose the device</option>
          {device !== null && !devices.some((d) => d.id === device) && <option value={device}>This device</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      {device === null ? (
        <p className="paste-card__note">Choose the device this was read on.</p>
      ) : (
        <>
          {writable.length > 0 && (
            <ul className="suggest-card__rows">
              {writable.map((r) => (
                <li key={r.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={ticked.has(r.key)}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if (e.target.checked) next.add(r.key);
                        else next.delete(r.key);
                        setTicks(next);
                      }}
                    />
                    <span className="suggest-card__end">{r.label}</span>
                    <span className="suggest-card__end suggest-card__far">
                      <span className="suggest-card__port">{r.theirs}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <Reasons
            lines={[
              ...writable.filter((r) => r.why !== null).map((r) => ({ key: `w-${r.key}`, text: r.why ?? '' })),
              ...said.map((r) => ({ key: `n-${r.key}`, text: r.why ?? '' })),
            ]}
            summary={`${writable.filter((r) => r.why !== null).length + said.length} notes on what it says`}
          />
          {same.length > 0 && <p className="paste-card__note suggest-card__why">{same.map((r) => r.label).join(', ')} already match the drawing.</p>}
          {rows.length === 0 && <p className="paste-card__note">Nothing in it is new to this device.</p>}
          {refusal !== '' && <p className="paste-card__refusal" role="alert">{refusal}</p>}
          <div className="paste-card__actions suggest-card__actions">
            <button type="button" onClick={onClose}>Skip</button>
            <button type="button" className="suggest-card__add" disabled={chosen.length === 0} onClick={save}>
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

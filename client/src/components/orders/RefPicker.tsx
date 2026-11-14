// A device or a port, picked from the estate index (the same search Ctrl+K's "Other sites" and a
// link between sites use). An order's `device` and `port` fields hold what is picked here, and a
// job's `holds` keeps it busy with the order (ADR-0084 decision 18).

import { useEffect, useState } from 'react';

import { fetchFarEnds, searchEstate, type EstateHit } from '../../api/estate';
import type { AnswerValue } from '../../api/orders';

export type Ref = { design: string; device: string; port?: string | null };

export const refKey = (r: Ref) => `${r.design}/${r.port ?? r.device}`;

export function isRef(v: AnswerValue | undefined): v is Ref {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'design' in v;
}

/** Names for the device and port answers of an order, looked up once each. */
export function useRefNames(organisationId: string, refs: readonly Ref[]): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const wanted = refs.map(refKey).sort().join('|');
  useEffect(() => {
    if (refs.length === 0) return;
    let live = true;
    fetchFarEnds(
      organisationId,
      refs.map((r) => ({ design: r.design, element: r.port ?? r.device })),
    ).then(
      (ends) => {
        if (!live) return;
        const out: Record<string, string> = {};
        for (const e of ends) {
          if (e.state !== 'here') continue;
          const what = [e.device, e.port].filter((x) => x !== '').join(' · ');
          out[`${e.design}/${e.element}`] = e.designName ? `${what} (${e.designName})` : what;
        }
        setNames(out);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wanted` is refs' identity
  }, [organisationId, wanted]);
  return names;
}

export function RefPicker({
  organisationId,
  kind,
  label,
  value,
  onChange,
}: {
  organisationId: string;
  kind: 'device' | 'port';
  label: string;
  value: Ref | null;
  onChange: (v: Ref | null) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<EstateHit[]>([]);
  const [chosen, setChosen] = useState<EstateHit | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      searchEstate(organisationId, q.trim(), 'device').then(
        (a) => {
          if (!live) return;
          setHits(a.hits.filter((h) => h.kind === 'device' && (kind === 'device' || h.ports.length > 0)).slice(0, 8));
          setNote(a.hits.length === 0 ? 'Nothing found. Search by a device’s name.' : null);
        },
        () => live && setNote('Search across sites is not answering right now.'),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [organisationId, q, kind]);

  if (value) {
    return (
      <span className="order-ref">
        <span>{shown ?? (kind === 'port' ? 'A port is chosen' : 'A device is chosen')}</span>
        <button
          type="button"
          className="order-link"
          onClick={() => {
            onChange(null);
            setShown(null);
            setChosen(null);
          }}
        >
          Change
        </button>
      </span>
    );
  }
  return (
    <span className="order-ref order-ref--pick">
      {chosen && kind === 'port' ? (
        <>
          <span>
            {chosen.name}
            {chosen.designName ? ` (${chosen.designName})` : ''}
          </span>
          <select
            aria-label={`${label}: port`}
            value=""
            onChange={(e) => {
              const port = chosen.ports.find((p) => p.id === e.currentTarget.value);
              if (!port) return;
              setShown(`${chosen.name} · ${port.name || 'Unnamed port'}${chosen.designName ? ` (${chosen.designName})` : ''}`);
              onChange({ design: chosen.design, device: chosen.element, port: port.id });
            }}
          >
            <option value="">Choose a port…</option>
            {chosen.ports.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || 'Unnamed port'}
              </option>
            ))}
          </select>
          <button type="button" className="order-link" onClick={() => setChosen(null)}>
            Another device
          </button>
        </>
      ) : (
        <>
          <input type="search" aria-label={`${label}: search devices`} placeholder="Search devices by name" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          {hits.length > 0 ? (
            <span className="order-ref__hits">
              {hits.map((h) => (
                <button
                  key={`${h.design}:${h.element}`}
                  type="button"
                  className="btn-small"
                  onClick={() => {
                    if (kind === 'device') {
                      setShown(`${h.name}${h.designName ? ` (${h.designName})` : ''}`);
                      onChange({ design: h.design, device: h.element });
                    } else setChosen(h);
                  }}
                >
                  {h.name}
                  {h.designName ? ` · ${h.designName}` : ''}
                </button>
              ))}
            </span>
          ) : null}
          {note ? <span className="org-sub">{note}</span> : null}
        </>
      )}
    </span>
  );
}

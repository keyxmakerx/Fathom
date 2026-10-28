import { useCallback, useEffect, useState } from 'react';

import { ESTATE_KIND_WORD, openElsewhere, pageEstate, searchEstate, type EstateAnswer, type EstateHit, type EstateKind } from '../../api/estate';

/**
 * Inventory › Every site (ADR-0079 decision 2): one table across every design this person may
 * read, from the server's estate index. Paged by the server, 100 rows at a time, grouped by
 * design; a search box asks the index for every word typed. A row opens its design at that
 * thing, the way a scanned label does. Nothing here can change a design.
 */

const KINDS: ReadonlyArray<[EstateKind | '', string]> = [
  ['', 'Everything'],
  ['device', 'Devices'],
  ['card', 'Cards'],
  ['optic', 'Optics'],
  ['power_supply', 'Power supplies'],
  ['spare', 'Spares'],
];

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; answer: EstateAnswer; more: boolean };

/** The sentence under the table: what was looked in and what is still catching up. */
export function coverageSentence(answer: EstateAnswer): string {
  const sites = answer.designs === 1 ? '1 design' : `${answer.designs.toLocaleString('en-GB')} designs`;
  const behind = answer.behind > 0 ? ` ${answer.behind.toLocaleString('en-GB')} of them are still being brought up to date, so a recent change may not show yet.` : '';
  return `Looked in ${sites} you can open.${behind}`;
}

export function EverywhereTable({ hits, currentDesign }: { hits: readonly EstateHit[]; currentDesign: string | null }) {
  if (hits.length === 0) return <p className="inventory-place__muted">Nothing found.</p>;
  return (
    <table className="data-table" data-testid="everywhere-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Kind</th>
          <th>Model</th>
          <th>Serial</th>
          <th>On</th>
          <th>Where</th>
          <th>Design</th>
          <th>Addresses</th>
        </tr>
      </thead>
      <tbody>
        {hits.map((h) => (
          <tr key={`${h.design}:${h.element}`}>
            <td>
              <button type="button" className="btn-link" onClick={() => openElsewhere(h.design, h.open)}>
                {h.name || h.model || h.serial || '(no name)'}
              </button>
            </td>
            <td>{ESTATE_KIND_WORD[h.kind] ?? h.kind}</td>
            <td>{h.model}</td>
            <td>
              <code>{h.serial}</code>
            </td>
            <td>{h.device}</td>
            <td>{h.place}</td>
            <td>{h.design === currentDesign ? 'This design' : (h.designName ?? 'Unnamed design')}</td>
            <td>{h.addresses.join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EverywherePanel({ organisationId, currentDesign }: { organisationId: string; currentDesign: string | null }) {
  const [kind, setKind] = useState<EstateKind | ''>('');
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  const load = useCallback(
    (q: string, k: EstateKind | '') => {
      setLoaded({ status: 'loading' });
      const ask = q.trim() ? searchEstate(organisationId, q.trim(), k || undefined) : pageEstate(organisationId, k || undefined);
      ask
        .then((answer) => setLoaded({ status: 'ready', answer, more: !q.trim() && answer.hits.length >= 100 }))
        .catch((e: unknown) => setLoaded({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
    },
    [organisationId],
  );

  useEffect(() => {
    const t = window.setTimeout(() => load(query, kind), query ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, query, kind]);

  const more = () => {
    if (loaded.status !== 'ready' || loaded.answer.hits.length === 0) return;
    const last = loaded.answer.hits[loaded.answer.hits.length - 1];
    const before = loaded.answer;
    pageEstate(organisationId, kind || undefined, [last.design, last.element])
      .then((next) =>
        setLoaded({ status: 'ready', answer: { ...next, hits: [...before.hits, ...next.hits] }, more: next.hits.length >= 100 }),
      )
      .catch((e: unknown) => setLoaded({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
  };

  return (
    <div className="inventory-place__everywhere" aria-label="Every site">
      <p className="inventory-place__muted">Every device, card, optic, power supply and spare in the designs you can open.</p>
      <div className="inventory-place__everywhere-bar">
        <input
          type="search"
          aria-label="Search every site"
          placeholder="Name, model, serial or address"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.currentTarget.value as EstateKind | '')}>
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {loaded.status === 'loading' ? (
        <p className="inventory-place__muted">Looking…</p>
      ) : loaded.status === 'error' ? (
        <p className="inventory-place__muted">Could not search every site: {loaded.message}</p>
      ) : (
        <>
          <EverywhereTable hits={loaded.answer.hits} currentDesign={currentDesign} />
          <p className="inventory-place__muted">{coverageSentence(loaded.answer)}</p>
          {loaded.more ? (
            <button type="button" className="btn-quiet" onClick={more}>
              More
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

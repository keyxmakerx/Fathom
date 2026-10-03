// The parts of an Inventory page that read the estate rather than edit one thing: a cable's run
// through patch panels, what a device is plugged into, a patch panel's port map, and what a rack
// holds. Every link opens the page it names. Nothing here writes the document.

import type { ClosetView, EditorActions, PortView, Selection } from '../drawing/contract';
import type { Document } from '../../document/model';
import { cablePath, lastTracedOf, pluggedInto, selectionOfHost, stationPlace, type Station } from './cablePath';
import { placeText, type PlaceIndex, type Where } from './placeIndex';

const ABSENT = '—';

export function PathStrip(props: { doc: Document; view: ClosetView; idx: PlaceIndex; cableId: string; actions: EditorActions }) {
  const { doc, view, idx, cableId, actions } = props;
  const path = cablePath(view, idx, cableId);
  if (!path) return null;
  const traced = lastTracedOf(doc, cableId);
  const openHost = (s: Station) => {
    const sel = selectionOfHost(s.hostKind, s.hostId);
    if (sel) actions.onSelect?.(sel as Selection);
  };
  return (
    <section className="inv-path" aria-label="The run this cable is on">
      <h3 className="inv-path__head">
        The run{path.cables.length > 1 ? ` · ${path.cables.length} cables through ${path.stations.length - 2} patch ${path.stations.length - 2 === 1 ? 'panel' : 'panels'}` : ''}
      </h3>
      <ol className="inv-path__list">
        {path.stations.map((s, i) => {
          const cable = path.cables[i];
          return (
            <li key={i} className="inv-path__item">
              <div className={`inv-path__stop inv-path__stop--${s.kind}`}>
                {selectionOfHost(s.hostKind, s.hostId) ? (
                  <button type="button" className="inv-path__host" onClick={() => openHost(s)}>
                    {s.host}
                  </button>
                ) : (
                  <span className="inv-path__host">{s.host}</span>
                )}
                {s.kind === 'panel' ? <span className="inv-path__tag">patch panel</span> : null}
                <span className="inv-path__ports">
                  {s.ports.map((p, k) => (
                    <span key={p.portId}>
                      {k > 0 ? ' ⇄ ' : ''}
                      {p.label || ABSENT} <span className="inv-path__face">{p.face}</span>
                    </span>
                  ))}
                </span>
                <span className="inv-path__place">{stationPlace(s) || 'not in a rack'}</span>
              </div>
              {cable ? (
                <div className={`inv-path__cable${i === path.at ? ' inv-path__cable--here' : ''}`}>
                  {i === path.at ? (
                    <span>{cable.label || 'this cable'} (this page)</span>
                  ) : (
                    <button type="button" onClick={() => actions.onSelect?.({ kind: 'cable', id: cable.id })}>
                      {cable.label || 'unlabelled'}
                    </button>
                  )}
                  <span className="inv-path__meta">{[cable.media, cable.lengthM != null ? `${cable.lengthM} m` : ''].filter(Boolean).join(' · ')}</span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="inv-path__traced">
        Last traced: <b>{traced ?? 'not recorded'}</b>
      </p>
    </section>
  );
}

export function PluggedInto(props: { view: ClosetView; idx: PlaceIndex; hostId: string; actions: EditorActions }) {
  const { view, idx, hostId, actions } = props;
  const list = pluggedInto(view, idx, hostId);
  return (
    <section className="inv-plug" aria-label="Plugged into">
      <h3 className="inv-path__head">Plugged into</h3>
      {list.length === 0 ? (
        <p className="inv-page__muted">Nothing is cabled to this yet.</p>
      ) : (
        <ul className="inv-page__list">
          {list.map((l) => (
            <li key={l.port.portId}>
              <span className="inv-page__mono">{l.port.label || ABSENT}</span>
              <button type="button" onClick={() => actions.onSelect?.({ kind: 'cable', id: l.cableId })}>
                {l.cableLabel || 'unlabelled'}
              </button>
              <span>
                {l.far ? ('outside' in l.far ? l.far.outside : `${l.far.host} · ${l.far.port}`) : ABSENT}
                {l.far && 'place' in l.far && l.far.place ? <span className="inv-page__muted"> {placeText(l.far.place)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A patch panel as a grid: one column per hole, the front above the rear, filled when cabled. */
export function PanelMap(props: { view: ClosetView; ports: readonly PortView[]; actions: EditorActions }) {
  const { view, ports, actions } = props;
  const used = new Set<string>();
  const pairs: Array<{ front: PortView; rear: PortView | undefined }> = [];
  const sorted = [...ports].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  for (const p of sorted) {
    if (p.face !== 'front' || used.has(p.id)) continue;
    used.add(p.id);
    const rear = p.passThroughId ? ports.find((q) => q.id !== p.id && q.passThroughId === p.passThroughId) : undefined;
    if (rear) used.add(rear.id);
    pairs.push({ front: p, rear });
  }
  for (const p of sorted) if (!used.has(p.id)) pairs.push({ front: p, rear: undefined });
  const cell = (p: PortView | undefined, face: string) => {
    if (!p) return <span className="inv-pm__cell inv-pm__cell--none" aria-label={`no ${face} port`} />;
    const cable = p.cable ? view.cables.find((c) => c.id === p.cable!.cableId) : undefined;
    return (
      <button
        type="button"
        className={`inv-pm__cell${cable ? ' inv-pm__cell--on' : ''}`}
        title={cable ? `${p.label} ${face}: ${cable.label || 'unlabelled cable'}` : `${p.label} ${face}: free`}
        aria-label={`${p.label} ${face} ${cable ? `cabled, ${cable.label || 'unlabelled'}` : 'free'}`}
        onClick={() => (cable ? actions.onSelect?.({ kind: 'cable', id: cable.id }) : actions.onSelect?.({ kind: 'port', id: p.id }))}
      />
    );
  };
  const cabled = ports.filter((p) => p.cable).length;
  return (
    <section className="inv-pm" aria-label="Port map">
      <h3 className="inv-path__head">
        Port map · {cabled} of {ports.length} ports cabled
      </h3>
      <div className="inv-pm__grid" role="grid">
        {pairs.map(({ front, rear }) => (
          <div key={front.id} className="inv-pm__col" role="row">
            <span className="inv-pm__n">{front.label}</span>
            {cell(front, 'front')}
            {cell(rear, 'rear')}
          </div>
        ))}
      </div>
      <p className="inv-page__muted">Top row front, bottom row rear. Filled means a cable; select one to open it.</p>
    </section>
  );
}

export function RackContents(props: { view: ClosetView; idx: PlaceIndex; rackId: string; actions: EditorActions; onSetWhere?: (w: Where) => void }) {
  const { view, idx, rackId, actions, onSetWhere } = props;
  const rack = view.racks.find((r) => r.id === rackId);
  const place = idx.racks.get(rackId);
  if (!rack || !place) return null;
  const devices = [...rack.chassis].sort((a, b) => b.positionU - a.positionU);
  const touching = new Map<string, { id: string; label: string | null; other: string }>();
  for (const p of idx.ports) {
    if (p.place?.rackId !== rackId || !p.cableId) continue;
    const cable = view.cables.find((c) => c.id === p.cableId);
    const far = cable?.ends.find((e) => !('portId' in e) || e.portId !== p.id);
    const fp = far && 'portId' in far ? idx.portById.get(far.portId) : undefined;
    // A cable that stays inside the rack is not "touching" it from outside, but it is still listed once.
    if (!touching.has(p.cableId)) touching.set(p.cableId, { id: p.cableId, label: cable?.label ?? null, other: fp ? `${fp.hostName} · ${fp.label}${fp.place && fp.place.rackId !== rackId ? ` (${placeText(fp.place)})` : ''}` : far && 'outside' in far ? far.label || 'outside' : ABSENT });
  }
  const cables = [...touching.values()];
  return (
    <section className="inv-rackp" aria-label="This rack">
      <div className="inv-rackp__bar">
        <h3 className="inv-path__head">In this rack · {devices.length + rack.shelves.length}</h3>
        {onSetWhere ? (
          <button type="button" onClick={() => onSetWhere({ site: place.site, room: place.room, rack: place.rack })}>
            Set Where to this rack
          </button>
        ) : null}
      </div>
      {devices.length === 0 && rack.shelves.length === 0 ? (
        <p className="inv-page__muted">Empty.</p>
      ) : (
        <ul className="inv-page__list">
          {devices.map((c) => (
            <li key={c.id}>
              <span className="inv-page__mono">U{c.positionU}</span>
              <button type="button" onClick={() => actions.onSelect?.({ kind: 'chassis', id: c.id })}>
                {c.hostname || 'unnamed'}
              </button>
              <span className="inv-page__muted">{c.role ?? ''}</span>
            </li>
          ))}
          {rack.shelves.map((s) => (
            <li key={s.id}>
              <span className="inv-page__mono">U{s.positionU}</span>
              <span>shelf</span>
              <span className="inv-page__muted">{s.occupants.length} on it</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="inv-path__head">Cables touching this rack · {cables.length}</h3>
      {cables.length === 0 ? (
        <p className="inv-page__muted">None.</p>
      ) : (
        <ul className="inv-page__list">
          {cables.slice(0, 60).map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => actions.onSelect?.({ kind: 'cable', id: c.id })}>
                {c.label || 'unlabelled'}
              </button>
              <span className="inv-page__muted">to {c.other}</span>
            </li>
          ))}
          {cables.length > 60 ? <li className="inv-page__muted">and {cables.length - 60} more: set Where to this rack and open Cables.</li> : null}
        </ul>
      )}
    </section>
  );
}

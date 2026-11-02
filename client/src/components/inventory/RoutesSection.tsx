// Routes in Inventory (sign-off r96, round 1): the by-hand way to give a host its gateway and a
// router its static routes, so a drawn network can be traced past its first hop. Pasted routes
// are listed beside them and stay as the paste wrote them. Calls `document/routes.ts` and hands
// the result to `applyDocChange`, as the VPNs section does; it reuses that section's look.

import { useMemo, useState } from 'react';

import { parseNodeId, type Document } from '../../document/model';
import { addRoute, instancesOf, listRoutes, removeRoute } from '../../document/routes';
import { getSession } from '../../state/sessionState';
import './vpns.css';

function actorOpts(): { actor: string } | undefined {
  const s = getSession();
  return s ? { actor: s.accountId } : undefined;
}

function attempt(apply: () => void, setError: (e: string | null) => void): boolean {
  try {
    apply();
    setError(null);
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

function liveDevices(doc: Document): { id: string; hostname: string }[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device')
    .map((n) => {
      const h = n.fields['Device.hostname'];
      return { id: n.id, hostname: h?.presence === 'set' && typeof h.value === 'string' && h.value !== '' ? h.value : 'unnamed device' };
    })
    .sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }));
}

/** The Add route form. `device` fixes the device (the device panel's Routing tab), and the picker is not shown. */
export function AddRoute({ doc, applyDocChange, onClose, device }: { doc: Document; applyDocChange: (next: Document) => void; onClose: () => void; device?: string }) {
  const devices = useMemo(() => liveDevices(doc), [doc]);
  const [picked, setDeviceId] = useState('');
  const deviceId = device ?? picked;
  const [destination, setDestination] = useState('default');
  const [via, setVia] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tables = deviceId === '' ? [] : instancesOf(doc, deviceId);
  return (
    <form
      className="vpns__form"
      aria-label="Add a route"
      onSubmit={(e) => {
        e.preventDefault();
        if (deviceId === '') {
          setError('Pick the device the route is on.');
          return;
        }
        if (attempt(() => applyDocChange(addRoute(doc, { deviceId, destination, via, instanceId: instanceId === '' ? undefined : instanceId }, actorOpts()).doc), setError)) {
          setVia('');
          setDestination('default');
        }
      }}
    >
      {device == null ? (
        <label className="vpns__field">
          <span>Device</span>
          <select
            className="vpns__input"
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              setInstanceId('');
            }}
            autoFocus
          >
            <option value="">Pick a device…</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {tables.length > 1 ? (
        <label className="vpns__field">
          <span>Routing table</span>
          <select className="vpns__input" value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
            <option value="">Pick one…</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="vpns__field">
        <span>To</span>
        <input className="vpns__input vpns__input--mono" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="default, or 10.2.0.0/16" />
      </label>
      <label className="vpns__field">
        <span>Via</span>
        <input className="vpns__input vpns__input--mono" value={via} onChange={(e) => setVia(e.target.value)} placeholder="the gateway, e.g. 10.0.10.1" />
      </label>
      {error != null && <p className="vpns__error">{error}</p>}
      <p className="vpns__note">&ldquo;default&rdquo; is everywhere else: on a host, To default via its gateway is the gateway. Via &ldquo;discard&rdquo; drops the traffic.</p>
      <div className="vpns__actions">
        <button type="submit" className="vpns__primary">
          Add route
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

export function RoutesSection({ doc, applyDocChange, canDraw, filter }: { doc: Document; applyDocChange: (next: Document) => void; canDraw: boolean; filter: string }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = useMemo(() => listRoutes(doc), [doc]);
  const f = filter.trim().toLowerCase();
  const rows = f === '' ? all : all.filter((r) => `${r.hostname} ${r.instance} ${r.destination} ${r.via}`.toLowerCase().includes(f));
  return (
    <section className="vpns" aria-label="Routes">
      <div className="vpns__head">
        <h3 className="vpns__title">Routes</h3>
        <span className="vpns__count">{all.length === 1 ? '1 route' : `${all.length} routes`}</span>
        <span style={{ flexGrow: 1 }} />
        {canDraw && !adding ? (
          <button type="button" onClick={() => setAdding(true)}>
            Add route
          </button>
        ) : null}
      </div>
      <p className="vpns__note">Static routes and gateways. The path trace follows these; a device with neither can only reach its own networks.</p>
      {adding && canDraw ? <AddRoute doc={doc} applyDocChange={applyDocChange} onClose={() => setAdding(false)} /> : null}
      {rows.length === 0 && !adding ? <p className="vpns__note">{all.length === 0 ? 'No routes yet.' : 'No routes match this filter.'}</p> : null}
      {error != null && <p className="vpns__error">{error}</p>}
      <ul className="vpns__list">
        {rows.map((r) => (
          <li key={r.id} className="vpns__row" data-route-id={r.id}>
            <div className="vpns__row-head vpns__row-head--route">
              <span className="vpns__row-name">{r.hostname}</span>
              <span className="vpns__mono">{r.destination === '0.0.0.0/0' ? 'default' : r.destination}</span>
              <span className="vpns__mono">{r.via}</span>
              <span>{r.pasted ? 'from a paste' : r.instance === 'default' ? 'by hand' : `by hand · ${r.instance}`}</span>
              {canDraw && !r.pasted ? (
                <button type="button" aria-label={`Remove the route to ${r.destination} on ${r.hostname}`} onClick={() => attempt(() => applyDocChange(removeRoute(doc, r.id, actorOpts())), setError)}>
                  Remove
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

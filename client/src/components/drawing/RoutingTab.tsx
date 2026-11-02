// The device panel's Routing tab (sign-off r101, option A), shown while the Routing lens is lit: the
// device's own tables, connected networks first and then static routes, who wrote each, and Add route
// (the Inventory › Routes form with the device filled in). Trace from here is the panel's own foot. It says what is not read yet, so a short
// table never looks whole.

import { createContext, useContext, useMemo, useState } from 'react';

import type { Document } from '../../document/model';
import { routingTable } from '../../document/routes';
import { AddRoute } from '../inventory/RoutesSection';
import '../inventory/vpns.css';

export interface RoutingApi {
  /** The Routing lens is lit: the panel offers this tab. */
  lit: boolean;
  doc: Document;
  /** Absent when this person may not draw: no Add route. */
  applyDocChange?: (next: Document) => void;
}

export const RoutingContext = createContext<RoutingApi | null>(null);

/** Whether the panel shows the Routing tab. */
export function useRoutingLit(): boolean {
  return useContext(RoutingContext)?.lit === true;
}

export function RoutingTab({ deviceId }: { deviceId: string }) {
  const api = useContext(RoutingContext);
  const [adding, setAdding] = useState(false);
  const tables = useMemo(() => (api == null ? [] : routingTable(api.doc, deviceId)), [api, deviceId]);
  if (api == null) return null;
  const several = tables.length > 1;
  return (
    <div className="routing-tab" data-testid="routing-tab">
      {tables.map((t) => {
        const rows = [
          ...t.connected.map((c) => ({ key: `c:${c.network}:${c.how}`, to: c.network, how: c.how, from: c.pasted ? 'paste' : 'by hand' })),
          ...t.statics.map((r) => ({ key: r.id, to: r.destination === '0.0.0.0/0' ? 'default' : r.destination, how: r.via, from: r.pasted ? 'paste' : 'by hand' })),
        ];
        return (
          <section key={t.id || 'default'} aria-label={t.name === 'default' ? 'Default table' : `VRF ${t.name}`}>
            <div className="drawing-editor__group">{t.name === 'default' ? (several ? 'Default table' : 'Routing table') : `VRF ${t.name}`}</div>
            {rows.length === 0 ? (
              <p className="drawing-editor__empty-next">No routes in this table: no address on its interfaces, and no route typed or pasted.</p>
            ) : (
              <table className="routing-tab__table">
                <thead>
                  <tr>
                    <th scope="col">To</th>
                    <th scope="col">How</th>
                    <th scope="col">From</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td className="routing-tab__mono">{r.to}</td>
                      <td>{r.how}</td>
                      <td className="routing-tab__muted routing-tab__from">{r.from}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
      {adding && api.applyDocChange != null ? (
        <AddRoute doc={api.doc} applyDocChange={api.applyDocChange} onClose={() => setAdding(false)} device={deviceId} />
      ) : (
        api.applyDocChange != null && (
          <div className="routing-tab__actions">
            <button type="button" onClick={() => setAdding(true)} data-testid="routing-tab-add">
              Add route
            </button>
          </div>
        )
      )}
      <div className="drawing-editor__group">Not read yet</div>
      <p className="routing-tab__muted">Routes learned by OSPF or BGP are not in the design yet, so this table may be shorter than the device's own.</p>
    </div>
  );
}

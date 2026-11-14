// Orders on the Work tab (ADR-0084 piece 4; r74: every piece of work in one place). Open orders,
// newest first, each saying where it is and whether something in it is yours to do; "Open an
// order" asks what its type asks when it opens; choosing one opens its page in place.

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchOrder, fetchOrders, fetchOrderTypes, type Order, type OrderLine, type OrderTypeLine } from '../../api/orders';
import { OpenOrderForm } from './OpenOrderForm';
import { OrderPage } from './OrderPage';
import { orderNumber, personWords, readyForYou, whenWords, whereItIs } from './orderModel';
import './orders.css';

/** At most this many open orders are opened for their "where it is" line; the rest say less. */
export const DETAILED_ORDERS = 30;

type View = { kind: 'list' } | { kind: 'open' } | { kind: 'order'; id: string; initial?: Order };

/** The Work tab's orders: the list, or one order, or the form that opens one. `onView` tells the
 * Work tab whether an order fills it, so the rest of the tab steps aside. */
export function OrdersSection({ organisationId, refreshMs, onFull }: { organisationId: string; refreshMs: number; onFull: (full: boolean) => void }) {
  const [view, setViewState] = useState<View>({ kind: 'list' });
  const setView = (v: View) => {
    setViewState(v);
    onFull(v.kind !== 'list');
  };
  const [types, setTypes] = useState<OrderTypeLine[] | null>(null);
  const [lines, setLines] = useState<{ orders: OrderLine[]; people: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, { at: number; order: Order }>>({});
  const [finished, setFinished] = useState<{ orders: OrderLine[]; people: Record<string, string> } | null | 'loading'>(null);
  const detailsRef = useRef(details);
  detailsRef.current = details;

  const load = useCallback(() => {
    fetchOrderTypes(organisationId).then(
      (t) => setTypes(t.types),
      () => setTypes([]),
    );
    fetchOrders(organisationId).then(
      (l) => {
        setLines(l);
        setError(null);
        // Open each changed order once for its "where it is" line; an unchanged one is not asked again.
        for (const line of l.orders.slice(0, DETAILED_ORDERS)) {
          const had = detailsRef.current[line.id];
          if (had && had.at === line.updatedAt) continue;
          fetchOrder(organisationId, line.id).then(
            (order) => setDetails((d) => ({ ...d, [line.id]: { at: line.updatedAt, order } })),
            () => undefined,
          );
        }
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [organisationId]);

  useEffect(() => {
    setLines(null);
    setDetails({});
    setFinished(null);
    load();
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, refreshMs);
    return () => window.clearInterval(tick);
  }, [load, refreshMs]);

  if (view.kind === 'order') {
    return (
      <OrderPage
        organisationId={organisationId}
        orderId={view.id}
        initial={view.initial}
        onBack={() => {
          setView({ kind: 'list' });
          load();
        }}
      />
    );
  }
  if (view.kind === 'open') {
    return <OpenOrderForm organisationId={organisationId} types={types ?? []} onCancel={() => setView({ kind: 'list' })} onOpened={(o) => setView({ kind: 'order', id: o.id, initial: o })} />;
  }

  const typeName = (id: string) => types?.find((t) => t.id === id)?.name ?? 'An order type';
  const showFinished = () => {
    setFinished('loading');
    fetchOrders(organisationId, true).then(
      (f) => setFinished(f),
      () => setFinished({ orders: [], people: {} }),
    );
  };

  return (
    <section className="work__section orders" aria-label="Orders" data-testid="orders-section">
      <div className="orders__head">
        <h3 className="work__label">
          Orders<span className="work__note"> · updates live</span>
        </h3>
        {types && types.length > 0 ? (
          <button type="button" className="btn-small" onClick={() => setView({ kind: 'open' })} data-testid="orders-open">
            Open an order
          </button>
        ) : null}
      </div>
      {error ? <p className="work__muted">Could not gather the orders: {error}</p> : null}
      {lines === null && !error ? <p className="work__muted">Gathering the orders…</p> : null}
      {lines !== null && lines.orders.length === 0 ? (
        <p className="work__muted">
          {types && types.length === 0 ? 'No orders. A Steward makes order types under Steward › Order types; then anyone opens an order here.' : 'No open orders.'}
        </p>
      ) : null}
      {lines !== null && lines.orders.length > 0 ? (
        <OrderRows lines={lines.orders} people={lines.people} details={details} typeName={typeName} onOpen={(id) => setView({ kind: 'order', id, initial: details[id]?.order })} />
      ) : null}
      {finished === null ? (
        <button type="button" className="btn-quiet orders__finished" onClick={showFinished}>
          Show finished orders
        </button>
      ) : finished === 'loading' ? (
        <p className="work__muted">Gathering finished orders…</p>
      ) : finished.orders.length === 0 ? (
        <p className="work__muted">No finished orders yet.</p>
      ) : (
        <OrderRows lines={finished.orders} people={finished.people} details={{}} typeName={typeName} onOpen={(id) => setView({ kind: 'order', id })} />
      )}
    </section>
  );
}

function OrderRows({
  lines,
  people,
  details,
  typeName,
  onOpen,
}: {
  lines: readonly OrderLine[];
  people: Record<string, string>;
  details: Record<string, { at: number; order: Order }>;
  typeName: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="orders__rows">
      <li className="orders__row orders__row--head" aria-hidden="true">
        <span>No.</span>
        <span>Order</span>
        <span>Where it’s at</span>
        <span>For you</span>
      </li>
      {lines.map((l) => {
        const o = details[l.id]?.order;
        const mine = o ? readyForYou(o) : [];
        const customer = o?.definition.fields.find((f) => f.kind === 'text' && typeof o.answers[f.key] === 'string');
        return (
          <li key={l.id} className="orders__row" data-testid="order-row">
            <span className="work__number">{orderNumber(l.number, o?.code ?? null)}</span>
            <span className="work__what">
              <button type="button" className="order-link" onClick={() => onOpen(l.id)}>
                {o?.name ?? typeName(l.type)}
                {customer && o ? ` · ${String(o.answers[customer.key])}` : ''}
              </button>
              <span className="work__in">
                Opened {whenWords(l.openedAt)} by {personWords(people, l.openedBy)}
              </span>
            </span>
            <span className="orders__where">{o ? whereItIs(o) : l.status === 'open' ? 'Open' : l.status === 'done' ? 'Done' : 'Cancelled'}</span>
            <span className="orders__mine">{mine.length === 0 ? '' : mine.length === 1 ? <b>{mine[0].name}</b> : <b>{mine.length} jobs</b>}</span>
          </li>
        );
      })}
    </ul>
  );
}

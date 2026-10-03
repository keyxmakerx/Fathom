// The side list: kinds in quiet groups, saved views nested under their kind with counts. On a phone
// it is two selects (kind, then view). Counts follow "Where" and are handed in; this only draws.

import type { Kind } from './kinds';
import { KIND_GROUPS } from './kinds';
import { viewsFor, type SavedView } from './views';

export interface SideListProps {
  kind: Kind;
  viewId: string;
  counts: Readonly<Record<Kind, number | null>>;
  views: readonly SavedView[];
  viewCounts: ReadonlyMap<string, number>;
  /** Whether the list is showing (not a page, not search results). */
  onList: boolean;
  onKind: (kind: Kind) => void;
  onView: (view: SavedView) => void;
  onRemoveView: (view: SavedView) => void;
  /** Corrections from the floor waiting for someone with Draw; absent for a reader. */
  waiting?: { count: number; onOpen: () => void };
}

const fmt = (n: number | null | undefined): string => (n == null ? '…' : n.toLocaleString('en-GB'));

export function SideList(props: SideListProps) {
  const { kind, viewId, counts, views, viewCounts, onList, onKind, onView, onRemoveView, waiting } = props;
  return (
    <>
      <nav className="inventory-place__rail" aria-label="Inventory kinds and saved views">
        {KIND_GROUPS.map((group, gi) => (
          <ul key={gi} className="inventory-place__kinds inventory-place__group">
            {group.map((k) => {
              const mine = viewsFor(views, k.key);
              return (
                <li key={k.key}>
                  <button
                    type="button"
                    className={onList && k.key === kind && !viewId ? 'inventory-place__kind inventory-place__kind--active' : 'inventory-place__kind'}
                    aria-current={onList && k.key === kind && !viewId ? 'true' : undefined}
                    onClick={() => onKind(k.key)}
                  >
                    <span>{k.label}</span>
                    <span className="inventory-place__count">{fmt(counts[k.key])}</span>
                  </button>
                  {mine.length > 0 ? (
                    <ul className="inventory-place__views">
                      {mine.map((v) => (
                        <li key={v.id} className="inventory-place__view-row">
                          <button
                            type="button"
                            className={onList && viewId === v.id ? 'inventory-place__view inventory-place__view--active' : 'inventory-place__view'}
                            aria-current={onList && viewId === v.id ? 'true' : undefined}
                            onClick={() => onView(v)}
                          >
                            <span>
                              {v.name}
                              <span className="inventory-place__who">{v.who}</span>
                            </span>
                            <span className="inventory-place__count">{fmt(viewCounts.get(v.id))}</span>
                          </button>
                          {v.who === 'Mine' ? (
                            <button type="button" className="inventory-place__view-x" aria-label={`Remove the view ${v.name}`} onClick={() => onRemoveView(v)}>
                              ×
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ))}
        {waiting && waiting.count > 0 ? (
          <ul className="inventory-place__kinds inventory-place__group">
            <li>
              <button type="button" className="inventory-place__kind inventory-place__waiting" onClick={waiting.onOpen}>
                <span>Corrections waiting</span>
                <span className="inventory-place__count">{fmt(waiting.count)}</span>
              </button>
            </li>
          </ul>
        ) : null}
      </nav>
      <div className="inventory-place__mobile-nav">
        <select aria-label="Kind" value={kind} onChange={(e) => onKind(e.currentTarget.value as Kind)}>
          {KIND_GROUPS.flat().map((k) => (
            <option key={k.key} value={k.key}>
              {k.label} · {fmt(counts[k.key])}
            </option>
          ))}
        </select>
        <select
          aria-label="Saved view"
          value={viewId}
          onChange={(e) => {
            const v = views.find((x) => x.id === e.currentTarget.value);
            if (v) onView(v);
            else onKind(kind);
          }}
        >
          <option value="">All {KIND_GROUPS.flat().find((k) => k.key === kind)?.label.toLowerCase()}</option>
          {viewsFor(views, kind).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {fmt(viewCounts.get(v.id))}
            </option>
          ))}
        </select>
        {waiting && waiting.count > 0 ? (
          <button type="button" onClick={waiting.onOpen}>
            Corrections waiting · {fmt(waiting.count)}
          </button>
        ) : null}
      </div>
    </>
  );
}

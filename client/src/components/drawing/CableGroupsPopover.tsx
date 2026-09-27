import { useMemo, useState } from 'react';

import type { Document } from '../../document/model';
import {
  availableCableGroupRefs,
  cableGroupRefKey,
  isAllShortcutLit,
  isNoneShortcutLit,
  resolveCableGroup,
  resolveStoredGroups,
  withAllShortcut,
  withGroupAdded,
  withGroupRemoved,
  withGroupTicked,
  withNoneShortcut,
  type CableGroupKindLabel,
  type CableGroupRef,
  type StoredCableGroupsState,
} from './cableGroups';
import type { ClosetView } from './contract';
import '../../styles/cableGroupsPopover.css';

export interface CableGroupsPopoverProps {
  doc: Document;
  view: ClosetView;
  state: StoredCableGroupsState;
  onStateChange: (next: StoredCableGroupsState) => void;
  /** The rack stop's own drawn-cable count, out of every cable in the view
   * — decision 2's "showing 5 of 38", computed once by the caller
   * (`Drawing.tsx`'s own `computeCableDraw`) so this popover need not repeat
   * the draw rule. */
  drawnCount: number;
  totalCount: number;
  onShowAllHidden: () => void;
}

const KIND_ORDER: Record<CableGroupKindLabel, number> = { VLAN: 0, TAG: 1, TYPE: 2, DEVICE: 3 };

/** GitHub issue #54 — the Cables list, hanging from the lit Cables lens
 * (`Bar.tsx`). One popover, two screens: the groups themselves, and the
 * "+ Add a group…" picker over VLANs, tags, types and devices. Never saved
 * to the design (`cableGroups.ts`'s own storage layer) — this component
 * only turns a click into a new `StoredCableGroupsState` and hands it back.
 */
export function CableGroupsPopover({ doc, view, state, onStateChange, drawnCount, totalCount, onShowAllHidden }: CableGroupsPopoverProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  const { rows } = useMemo(() => resolveStoredGroups(doc, view, state), [doc, view, state]);

  const pickerRows = useMemo(() => {
    if (!pickerOpen) return [];
    const already = new Set(state.groups.map((g) => cableGroupRefKey(g.ref)));
    const q = pickerQuery.trim().toLowerCase();
    const candidates: Array<{ ref: CableGroupRef; kindLabel: CableGroupKindLabel; name: string; count: number }> = [];
    for (const ref of availableCableGroupRefs(doc, view)) {
      const key = cableGroupRefKey(ref);
      if (already.has(key)) continue;
      const resolved = resolveCableGroup(doc, view, ref);
      if (!resolved) continue;
      if (q.length > 0 && !resolved.name.toLowerCase().includes(q) && !resolved.kindLabel.toLowerCase().includes(q)) continue;
      candidates.push({ ref, kindLabel: resolved.kindLabel, name: resolved.name, count: resolved.cableIds.size });
    }
    candidates.sort((a, b) => KIND_ORDER[a.kindLabel] - KIND_ORDER[b.kindLabel] || a.name.localeCompare(b.name));
    return candidates;
  }, [pickerOpen, pickerQuery, doc, view, state.groups]);

  if (pickerOpen) {
    return (
      <div className="cable-groups-pop">
        <div className="cable-groups-pop__header">
          <span className="cable-groups-pop__title">Add a group</span>
          <button type="button" className="cable-groups-pop__back" onClick={() => setPickerOpen(false)}>
            back
          </button>
        </div>
        <div className="cable-groups-pop__search">
          <input
            autoFocus
            type="text"
            placeholder="VLAN, tag, type or device"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
          />
        </div>
        <div className="cable-groups-pop__rows" role="listbox">
          {pickerRows.length === 0 && <div className="cable-groups-pop__empty">nothing matches</div>}
          {pickerRows.map((row) => (
            <button
              key={cableGroupRefKey(row.ref)}
              type="button"
              role="option"
              className="cable-groups-pop__pick-row"
              onClick={() => {
                onStateChange(withGroupAdded(state, row.ref));
                setPickerOpen(false);
                setPickerQuery('');
              }}
            >
              <span className="cable-groups-pop__name">{row.name}</span>
              <span className="cable-groups-pop__kind">{row.kindLabel}</span>
              <span className="cable-groups-pop__count">{row.count}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="cable-groups-pop">
      <div className="cable-groups-pop__header">
        <span className="cable-groups-pop__title">Cables · groups</span>
        <span className="cable-groups-pop__showing">
          showing <strong>{drawnCount}</strong> of {totalCount}
        </span>
      </div>
      <div className="cable-groups-pop__shortcuts">
        <button
          type="button"
          className={isAllShortcutLit(state) ? 'cable-groups-pop__fchip cable-groups-pop__fchip--lit' : 'cable-groups-pop__fchip'}
          onClick={() => onStateChange(withAllShortcut(state))}
        >
          All
        </button>
        <button
          type="button"
          className={isNoneShortcutLit(state) ? 'cable-groups-pop__fchip cable-groups-pop__fchip--lit' : 'cable-groups-pop__fchip'}
          onClick={() => onStateChange(withNoneShortcut(state))}
        >
          None
        </button>
        <span className="cable-groups-pop__hint">shortcuts; the groups below decide</span>
      </div>
      {rows.map(({ stored, resolved }) => {
        const key = cableGroupRefKey(stored.ref);
        return (
          <div key={key} className={stored.on ? 'cable-groups-pop__row cable-groups-pop__row--on' : 'cable-groups-pop__row'}>
            <label className="cable-groups-pop__check">
              <input
                type="checkbox"
                checked={stored.on}
                onChange={(e) => onStateChange(withGroupTicked(state, key, e.target.checked))}
              />
            </label>
            <span className="cable-groups-pop__name">{resolved.name}</span>
            <span className="cable-groups-pop__kind">{resolved.kindLabel}</span>
            <span className="cable-groups-pop__count">{resolved.cableIds.size}</span>
            <button
              type="button"
              className="cable-groups-pop__remove"
              aria-label={`remove group ${resolved.name}`}
              onClick={() => onStateChange(withGroupRemoved(state, key))}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="cable-groups-pop__add" onClick={() => setPickerOpen(true)}>
        <span className="cable-groups-pop__add-plus">+</span>
        <span>Add a group…</span>
        <span className="cable-groups-pop__hint">by VLAN, tag, type or device</span>
      </button>
      {state.hiddenCableIds.length > 0 && (
        <div className="cable-groups-pop__hidden">
          <span className="cable-groups-pop__hidden-chip">{state.hiddenCableIds.length} hidden one at a time</span>
          <button type="button" className="cable-groups-pop__show-link" onClick={onShowAllHidden}>
            show
          </button>
        </div>
      )}
      <div className="cable-groups-pop__footer">Kept in this browser; never saved to the design.</div>
    </div>
  );
}

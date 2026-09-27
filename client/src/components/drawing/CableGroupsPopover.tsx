import { useMemo, useState } from 'react';

import type { Document } from '../../document/model';
import {
  availableCableGroupCandidates,
  cableGroupRefKey,
  closetHiddenCableCount,
  isAllShortcutLit,
  isNoneShortcutLit,
  resolveCableGroup,
  withAllShortcut,
  withGroupAdded,
  withGroupRemoved,
  withGroupTicked,
  withNoneShortcut,
  type CableGroupKindLabel,
  type CableGroupRef,
  type ResolvedCableGroup,
  type StoredCableGroup,
  type StoredCableGroupsState,
} from './cableGroups';
import type { ClosetView } from './contract';
import '../../styles/cableGroupsPopover.css';

const PICKER_ROW_CAP = 50;

export interface CableGroupsPopoverProps {
  doc: Document;
  view: ClosetView;
  state: StoredCableGroupsState;
  /** Already resolved by the caller (`racks/RacksPlace.tsx`) — this popover
   * never resolves a group a second time. */
  rows: ReadonlyArray<{ stored: StoredCableGroup; resolved: ResolvedCableGroup }>;
  onStateChange: (next: StoredCableGroupsState) => void;
  /** The rack stop's own drawn-cable count, out of every cable in this
   * closet, computed once by the caller (`RacksPlace.tsx`'s own
   * `computeCableDraw`) so this popover need not repeat the draw rule. */
  drawnCount: number;
  totalCount: number;
  onShowAllHidden: () => void;
}

const KIND_ORDER: Record<CableGroupKindLabel, number> = { VLAN: 0, TAG: 1, TYPE: 2, DEVICE: 3 };

/** The Cables list, hanging from the lit Cables lens (`Bar.tsx`). One
 * popover, two screens: the groups themselves, and the "+ Add a group…"
 * picker over VLANs, tags, types and devices. Never saved to the design
 * (`cableGroups.ts`'s own storage layer) — this component only turns a
 * click into a new `StoredCableGroupsState` and hands it back.
 */
export function CableGroupsPopover({ doc, view, state, rows, onStateChange, drawnCount, totalCount, onShowAllHidden }: CableGroupsPopoverProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  // Filters the cheap candidate list (a name, never a resolved cable count)
  // by text FIRST, caps what is left, and only then resolves membership for
  // the rows actually shown — never for every VLAN, tag and device in the
  // design up front.
  const pickerRows = useMemo(() => {
    if (!pickerOpen) return [];
    const already = new Set(state.groups.map((g) => cableGroupRefKey(g.ref)));
    const q = pickerQuery.trim().toLowerCase();
    const matched: Array<{ ref: CableGroupRef; kindLabel: CableGroupKindLabel; name: string }> = [];
    for (const candidate of availableCableGroupCandidates(doc, view)) {
      const key = cableGroupRefKey(candidate.ref);
      if (already.has(key)) continue;
      if (q.length > 0 && !candidate.name.toLowerCase().includes(q) && !candidate.kindLabel.toLowerCase().includes(q)) continue;
      matched.push(candidate);
    }
    matched.sort((a, b) => KIND_ORDER[a.kindLabel] - KIND_ORDER[b.kindLabel] || a.name.localeCompare(b.name));
    const shown = matched.slice(0, PICKER_ROW_CAP);
    return shown.map((candidate) => {
      const resolved = resolveCableGroup(doc, view, candidate.ref);
      return { ref: candidate.ref, kindLabel: candidate.kindLabel, name: candidate.name, count: resolved?.cableIds.size ?? 0 };
    });
  }, [pickerOpen, pickerQuery, doc, view, state.groups]);

  function addHighlighted(): void {
    const row = pickerRows[highlight];
    if (!row) return;
    onStateChange(withGroupAdded(state, row.ref));
    setPickerOpen(false);
    setPickerQuery('');
    setHighlight(0);
  }

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
            onChange={(e) => {
              setPickerQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, Math.max(pickerRows.length - 1, 0)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                addHighlighted();
              }
            }}
          />
        </div>
        <div className="cable-groups-pop__rows" role="listbox">
          {pickerRows.length === 0 && <div className="cable-groups-pop__empty">nothing matches</div>}
          {pickerRows.map((row, i) => (
            <button
              key={cableGroupRefKey(row.ref)}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className={
                i === highlight ? 'cable-groups-pop__pick-row cable-groups-pop__pick-row--highlight' : 'cable-groups-pop__pick-row'
              }
              onMouseEnter={() => setHighlight(i)}
              onClick={() => {
                onStateChange(withGroupAdded(state, row.ref));
                setPickerOpen(false);
                setPickerQuery('');
                setHighlight(0);
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
      <button
        type="button"
        className="cable-groups-pop__add"
        onClick={() => {
          setPickerOpen(true);
          setHighlight(0);
        }}
      >
        <span className="cable-groups-pop__add-plus">+</span>
        <span>Add a group…</span>
        <span className="cable-groups-pop__hint">by VLAN, tag, type or device</span>
      </button>
      {state.hiddenCableIds.length > 0 && (
        <div className="cable-groups-pop__hidden">
          <span className="cable-groups-pop__hidden-chip">
            {closetHiddenCableCount(view, state.hiddenCableIds)} hidden one at a time
          </span>
          <button type="button" className="cable-groups-pop__show-link" onClick={onShowAllHidden}>
            show
          </button>
        </div>
      )}
      <div className="cable-groups-pop__footer">Kept in this browser; never saved to the design.</div>
    </div>
  );
}

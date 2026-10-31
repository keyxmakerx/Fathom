// Sign-off r63: stepping into a shelf. Everything on it drawn large and front-on, left to right by slot,
// with empty slots hatched. The bar's path gains the rack and the shelf, and leads back out; so does Esc.
// A click selects (the panel beside shows it), a double-click on a device opens it as Open does.
import { useEffect, type JSX, type MouseEvent } from 'react';

import type { ClosetView, OccupantView } from '../../document/view';
import { PORT_GLYPHS } from '../ports';
import type { Selection } from '../drawing/contract';
import { findShelf } from '../drawing/lookup';
import { portKindFor } from '../drawing/portGlyph';
import { deviceChassis } from '../jot/jotLayout';
import './shelfRoom.css';

export interface ShelfRoomProps {
  view: ClosetView;
  shelfId: string;
  selected: Selection | null;
  /** A card or an opened device is over this view: it takes the keys. */
  paused: boolean;
  onSelect: (selection: Selection | null) => void;
  /** Opens a device on the shelf, the same as Open on it anywhere else. */
  onOpenDevice: (chassisId: string) => void;
  onBack: () => void;
}

function focusInField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
}

/** The slots to draw, left to right: the shelf's own count when it has one, else just the slots in use. */
export function shelfRoomSlots(slots: number | null | undefined, occupants: readonly Pick<OccupantView, 'slot'>[]): number[] {
  const highest = Math.max(0, ...occupants.map((o) => o.slot));
  const count = Math.max(slots ?? 0, highest);
  if (slots != null && slots > 0) return Array.from({ length: count }, (_, i) => i + 1);
  return [...new Set(occupants.map((o) => o.slot))].sort((a, b) => a - b);
}

export function ShelfRoom({ view, shelfId, selected, paused, onSelect, onOpenDevice, onBack }: ShelfRoomProps): JSX.Element {
  const found = findShelf(view, shelfId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || focusInField() || e.key !== 'Escape' || e.defaultPrevented) return;
      onBack();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, onBack]);

  if (found == null) return <div className="shelf-room shelf-room--gone">That shelf is no longer in the design.</div>;
  const { rack, shelf } = found;
  const bySlot = new Map(shelf.occupants.map((o) => [o.slot, o]));
  const slots = shelfRoomSlots(shelf.slots, shelf.occupants);
  const free = slots.filter((s) => !bySlot.has(s)).length;
  const farName = (chassisId: string | null) => (chassisId == null ? null : deviceChassis(view, chassisId)?.hostname || null);

  return (
    <div className="shelf-room" data-testid="shelf-room" onClick={() => onSelect({ kind: 'shelf', id: shelf.id })}>
      <div className="shelf-room__bar">
        {/* As with an opened device, no "← Rack" here: the bar's path and Esc lead back out. */}
        <span className="shelf-room__name">{shelf.label || 'Shelf'}</span>
        <span className="shelf-room__meta">
          SHELF {shelf.heightU}U · {rack.label || 'Rack'} U{shelf.positionU} · {shelf.occupants.length} on it
          {free > 0 ? ` · ${free} ${free === 1 ? 'slot' : 'slots'} free` : ''}
        </span>
      </div>
      <div className="shelf-room__stage">
        {slots.length === 0 ? (
          <div className="shelf-room__empty">Nothing on this shelf yet.</div>
        ) : (
          <div className="shelf-room__tray" style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(168px, 1fr))` }}>
            {slots.map((slot) => {
              const occupant = bySlot.get(slot);
              if (occupant == null) {
                return (
                  <div key={`gap-${slot}`} className="shelf-room__gap">
                    <span className="shelf-room__slot">SLOT {slot}</span>
                    <span>empty</span>
                  </div>
                );
              }
              const isDevice = occupant.kind === 'chassis';
              const isSelected = selected?.kind === 'occupant' && selected.id === occupant.id;
              return (
                <div
                  key={occupant.id}
                  role="button"
                  tabIndex={0}
                  data-occupant-id={occupant.id}
                  className={isSelected ? 'shelf-room__thing shelf-room__thing--selected' : 'shelf-room__thing'}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    onSelect({ kind: 'occupant', id: occupant.id });
                  }}
                  onDoubleClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    if (isDevice) onOpenDevice(occupant.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isDevice) onOpenDevice(occupant.id);
                    else if (e.key === ' ') onSelect({ kind: 'occupant', id: occupant.id });
                    else return;
                    e.preventDefault();
                  }}
                >
                  <div className="shelf-room__head">
                    <span className="shelf-room__slot">SLOT {slot}</span>
                    {isDevice ? (
                      <button
                        type="button"
                        className="shelf-room__open"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDevice(occupant.id);
                        }}
                      >
                        Open
                      </button>
                    ) : null}
                  </div>
                  <span className="shelf-room__label">{occupant.label || 'unnamed'}</span>
                  {occupant.model ? (
                    <span className="shelf-room__model">{occupant.model}</span>
                  ) : (
                    <span className="shelf-room__typed" aria-label="typed by hand">
                      typed
                    </span>
                  )}
                  {occupant.ports.length > 0 ? (
                    <ul className="shelf-room__ports">
                      {occupant.ports.map((port) => {
                        const kind = portKindFor(port.connector);
                        const Glyph = kind != null ? PORT_GLYPHS[kind] : null;
                        const cabled = port.cable != null;
                        const far = cabled ? farName(port.cable!.farChassisId) : null;
                        return (
                          <li key={port.id}>
                            <button
                              type="button"
                              data-port-id={port.id}
                              className={selected?.kind === 'port' && selected.id === port.id ? 'shelf-room__port shelf-room__port--selected' : 'shelf-room__port'}
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelect({ kind: 'port', id: port.id });
                              }}
                            >
                              {Glyph ? <Glyph cabled={cabled} title={port.label} className="shelf-room__glyph" /> : null}
                              <span>{port.label}</span>
                              <span className="shelf-room__far">{cabled ? `to ${far ?? (port.cable!.outsideCloset ? 'another closet' : '—')}` : 'free'}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <span className="shelf-room__far">No ports</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="shelf-room__lip" aria-hidden="true" />
        <p className="shelf-room__hint">Click a thing to see it in the panel. Double-click a device to open it. Esc goes back to the rack.</p>
      </div>
    </div>
  );
}

import { Fragment, useState, type DragEvent, type KeyboardEvent } from 'react';

import '../../styles/drawing.css';
import type { PaletteItem } from './contract';
import { PALETTE_DRAG_MIME, encodePaletteDrag, setDraggedUnits } from './dnd';
import { DescribeModel, type DescribedModel } from '../describe/DescribeModel';

/** A device someone described and kept (`describe/`), offered beside the catalogue. */
export interface YourModel {
  id: string;
  name: string;
  summary: string;
}

export interface PaletteProps {
  palette: PaletteItem[];
  /** Adds an item without dragging it (ADR-0060 decision 4). Absent, the rows
   * are drag sources only. */
  onPick?: (item: PaletteItem) => void;
  /** Devices this person described and kept, listed first under "Your models". */
  yours?: readonly YourModel[];
  onPickYours?: (id: string) => void;
  /** Absent, there is no "Not here? Describe it". */
  onDescribe?: (model: DescribedModel) => void;
}

function nameOf(item: PaletteItem): string {
  return item.label ?? item.model;
}

/**
 * The equipment list, the content of the shell's rail once it opens. A search
 * box narrows it; headings group common devices, things for a wall, and exact
 * models. Every row can be dragged onto the canvas, and clicked (or Enter) to
 * add it where there is room.
 */
export function Palette({ palette, onPick, yours = [], onPickYours, onDescribe }: PaletteProps) {
  const [query, setQuery] = useState('');
  const [describing, setDescribing] = useState(false);

  function handleDragStart(event: DragEvent<HTMLLIElement>, item: PaletteItem) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(PALETTE_DRAG_MIME, encodePaletteDrag(item));
    setDraggedUnits(item.rackUnits);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLLIElement>, item: PaletteItem) {
    if (onPick && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onPick(item);
    }
  }

  if (palette.length === 0) {
    return <div className="drawing-palette drawing-palette--empty">No catalogue entries.</div>;
  }

  const q = query.trim().toLowerCase();
  const shown =
    q === ''
      ? palette
      : palette.filter((item) => `${item.vendor} ${nameOf(item)} ${item.model} ${item.summary}`.toLowerCase().includes(q));
  const yoursShown = onPickYours ? yours.filter((m) => q === '' || `${m.name} ${m.summary}`.toLowerCase().includes(q)) : [];
  const describeButton = onDescribe ? (
    <button type="button" className="btn describe-open" onClick={() => setDescribing(true)} title="Draw a device the list does not have, from its ports">
      Not here? Describe it
    </button>
  ) : null;

  if (describing && onDescribe) {
    return (
      <div className="drawing-palette-wrap">
        <DescribeModel
          initialName={query.trim()}
          onCancel={() => setDescribing(false)}
          onUse={(model) => {
            onDescribe(model);
            setDescribing(false);
            setQuery('');
          }}
        />
      </div>
    );
  }

  return (
    <div className="drawing-palette-wrap">
      <input
        type="search"
        className="drawing-palette__search"
        placeholder="Search equipment"
        aria-label="Search equipment"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {yoursShown.length > 0 ? (
        <ul className="drawing-palette">
          <li className="drawing-palette__group" role="presentation">
            Your models
          </li>
          {yoursShown.map((m) => (
            <li
              key={m.id}
              className="drawing-palette__item drawing-palette__item--yours"
              role="button"
              tabIndex={0}
              title={`Click to add ${m.name}`}
              onClick={() => onPickYours?.(m.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPickYours?.(m.id);
                }
              }}
            >
              <div className="drawing-palette__item-head">
                <span className="drawing-palette__model">{m.name}</span>
              </div>
              <div className="drawing-palette__summary">{m.summary}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {shown.length === 0 && yoursShown.length === 0 ? (
        <div className="drawing-palette drawing-palette--empty">Nothing matches "{query.trim()}".</div>
      ) : shown.length === 0 ? null : (
        <ul className="drawing-palette">
          {shown.map((item, i) => (
            <Fragment key={`${item.vendor}/${item.model}/${item.role ?? ''}`}>
              {item.group !== undefined && item.group !== shown[i - 1]?.group ? (
                <li className="drawing-palette__group" role="presentation">
                  {item.group}
                </li>
              ) : null}
              <li
                className={item.vendor !== '' ? 'drawing-palette__item drawing-palette__item--model' : 'drawing-palette__item'}
                draggable
                onDragStart={(event) => handleDragStart(event, item)}
                onDragEnd={() => setDraggedUnits(null)}
                role={onPick ? 'button' : undefined}
                tabIndex={onPick ? 0 : undefined}
                title={onPick ? `Click to add ${nameOf(item)}, or drag it where you want it` : undefined}
                onClick={onPick ? () => onPick(item) : undefined}
                onKeyDown={onPick ? (event) => handleKeyDown(event, item) : undefined}
              >
                <div className="drawing-palette__item-head">
                  <span className="drawing-palette__vendor">{item.vendor}</span>
                  <span className="drawing-palette__model">{nameOf(item)}</span>
                  <span className="drawing-palette__units">{item.rackUnits}U</span>
                </div>
                <div className="drawing-palette__summary">{item.summary}</div>
              </li>
            </Fragment>
          ))}
        </ul>
      )}
      {describeButton}
    </div>
  );
}

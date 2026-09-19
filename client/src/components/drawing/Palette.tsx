import type { DragEvent } from 'react';

import '../../styles/drawing.css';
import type { PaletteItem } from './contract';
import { PALETTE_DRAG_MIME, encodePaletteDrag } from './dnd';

export interface PaletteProps {
  palette: PaletteItem[];
}

/**
 * The catalogue, as the content of the shell's folded rail once it opens
 * (`Shell.tsx`'s `Strip`, wired by the lead — this component only draws its
 * own content). Every row is a native HTML5 drag source; `Drawing.tsx`'s
 * canvas is the only drop target that understands the payload.
 */
export function Palette({ palette }: PaletteProps) {
  function handleDragStart(event: DragEvent<HTMLLIElement>, item: PaletteItem) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(PALETTE_DRAG_MIME, encodePaletteDrag(item));
  }

  if (palette.length === 0) {
    return <div className="drawing-palette drawing-palette--empty">No catalogue entries.</div>;
  }

  return (
    <ul className="drawing-palette">
      {palette.map((item) => (
        <li
          key={`${item.vendor}/${item.model}`}
          className="drawing-palette__item"
          draggable
          onDragStart={(event) => handleDragStart(event, item)}
        >
          <div className="drawing-palette__item-head">
            <span className="drawing-palette__vendor">{item.vendor}</span>
            <span className="drawing-palette__model">{item.model}</span>
            <span className="drawing-palette__units">{item.rackUnits}U</span>
          </div>
          <div className="drawing-palette__summary">{item.summary}</div>
        </li>
      ))}
    </ul>
  );
}

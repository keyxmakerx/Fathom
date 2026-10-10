// The cable colour key: a small frosted panel at the bottom-left of the canvas listing the cable colours
// in use and what they mean (`colourKey.ts`). Click a row to light those cables and dim the rest; click it
// again to put everything back.

import { useEffect, useState } from 'react';
import '../../styles/canvas-aids.css';

import type { Sheath } from '../../document/cables';
import type { KeyRow } from './colourKey';
import { SHEATH_VAR, needsHairlineOutline } from './sheath';

export function ColourKey({ rows, onHighlight }: { rows: readonly KeyRow[]; onHighlight: (cableIds: ReadonlySet<string> | null) => void }) {
  const [active, setActive] = useState<Sheath | null>(null);
  const row = active != null ? rows.find((r) => r.sheath === active) : undefined;

  // The lit cables follow the design: a recoloured or removed cable moves the highlight with it.
  const lit = row?.cableIds ?? null;
  useEffect(() => {
    onHighlight(lit);
  }, [lit, onHighlight]);
  useEffect(() => () => onHighlight(null), [onHighlight]);
  useEffect(() => {
    if (active != null && row === undefined) setActive(null);
  }, [active, row]);

  if (rows.length === 0) return null;
  return (
    <div className="colour-key" role="group" aria-label="Cable colour key" data-print-omit="">
      <div className="colour-key__head">Cable colours</div>
      <ul className="colour-key__list">
        {rows.map((r) => (
          <li key={r.sheath}>
            <button
              type="button"
              className="colour-key__row"
              aria-pressed={r.sheath === active}
              title={r.sheath === active ? 'Show every cable again' : `Light the ${r.count === 1 ? 'cable' : `${r.count} cables`} drawn in ${r.colour.toLowerCase()}`}
              onClick={() => setActive(r.sheath === active ? null : r.sheath)}
            >
              <span
                className={needsHairlineOutline(r.sheath) ? 'colour-key__swatch colour-key__swatch--outlined' : 'colour-key__swatch'}
                style={{ background: SHEATH_VAR[r.sheath] }}
                aria-hidden="true"
              />
              <span className="colour-key__text">{r.text}</span>
              {r.shares != null && <span className="colour-key__count">{r.count}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

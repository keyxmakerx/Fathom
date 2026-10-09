// Colour appears in the Inventory only as a cable's sheath: a small square beside its word.
// Ink everywhere else. The word is always shown; the square is never the only signal.

import { SHEATH_VAR } from '../drawing/sheath';
import type { Sheath } from '../drawing/contract';

export function isSheath(name: string): name is Sheath {
  return Object.prototype.hasOwnProperty.call(SHEATH_VAR, name.toLowerCase());
}

/** The square for a sheath name; nothing for a word that is not one. */
export function Swatch({ name }: { name: string }) {
  const key = name.trim().toLowerCase();
  if (!isSheath(key)) return null;
  return <span className="inv-swatch" aria-hidden="true" style={{ background: SHEATH_VAR[key as Sheath] }} />;
}

/** `swatch word`, as one unit. */
export function SheathWord({ name }: { name: string }) {
  return (
    <span className="inv-sheath">
      <Swatch name={name} />
      {name}
    </span>
  );
}

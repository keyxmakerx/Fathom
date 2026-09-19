import { CABLE_VISIBILITY_OPTIONS, type CableVisibility } from './cableVisibility';

const LABEL: Record<CableVisibility, string> = {
  all: 'all',
  copper: 'copper',
  fibre: 'fibre',
  power: 'power',
  none: 'none',
};

export interface CablesViewControlProps {
  value: CableVisibility;
  onChange: (next: CableVisibility) => void;
}

/**
 * The owner's ask of 2026-09-19: "cables · all | copper | fibre | power |
 * none, one lit." A view control, on the canvas near the lens row —
 * `docs/UI-SPEC.md` "The shape": "view controls are not lenses: a lens
 * never hides a box." The plan control on the Room board
 * (`design/places/Room.dc.html`) is the precedent for the FORM: a small
 * flat on-canvas control, its choice never a document fact.
 *
 * Every colour a token, zero radius, no shadow (`drawing.css`'s own
 * `.drawing-cables-control*` rules) — the "on" choice reads ink-on-paper,
 * exactly `Editor.tsx`'s own segmented "PLACED ON" control's look, never a
 * risk colour (UI-SPEC "Look": this is a fact about the view, not an
 * error/warning/recommendation/confirmation).
 */
export function CablesViewControl({ value, onChange }: CablesViewControlProps) {
  return (
    <div className="drawing-cables-control" role="group" aria-label="Cables">
      <span className="drawing-cables-control__label">cables</span>
      {CABLE_VISIBILITY_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          className={
            option === value
              ? 'drawing-cables-control__option drawing-cables-control__option--on'
              : 'drawing-cables-control__option'
          }
          onClick={() => onChange(option)}
        >
          {LABEL[option]}
        </button>
      ))}
    </div>
  );
}

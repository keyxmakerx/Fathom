// The note over an empty design (ADR-0060 decision 4) with its "Add equipment" button (ADR-0065 §3), which
// opens the Equipment tab. The note takes no click (so it never blocks a drop); the button does.

import { ADD_EQUIPMENT_LABEL } from '../racks/emptyHints';

export function EmptyHint({ hint, onAddEquipment }: { hint: string; onAddEquipment?: () => void }) {
  return (
    <div className="drawing-empty-hint" role="note">
      <p>{hint}</p>
      {onAddEquipment != null ? (
        <button type="button" className="drawing-empty-hint__add" onClick={onAddEquipment} data-testid="add-equipment">
          {ADD_EQUIPMENT_LABEL}
        </button>
      ) : null}
    </div>
  );
}

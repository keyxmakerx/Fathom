// A planned address that is not drawn on the device it is meant for, marked on that device in the
// plan colour (ADR-0083 decision 7), the way an AI's proposed change is marked. Dashed, because it
// is intended and not yet true. It never takes the pointer, so the device under it works as before.
import { createContext, useContext } from 'react';

import type { PlannedMark } from './ipPlanChecks';
import { CheckMarksContext } from './checksStore';
import '../drawing/plans-canvas.css';
import './checks.css';

export const PlannedMarksContext = createContext<ReadonlyMap<string, readonly PlannedMark[]>>(new Map());

/** The words on the tag and its hover text: the first address, and how many more. */
export function plannedWords(marks: readonly PlannedMark[]): { tag: string; title: string } {
  const first = marks[0]!;
  const more = marks.length - 1;
  return {
    tag: more > 0 ? `PLAN ${first.address} +${more}` : `PLAN ${first.address}`,
    title: marks.map((m) => `${m.address} is planned for "${m.meant}" in the IP plan and is not drawn here yet.`).join(' '),
  };
}

export function PlannedAddressMark({ deviceId }: { deviceId: string }) {
  const marks = useContext(PlannedMarksContext).get(deviceId);
  const on = useContext(CheckMarksContext);
  if (!marks || marks.length === 0 || !on) return null;
  const { tag, title } = plannedWords(marks);
  return (
    <span className="planned-mark" title={title} aria-label={title} data-testid="planned-mark">
      {tag}
    </span>
  );
}

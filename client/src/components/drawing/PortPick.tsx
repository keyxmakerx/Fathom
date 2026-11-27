// r159: a pressed port is marked as picked, wherever it is drawn: on a rack device, on a wall, on a shelf.
//
// A pressed port had no mark of its own: the dot where its card's line starts was the only sign, and with Details
// open there is no card. Now it stands on a square of ink, as a selected thing on a shelf is drawn in ink
// (`drawing.css`, `.drawing-port-pick`). A selected cable's two ports keep their hairline ring: the square says
// "this is what is selected", the ring "this is where the selected cable ends".
//
// Each drawn port asks the live store one question, so pressing a port re-renders that port and the one before it,
// nothing else. A port that is not drawn (far out) has no button and no mark.

import { useLive } from './liveStore';

/** Whether `portId` is the selected port. */
export function isPickedPort(selected: { kind: string; id: string } | null, portId: string): boolean {
  return selected?.kind === 'port' && selected.id === portId;
}

/** The square behind a pressed port; nothing for any other. A child of the port's own button. */
export function PortPick({ portId }: { portId: string }) {
  const picked = useLive((s) => isPickedPort(s.selected, portId));
  return picked ? <span className="drawing-port-pick" aria-hidden="true" /> : null;
}

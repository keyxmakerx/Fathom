// The Show menu's rows for the small aids on the canvas. Pure; the state is `drawing/canvasAids.ts`.

import { colourKeyShown, type AidId, type AidPrefs } from '../drawing/canvasAids';
import type { ShowAids } from '../shell/types';

/** The mini-map row is always there; the colour key row only in the Rack look, where cables are coloured. */
export function showAidsFor(prefs: AidPrefs, state: { rack: boolean; colours: number }, onToggle: (id: AidId) => void): ShowAids {
  const items: ShowAids['items'][number][] = [{ id: 'minimap', label: 'Mini-map', on: prefs.minimap, note: 'big drawings only' }];
  if (state.rack) {
    items.push({
      id: 'colourKey',
      label: 'Cable colour key',
      on: colourKeyShown(prefs.colourKey, state.colours),
      note: prefs.colourKey === null && state.colours < 2 ? 'needs two colours' : undefined,
    });
  }
  return { items, onToggle };
}

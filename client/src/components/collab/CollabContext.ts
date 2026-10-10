import { createContext } from 'react';

import type { Selection } from '../drawing/contract';
import type { ChangedThing } from './changesSince';
import type { Point, PointerInfo } from './pointers';

/** What the canvas shows of other people: their pointers, and what they changed while you were away. */
export interface CollabApi {
  /** Our own pointer, in canvas coordinates; `null` when it left. */
  setPointer(point: Point | null): void;
  /** Hears everyone else's pointers. Returns how to stop. */
  subscribePointers(listener: (pointers: PointerInfo[]) => void): () => void;
  /** Present only while there is something to show. */
  changes: {
    /** "2 changes by Sam since Tuesday". */
    sentence: string;
    things: ChangedThing[];
    /** Set once the things have glowed, so a remount (another look) does not glow them again. */
    glowed: { current: boolean };
    /** Marks everything as seen and takes the bar away. */
    dismiss(): void;
  } | null;
  /** Selects a thing as if it had been clicked. */
  select(selection: Selection): void;
}

/** `null` outside a design (a drawing shown on its own): the layer draws nothing. */
export const CollabContext = createContext<CollabApi | null>(null);

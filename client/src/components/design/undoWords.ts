// What a refused Undo or Redo says to the person who pressed it. The refusal's own message (`UndoConflictError`)
// quotes ids, an account's among them; this names the person and the thing. Pure, so it is tested without a page.

import { elementName, NO_NAME } from '../../document/liveDoc';
import type { Document } from '../../document/model';
import type { UndoConflict } from '../../document/undo';
import type { EditsOff } from '../shell/types';

import { namedWords } from './changeToast';

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

/** One sentence for a refusal: what stood in the way, and whose change it was. `nameOf` gives a person's name as
 * histories write it ("a colleague" when none has been heard), never a piece of an account id. */
export function refusedSentence(doc: Document, c: UndoConflict, press: 'undo' | 'redo', nameOf: (account: string) => string): string {
  const nothing = `Nothing was ${press === 'undo' ? 'undone' : 'redone'}`;
  switch (c.kind) {
    case 'later-change': {
      const name = elementName(doc, c.element);
      const what = name === NO_NAME ? 'the same part of the design' : name;
      const theirs = doc.batches.find((b) => b.id === c.batchId);
      const did = theirs === undefined ? '' : ` (${lowerFirst(namedWords(doc, theirs))})`;
      return `${nothing}: ${what} was changed by ${nameOf(c.actor)} since${did}.`;
    }
    case 'revive-refused': {
      if (c.taken === undefined) return `${nothing}: what it was attached to is gone now.`;
      const rack = elementName(doc, c.taken.rack);
      const by = elementName(doc, c.taken.by);
      return `${nothing}: U${c.taken.positionU}${rack === NO_NAME ? '' : ` in ${rack}`} is taken now${by === NO_NAME ? '' : `, by ${by}`}.`;
    }
    case 'recorded-plan':
      return `${nothing}: a recorded plan is history as written.`;
    case 'not-yours':
      return `${nothing}: that change is ${nameOf(c.actor)}'s.`;
    case 'unattributed':
      return `${nothing}: that change has no one person it belongs to.`;
  }
}

/** Why Undo or Redo cannot be pressed just now, or null when it can. The first that holds is the one said: a
 * person who may not change the design is told that, not that there is nothing to undo. The bar, its folded menu
 * and Search all ask here, so the three never disagree. */
export function notOffered(
  press: 'undo' | 'redo',
  now: {
    /** This person may change the design (ADR-0052 §5). */
    canDraw: boolean;
    /** The drawing on a phone, which is to look at (ADR-0075 decision 1). */
    phoneCanvas: boolean;
    /** A save from History is drawn in place of the design as it is now. */
    lookingBack: boolean;
    /** There is a step of this person's own to take. */
    any: boolean;
  },
): EditsOff | null {
  if (!now.canDraw) return 'viewOnly';
  if (now.phoneCanvas) return 'phoneCanvas';
  if (now.lookingBack) return 'save';
  if (!now.any) return press === 'undo' ? 'nothingToUndo' : 'nothingToRedo';
  return null;
}

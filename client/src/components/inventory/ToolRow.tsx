// r116: Inventory's and the Sheet's tool row, under the bar: Back (only from a page), Find, and the lens beside it.

import type { ReactNode } from 'react';

import { LensGroup } from '../shell/CanvasBar';
import type { Lens } from '../shell/lens';

export interface ToolRowProps {
  /** Present only while a page is open: where Back goes. */
  back?: { word: string; onBack: () => void };
  /** The Find box; absent on the Sheet, which has none. */
  find?: ReactNode;
  lens: Lens;
  onLensChange: (lens: Lens) => void;
}

export function ToolRow({ back, find, lens, onLensChange }: ToolRowProps) {
  return (
    <div className="inv-toolrow" role="toolbar" aria-label="Inventory tools" data-testid="inv-toolrow">
      {back != null ? (
        <button type="button" className="inv-toolrow__back" onClick={back.onBack} title={`Back to ${back.word}`} data-testid="inv-back">
          <span aria-hidden="true">←</span> Back
        </button>
      ) : null}
      {find ?? <span className="inv-toolrow__grow" />}
      <LensGroup place="inventory" lens={lens} onLensChange={onLensChange} />
    </div>
  );
}

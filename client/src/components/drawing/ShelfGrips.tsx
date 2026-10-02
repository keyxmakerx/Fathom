// A selected shelf's two resize grips (ADR-0060 step 7): the bottom one for height, the right
// one for slots. A drag shows the new units dashed and lights its units in the rack; the
// engine's own refusal names what is in the way. Let go to keep, Esc to cancel.

import { useState } from 'react';

import type { ShelfView } from '../../document/view';
import { useGripDrag, type GripDrag } from './useGripDrag';
import { useLiveStore } from './liveStore';
import { U_PX } from './geometry';

/** Flow units of drag per slot added or removed. */
const SLOT_STEP_PX = 32;
const MAX_SLOTS = 32;

export type ResizeChange = { heightU?: number; slots?: number };
/** `preview` asks without doing: a refusal comes back as its sentence. */
export type ResizeShelf = (change: ResizeChange, preview: boolean) => { refused: string } | void;

interface Props {
  shelf: ShelfView;
  rackId: string;
  /** Slots now: the stored count, else the highest taken. */
  slotsNow: number;
  onResize: ResizeShelf;
  onSlotsPreview: (slots: number | null) => void;
}

export function ShelfGrips({ shelf, rackId, slotsNow, onResize, onSlotsPreview }: Props) {
  const store = useLiveStore();
  const [caption, setCaption] = useState<{ text: string; refused: boolean } | null>(null);
  const [dh, setDh] = useState(0);

  const heightFor = (d: GripDrag): number => Math.max(1, shelf.heightU + Math.round(d.dy / U_PX));
  const slotsFor = (d: GripDrag): number => Math.min(MAX_SLOTS, Math.max(1, slotsNow + Math.round(d.dx / SLOT_STEP_PX)));

  const clear = (): void => {
    setCaption(null);
    setDh(0);
    onSlotsPreview(null);
    store.setState({ dropPreview: {} });
  };

  const heightGrip = useGripDrag({
    onMove: (d) => {
      const h = heightFor(d);
      const grow = h - shelf.heightU;
      setDh(grow);
      const refusal = h === shelf.heightU ? undefined : onResize({ heightU: h }, true);
      setCaption({ text: refusal ? refusal.refused : `${shelf.label} · ${shelf.heightU}U → ${h}U · let go to keep · Esc to cancel`, refused: !!refusal });
      store.setState({
        dropPreview: grow > 0 ? { [rackId]: { fromU: Math.max(1, shelf.positionU - grow), toU: shelf.positionU - 1, valid: !refusal } } : {},
      });
    },
    onEnd: (d, cancelled) => {
      const h = heightFor(d);
      clear();
      if (!cancelled && d.moved && h !== shelf.heightU) onResize({ heightU: h }, false);
    },
  });

  const slotGrip = useGripDrag({
    onMove: (d) => {
      const n = slotsFor(d);
      const refusal = n === slotsNow ? undefined : onResize({ slots: n }, true);
      onSlotsPreview(refusal ? null : n);
      setCaption({ text: refusal ? refusal.refused : `${shelf.label} · ${slotsNow} → ${n} slots · let go to keep · Esc to cancel`, refused: !!refusal });
    },
    onEnd: (d, cancelled) => {
      const n = slotsFor(d);
      clear();
      if (!cancelled && d.moved && n !== slotsNow) onResize({ slots: n }, false);
    },
  });

  return (
    <>
      {dh !== 0 && (
        <div
          className="drawing-shelf__proposed"
          style={dh > 0 ? { top: shelf.heightU * U_PX, height: dh * U_PX } : { top: (shelf.heightU + dh) * U_PX, height: -dh * U_PX }}
        >
          <span className="drawing-shelf__proposed-label">{dh > 0 ? `+${dh}U` : `${dh}U`}</span>
        </div>
      )}
      {caption && <div className={caption.refused ? 'drawing-shelf__caption drawing-shelf__caption--refused' : 'drawing-shelf__caption'}>{caption.text}</div>}
      <button type="button" className="free-square drawing-shelf__grip drawing-shelf__grip--h nodrag nopan" aria-label="Resize the shelf's height" onPointerDown={heightGrip} />
      <button type="button" className="free-square drawing-shelf__grip drawing-shelf__grip--w nodrag nopan" aria-label="Resize the shelf's slots" onPointerDown={slotGrip} />
    </>
  );
}

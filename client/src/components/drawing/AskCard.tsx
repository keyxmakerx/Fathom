import { useEffect, useRef, useState } from 'react';

import { ContextMenu } from './ContextMenu';
import { cableRunItems, RACK_SIZE_CHOICES, type MenuActions, type MenuItem } from './contextMenuItems';

/** The most units a rack may be given by hand (the panel's Height field asks the same). */
const MAX_RACK_U = 255;

/** r116: "Add a rack…" asks its one question after the click: 42U, 24U, 12U or Custom. */
export function RackSizeAsk({ x, y, onPick, onClose }: { x: number; y: number; onPick: (heightU: number) => void; onClose: () => void }) {
  const [custom, setCustom] = useState(false);
  const toForm = useRef(false);
  if (!custom) {
    const items: MenuItem[] = [
      ...RACK_SIZE_CHOICES.map((u) => ({ label: `${u}U`, onSelect: () => onPick(u) })),
      // The menu calls close just before a pick runs; Custom keeps this open and the form takes its place.
      {
        label: 'Custom…',
        onSelect: () => {
          toForm.current = true;
          setCustom(true);
        },
      },
    ];
    return <ContextMenu x={x} y={y} items={items} onClose={() => queueMicrotask(() => !toForm.current && onClose())} title="How tall is the rack?" />;
  }
  return <CustomHeight x={x} y={y} onPick={onPick} onClose={onClose} />;
}

function CustomHeight({ x, y, onPick, onClose }: { x: number; y: number; onPick: (heightU: number) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const box = useRef<HTMLFormElement>(null);
  useEffect(() => {
    box.current?.querySelector('input')?.focus();
    // Escape closes only this, as the menu does; a press elsewhere puts it away.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (box.current != null && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  return (
    <form
      ref={box}
      className="drawing-context-menu drawing-ask"
      style={{ left: x, top: y }}
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(text);
        if (text.trim() === '' || !Number.isInteger(n) || n < 1 || n > MAX_RACK_U) {
          setRefusal(`Type a whole number of units, 1 to ${MAX_RACK_U}.`);
          return;
        }
        onPick(n);
      }}
    >
      <div className="drawing-context-menu__title">How many units?</div>
      <input inputMode="numeric" aria-label="Rack height in units" placeholder="e.g. 18" value={text} onChange={(e) => setText(e.target.value)} />
      {refusal != null ? <div className="drawing-context-menu__why">{refusal}</div> : null}
      <button type="submit">Add rack</button>
    </form>
  );
}

/** r116: "Add a cable run…" asks its one question after the click: which kind, on which free side. */
export function CableRunAsk({ x, y, hostId, actions, onClose }: { x: number; y: number; hostId: string; actions: MenuActions; onClose: () => void }) {
  return <ContextMenu x={x} y={y} items={cableRunItems(hostId, actions)} onClose={onClose} title="Cable runs" />;
}

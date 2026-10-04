// Every text box inside this boundary gates what is pasted or dropped into it (CLAUDE.md rule 4);
// what is typed is left as typed. A box that gates its own paste says so with `data-gate="self"`.
// Without a gate, a paste inserts nothing. The new value reaches React the way a keystroke would.

import { useCallback, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';

import { gatedInsert, type Redact } from './gatedPaste';

const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', '']);

function gatedBox(target: EventTarget): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target.closest('[data-gate="self"]')) return null;
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_TYPES.has(target.type)) return target;
  return null;
}

/** Sets a box's value so React's onChange fires as if it were typed. */
function setValue(box: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(box, value);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

export function PasteGateBoundary({ redact, children }: { redact: Redact | null; children: ReactNode }) {
  const take = useCallback(
    (box: HTMLInputElement | HTMLTextAreaElement, text: string) => {
      if (!redact) return; // fail closed
      gatedInsert(redact, box, text, box instanceof HTMLTextAreaElement).then(
        (next) => {
          setValue(box, next.value);
          box.setSelectionRange?.(next.caret, next.caret);
        },
        () => undefined,
      );
    },
    [redact],
  );
  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const box = gatedBox(e.target);
    const text = e.clipboardData.getData('text/plain');
    if (!box || text === '') return;
    e.preventDefault();
    take(box, text);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    const box = gatedBox(e.target);
    const text = e.dataTransfer.getData('text/plain');
    if (!box || text === '') return;
    e.preventDefault();
    take(box, text);
  };
  return (
    <div className="paste-gate" style={{ display: 'contents' }} onPasteCapture={onPaste} onDropCapture={onDrop}>
      {children}
    </div>
  );
}

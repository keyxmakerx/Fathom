import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface EditorProps {
  children: ReactNode;
  /** Live notices. They sit under their field when this panel shows it. */
  notices?: ReactNode;
  /** The panel label of the field the notices belong under ("serial"). */
  noticeField?: string | null;
  /** The element that field is on. */
  noticeElement?: string | null;
  /** Said when the notices are (or are no longer) drawn here; otherwise the shell draws them elsewhere. */
  onAnchored?: (anchored: boolean) => void;
}

const HOST_CLASS = 'shell-editor__notices--field';

/** The row whose label is `field` ("Serial", "Height (U)"), or the panel's title for a name. */
export function matchLabel(text: string, want: string): boolean {
  return text === want || text.startsWith(`${want} `) || text.startsWith(`${want}(`);
}

/** Does a panel's `data-elements` list hold `element`? */
export function panelHolds(elements: string | undefined, element: string): boolean {
  return (elements ?? '').split(' ').includes(element);
}

/**
 * The row for `field` on `element` in this panel, or null when the panel shows another element
 * (a panel lists its own ids in `data-elements`) or has no such row.
 */
export function rowFor(aside: ParentNode, field: string, element: string): HTMLElement | null {
  const panel = [...aside.querySelectorAll<HTMLElement>('[data-elements]')].find((p) =>
    panelHolds(p.dataset.elements, element),
  );
  if (panel == null) return null;
  const want = field.toLowerCase();
  for (const label of panel.querySelectorAll<HTMLElement>('.drawing-editor__field-label')) {
    if (matchLabel((label.textContent ?? '').trim().toLowerCase(), want)) return label.parentElement;
  }
  return want === 'name' ? panel.querySelector<HTMLElement>('.drawing-editor__title') : null;
}

/**
 * The editor surface — BRIEF.md "Under the bar": "The editor is closed
 * unless something is selected. Where a board has nothing selected, there
 * is no right panel at all." `Shell` only mounts this when its `editor`
 * prop is not `null`, so absence from the DOM is the caller not rendering
 * it, not this component hiding itself.
 *
 * The notices sit directly under the row they are about, on the element the panel shows;
 * otherwise the shell draws them in the canvas corner, so they are never below the fold.
 */
export function Editor({ children, notices, noticeField, noticeElement, onAnchored }: EditorProps) {
  const aside = useRef<HTMLElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const root = aside.current;
    if (root == null || noticeField == null || noticeElement == null) {
      setHost(null);
      return;
    }
    const find = () => {
      const row = rowFor(root, noticeField, noticeElement);
      if (row == null) return setHost(null);
      let h = row.querySelector<HTMLElement>(`:scope > .${HOST_CLASS}`);
      if (h == null) {
        h = document.createElement('div');
        h.className = `shell-editor__notices ${HOST_CLASS}`;
        row.appendChild(h);
      }
      setHost((cur) => (cur === h ? cur : h));
    };
    find();
    const watch = new MutationObserver(find);
    watch.observe(root, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      root.querySelectorAll(`.${HOST_CLASS}`).forEach((n) => n.remove());
    };
  }, [noticeField, noticeElement]);

  const target = notices != null ? host : null;
  const shown = target != null;
  useEffect(() => {
    onAnchored?.(shown);
    return () => onAnchored?.(false);
  }, [shown, onAnchored]);

  // Bring a newly shown notice into view if it is not.
  useEffect(() => {
    if (target != null && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' });
  }, [target]);

  return (
    <aside className="shell-editor" aria-label="Editor" ref={aside}>
      {children}
      {target != null && createPortal(notices, target)}
    </aside>
  );
}

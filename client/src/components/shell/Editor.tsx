import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface EditorProps {
  children: ReactNode;
  /** Live notices. */
  notices?: ReactNode;
  /** The panel label of the field the notices belong under ("serial"); they go right below its row. */
  noticeField?: string | null;
}

const HOST_CLASS = 'shell-editor__notices shell-editor__notices--field';

/** The row whose label is `field` ("Serial", "Height (U)"), or the panel's title for a name. */
function rowFor(aside: HTMLElement, field: string): HTMLElement | null {
  const want = field.toLowerCase();
  for (const label of aside.querySelectorAll<HTMLElement>('.drawing-editor__field-label')) {
    const text = (label.textContent ?? '').trim().toLowerCase();
    if (text === want || text.startsWith(`${want} `) || text.startsWith(`${want}(`)) return label.parentElement;
  }
  return want === 'name' ? aside.querySelector<HTMLElement>('.drawing-editor__title') : null;
}

/**
 * The editor surface — BRIEF.md "Under the bar": "The editor is closed
 * unless something is selected. Where a board has nothing selected, there
 * is no right panel at all." `Shell` only mounts this when its `editor`
 * prop is not `null`, so absence from the DOM is the caller not rendering
 * it, not this component hiding itself.
 *
 * The notices sit directly under the row they are about, or at the panel's top when that row is
 * not on show, so they are never below the fold.
 */
export function Editor({ children, notices, noticeField }: EditorProps) {
  const aside = useRef<HTMLElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const root = aside.current;
    if (root == null || noticeField == null) {
      setHost(null);
      return;
    }
    const find = () => {
      const row = rowFor(root, noticeField);
      if (row == null) return setHost(null);
      let h = row.querySelector<HTMLElement>(':scope > .shell-editor__notices--field');
      if (h == null) {
        h = document.createElement('div');
        h.className = HOST_CLASS;
        row.appendChild(h);
      }
      setHost((cur) => (cur === h ? cur : h));
    };
    find();
    const watch = new MutationObserver(find);
    watch.observe(root, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      root.querySelectorAll('.shell-editor__notices--field').forEach((n) => n.remove());
    };
  }, [noticeField]);

  // Bring a newly shown notice into view if it is not.
  const shown = notices != null;
  useEffect(() => {
    const here = host ?? aside.current?.querySelector<HTMLElement>(':scope > .shell-editor__notices');
    if (shown && noticeField != null && typeof here?.scrollIntoView === 'function') here.scrollIntoView({ block: 'nearest' });
  }, [host, shown, noticeField]);

  return (
    <aside className="shell-editor" aria-label="Editor" ref={aside}>
      {shown && host == null && <div className="shell-editor__notices">{notices}</div>}
      {children}
      {shown && host != null && createPortal(notices, host)}
    </aside>
  );
}

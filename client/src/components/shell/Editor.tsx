import type { ReactNode } from 'react';

export interface EditorProps {
  children: ReactNode;
}

/**
 * The editor surface — BRIEF.md "Under the bar": "The editor is closed
 * unless something is selected. Where a board has nothing selected, there
 * is no right panel at all." `Shell` only mounts this when its `editor`
 * prop is not `null`, so absence from the DOM is the caller not rendering
 * it, not this component hiding itself.
 */
export function Editor({ children }: EditorProps) {
  return (
    <aside className="shell-editor" aria-label="Editor">
      {children}
    </aside>
  );
}

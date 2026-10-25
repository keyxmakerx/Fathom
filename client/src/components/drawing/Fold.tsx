// r30-device: a section of the device panel folded to one line, its heading on the left and what
// it holds on the right, opened by a click. Device and Location stay open; the rest fold.

import type { ReactNode } from 'react';

export function Fold({ title, summary, testId, children }: { title: string; summary?: ReactNode; testId?: string; children: ReactNode }) {
  return (
    <details className="drawing-editor__fold" data-testid={testId}>
      <summary className="drawing-editor__fold-head">
        <span className="drawing-editor__fold-title">{title}</span>
        {summary != null ? <span className="drawing-editor__fold-summary">{summary}</span> : null}
      </summary>
      <div className="drawing-editor__fold-body">{children}</div>
    </details>
  );
}

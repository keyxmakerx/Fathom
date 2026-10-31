// Sign-off rua-ui-audit: the reasons a suggestion card gives for what it leaves, folded into one line
// once there are more than a few, so 12 paragraphs never sit between the rows and the Add button.
import type { JSX } from 'react';

const OPEN_UP_TO = 2;

export function Reasons({ lines, summary }: { lines: readonly { key: string; text: string }[]; summary: string }): JSX.Element | null {
  if (lines.length === 0) return null;
  if (lines.length <= OPEN_UP_TO) {
    return (
      <>
        {lines.map((l) => (
          <p key={l.key} className="paste-card__note suggest-card__why">{l.text}</p>
        ))}
      </>
    );
  }
  return (
    <details className="suggest-card__reasons">
      <summary className="paste-card__note suggest-card__why">{summary}</summary>
      {lines.map((l) => (
        <p key={l.key} className="paste-card__note suggest-card__why">{l.text}</p>
      ))}
    </details>
  );
}

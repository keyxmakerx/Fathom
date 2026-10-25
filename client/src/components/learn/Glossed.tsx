// A line of Why? text with its glossary words underlined (card nu-words A). Pressing a word opens its definition under
// the line, in the flow of the card, so a narrow panel never clips it; pressing it again or Escape closes it.
import { useMemo, useState } from 'react';
import type { JSX } from 'react';

import { useLearn } from './context';
import { glossPieces, type GlossaryEntry } from './glossary';
import './glossary.css';

/** `learnMore` opens an explainer; it defaults to the Learn library of the design the card sits in. */
export function Glossed({ text, learnMore }: { text: string; learnMore?: (explainerId: string) => void }): JSX.Element {
  const learn = useLearn();
  learnMore ??= learn?.openExplainer;
  const pieces = useMemo(() => glossPieces(text), [text]);
  const [open, setOpen] = useState<GlossaryEntry | null>(null);
  return (
    <>
      {pieces.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <button
            key={i}
            type="button"
            className="gloss"
            aria-expanded={open === p.entry}
            onClick={() => setOpen((o) => (o === p.entry ? null : p.entry))}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && open != null) {
                e.stopPropagation();
                setOpen(null);
              }
            }}
          >
            {p.text}
          </button>
        ),
      )}
      {open != null && (
        <span className="gloss-def" role="note" data-testid="gloss-def">
          <span className="gloss-def__term">{open.term === 'vlan' ? 'VLAN' : open.term}</span> {open.definition}
          {open.explainer !== undefined && learnMore != null && (
            <>
              {' '}
              <button type="button" className="gloss" onClick={() => learnMore(open.explainer!)}>
                Learn more
              </button>
            </>
          )}
        </span>
      )}
    </>
  );
}

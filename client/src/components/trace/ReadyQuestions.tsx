// What a sample offers once open: "Try a question" (card nu-vlan A), the questions it was made to answer, each one
// click from a trace; and on the practice lab (card nu-why A), a note that sends the person to Checks.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { ReadyQuestion } from "../home/sampleQuestions";

/** The card sits over the top left of the drawing, so it folds to its title row once the person clicks on the
 * drawing (the card itself, and a Diagram look, start folded when `folded` says so). Show opens it again. */
export function ReadyQuestions({
  questions,
  onAsk,
  folded = false,
}: {
  questions: readonly ReadyQuestion[];
  onAsk: (q: ReadyQuestion) => void;
  folded?: boolean;
}): JSX.Element | null {
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(!folded);
  const card = useRef<HTMLElement>(null);
  useEffect(() => setOpen(!folded), [folded]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (
        card.current != null &&
        e.target instanceof Node &&
        !card.current.contains(e.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (hidden || questions.length === 0) return null;
  return (
    <aside
      ref={card}
      className={
        open ? "trace-questions" : "trace-questions trace-questions--folded"
      }
      aria-label="Try a question"
      data-testid="ready-questions"
    >
      <div className="trace-panel__head">
        <span className="trace-questions__title">Try a question</span>
        <span className="trace-questions__actions">
          {open ? null : (
            <button
              type="button"
              className="trace-link"
              onClick={() => setOpen(true)}
              data-testid="ready-questions-show"
            >
              Show
            </button>
          )}
          <button
            type="button"
            className="trace-link"
            onClick={() => setHidden(true)}
          >
            Hide
          </button>
        </span>
      </div>
      {open ? (
        <>
          <ul className="trace-suggest">
            {questions.map((q) => (
              <li key={q.ask}>
                <button
                  type="button"
                  className="trace-link"
                  onClick={() => onAsk(q)}
                >
                  {q.ask}
                </button>
              </li>
            ))}
          </ul>
          <p className="trace-muted trace-questions__hint">
            Each one traces the path and shows what the devices on it read.
          </p>
        </>
      ) : null}
    </aside>
  );
}

/** On the practice lab (card nu-why A): how many mistakes are hidden, and the way to Checks, which finds them. */
export function PracticeNote({
  count,
  onOpenChecks,
}: {
  count: number;
  onOpenChecks: () => void;
}): JSX.Element | null {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <aside
      className="trace-questions"
      aria-label="Practice home lab"
      data-testid="practice-note"
    >
      <div className="trace-panel__head">
        <span className="trace-questions__title">Practice home lab</span>
        <button
          type="button"
          className="trace-link"
          onClick={() => setHidden(true)}
        >
          Hide
        </button>
      </div>
      <p className="trace-questions__hint trace-questions__lead">
        {count === 1 ? "One mistake is" : `${count} mistakes are`} hidden in
        this network. Checks finds them; open each Why? to learn what went wrong
        and how to fix it. Your own designs are not touched.
      </p>
      <button type="button" className="trace-link" onClick={onOpenChecks}>
        Open Checks
      </button>
    </aside>
  );
}

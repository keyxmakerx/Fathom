// What a sample offers once open: "Try a question" (card nu-vlan A), the questions it was made to answer, each one
// click from a trace; and on the practice lab (card nu-why A), a note that sends the person to Checks.
import { useState } from 'react';
import type { JSX } from 'react';

import type { ReadyQuestion } from '../home/sampleQuestions';

export function ReadyQuestions({ questions, onAsk }: { questions: readonly ReadyQuestion[]; onAsk: (q: ReadyQuestion) => void }): JSX.Element | null {
  const [hidden, setHidden] = useState(false);
  if (hidden || questions.length === 0) return null;
  return (
    <aside className="trace-questions" aria-label="Try a question" data-testid="ready-questions">
      <div className="trace-panel__head">
        <span className="trace-questions__title">Try a question</span>
        <button type="button" className="trace-link" onClick={() => setHidden(true)}>
          Hide
        </button>
      </div>
      <ul className="trace-suggest">
        {questions.map((q) => (
          <li key={q.ask}>
            <button type="button" className="trace-link" onClick={() => onAsk(q)}>
              {q.ask}
            </button>
          </li>
        ))}
      </ul>
      <p className="trace-muted trace-questions__hint">Each one traces the path and shows what the devices on it read.</p>
    </aside>
  );
}

/** On the practice lab (card nu-why A): how many mistakes are hidden, and the way to Checks, which finds them. */
export function PracticeNote({ count, onOpenChecks }: { count: number; onOpenChecks: () => void }): JSX.Element | null {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <aside className="trace-questions" aria-label="Practice home lab" data-testid="practice-note">
      <div className="trace-panel__head">
        <span className="trace-questions__title">Practice home lab</span>
        <button type="button" className="trace-link" onClick={() => setHidden(true)}>
          Hide
        </button>
      </div>
      <p className="trace-questions__hint trace-questions__lead">
        {count === 1 ? 'One mistake is' : `${count} mistakes are`} hidden in this network. Checks finds them; open each Why? to learn what
        went wrong and how to fix it. Your own designs are not touched.
      </p>
      <button type="button" className="trace-link" onClick={onOpenChecks}>
        Open Checks
      </button>
    </aside>
  );
}

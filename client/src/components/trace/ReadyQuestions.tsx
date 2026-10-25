// "Try a question" (card nu-vlan A): on a sample, the questions it was made to answer, each one click from a trace.
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

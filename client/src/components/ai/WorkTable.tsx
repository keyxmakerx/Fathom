// What an AI may do, by kind of work (ADR-0077 amendment; sign-off card r47-ai-controls, approved 2026-10-27):
// one row per kind, Off, Ideas or Proposes. The same table is the admin's ceiling, the organisation's rules and
// one connection's own; a level above `cap` cannot be chosen. An AI never changes a design itself: Proposes means
// the change is shown on the canvas and waits for a person to accept it. The server decides it all again.

import './ai.css';

import { LEVELS, WORKS, type AiLevel, type AiWork, type WorkLevels } from '../../api/ai';

export const WORK_WORDS: Record<AiWork, { name: string; note: string }> = {
  design: { name: 'Edit the design', note: 'devices, ports, cables, racks, notes and stock' },
  plans: { name: 'Draft maintenance plans', note: 'a plan and its steps' },
  issues: { name: 'Troubleshoot', note: '“It’s down” issues, adding and answering steps' },
  doing: { name: 'Work through a plan', note: 'mark steps done or went differently, record how it went' },
};

export const LEVEL_WORDS: Record<AiLevel, string> = { off: 'Off', ideas: 'Ideas', propose: 'Proposes' };

const RANK: Record<AiLevel, number> = { off: 0, ideas: 1, propose: 2 };

/** The stricter of two levels. */
export const lower = (a: AiLevel, b: AiLevel): AiLevel => (RANK[a] <= RANK[b] ? a : b);

/** Kind by kind, the stricter of the two. */
export function lowerAll(a: WorkLevels, b: WorkLevels): WorkLevels {
  return { design: lower(a.design, b.design), plans: lower(a.plans, b.plans), issues: lower(a.issues, b.issues), doing: lower(a.doing, b.doing) };
}

/** One sentence: which kinds of work an AI may propose, which it may only send ideas for. */
export function workInWords(levels: WorkLevels): string {
  const at = (l: AiLevel) => WORKS.filter((w) => levels[w] === l).map((w) => WORK_WORDS[w].name.toLowerCase());
  const list = (words: string[]) => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
  const propose = at('propose');
  const ideas = at('ideas');
  if (propose.length === 0 && ideas.length === 0) return 'An AI may do nothing.';
  const parts = [
    ...(propose.length > 0 ? [`propose changes to ${list(propose)}`] : []),
    ...(ideas.length > 0 ? [`send ideas to ${list(ideas)}`] : []),
  ];
  return `An AI may ${parts.join(', and ')}.`;
}

export interface WorkTableProps {
  value: WorkLevels;
  /** The most each kind may be set to; a level above it is shown but cannot be chosen. */
  cap?: WorkLevels;
  /** Who set the cap, for the note on a capped row. */
  capWho?: string;
  onChange?: (next: WorkLevels) => void;
  testId?: string;
}

export function WorkTable({ value, cap, capWho, onChange, testId }: WorkTableProps) {
  return (
    <table className="ai-work" data-testid={testId}>
      <thead>
        <tr>
          <th scope="col">Work</th>
          {LEVELS.map((l) => (
            <th key={l} scope="col">
              {LEVEL_WORDS[l]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {WORKS.map((w) => {
          const most = cap?.[w] ?? 'propose';
          return (
            <tr key={w} data-work={w}>
              <th scope="row">
                {WORK_WORDS[w].name}
                <span className="ai-tick__why"> · {WORK_WORDS[w].note}</span>
                {cap && most !== 'propose' && capWho && (
                  <span className="ai-tick__why">
                    {' '}
                    · {capWho} allows at most {LEVEL_WORDS[most]}
                  </span>
                )}
              </th>
              {LEVELS.map((l) => (
                <td key={l}>
                  <input
                    type="radio"
                    name={`${testId ?? 'work'}-${w}`}
                    aria-label={`${WORK_WORDS[w].name}: ${LEVEL_WORDS[l]}`}
                    value={l}
                    checked={value[w] === l}
                    disabled={onChange == null || RANK[l] > RANK[most]}
                    onChange={() => onChange?.({ ...value, [w]: l })}
                  />
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

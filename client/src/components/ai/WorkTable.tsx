// What an AI may do, by kind of work (ADR-0077 amendment; sign-off card r47-ai-controls, approved 2026-10-27):
// one row per kind, Off, Ideas or Proposes. The same grid is the admin's ceiling, the organisation's rules and
// one connection's own, each showing the layers above it; a level above the strictest of them cannot be chosen.
// An AI never changes a design itself: Proposes means the change is shown on the canvas and waits for a person
// to accept it. The server decides it all again.

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

/** One layer above the table's own: the server's limit, or the organisation's rules. */
export interface WorkLayer {
  /** The column's name: "Server", "Organisation". */
  name: string;
  /** Who sets it, under the name: "set by the admin". */
  setBy: string;
  levels: WorkLevels;
  /** Opens the page where it is set, for someone who may. */
  onOpen?: () => void;
}

export interface WorkTableProps {
  value: WorkLevels;
  /** The layers above this one, top first, each shown read-only (card r54-ai-layers). */
  above?: WorkLayer[];
  /** This table's own column. */
  own?: { name: string; setBy: string };
  /** A further limit that is no layer's, such as a Steward narrowing someone else's connection. */
  cap?: WorkLevels;
  onChange?: (next: WorkLevels) => void;
  testId?: string;
}

/** The strictest of the layers above on one kind of work, and the first layer that sets it. */
function limitOf(above: WorkLayer[], w: AiWork): { most: AiLevel; by?: WorkLayer } {
  let most: AiLevel = 'propose';
  let by: WorkLayer | undefined;
  for (const layer of above) {
    if (RANK[layer.levels[w]] < RANK[most]) {
      most = layer.levels[w];
      by = layer;
    }
  }
  return { most, by };
}

/**
 * One grid for every layer: a read-only column for each layer above, this table's own column, and what is in
 * effect with the layer holding it back. The same grid sits in Admin, Steward › AI rules and on each connection,
 * so the three layers read the same way wherever they're set.
 */
export function WorkTable({ value, above = [], own = { name: 'Allowed', setBy: '' }, cap, onChange, testId }: WorkTableProps) {
  const layered = above.length > 0;
  return (
    <div className="ai-work-frame">
      <table className={layered ? 'ai-work ai-work--layered' : 'ai-work'} data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">Work</th>
            {above.map((layer) => (
              <th key={layer.name} scope="col" className="ai-work__layer">
                {layer.onOpen ? (
                  <button type="button" className="ai-work__open" onClick={layer.onOpen}>
                    {layer.name}
                  </button>
                ) : (
                  layer.name
                )}
                <span className="ai-work__who">{layer.setBy}</span>
              </th>
            ))}
            <th scope="col" className="ai-work__own">
              {own.name}
              {own.setBy && <span className="ai-work__who">{own.setBy}</span>}
            </th>
            {layered && <th scope="col">In effect</th>}
          </tr>
        </thead>
        <tbody>
          {WORKS.map((w) => {
            const limit = limitOf(above, w);
            const most = cap ? lower(limit.most, cap[w]) : limit.most;
            const now = lower(value[w], most);
            const held = limit.by != null && now === limit.most;
            return (
              <tr key={w} data-work={w}>
                <th scope="row">
                  {WORK_WORDS[w].name}
                  <span className="ai-tick__why"> · {WORK_WORDS[w].note}</span>
                </th>
                {above.map((layer) => (
                  <td key={layer.name} className="ai-work__layer" data-layer={layer.name}>
                    {LEVEL_WORDS[layer.levels[w]]}
                  </td>
                ))}
                <td className="ai-work__own" data-layer={own.name}>
                  <span className="ai-seg" role="radiogroup" aria-label={`${WORK_WORDS[w].name}: ${own.name}`}>
                    {LEVELS.map((l) => {
                      const beyond = RANK[l] > RANK[most];
                      return (
                        <label
                          key={l}
                          className={beyond ? 'ai-seg__opt ai-seg__opt--beyond' : 'ai-seg__opt'}
                          title={beyond && limit.by && RANK[l] > RANK[limit.most] ? `The ${limit.by.name.toLowerCase()} allows at most ${LEVEL_WORDS[limit.most]}` : undefined}
                        >
                          <input
                            type="radio"
                            name={`${testId ?? 'work'}-${w}`}
                            aria-label={`${WORK_WORDS[w].name}: ${LEVEL_WORDS[l]}`}
                            value={l}
                            checked={value[w] === l}
                            disabled={onChange == null || beyond}
                            onChange={() => onChange?.({ ...value, [w]: l })}
                          />
                          <span>{LEVEL_WORDS[l]}</span>
                        </label>
                      );
                    })}
                  </span>
                </td>
                {layered && (
                  <td className="ai-work__effect" data-layer="In effect">
                    <strong>{LEVEL_WORDS[now]}</strong>
                    {held && limit.by && <span className="ai-work__held">Limited by the {limit.by.name.toLowerCase()}</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

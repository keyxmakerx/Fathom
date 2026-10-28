// How much an AI connection may reach, at a glance (sign-off card r54-ai-layers): one word from what it
// sees, what it may do and which folders, after every layer is applied. A badge, never a control; the
// server decides each request on the levels themselves.

import { LEVELS, WORKS, type WorkLevels } from '../../api/ai';
import { lowerAll } from './WorkTable';

export type Access = 'safe' | 'medium' | 'critical' | 'full';

export const ACCESS_WORDS: Record<Access, { name: string; note: string }> = {
  safe: { name: 'Safe', note: 'Sees the layout only, and can only send ideas.' },
  medium: { name: 'Medium', note: 'Sees addresses, or proposes plans or troubleshooting. Never notes, never design changes.' },
  critical: { name: 'Critical', note: 'Reads notes, or proposes changes to the design.' },
  full: { name: 'Full', note: 'Reads notes and proposes changes to the design, plans and troubleshooting, in every folder.' },
};

/** The one word for a connection, from what is in effect for it. */
export function accessOf(sees: readonly string[], work: WorkLevels, everyFolder: boolean): Access {
  const notes = sees.includes('notes');
  const proposesAll = WORKS.filter((w) => w !== 'doing').every((w) => work[w] === 'propose');
  if (notes && proposesAll && everyFolder) return 'full';
  if (notes || work.design === 'propose') return 'critical';
  if (sees.includes('addresses') || WORKS.some((w) => work[w] === 'propose')) return 'medium';
  return 'safe';
}

/** What a key may do now, every layer applied, when the server did not say: the strictest of them all. */
export function workInEffect(...layers: WorkLevels[]): WorkLevels {
  return layers.reduce((a, b) => lowerAll(a, b), Object.fromEntries(WORKS.map((w) => [w, LEVELS[LEVELS.length - 1]])) as WorkLevels);
}

export function AccessBadge({ access, testId }: { access: Access; testId?: string }) {
  const { name, note } = ACCESS_WORDS[access];
  return (
    <span className={`ai-access ai-access--${access}`} title={note} aria-label={`${name} access: ${note}`} data-testid={testId}>
      {name}
    </span>
  );
}

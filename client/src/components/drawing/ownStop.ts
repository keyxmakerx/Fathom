// r159: a device on a wall, a desk or a ceiling takes a Tab stop of its own, as a thing on a shelf already did
// (its box is a button). It comes right after its wall, left to right (`leftToRight`), and Enter selects it
// as a press does. Its ports keep theirs, which come once they are drawn (`SurfaceNode.tsx`).
//
// It is named and described as React Flow names a node (`thingSays.ts`, `nodeKey.ts`): a group, its name and what
// it is, then "Press Enter to select it." from the canvas's own description.

import { useStore } from '@xyflow/react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { enterSelectsHere } from './nodeKey';
import { fixtureSays } from './thingSays';

type Fixture = { id: string; kind: 'chassis' | 'passive'; label: string; form: string | null; chassis?: { role?: string | null } | undefined };

/** The things on a wall in the order Tab visits them: left to right, and at one place from the top down. A thing not
 * measured across goes last, in the order the wall holds them. */
export function leftToRight<T extends { xMm: number | null; yMm: number | null }>(fixtures: readonly T[]): T[] {
  const across = (a: T, b: T): number => {
    if (a.xMm == null || b.xMm == null) return Number(a.xMm == null) - Number(b.xMm == null);
    return a.xMm - b.xMm || (b.yMm ?? 0) - (a.yMm ?? 0);
  };
  return fixtures
    .map((f, i) => ({ f, i }))
    .sort((a, b) => across(a.f, b.f) || a.i - b.i)
    .map(({ f }) => f);
}

/** The kind read after its name: a device, or a passive thing by its form ("outlet", "board"). */
export function fixtureKindSaid(fixture: Pick<Fixture, 'kind' | 'form'>): string {
  if (fixture.kind === 'chassis') return 'device';
  return (fixture.form ?? '').replace(/_/g, ' ').trim() || 'thing';
}

/** What a thing on a wall spreads on the element that takes its press: its Tab stop, its words and its Enter. */
export function useOwnStop(fixture: Fixture, onSelect: (id: string) => void) {
  const rfId = useStore((s) => s.rfId);
  return {
    tabIndex: 0,
    role: 'group',
    'aria-label': fixtureSays(fixture),
    'aria-roledescription': fixtureKindSaid(fixture),
    'aria-describedby': `react-flow__node-desc-${rfId}`,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!enterSelectsHere(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect(fixture.id);
    },
  } as const;
}

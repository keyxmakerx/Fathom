import { describe, expect, it } from 'vitest';

import { STEWARD_RAIL, shownRail, type StewardGroup } from './stewardRail';

describe('the Steward list (ADR-0088)', () => {
  it('shows today’s pages in their groups, and no heading for a group with nothing built', () => {
    const shown = shownRail({ waitingReady: true });
    expect(shown.map((g) => g.heading)).toEqual(['People', 'Estate', 'Passwords and AI']);
    expect(shown.flatMap((g) => g.entries.map((e) => e.page))).toEqual(['people', 'waiting', 'folders', 'firmware', 'passwords', 'ai', 'ai-rules']);
  });

  it('leaves Waiting for you out until its count has loaded', () => {
    expect(shownRail({ waitingReady: false })[0].entries.map((e) => e.page)).toEqual(['people']);
  });

  it('puts a page a thread has built in its fixed place', () => {
    const built: StewardGroup[] = STEWARD_RAIL.map((g) => ({ ...g, entries: g.entries.map((e) => (e.page === 'teams' || e.page === 'mail' ? { ...e, built: true } : e)) }));
    const shown = shownRail({ waitingReady: true }, built);
    expect(shown[0].entries.map((e) => e.label)).toEqual(['People', 'Teams', 'Waiting for you']);
    expect(shown.map((g) => g.heading)).toEqual(['People', 'Estate', 'Work', 'Passwords and AI']);
  });

  it('names every page once', () => {
    const pages = STEWARD_RAIL.flatMap((g) => g.entries.map((e) => e.page));
    expect(new Set(pages).size).toBe(pages.length);
  });
});

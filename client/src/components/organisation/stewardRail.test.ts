import { describe, expect, it } from 'vitest';

import { STEWARD_RAIL, shownRail, type StewardGroup } from './stewardRail';

describe('the Steward list (ADR-0088)', () => {
  it('shows today’s pages in their groups, with the unfinished ones listed and marked', () => {
    const shown = shownRail({ waitingReady: true });
    expect(shown.map((g) => g.heading)).toEqual(['People', 'Sites and devices', 'Work', 'Passwords and AI']);
    expect(shown.flatMap((g) => g.entries.map((e) => e.page))).toEqual(['people', 'teams', 'waiting', 'folders', 'firmware', 'device-reading', 'order-types', 'ip-plan', 'mail', 'passwords', 'ai', 'ai-rules']);
  });

  it('hides nothing in the alpha: orders and mail are listed and carry the Not finished mark; the IP plan is finished', () => {
    const entries = shownRail({ waitingReady: true }).flatMap((g) => g.entries);
    expect(entries.filter((e) => e.notFinished).map((e) => e.page)).toEqual(['order-types', 'mail']);
  });

  it('leaves Waiting for you out until its count has loaded', () => {
    expect(shownRail({ waitingReady: false })[0].entries.map((e) => e.page)).toEqual(['people', 'teams']);
  });

  it('puts a page a thread has built in its fixed place', () => {
    const built: StewardGroup[] = STEWARD_RAIL.map((g) => ({ ...g, entries: g.entries.map((e) => (e.page === 'teams' ? { ...e, built: true } : e)) }));
    const shown = shownRail({ waitingReady: true }, built);
    expect(shown[0].entries.map((e) => e.label)).toEqual(['People', 'Teams', 'Waiting for you']);
    expect(shown.map((g) => g.heading)).toEqual(['People', 'Sites and devices', 'Work', 'Passwords and AI']);
  });

  it('names every page once', () => {
    const pages = STEWARD_RAIL.flatMap((g) => g.entries.map((e) => e.page));
    expect(new Set(pages).size).toBe(pages.length);
  });
});

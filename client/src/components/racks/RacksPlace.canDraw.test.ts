import { describe, expect, it } from 'vitest';

import { canDrawFor } from './RacksPlace';

// ADR-0052 §5, this session's brief item 1: "canDraw = capability !== 'read'."
// `canDrawFor` is the pure part `applyDocChange`/`Drawing`'s `canDraw`/the
// editor's `onEdit` all read off the same call — tested directly, the same
// "no Document, no React" shape `refusalFor`'s own tests already use
// (`RacksPlace.edit.test.ts`).

describe('canDrawFor', () => {
  it('refuses draw for a "read" capability', () => {
    expect(canDrawFor('read')).toBe(false);
  });

  it('allows draw for "draw"', () => {
    expect(canDrawFor('draw')).toBe(true);
  });

  it('allows draw for "steward"', () => {
    expect(canDrawFor('steward')).toBe(true);
  });

  it('fails open (allows draw) for a capability this client does not recognise — never a guessed refusal', () => {
    expect(canDrawFor('some-future-capability')).toBe(true);
  });
});

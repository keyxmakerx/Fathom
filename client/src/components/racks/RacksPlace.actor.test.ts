import { describe, expect, it } from 'vitest';

import { actorOpts } from './RacksPlace';

// The defect this guards: `handlePlace`/`handleMove` (drag-and-drop —
// creating the first premises/rack, placing or moving a chassis) once
// dispatched every command with no `Actor` opts at all, so
// `document/commands.ts`'s own `resolve` fell back to `LOCAL_ACTOR`
// (`document/model.ts`) even while a real account was signed in — the
// driven proof (`scripts/drive-first-design.mjs`) showed every Trail row
// for "create premises"/"create rack"/place a device reading `'local'`
// (`components/racks/trail.ts`'s `whoLabel`), which ADR-0053 then refuses
// to let anyone undo. `actorOpts` is the one place that decision is made
// now — tested directly here, the same way this file already tests
// `refusalFor`/`canDrawFor`'s pure logic.

describe('actorOpts', () => {
  it('stamps the signed-in account as the actor', () => {
    expect(actorOpts('account:01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({
      actor: 'account:01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
  });

  it('omits an actor when nobody is signed in — the one honest case for the command\'s own LOCAL_ACTOR default', () => {
    expect(actorOpts(null)).toBeUndefined();
  });
});

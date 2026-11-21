import { describe, expect, it } from 'vitest';

import { focusToAnswer } from './focusRequest';

describe('a request to show a thing on the canvas', () => {
  const asked = { kind: 'chassis', id: 'router-1' };

  it('is answered when the design is here', () => {
    expect(focusToAnswer(asked, true, null)).toBe(asked);
  });

  it('waits for the design when it came first', () => {
    expect(focusToAnswer(asked, false, null)).toBeNull();
    expect(focusToAnswer(asked, true, null)).toBe(asked);
  });

  it('is answered once: a change to the design is not a new request', () => {
    // The caller asks again after every change to the design, with the same request in hand.
    expect(focusToAnswer(asked, true, asked)).toBeNull();
  });

  it('is answered again when the same thing is asked for again', () => {
    const again = { ...asked };
    expect(focusToAnswer(again, true, asked)).toBe(again);
  });

  it('is nothing when nothing was asked', () => {
    expect(focusToAnswer(null, true, null)).toBeNull();
    expect(focusToAnswer(undefined, true, asked)).toBeNull();
  });
});

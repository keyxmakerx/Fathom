import { describe, expect, it } from 'vitest';

import { ApiRefusal } from '../../api/errors';
import { describeError } from './useDesignSession';

// ADR-0054 §1: "the refusal wash names the change" — the server's own
// sentence, exactly. `describeError` is the one function standing between
// the `SaveQueue`'s refusal and `saveRefusal`, the string the save-refusal
// wash renders verbatim (`RacksPlace.tsx`'s `racks-place__refusal`,
// `InventoryPlace.tsx`'s `inventory-place__refusal`); this is the guard that
// a conflict's sentence reaches the wash unrewritten and unwrapped — no
// "Try again in Ns." tacked on (that suffix is the rate limiter's own,
// `retryAfterSeconds` set only there, never on a conflict), no rephrasing.
describe('describeError (the save-refusal wash text)', () => {
  it('surfaces a conflict refusal’s sentence verbatim, with nothing added', () => {
    const sentence = 'design-1 is at version 6, not the 5 this save was based on';
    const refusal = new ApiRefusal(409, sentence, null);
    expect(describeError(refusal)).toBe(sentence);
  });

  it('still appends the retry suffix for a rate-limit refusal, unaffected by the conflict case', () => {
    const refusal = new ApiRefusal(429, 'too many requests', 3);
    expect(describeError(refusal)).toBe('too many requests Try again in 3s.');
  });
});

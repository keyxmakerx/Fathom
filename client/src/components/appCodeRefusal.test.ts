import { describe, expect, it } from 'vitest';

import { ApiRefusal } from '../api/errors';
import { describeAppCodeRefusal } from './appCodeRefusal';

describe('the app-code refusal on the account screen', () => {
  it('shows the sentence a 409 carries, verbatim', () => {
    const sentence = 'this account already has an app code; replacing one is a recovery';
    expect(describeAppCodeRefusal(new ApiRefusal(409, sentence, null))).toBe(sentence);
  });

  it('says what 409 means here when the 409 carries no sentence', () => {
    expect(describeAppCodeRefusal(new ApiRefusal(409, 'refused', null))).toMatch(
      /already has an app code/,
    );
    expect(describeAppCodeRefusal(new ApiRefusal(409, '', null))).toMatch(/already has an app code/);
  });

  it('leaves every other refusal exactly as it reads today', () => {
    // The uniform sentence `api.rs` fixes for a refused credential act on
    // the server binary this was built against. Not interpreted, not
    // rewritten, and not turned into a guess about which check failed.
    expect(describeAppCodeRefusal(new ApiRefusal(403, 'sign-in refused', null))).toBe(
      'sign-in refused',
    );
    expect(describeAppCodeRefusal(new ApiRefusal(429, 'too many attempts', 30))).toBe(
      'too many attempts Try again in 30s.',
    );
  });

  it('does not pretend to know what a non-refusal was', () => {
    expect(describeAppCodeRefusal(new Error('the network went away'))).toBe(
      'That did not complete. See the console for detail.',
    );
  });
});

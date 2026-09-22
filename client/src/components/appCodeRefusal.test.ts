import { describe, expect, it } from 'vitest';

import { ApiRefusal } from '../api/errors';
import { describeAppCodeRefusal } from './appCodeRefusal';

// **The sentences fed in here are the server's real ones, copied off the
// wire.** The first cut of this test made one up, which is CLAUDE.md rule 2's
// shape of mistake — a gate tested against what the checker needed rather
// than against what the other side actually sends. Both of the server's
// wordings are below: the one `credentials.rs` sends today, and the one
// ADR-0056 decision 4 renames it to. Neither may reach a screen.

/** `CredentialError::TotpAlreadyEnrolled`, `credentials.rs`, as it reads on
 * the build this was written against. */
const SERVER_409_TODAY =
  'this account already has a confirmed app code. Replacing a live second factor from inside a session is not a form; it is a recovery, and it goes through the host command ADR-0055 decision 8 names';

/** The same refusal after the rename ADR-0056 decision 4 asks for. */
const SERVER_409_RENAMED =
  'this account already has a confirmed authenticator. Replacing a live second factor from inside a session is not a form; it is a recovery, and it goes through the host command ADR-0055 decision 8 names';

describe('the authenticator refusal on the account screen', () => {
  it('maps a 409 by status, and prints no sentence the server sent', () => {
    for (const body of [SERVER_409_TODAY, SERVER_409_RENAMED, 'refused', '']) {
      const shown = describeAppCodeRefusal(new ApiRefusal(409, body, null));
      expect(shown).toBe(
        'This account already has a confirmed authenticator. Replacing it is a recovery, done from the host with fathom-server recover-operator.',
      );
      // Not a substring of it, not a suffix on it, not a fallback when the
      // body looks reasonable: the body goes nowhere.
      expect(shown).not.toContain('ADR-0055');
      expect(shown).not.toContain('from inside a session');
    }
  });

  it('never says "app code" to a person, whatever the server said', () => {
    // ADR-0056 decision 4: the name leaves every user-facing string. The
    // server's own sentence still carries it today, which is exactly why
    // this client does not relay it.
    expect(SERVER_409_TODAY).toContain('app code');
    for (const body of [SERVER_409_TODAY, SERVER_409_RENAMED, 'refused', '']) {
      expect(describeAppCodeRefusal(new ApiRefusal(409, body, null)).toLowerCase()).not.toContain(
        'app code',
      );
    }
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

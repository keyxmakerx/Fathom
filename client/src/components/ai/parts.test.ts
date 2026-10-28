import { describe, expect, it } from 'vitest';

import { ApiRefusal } from '../../api/errors';
import { aiError } from './parts';

describe('aiError', () => {
  it("gives the server's own sentence, capitalised", () => {
    expect(aiError(new ApiRefusal(422, 'that change was refused: a port is on one chassis', null))).toBe(
      'That change was refused: a port is on one chassis',
    );
  });

  it('says a server fault changed nothing and where its cause is, not "refused"', () => {
    const text = aiError(new ApiRefusal(500, 'refused', null));
    expect(text).toContain('changed nothing');
    expect(text).toContain("server's log");
  });

  it('keeps the plain refusal for a bare refusal that is not a fault', () => {
    expect(aiError(new ApiRefusal(403, 'refused', null))).toBe('Fathom refused that.');
  });
});

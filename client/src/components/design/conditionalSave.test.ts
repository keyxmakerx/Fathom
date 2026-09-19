import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/payload', () => ({
  saveDesign: vi.fn(),
}));

import { ApiRefusal } from '../../api/errors';
import { saveDesign } from '../../api/payload';
import { ConditionalSave } from './conditionalSave';

const mockedSaveDesign = vi.mocked(saveDesign);

describe('ConditionalSave', () => {
  it('sends the opened version as the first save’s base', async () => {
    mockedSaveDesign.mockResolvedValueOnce(6);
    const conditionalSave = new ConditionalSave(5);
    await conditionalSave.save('org-1', 'design-1', new Uint8Array());
    expect(mockedSaveDesign).toHaveBeenCalledWith('org-1', 'design-1', expect.any(Uint8Array), 5);
  });

  it('a 200 advances the base to the version the server just wrote', async () => {
    mockedSaveDesign.mockResolvedValueOnce(6);
    const conditionalSave = new ConditionalSave(5);
    const version = await conditionalSave.save('org-1', 'design-1', new Uint8Array());
    expect(version).toBe(6);
    expect(conditionalSave.currentBase).toBe(6);
  });

  it('a 409 leaves the base exactly where it was', async () => {
    mockedSaveDesign.mockRejectedValueOnce(
      new ApiRefusal(409, 'design-1 is at version 6, not 5', null),
    );
    const conditionalSave = new ConditionalSave(5);
    await expect(conditionalSave.save('org-1', 'design-1', new Uint8Array())).rejects.toBeInstanceOf(
      ApiRefusal,
    );
    expect(conditionalSave.currentBase).toBe(5);
  });

  it('a save after a 409 sends the same old base again, and is refused the same way', async () => {
    mockedSaveDesign.mockRejectedValueOnce(
      new ApiRefusal(409, 'design-1 is at version 6, not 5', null),
    );
    const conditionalSave = new ConditionalSave(5);
    await expect(conditionalSave.save('org-1', 'design-1', new Uint8Array())).rejects.toBeInstanceOf(
      ApiRefusal,
    );

    mockedSaveDesign.mockRejectedValueOnce(
      new ApiRefusal(409, 'design-1 is at version 6, not 5', null),
    );
    await expect(conditionalSave.save('org-1', 'design-1', new Uint8Array())).rejects.toBeInstanceOf(
      ApiRefusal,
    );

    expect(mockedSaveDesign).toHaveBeenNthCalledWith(1, 'org-1', 'design-1', expect.any(Uint8Array), 5);
    expect(mockedSaveDesign).toHaveBeenNthCalledWith(2, 'org-1', 'design-1', expect.any(Uint8Array), 5);
    expect(conditionalSave.currentBase).toBe(5);
  });

  it('never reads the server’s current version off a refusal, even when one is present', async () => {
    // ADR-0054 §1: "never adopt the server's current version." The refusal
    // here carries no version at all in its message or fields beyond
    // status/message/retryAfterSeconds — this test's own guard that a future
    // change cannot smuggle version-adoption in by reading some new field
    // off the refusal without this test noticing the base move.
    mockedSaveDesign.mockRejectedValueOnce(new ApiRefusal(409, 'design-1 is at version 99, not 5', null));
    const conditionalSave = new ConditionalSave(5);
    await expect(conditionalSave.save('org-1', 'design-1', new Uint8Array())).rejects.toBeInstanceOf(
      ApiRefusal,
    );
    expect(conditionalSave.currentBase).toBe(5);
    expect(conditionalSave.currentBase).not.toBe(99);
  });
});

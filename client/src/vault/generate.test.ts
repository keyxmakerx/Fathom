import { describe, expect, it } from 'vitest';

import { generatePassword } from './generate';

describe('generatePassword', () => {
  it('makes 20 characters with every kind and no look-alikes', () => {
    for (let i = 0; i < 200; i += 1) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[2-9]/);
      expect(p).toMatch(/[-_.!@#%+=?]/);
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });

  it('does not repeat', () => {
    expect(new Set(Array.from({ length: 100 }, () => generatePassword())).size).toBe(100);
  });
});

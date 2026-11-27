import { describe, expect, it } from 'vitest';

import { isPickedPort } from './PortPick';

describe('a pressed port is marked (r159)', () => {
  it('only the selected port, and only when a port is what is selected', () => {
    expect(isPickedPort({ kind: 'port', id: 'p1' }, 'p1')).toBe(true);
    expect(isPickedPort({ kind: 'port', id: 'p1' }, 'p2')).toBe(false);
    expect(isPickedPort({ kind: 'cable', id: 'p1' }, 'p1')).toBe(false);
    expect(isPickedPort(null, 'p1')).toBe(false);
  });
});

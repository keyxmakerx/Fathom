import { afterEach, describe, expect, it, vi } from 'vitest';

import { OWN_PRESS_EVENT, ownPress } from './ownPress';

afterEach(() => vi.unstubAllGlobals());

describe('ownPress', () => {
  it('stops the click where it landed and sends it on by name', () => {
    const sent: { type: string; detail: unknown }[] = [];
    vi.stubGlobal(
      'CustomEvent',
      class {
        readonly type: string;
        readonly detail: unknown;
        constructor(type: string, init: { detail: unknown }) {
          this.type = type;
          this.detail = init.detail;
        }
      },
    );
    vi.stubGlobal('window', { dispatchEvent: (e: { type: string; detail: unknown }) => sent.push({ type: e.type, detail: e.detail }) });
    const click = { clientX: 3, clientY: 4 } as MouseEvent;
    const stopPropagation = vi.fn();

    ownPress({ stopPropagation, nativeEvent: click });

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ type: OWN_PRESS_EVENT, detail: click }]);
  });
});

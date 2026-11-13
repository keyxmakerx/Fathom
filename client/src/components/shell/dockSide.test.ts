// A head that sits straight in a side slot (AI ideas) must keep its own height. The slot gives every
// child `flex: 1 1 auto`; without its own exception the head took a share of the spare height, and
// after an idea was accepted the "AI ideas" head sat hundreds of pixels down the panel (2026-11-13).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const dock = readFileSync(fileURLToPath(new URL('../../styles/dock.css', import.meta.url)), 'utf8');

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string | null {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('a side slot', () => {
  it('lets its children fill it', () => {
    expect(rule(dock, '.dock-panel > .dock-side > *')).toMatch(/flex:\s*1 1 auto/);
  });

  it('keeps a panel head that sits straight in it its own height', () => {
    expect(rule(dock, '.dock-panel > .dock-side > .panel-head')).toMatch(/flex:\s*none/);
  });
});

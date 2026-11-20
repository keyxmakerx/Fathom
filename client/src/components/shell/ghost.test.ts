import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GHOST_KEPT_STATE, GHOST_MS, GHOST_STRIPPED, ghostDrops, ghostLife } from './ghost';

const TOKENS = readFileSync(fileURLToPath(new URL('../../../../design/tokens.css', import.meta.url)), 'utf8');
const BASE = readFileSync(fileURLToPath(new URL('../../styles/base.css', import.meta.url)), 'utf8');
// Every stylesheet the client ships: the glob names them, and each is read from disk (a test is handed no CSS).
const SHEET_PATHS = Object.keys(import.meta.glob('../../**/*.css'));

/** The stylesheets with their comments taken out. */
function stylesheets(): Array<{ file: string; css: string }> {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  return [...SHEET_PATHS.map((file) => ({ file, css: read(file) })), { file: 'design/tokens.css', css: TOKENS }].map(({ file, css }) => ({
    file,
    css: css.replace(/\/\*[\s\S]*?\*\//g, ''),
  }));
}

/** The attributes the stylesheets select on, each with the files that do. */
function selectedAttributes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { file, css } of stylesheets()) {
    // Selectors only: what stands before each `{`, not the declarations inside the braces.
    for (const selector of css.match(/[^{}]+(?=\{)/g) ?? []) {
      for (const match of selector.matchAll(/\[\s*([a-zA-Z][\w-]*)/g)) {
        const name = (match[1] ?? '').toLowerCase();
        found.set(name, [...(found.get(name) ?? []), file]);
      }
    }
  }
  return found;
}

describe('the copy a closing menu leaves', () => {
  it('keeps nothing that names it, finds it or focuses it', () => {
    for (const name of ['id', 'role', 'tabindex', 'title', 'href', 'name', 'data-testid', 'data-hint', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-modal']) {
      expect(ghostDrops(name), name).toBe(true);
    }
  });

  it('reads an attribute name whatever its case', () => {
    expect(ghostDrops('tabIndex')).toBe(true);
    expect(ghostDrops('ARIA-LABEL')).toBe(true);
  });

  it('keeps what draws it', () => {
    for (const name of ['class', 'style', 'type', 'disabled', 'value', 'placeholder', 'data-side', 'data-state', 'width', 'height', 'viewBox', 'd', 'src', ...GHOST_KEPT_STATE]) {
      expect(ghostDrops(name), name).toBe(false);
    }
  });

  it('keeps an id or a link inside a picture, where it is part of the drawing', () => {
    expect(ghostDrops('id', true)).toBe(false);
    expect(ghostDrops('href', true)).toBe(false);
    expect(ghostDrops('aria-label', true)).toBe(true);
    expect(ghostDrops('data-testid', true)).toBe(true);
  });

  it('lists each attribute once, in lower case, and keeps only states', () => {
    expect(new Set(GHOST_STRIPPED).size).toBe(GHOST_STRIPPED.length);
    for (const name of [...GHOST_STRIPPED, ...GHOST_KEPT_STATE]) expect(name).toBe(name.toLowerCase());
    for (const name of GHOST_KEPT_STATE) expect(name).toMatch(/^aria-(checked|current|disabled|expanded|pressed|selected)$/);
  });

  // The copy looks like the thing only while no stylesheet draws from something the copy has lost. A rule that
  // selects on a label, an id, a role or a test id would make a closing menu change shape as it fades.
  it('loses nothing a stylesheet draws from', () => {
    const lost = [...selectedAttributes()].filter(([name]) => ghostDrops(name)).map(([name, files]) => `[${name}] in ${[...new Set(files)].join(', ')}`);
    expect(lost).toEqual([]);
  });

  it('keeps no state that no stylesheet draws from', () => {
    const drawnFrom = selectedAttributes();
    for (const name of GHOST_KEPT_STATE) expect(drawnFrom.has(name), name).toBe(true);
  });

  it('goes in the time of the token its style names, a little faster than a menu arrives', () => {
    const ms = (token: string) => Number(new RegExp(`${token}:\\s*(\\d+)ms`).exec(TOKENS)?.[1]);
    expect(ms('--m-hover')).toBe(GHOST_MS);
    expect(ms('--m-pop')).toBeGreaterThan(GHOST_MS);
    expect(BASE).toMatch(/\[data-ghost\]\s*\{[^}]*var\(--m-hover\)/);
  });

  it('lasts as long as its own leaving animation, and never less than the usual time', () => {
    expect(ghostLife('0.12s')).toBe(120);
    expect(ghostLife('160ms')).toBe(160);
    expect(ghostLife('0.26s, 0.1s')).toBe(260);
    expect(ghostLife('0s')).toBe(GHOST_MS);
    expect(ghostLife('')).toBe(GHOST_MS);
  });

  it('is not drawn at all for someone who asked for less motion', () => {
    expect(BASE).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\[data-ghost\]\s*\{\s*display: none/);
  });

  // `[data-ghost] *` matches no ::before or ::after, so a mark drawn in one would arrive again as its menu left.
  it('holds still what a ::before or ::after draws, as it holds the rest', () => {
    const rule = /\[data-ghost\]::before,\s*\[data-ghost\]::after,\s*\[data-ghost\] \*::before,\s*\[data-ghost\] \*::after\s*\{([^}]*)\}/.exec(BASE)?.[1] ?? '';
    expect(rule).toMatch(/animation:\s*none\s*!important/);
    expect(rule).toMatch(/transition:\s*none\s*!important/);
  });
});

describe('the copy a closing sheet leaves', () => {
  const PALETTE = readFileSync(fileURLToPath(new URL('../../styles/palette.css', import.meta.url)), 'utf8');
  const frames = (name: string) => new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\})\\s*\\}`).exec(PALETTE)?.[1] ?? '';
  const step = (name: string, at: 'from' | 'to') => new RegExp(`${at}\\s*\\{([^}]*)\\}`).exec(frames(name))?.[1]?.replace(/\s+/g, ' ').trim();
  const rule = (selector: string) => PALETTE.split(`${selector} {`)[1]?.split('}')[0] ?? '';

  it('goes back the way the sheet came', () => {
    expect(step('float-sheet-out', 'to')).toBe('opacity: 0; transform: translateY(-8px) scale(0.985);');
    expect(step('float-sheet-out', 'to')).toBe(step('float-sheet-in', 'from'));
  });

  it('clears the wash behind it by its colour, so the sheet is not faded twice', () => {
    expect(step('float-scrim-out', 'to')).toBe('background-color: transparent;');
  });

  it('goes in the same time as a closing menu', () => {
    expect(rule('.float-scrim[data-ghost]')).toMatch(/float-scrim-out var\(--m-hover\b[^)]*\)[^;]*!important/);
    expect(rule('.float-scrim[data-ghost] > .float-sheet')).toMatch(/float-sheet-out var\(--m-hover\b[^)]*\)[^;]*!important/);
  });
});

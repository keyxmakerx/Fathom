// A dialog arrives the way a menu does: a sheet, a card or a panel fades and drops 4px into place, and a wash or a
// whole page laid over this one fades in. Each takes `--m-pop` on the one easing, stands still when the computer
// asks for reduced motion, and keeps nothing of the motion once it has arrived (`design/tokens.css`: a duration is
// a token, never a number at the call site, and every animated property has a reduced-motion answer).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sheet = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** What a selector's own rule declares: the first rule that names it alone, outside any `@media`. */
function ruleOf(css: string, selector: string): string {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`));
  return at < 0 ? '' : (css.slice(at).split('{')[1]?.split('}')[0] ?? '');
}

/** Everything inside the `@media` blocks of one kind. */
function inMedia(css: string, query: string): string {
  const out: string[] = [];
  for (let from = css.indexOf(`@media ${query}`); from >= 0; from = css.indexOf(`@media ${query}`, from + 1)) {
    let depth = 0;
    for (let i = css.indexOf('{', from); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && (depth -= 1) === 0) {
        out.push(css.slice(css.indexOf('{', from) + 1, i));
        break;
      }
    }
  }
  return out.join('\n');
}

const frames = (css: string, name: string): string => new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\})\\s*\\}`).exec(css)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

const FADE = 'fathom-fade-in';
const DROP = 'fathom-pop-in';

/** Every dialog that once cut in, the stylesheet it is drawn by, and how it arrives now. */
const ARRIVING: ReadonlyArray<{ what: string; file: string; selector: string; by: string }> = [
  { what: 'the wash behind a vault sheet', file: 'components/vault/vault.css', selector: '.vault-scrim', by: FADE },
  { what: 'a vault sheet', file: 'components/vault/vault.css', selector: '.vault-sheet', by: DROP },
  { what: "the wash behind Inventory's Paste rows", file: 'components/inventory/inventory.css', selector: '.inv-paste', by: FADE },
  { what: "Inventory's Paste rows", file: 'components/inventory/inventory.css', selector: '.inv-paste__box', by: DROP },
  { what: 'the wash behind the importer', file: 'components/import/import.css', selector: '.imp', by: FADE },
  { what: 'the importer', file: 'components/import/import.css', selector: '.imp__box', by: DROP },
  { what: 'Learn', file: 'components/learn/learn.css', selector: '.learn-overlay', by: FADE },
  { what: "the phone's scan sheet", file: 'components/phone/phone.css', selector: '.phone-scan', by: FADE },
  { what: 'the paste card', file: 'components/paste/paste.css', selector: '.paste-card', by: 'paste-card-in' },
  { what: 'the Print panel', file: 'print/print.css', selector: '.print-panel', by: DROP },
  { what: 'the print preview', file: 'print/print.css', selector: '.print-preview', by: FADE },
  { what: 'the labels preview', file: 'print/labels.css', selector: '.labels-preview', by: FADE },
];

describe('a dialog arriving', () => {
  const BASE = sheet('styles/base.css');

  it.each(ARRIVING)('$what arrives in the time and on the easing a menu does', ({ file, selector, by }) => {
    const rule = ruleOf(sheet(file), selector);
    // No fill: a motion held after it ends leaves a transform on the box, and what is inside is then placed by it.
    expect(rule).toContain(`animation: ${by} var(--m-pop) var(--m-ease);`);
  });

  it.each(ARRIVING)('$what stands still under reduced motion', ({ file, selector }) => {
    const still = inMedia(sheet(file), '(prefers-reduced-motion: reduce)');
    expect(still).toMatch(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{][^}]*animation:\\s*none`));
  });

  it('fades a wash or a whole page in and moves nothing', () => {
    expect(frames(BASE, FADE)).toBe('from { opacity: 0; } to { opacity: 1; }');
  });

  it('drops a sheet 4px into place, as a menu', () => {
    expect(frames(BASE, DROP)).toBe('from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; }');
  });

  // The paste card is centred by a shift of half its width, which the shared drop would take away while it ran.
  it('drops the paste card the same 4px and keeps the shift that centres it', () => {
    const css = sheet('components/paste/paste.css');
    expect(ruleOf(css, '.paste-card')).toContain('transform: translateX(-50%);');
    expect(frames(css, 'paste-card-in')).toBe('from { opacity: 0; transform: translate(-50%, -4px); } to { opacity: 1; transform: translateX(-50%); }');
  });

  // A suggestion card is a paste card hung from the right with no shift, so it takes the shared drop.
  it('drops a suggestion card by the shared motion, and holds it still under reduced motion', () => {
    const css = sheet('components/suggest/suggest.css');
    const rule = ruleOf(css, '.paste-card.suggest-card');
    expect(rule).toContain('transform: none;');
    expect(rule).toContain(`animation-name: ${DROP};`);
    expect(inMedia(css, '(prefers-reduced-motion: reduce)')).toMatch(/\.paste-card\.suggest-card\s*\{[^}]*animation:\s*none/);
  });

  it('prints a preview as it stands, not part of the way in', () => {
    expect(inMedia(sheet('print/print.css'), 'print')).toMatch(/\.print-preview\s*\{[^}]*animation:\s*none/);
    expect(inMedia(sheet('print/labels.css'), 'print')).toMatch(/\.labels-preview\s*\{[^}]*animation:\s*none/);
  });
});

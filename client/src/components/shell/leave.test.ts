// A dialog leaves the way it came. Closed, a still copy of it fades where it hung (`ghost.ts`): a sheet, a card or a
// panel goes back up the 4px it dropped, a wash clears, and a whole page laid over this one fades. Each takes
// `--m-hover` on the one easing, a little faster than it arrived. Some close at once and leave nothing: a vault
// sheet, anything holding a paste the gate has not read, a password field or a camera picture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GHOST_MOST, GHOST_NEVER, GHOST_SKIP } from './ghost';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const sheet = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '');

/** What a selector's own rule declares: the first rule that names it alone. */
function ruleOf(css: string, selector: string): string {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`));
  return at < 0 ? '' : (css.slice(at).split('{')[1]?.split('}')[0] ?? '');
}

const frames = (css: string, name: string): string => new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\})\\s*\\}`).exec(css)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

const FADE = 'fathom-fade-out';
const RISE = 'fathom-pop-out';
const WASH = 'fathom-wash-out';

/** Every dialog that leaves a copy, and the component whose root the copy is taken of. */
const LEAVING: ReadonlyArray<{ what: string; file: string }> = [
  { what: 'the importer', file: 'components/import/ImportDialog.tsx' },
  { what: 'Learn', file: 'components/learn/LearnOverlay.tsx' },
  { what: "the phone's scan sheet", file: 'components/phone/ScanSheet.tsx' },
  { what: "the phone's AI ideas sheet", file: 'components/design/DesignPlace.tsx' },
  { what: 'the paste card', file: 'components/paste/PasteCard.tsx' },
  { what: 'the folder card', file: 'components/paste/FolderCard.tsx' },
  { what: 'the tie card', file: 'components/ties/TieCard.tsx' },
  { what: 'a cable suggestion card', file: 'components/suggest/SuggestCard.tsx' },
  { what: 'the card of what a device says', file: 'components/suggest/FactsCard.tsx' },
  { what: 'the hosts card', file: 'components/suggest/HostsCard.tsx' },
  { what: 'the Print panel', file: 'print/PrintPanel.tsx' },
];

/** How a copy leaves where the shared drop back up is not its motion: the stylesheet, the copy's selector, the motion. */
const OWN_MOTION: ReadonlyArray<{ what: string; file: string; selector: string; by: string }> = [
  { what: 'the wash behind the importer', file: 'components/import/import.css', selector: '.imp[data-ghost]', by: WASH },
  { what: 'the importer on its wash', file: 'components/import/import.css', selector: '.imp[data-ghost] > .imp__box', by: RISE },
  { what: 'Learn', file: 'components/learn/learn.css', selector: '.learn-overlay[data-ghost]', by: FADE },
  { what: "a phone's sheet", file: 'components/phone/phone.css', selector: '.phone-scan[data-ghost]', by: FADE },
  { what: 'the paste card', file: 'components/paste/paste.css', selector: '.paste-card[data-ghost]', by: 'paste-card-out' },
];

describe('a dialog leaving', () => {
  const BASE = sheet('styles/base.css');

  it.each(LEAVING)('$what leaves a copy of itself', ({ file }) => {
    expect(read(file)).toMatch(/\buseGhostRef[<(]/);
  });

  it.each(OWN_MOTION)('$what leaves in the time and on the easing a closing menu does', ({ file, selector, by }) => {
    expect(ruleOf(sheet(file), selector)).toContain(`animation: ${by} var(--m-hover) var(--m-ease) both !important;`);
  });

  it('fades a whole page out and moves nothing', () => {
    expect(frames(BASE, FADE)).toBe('to { opacity: 0; }');
  });

  it('clears a wash by its colour, so the box on it is not faded twice', () => {
    expect(frames(BASE, WASH)).toBe('to { background-color: transparent; }');
  });

  it('takes a sheet back up the 4px it dropped', () => {
    expect(frames(BASE, RISE)).toBe('to { opacity: 0; transform: translateY(-4px); }');
    expect(frames(BASE, 'fathom-pop-in')).toContain('from { opacity: 0; transform: translateY(-4px); }');
  });

  // The shared motion would take away the shift that centres the card, and its copy would slide half a card aside.
  it('takes the paste card back the way it came, keeping the shift that centres it', () => {
    const css = sheet('components/paste/paste.css');
    expect(frames(css, 'paste-card-out')).toBe('to { opacity: 0; transform: translate(-50%, -4px); }');
    expect(frames(css, 'paste-card-in')).toContain('from { opacity: 0; transform: translate(-50%, -4px); }');
  });

  it('takes a suggestion card back by the shared motion, as it came', () => {
    expect(ruleOf(sheet('components/suggest/suggest.css'), '.paste-card.suggest-card[data-ghost]')).toContain(`animation-name: ${RISE} !important;`);
  });

  it('is never printed part of the way out', () => {
    expect(BASE).toMatch(/@media print\s*\{\s*\[data-ghost\]\s*\{\s*display:\s*none\s*!important/);
  });
});

describe('what closes at once and leaves nothing', () => {
  const never = GHOST_NEVER.split(',').map((part) => part.trim());

  // A copy of a vault sheet would keep what was typed into it on the page after the sheet had closed.
  it('a vault sheet', () => {
    const files = Object.keys(import.meta.glob('../vault/**/*.{ts,tsx}')).filter((file) => !/\.test\.tsx?$/.test(file));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/useGhostRef|shell\/ghost/);
    }
  });

  it('anything that holds a password field', () => {
    expect(never).toContain('input[type="password"]');
  });

  // Until Apply, Paste rows holds what was pasted as it was pasted: its box gates its own paste. It asks for a copy
  // as every dialog does and is refused one, which the inventory's browser drive sees.
  it('Paste rows, which holds a paste the gate has not read yet', () => {
    const source = read('components/inventory/PasteDialog.tsx');
    expect(source).toMatch(/<textarea[^>]*data-gate="self"/);
    expect(never).toContain('[data-gate="self"]');
  });

  it("the phone's scan sheet while the camera shows, since a copy of a camera picture is empty", () => {
    expect(read('components/phone/ScanSheet.tsx')).toMatch(/<video\b/);
    expect(never).toContain('video');
    expect(never).toContain('canvas');
  });

  it('anything too large to copy in a frame', () => {
    expect(GHOST_MOST).toBeGreaterThanOrEqual(400);
    expect(GHOST_MOST).toBeLessThanOrEqual(1000);
  });
});

describe('what a copy leaves out', () => {
  // The Print panel lays the whole pack out, hidden, to count its pages.
  it("the Print panel's hidden pass that counts pages", () => {
    expect(GHOST_SKIP).toBe('data-ghost-skip');
    expect(read('print/PrintPreview.tsx')).toMatch(/className="print-counter" data-ghost-skip=""/);
  });
});

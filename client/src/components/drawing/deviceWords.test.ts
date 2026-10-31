// Sign-off r60: one word list for what can be done to a device. The words live in `DEVICE_WORDS`; a
// button, menu item or tab that says one of them takes it from there, so the canvas, the panel, Ctrl K
// and Inventory cannot drift apart again ("Trace a path from here" beside "Trace from here").

import { describe, expect, it } from 'vitest';

import { DEVICE_WORDS } from './contextMenuItems';

/** Every source file under `src`, by its path from `src` ("components/drawing/Editor.tsx"), tests left out. */
const RAW = import.meta.glob(['../../**/*.ts', '../../**/*.tsx', '!../../**/*.test.ts', '!../../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const SOURCES = Object.entries(RAW).map(([path, text]) => ({ file: fromSrc(path), text }));

/** Vite names each file from this one ("./Editor.tsx", "../firmware/parts.tsx"); the test names it from `src`. */
function fromSrc(path: string): string {
  const at = ['components', 'drawing'];
  for (const part of path.split('/')) {
    if (part === '..') at.pop();
    else if (part !== '.') at.push(part);
  }
  return at.join('/');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Open" and "Details" are everyday words used for many other things; the rest name device actions. */
const ACTION_WORDS = Object.entries(DEVICE_WORDS)
  .filter(([key]) => key !== 'open' && key !== 'details')
  .map(([, word]) => word);

/** The same words for something that is not a device action. */
const ELSEWHERE = new Set([
  // A firmware image's download link, not the device's.
  'components/firmware/PlanExtras.tsx: Copy link',
  'components/firmware/parts.tsx: Copy link',
]);

/** Words the list replaced; none may come back. */
const RETIRED = ['Trace a path from here', 'Suggest cables from its neighbours (LLDP)', 'Open in inventory'];

describe('the device action words', () => {
  const files = SOURCES.filter((f) => f.file !== 'components/drawing/contextMenuItems.ts');

  it('reads the source tree', () => {
    expect(files.some((f) => f.file === 'components/drawing/Editor.tsx')).toBe(true);
  });

  it('are written once, in DEVICE_WORDS, and taken from there by every button and label', () => {
    const found: string[] = [];
    for (const { file, text } of files) {
      for (const word of ACTION_WORDS) {
        const asText = new RegExp(`>\\s*${escape(word)}\\s*<`);
        const asLabel = new RegExp(`(?<![-\\w])label(=|:\\s*)(['"])${escape(word)}\\2`);
        const hit = `${file}: ${word}`;
        if ((asText.test(text) || asLabel.test(text)) && !ELSEWHERE.has(hit)) found.push(hit);
      }
    }
    expect(found).toEqual([]);
  });

  it('do not use the retired wordings', () => {
    const found = files.filter(({ text }) => RETIRED.some((w) => text.includes(`'${w}'`) || text.includes(`>${w}<`)));
    expect(found.map((f) => f.file)).toEqual([]);
  });
});

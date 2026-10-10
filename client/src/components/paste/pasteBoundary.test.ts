// No DOM environment here, so the boundary's reach is pinned by its source: the canvas editor
// (every place, the docs overlay and the print panel) sits inside one boundary, so a paste into
// any of its text boxes passes the gate (CLAUDE.md rule 4). The gate itself is tested against the
// real wasm in `inventory/gatedPaste.test.ts`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, rel), 'utf8');

describe('the canvas editor is inside the paste gate', () => {
  const src = read('../design/DesignPlace.tsx');

  it('DesignPlace wraps everything it renders in the boundary, fed the real gate', () => {
    const ret = src.slice(src.lastIndexOf('\n  return (\n'));
    expect(ret).toMatch(/^\n {2}return \(\n {4}<PasteGateBoundary redact=\{redact\}>/);
    expect(ret).toMatch(/<\/PasteGateBoundary>\n {2}\);\n\}\s*$/);
    expect(src).toContain("const redact = useCallback(async (text: string) => (await ensureEngine()).redactText(text).text");
  });

  it('a boundary inside another leaves a paste the outer one already took', () => {
    const b = read('./PasteGateBoundary.tsx');
    expect(b.match(/if \(e\.defaultPrevented\) return;/g)).toHaveLength(2); // paste and drop
  });
});

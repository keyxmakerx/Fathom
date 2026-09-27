// Drawing.tsx must take its caches from `useDrawingNodeCaches`, which creates
// them once; a cache built anywhere else in it would be rebuilt every render.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DRAWING = readFileSync(fileURLToPath(new URL('./Drawing.tsx', import.meta.url)), 'utf8');
const HOOK = readFileSync(fileURLToPath(new URL('./useDrawingNodeCaches.ts', import.meta.url)), 'utf8');

/** Every way Drawing.tsx could build or replace a cache outside the hook. */
function cacheViolations(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const found: string[] = [];
  for (const banned of ['createDrawingNodeCaches', 'createChassisNodeCaches', 'new IdCache', 'new StableRef', 'prevNodes']) {
    if (code.includes(banned)) found.push(banned);
  }
  const calls = code.match(/\buseDrawingNodeCaches\(\)/g) ?? [];
  if (calls.length !== 1) found.push(`useDrawingNodeCaches() called ${calls.length} times`);
  const handle = /const\s+(\w+)\s*=\s*useDrawingNodeCaches\(\)/.exec(code)?.[1];
  if (handle == null) found.push('the caches are not held in one const');
  else {
    const rest = code.replace(/const\s+\w+\s*=\s*useDrawingNodeCaches\(\)/, '');
    if (new RegExp(`\\b${handle}(\\.\\w+)*\\s*=(?!=)`).test(rest)) found.push(`${handle} is reassigned`);
  }
  return found;
}

describe('Drawing.tsx builds its caches only through useDrawingNodeCaches', () => {
  it('has no cache construction or reassignment outside the hook', () => {
    expect(cacheViolations(DRAWING)).toEqual([]);
  });

  it('the hook creates the caches once, through a lazy useState', () => {
    expect(HOOK).toMatch(/useState\(createDrawingCaches\)/);
  });

  it('catches a Drawing that rebuilds its caches every render', () => {
    const broken = DRAWING.replace(
      /const\s+caches\s*=\s*useDrawingNodeCaches\(\);/,
      'const caches = useDrawingNodeCaches();\n  caches.nodes = createDrawingNodeCaches();',
    );
    expect(broken).not.toBe(DRAWING);
    expect(cacheViolations(broken)).toContain('createDrawingNodeCaches');
    expect(cacheViolations(broken)).toContain('caches is reassigned');
  });
});

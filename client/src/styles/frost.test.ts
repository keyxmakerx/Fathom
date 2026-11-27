// The frosted glass behind menus, pop-overs, tips and the mini-map (UI-SPEC, Look: "frosted glass (`--pop-bg`,
// `--pop-blur`)"). A rule writes the blur twice: `-webkit-backdrop-filter` for older Safari and `backdrop-filter`
// for every other browser. The build's minifier keeps both lines only when the `-webkit-` one is written first.
// Written second, the standard line was dropped: the built app drew no blur in Chromium, while `npm run dev`, which
// does not minify, drew it. So every rule writes the pair, `-webkit-` first, with one value.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Every stylesheet the client ships: the glob names them, and each is read from disk (a test is handed no CSS).
const SHEET_PATHS = Object.keys(import.meta.glob('../**/*.css'));

/** The blur as each rule of a stylesheet writes it, in the order written: the property and its value. */
function blurLines(css: string): { property: string; value: string }[][] {
  const bodies = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{[^{}]*\}/g) ?? [];
  return bodies
    .map((body) => [...body.matchAll(/(?:^|[;{\s])((?:-webkit-)?backdrop-filter)\s*:\s*([^;}]+)/g)].map((m) => ({ property: m[1]!, value: m[2]!.trim() })))
    .filter((lines) => lines.length > 0);
}

describe('the frosted glass survives the build', () => {
  const frosted = SHEET_PATHS.map((sheet) => ({ sheet, rules: blurLines(readFileSync(fileURLToPath(new URL(sheet, import.meta.url)), 'utf8')) })).filter((s) => s.rules.length > 0);

  it('reads the blur out of a rule in the order it is written', () => {
    expect(blurLines('.a { color: red; -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); } .b { color: blue; }')).toEqual([
      [
        { property: '-webkit-backdrop-filter', value: 'blur(2px)' },
        { property: 'backdrop-filter', value: 'blur(2px)' },
      ],
    ]);
    expect(blurLines('/* backdrop-filter: none; */ .a { backdrop-filter: none }')).toEqual([[{ property: 'backdrop-filter', value: 'none' }]]);
  });

  it('finds the stylesheets that frost something', () => {
    // The menus (shell.css), the tips (hints.css) and the mini-map (canvas-aids.css) are among them.
    const names = frosted.map((s) => s.sheet);
    expect(names).toContain('./shell.css');
    expect(names).toContain('./hints.css');
    expect(names).toContain('./canvas-aids.css');
    expect(names.some((n) => n.startsWith('../components/'))).toBe(true);
  });

  it('every rule writes the pair, the -webkit- line first, with one value', () => {
    const wrong = frosted.flatMap((s) =>
      s.rules
        .filter((lines) => !(lines.length === 2 && lines[0]!.property === '-webkit-backdrop-filter' && lines[1]!.property === 'backdrop-filter' && lines[0]!.value === lines[1]!.value))
        .map((lines) => `${s.sheet}: ${lines.map((l) => `${l.property}: ${l.value}`).join('; ')}`),
    );
    expect(wrong).toEqual([]);
  });
});

// A blur sees no further than the nearest thing around it that is drawn as one piece, and a thing that fades as a
// whole and holds the end of its fade is such a piece: the glass inside then blurs that thing alone, and the page
// shows sharp through it. `scripts/drive-fresh-install.mjs` looks at the pixels in the built app.
describe('the frosted glass sees the page behind it', () => {
  const palette = readFileSync(fileURLToPath(new URL('./palette.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const frames = (name: string) => new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\})\\s*\\}`).exec(palette)?.[1] ?? '';
  const rule = (selector: string) => palette.split(`${selector} {`)[1]?.split('}')[0] ?? '';
  const WHOLE = ['opacity', 'filter', 'mix-blend-mode', 'mask', 'clip-path'];

  it('the wash a floating sheet sits in comes in by its colour, not as a whole', () => {
    expect(rule('.float-scrim')).toMatch(/animation:\s*float-scrim-in\b/);
    expect(frames('float-scrim-in')).toMatch(/background-color:\s*transparent/);
    for (const property of WHOLE) expect(frames('float-scrim-in')).not.toContain(property);
  });

  it('and is not drawn as one piece at rest', () => {
    for (const property of [...WHOLE, 'will-change']) expect(rule('.float-scrim')).not.toMatch(new RegExp(`(^|[;\\s])${property}\\s*:`));
  });
});

/** Pure lookups from a `Sheath`/`CableKind` name to the token that draws
 * it, and to the list the colour picker offers for a given cable kind —
 * `docs/UI-SPEC.md` "Cables": "Colour is the real sheath," and
 * `design/tokens.css`'s `--sheath-*` block, which is the one place any of
 * these become a hex value. No DOM, no React — testable on its own. */

import type { CableKind, Sheath } from './contract';

/** Every `Sheath` reads as its token — never a literal hex anywhere else in
 * this drawing (BRIEF: "Every colour from tokens"). */
export const SHEATH_VAR: Readonly<Record<Sheath, string>> = {
  grey: 'var(--sheath-grey)',
  blue: 'var(--sheath-blue)',
  red: 'var(--sheath-red)',
  yellow: 'var(--sheath-yellow)',
  green: 'var(--sheath-green)',
  orange: 'var(--sheath-orange)',
  purple: 'var(--sheath-purple)',
  black: 'var(--sheath-black)',
  white: 'var(--sheath-white)',
  aqua: 'var(--sheath-aqua)',
  erika: 'var(--sheath-erika)',
};

/** UI-SPEC "Cables": "grey, blue, red, yellow, green, orange, purple,
 * black, white for copper" — the stock lead colours, in the order the
 * approved boards list them (`Patching.dc.html`'s own swatch row). */
export const COPPER_SHEATHS: readonly Sheath[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'orange',
  'purple',
  'black',
  'white',
];

/** UI-SPEC "Cables": "per TIA-598-C for fibre — orange OM1/OM2, aqua
 * OM3/OM4, erika violet OM4 (some makers), yellow OS2." */
export const FIBRE_SHEATHS: readonly Sheath[] = ['orange', 'aqua', 'erika', 'yellow'];

/** The brief's "power a fixed grey" — one colour, so the picker for a power
 * cable has one row rather than a choice with only one honest answer. */
export const POWER_SHEATHS: readonly Sheath[] = ['grey'];

/** What the colour picker lists for a cable of this kind — UI-SPEC
 * "Drag-to-connect": "the colour picker... listing the sheaths for that
 * cable kind." */
export function sheathsFor(kind: CableKind): readonly Sheath[] {
  if (kind === 'fibre') return FIBRE_SHEATHS;
  if (kind === 'power') return POWER_SHEATHS;
  return COPPER_SHEATHS;
}

/**
 * UI-SPEC "Cables": "A sheath within a hairline of the page gets a
 * hairline outline (white on light, black on dark)" — white blends into
 * the light theme's white page, black blends into the dark theme's
 * near-black page (`design/tokens.css`'s two `--page` values). Applied
 * unconditionally in both themes rather than switching on the current one:
 * `--hairline` is itself a theme-aware token, so the outline this draws is
 * always the right shade for whichever theme is active, and in the theme
 * where it is not strictly needed it reads as a barely-visible addition,
 * not a wrong one — cheaper than replicating `tokens.css`'s own
 * light/dark selectors a third time in component logic.
 */
export function needsHairlineOutline(sheath: Sheath): boolean {
  return sheath === 'white' || sheath === 'black';
}

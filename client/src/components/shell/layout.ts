/** BRIEF.md "The bar": "Measure the row; if it will not fit 1440, search
 * collapses to the magnifier alone before anything else gives." Everything
 * except search has a width fixed by its content (brand, tabs, path, lens,
 * presence, undo/redo, zoom, account); search is the one element with two
 * widths to choose between. This is the whole decision, pulled out of the
 * component so it can be tested without rendering or measuring anything. */
export interface BarFitInput {
  /** The bar's own available width, in CSS pixels. */
  containerWidth: number;
  /** The combined width of everything in the bar except the search box. */
  fixedWidth: number;
  /** The search box's width when drawn in full (BRIEF.md: "~180px"). */
  searchExpandedWidth: number;
}

/** Pure: would the bar, at `containerWidth`, fail to fit `fixedWidth` plus
 * the search box at `searchExpandedWidth`? If so, search collapses to the
 * magnifier alone. */
export function searchShouldCollapse({
  containerWidth,
  fixedWidth,
  searchExpandedWidth,
}: BarFitInput): boolean {
  return containerWidth < fixedWidth + searchExpandedWidth;
}

/** How far the bar is folded: 0 is everything shown; each step folds one more
 * group (search, the action chips, the path, the lenses, then undo and zoom). */
export const BAR_FOLD_MAX = 5;

/** Pure: the next fold level. Fold one more while the row is wider than the
 * bar; unfold one when the width the less-folded row needed now fits.
 * `needed[l]` is the row's width last measured at level `l`. */
export function nextFoldLevel(input: { level: number; total: number; avail: number; needed: readonly (number | undefined)[] }): number {
  const { level, total, avail, needed } = input;
  if (total > avail && level < BAR_FOLD_MAX) return level + 1;
  const wider = level > 0 ? needed[level - 1] : undefined;
  if (wider !== undefined && wider <= avail) return level - 1;
  return level;
}

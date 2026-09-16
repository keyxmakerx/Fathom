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

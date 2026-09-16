/** One step of the breadcrumb under the tabs (BRIEF.md "The bar", point 3):
 * `Northwind › HQ › Building A › IDF-2`. `onSelect`, if given, fires when
 * this specific part is clicked, in addition to opening the tree popover —
 * BRIEF.md's rule that clicking *any* part opens the tree beneath it. */
export interface PathPart {
  label: string;
  onSelect?: () => void;
}

export interface PathItem extends PathPart {
  /** True for the last part only: drawn ink and 700. Every part before it
   * is muted. */
  current: boolean;
}

/** Pure: mark the last part of the path current, the rest not — BRIEF.md
 * "separators muted, the last part ink 700, the rest muted". An empty path
 * (Home; nothing is in scope yet) returns an empty list. */
export function pathToItems(path: readonly PathPart[]): PathItem[] {
  const lastIndex = path.length - 1;
  return path.map((part, index) => ({ ...part, current: index === lastIndex }));
}

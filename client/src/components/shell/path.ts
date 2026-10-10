/** One step of the breadcrumb under the tabs (BRIEF.md "The bar", point 3):
 * `Northwind › HQ › Building A › IDF-2`. `onSelect`, if given, fires when
 * this specific part is clicked; only the part marked `opensTree` opens the
 * tree popover (the owner, 2026-10-10: every crumb opening the same menu read
 * as pointless). */
export interface PathPart {
  label: string;
  onSelect?: () => void;
  /** This crumb opens the list of places and designs to switch to. */
  opensTree?: boolean;
  /** What a click does, as a tooltip. */
  hint?: string;
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

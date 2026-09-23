/** The five lenses, in the bar's fixed left-to-right order — BRIEF.md "The
 * bar", point 4: "Order: Cables, Links, Routing, Power, Owner." A lens never
 * moves a box and never hides one; it changes the marks and the colours
 * (ADR-0047 §1). */
export const LENSES = ['cables', 'links', 'routing', 'power', 'owner'] as const;

export type Lens = (typeof LENSES)[number];

export const LENS_LABEL: Record<Lens, string> = {
  cables: 'Cables',
  links: 'Links',
  routing: 'Routing',
  power: 'Power',
  owner: 'Owner',
};

/** Pure: is `candidate` the lit lens, given the shell's current `active`
 * lens? Extracted so the lit/unlit decision is testable without rendering
 * anything (BRIEF.md "the lit one has an ink background and page-coloured
 * text"). */
/** The lenses shown in each place: only those that change what it draws
 * (the owner, 2026-09-23). Links, Power and Owner have no drawing yet. */
export const LENSES_IN: Record<'racks' | 'inventory', readonly Lens[]> = {
  racks: ['cables', 'routing'],
  inventory: ['cables', 'routing', 'power', 'owner'],
};

export function isLensLit(candidate: Lens, active: Lens): boolean {
  return candidate === active;
}

// ADR-0074 §1 to §3: the three stops above the closet, drawn from the folders the person may
// read. The building stop shows its closets, the site stop its buildings, the estate stop every
// site. Nothing here is a second store of places: every box is a `Scope` the server sent, and a
// folder the person may not read is simply absent (`api/scopes.ts`).

import type { Scope } from '../../api/scopes';

export type UpperStop = 'building' | 'site' | 'estate';

/** The server's folder kind each upper stop is about. */
const STOP_KIND: Record<Exclude<UpperStop, 'estate'>, string> = { building: 'building', site: 'network' };
/** The kind of box each stop draws. */
const BOX_KIND: Record<UpperStop, string> = { building: 'rack', site: 'building', estate: 'network' };

/** Above this many branch or customer sites, the estate folds them into a counted stack (§3). */
export const FOLD_AT = 8;

export interface MapBox {
  scope: Scope;
  /** Folders directly inside this one that the person may read. */
  inside: number;
  /** Designs in this folder and every folder inside it. */
  designs: number;
  /** The open design sits in this folder or one inside it. */
  here: boolean;
}

export interface FoldedStack {
  role: string;
  boxes: MapBox[];
}

export interface MapView {
  stop: UpperStop;
  /** The folder this stop is about; `null` at the estate. */
  place: Scope | null;
  boxes: MapBox[];
  /** §3: many small sites as counted stacks, each unfolding on a click. Estate only. */
  stacks: FoldedStack[];
}

/** `scopeId` itself or its nearest ancestor of `kind` among the folders sent, else `null`. */
export function ancestorOfKind(scopes: readonly Scope[], scopeId: string, kind: string): Scope | null {
  const byId = new Map(scopes.map((s) => [s.scopeId, s]));
  let at = byId.get(scopeId);
  while (at) {
    if (at.kind === kind) return at;
    at = at.parentScopeId === null ? undefined : byId.get(at.parentScopeId);
  }
  return null;
}

/** Whether `scopeId` is `ancestorId` or sits somewhere inside it, by the opaque path. */
export function isWithin(scopes: readonly Scope[], scopeId: string, ancestor: Scope): boolean {
  const scope = scopes.find((s) => s.scopeId === scopeId);
  if (!scope) return false;
  return scope.path === ancestor.path || scope.path.startsWith(`${ancestor.path}.`);
}

/** The upper stops open from `currentScopeId`, nearest first: a design with no building above it
 * has no building stop. The estate is there whenever any site is. */
export function upperStopsFor(scopes: readonly Scope[], currentScopeId: string): UpperStop[] {
  const out: UpperStop[] = [];
  if (ancestorOfKind(scopes, currentScopeId, 'building')) out.push('building');
  if (ancestorOfKind(scopes, currentScopeId, 'network')) out.push('site');
  if (scopes.some((s) => s.kind === 'network')) out.push('estate');
  return out;
}

/** The folder a stop is about when it opens from the design in `currentScopeId`. */
export function focusFor(scopes: readonly Scope[], stop: UpperStop, currentScopeId: string): string | null {
  if (stop === 'estate') return null;
  return ancestorOfKind(scopes, currentScopeId, STOP_KIND[stop])?.scopeId ?? null;
}

/**
 * What a stop draws. `focusId` names the building or site (ignored at the estate);
 * `designScopeIds` is the folder of every design the person may open.
 */
export function mapView(
  scopes: readonly Scope[],
  stop: UpperStop,
  focusId: string | null,
  currentScopeId: string,
  designScopeIds: readonly string[],
): MapView {
  const place = stop === 'estate' ? null : (scopes.find((s) => s.scopeId === focusId) ?? null);
  const candidates =
    stop === 'estate'
      ? scopes.filter((s) => s.kind === 'network')
      : place === null
        ? []
        : scopes.filter((s) => s.kind === BOX_KIND[stop] && s.parentScopeId === place.scopeId);

  const boxes: MapBox[] = candidates
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((scope) => ({
      scope,
      inside: scopes.filter((s) => s.parentScopeId === scope.scopeId).length,
      designs: designScopeIds.filter((id) => isWithin(scopes, id, scope)).length,
      here: isWithin(scopes, currentScopeId, scope),
    }));

  if (stop !== 'estate') return { stop, place, boxes, stacks: [] };

  // §3: hubs and anything the person is in stay out; many small sites of one role fold.
  const stacks: FoldedStack[] = [];
  let shown = boxes;
  for (const role of ['branch', 'customer']) {
    const small = shown.filter((b) => b.scope.placeRole === role && !b.here);
    if (small.length > FOLD_AT) {
      stacks.push({ role, boxes: small });
      shown = shown.filter((b) => !small.includes(b));
    }
  }
  return { stop, place, boxes: shown, stacks };
}

/** The stop one level in from `stop`, or `null` from the building (its boxes are closets). */
export function stopInside(stop: UpperStop): UpperStop | null {
  return stop === 'estate' ? 'site' : stop === 'site' ? 'building' : null;
}

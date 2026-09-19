/**
 * UI-SPEC "Cables"/"Keeping it readable at forty cables" — the owner's ask
 * of 2026-09-19: "a 64-port device makes a cable hard to click." A view
 * control, not a lens (UI-SPEC "The shape": "view controls are not lenses:
 * a lens never hides a box") — the plan control on the Room board
 * (`design/places/Room.dc.html`) is the precedent for the FORM: a small
 * on-canvas control, its choice never a document fact, never saved.
 *
 * Pure: no DOM, no React, no `Document` — a kind list in, the visible
 * subset out. `Drawing.tsx` is the one caller; `CablesViewControl.tsx` is
 * the one renderer of the choice this file stores.
 */

import type { CableKind } from './contract';

export const CABLE_VISIBILITY_OPTIONS = ['all', 'copper', 'fibre', 'power', 'none'] as const;

export type CableVisibility = (typeof CABLE_VISIBILITY_OPTIONS)[number];

/** Whether a cable of `kind` draws under `visibility` — `'all'` and
 * `'none'` are the two extremes, the three kinds each show exactly their
 * own. */
export function cableKindVisible(visibility: CableVisibility, kind: CableKind): boolean {
  if (visibility === 'all') return true;
  if (visibility === 'none') return false;
  return visibility === kind;
}

/** The brief's own rule: "hiding a kind removes those cables and bundles
 * from the drawing" — filters a cable (or bundle, or anything else typed by
 * its own `kind`) list down to what `visibility` keeps. Generic over `T`
 * rather than `CableView` alone so `Drawing.tsx` can run the SAME rule over
 * whatever shape it is filtering at that call site (a `CableView`, or later
 * a bundle) without a second copy of the `if` above. */
export function filterCablesByVisibility<T extends { kind: CableKind }>(
  cables: readonly T[],
  visibility: CableVisibility,
): T[] {
  return cables.filter((c) => cableKindVisible(visibility, c.kind));
}

/** The one browser-local key this control's choice lives under — never a
 * document field (rule 1: "A field that is not in `schema/` does not
 * exist"), never sent to the server. */
const STORAGE_KEY = 'fathom.drawing.cableVisibility';

function isCableVisibility(raw: string): raw is CableVisibility {
  return (CABLE_VISIBILITY_OPTIONS as readonly string[]).includes(raw);
}

/** `localStorage`, wrapped in try/catch — the brief's own words. Private
 * browsing, a disabled storage API, or a full quota all throw on some
 * engines; none of those are a reason the drawing itself should fail to
 * render. Falls back to `'all'`, the one choice that changes nothing about
 * what draws today. */
export function loadCableVisibility(): CableVisibility {
  try {
    // Bare `localStorage`, not `window.localStorage` — `theme.ts`'s own
    // `getStoredTheme` reads the same global the same way; matched here
    // rather than routed through `window` for no reason this file needs.
    // Also what makes the try/catch below catch a MISSING global (a
    // pre-DOM/SSR-like context, this module's own test) exactly the way it
    // catches a real browser refusing the call (private mode, a disabled
    // storage API, a full quota) — one guard, every failure shape.
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw != null && isCableVisibility(raw)) return raw;
  } catch {
    // storage unavailable — the default below is the honest fallback, not a
    // silently swallowed failure that pretends to have read a real choice.
  }
  return 'all';
}

/** The reverse — best-effort only, per the same "wrapped in try/catch"
 * brief line. A save that fails leaves whatever choice was already stored
 * (or none) rather than throwing out of a click handler. */
export function saveCableVisibility(visibility: CableVisibility): void {
  try {
    localStorage.setItem(STORAGE_KEY, visibility);
  } catch {
    // best effort only — never a document fact, never worth surfacing as a
    // refusal the way a real edit's is.
  }
}

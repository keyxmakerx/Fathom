/** The cable style (round 15, signed off 2026-10-10): how a cable's line is drawn between its
 * ports. Physics (the default), cable-tied, right-angle or faded. Each person picks their own in
 * the Show menu; kept in this browser per account, never a document field, so switching changes
 * no byte of the design. */

export const CABLE_STYLES = ['physics', 'tied', 'square', 'faded'] as const;

export type CableStyle = (typeof CABLE_STYLES)[number];

export const CABLE_STYLE_LABEL: Record<CableStyle, string> = {
  physics: 'Physics',
  tied: 'Cable-tied',
  square: 'Right-angle',
  faded: 'Faded',
};

/** One line under the picker, from the signed-off card. */
export const CABLE_STYLE_HINT: Record<CableStyle, string> = {
  physics: 'Cables hang and sway a little when you move a device.',
  tied: 'Cables that share a route bundle together, with ties.',
  square: 'Straight runs and square corners, like a wiring diagram.',
  faded: 'About an inch shows at each end. Point at a port or cable to see the whole run.',
};

/** Key Maker's pick on r15-cable-style (2026-10-10 14:29Z). */
export const DEFAULT_CABLE_STYLE: CableStyle = 'physics';

export function isCableStyle(raw: unknown): raw is CableStyle {
  return typeof raw === 'string' && (CABLE_STYLES as readonly string[]).includes(raw);
}

function keyFor(accountId: string | null): string {
  return `fathom.cableStyle.${accountId ?? 'anon'}`;
}

/** Best effort: private mode or a blocked store gives the default. */
export function loadCableStyle(accountId: string | null): CableStyle {
  try {
    const raw = localStorage.getItem(keyFor(accountId));
    if (isCableStyle(raw)) return raw;
  } catch {
    // storage unavailable: the default is the honest fallback
  }
  return DEFAULT_CABLE_STYLE;
}

export function saveCableStyle(accountId: string | null, style: CableStyle): void {
  try {
    localStorage.setItem(keyFor(accountId), style);
  } catch {
    // best effort only
  }
}

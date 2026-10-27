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

/** Cable colour (Key Maker's note on the cables card, 2026-10-27): every cable in its sheath
 * colour, or only the cable pointed at or selected, with the rest in plain grey. Kept like the
 * style: per person, in this browser, never in the design. */
export const CABLE_COLOURS = ['all', 'pointed'] as const;

export type CableColour = (typeof CABLE_COLOURS)[number];

export const CABLE_COLOUR_LABEL: Record<CableColour, string> = {
  all: 'Every cable',
  pointed: 'Only the one I point at',
};

export const DEFAULT_CABLE_COLOUR: CableColour = 'all';

export function isCableColour(raw: unknown): raw is CableColour {
  return typeof raw === 'string' && (CABLE_COLOURS as readonly string[]).includes(raw);
}

function colourKeyFor(accountId: string | null): string {
  return `fathom.cableColour.${accountId ?? 'anon'}`;
}

export function loadCableColour(accountId: string | null): CableColour {
  try {
    const raw = localStorage.getItem(colourKeyFor(accountId));
    if (isCableColour(raw)) return raw;
  } catch {
    // storage unavailable: the default is the honest fallback
  }
  return DEFAULT_CABLE_COLOUR;
}

export function saveCableColour(accountId: string | null, colour: CableColour): void {
  try {
    localStorage.setItem(colourKeyFor(accountId), colour);
  } catch {
    // best effort only
  }
}

/** The look switch (ADR-0061 round 7): Rack draws faceplates and dressed
 * cables, Diagram draws plain boxes and square lines. Each person's choice is
 * kept in this browser per account and design — never a document field, never
 * sent to the server; new designs start on Rack. */

export const LOOKS = ['rack', 'diagram'] as const;

export type Look = (typeof LOOKS)[number];

export const LOOK_LABEL: Record<Look, string> = { rack: 'Rack', diagram: 'Diagram' };

export const DEFAULT_LOOK: Look = 'rack';

export function isLook(raw: unknown): raw is Look {
  return typeof raw === 'string' && (LOOKS as readonly string[]).includes(raw);
}

function keyFor(accountId: string | null, designId: string | undefined): string {
  return `fathom.look.${accountId ?? 'anon'}.${designId ?? 'unsaved'}`;
}

/** Best effort: private mode or a blocked store gives the default. */
export function loadLook(accountId: string | null, designId: string | undefined): Look {
  try {
    const raw = localStorage.getItem(keyFor(accountId, designId));
    if (isLook(raw)) return raw;
  } catch {
    // storage unavailable: the default is the honest fallback
  }
  return DEFAULT_LOOK;
}

export function saveLook(accountId: string | null, designId: string | undefined, look: Look): void {
  try {
    localStorage.setItem(keyFor(accountId, designId), look);
  } catch {
    // best effort only
  }
}

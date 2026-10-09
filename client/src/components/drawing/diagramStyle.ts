/** The diagram style (ADR-0060 decision 3): how the Diagram look draws a device.
 * Boxes (default) or Icons; Faceplates is the Rack look. Per account and design,
 * kept in this browser — never a document field, so switching changes no byte of
 * the design. */

export const DIAGRAM_STYLES = ['boxes', 'icons'] as const;

export type DiagramStyle = (typeof DIAGRAM_STYLES)[number];

export const DIAGRAM_STYLE_LABEL: Record<DiagramStyle, string> = { boxes: 'Boxes', icons: 'Icons' };

export const DEFAULT_DIAGRAM_STYLE: DiagramStyle = 'boxes';

export function isDiagramStyle(raw: unknown): raw is DiagramStyle {
  return typeof raw === 'string' && (DIAGRAM_STYLES as readonly string[]).includes(raw);
}

function keyFor(accountId: string | null, designId: string | undefined): string {
  return `fathom.diagramStyle.${accountId ?? 'anon'}.${designId ?? 'unsaved'}`;
}

/** Best effort: private mode or a blocked store gives the default. */
export function loadDiagramStyle(accountId: string | null, designId: string | undefined): DiagramStyle {
  try {
    const raw = localStorage.getItem(keyFor(accountId, designId));
    if (isDiagramStyle(raw)) return raw;
  } catch {
    // storage unavailable: the default is the honest fallback
  }
  return DEFAULT_DIAGRAM_STYLE;
}

export function saveDiagramStyle(accountId: string | null, designId: string | undefined, style: DiagramStyle): void {
  try {
    localStorage.setItem(keyFor(accountId, designId), style);
  } catch {
    // best effort only
  }
}

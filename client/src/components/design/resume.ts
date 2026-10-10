/** "Pick up where you left off": per person, per design, kept in this browser (never a document
 * field), next to `drawing/layers.ts`'s key scheme. The camera, which right-hand tab was open,
 * whether Equipment was open, and the selected thing. */

export type ResumeTab = 'details' | 'trail';

export interface ResumeCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface ResumeSelection {
  kind: string;
  id: string;
}

export interface Resume {
  camera: ResumeCamera | null;
  tab: ResumeTab | null;
  equipmentOpen: boolean;
  selection: ResumeSelection | null;
}

export const EMPTY_RESUME: Resume = { camera: null, tab: null, equipmentOpen: false, selection: null };

/** The kinds a selection can be restored as. A port is left out on purpose: selecting one
 * glides the camera to it, which would undo the camera being restored. */
const RESTORABLE_KINDS = ['rack', 'chassis', 'cable', 'shelf', 'occupant', 'fixture', 'label', 'line'] as const;

export function resumeKey(accountId: string | null, designId: string | undefined): string {
  return `fathom.resume.${accountId ?? 'anon'}.${designId ?? 'unsaved'}`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keeps what is valid and drops the rest; anything damaged gives the empty value. */
export function parseResume(raw: unknown): Resume {
  if (typeof raw !== 'object' || raw === null) return EMPTY_RESUME;
  const r = raw as Record<string, unknown>;
  let camera: ResumeCamera | null = null;
  const c = r.camera as Record<string, unknown> | null | undefined;
  if (c != null && typeof c === 'object' && finite(c.x) && finite(c.y) && finite(c.zoom) && c.zoom > 0.05 && c.zoom <= 8) {
    camera = { x: c.x, y: c.y, zoom: c.zoom };
  }
  const tab: ResumeTab | null = r.tab === 'details' || r.tab === 'trail' ? r.tab : null;
  let selection: ResumeSelection | null = null;
  const s = r.selection as Record<string, unknown> | null | undefined;
  if (s != null && typeof s === 'object' && typeof s.kind === 'string' && typeof s.id === 'string' && s.id !== '') {
    if ((RESTORABLE_KINDS as readonly string[]).includes(s.kind)) selection = { kind: s.kind, id: s.id };
  }
  return { camera, tab, equipmentOpen: r.equipmentOpen === true, selection };
}

export function loadResume(accountId: string | null, designId: string | undefined): Resume {
  try {
    const raw = localStorage.getItem(resumeKey(accountId, designId));
    if (raw != null) return parseResume(JSON.parse(raw));
  } catch {
    // storage unavailable or damaged: start fresh
  }
  return EMPTY_RESUME;
}

/** Changes some of what is remembered and leaves the rest. Best effort. */
export function patchResume(accountId: string | null, designId: string | undefined, patch: Partial<Resume>): void {
  if (designId == null) return;
  try {
    const next: Resume = { ...loadResume(accountId, designId), ...patch };
    localStorage.setItem(resumeKey(accountId, designId), JSON.stringify(next));
  } catch {
    // not remembered
  }
}

/** Is the stored camera worth restoring: does it still show any of what is drawn? Without this a
 * design whose racks were moved since would open onto empty canvas. */
export function viewShowsAny(
  camera: ResumeCamera,
  pane: { width: number; height: number },
  rects: readonly { x: number; y: number; width: number; height: number }[],
): boolean {
  if (rects.length === 0) return true; // nothing drawn to miss
  const left = -camera.x / camera.zoom;
  const top = -camera.y / camera.zoom;
  const right = left + pane.width / camera.zoom;
  const bottom = top + pane.height / camera.zoom;
  return rects.some((r) => r.x < right && r.x + r.width > left && r.y < bottom && r.y + r.height > top);
}

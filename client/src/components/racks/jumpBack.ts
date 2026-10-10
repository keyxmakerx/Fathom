// "Jump back": where you have been inside this design in this tab, like a browser's history. Every step is
// a place (the look, what is selected, which device is open, how close the camera is) with the camera it
// was left at. The pure stack lives here; `useJumpBack.ts` feeds it and `JumpTrail.tsx` draws it.

import type { CameraStop } from '../drawing/geometry';
import type { Look } from '../drawing/look';

export interface Spot {
  look: Look;
  selection: { kind: string; id: string } | null;
  /** The device opened full-size, if any. */
  jotId: string | null;
  stop: CameraStop;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Step {
  spot: Spot;
  /** Where the camera was last left at this step; null until it has settled once. */
  camera: Camera | null;
  /** The words on its chip, in capitals. */
  label: string;
  /** When it was made or last moved a stop, in milliseconds. */
  at: number;
}

export interface Trail {
  steps: readonly Step[];
  /** The current step. */
  index: number;
}

/** Rapid zooming through several stops is one step, not three. */
export const COALESCE_MS = 800;
/** The oldest steps fall off past this many. */
export const MAX_STEPS = 50;

export const EMPTY_TRAIL: Trail = { steps: [], index: -1 };

/** The whole room and one rack are the same level to a person: zooming between them has not taken them
 * anywhere with a name. Getting close to a device (faceplate) and going inside it are levels of their own. */
export function levelOf(stop: CameraStop): 'room' | 'faceplate' | 'inside' {
  return stop === 'faceplate' || stop === 'inside' ? stop : 'room';
}

export function spotKey(s: Spot): string {
  return `${s.look}|${s.selection ? `${s.selection.kind}:${s.selection.id}` : ''}|${s.jotId ?? ''}|${levelOf(s.stop)}`;
}

/** The same place, only the camera's level differs (a zoom, nothing chosen or opened). */
export function sameButStop(a: Spot, b: Spot): boolean {
  return a.look === b.look && a.jotId === b.jotId && a.selection?.id === b.selection?.id && a.selection?.kind === b.selection?.kind && levelOf(a.stop) !== levelOf(b.stop);
}

export const canGoBack = (t: Trail): boolean => t.index > 0;
export const canGoForward = (t: Trail): boolean => t.index >= 0 && t.index < t.steps.length - 1;

function cap(steps: readonly Step[], index: number): Trail {
  if (steps.length <= MAX_STEPS) return { steps, index };
  const drop = steps.length - MAX_STEPS;
  return { steps: steps.slice(drop), index: Math.max(0, index - drop) };
}

/**
 * The person is now at `spot`. Same place as the current step: nothing new (a changed label is kept).
 * Somewhere new: a step is added after the current one and anything that was ahead of it is dropped, as in
 * a browser. Two exceptions. A change of stop alone, soon after the step was made, moves that step on
 * instead of adding one, so one wheel gesture through three stops is one step. And with `quiet` (the camera
 * is gliding to a step just restored) a change of stop alone is absorbed into the current step.
 */
export function visit(trail: Trail, spot: Spot, label: string, camera: Camera | null, now: number, options: { quiet?: boolean } = {}): Trail {
  const cur = trail.steps[trail.index];
  if (cur == null) return { steps: [{ spot, camera, label, at: now }], index: 0 };
  if (spotKey(cur.spot) === spotKey(spot)) {
    if (cur.label === label) return trail;
    return { ...trail, steps: trail.steps.map((s, i) => (i === trail.index ? { ...s, label } : s)) };
  }
  const stopOnly = sameButStop(cur.spot, spot);
  // Absorbed in place: the steps ahead (which Forward still needs) stay.
  if (stopOnly && options.quiet === true) {
    return { ...trail, steps: trail.steps.map((s, i) => (i === trail.index ? { ...cur, spot, label } : s)) };
  }
  const keep = trail.steps.slice(0, trail.index + 1);
  if (stopOnly && trail.index > 0 && now - cur.at < COALESCE_MS) {
    return { steps: [...keep.slice(0, -1), { ...cur, spot, label, at: now }], index: trail.index };
  }
  return cap([...keep, { spot, camera, label, at: now }], keep.length);
}

/** A step that is always new, even at the same place (opening a saved view, whose name is the chip's words). */
export function addStep(trail: Trail, spot: Spot, label: string, camera: Camera | null, now: number): Trail {
  const keep = trail.steps.slice(0, trail.index + 1);
  return cap([...keep, { spot, camera, label, at: now }], keep.length);
}

/** Remembers where the camera was left at the current step. */
export function withCamera(trail: Trail, camera: Camera): Trail {
  const cur = trail.steps[trail.index];
  if (cur == null) return trail;
  if (cur.camera != null && cur.camera.x === camera.x && cur.camera.y === camera.y && cur.camera.zoom === camera.zoom) return trail;
  return { ...trail, steps: trail.steps.map((s, i) => (i === trail.index ? { ...s, camera } : s)) };
}

export interface Move {
  trail: Trail;
  step: Step;
}

function walk(trail: Trail, dir: -1 | 1, ok: (step: Step) => boolean): Move | null {
  for (let i = trail.index + dir; i >= 0 && i < trail.steps.length; i += dir) {
    const step = trail.steps[i]!;
    if (ok(step)) return { trail: { ...trail, index: i }, step };
  }
  return null;
}

/** One step back, skipping any `ok` refuses (a device that has since been deleted). Null when there is none. */
export function back(trail: Trail, ok: (step: Step) => boolean = () => true): Move | null {
  return walk(trail, -1, ok);
}

export function forward(trail: Trail, ok: (step: Step) => boolean = () => true): Move | null {
  return walk(trail, 1, ok);
}

/** Straight to step `index`, as clicking its chip does. */
export function jumpTo(trail: Trail, index: number): Move | null {
  const step = trail.steps[index];
  if (step == null || index === trail.index) return null;
  return { trail: { ...trail, index }, step };
}

export interface ChipView {
  index: number;
  label: string;
  current: boolean;
}

/** The chips to draw: at most `max` steps around the current one, and how many are left out each side. */
export function chipWindow(trail: Trail, max = 5): { chips: ChipView[]; before: number; after: number } {
  const n = trail.steps.length;
  if (n === 0) return { chips: [], before: 0, after: 0 };
  const size = Math.min(max, n);
  // Keep the current chip in view, nearer the right end so the way back stays visible.
  const start = Math.max(0, Math.min(trail.index - (size - 2), n - size));
  const from = Math.max(0, start);
  const chips = trail.steps.slice(from, from + size).map((s, i) => ({ index: from + i, label: s.label, current: from + i === trail.index }));
  return { chips, before: from, after: n - (from + size) };
}

/** The words for a step, in capitals: "SWITCH-1 · FACEPLATE". `name` is what is selected, or the design's own name. */
export function stepLabel(input: { name: string; look: Look; jot: boolean; stop: CameraStop }): string {
  const parts = [input.name.trim() === '' ? 'Overview' : input.name.trim()];
  if (input.jot) parts.push('open');
  else if (levelOf(input.stop) !== 'room') parts.push(levelOf(input.stop));
  else if (input.look === 'diagram') parts.push('diagram');
  return parts.join(' · ').toUpperCase();
}

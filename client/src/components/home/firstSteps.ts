// Getting started (r15-start, approved in round 10): five first steps that tick themselves as the person does them.
// Remembered per account in this browser only; it is a convenience, so a browser that refuses storage just shows the
// list unticked. A step ticks from what a design holds, read when the person has it open; in a sample design only
// what the person does there counts (a paste, a trace), never what the sample came with.
import { parseEdgeId, parseNodeId, type Document } from '../../document/model';

export type StepId = 'device' | 'place' | 'paste' | 'cable' | 'trace';

export interface FirstStep {
  id: StepId;
  label: string;
  /** A few words beside the step, when it needs them. */
  note?: string;
}

export const FIRST_STEPS: readonly FirstStep[] = [
  { id: 'device', label: 'Add your first device' },
  { id: 'place', label: 'Put it in a rack or on a wall' },
  { id: 'paste', label: 'Paste its config', note: 'credentials never kept' },
  { id: 'cable', label: 'Connect two ports with a cable' },
  { id: 'trace', label: 'Trace a path between two devices' },
];

export interface FirstStepsState {
  done: StepId[];
  hidden: boolean;
  /** Designs opened from a sample, so their cables and devices are not the person's own steps. */
  samples: string[];
}

const EMPTY: FirstStepsState = { done: [], hidden: false, samples: [] };
const STEP_IDS = new Set<string>(FIRST_STEPS.map((s) => s.id));

const key = (accountId: string | null | undefined): string => `fathom.firstSteps.${accountId ?? 'local'}`;

export function loadFirstSteps(accountId: string | null | undefined): FirstStepsState {
  try {
    const raw = localStorage.getItem(key(accountId));
    if (raw == null) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<FirstStepsState>;
    return {
      done: Array.isArray(parsed.done) ? (parsed.done.filter((s) => STEP_IDS.has(s)) as StepId[]) : [],
      hidden: parsed.hidden === true,
      samples: Array.isArray(parsed.samples) ? parsed.samples.filter((s): s is string => typeof s === 'string') : [],
    };
  } catch {
    return EMPTY;
  }
}

function save(accountId: string | null | undefined, state: FirstStepsState): void {
  try {
    localStorage.setItem(key(accountId), JSON.stringify(state));
  } catch {
    // Storage refused: the list still shows, it just will not remember.
  }
}

export function setFirstStepsHidden(accountId: string | null | undefined, hidden: boolean): FirstStepsState {
  const next = { ...loadFirstSteps(accountId), hidden };
  save(accountId, next);
  return next;
}

export function rememberSample(accountId: string | null | undefined, designId: string): void {
  const state = loadFirstSteps(accountId);
  if (!state.samples.includes(designId)) save(accountId, { ...state, samples: [...state.samples, designId] });
}

/** The steps `doc` shows were done. A sample counts only for a paste; its devices and cables came with it. */
export function stepsIn(doc: Document, isSample: boolean): StepId[] {
  const out = new Set<StepId>();
  if (doc.provenance.some((p) => p.origin.kind === 'parsed')) out.add('paste');
  if (isSample) return [...out];
  if (doc.nodes.some((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device')) out.add('device');
  if (doc.nodes.some((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Cable')) out.add('cable');
  const placed = doc.edges.some((e) => {
    if (e.absentSince !== undefined) return false;
    const kind = parseEdgeId(e.id).kind;
    return (kind === 'MountedIn' || kind === 'SitsOn' || kind === 'FixedTo') && parseNodeId(e.from).kind === 'Chassis';
  });
  if (placed) out.add('place');
  return [...out];
}

/** Ticks what `doc` shows, plus `trace` when a trace ran; returns true when anything new ticked. */
export function recordFirstSteps(accountId: string | null | undefined, designId: string, doc: Document | null, traced: boolean): boolean {
  const state = loadFirstSteps(accountId);
  if (state.done.length === FIRST_STEPS.length) return false;
  const found = doc ? stepsIn(doc, state.samples.includes(designId)) : [];
  if (traced) found.push('trace');
  const fresh = found.filter((s) => !state.done.includes(s));
  if (fresh.length === 0) return false;
  save(accountId, { ...state, done: [...state.done, ...fresh] });
  return true;
}

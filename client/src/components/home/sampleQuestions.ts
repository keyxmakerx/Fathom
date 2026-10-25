// Ready-made questions a sample offers once it is open (card nu-vlan A): each names the device it starts from by
// hostname, so it is found again in the person's own copy, wherever they have since moved it.
import { edgesOut, fieldValue, parseNodeId, type Document } from '../../document/model';
import { samples, type SampleSpec } from './sampleNetwork';

export interface ReadyQuestion {
  ask: string;
  /** The chassis the trace starts from. */
  chassisId: string;
  to: string;
  flow: string;
}

/** The questions of every sample whose starting device is still in `doc`, each once. */
export function readyQuestions(doc: Document, specs: readonly SampleSpec[] = samples()): ReadyQuestion[] {
  const chassisByHost = new Map<string, string>();
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || parseNodeId(n.id).kind !== 'Device') continue;
    const host = fieldValue(n.fields, 'Device.hostname');
    const chassis = edgesOut(doc, n.id, 'HasChassis')[0];
    if (typeof host === 'string' && chassis && !chassisByHost.has(host)) chassisByHost.set(host, chassis.to);
  }
  const out: ReadyQuestion[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    for (const q of spec.questions ?? []) {
      const chassisId = chassisByHost.get(q.from);
      if (chassisId === undefined || seen.has(q.ask)) continue;
      seen.add(q.ask);
      out.push({ ask: q.ask, chassisId, to: q.to, flow: q.flow ?? '' });
    }
  }
  return out;
}

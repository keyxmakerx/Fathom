// Path trace (ADR-0061 item 9): the pure parts. The page composes nothing the engine did not say.
import type { TraceHop, TracePolicy, TraceResult } from '../../engine/engine';
import type { Canon } from '../checks/checksModel';

/** Words Fathom never uses as a conclusion about a flow (UI-SPEC "Inside a box"). A test holds every string
 * the panel shows against this list. */
export const VERDICT_WORDS = ['allowed', 'permitted', 'denied', 'blocked', 'reachable', 'unreachable', 'reached', 'reaches'] as const;

export interface Flow {
  protocol: number;
  port: number;
}

/** "TCP 445" or "udp 53" into a flow; empty is no flow; anything else is `null` (the box says how to write it). */
export function parseFlow(text: string): Flow | null | 'none' {
  const t = text.trim();
  if (t === '') return 'none';
  const m = /^(tcp|udp)\s*[/ ]?\s*(\d{1,5})$/i.exec(t);
  if (m == null) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { protocol: m[1]!.toLowerCase() === 'tcp' ? 6 : 17, port };
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An address typed in the far-end box: dotted IPv4 or an IPv6 literal. Empty otherwise. */
export function readAddress(text: string): string | null {
  const t = text.trim();
  const m = V4.exec(t);
  if (m != null) return m.slice(1).every((p) => Number(p) <= 255) ? t : null;
  return /^[0-9a-f:]+$/i.test(t) && t.includes(':') ? t : null;
}

/** The "Reading as" line under the far-end box. */
export function readingAs(text: string, deviceLabel: string | null): string {
  if (deviceLabel != null) return `Reading as a device: ${deviceLabel}`;
  const t = text.trim();
  if (t === '') return '';
  return readAddress(t) != null ? `Reading as an address: ${t}` : 'Not an address yet. Type an address or a device name.';
}

/** The rows a hop shows: every policy, or with the filter on only those that could affect the flow. */
export function visiblePolicies(rows: readonly TracePolicy[], onlyAffecting: boolean): TracePolicy[] {
  return onlyAffecting ? rows.filter((p) => p.couldAffect) : [...rows];
}

/** How many policy rows the filter hides on a hop. */
export function hiddenCount(hop: TraceHop, onlyAffecting: boolean): number {
  return onlyAffecting ? hop.policies.length + hop.unplaced.length - visiblePolicies(hop.policies, true).length - visiblePolicies(hop.unplaced, true).length : 0;
}

/** Canonical element key -> the hop numbers that touch it, for the canvas's numbered circles. A port counts
 * toward its device; a cable keeps its own id. */
export function hopNumbers(result: TraceResult, canon: Canon): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const hop of result.hops) {
    if (hop.kind === 'stop') continue;
    const seen = new Set<string>();
    for (const id of hop.nodes) {
      const key = canon(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.set(key, [...(out.get(key) ?? []), hop.n]);
    }
  }
  return out;
}

/** Every canonical key the path touches (the hops that name nodes). */
export function pathKeys(result: TraceResult, canon: Canon): Set<string> {
  return new Set(hopNumbers(result, canon).keys());
}

/** The sentence over the hops: where the path ended. */
export function endLine(result: TraceResult): string {
  if (result.stopped !== '') return `Could not establish: ${result.stopped}`;
  return result.hops.length > 0 ? `The walk ends at ${result.to}. The rows above are what the devices read.` : '';
}

/** The device to tie ports on when the walk stopped at an interface not tied to a port, else null. The engine's
 * stop sentence is the signal; the device is the hop just before it. */
export function untiedStop(result: TraceResult): string | null {
  if (!result.stopped.includes('is not tied to a port')) return null;
  const last = [...result.hops].reverse().find((h) => h.kind === 'device');
  return last?.nodes[0] ?? null;
}

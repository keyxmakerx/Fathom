// The sentence the canvas shows once a pasted config has been taken in, so a paste is seen to land.
// Counts only: never a value, and never a claim about what the gate guarantees.

import type { CaptureView } from '../../document/capture';

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface PastedCounts {
  /** The device it went onto; left out where the open drawer already says which. */
  hostname?: string;
  lines: number;
  interfaces: number;
  destroyed: number;
}

export function pastedNotice(c: PastedCounts): string {
  const onto = c.hostname ? ` onto ${c.hostname}` : '';
  const gate = c.destroyed > 0 ? `; ${count(c.destroyed, 'value', 'values')} destroyed at the gate` : '';
  return `Config pasted${onto}: ${count(c.lines, 'line', 'lines')}, ${count(c.interfaces, 'interface', 'interfaces')}${gate}.`;
}

/** The same counts read off a capture as the drawer draws it. */
export function countsOfCapture(capture: CaptureView): PastedCounts {
  const interfaces = new Set<string>();
  let destroyed = 0;
  for (const line of capture.lines) {
    if (line.builtInterface && line.builtLabel !== null) interfaces.add(line.builtLabel);
    destroyed += line.drops.length;
  }
  return { lines: capture.lineCount, interfaces: interfaces.size, destroyed };
}

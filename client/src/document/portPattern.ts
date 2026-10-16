// Ports by pattern (round 15, r15-qol): one line names many ports. `ge-0/0/{0-23}` is 24 ports,
// `{1-4}` counts with no padding, `{01-24}` keeps the zero padding, `{a,b,c}` lists words, and
// several braces multiply (`ge-{0-1}/0/{0-3}` is 8). Text with no brace is one port. Pure.

export const MAX_PATTERN_PORTS = 256;

export type PatternResult = { ok: true; labels: string[] } | { ok: false; reason: string };

type Part = string[];

function group(body: string): Part | string {
  const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(body);
  if (range) {
    const [, a, b] = range as unknown as [string, string, string];
    const first = Number(a);
    const last = Number(b);
    if (first > last) return `{${body}} counts down; write the smaller number first.`;
    if (last - first + 1 > MAX_PATTERN_PORTS) return `{${body}} is more than ${MAX_PATTERN_PORTS} ports.`;
    const width = a.length > 1 && a.startsWith('0') ? a.length : 0;
    const out: string[] = [];
    for (let n = first; n <= last; n += 1) out.push(String(n).padStart(width, '0'));
    return out;
  }
  if (body.includes(',')) {
    const words = body.split(',').map((w) => w.trim());
    if (words.some((w) => w === '')) return `{${body}} has an empty item.`;
    return words;
  }
  return `{${body}} is not a range like {0-23} or a list like {a,b}.`;
}

/** The labels a pattern names, in order, or why it names none. */
export function expandPortPattern(pattern: string): PatternResult {
  const text = pattern.trim();
  if (text === '') return { ok: false, reason: 'Type a port name or a pattern.' };
  const parts: Part[] = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    const close = text.indexOf('}', at);
    if (open === -1) {
      if (close !== -1) return { ok: false, reason: 'A } has no { before it.' };
      parts.push([text.slice(at)]);
      break;
    }
    if (close !== -1 && close < open) return { ok: false, reason: 'A } has no { before it.' };
    if (open > at) parts.push([text.slice(at, open)]);
    const end = text.indexOf('}', open);
    if (end === -1) return { ok: false, reason: 'A { is not closed.' };
    const g = group(text.slice(open + 1, end));
    if (typeof g === 'string') return { ok: false, reason: g };
    parts.push(g);
    at = end + 1;
  }
  let total = 1;
  for (const p of parts) total *= p.length;
  if (total > MAX_PATTERN_PORTS) return { ok: false, reason: `That is ${total} ports; one go takes at most ${MAX_PATTERN_PORTS}.` };
  let labels = [''];
  for (const p of parts) labels = labels.flatMap((l) => p.map((x) => l + x));
  const seen = new Set<string>();
  for (const l of labels) {
    if (seen.has(l)) return { ok: false, reason: `It names ${l} twice.` };
    seen.add(l);
  }
  return { ok: true, labels };
}

/** "ge-0/0/0 · ge-0/0/1 · ge-0/0/2 · … · ge-0/0/23": the first three and the last. */
export function previewLabels(labels: readonly string[]): string {
  if (labels.length <= 5) return labels.join(' · ');
  return [...labels.slice(0, 3), '…', labels[labels.length - 1]!].join(' · ');
}

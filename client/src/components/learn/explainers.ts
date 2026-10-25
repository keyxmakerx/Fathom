// Which explainers belong to a device, and how the Learn library groups them. Pure: the
// About card, the library and the glossary's "Learn more" all read from here (ADR-0066 item 1.1).

import type { Explainer } from '../../api/learn';

export const FIRST_TAB = 'read this first';

/** Linux explainers name no platform: every Linux flavour is the one registry row `linux-host`. */
function linuxFlavour(e: Explainer): boolean {
  return e.subject != null && e.subject.startsWith('linux');
}

/** The "read this first" explainers for a platform registry id, the family one first. */
export function aboutPlatform(all: readonly Explainer[], platform: string): Explainer[] {
  if (platform === '') return [];
  const firsts = all.filter((e) => e.tab === FIRST_TAB);
  if (platform === 'linux-host') {
    return firsts.filter(linuxFlavour).sort((a, b) => rank(a) - rank(b) || (a.title ?? '').localeCompare(b.title ?? ''));
  }
  return firsts.filter((e) => e.platforms.includes(platform));
}

function rank(e: Explainer): number {
  return e.subject === 'linux.family-basics' ? 0 : 1;
}

/** A heading for the library: the part of the subject before the first dot, in words. */
export function topicOf(e: Explainer): string {
  const subject = e.subject ?? '';
  if (subject.startsWith('basics.')) return 'Networking basics';
  if (subject.startsWith('linux')) return 'Linux';
  if (subject.startsWith('ipsec') || subject.startsWith('ike') || subject.startsWith('mtu') || subject.startsWith('junos.')) return 'IPsec VPNs';
  if (e.kind === 'symptom' || e.kind === 'error') return 'IPsec VPNs';
  if (subject.startsWith('arista')) return 'Arista EOS';
  if (subject.startsWith('junos-ex')) return 'Juniper EX';
  if (subject.startsWith('opnsense')) return 'OPNsense';
  if (subject.startsWith('ubiquiti')) return 'Ubiquiti';
  return 'Other';
}

/** The one-line notes the Learn layer may write on the drawing (`corpus/explainers/network-basics.yaml`). */
export const NOTE_TAB = 'learn note';

/** The library: topics in a fixed order, "read this first" entries at the top of each. */
export function library(all: readonly Explainer[]): { topic: string; entries: Explainer[] }[] {
  const order = ['Networking basics', 'Arista EOS', 'Juniper EX', 'Linux', 'OPNsense', 'Ubiquiti', 'IPsec VPNs', 'Other'];
  const groups = new Map<string, Explainer[]>();
  for (const e of all) {
    const t = topicOf(e);
    groups.set(t, [...(groups.get(t) ?? []), e]);
  }
  return order
    .filter((t) => groups.has(t))
    .map((topic) => ({
      topic,
      entries: [...groups.get(topic)!].sort((a, b) => Number(b.tab === FIRST_TAB) - Number(a.tab === FIRST_TAB)),
    }));
}

/** The title a person reads; an entry without one falls back to its subject. */
export function titleOf(e: Explainer): string {
  return e.title ?? e.subject ?? e.id;
}

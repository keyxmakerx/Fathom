// Sign-off r60: a person chooses which sections the device panel's Details tab shows, and in what order.
// The choice is kept in this browser only, like the panel's width; it changes nothing in the design.
// Device and Location always come first and always show, since every other section is about them.

import { loadJsonPref, saveJsonPref } from '../../prefs';

export const DEVICE_SECTIONS = [
  { id: 'connections', title: 'Connections' },
  { id: 'management', title: 'Management' },
  { id: 'firmware', title: 'Firmware' },
  { id: 'about', title: 'About' },
  { id: 'photo', title: 'Photo' },
] as const;

export type DeviceSectionId = (typeof DEVICE_SECTIONS)[number]['id'];

/** A section the menus open by themselves ("Open in Termix" lands in Management), so it cannot be hidden. */
export const ALWAYS_SHOWN: Readonly<Partial<Record<DeviceSectionId, string>>> = {
  management: 'Menu commands open here',
};

export interface SectionPrefs {
  order: readonly DeviceSectionId[];
  hidden: readonly DeviceSectionId[];
}

export const DEFAULT_SECTIONS: SectionPrefs = { order: DEVICE_SECTIONS.map((s) => s.id), hidden: [] };

const KNOWN = new Set<string>(DEVICE_SECTIONS.map((s) => s.id));
const isSection = (v: unknown): v is DeviceSectionId => typeof v === 'string' && KNOWN.has(v);

/**
 * Read what was stored, forgiving: unknown ids are dropped, a section added since goes at its default
 * place's end, and a section that may not be hidden is shown whatever was stored.
 */
export function parseSectionPrefs(raw: unknown): SectionPrefs {
  if (raw == null || typeof raw !== 'object') return DEFAULT_SECTIONS;
  const r = raw as { order?: unknown; hidden?: unknown };
  const stored = Array.isArray(r.order) ? r.order.filter(isSection) : [];
  const order = [...new Set(stored)];
  for (const s of DEVICE_SECTIONS) if (!order.includes(s.id)) order.push(s.id);
  const hidden = Array.isArray(r.hidden) ? [...new Set(r.hidden.filter(isSection))].filter((id) => ALWAYS_SHOWN[id] == null) : [];
  return { order, hidden };
}

/** Move a section one place up (-1) or down (+1); at an end it stays. */
export function moveSection(prefs: SectionPrefs, id: DeviceSectionId, by: -1 | 1): SectionPrefs {
  const at = prefs.order.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= prefs.order.length) return prefs;
  const order = [...prefs.order];
  [order[at], order[to]] = [order[to], order[at]];
  return { ...prefs, order };
}

/** Show or hide a section; one that may not be hidden stays shown. */
export function toggleSection(prefs: SectionPrefs, id: DeviceSectionId): SectionPrefs {
  if (ALWAYS_SHOWN[id] != null) return prefs;
  const hidden = prefs.hidden.includes(id) ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id];
  return { ...prefs, hidden };
}

const KEY = 'fathom.device-sections';

export const loadSectionPrefs = (): SectionPrefs => loadJsonPref(KEY, parseSectionPrefs, DEFAULT_SECTIONS);
export const saveSectionPrefs = (prefs: SectionPrefs): void => saveJsonPref(KEY, prefs);

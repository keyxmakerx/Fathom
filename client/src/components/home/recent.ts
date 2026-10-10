/** "Recently opened by me on this browser": designs, and devices opened in a design. Kept per
 * account in localStorage, never on the server and never a document field. */
import type { DesignSummary } from '../../api/designs';

export interface RecentDesign {
  organisationId: string;
  designId: string;
  /** Unix seconds. */
  at: number;
}

export interface RecentDevice {
  organisationId: string;
  designId: string;
  chassisId: string;
  /** The device's name when it was opened. */
  name: string;
  at: number;
}

export interface Recent {
  designs: RecentDesign[];
  devices: RecentDevice[];
}

export const EMPTY_RECENT: Recent = { designs: [], devices: [] };

/** How many of each are kept, and how many Home shows. */
export const KEEP = 12;
export const SHOW = 6;

export const recentKey = (accountId: string | null) => `fathom.recent.${accountId ?? 'anon'}`;

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keeps the entries that are whole and drops the rest. */
export function parseRecent(raw: unknown): Recent {
  if (typeof raw !== 'object' || raw === null) return EMPTY_RECENT;
  const r = raw as Record<string, unknown>;
  const designs: RecentDesign[] = [];
  for (const e of Array.isArray(r.designs) ? r.designs : []) {
    const d = e as Record<string, unknown> | null;
    if (d != null && str(d.organisationId) && str(d.designId) && num(d.at)) designs.push({ organisationId: d.organisationId, designId: d.designId, at: d.at });
  }
  const devices: RecentDevice[] = [];
  for (const e of Array.isArray(r.devices) ? r.devices : []) {
    const d = e as Record<string, unknown> | null;
    if (d != null && str(d.organisationId) && str(d.designId) && str(d.chassisId) && typeof d.name === 'string' && num(d.at)) {
      devices.push({ organisationId: d.organisationId, designId: d.designId, chassisId: d.chassisId, name: d.name, at: d.at });
    }
  }
  return { designs: designs.slice(0, KEEP), devices: devices.slice(0, KEEP) };
}

/** Puts an entry first, replacing any earlier one for the same thing. */
export function withDesign(recent: Recent, entry: RecentDesign): Recent {
  const rest = recent.designs.filter((d) => d.designId !== entry.designId);
  return { ...recent, designs: [entry, ...rest].slice(0, KEEP) };
}

export function withDevice(recent: Recent, entry: RecentDevice): Recent {
  const rest = recent.devices.filter((d) => !(d.designId === entry.designId && d.chassisId === entry.chassisId));
  return { ...recent, devices: [entry, ...rest].slice(0, KEEP) };
}

export interface RecentView {
  designs: { design: DesignSummary; at: number }[];
  devices: { design: DesignSummary; device: RecentDevice }[];
}

/** What Home shows for one organisation: newest first, only what this account can still see (the
 * designs the server listed), at most `SHOW` of each. */
export function visibleRecent(recent: Recent, organisationId: string, listed: readonly DesignSummary[], show: number = SHOW): RecentView {
  const byId = new Map(listed.map((d) => [d.designId, d] as const));
  const designs: RecentView['designs'] = [];
  for (const e of [...recent.designs].sort((a, b) => b.at - a.at)) {
    const design = byId.get(e.designId);
    if (e.organisationId === organisationId && design != null && designs.length < show) designs.push({ design, at: e.at });
  }
  const devices: RecentView['devices'] = [];
  for (const e of [...recent.devices].sort((a, b) => b.at - a.at)) {
    const design = byId.get(e.designId);
    if (e.organisationId === organisationId && design != null && devices.length < show) devices.push({ design, device: e });
  }
  return { designs, devices };
}

/** Forgets what the server no longer lists for this organisation (deleted, or access gone). */
export function pruned(recent: Recent, organisationId: string, listed: readonly DesignSummary[]): Recent {
  const ids = new Set(listed.map((d) => d.designId));
  const keep = (e: { organisationId: string; designId: string }) => e.organisationId !== organisationId || ids.has(e.designId);
  return { designs: recent.designs.filter(keep), devices: recent.devices.filter(keep) };
}

export function pruneRecent(accountId: string | null, organisationId: string, listed: readonly DesignSummary[]): void {
  const now = loadRecent(accountId);
  const next = pruned(now, organisationId, listed);
  if (next.designs.length !== now.designs.length || next.devices.length !== now.devices.length) save(accountId, next);
}

export function loadRecent(accountId: string | null): Recent {
  try {
    const raw = localStorage.getItem(recentKey(accountId));
    if (raw != null) return parseRecent(JSON.parse(raw));
  } catch {
    // storage unavailable or damaged: nothing recent
  }
  return EMPTY_RECENT;
}

function save(accountId: string | null, recent: Recent): void {
  try {
    localStorage.setItem(recentKey(accountId), JSON.stringify(recent));
  } catch {
    // not remembered
  }
}

export function recordDesignOpen(accountId: string | null, organisationId: string, designId: string, now: number = Math.floor(Date.now() / 1000)): void {
  save(accountId, withDesign(loadRecent(accountId), { organisationId, designId, at: now }));
}

export function recordDeviceOpen(accountId: string | null, organisationId: string, designId: string, chassisId: string, name: string, now: number = Math.floor(Date.now() / 1000)): void {
  save(accountId, withDevice(loadRecent(accountId), { organisationId, designId, chassisId, name, at: now }));
}

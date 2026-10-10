// Faceplate templates: a saved set of hand-typed ports (a 24-port keystone panel, say) to start a
// new box from. Kept per person in this browser, keyed by account, like Inventory's "Mine" views:
// there is nowhere on the server yet to keep something a person makes up. Never a document field.

import { useCallback, useSyncExternalStore } from 'react';

import { PORT_CONNECTOR_VALUES, PORT_SERVICE_VALUES } from '../../document/compat';
import { clampPlate, type TemplatePort } from '../../document/plate';
import type { ChassisView } from '../../document/view';

export interface FaceplateTemplate {
  id: string;
  name: string;
  /** The box's role when it was saved, so a box started from it is named like one; null when it had none. */
  role: string | null;
  ports: TemplatePort[];
}

const MAX_TEMPLATES = 50;

export function storeKey(accountId: string | null): string {
  return `fathom.faceplateTemplates.${accountId ?? 'anon'}`;
}

/** The hand-typed ports of a box as a template. Catalogue ports are left out: the catalogue keeps those. */
export function captureTemplate(id: string, name: string, chassis: Pick<ChassisView, 'ports' | 'role'>): FaceplateTemplate {
  const ports: TemplatePort[] = chassis.ports
    .filter((p) => p.rowKind === undefined)
    .map((p) => {
      const port: TemplatePort = { label: p.label, connector: (PORT_CONNECTOR_VALUES as readonly string[]).includes(p.connector) ? p.connector : 'other', face: p.face };
      if (p.service != null && (PORT_SERVICE_VALUES as readonly string[]).includes(p.service)) port.service = p.service;
      if (p.plate != null) port.plate = { x: clampPlate(p.plate.x), y: clampPlate(p.plate.y) };
      return port;
    });
  return { id, name: name.trim() || 'My faceplate', role: chassis.role ?? null, ports };
}

function isPort(x: unknown): x is TemplatePort {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  if (typeof p.label !== 'string' || typeof p.connector !== 'string' || (p.face !== 'front' && p.face !== 'rear')) return false;
  if (p.service !== undefined && typeof p.service !== 'string') return false;
  if (p.plate !== undefined) {
    const at = p.plate as Record<string, unknown> | null;
    if (at === null || typeof at !== 'object' || typeof at.x !== 'number' || typeof at.y !== 'number') return false;
  }
  return true;
}

/** Whatever is stored, read defensively: anything malformed is dropped, never trusted. */
export function parseTemplates(raw: string | null): FaceplateTemplate[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (t): t is FaceplateTemplate =>
          typeof t === 'object' && t !== null && typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.ports) && t.ports.every(isPort),
      )
      .map((t) => ({ id: t.id, name: t.name, role: typeof t.role === 'string' ? t.role : null, ports: t.ports }));
  } catch {
    return [];
  }
}

/** Adds a template, replacing one of the same name. */
export function withTemplate(list: readonly FaceplateTemplate[], t: FaceplateTemplate): FaceplateTemplate[] {
  return [...list.filter((x) => x.name !== t.name), t].slice(-MAX_TEMPLATES);
}

export const withoutTemplate = (list: readonly FaceplateTemplate[], id: string): FaceplateTemplate[] => list.filter((t) => t.id !== id);

// ---- the browser store, shared by every view that shows templates ----

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; list: FaceplateTemplate[] }>();
const EMPTY: FaceplateTemplate[] = [];

function read(key: string): FaceplateTemplate[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    raw = null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.list;
  const list = raw === null ? EMPTY : parseTemplates(raw);
  cache.set(key, { raw, list });
  return list;
}

function write(key: string, list: readonly FaceplateTemplate[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage can be blocked; the template then lasts only this visit.
    cache.set(key, { raw: null, list: [...list] });
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = () => listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export interface TemplateStore {
  templates: readonly FaceplateTemplate[];
  save: (t: FaceplateTemplate) => void;
  remove: (id: string) => void;
}

/** This person's templates in this browser, live across every view that shows them. */
export function useFaceplateTemplates(accountId: string | null): TemplateStore {
  const key = storeKey(accountId);
  const templates = useSyncExternalStore(subscribe, () => read(key), () => EMPTY);
  const save = useCallback((t: FaceplateTemplate) => write(key, withTemplate(read(key), t)), [key]);
  const remove = useCallback((id: string) => write(key, withoutTemplate(read(key), id)), [key]);
  return { templates, save, remove };
}

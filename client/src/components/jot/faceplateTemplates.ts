// Faceplate templates: a saved set of hand-typed ports (a 24-port keystone panel, say) to start a
// new box from. Never a document field. Since sign-off r114 they live on the server, one shared
// list per organisation, sealed (`api/faceplateTemplates.ts`, migration 0076). Templates this
// browser kept per account before then are sent up once and the browser copy cleared. With no
// organisation (no server to ask) the old per-account browser store is used.

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { ApiRefusal } from '../../api/errors';
import { createTemplate, deleteTemplate, fetchTemplates } from '../../api/faceplateTemplates';

import { PORT_CONNECTOR_VALUES, PORT_SERVICE_VALUES, isPortFace } from '../../document/compat';
import { clampPlate, type TemplatePort } from '../../document/plate';
import type { ChassisView } from '../../document/view';
import { readPref, writePref } from '../../prefs';
import { ACCOUNT_PLANE, getSessionOn, subscribe as subscribeSession } from '../../state/sessionState';

export interface FaceplateTemplate {
  id: string;
  name: string;
  /** The box's role when it was saved, so a box started from it is named like one; null when it had none. */
  role: string | null;
  ports: TemplatePort[];
  /** Who saved it, on the server; absent for one kept in this browser. */
  createdBy?: string;
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
  if (typeof p.label !== 'string' || typeof p.connector !== 'string' || !isPortFace(p.face)) return false;
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

// ---- the store, shared by every view that shows templates ----

const listeners = new Set<() => void>();
const EMPTY: FaceplateTemplate[] = [];

function notify(): void {
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

// -- in this browser, for a session with no organisation --

const cache = new Map<string, { raw: string | null; list: FaceplateTemplate[] }>();

function read(key: string): FaceplateTemplate[] {
  const raw = readPref(key);
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
  notify();
}

function forget(key: string): void {
  writePref(key, null);
  cache.delete(key);
}

// -- on the server, one shared list per organisation --

interface OrgEntry {
  list: FaceplateTemplate[];
  loading: boolean;
  error: string | null;
}

const orgs = new Map<string, OrgEntry>();
const ORG_EMPTY: OrgEntry = { list: EMPTY, loading: true, error: null };

function setOrg(organisationId: string, change: Partial<OrgEntry>): void {
  orgs.set(organisationId, { ...(orgs.get(organisationId) ?? ORG_EMPTY), ...change });
  notify();
}

/** The server's ports go through the same defensive reading as the browser's ever did. */
function fromServer(raw: readonly { id: string; createdBy: string }[]): FaceplateTemplate[] {
  const makers = new Map(raw.map((t) => [t.id, t.createdBy]));
  return parseTemplates(JSON.stringify(raw)).map((t) => {
    const by = makers.get(t.id);
    return by ? { ...t, createdBy: by } : t;
  });
}

function refusalWords(e: unknown, what: 'save' | 'delete'): string {
  if (e instanceof ApiRefusal && e.status === 403) {
    return what === 'delete'
      ? 'Only the person who saved it, or a Steward, can delete it.'
      : 'Saving a template needs Draw somewhere in this organisation.';
  }
  return what === 'delete' ? 'That template could not be deleted. Try again.' : 'That template could not be saved. Try again.';
}

const started = new Set<string>();

/** Loads the organisation's list, sending up anything this browser still keeps for the account first. */
export async function loadOrganisationTemplates(organisationId: string, accountId: string | null): Promise<void> {
  try {
    let list = fromServer(await fetchTemplates(organisationId));
    const key = storeKey(accountId);
    const local = read(key);
    let kept = 0;
    for (const t of local) {
      if (list.some((x) => x.name === t.name && x.ports.length === t.ports.length)) continue;
      try {
        const made = await createTemplate(organisationId, { name: t.name, role: t.role, ports: t.ports });
        list = [...list, ...fromServer([made])];
      } catch {
        kept += 1;
      }
    }
    // Once every one is on the server the browser copy goes (sign-off r114 pick A). One the
    // server refused stays here, and is tried again next time.
    if (local.length > 0 && kept === 0) forget(key);
    setOrg(organisationId, {
      list,
      loading: false,
      error: kept > 0 ? `${kept === 1 ? 'One template' : `${kept} templates`} kept in this browser could not be moved to the server.` : null,
    });
  } catch {
    started.delete(organisationId);
    setOrg(organisationId, { loading: false, error: 'Templates could not be loaded. Reopen this to try again.' });
  }
}

export interface TemplateStore {
  templates: readonly FaceplateTemplate[];
  save: (t: FaceplateTemplate) => void;
  remove: (id: string) => void;
  /** What went wrong with the last load, save or delete, in words; null when nothing did. */
  error: string | null;
  /** True when the list is the organisation's shared one on the server. */
  shared: boolean;
}

export interface TemplateOwner {
  organisationId: string | null;
  accountId: string | null;
}

/** The organisation's templates (or, with no organisation, this person's in this browser), live
 * across every view that shows them. */
export function useFaceplateTemplates(owner: TemplateOwner): TemplateStore {
  const { organisationId, accountId } = owner;
  const key = storeKey(accountId);
  const entry = useSyncExternalStore(
    subscribe,
    () => (organisationId === null ? null : (orgs.get(organisationId) ?? ORG_EMPTY)),
    () => null,
  );
  const localList = useSyncExternalStore(subscribe, () => (organisationId === null ? read(key) : EMPTY), () => EMPTY);

  useEffect(() => {
    if (organisationId === null || started.has(organisationId)) return;
    started.add(organisationId);
    void loadOrganisationTemplates(organisationId, accountId);
  }, [organisationId, accountId]);

  const save = useCallback(
    (t: FaceplateTemplate) => {
      if (organisationId === null) {
        write(key, withTemplate(read(key), t));
        return;
      }
      const list = (orgs.get(organisationId) ?? ORG_EMPTY).list;
      // Saving under a name of your own replaces it, as the browser store always did.
      const mine = list.find((x) => x.name === t.name.trim() && x.createdBy === accountId);
      createTemplate(organisationId, { name: t.name, role: t.role, ports: t.ports, ...(mine ? { replaces: mine.id } : {}) }).then(
        (made) => {
          const now = (orgs.get(organisationId) ?? ORG_EMPTY).list.filter((x) => x.id !== mine?.id);
          setOrg(organisationId, { list: [...now, ...fromServer([made])], error: null });
        },
        (e: unknown) => setOrg(organisationId, { error: refusalWords(e, 'save') }),
      );
    },
    [organisationId, accountId, key],
  );
  const remove = useCallback(
    (id: string) => {
      if (organisationId === null) {
        write(key, withoutTemplate(read(key), id));
        return;
      }
      deleteTemplate(organisationId, id).then(
        () => setOrg(organisationId, { list: withoutTemplate((orgs.get(organisationId) ?? ORG_EMPTY).list, id), error: null }),
        (e: unknown) => setOrg(organisationId, { error: refusalWords(e, 'delete') }),
      );
    },
    [organisationId, key],
  );
  if (entry === null) return { templates: localList, save, remove, error: null, shared: false };
  return { templates: entry.list, save, remove, error: entry.error, shared: true };
}

/** The organisation's list as loaded so far, and any error, outside React. */
export function organisationTemplates(organisationId: string): { templates: readonly FaceplateTemplate[]; error: string | null } {
  const e = orgs.get(organisationId) ?? ORG_EMPTY;
  return { templates: e.list, error: e.error };
}

/** For tests: forget every organisation's list so the next hook loads afresh. */
export function resetTemplateStoreForTests(): void {
  forgetAll();
}

function forgetAll(): void {
  orgs.clear();
  started.clear();
  cache.clear();
}

// What another person's session loaded never shows to the next one in this tab: the memory copy
// goes when the account signs out or another signs in.
let heldAccount: string | null = getSessionOn(ACCOUNT_PLANE)?.accountId ?? null;
subscribeSession(() => {
  const now = getSessionOn(ACCOUNT_PLANE)?.accountId ?? null;
  if (now !== heldAccount) {
    heldAccount = now;
    forgetAll();
  }
});

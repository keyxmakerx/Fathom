// Termix's maintenance window and its up or down, for a plan's devices (ADR-0080 decisions 6 and 7).
// Both are Termix's own; Fathom only asks. Without Termix, or without its Automations add-on, the plan
// shows a line reminding the person to pause their own alerting, and nothing says up or down (Fathom
// does not ping).
//
// What Termix offers, read from its source on 1 November 2026 (CLAUDE.md rule 1):
// - Automations 1.2.0 (`Termix-SSH/Plugin-Automations` `4468c55`, `src/backend/maintenance-routes.ts`):
//   `POST /plugin-api/automations/maintenance/{hostId}` {action: start | schedule | end | remove,
//   reason, durationMinutes}. 403 when the host was shared with the caller: only its owner may change
//   it. While a host is in maintenance, automations triggered by its status, health checks, metrics,
//   Docker or tunnels do not fire for it. `maintenance-time.ts` `parsePlan`: a start needs a reason of
//   1 to 200 characters, durationMinutes 1 to 10080, graceMinutes 0 to 1440 and notifyOverdue, and
//   `maintenance-service.ts`: a second start on an active host is refused, and `end` clears the active
//   window whatever its reasons, so Fathom ends only a window whose one reason is the plan's.
//   `GET /plugin-api/automations/maintenance/{hostId}` answers `{ active: { reasons, ... } | null }`.
// - core v26.10.6 (`c759a14`, `src/backend/database/routes/host-status-routes.ts`):
//   `GET /host/status?hostIds=1,2` answers `{ "<id>": { status: online | reachable | offline,
//   lastChecked } }` for the hosts the caller may see.

import { TermixError, type TermixHost, call } from './termix';

export const AUTOMATIONS = 'automations';

type Fetch = typeof fetch;

export interface WindowResult {
  done: number;
  /** Already in maintenance (start), or in maintenance for other reasons too, or not at all (end): left as it is. */
  left: number;
  /** Shared with this Termix user, so only the host's owner could change it. */
  notOwned: number;
  failed: number;
}

/** A plan with no window is put in maintenance for an hour; Termix wants a length. */
export const DEFAULT_MINUTES = 60;

/** Minutes between the plan's window start and end, when both are set and in order, within Termix's 1 to 10080. */
export function windowMinutes(start: string, end: string): number | null {
  if (start === '' || end === '') return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.min(10080, Math.max(1, Math.round(ms / 60_000))) : null;
}

/** Termix's reason for the plan's window: the plan's name, 1 to 200 characters. */
export const windowReason = (title: string): string => `Fathom: ${title.trim() || 'a plan'}`.slice(0, 200);

/** Starts or ends maintenance on each host. A shared host is skipped and counted; a refused key stops the run. */
export async function setMaintenance(
  origin: string,
  key: string,
  hostIds: readonly number[],
  how: { action: 'start' | 'end'; reason: string; durationMinutes?: number },
  f: Fetch = fetch,
): Promise<WindowResult> {
  const out: WindowResult = { done: 0, left: 0, notOwned: 0, failed: 0 };
  const path = (id: number) => `/plugin-api/automations/maintenance/${id}`;
  const body =
    how.action === 'start'
      ? { action: 'start', reason: how.reason, durationMinutes: how.durationMinutes ?? DEFAULT_MINUTES, graceMinutes: 0, notifyOverdue: false }
      : { action: 'end' };
  for (const id of hostIds) {
    try {
      const now = (await call(origin, key, 'GET', path(id), undefined, f)) as { active?: { reasons?: unknown } | null; owned?: unknown } | null;
      if (now?.owned === false) {
        out.notOwned++;
        continue;
      }
      const reasons = Array.isArray(now?.active?.reasons) ? (now.active.reasons as unknown[]) : null;
      // Start: a host already in maintenance keeps its window. End: only a window that is the plan's alone.
      const mine = reasons !== null && reasons.length === 1 && reasons[0] === how.reason;
      if (how.action === 'start' ? reasons !== null : !mine) {
        out.left++;
        continue;
      }
      await call(origin, key, 'POST', path(id), body, f);
      out.done++;
    } catch (e) {
      if (e instanceof TermixError && e.status === 401) throw e;
      if (e instanceof TermixError && e.status === 403) out.notOwned++;
      else out.failed++;
    }
  }
  return out;
}

export function windowSummary(r: WindowResult, action: 'start' | 'end'): string {
  const verb = action === 'start' ? 'Put' : 'Took';
  const where = action === 'start' ? 'into maintenance in Termix' : 'out of maintenance in Termix';
  const parts = [`${verb} ${r.done} ${r.done === 1 ? 'device' : 'devices'} ${where}`];
  if (r.left) parts.push(`${r.left} left as ${r.left === 1 ? 'it was' : 'they were'}, ${action === 'start' ? 'already in maintenance' : 'in maintenance for another reason too, or not at all'}`);
  if (r.notOwned) parts.push(`${r.notOwned} ${r.notOwned === 1 ? 'is' : 'are'} shared with you there, so only ${r.notOwned === 1 ? 'its' : 'their'} owner can`);
  if (r.failed) parts.push(`${r.failed} could not be changed`);
  return parts.join('; ') + '.';
}

export type HostState = 'online' | 'reachable' | 'offline';

/** Termix's word for each, labelled as Termix's where it is shown. */
export const HOST_STATE_WORD: Readonly<Record<HostState, string>> = { online: 'up', reachable: 'reachable', offline: 'down' };

/** Termix's up or down for these hosts, by host id. A host Termix does not answer for is left out. */
export async function hostStatus(origin: string, key: string, hostIds: readonly number[], f: Fetch = fetch): Promise<Map<number, HostState>> {
  const out = new Map<number, HostState>();
  if (hostIds.length === 0) return out;
  const got = await call(origin, key, 'GET', `/host/status?hostIds=${hostIds.join(',')}`, undefined, f);
  if (got === null || typeof got !== 'object') return out;
  for (const [id, entry] of Object.entries(got as Record<string, unknown>)) {
    const s = (entry as { status?: unknown } | null)?.status;
    const n = Number(id);
    if (Number.isSafeInteger(n) && (s === 'online' || s === 'reachable' || s === 'offline')) out.set(n, s);
  }
  return out;
}

/** The Termix host for each address, by address. */
export function hostsByAddress(hosts: readonly TermixHost[], addresses: readonly string[], match: (h: TermixHost[], a: string) => TermixHost | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of addresses) {
    const h = a.trim() === '' ? null : match([...hosts], a);
    if (h) out.set(a, h.id);
  }
  return out;
}

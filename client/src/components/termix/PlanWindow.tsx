// Start work opens a Termix maintenance window for the plan's devices; Record ends it (ADR-0080 decision
// 6). It is a choice, ticked by default when Termix runs its Automations add-on, and the plan always says
// the plain way beside it: pause your own alerting. What happened is said once, in the plan, for this tab.

import { useState, useSyncExternalStore } from 'react';

import type { Plan } from '../../document/plans';
import { AUTOMATIONS, setMaintenance, windowMinutes, windowReason, windowSummary } from './maintenance';
import type { ReachableDevice } from './planDevices';
import { hostIdsFor } from './snippets';
import { listHosts } from './termix';
import { useAddOns, useTermixKey } from './useAddOns';
import { useTermix } from './useTermix';
import './termix.css';

// What Termix said about a plan's window, for this tab: shown in Do and Record, never stored.
const said = new Map<string, string>();
const listeners = new Set<() => void>();
const say = (planId: string, text: string) => {
  said.set(planId, text);
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ticked unless the person unticks it; one choice per plan, for this tab. */
const unticked = new Set<string>();

export function useTermixWindow(plan: Plan, devices: readonly ReachableDevice[]) {
  const { url: origin } = useTermix();
  const key = useTermixKey();
  const addOns = useAddOns(origin);
  const [on, setOn] = useState(() => !unticked.has(plan.id));
  const offered = origin !== null && (addOns === null || addOns.has(AUTOMATIONS));
  const run = async (action: 'start' | 'end') => {
    if (!origin || !offered || !on || devices.length === 0) return;
    if (!key) {
      say(plan.id, 'No Termix API key is pasted in this tab, so Termix’s maintenance window was not changed. Paste one under Open in Termix.');
      return;
    }
    try {
      const ids = hostIdsFor(await listHosts(origin, key), devices.map((d) => d.address));
      const minutes = windowMinutes(plan.windowStart, plan.windowEnd);
      const r = await setMaintenance(origin, key, ids, { action, reason: windowReason(plan.title), ...(minutes !== null ? { durationMinutes: minutes } : {}) });
      const missing = devices.length - ids.length;
      say(plan.id, windowSummary(r, action) + (missing > 0 ? ` ${missing} ${missing === 1 ? 'is' : 'are'} not in Termix.` : ''));
    } catch (e) {
      say(plan.id, e instanceof Error ? e.message : String(e));
    }
  };
  return {
    /** The choice, shown before Start work. */
    choice:
      origin === null ? null : !offered ? (
        <p className="termix__hint" data-testid="termix-window-off">
          This Termix does not run its Automations add-on, so no maintenance window is opened there.
        </p>
      ) : (
        <label className="termix-window" data-testid="termix-window">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              setOn(e.target.checked);
              if (e.target.checked) unticked.delete(plan.id);
              else unticked.add(plan.id);
            }}
          />{' '}
          Put the plan’s devices into maintenance in Termix when work starts, and take them out on Record
          {windowMinutes(plan.windowStart, plan.windowEnd) === null ? ' (for an hour: the plan has no window)' : ''}
        </label>
      ),
    started: () => run('start'),
    recorded: () => run('end'),
  };
}

/** The plain way, always there: Fathom does not pause anyone's alerting. */
export function AlertingReminder() {
  return (
    <p className="plans-note" data-testid="alerting-reminder">
      Before you start, pause alerting for these devices in your own monitoring. Fathom does not do it.
    </p>
  );
}

/** What Termix said about this plan's window, in this tab. */
export function WindowNote({ planId }: { planId: string }) {
  const read = () => said.get(planId) ?? null;
  const text = useSyncExternalStore(subscribe, read, read);
  if (text === null) return null;
  return (
    <p className="termix__hint" role="status" data-testid="termix-window-said">
      {text}
    </p>
  );
}

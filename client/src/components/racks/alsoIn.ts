// Sign-off r60: "Also in" on a device's panel: the plans, checks and AI ideas that name the device, so a
// person sees from the device what else is about it. Pure; the section is `AlsoIn.tsx`.

import { touchedBy, type Plan } from '../../document/plans';
import type { CheckFinding } from '../../engine/engine';

export interface AlsoInLists {
  plans: Plan[];
  findings: CheckFinding[];
  /** An open AI idea names it. */
  ideas: boolean;
}

/** `ids` are the device's own ids: its device, chassis, ports and cards; a plan or a finding may name any of them. */
export function alsoInOf(ids: ReadonlySet<string>, plans: readonly Plan[], findings: readonly CheckFinding[], aiTargets: ReadonlySet<string>): AlsoInLists {
  return {
    // A recorded plan is history; the History tab shows it.
    plans: plans.filter((p) => p.stage !== 'recorded' && touchedBy(p).some((id) => ids.has(id))),
    findings: findings.filter((f) => f.elements.some((e) => ids.has(e.id))),
    ideas: [...ids].some((id) => aiTargets.has(id)),
  };
}

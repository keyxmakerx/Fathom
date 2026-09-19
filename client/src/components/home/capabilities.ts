// Home's own capability gate for the "New scope" action. `canDrawFor`
// (`components/design/useDesignSession.ts`) already answers the drawing
// question — "capability !== 'read'" — and fails OPEN for a capability this
// client does not recognise, per ADR-0052 §5's reasoning: losing every save
// on an unrecognised value would be worse than drawing with one. Creating a
// scope is not that trade: nothing is lost by refusing an unrecognised
// capability the steward action, and granting it by mistake would let an
// account create structure it was never given the standing to create. So
// this fails CLOSED — the one asymmetry from `canDrawFor` worth its own
// file and its own test.

import type { DesignCapability } from '../../api/designs';

/** `authority.rs`'s `Capability::as_str` — `"steward"` is the one value
 * this returns `true` for. Any other string, including one this client does
 * not yet recognise, is refused rather than guessed open. */
export function canStewardFor(capability: DesignCapability): boolean {
  return capability === 'steward';
}

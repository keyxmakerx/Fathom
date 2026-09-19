// ADR-0046 §3: "An account with exactly one place to go lands there
// directly." Home cannot itself navigate — it is a body the shell's
// caller places below its own bar (see `Home.tsx`'s own doc) — so this is
// pure decision logic the component calls and hands to a caller-supplied
// callback, kept apart from any rendering so it is testable without a DOM.
//
// "Exactly one place" is read here as: exactly one organisation to choose
// between, AND, within it, exactly one design to choose between. Anything
// else (more than one organisation; one organisation with zero or several
// designs) is still a choice, so Home renders its list.

import type { DesignSummary } from '../../api/designs';
import type { Organisation } from '../../api/organisations';

export interface DirectEntry {
  organisation: Organisation;
  design: DesignSummary;
}

/**
 * `organisations` is every organisation the account belongs to.
 * `designsInSoleOrganisation` is the design list for that one organisation
 * — pass `null` while it has not loaded yet (or when there is more than
 * one organisation and so it was never fetched for this purpose), which
 * this function treats as "not yet known" rather than "zero", so it never
 * fires on a page that has not finished loading.
 */
export function pickDirectEntry(
  organisations: readonly Organisation[],
  designsInSoleOrganisation: readonly DesignSummary[] | null,
): DirectEntry | null {
  if (organisations.length !== 1) {
    return null;
  }
  if (designsInSoleOrganisation === null || designsInSoleOrganisation.length !== 1) {
    return null;
  }
  return { organisation: organisations[0], design: designsInSoleOrganisation[0] };
}

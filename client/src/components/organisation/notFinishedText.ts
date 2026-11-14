/**
 * What the "Not finished" Steward pages say (alpha, 2026-11-12). Plain words, checked against
 * `docs/STATE.md` (the IP plan store) and `docs/decisions/` ADR-0085 (email). When a real
 * screen lands, delete its lines here and drop `notFinished` in `stewardRail.ts`. Order types
 * landed on 2026-11-14 (`components/orders/`).
 */

export const IP_PLAN_WORKS: readonly string[] = [
  'The server keeps an IP plan for the organisation: address blocks, prefixes, ranges, addresses, VLANs and AS numbers.',
  'It can hand out the next free prefix, address, VLAN or AS number, and hold a reservation for 30 days.',
  'Each design’s own Prefixes and VLANs tables, in Inventory, are finished and are separate from this.',
];
export const IP_PLAN_MISSING: readonly string[] = [
  'No screen to see or change the organisation’s IP plan.',
  'No check that a design matches the plan.',
  'No NetBox files in or out.',
];

export const MAIL_WORKS: readonly string[] = [
  'An operator can save mail settings in the console. They are stored sealed and never shown again.',
  'Every screen that needs mail says so, and says what to do instead.',
];
export const MAIL_MISSING: readonly string[] = [
  'Nothing is sent. The test message gives an error, and there is no reset or notice by mail.',
  'Invitations are not emailed: a Steward hands the link over in person or by a message they choose.',
  'No place here to choose what Fathom tells people about.',
];

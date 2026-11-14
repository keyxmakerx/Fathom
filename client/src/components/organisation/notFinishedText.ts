/**
 * What the "Not finished" Steward pages say (alpha, 2026-11-12). Plain words, checked against
 * `docs/STATE.md` (orders) and `docs/decisions/` ADR-0085 (email). When a real
 * screen lands, delete its lines here and drop `notFinished` in `stewardRail.ts`.
 */

export const ORDER_TYPES_WORKS: readonly string[] = [
  'Fathom can read an order type written as a file and tell you every problem with it, line by line.',
  'The server keeps order types and orders, and works out each order’s jobs and sign-offs.',
  'Starter order types are in the corpus folder: a dedicated internet circuit, a new site build, taking a service out.',
];
export const ORDER_TYPES_MISSING: readonly string[] = [
  'No screen to write an order type, open an order or sign one off.',
  'No overdue clock.',
  'An order does not yet stop a clash with another plan.',
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

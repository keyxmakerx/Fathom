// Where an invitation is redeemed, spelled out for the operator who has to
// hand it over.
//
// ADR-0056 decision 6: *"invitations are redeemed at their own address carried
// by the invitation (`/invite#<token>`, the token in the fragment so it never
// reaches a log), and the console shows that address next to the token it
// minted; no link under sign-in."* The board minted the token and then showed
// the token alone, so the operator had to know that a bare `inv_…` is pasted
// into a screen they had no address for. This is that address.
//
// A pure function in its own module for the reason the rest of this client's
// copy helpers are: the test runner is `environment: 'node'`, and the part
// worth testing here is a string.
//
// Written 2026-09-22.

/**
 * The address an invitation token is redeemed at.
 *
 * **The token goes after the `#` and nowhere else.** A fragment is not sent
 * with the request, so it cannot appear in an access log, a proxy log or a
 * `Referer` header — which is the whole reason decision 6 puts it there, and
 * the reason this function does not offer a query-string form.
 *
 * `origin` is `window.location.origin` at the call site. An empty origin
 * (server-side render, or a browser that has none) yields a path-only
 * address, which is still the right thing to paste into the same browser and
 * is never a wrong host.
 */
export function invitationAddress(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite#${token}`;
}

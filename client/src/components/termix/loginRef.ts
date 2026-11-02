// Logins by reference, never by value (ADR-0080 decision 3). A device whose login was pulled from an
// outside Vaultwarden (ADR-0071 part four) goes to Termix with its password field set to a reference,
// `bw://<item id>/password`. The reference names an item; it is not the secret. Termix's Secret
// Sources add-on resolves it in its own `bw serve` at connect time, and only if Termix's operator
// connected it to a vault that can see that item. Fathom never reads the password to do this.
//
// What Termix offers, read from its source on 1 November 2026 (CLAUDE.md rule 1):
// - core v26.10.6 (`c759a14`), `src/backend/hosts/external-secrets.ts`: a host's `password`, `key`,
//   `keyPassword`, `sudoPassword` and `socks5Password` may hold `<scheme>://...`, resolved through
//   whichever add-on registered the scheme; a user name is not one of those fields.
// - Secret Sources 1.1.0 (`Termix-SSH/Plugin-Secret-Sources` `8088014`),
//   `src/backend/providers/bitwarden-cli.ts`: `bw://<item name or id>/<field>`, field `password`
//   among others; an id of UUID shape is fetched directly (`/object/item/<id>`), so no name search.
// Secret Server and Passbolt have no scheme in Secret Sources 1.1.0, and Fathom's own vault (modes A
// and B) has none by design, so those logins never go to Termix.

import type { OutsideConnection } from '../../api/vault';

/** The Termix add-on that resolves references. Its button hides when Termix does not run it. */
export const SECRET_SOURCES = 'secret-sources';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `bw://<id>/password` for a Vaultwarden item id; null for anything that is not one. */
export function bitwardenReference(cipherId: string): string | null {
  const id = cipherId.trim();
  return UUID.test(id) ? `bw://${id.toLowerCase()}/password` : null;
}

/** Whether a value is exactly a reference Fathom makes, so nothing else is ever sent as a password. */
export function isOurReference(value: string): boolean {
  return /^bw:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/password$/.test(value);
}

export interface LoginReference {
  /** `bw://<id>/password`. */
  reference: string;
  /** The item's name, as the vault shows it to the people who may use it. */
  name: string;
}

/**
 * The outside Vaultwarden login marked as used on this device, when there is exactly one the caller
 * can see in a connection that is on. Two would be a guess, so none is offered then.
 */
export function referenceFor(outside: readonly OutsideConnection[], design: string, element: string): LoginReference | null {
  const found: LoginReference[] = [];
  for (const c of outside) {
    if (c.provider !== 'vaultwarden' || c.state !== 'on') continue;
    for (const i of c.items) {
      if (i.state !== 'on' || !i.usedOn.some((u) => u.design === design && u.element === element)) continue;
      const reference = bitwardenReference(i.cipherId);
      if (reference) found.push({ reference, name: i.name });
    }
  }
  return found.length === 1 ? found[0]! : null;
}

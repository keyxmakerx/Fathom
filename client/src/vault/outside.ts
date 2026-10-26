// Connecting an outside vault (ADR-0071 part four): what the person's browser does with the
// account's master password, once. The server signed in with the API key and handed over the
// account's sealed keys (`outsidePrepare`); this opens them, finds the organisation key of the
// one collection the account sees, and checks that key against the collection's sealed name.
// Only that organisation key goes back to the server. The master password, the master key, the
// user key and the private key never leave this function.

import type { OutsidePrepared } from '../api/vault';
import { decryptType2, openOrganisationKey, splitKey, type BitwardenKdf } from './bitwarden';

/** `KdfType` in Vaultwarden's user model: 0 PBKDF2-SHA256, 1 Argon2id. */
export function kdfOf(prep: OutsidePrepared): BitwardenKdf {
  if (prep.kdf.type === 0) return { type: 'pbkdf2', iterations: prep.kdf.iterations };
  if (prep.kdf.type === 1) {
    return { type: 'argon2id', iterations: prep.kdf.iterations, memoryMiB: prep.kdf.memory ?? 0, parallelism: prep.kdf.parallelism ?? 0 };
  }
  throw new Error('This vault makes its keys in a way Fathom does not know.');
}

const tidy = (s: string) => s.trim().split(/\s+/).join(' ');

export interface Opened {
  collectionId: string;
  collectionName: string;
  orgKey: Uint8Array;
}

/**
 * Open the account and the one collection's organisation key. `email` is used only when the
 * vault did not say which e-mail the account's key is salted with. Refuses, in words, when the
 * account sees other than one collection, or the collection is not called `collectionName`.
 */
export async function openForConnect(prep: OutsidePrepared, masterPassword: string, email: string, collectionName: string): Promise<Opened> {
  if (prep.collections.length !== 1) {
    throw new Error(`The account must see exactly 1 collection; it sees ${prep.collections.length}.`);
  }
  const col = prep.collections[0];
  const org = prep.organisations.find((o) => o.id === col.organisationId);
  if (!org?.protectedKey) throw new Error('The account is not a confirmed member of the collection’s organisation yet.');
  const salt = prep.salt ?? email;
  if (!salt.trim()) throw new Error('Type the account’s e-mail address.');
  const orgKey = await openOrganisationKey(masterPassword, salt, kdfOf(prep), prep.protectedUserKey, prep.protectedPrivateKey, org.protectedKey);
  const name = new TextDecoder('utf-8', { fatal: true }).decode(await decryptType2(col.protectedName, splitKey(orgKey)));
  if (tidy(name) !== tidy(collectionName)) {
    orgKey.fill(0);
    throw new Error(`The account’s one collection is not called “${tidy(collectionName)}”.`);
  }
  return { collectionId: col.id, collectionName: tidy(name), orgKey };
}

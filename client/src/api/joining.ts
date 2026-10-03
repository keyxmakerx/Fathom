// The key-check code of the key this browser holds for an account: what the
// person who just joined reads out, and what the steward finds on the Waiting
// row. Computed here from the public key, never fetched.

import { exportPublicKeyRaw, getEnrolledKeyPair, getPendingKeyPair } from '../crypto/keys';
import { keyCodeOfPublicKey } from './grantBytes';

/** The code for the key held under `address`, enrolled or still pending, or
 * null when this browser holds none. */
export async function keyCheckCode(address: string): Promise<string | null> {
  const pair = (await getEnrolledKeyPair(address)) ?? (await getPendingKeyPair(address));
  return pair ? keyCodeOfPublicKey(await exportPublicKeyRaw(pair.publicKey)) : null;
}

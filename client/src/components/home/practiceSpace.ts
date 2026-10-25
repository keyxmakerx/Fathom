// ADR-0069: the practice space for the person who runs the server. It is an ordinary organisation, made by the same
// operator act as Admin's "Create the shell and its claim" and claimed at once by the same genesis, so nothing here is
// a new power. Two things differ, both on purpose: the shell is marked practice, and the organisation's root key is
// made unextractable and dropped, so there is no recovery key to save. Nobody can recover a practice space's root,
// and nobody needs to: it holds only practice.
import { randomIdSalt, redeemOrganisationClaim } from '../../api/claim';
import { createPracticeShell } from '../../api/console';
import { exportPublicKeyRaw, generateKeyPair, getEnrolledKeyPair } from '../../crypto/keys';

export const PRACTICE_NAME = 'Practice space';

/** Makes and claims the practice space; needs an operator session (Admin) and the account's key in this browser.
 * Answers the new organisation's id. */
export async function makePracticeSpace(accountAddress: string, accountId: string): Promise<string> {
  const accountKeyPair = await getEnrolledKeyPair(accountAddress);
  if (!accountKeyPair) throw new Error('This browser holds no key for this account. Sign in again and retry.');
  const claim = await createPracticeShell(PRACTICE_NAME);
  const rootKeyPair = await generateKeyPair();
  return redeemOrganisationClaim(
    claim.token,
    claim.noticeAddress,
    rootKeyPair,
    await exportPublicKeyRaw(rootKeyPair.publicKey),
    randomIdSalt(),
    accountId,
    await exportPublicKeyRaw(accountKeyPair.publicKey),
  );
}

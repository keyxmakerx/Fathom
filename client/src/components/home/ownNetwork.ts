// Sign-off r123 (approved 12 November 2026): "Start your own network", for the person who set the server up and runs it
// for themselves. It does nothing a person cannot already do by hand, in the same order: Admin's own "Create the shell
// and its claim" (ADR-0055), the claim redeemed from their own account with a fresh root key whose recovery key they
// saved first (ADR-0057 decision 5), then the site and the empty design Home's own New design makes (ADR-0060
// decision 6). No new route and no new power. Unlike the practice space (ADR-0069) the organisation is an ordinary one
// and its root key is shown once as the recovery key, because this one holds real work.
import { formatRecoveryKey, randomIdSalt, redeemOrganisationClaim } from '../../api/claim';
import { createOrganisationShell, type OrganisationClaim } from '../../api/console';
import { createDesign, type DesignSummary } from '../../api/designs';
import { createScope, type Scope } from '../../api/scopes';
import { emptyDocument } from '../../document/model';
import { writePlain } from '../../document/plain';
import { exportPrivateScalar, exportPublicKeyRaw, generateExtractableKeyPair, getEnrolledKeyPair } from '../../crypto/keys';

/** The name filled in for the person (r123, name A). */
export const OWN_NETWORK_DEFAULT_NAME = 'Home network';

/** The longest name the card accepts; the same bound the console's display names keep in practice. */
export const OWN_NETWORK_NAME_MAX = 80;

/** A root key made in this browser and not yet sent anywhere, with the text the person saves. */
export interface PreparedOwnNetwork {
  rootKeyPair: CryptoKeyPair;
  rootPubkey: Uint8Array;
  idSalt: Uint8Array;
  recoveryKeyText: string;
}

export interface OwnNetwork {
  organisationId: string;
  site: Scope;
  design: DesignSummary;
}

/** The name as it will be sent, or null when there is nothing to send. Spaces at either end are dropped. */
export function ownNetworkName(typed: string): string | null {
  const name = typed.trim();
  if (name.length === 0 || name.length > OWN_NETWORK_NAME_MAX) return null;
  return name;
}

/** Makes the root key and its recovery text. Nothing leaves the browser. */
export async function prepareOwnNetwork(): Promise<PreparedOwnNetwork> {
  const rootKeyPair = await generateExtractableKeyPair();
  const rootPubkey = await exportPublicKeyRaw(rootKeyPair.publicKey);
  const recoveryKeyText = await formatRecoveryKey(await exportPrivateScalar(rootKeyPair.privateKey));
  return { rootKeyPair, rootPubkey, idSalt: randomIdSalt(), recoveryKeyText };
}

/** What has been made so far. A press of Start drawing after a failure carries on from here, so a retry never makes a
 * second organisation: the claim already minted is redeemed again (a claim that went through answers as spent), and a
 * claimed organisation goes straight on to its site and design. */
export interface OwnNetworkProgress {
  claim?: OrganisationClaim;
  organisationId?: string;
  site?: Scope;
}

export class OwnNetworkFailure extends Error {
  readonly progress: OwnNetworkProgress;
  readonly cause: unknown;
  constructor(progress: OwnNetworkProgress, cause: unknown) {
    super('making your own network stopped part way');
    this.progress = progress;
    this.cause = cause;
  }
}

/**
 * Makes and claims the organisation, then its site and an empty design. Needs an operator session for the first act
 * (Admin) and the account's key in this browser for the claim; the rest is the account's own.
 */
export async function makeOwnNetwork(
  name: string,
  prepared: PreparedOwnNetwork,
  accountAddress: string,
  accountId: string,
  from: OwnNetworkProgress = {},
): Promise<OwnNetwork> {
  const progress: OwnNetworkProgress = { ...from };
  try {
    if (progress.organisationId === undefined) {
      const accountKeyPair = await getEnrolledKeyPair(accountAddress);
      if (!accountKeyPair) throw new Error('This browser holds no key for this account. Sign in again and retry.');
      const subjectPubkey = await exportPublicKeyRaw(accountKeyPair.publicKey);
      if (progress.claim === undefined) progress.claim = await createOrganisationShell(name);
      progress.organisationId = await redeemOrganisationClaim(
        progress.claim.token,
        progress.claim.noticeAddress,
        prepared.rootKeyPair,
        prepared.rootPubkey,
        prepared.idSalt,
        accountId,
        subjectPubkey,
      );
    }
    const organisationId = progress.organisationId;
    if (progress.site === undefined) progress.site = await createScope(organisationId, null, name);
    const site = progress.site;
    const design = await createDesign(organisationId, site.scopeId, writePlain(emptyDocument()));
    return { organisationId, site, design };
  } catch (error) {
    throw new OwnNetworkFailure(progress, error);
  }
}

/** The sentence a failure shows: what exists now, and that pressing again carries on rather than starting over. */
export function describeOwnNetworkFailure(error: unknown, refusal: string | null): string {
  const why = refusal ? ` ${refusal}` : '';
  const progress = error instanceof OwnNetworkFailure ? error.progress : {};
  if (progress.organisationId !== undefined) {
    return `Your organisation is made, but its ${progress.site === undefined ? 'site' : 'first design'} could not be.${why} Press Start drawing again to finish.`;
  }
  if (progress.claim !== undefined) {
    return `Fathom could not claim the organisation for you.${why} Press Start drawing again to try once more; it uses the same claim.`;
  }
  return `Your network could not be made. Nothing was changed on the server.${why}`;
}

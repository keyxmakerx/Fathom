// Plan approval (migration 0072, sign-off r102-plan-approval). Wire shapes are
// `design_api/plan_approval_routes.rs`. A folder's rule and every approval are signed here with
// this browser's enrolled key. The server fixes the bytes; this file rebuilds them from the
// person's own choice and from the plan as this browser holds it, and refuses to sign if the two
// differ. An approval is over `planDigest`: the plan's title, window and team and every step's
// words. So what is signed is the plan on this screen, never a plan the server describes.

import { concatBytes, fromHex, lp, toHex, u32LE, u64LE, utf8 } from '../crypto/bytes';
import { signMessage } from '../crypto/keys';
import { edgesOut, fieldValue, findNode, parseNodeId, type Document } from '../document/model';
import { getSession } from '../state/sessionState';
import { body } from './fieldDefinitions';
import { arrayOf, asRec, bool, int, jsonObject, oneOf, optStr, sameBytes, str, type Rec } from './json';
import { NoSigningKeyHere, ownKeyFingerprint, signingKey } from './share';
import { signedFetch } from './signedFetch';

export type ApprovalKind = 'before' | 'emergency' | 'after';
export type AskKind = 'ask' | 'send_back';

// ---------------------------------------------------------------------------
// Bytes, pinned by the same vectors as `tests/authority_vectors.rs`

/** `authority::plan_rule_bytes`. */
export function planRuleBytes(f: {
  organisation: string;
  rootPubkeyFpr: Uint8Array;
  ruleId: string;
  scope: string | null;
  required: boolean;
  signer: string;
  signerKeyFpr: Uint8Array;
  atUnix: number;
  authEpoch: number;
}): Uint8Array {
  return concatBytes(
    lp(utf8('fathom/plan/rule/v1')),
    lp(utf8(f.organisation)),
    lp(f.rootPubkeyFpr),
    lp(utf8(f.ruleId)),
    lp(utf8(f.scope ?? '')),
    new Uint8Array([f.required ? 1 : 0]),
    lp(utf8(f.signer)),
    lp(f.signerKeyFpr),
    u64LE(f.atUnix),
    u32LE(f.authEpoch),
  );
}

/** `authority::plan_approval_bytes`. */
export function planApprovalBytes(f: {
  organisation: string;
  rootPubkeyFpr: Uint8Array;
  approvalId: string;
  design: string;
  plan: string;
  planDigest: Uint8Array;
  kind: ApprovalKind;
  team: string | null;
  reason: string;
  signer: string;
  signerKeyFpr: Uint8Array;
  atUnix: number;
  authEpoch: number;
}): Uint8Array {
  return concatBytes(
    lp(utf8('fathom/plan/approval/v1')),
    lp(utf8(f.organisation)),
    lp(f.rootPubkeyFpr),
    lp(utf8(f.approvalId)),
    lp(utf8(f.design)),
    lp(utf8(f.plan)),
    lp(f.planDigest),
    lp(utf8(f.kind)),
    lp(utf8(f.team ?? '')),
    lp(utf8(f.reason)),
    lp(utf8(f.signer)),
    lp(f.signerKeyFpr),
    u64LE(f.atUnix),
    u32LE(f.authEpoch),
  );
}

/** A step's words, in the digest's order: ordinal, kind, targets, change, before, after, edit,
 * If, path. */
export type StepWords = readonly [string, string, string, string, string, string, string, string, string];

/** `authority::plan_digest` over values already read: `head` is title, window start, window
 * end, team. Steps are sorted by id here, as on the server. */
export async function planDigestOf(plan: string, head: readonly [string, string, string, string], steps: readonly (readonly [string, StepWords])[]): Promise<Uint8Array> {
  const sorted = [...steps].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const message = concatBytes(
    lp(utf8('fathom/plan/digest/v1')),
    lp(utf8(plan)),
    ...head.map((v) => lp(utf8(v))),
    u32LE(sorted.length),
    ...sorted.flatMap(([id, words]) => [lp(utf8(id)), ...words.map((w) => lp(utf8(w)))]),
  );
  return new Uint8Array(await crypto.subtle.digest('SHA-256', message as BufferSource));
}

/** A field's text as the server reads it for the digest: a string, a number in decimal, else ''. */
function words(fields: Parameters<typeof fieldValue>[0], key: string): string {
  const v = fieldValue(fields, key);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return '';
}

/** The digest of plan `planId` as this document holds it: what an approval of it says. */
export async function planDigest(doc: Document, planId: string): Promise<Uint8Array> {
  const n = findNode(doc, planId);
  if (!n || n.absentSince !== undefined) throw new Error(`"${planId}" is not a live plan`);
  const f = (key: string) => words(n.fields, `MaintenancePlan.${key}`);
  const steps = edgesOut(doc, planId, 'HasStep').flatMap((e): [string, StepWords][] => {
    const s = findNode(doc, e.to);
    if (!s || s.absentSince !== undefined) return [];
    const w = (key: string) => words(s.fields, `PlanStep.${key}`);
    return [[parseNodeId(s.id).ulid, [w('ordinal'), w('kind'), w('targets'), w('change'), w('before'), w('after'), w('edit'), w('if_when'), w('branch_of')]]];
  });
  return planDigestOf(parseNodeId(planId).ulid, [f('title'), f('window_start'), f('window_end'), f('team')], steps);
}

// ---------------------------------------------------------------------------
// Reading

export interface ApprovalLine {
  kind: ApprovalKind;
  by: string;
  team: string | null;
  reason: string;
  at: number;
  /** Over the plan as it reads now. */
  current: boolean;
}

export interface AskLine {
  kind: AskKind;
  by: string;
  note: string;
  at: number;
  current: boolean;
}

export interface PlanApproval {
  /** The plan's ULID (not its design id). */
  plan: string;
  title: string;
  stage: string;
  digest: string;
  approved: boolean;
  flagged: boolean;
  approvals: ApprovalLine[];
  asks: AskLine[];
  mayApprove: boolean;
  mayEmergency: boolean;
  mayApproveAfter: boolean;
  maySendBack: boolean;
}

export interface DesignApprovals {
  /** The design's folder asks for plans to be approved before they start. */
  required: boolean;
  plans: PlanApproval[];
  names: Readonly<Record<string, string>>;
}

const designBase = (organisation: string, design: string) =>
  `/organisations/${encodeURIComponent(organisation)}/designs/${encodeURIComponent(design)}/plan-approvals`;

export function parseApprovals(bytes: Uint8Array): DesignApprovals {
  const r = jsonObject(bytes, 'plan approvals');
  const names = asRec(r.names ?? {}, 'names');
  return {
    required: bool(r, 'required', 'plan approvals'),
    names: Object.fromEntries(Object.entries(names).filter((e): e is [string, string] => typeof e[1] === 'string')),
    plans: arrayOf(r, 'plans', 'plan approvals').map((v) => {
      const p = asRec(v, 'plan');
      return {
        plan: str(p, 'plan', 'plan'),
        title: str(p, 'title', 'plan'),
        stage: str(p, 'stage', 'plan'),
        digest: str(p, 'digest', 'plan'),
        approved: bool(p, 'approved', 'plan'),
        flagged: bool(p, 'flagged', 'plan'),
        approvals: arrayOf(p, 'approvals', 'plan').map((a) => {
          const x = asRec(a, 'approval');
          return {
            kind: oneOf(x, 'kind', ['before', 'emergency', 'after'] as const, 'approval'),
            by: str(x, 'by', 'approval'),
            team: optStr(x, 'team', 'approval'),
            reason: str(x, 'reason', 'approval'),
            at: int(x, 'at', 'approval'),
            current: bool(x, 'current', 'approval'),
          };
        }),
        asks: arrayOf(p, 'asks', 'plan').map((a) => {
          const x = asRec(a, 'ask');
          return {
            kind: oneOf(x, 'kind', ['ask', 'send_back'] as const, 'ask'),
            by: str(x, 'by', 'ask'),
            note: str(x, 'note', 'ask'),
            at: int(x, 'at', 'ask'),
            current: bool(x, 'current', 'ask'),
          };
        }),
        mayApprove: bool(p, 'may_approve', 'plan'),
        mayEmergency: bool(p, 'may_emergency', 'plan'),
        mayApproveAfter: bool(p, 'may_approve_after', 'plan'),
        maySendBack: bool(p, 'may_send_back', 'plan'),
      };
    }),
  };
}

export async function fetchApprovals(organisation: string, design: string): Promise<DesignApprovals> {
  return parseApprovals(await signedFetch('GET', designBase(organisation, design)));
}

/** Where a plan stands on its approval, in a few words for a badge; null when nothing to say. */
export function approvalWords(required: boolean, p: PlanApproval | undefined): string | null {
  if (!p) return null;
  if (p.flagged) return 'Started in an emergency · needs approval after';
  if (!required || p.stage !== 'planned') return null;
  if (p.approved) return 'Approved';
  if (p.asks.some((a) => a.current && a.kind === 'send_back')) return 'Sent back';
  if (p.asks.some((a) => a.current && a.kind === 'ask')) return 'Waiting for approval';
  return 'Needs approval';
}

// ---------------------------------------------------------------------------
// Signing

const textOf = (r: Rec, key: string): string | null => (typeof r[key] === 'string' ? (r[key] as string) : null);

/** Approve a plan, start it in an emergency, or approve it after one: propose, check the
 * server's digest is this document's, rebuild the bytes, sign with this browser's key, send. */
export async function signApproval(organisation: string, design: string, doc: Document, planId: string, kind: ApprovalKind, reason = ''): Promise<string> {
  const key = await signingKey();
  const signer = getSession()?.accountId;
  if (!signer) throw new NoSigningKeyHere();
  const keyFpr = await ownKeyFingerprint();
  const plan = parseNodeId(planId).ulid;
  const digest = await planDigest(doc, planId);
  const proposal = jsonObject(
    await signedFetch('POST', `${designBase(organisation, design)}/propose`, body({ key: toHex(keyFpr), plan, kind, reason })),
    'proposal',
  );
  if (textOf(proposal, 'plan_digest') !== toHex(digest)) {
    throw new Error('The plan changed since this screen read it, so nothing was signed. Look at it again first.');
  }
  if (
    textOf(proposal, 'design') !== design ||
    textOf(proposal, 'plan') !== plan ||
    textOf(proposal, 'kind') !== kind ||
    textOf(proposal, 'reason') !== reason ||
    textOf(proposal, 'signer') !== signer ||
    textOf(proposal, 'signer_key_fpr') !== toHex(keyFpr)
  ) {
    throw new Error('The server proposed something other than what you chose, so it was not signed.');
  }
  const local = planApprovalBytes({
    organisation,
    rootPubkeyFpr: fromHex(str(proposal, 'root_fpr', 'proposal')),
    approvalId: str(proposal, 'approval_id', 'proposal'),
    design,
    plan,
    planDigest: digest,
    kind,
    team: optStr(proposal, 'team', 'proposal'),
    reason,
    signer,
    signerKeyFpr: keyFpr,
    atUnix: int(proposal, 'at', 'proposal'),
    authEpoch: int(proposal, 'auth_epoch', 'proposal'),
  });
  if (!sameBytes(local, fromHex(str(proposal, 'bytes', 'proposal')))) {
    throw new Error('The server proposed bytes that are not the approval you chose, so they were not signed.');
  }
  const signature = await signMessage(key, local);
  const back: Record<string, unknown> = {};
  for (const k of ['approval_id', 'design', 'plan', 'plan_digest', 'kind', 'team', 'reason', 'signer', 'signer_key_fpr', 'at', 'auth_epoch', 'root_fpr']) back[k] = proposal[k];
  back.signature = toHex(signature);
  const answer = jsonObject(await signedFetch('POST', `${designBase(organisation, design)}/sign`, body(back)), 'sign');
  return str(answer, 'approval', 'sign');
}

/** Ask for a plan to be approved, or send it back with a note. Not signed: it decides nothing. */
export async function askApproval(organisation: string, design: string, planId: string, kind: AskKind, note: string): Promise<void> {
  await signedFetch('POST', `${designBase(organisation, design)}/ask`, body({ plan: parseNodeId(planId).ulid, kind, note }));
}

// ---------------------------------------------------------------------------
// Folder rules

const rulesBase = (organisation: string) => `/organisations/${encodeURIComponent(organisation)}/plan-rules`;

export interface PlanRules {
  steward: boolean;
  /** Each folder's own rule; `scope` null is the whole organisation. */
  rules: { scope: string | null; required: boolean }[];
}

export function parseRules(bytes: Uint8Array): PlanRules {
  const r = jsonObject(bytes, 'plan rules');
  return {
    steward: bool(r, 'steward', 'plan rules'),
    rules: arrayOf(r, 'rules', 'plan rules').map((v) => {
      const x = asRec(v, 'rule');
      return { scope: optStr(x, 'scope', 'rule'), required: bool(x, 'required', 'rule') };
    }),
  };
}

export async function fetchRules(organisation: string): Promise<PlanRules> {
  return parseRules(await signedFetch('GET', rulesBase(organisation)));
}

/** Does a plan in `scope` need approval: its folder's own rule or an enclosing one asks.
 * `ancestors` is the folder's chain from the top, the folder itself last. */
export function requiredIn(rules: PlanRules, ancestors: readonly string[]): boolean {
  return rules.rules.some((r) => r.required && (r.scope === null || ancestors.includes(r.scope)));
}

/** A folder's Steward turns approval on or off there. */
export async function setRule(organisation: string, scope: string | null, required: boolean): Promise<string> {
  const key = await signingKey();
  const signer = getSession()?.accountId;
  if (!signer) throw new NoSigningKeyHere();
  const keyFpr = await ownKeyFingerprint();
  const proposal = jsonObject(await signedFetch('POST', `${rulesBase(organisation)}/propose`, body({ key: toHex(keyFpr), scope, required })), 'proposal');
  if ((proposal.scope ?? null) !== scope || proposal.required !== required || textOf(proposal, 'signer') !== signer || textOf(proposal, 'signer_key_fpr') !== toHex(keyFpr)) {
    throw new Error('The server proposed a change that is not the one you chose, so it was not signed.');
  }
  const local = planRuleBytes({
    organisation,
    rootPubkeyFpr: fromHex(str(proposal, 'root_fpr', 'proposal')),
    ruleId: str(proposal, 'rule_id', 'proposal'),
    scope,
    required,
    signer,
    signerKeyFpr: keyFpr,
    atUnix: int(proposal, 'at', 'proposal'),
    authEpoch: int(proposal, 'auth_epoch', 'proposal'),
  });
  if (!sameBytes(local, fromHex(str(proposal, 'bytes', 'proposal')))) {
    throw new Error('The server proposed bytes that are not the change you chose, so they were not signed.');
  }
  const signature = await signMessage(key, local);
  const back: Record<string, unknown> = {};
  for (const k of ['rule_id', 'scope', 'required', 'signer', 'signer_key_fpr', 'at', 'auth_epoch', 'root_fpr']) back[k] = proposal[k];
  back.signature = toHex(signature);
  const answer = jsonObject(await signedFetch('POST', `${rulesBase(organisation)}/sign`, body(back)), 'sign');
  return str(answer, 'rule', 'sign');
}

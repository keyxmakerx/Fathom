import { describe, expect, it } from 'vitest';

import { toHex } from '../crypto/bytes';
import { createSketchDevice } from '../document/commands';
import { emptyDocument } from '../document/model';
import { addStep, createPlan, setPlanHead, startPlan, TYPED_AS_WRITTEN } from '../document/plans';
import { setWorkField } from '../document/work';
import { approvalWords, parseApprovals, planApprovalBytes, planDigest, planDigestOf, planRuleBytes, requiredIn, type PlanApproval } from './planApprovals';

// `PLAN_RULE_BYTES`, `PLAN_DIGEST` and `PLAN_APPROVAL_BYTES` from
// `crates/fathom-server/tests/vectors/gen_authority_vectors.py` (migration 0072), the same bytes
// `tests/authority_vectors.rs` pins.
const PLAN_RULE_BYTES =
  '13000000666174686f6d2f706c616e2f72756c652f76311a00000030314a515a3030303030303030303030303030303030303041412000000041414141414141414141414141414141414141414141414141414141414141411a00000030314a515a3030303030303030303030303030303030303050501a00000030314a515a303030303030303030303030303030303030304242011a00000030314a515a303030303030303030303030303030303030304444200000004343434343434343434343434343434343434343434343434343434343434343800e80690000000007000000';
const PLAN_DIGEST = '4550f9160efc8a15bdadfec6eaf746eccb1bc6436f69bc4b8418732b821f8a22';
const PLAN_APPROVAL_BYTES =
  '17000000666174686f6d2f706c616e2f617070726f76616c2f76311a00000030314a515a3030303030303030303030303030303030303041412000000041414141414141414141414141414141414141414141414141414141414141411a00000030314a515a3030303030303030303030303030303030303051511a00000030314a515a3030303030303030303030303030303030303052521a00000030314a515a303030303030303030303030303030303030305353200000004550f9160efc8a15bdadfec6eaf746eccb1bc6436f69bc4b8418732b821f8a2209000000656d657267656e63791a00000030314a515a30303030303030303030303030303030303030545410000000436f72652073776974636820646f776e1a00000030314a515a303030303030303030303030303030303030304444200000004343434343434343434343434343434343434343434343434343434343434343800e80690000000007000000';

const ORG = '01JQZ0000000000000000000AA';
const ROOT = new Uint8Array(32).fill(0x41);
const GRANTER = '01JQZ0000000000000000000DD';
const GRANTER_KEY = new Uint8Array(32).fill(0x43);
const AT = 1_770_000_000;

describe('plan approval bytes', () => {
  it('builds a folder rule as the server does', () => {
    const bytes = planRuleBytes({ organisation: ORG, rootPubkeyFpr: ROOT, ruleId: '01JQZ0000000000000000000PP', scope: '01JQZ0000000000000000000BB', required: true, signer: GRANTER, signerKeyFpr: GRANTER_KEY, atUnix: AT, authEpoch: 7 });
    expect(toHex(bytes)).toBe(PLAN_RULE_BYTES);
  });

  it('digests a plan with its steps in id order, whatever order they come in', async () => {
    const digest = await planDigestOf('01JQZ0000000000000000000SS', ['Readdress core-1', '2026-11-03T22:00', '', '01JQZ0000000000000000000TT'], [
      ['01JQZ0000000000000000000VB', ['2', 'other', '', 'Reboot core-1', '', '', '', '', '']],
      ['01JQZ0000000000000000000VA', ['1', 'address', 'device:01JQZ0000000000000000000WW', 'Move core-1 to 10.0.0.2', '10.0.0.1', '10.0.0.2', 'field\tDevice.mgmt\t10.0.0.2', '', '']],
    ]);
    expect(toHex(digest)).toBe(PLAN_DIGEST);
  });

  it('builds an emergency start over that digest as the server does', () => {
    const bytes = planApprovalBytes({
      organisation: ORG,
      rootPubkeyFpr: ROOT,
      approvalId: '01JQZ0000000000000000000QQ',
      design: '01JQZ0000000000000000000RR',
      plan: '01JQZ0000000000000000000SS',
      planDigest: Uint8Array.from(PLAN_DIGEST.match(/../g)!.map((h) => parseInt(h, 16))),
      kind: 'emergency',
      team: '01JQZ0000000000000000000TT',
      reason: 'Core switch down',
      signer: GRANTER,
      signerKeyFpr: GRANTER_KEY,
      atUnix: AT,
      authEpoch: 7,
    });
    expect(toHex(bytes)).toBe(PLAN_APPROVAL_BYTES);
  });
});

describe('reading approvals', () => {
  const wire = {
    required: true,
    names: { A1: 'Sam Ortiz' },
    plans: [
      {
        plan: '01JQZ0000000000000000000SS',
        title: 'Readdress core-1',
        stage: 'planned',
        digest: PLAN_DIGEST,
        approved: false,
        flagged: false,
        approvals: [],
        asks: [{ kind: 'ask', by: 'A1', note: 'Tonight', at: AT, current: true }],
        may_approve: true,
        may_emergency: false,
        may_approve_after: false,
        may_send_back: true,
      },
    ],
  };

  it('parses what the server sends', () => {
    const a = parseApprovals(new TextEncoder().encode(JSON.stringify(wire)));
    expect(a.required).toBe(true);
    expect(a.names.A1).toBe('Sam Ortiz');
    expect(a.plans[0].asks[0].note).toBe('Tonight');
    expect(a.plans[0].mayApprove).toBe(true);
  });

  it('says where a plan stands in a few words', () => {
    const p = parseApprovals(new TextEncoder().encode(JSON.stringify(wire))).plans[0];
    expect(approvalWords(true, p)).toBe('Waiting for approval');
    expect(approvalWords(false, p)).toBeNull();
    expect(approvalWords(true, { ...p, approved: true } as PlanApproval)).toBe('Approved');
    expect(approvalWords(true, { ...p, asks: [] })).toBe('Needs approval');
    expect(approvalWords(true, { ...p, asks: [{ ...p.asks[0], kind: 'send_back' }] })).toBe('Sent back');
    expect(approvalWords(false, { ...p, stage: 'doing', flagged: true })).toBe('Started in an emergency · needs approval after');
  });

  it('a rule on an enclosing folder reaches the folders inside it', () => {
    const rules = { steward: true, rules: [{ scope: 'F1', required: true }, { scope: 'F9', required: false }] };
    expect(requiredIn(rules, ['F1', 'F2'])).toBe(true);
    expect(requiredIn(rules, ['F9'])).toBe(false);
    expect(requiredIn({ steward: false, rules: [{ scope: null, required: true }] }, [])).toBe(true);
  });
});

describe('the digest of a plan in a document', () => {
  const ACCOUNT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  let now = 1_790_900_000_000;
  const tick = () => ({ actor: ACCOUNT, now: (now += 1000) });

  function aPlan() {
    const d0 = createSketchDevice(emptyDocument(), { hostname: 'core-1', ...tick() });
    const p = createPlan(d0, { title: 'Readdress core-1', gate: TYPED_AS_WRITTEN, ...tick() });
    const s = addStep(p.doc, p.id, { kind: 'other', change: 'Reboot core-1', gate: TYPED_AS_WRITTEN, ...tick() });
    return { doc: s.doc, plan: p.id };
  }

  it('reads the plan as the server will, so the server and this screen agree', async () => {
    const { doc, plan } = aPlan();
    const step = doc.nodes.find((n) => n.id.startsWith('plan-step:'))!.id.split(':')[1];
    const expected = await planDigestOf(plan.split(':')[1], ['Readdress core-1', '', '', ''], [[step, ['0', 'other', '', 'Reboot core-1', '', '', '', '', '']]]);
    expect(toHex(await planDigest(doc, plan))).toBe(toHex(expected));
  });

  it('moves with any change to the plan and its team, not with starting it', async () => {
    const { doc, plan } = aPlan();
    const before = toHex(await planDigest(doc, plan));
    const retitled = setPlanHead(doc, plan, { title: 'Readdress core-2' }, { gate: TYPED_AS_WRITTEN, ...tick() });
    expect(toHex(await planDigest(retitled, plan))).not.toBe(before);
    const teamed = setWorkField(doc, plan, 'team', '01JQZ0000000000000000000TT', { gate: TYPED_AS_WRITTEN, ...tick() });
    expect(toHex(await planDigest(teamed, plan))).not.toBe(before);
    const started = startPlan(doc, plan, tick());
    expect(toHex(await planDigest(started, plan))).toBe(before);
  });
});

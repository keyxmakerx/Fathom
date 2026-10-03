import { describe, expect, it } from 'vitest';

import { BATCH_CAP, DAY_SECONDS } from '../../api/invitations';
import { access, invitation, person } from './fixtures';
import {
  accessWords,
  applyEdits,
  canDoWords,
  confirmButton,
  confirmRowOf,
  expiryFromDays,
  initialTicks,
  removalWords,
  splitRows,
  stateWords,
  stewardNeeds,
  ticked,
  whenLabel,
  whyNotRemovable,
} from './model';

describe('words', () => {
  it('name the access and the folder, or the whole organisation', () => {
    expect(accessWords('draw', 'S', 'LON1')).toBe('Draw · LON1');
    expect(accessWords('read', null, 'Northwind')).toBe('Read · whole organisation');
  });

  it('say what a person can do, and what waits for whom', () => {
    expect(canDoWords(person())).toBe('Draw · LON1; Read · whole organisation');
    const invited = person({ state: 'invited', access: [], asked: { capability: 'draw', scopeId: 'S', scopeLabel: 'LON1' } });
    expect(canDoWords(invited)).toBe('Draw · LON1 (when they join)');
    expect(canDoWords({ ...invited, state: 'waiting' })).toBe('Draw · LON1 (waits for you)');
    expect(stateWords(invited)).toBe('Invited');
    expect(stateWords({ ...invited, state: 'waiting' })).toBe('Waiting for you');
    expect(stateWords({ ...invited, expired: true })).toMatch(/expired/);
  });

  it('label today, yesterday and older times', () => {
    const now = new Date(2026, 9, 3, 12, 0).getTime();
    const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime() / 1000;
    expect(whenLabel(at(3, 9, 12), now)).toBe('today 09:12');
    expect(whenLabel(at(2, 17, 40), now)).toBe('yesterday 17:40');
    expect(whenLabel(at(1, 9, 5), now)).toBe('1 Oct 09:05');
  });
});

describe('removing access', () => {
  it('says the 24 hour rule in words for another steward', () => {
    const steward = access({ capability: 'steward', scopeId: null, label: 'Northwind', revokeTakesEffectInSeconds: 86400 });
    const words = removalWords(steward, 'Lee');
    expect(words).toMatch(/24 hours after you sign/);
    expect(words).toMatch(/keep it/);
  });

  it('says a read or draw removal is at once', () => {
    expect(removalWords(access(), 'Jo')).toMatch(/as soon as you sign/);
  });

  it('explains why a row cannot be removed', () => {
    expect(whyNotRemovable(access(), false)).toBeNull();
    expect(whyNotRemovable(access({ genesis: true }), false)).toMatch(/set up/);
    expect(whyNotRemovable(access({ inherited: true }), false)).toMatch(/above/);
    expect(whyNotRemovable(access({ revocable: false }), false)).toMatch(/do not steward/);
    expect(whyNotRemovable(access(), true)).toMatch(/your own/);
    expect(whyNotRemovable(access({ scopeId: null }), false)).toMatch(/whole organisation/);
    expect(whyNotRemovable(access({ revokingAtUnix: 1_800_086_400 }), false)).toMatch(/Being removed/);
  });
});

describe('the Waiting rows', () => {
  const list = [
    invitation(1),
    invitation(2, { capabilityAsked: 'steward', scopeId: null, scopeLabel: 'Northwind' }),
    invitation(3, { canConfirm: false, expired: true }),
    invitation(4, { state: 'asked', keyCode: null, canConfirm: false, joinedAtUnix: null }),
    invitation(5, { unverifiable: true, canConfirm: false }),
  ];

  it('leave out people who have not joined, and split batch, steward and blocked', () => {
    const split = splitRows(applyEdits(list, {}));
    expect(split.batch.map((r) => r.invitation.account)).toEqual(['ACC1']);
    expect(split.stewards.map((r) => r.invitation.account)).toEqual(['ACC2']);
    expect(split.blocked.map((r) => r.invitation.account)).toEqual(['ACC3', 'ACC5']);
  });

  it('move a row between batch and steward when the steward changes it', () => {
    const edits = { [list[0].id]: { capability: 'steward' as const, scopeId: null, scopeLabel: 'Northwind' }, [list[1].id]: { capability: 'read' as const, scopeId: 'S2', scopeLabel: 'MAN1' } };
    const split = splitRows(applyEdits(list, edits));
    expect(split.batch.map((r) => r.invitation.account)).toEqual(['ACC2']);
    expect(split.stewards.map((r) => r.invitation.account)).toEqual(['ACC1']);
    expect(split.batch[0]).toMatchObject({ capability: 'read', scopeId: 'S2', changed: true });
  });

  it('tick everyone, up to the cap, and build the rows to confirm from what is ticked', () => {
    const many = Array.from({ length: BATCH_CAP + 20 }, (_, i) => invitation(i));
    const split = splitRows(applyEdits(many, {}));
    const ticks = initialTicks(split.batch);
    expect(ticks.size).toBe(BATCH_CAP);
    expect(confirmButton(BATCH_CAP + 1)).toMatchObject({ disabled: true });
    expect(confirmButton(3)).toEqual({ label: 'Confirm 3 people', disabled: false, note: null });
    expect(confirmButton(1).label).toBe('Confirm 1 person');
    expect(confirmButton(0).disabled).toBe(true);
    const rows = ticked(split.batch, new Set([split.batch[2].invitation.id])).map(confirmRowOf);
    expect(rows).toEqual([{ invitation: split.batch[2].invitation.id, account: 'ACC2', capability: 'draw', scopeId: 'S-LON1', keyCode: 'QDMPW1FAVF' }]);
  });
});

describe('steward requests', () => {
  it('state the 24 hour wait or the second steward', () => {
    expect(stewardNeeds(true)).toMatch(/24 hours/);
    expect(stewardNeeds(true)).toMatch(/only steward/);
    expect(stewardNeeds(false)).toMatch(/second steward must agree/);
  });

  it('turns days into an expiry between two days and a year', () => {
    expect(expiryFromDays(365, 1000)).toBe(1000 + 365 * DAY_SECONDS);
    expect(expiryFromDays(1, 1000)).toBeNull();
    expect(expiryFromDays(366, 1000)).toBeNull();
    expect(expiryFromDays(Number.NaN, 1000)).toBeNull();
  });
});

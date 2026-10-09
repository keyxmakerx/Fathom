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
  accessDetail,
  contactLine,
  dateTimeLabel,
  MOVED_TO_STEWARD,
  refuseEach,
  refusedBeforeError,
  shortDateLabel,
  startsLater,
  stateMark,
  stateWords,
  STEWARD_REQUEST_RULE,
  stewardNeeds,
  ticksWithout,
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

describe('someone whose access has not started', () => {
  const now = new Date(2026, 9, 3, 12, 0).getTime();
  const unix = (d: number) => new Date(2026, 9, d, 9, 0).getTime() / 1000;

  it('shows "Starts D Mon" with an open mark only when every row is still ahead', () => {
    const later = person({ access: [access({ effectiveFromUnix: unix(4) }), access({ grant: 'G2', effectiveFromUnix: unix(9) })] });
    expect(startsLater(later, now)).toBe(unix(4));
    expect(stateWords(later, now)).toBe('Starts 4 Oct');
    expect(stateMark(later, now)).toBe('○');
    const mixed = person({ access: [access({ effectiveFromUnix: unix(1) }), access({ grant: 'G2', effectiveFromUnix: unix(9) })] });
    expect(stateWords(mixed, now)).toBe('Active');
    expect(stateMark(mixed, now)).toBe('●');
    expect(stateWords(person({ access: [] }), now)).toBe('Active');
  });

  it('draws the waiting person with a glyph the interface font has', () => {
    const waiting = person({ state: 'waiting', access: [] });
    expect(stateMark(waiting)).toBe('◐');
  });

  it('formats a short date and a date with its time', () => {
    expect(shortDateLabel(unix(4))).toBe('4 Oct');
    expect(dateTimeLabel(unix(4))).toBe('4 Oct 2026 09:00');
  });
});

describe('the line under an access row', () => {
  const now = new Date(2026, 9, 3, 12, 0).getTime();
  const unix = (d: number) => new Date(2026, 9, d, 9, 0).getTime() / 1000;

  it('joins its parts with a middle dot and never starts with one', () => {
    expect(accessDetail(access({ effectiveFromUnix: unix(1) }), now)).toBe('since 1 Oct 2026');
    expect(accessDetail(access({ effectiveFromUnix: unix(1), inherited: true, expiresAtUnix: unix(9), awaitingSecond: true, suspended: true }), now)).toBe(
      'from a folder above · until 9 Oct 2026 · waiting for a second steward · suspended · since 1 Oct 2026',
    );
    expect(accessDetail(access({ effectiveFromUnix: unix(4) }), now)).toBe('starts 4 Oct 2026, not yet in force');
  });
});

describe('what is under a name', () => {
  it('labels a member address as the sign-in name, and leaves a typed email as typed', () => {
    expect(contactLine(person({ email: 'ana-silva-33cw9a40' }))).toBe('sign-in name: ana-silva-33cw9a40');
    expect(contactLine(person({ state: 'invited', email: 'ana@northwind.example' }))).toBe('ana@northwind.example');
    expect(contactLine(person({ email: null }))).toBeNull();
  });
});

describe('refusing several people', () => {
  it('stops at the first failure and says how many went through', async () => {
    const seen: string[] = [];
    const failing = async (id: string) => {
      if (id === 'c') throw new Error('The server said no.');
      seen.push(id);
    };
    const result = await refuseEach(['a', 'b', 'c', 'd'], failing);
    expect(seen).toEqual(['a', 'b']);
    expect(result.refused).toBe(2);
    expect(result.error).toBeInstanceOf(Error);
    expect(refusedBeforeError('The server said no.', 2, 4)).toBe('The server said no. 2 of 4 people were refused before it stopped.');
    expect(refusedBeforeError('The server said no.', 0, 4)).toBe('The server said no.');
    expect(refusedBeforeError('x.', 1, 1)).toBe('x. 1 of 1 person was refused before it stopped.');
  });

  it('reports no error when all go through', async () => {
    expect(await refuseEach(['a', 'b'], async () => undefined)).toEqual({ refused: 2, error: null });
  });

  it('takes the people just confirmed or refused out of the ticks at once', () => {
    expect([...ticksWithout(new Set(['a', 'b', 'c']), ['a', 'c'])]).toEqual(['b']);
  });
});

describe('words that explain the rules before they bite', () => {
  it('says the 24-hour wait and the second steward on the Steward requests box', () => {
    expect(STEWARD_REQUEST_RULE).toMatch(/24 hours after you sign/);
    expect(STEWARD_REQUEST_RULE).toMatch(/second steward must agree/);
  });

  it('says a row moved to the Steward requests box', () => {
    expect(MOVED_TO_STEWARD).toBe('Moved to Steward requests: a Steward is confirmed on its own.');
  });
});

// `parseInvitationAnswer`'s vector below was produced by an independent
// Python one-liner (struct.pack('<I', len) + bytes, then struct.pack('<Q')
// for the expiry), the method `enrolment.test.ts` documents, not by this
// module's own encoder:
//
//   lp(b"01JXACCOUNTIDEXAMPLE000001") + lp(bytes(range(32)))
//     + lp(b"01JXTOKENIDEXAMPLE0000001") + struct.pack('<Q', 1790000000)
import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from '../crypto/bytes';
import {
  buildAccountShellBody,
  parseInvitationAnswer,
  parseOperatorList,
  parseOrganisationList,
} from './console';

const INVITATION_HEX =
  '1a00000030314a584143434f554e5449444558414d504c4530303030303120000000000102' +
  '030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f1900000030314a58' +
  '544f4b454e49444558414d504c4530303030303031803bb16a00000000';

describe('parseInvitationAnswer (admin.rs invitation_response)', () => {
  it('reads LP(subject) || LP(token) || LP(token_id) || u64(expires_at)', () => {
    const answer = parseInvitationAnswer(fromHex(INVITATION_HEX));
    expect(answer.subject).toBe('01JXACCOUNTIDEXAMPLE000001');
    expect(toHex(answer.token)).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(answer.tokenId).toBe('01JXTOKENIDEXAMPLE0000001');
    expect(answer.expiresAtUnix).toBe(1_790_000_000);
  });

  it('refuses a trailing byte and a token that is not 32 bytes', () => {
    expect(() => parseInvitationAnswer(fromHex(`${INVITATION_HEX}ff`))).toThrow(/trailing/);
    // Shorten the token field to 31 bytes: patch its length prefix and drop
    // one token byte.
    const bytes = fromHex(INVITATION_HEX);
    const short = new Uint8Array([...bytes.slice(0, 30), 0x1f, 0, 0, 0, ...bytes.slice(34, 65), ...bytes.slice(66)]);
    expect(() => parseInvitationAnswer(short)).toThrow(/31-byte token/);
  });
});

describe('buildAccountShellBody (admin.rs create_account_shell)', () => {
  it('is LP(address) || LP(display_name) and nothing after', () => {
    // 'a@b' is 3 bytes, 'Jo' is 2: 4+3 + 4+2 = 13 bytes.
    const body = buildAccountShellBody('a@b', 'Jo');
    expect(toHex(body)).toBe('03000000' + '614062' + '02000000' + '4a6f');
  });
});

describe('parseOperatorList (admin.rs list_operators)', () => {
  it('reads a display name with spaces from both ends of the line', () => {
    const rows = parseOperatorList(
      '01JXOP1 the first operator - true false\n01JXOP2 Ada Lovelace Jr 01JXOP1 false true\n',
    );
    expect(rows).toEqual([
      {
        id: '01JXOP1',
        displayName: 'the first operator',
        createdBy: null,
        neverIndependentlySignedIn: true,
        disabled: false,
      },
      {
        id: '01JXOP2',
        displayName: 'Ada Lovelace Jr',
        createdBy: '01JXOP1',
        neverIndependentlySignedIn: false,
        disabled: true,
      },
    ]);
  });

  it('is empty for an empty answer and refuses a line that is not five fields', () => {
    expect(parseOperatorList('')).toEqual([]);
    expect(() => parseOperatorList('01JXOP1 name true\n')).toThrow(/fewer than five/);
    expect(() => parseOperatorList('01JXOP1 name - yes false\n')).toThrow(/never_independently_signed_in/);
  });
});

describe('parseOrganisationList (admin.rs list_organisations)', () => {
  it('splits each line at its first space only', () => {
    expect(parseOrganisationList('01JXORG1 Northwind Traders\n01JXORG2 Solo\n')).toEqual([
      { id: '01JXORG1', displayName: 'Northwind Traders' },
      { id: '01JXORG2', displayName: 'Solo' },
    ]);
    expect(parseOrganisationList('')).toEqual([]);
  });
});

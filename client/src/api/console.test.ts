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
  buildOperatorRequestBody,
  buildSettingBody,
  operatorRequestBytes,
  parseInvitationAnswer,
  parseNotices,
  parseOperatorList,
  parseOrganisationList,
  parsePendingAnswer,
  settingRequestBytes,
  smtpValueBytes,
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
  // Six fields since ADR-0055 stream (b): the address is appended after the
  // two flags, so the name is still read from both ends but there is one
  // more word to take off the right.
  it('reads a display name with spaces from both ends of the line', () => {
    const rows = parseOperatorList(
      '01JXOP1 the first operator - true false owner@example.test\n' +
        '01JXOP2 Ada Lovelace Jr 01JXOP1 false true ada@example.test\n',
    );
    expect(rows).toEqual([
      {
        id: '01JXOP1',
        displayName: 'the first operator',
        createdBy: null,
        neverIndependentlySignedIn: true,
        disabled: false,
        address: 'owner@example.test',
      },
      {
        id: '01JXOP2',
        displayName: 'Ada Lovelace Jr',
        createdBy: '01JXOP1',
        neverIndependentlySignedIn: false,
        disabled: true,
        address: 'ada@example.test',
      },
    ]);
  });

  it('reads "-" as no address of record, the way it already reads it as nobody', () => {
    expect(parseOperatorList('01JXOP1 name - true false -\n')[0]).toEqual({
      id: '01JXOP1',
      displayName: 'name',
      createdBy: null,
      neverIndependentlySignedIn: true,
      disabled: false,
      address: null,
    });
  });

  it('is empty for an empty answer and refuses a line that is not six fields', () => {
    expect(parseOperatorList('')).toEqual([]);
    expect(() => parseOperatorList('01JXOP1 name true\n')).toThrow(/fewer than six/);
    // The five-field line the server sent before ADR-0055: refused, rather
    // than read as a six-field one with the flags shifted by a word.
    expect(() => parseOperatorList('01JXOP1 name - true false\n')).toThrow(/fewer than six/);
    expect(() => parseOperatorList('01JXOP1 name - yes false a@b\n')).toThrow(
      /never_independently_signed_in/,
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0055: the notices, the two assertion-carrying verbs, and the SMTP
// envelope. Vectors from the same independent Python one-liner.
// ---------------------------------------------------------------------------

describe('parseNotices (operators.rs notices, admin.rs notices)', () => {
  it('reads LP-framed lines until the body runs out, and keeps one it does not know', () => {
    const hex =
      '100000006f6e655f6f70657261746f7220312033' + // lp("one_operator 1 3")
      '290000007265636f76657265645f66726f6d5f686f73742031373839303030303030203137' +
      '3839363034383030' + // lp("recovered_from_host 1789000000 1789604800")
      '0f000000736f6d657468696e675f6e65772031'; // lp("something_new 1")
    expect(parseNotices(fromHex(hex))).toEqual([
      { kind: 'one_operator', live: 1, weeks: 3, line: 'one_operator 1 3' },
      {
        kind: 'recovered_from_host',
        atUnix: 1_789_000_000,
        untilUnix: 1_789_604_800,
        line: 'recovered_from_host 1789000000 1789604800',
      },
      { kind: 'unknown', line: 'something_new 1' },
    ]);
  });

  it('is empty for an empty answer: no notice is a legal answer', () => {
    expect(parseNotices(new Uint8Array(0))).toEqual([]);
  });
});

describe('parsePendingAnswer (admin.rs pending_response)', () => {
  it('reads LP(id) || u64(effective_at)', () => {
    expect(
      parsePendingAnswer(fromHex('1800000030314a584348414e47453030303030303030303030303031008db26a00000000')),
    ).toEqual({ id: '01JXCHANGE00000000000001', effectiveAtUnix: 1_790_086_400 });
  });
});

describe('operatorRequestBytes (operators.rs operator_request_bytes)', () => {
  it('signs the address as well as the name: the operator signs where the invitation goes', () => {
    expect(toHex(operatorRequestBytes('01JXDEPLOY', '01JXOP1', 'Ada Lovelace', 'ada@example.test'))).toBe(
      '1f000000666174686f6d2f736974652f6f70657261746f722f726571756573742f7631' +
        '0a00000030314a584445504c4f59' +
        '0700000030314a584f5031' +
        '0c000000416461204c6f76656c616365' +
        '10000000616461406578616d706c652e74657374',
    );
  });

  it('carries the same three fields in the body', () => {
    expect(toHex(buildOperatorRequestBody('Jo', 'a@b', new Uint8Array([7])))).toBe(
      '020000004a6f' + '03000000614062' + '0100000007',
    );
  });
});

describe('the smtp value envelope (placement.rs smtp_value_bytes)', () => {
  const SMTP_HEX =
    '10000000736d74702e6578616d706c652e6e6574' + // lp("smtp.example.net")
    '03000000353837' + //                          lp("587") -- the port as TEXT
    '080000007374617274746c73' + //                lp("starttls")
    '06000000666174686f6d' + //                    lp("fathom")
    '0f00000068756e746572322d68756e74657232' + //  lp("hunter2-hunter2")
    '12000000666174686f6d406578616d706c652e6e6574'; // lp("fathom@example.net")

  const settings = {
    host: 'smtp.example.net',
    port: 587,
    tlsMode: 'starttls' as const,
    user: 'fathom',
    password: 'hunter2-hunter2',
    fromAddress: 'fathom@example.net',
  };

  it('is six fields with the port as text, so a dump is legible without an enum table', () => {
    expect(toHex(smtpValueBytes(settings))).toBe(SMTP_HEX);
  });

  it('signs the DIGEST of that value, never the value: the password is a credential', async () => {
    const bytes = await settingRequestBytes('01JXDEPLOY', '01JXOP1', 'smtp', smtpValueBytes(settings));
    expect(toHex(bytes)).toBe(
      '1e000000666174686f6d2f736974652f73657474696e672f726571756573742f7631' +
        '0a00000030314a584445504c4f59' +
        '0700000030314a584f5031' +
        '04000000736d7470' +
        '200000001964468441b555753bbe9038a284a77b9b9dfd00860972048dc1a36255a8e82c',
    );
    // The password's bytes appear nowhere in what is signed.
    expect(toHex(bytes).includes(toHex(new TextEncoder().encode('hunter2-hunter2')))).toBe(false);
  });

  it('carries key, value and assertion in the body', () => {
    expect(toHex(buildSettingBody('smtp', new Uint8Array([1, 2]), new Uint8Array([3])))).toBe(
      '04000000736d7470' + '020000000102' + '0100000003',
    );
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

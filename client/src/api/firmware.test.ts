import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./signedFetch', () => ({ signedFetch: vi.fn() }));

import { readLp, readU64LE, toHex } from '../crypto/bytes';
import { ApiRefusal } from './errors';
import {
  FirmwareOff,
  declarationBody,
  declareImage,
  firmwareRefusalWords,
  issueFetchLink,
  listFirmware,
  parseImages,
  sendImageBytes,
  shortHash,
  sizeWords,
} from './firmware';
import { signedFetch } from './signedFetch';

const signed = vi.mocked(signedFetch);
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const HASH = 'ab'.repeat(32);

const COMMANDS = {
  expected_sha256: HASH,
  device_path: '/var/tmp/junos.tgz',
  sourced: 'summary',
  sourced_note: 'Check them.',
  steps: [{ order: 1, step: 'check space first', command: 'show system storage', note: 'n', run_by: 'operator' }],
};

const IMAGE = {
  image_id: '01JQZ0000000000000000000I1',
  scope_id: 's',
  filename: 'junos.tgz',
  byte_length: 1_400_000_000,
  state: 'staged',
  failed_reason: null,
  created_at_unix: 10,
  staged_at_unix: 20,
  staged_seq: 3,
  sha256: HASH,
  commands: COMMANDS,
};

afterEach(() => {
  signed.mockReset();
  vi.unstubAllGlobals();
});

describe('reading the list', () => {
  it('reads staged, declared and failed images, with or without platform and version', () => {
    const list = parseImages(
      bytes([
        { ...IMAGE, platform: 'junos-ex', version: '21.4R3-S5', models: ['ex2300-24p', 'ex2300-48p'] },
        { ...IMAGE, image_id: 'B', state: 'failed', failed_reason: 'hash_mismatch', sha256: null, commands: null },
      ]),
    );
    expect(list[0]).toMatchObject({ imageId: IMAGE.image_id, state: 'staged', sha256: HASH, platform: 'junos-ex', version: '21.4R3-S5', models: ['ex2300-24p', 'ex2300-48p'], byteLength: 1_400_000_000 });
    expect(list[0]!.commands?.steps[0]).toMatchObject({ step: 'check space first', command: 'show system storage' });
    expect(list[1]).toMatchObject({ state: 'failed', failedReason: 'hash_mismatch', sha256: null, commands: null, platform: null, version: null, models: [] });
  });

  it('refuses a list that is not one', () => {
    expect(() => parseImages(bytes({ no: 1 }))).toThrow('not an array');
    expect(() => parseImages(bytes([{ filename: 'x' }]))).toThrow('image_id');
  });

  it('a bare 404 means firmware is off', async () => {
    signed.mockRejectedValue(new ApiRefusal(404, 'refused', null));
    await expect(listFirmware('o', 's')).rejects.toBeInstanceOf(FirmwareOff);
  });

  it('a 404 that names the scope is a real refusal, not "off"', async () => {
    signed.mockRejectedValue(new ApiRefusal(404, 'no such scope', null));
    await expect(listFirmware('o', 's')).rejects.toBeInstanceOf(ApiRefusal);
  });

  it('asks for the scope path, signed', async () => {
    signed.mockResolvedValue(bytes([]));
    expect(await listFirmware('org 1', 'sc/2')).toEqual([]);
    expect(signed).toHaveBeenCalledWith('GET', '/organisations/org%201/scopes/sc%2F2/firmware');
  });
});

describe('declaring', () => {
  it('writes the body the server reads: filename, length, hash, each length-prefixed', () => {
    const body = declarationBody({ filename: 'junos.tgz', byteLength: 1_400_000_000, sha256: HASH }, false);
    const a = readLp(body);
    expect(new TextDecoder().decode(a.value)).toBe('junos.tgz');
    const b = readLp(a.rest);
    expect(readU64LE(b.value)).toBe(1_400_000_000n);
    const c = readLp(b.rest);
    expect(toHex(c.value)).toBe(HASH);
    expect(c.rest.length).toBe(0);
  });

  it('adds platform and version after the hash when asked', () => {
    const body = declarationBody({ filename: 'a.tgz', byteLength: 5, sha256: HASH, platform: 'junos-ex', version: '21.4R3', models: ['a', 'b'] }, true);
    let r = readLp(body);
    r = readLp(r.rest);
    r = readLp(r.rest);
    const p = readLp(r.rest);
    expect(new TextDecoder().decode(p.value)).toBe('junos-ex');
    const v = readLp(p.rest);
    expect(new TextDecoder().decode(v.value)).toBe('21.4R3');
    expect(new TextDecoder().decode(readLp(v.rest).value)).toBe('a,b');
  });

  it('refuses a hash that is not 64 hex characters before anything is sent', () => {
    expect(() => declarationBody({ filename: 'a', byteLength: 1, sha256: 'abc' }, false)).toThrow('64');
  });

  const DECLARED = { image_id: 'I1', filename: 'a', byte_length: 5, upload_path: '/firmware/uploads/I1', upload_token: 'tok', upload_token_header: 'fathom-firmware-upload-token', upload_token_expires_at_unix: 99 };

  it('declares with platform and version, and again without them when the server does not take them yet', async () => {
    signed.mockRejectedValueOnce(new ApiRefusal(400, 'the declaration body is not the shape it must be', null)).mockResolvedValueOnce(bytes(DECLARED));
    const out = await declareImage('o', 's', { filename: 'a.tgz', byteLength: 5, sha256: HASH, platform: 'eos', version: '4.30.2F' });
    expect(out).toMatchObject({ imageId: 'I1', uploadPath: '/firmware/uploads/I1', uploadToken: 'tok' });
    expect(signed).toHaveBeenCalledTimes(2);
    expect(signed.mock.calls[0]![2]!.length).toBeGreaterThan(signed.mock.calls[1]![2]!.length);
  });

  it('does not retry a refusal that is about something else', async () => {
    signed.mockRejectedValue(new ApiRefusal(403, 'not authorised', null));
    await expect(declareImage('o', 's', { filename: 'a.tgz', byteLength: 5, sha256: HASH, platform: 'eos' })).rejects.toBeInstanceOf(ApiRefusal);
    expect(signed).toHaveBeenCalledTimes(1);
  });
});

describe('the one-time link', () => {
  it('reads the url, the hash and when it ends', async () => {
    signed.mockResolvedValue(bytes({ image_id: 'I1', filename: 'a.tgz', byte_length: 5, sha256: HASH, fetch_url: 'https://fathom.example/firmware/fetch/abc', fetch_token_id: 't', fetch_url_expires_at_unix: 1234, issued_seq: 1, commands: COMMANDS }));
    const link = await issueFetchLink('org', 'I1');
    expect(link).toMatchObject({ url: 'https://fathom.example/firmware/fetch/abc', expiresAtUnix: 1234, sha256: HASH });
    expect(link.commands?.expectedSha256).toBe(HASH);
    expect(signed).toHaveBeenCalledWith('POST', '/organisations/org/firmware/I1/fetch-urls');
  });
});

describe('sending the bytes', () => {
  class FakeXhr {
    static last: FakeXhr;
    status = 200;
    responseText = '';
    headers: Record<string, string> = {};
    upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    opened: [string, string] | null = null;
    body: unknown;
    constructor() {
      FakeXhr.last = this;
    }
    open(m: string, u: string) {
      this.opened = [m, u];
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(b: unknown) {
      this.body = b;
    }
    abort() {
      this.onabort?.();
    }
  }
  const declared = { imageId: 'I1', uploadPath: '/firmware/uploads/I1', uploadToken: 'tok', tokenHeader: 'fathom-firmware-upload-token', expiresAtUnix: 0 };

  it('posts the File itself with the token in the header, and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File([new Uint8Array(10)], 'a.tgz');
    const seen: number[] = [];
    const done = sendImageBytes(declared, file, (sent) => seen.push(sent));
    const x = FakeXhr.last;
    expect(x.opened).toEqual(['POST', '/firmware/uploads/I1']);
    expect(x.headers['fathom-firmware-upload-token']).toBe('tok');
    expect(x.body).toBe(file);
    x.upload.onprogress?.({ loaded: 4, total: 10, lengthComputable: true });
    x.responseText = JSON.stringify(IMAGE);
    x.onload?.();
    expect((await done)?.state).toBe('staged');
    expect(seen).toEqual([4]);
  });

  it('carries the server refusal as it was said', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const done = sendImageBytes(declared, new File([new Uint8Array(1)], 'a'), () => {});
    const x = FakeXhr.last;
    x.status = 409;
    x.responseText = 'NOTHING WAS STAGED. 5 bytes arrived against a declared 5, and the SHA-256 of what arrived did not match what was declared.\n';
    x.onload?.();
    await expect(done).rejects.toMatchObject({ status: 409 });
    await done.catch((e) => expect(firmwareRefusalWords(e)).toMatch(/^NOTHING WAS STAGED/));
  });
});

describe('words', () => {
  it('says 403 plainly', () => {
    expect(firmwareRefusalWords(new ApiRefusal(403, 'not authorised', null))).toBe('Only a steward can do this. Ask someone with steward access.');
    expect(firmwareRefusalWords(new FirmwareOff())).toBe('Firmware is off on this server.');
    expect(firmwareRefusalWords(new Error('boom'))).toBe('boom');
  });
  it('writes sizes and hashes short', () => {
    expect(sizeWords(1_400_000_000)).toBe('1.4 GB');
    expect(sizeWords(812_000_000)).toBe('812 MB');
    expect(sizeWords(900)).toBe('900 bytes');
    expect(shortHash(HASH)).toBe('abab…abab');
    expect(shortHash(null)).toBe('');
  });
});

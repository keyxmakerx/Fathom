// Vectors from bitwarden/sdk-internal at 5cf9198 (2026-10-23), `crates/bitwarden-crypto`, each
// named where it comes from, so this browser code opens exactly what Bitwarden's own does.

import { describe, expect, it } from 'vitest';

import { concatBytes, utf8 } from '../crypto/bytes';
import { decryptType2, decryptType4, masterKey, parseEncString, stretch } from './bitwarden';

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
// `keys/kdf.rs` test_master_key_derive_pbkdf2, and `keys/utils.rs` test_stretch_kdf_key.
const KDF_OUT = [31, 79, 104, 226, 150, 71, 177, 90, 194, 80, 172, 209, 17, 129, 132, 81, 138, 167, 69, 167, 254, 149, 2, 27, 39, 197, 64, 42, 22, 195, 86, 75];

describe('Bitwarden key derivation, against the SDK’s own vectors', () => {
  it('PBKDF2-SHA256 over the password with the e-mail as salt', async () => {
    expect([...(await masterKey('67t9b5g67$%Dh89n', 'test_key', { type: 'pbkdf2', iterations: 10000 }))]).toEqual(KDF_OUT);
  });
  it('the e-mail is trimmed and lower-cased', async () => {
    const a = await masterKey('pw', ' Test@Example.COM ', { type: 'pbkdf2', iterations: 5000 });
    const b = await masterKey('pw', 'test@example.com', { type: 'pbkdf2', iterations: 5000 });
    expect(a).toEqual(b);
  });
  it('stretches with HKDF-Expand, "enc" then "mac"', async () => {
    const s = await stretch(new Uint8Array(KDF_OUT));
    expect([...s.enc]).toEqual([111, 31, 178, 45, 238, 152, 37, 114, 143, 215, 124, 83, 135, 173, 195, 23, 142, 134, 120, 249, 61, 132, 163, 182, 113, 197, 189, 204, 188, 21, 237, 96]);
    expect([...s.mac]).toEqual([221, 127, 206, 234, 101, 27, 202, 38, 86, 52, 34, 28, 78, 28, 185, 16, 48, 61, 127, 166, 209, 247, 194, 87, 232, 26, 48, 85, 193, 249, 179, 155]);
  });
  it('refuses Argon2id in words, for now', async () => {
    await expect(masterKey('pw', 'a@b', { type: 'argon2id', iterations: 3, memoryMiB: 64, parallelism: 4 })).rejects.toThrow(/PBKDF2/);
  });
});

describe('type 2 and type 4 values', () => {
  // `hazmat/symmetric_encryption/aes256_cbc_hmac_sha256_ae.rs` test_decrypt_testvector.
  const key = new Uint8Array(64).map((_, i) => i);
  const iv = new Uint8Array([216, 218, 36, 0, 196, 186, 150, 85, 49, 147, 110, 168, 185, 227, 42, 172]);
  const mac = new Uint8Array([60, 78, 44, 111, 72, 233, 3, 6, 86, 250, 217, 242, 62, 229, 184, 221, 231, 150, 189, 44, 99, 189, 220, 55, 196, 194, 101, 60, 102, 195, 149, 130]);
  const data = new Uint8Array([234, 77, 16, 15, 189, 82, 36, 188, 182, 88, 64, 67, 145, 94, 30, 178, 36, 235, 130, 67, 255, 207, 183, 168, 73, 231, 82, 122, 193, 139, 25, 129]);
  const value = `2.${b64(iv)}|${b64(data)}|${b64(mac)}`;

  it('opens the SDK’s type-2 vector', async () => {
    const out = await decryptType2(value, { enc: key.slice(0, 32), mac: key.slice(32) });
    expect(new TextDecoder().decode(out)).toBe('Bitwarden SDK test vector');
  });
  it('a changed MAC or the wrong key never reaches AES', async () => {
    const bad = `2.${b64(iv)}|${b64(data)}|${b64(concatBytes(mac.slice(0, 31), new Uint8Array([mac[31] ^ 1])))}`;
    await expect(decryptType2(bad, { enc: key.slice(0, 32), mac: key.slice(32) })).rejects.toThrow(/did not open/);
    await expect(decryptType2(value, { enc: key.slice(0, 32), mac: utf8('x'.repeat(32)) })).rejects.toThrow(/did not open/);
  });
  it('only types 2 and 4 are taken', () => {
    expect(() => parseEncString('0.AAAA|BBBB')).toThrow(/type 0/);
    expect(() => parseEncString('7.AAAA')).toThrow(/type 7/);
  });
  it('opens the SDK’s type-4 (RSA-2048-OAEP-SHA1) vector into a 64-byte key', async () => {
    // `enc_string/asymmetric.rs` test_enc_string_rsa2048_oaep_sha1_b64.
    const der = Uint8Array.from(atob('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCXRVrCX+2hfOQS8HzYUS2oc/jGVTZpv+/Ryuoh9d8ihYX9dd0cYh2tl6KWdFc88lPUH11Oxqy20Rk2e5r/RF6T9yM0Me3NPnaKt+hlhLtfoc0h86LnhD56A9FDUfuI0dVnPcrwNv0YJIo94LwxtbqBULNvXl6wJ7WAbODrCQy5ZgMVg+iH+gGpwiqsZqHt+KuoHWcN53MSPDfaF4/YMB99U3TziJMOOJask1TEEnakMPln11PczNDazT17DXIxYrbPfutPdh6sLs6AQOajdZijfEvepgnOe7cQ7aeatiOJFrjTApKPGxOVRzEMX4XS4xbyhH0QxQeB6l16l8C0uxIBAgMBAAECggEASaWfeVDA3cVzOPFSpvJm20OTE+R6uGOU+7vh36TX/POq92qBuwbd0h0oMD32FxsXywd2IxtBDUSiFM9699qufTVuM0Q3tZw6lHDTOVG08+tPdr8qSbMtw7PGFxN79fHLBxejjO4IrM9lapjWpxEF+11x7r+wM+0xRZQ8sNFYG46aPfIaty4BGbL0I2DQ2y8I57iBCAy69eht59NLMm27fRWGJIWCuBIjlpfzET1j2HLXUIh5bTBNzqaN039WH49HczGE3mQKVEJZc/efk3HaVd0a1Sjzyn0QY+N1jtZN3jTRbuDWA1AknkX1LX/0tUhuS3/7C3ejHxjw4Dk1ZLo5/QKBgQDIWvqFn0+IKRSu6Ua2hDsufIHHUNLelbfLUMmFthxabcUn4zlvIscJO00Tq/ezopSRRvbGiqnxjv/mYxucvOUBeZtlus0Q9RTACBtw9TGoNTmQbEunJ2FOSlqbQxkBBAjgGEppRPt30iGj/VjAhCATq2MYOa/X4dVR51BqQAFIEwKBgQDBSIfTFKC/hDk6FKZlgwvupWYJyU9RkyfstPErZFmzoKhPkQ3YORo2oeAYmVUbS9I2iIYpYpYQJHX8jMuCbCz4ONxTCuSIXYQYUcUq4PglCKp31xBAE6TN8SvhfME9/MvuDssnQinAHuF0GDAhF646T3LLS1not6Vszv7brwSoGwKBgQC88v/8cGfi80ssQZeMnVvq1UTXIeQcQnoY5lGHJl3K8mbS3TnXE6c9j417Fdz+rj8KWzBzwWXQB5pSPflWcdZO886Xu/mVGmy9RWgLuVFhXwCwsVEPjNX5ramRb0/vY0yzenUCninBsIxFSbIfrPtLUYCc4hpxr+sr2Mg/y6jpvQKBgBezMRRs3xkcuXepuI2R+BCXL1/b02IJTUf1F+1eLLGd7YV0H+J3fgNc7gGWK51hOrF9JBZHBGeOUPlaukmPwiPdtQZpu4QNE3l37VlIpKTF30E6mb+BqR+nht3rUjarnMXgAoEZ18y6/KIjpSMpqC92Nnk/EBM9EYe6Cf4eA9ApAoGAeqEUg46UTlJySkBKURGpIs3v1kkf5I0X8DnOhwb+HPxNaiEdmO7ckm8+tPVgppLcG0+tMdLjigFQiDUQk2y3WjyxP5ZvXu7U96jaJRI8PFMoE06WeVYcdIzrID2HvqH+w0UQJFrLJ/0Mn4stFAEzXKZBokBGnjFnTnKcs7nv/O8='), (c) => c.charCodeAt(0));
    const out = await decryptType4(
      '4.DMD1D5r6BsDDd7C/FE1eZbMCKrmryvAsCKj6+bO54gJNUxisOI7SDcpPLRXf+JdhqY15pT+wimQ5cD9C+6OQ6s71LFQHewXPU29l9Pa1JxGeiKqp37KLYf+1IS6UB2K3ANN35C52ZUHh2TlzIS5RuntxnpCw7APbcfpcnmIdLPJBtuj/xbFd6eBwnI3GSe5qdS6/Ixdd0dgsZcpz3gHJBKmIlSo0YN60SweDq3kTJwox9xSqdCueIDg5U4khc7RhjYx8b33HXaNJj3DwgIH8iLj+lqpDekogr630OhHG3XRpvl4QzYO45bmHb8wAh67Dj70nsZcVg6bAEFHdSFohww==',
      der,
    );
    expect(out.length).toBe(64);
  });
});

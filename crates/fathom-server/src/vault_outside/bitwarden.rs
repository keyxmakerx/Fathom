//! **Opening a Bitwarden-format type-2 value on the server** (ADR-0071 part four): an outside
//! item's name, user name and password, and an item's own key, under the 64-byte organisation
//! key a person's browser handed over at connect (`client/src/vault/bitwarden.ts` opens that one
//! with WebCrypto; nothing here touches RSA or the master password).
//!
//! Source, read 2026-10-25 and again 2026-10-26: bitwarden/sdk-internal `crates/bitwarden-crypto`,
//! `hazmat/symmetric_encryption/aes256_cbc_hmac_sha256_ae.rs` (MAC = HMAC-SHA256(mac_key,
//! iv ‖ ciphertext), checked before AES-256-CBC with PKCS#7) and `enc_string/symmetric.rs`
//! ("2.iv|ct|mac", standard base64); `crates/bitwarden-vault/src/cipher/cipher.rs`
//! `decrypt_cipher_key` (an item with its own `key` has its fields sealed under that key,
//! which is itself sealed under the organisation key). The test vector is the SDK's own
//! `test_decrypt_testvector`, the same one `client/src/vault/bitwarden.test.ts` pins.
//!
//! **The MAC is checked first, in constant time** (`crypto::mac_verify`), so a wrong key or a
//! changed byte is refused before AES runs: no padding oracle.

use aes::Aes256;
use cbc::cipher::{block_padding::Pkcs7, BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};

use crate::crypto;

/// A 64-byte Bitwarden key: AES-256 key, then HMAC key. Wiped on drop, never printed.
pub struct BwKey([u8; 64]);

impl BwKey {
    pub fn from_slice(b: &[u8]) -> Option<Self> {
        Some(Self(b.try_into().ok()?))
    }
    pub fn expose(&self) -> &[u8; 64] {
        &self.0
    }
}

impl Drop for BwKey {
    fn drop(&mut self) {
        self.0.iter_mut().for_each(|b| *b = 0);
        core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
    }
}

/// Why a value did not open. Names no byte of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenError {
    NotType2,
    Malformed,
    /// The wrong key, or a changed value: the MAC did not verify.
    Mac,
    Padding,
}

/// RFC 4648 §4 base64, padded, strict: no whitespace, no URL alphabet, canonical last bits.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.is_empty() || !b.len().is_multiple_of(4) {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let chunks = b.len() / 4;
    for (i, q) in b.chunks(4).enumerate() {
        let last = i + 1 == chunks;
        let pad = q.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for (j, &c) in q.iter().enumerate() {
            let v = if j >= 4 - pad { 0 } else { val(c)? };
            n = (n << 6) | v;
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        // Canonical: the bits a padded quantum drops must be zero.
        if (pad == 1 && bytes[2] != 0) || (pad == 2 && bytes[1] != 0) {
            return None;
        }
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Some(out)
}

/// Open "2.iv|ct|mac" under `key`.
pub fn open_type2(value: &str, key: &BwKey) -> Result<Vec<u8>, OpenError> {
    let rest = value.strip_prefix("2.").ok_or(OpenError::NotType2)?;
    let mut parts = rest.split('|');
    let (Some(iv), Some(ct), Some(mac), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(OpenError::Malformed);
    };
    let iv = b64_decode(iv).ok_or(OpenError::Malformed)?;
    let ct = b64_decode(ct).ok_or(OpenError::Malformed)?;
    let mac = b64_decode(mac).ok_or(OpenError::Malformed)?;
    if iv.len() != 16 || mac.len() != 32 || ct.is_empty() || ct.len() % 16 != 0 {
        return Err(OpenError::Malformed);
    }
    let (enc_key, mac_key) = key.expose().split_at(32);
    let mut signed = iv.clone();
    signed.extend_from_slice(&ct);
    if !crypto::mac_verify(mac_key, &signed, &mac) {
        return Err(OpenError::Mac);
    }
    let dec = cbc::Decryptor::<Aes256>::new_from_slices(enc_key, &iv)
        .map_err(|_| OpenError::Malformed)?;
    let mut buf = ct;
    let n = dec
        .decrypt_padded::<Pkcs7>(&mut buf)
        .map_err(|_| OpenError::Padding)?
        .len();
    buf.truncate(n);
    Ok(buf)
}

/// Open a value that is text: a name, a user name, a password.
pub fn open_text(value: &str, key: &BwKey) -> Result<String, OpenError> {
    String::from_utf8(open_type2(value, key)?).map_err(|_| OpenError::Malformed)
}

/// An item's own key, when it has one, else the organisation key it is under.
pub fn item_key(protected: Option<&str>, org: &BwKey) -> Result<Option<BwKey>, OpenError> {
    match protected {
        None => Ok(None),
        Some(p) => {
            let mut raw = open_type2(p, org)?;
            let k = BwKey::from_slice(&raw).ok_or(OpenError::Malformed);
            raw.iter_mut().for_each(|b| *b = 0);
            k.map(Some)
        }
    }
}

/// RFC 4648 §4 base64, padded.
pub fn b64_encode(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// Seal `plain` as "2.iv|ct|mac" under `key`. **Fathom never writes to an outside vault**; this
/// is here so tests and stand-in vaults seal values exactly as Bitwarden clients do, and so
/// the opener is tested against its own inverse.
pub fn seal_type2(plain: &[u8], key: &BwKey, iv: &[u8; 16]) -> String {
    let (enc_key, mac_key) = key.expose().split_at(32);
    let enc =
        cbc::Encryptor::<Aes256>::new_from_slices(enc_key, iv).expect("32-byte key, 16-byte iv");
    let mut buf = plain.to_vec();
    buf.resize(plain.len() / 16 * 16 + 16, 0);
    let ct = enc
        .encrypt_padded::<Pkcs7>(&mut buf, plain.len())
        .expect("room for one block of padding")
        .to_vec();
    let mut signed = iv.to_vec();
    signed.extend_from_slice(&ct);
    let mac = crypto::mac(mac_key, &signed);
    buf.iter_mut().for_each(|b| *b = 0);
    format!(
        "2.{}|{}|{}",
        b64_encode(iv),
        b64_encode(&ct),
        b64_encode(&mac)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::b64_encode as b64;

    // sdk-internal `aes256_cbc_hmac_sha256_ae.rs` test_decrypt_testvector.
    const IV: [u8; 16] = [
        216, 218, 36, 0, 196, 186, 150, 85, 49, 147, 110, 168, 185, 227, 42, 172,
    ];
    const MAC: [u8; 32] = [
        60, 78, 44, 111, 72, 233, 3, 6, 86, 250, 217, 242, 62, 229, 184, 221, 231, 150, 189, 44,
        99, 189, 220, 55, 196, 194, 101, 60, 102, 195, 149, 130,
    ];
    const DATA: [u8; 32] = [
        234, 77, 16, 15, 189, 82, 36, 188, 182, 88, 64, 67, 145, 94, 30, 178, 36, 235, 130, 67,
        255, 207, 183, 168, 73, 231, 82, 122, 193, 139, 25, 129,
    ];

    fn key() -> BwKey {
        let mut k = [0u8; 64];
        k.iter_mut().enumerate().for_each(|(i, b)| *b = i as u8);
        BwKey(k)
    }

    #[test]
    fn it_opens_the_sdks_vector() {
        let v = format!("2.{}|{}|{}", b64(&IV), b64(&DATA), b64(&MAC));
        assert_eq!(open_text(&v, &key()).unwrap(), "Bitwarden SDK test vector");
    }

    #[test]
    fn a_changed_byte_or_another_key_is_a_mac_failure_before_aes() {
        let mut mac = MAC;
        mac[31] ^= 1;
        let v = format!("2.{}|{}|{}", b64(&IV), b64(&DATA), b64(&mac));
        assert_eq!(open_type2(&v, &key()), Err(OpenError::Mac));
        let v = format!("2.{}|{}|{}", b64(&IV), b64(&DATA), b64(&MAC));
        assert_eq!(open_type2(&v, &BwKey([9; 64])), Err(OpenError::Mac));
        assert_eq!(open_type2("4.AAAA", &key()), Err(OpenError::NotType2));
        assert_eq!(open_type2("2.AAAA|BBBB", &key()), Err(OpenError::Malformed));
    }

    #[test]
    fn what_it_seals_opens_and_matches_the_sdks_vector() {
        assert_eq!(
            seal_type2(b"Bitwarden SDK test vector", &key(), &IV),
            format!("2.{}|{}|{}", b64(&IV), b64(&DATA), b64(&MAC))
        );
        for n in [0, 1, 15, 16, 17, 64] {
            let plain = vec![7u8; n];
            assert_eq!(
                open_type2(&seal_type2(&plain, &key(), &[3; 16]), &key()).unwrap(),
                plain
            );
        }
    }

    #[test]
    fn base64_is_strict() {
        assert_eq!(b64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(b64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(b64_decode("TQ==").unwrap(), b"M");
        for bad in ["", "TQ=", "TR==", "T===", "TQ==TQ==", "TW-u", "TW u"] {
            assert!(b64_decode(bad).is_none(), "{bad}");
        }
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(b64_decode(&b64(&all)).unwrap(), all);
    }
}

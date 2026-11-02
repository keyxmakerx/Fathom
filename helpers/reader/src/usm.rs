//! SNMPv3's user-based security, authPriv only (ADR-0082 §4.5).
//!
//! - Keys from a password, then localised to one engine: RFC 3414 Appendix A.2.2 for SHA-1, and
//!   RFC 7860 §9.3 for SHA-2 ("Appendix A.1 of RFC 3414 with MD5 being replaced by the SHA-2 hash
//!   function H"). The 1,048,576-octet string of the repeated password is hashed, then
//!   `H(Ku ‖ engineID ‖ Ku)`.
//! - Authentication: HMAC over the whole message with the authentication parameters set to N zero
//!   octets, keeping the first N octets (RFC 3414 §7.3.1 for HMAC-SHA-96, N = 12; RFC 7860 §4.2.1
//!   and §4: N = 24 for usmHMAC192SHA256, 48 for usmHMAC384SHA512).
//! - Privacy: AES-128 in CFB mode with s = 128 (RFC 3826 §3.1.3), the key the first 128 bits of
//!   the localised privacy key, the IV `snmpEngineBoots ‖ snmpEngineTime ‖ salt`, each
//!   most-significant byte first (§3.1.2.1), the 8-octet salt sent as msgPrivacyParameters, no
//!   padding.
//!
//! HMAC-MD5-96 and CBC-DES are refused (ADR-0082 §4.5): there is no code for them here at all.
//! Sources read 2026-11-02: RFC 3414 from net-snmp's doc/rfc/snmpV3 copy; RFC 3826 and RFC 7860
//! from rfc-editor.org.

use aes::cipher::KeyIvInit;
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};

/// The authentication protocols this reader offers, best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    /// usmHMAC384SHA512AuthProtocol (RFC 7860).
    Sha512,
    /// usmHMAC192SHA256AuthProtocol (RFC 7860).
    Sha256,
    /// usmHMACSHAAuthProtocol, HMAC-SHA-96 (RFC 3414). Accepted, and marked older on the login.
    Sha1,
}

impl Auth {
    pub fn parse(s: &str) -> Option<Auth> {
        match s {
            "sha512" => Some(Auth::Sha512),
            "sha256" => Some(Auth::Sha256),
            "sha1" => Some(Auth::Sha1),
            _ => None,
        }
    }

    /// N, the octets of the HMAC kept as the MAC.
    pub fn mac_len(self) -> usize {
        match self {
            Auth::Sha512 => 48,
            Auth::Sha256 => 24,
            Auth::Sha1 => 12,
        }
    }

    fn digest(self, parts: &[&[u8]]) -> Vec<u8> {
        fn run<D: Digest>(parts: &[&[u8]]) -> Vec<u8> {
            let mut h = D::new();
            for p in parts {
                h.update(p);
            }
            h.finalize().to_vec()
        }
        match self {
            Auth::Sha512 => run::<Sha512>(parts),
            Auth::Sha256 => run::<Sha256>(parts),
            Auth::Sha1 => run::<Sha1>(parts),
        }
    }
}

/// RFC 3414 §11.2: implementations "must ensure that passwords are at least 8 characters".
pub const MIN_PASSWORD: usize = 8;

/// Ku: the password, repeated to 1,048,576 octets, hashed (RFC 3414 A.2.2).
pub fn password_to_key(auth: Auth, password: &[u8]) -> Vec<u8> {
    const TOTAL: usize = 1_048_576;
    fn run<D: Digest>(password: &[u8]) -> Vec<u8> {
        let mut h = D::new();
        let mut block = [0u8; 64];
        let mut at = 0usize;
        for _ in 0..TOTAL / 64 {
            for b in block.iter_mut() {
                *b = password[at % password.len()];
                at += 1;
            }
            h.update(block);
        }
        h.finalize().to_vec()
    }
    if password.is_empty() {
        return Vec::new();
    }
    match auth {
        Auth::Sha512 => run::<Sha512>(password),
        Auth::Sha256 => run::<Sha256>(password),
        Auth::Sha1 => run::<Sha1>(password),
    }
}

/// Kul: Ku localised to one engine, `H(Ku ‖ engineID ‖ Ku)`.
pub fn localise(auth: Auth, ku: &[u8], engine_id: &[u8]) -> Vec<u8> {
    auth.digest(&[ku, engine_id, ku])
}

/// The MAC over a whole message whose authentication parameters are N zero octets.
pub fn mac(auth: Auth, key: &[u8], whole_message: &[u8]) -> Vec<u8> {
    fn run<D>(key: &[u8], msg: &[u8]) -> Vec<u8>
    where
        D: hmac::EagerHash,
        Hmac<D>: KeyInit + Mac,
    {
        let mut m = <Hmac<D> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
        m.update(msg);
        m.finalize().into_bytes().to_vec()
    }
    let mut out = match auth {
        Auth::Sha512 => run::<Sha512>(key, whole_message),
        Auth::Sha256 => run::<Sha256>(key, whole_message),
        Auth::Sha1 => run::<Sha1>(key, whole_message),
    };
    out.truncate(auth.mac_len());
    out
}

/// Compares two MACs in time that does not depend on where they differ.
pub fn same_mac(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn iv(boots: u32, time: u32, salt: &[u8; 8]) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[..4].copy_from_slice(&boots.to_be_bytes());
    iv[4..8].copy_from_slice(&time.to_be_bytes());
    iv[8..].copy_from_slice(salt);
    iv
}

fn aes_key(priv_key: &[u8]) -> Option<[u8; 16]> {
    priv_key.get(..16)?.try_into().ok()
}

/// Encrypts a scoped PDU in place (RFC 3826 §3.1.3).
pub fn encrypt(priv_key: &[u8], boots: u32, time: u32, salt: &[u8; 8], data: &mut [u8]) {
    let Some(key) = aes_key(priv_key) else { return };
    cfb_mode::Encryptor::<aes::Aes128>::new(&key.into(), &iv(boots, time, salt).into())
        .encrypt(data);
}

/// Decrypts an answer's scoped PDU in place (RFC 3826 §3.1.4).
pub fn decrypt(priv_key: &[u8], boots: u32, time: u32, salt: &[u8; 8], data: &mut [u8]) {
    let Some(key) = aes_key(priv_key) else { return };
    cfb_mode::Decryptor::<aes::Aes128>::new(&key.into(), &iv(boots, time, salt).into())
        .decrypt(data);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// RFC 3414 Appendix A.3.2, "Password to Key Sample Results using SHA".
    #[test]
    fn rfc3414_a32_sha_key_and_its_localisation() {
        let ku = password_to_key(Auth::Sha1, b"maplesyrup");
        assert_eq!(hex(&ku), "9fb5cc0381497b3793528939ff788d5d79145211");
        let engine = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
        assert_eq!(
            hex(&localise(Auth::Sha1, &ku, &engine)),
            "6695febc9288e36282235fc7151f128497b38f3f"
        );
    }

    #[test]
    fn sha2_keys_are_their_hash_s_length_and_macs_are_n_octets() {
        let engine = [0x80, 0, 0x1f, 0x88, 4, 1, 2, 3];
        for (auth, key_len) in [(Auth::Sha512, 64), (Auth::Sha256, 32), (Auth::Sha1, 20)] {
            let kul = localise(auth, &password_to_key(auth, b"maplesyrup"), &engine);
            assert_eq!(kul.len(), key_len);
            assert_eq!(mac(auth, &kul, b"message").len(), auth.mac_len());
        }
    }

    /// RFC 2202 §3 test case 2 for HMAC-SHA-1 ("Jefe", "what do ya want for nothing?"),
    /// truncated to 96 bits as RFC 3414 §7.3.1 step 4 does.
    #[test]
    fn hmac_sha1_96_is_the_first_twelve_octets() {
        assert_eq!(
            hex(&mac(Auth::Sha1, b"Jefe", b"what do ya want for nothing?")),
            "effcdf6ae5eb2fa2d27416d5"
        );
        assert!(same_mac(b"abc", b"abc"));
        assert!(!same_mac(b"abc", b"abd"));
        assert!(!same_mac(b"abc", b"ab"));
    }

    #[test]
    fn aes_cfb_round_trips_any_length_without_padding() {
        let key = [7u8; 20];
        let salt = [1, 2, 3, 4, 5, 6, 7, 8];
        let plain = b"a scoped PDU that is not a multiple of sixteen".to_vec();
        let mut buf = plain.clone();
        encrypt(&key, 3, 1000, &salt, &mut buf);
        assert_eq!(buf.len(), plain.len());
        assert_ne!(buf, plain);
        decrypt(&key, 3, 1000, &salt, &mut buf);
        assert_eq!(buf, plain);
    }
}

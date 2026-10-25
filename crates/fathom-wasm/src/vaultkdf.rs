//! `OP_VAULT_KDF`: Argon2id with a secret input, for the password vault (ADR-0043 §6).
//!
//! The vault opens with two secrets combined in one derivation: the passphrase a person types
//! and the 128-bit vault key Fathom generated at setup. Argon2's secret input `K` (RFC 9106
//! §3.1) is what combines them, so an offline attacker holding a stolen database faces the
//! 128-bit key, not the passphrase. Two separate wraps of one key would be two doors, and the
//! cheaper door would be the bound.

use argon2::{Algorithm, Argon2, Params, Version};

use crate::protocol::{self, ERR_BAD_FRAME};

/// The parameter ranges a request may ask for: (min, max) of memory in KiB, passes, lanes.
/// The floor is OWASP's Argon2id minimum the server's own password hash uses (`credentials.rs`,
/// 19 MiB, 2 passes, 1 lane); the ceiling keeps one call under 256 MiB.
pub const BOUNDS: [(u32, u32); 3] = [(19_456, 262_144), (2, 10), (1, 4)];

/// Salt and secret are fixed at 16 bytes: the vault writes exactly that, and a fixed size
/// leaves nothing to negotiate. A passphrase is 1 to 1,024 bytes.
pub const SALT_LEN: usize = 16;
pub const SECRET_LEN: usize = 16;
pub const MAX_PASSPHRASE: usize = 1024;

fn u32_at(req: &[u8], at: usize) -> Option<u32> {
    req.get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn lp_at(req: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let len = u32_at(req, at)? as usize;
    let start = at + 4;
    let end = start.checked_add(len)?;
    req.get(start..end).map(|v| (v, end))
}

/// Derive 32 bytes, or `None` for any frame or parameter outside the rules above.
pub fn derive(req: &[u8]) -> Option<[u8; 32]> {
    let (m, t, p) = (u32_at(req, 0)?, u32_at(req, 4)?, u32_at(req, 8)?);
    for (value, (lo, hi)) in [m, t, p].into_iter().zip(BOUNDS) {
        if value < lo || value > hi {
            return None;
        }
    }
    let (passphrase, at) = lp_at(req, 12)?;
    let (salt, at) = lp_at(req, at)?;
    let (secret, at) = lp_at(req, at)?;
    if at != req.len()
        || passphrase.is_empty()
        || passphrase.len() > MAX_PASSPHRASE
        || salt.len() != SALT_LEN
        || secret.len() != SECRET_LEN
    {
        return None;
    }
    let params = Params::new(m, t, p, Some(32)).ok()?;
    let kdf = Argon2::new_with_secret(secret, Algorithm::Argon2id, Version::V0x13, params).ok()?;
    let mut out = [0u8; 32];
    kdf.hash_password_into(passphrase, salt, &mut out).ok()?;
    Some(out)
}

/// The opcode: [`derive`], answered as one hex row or `ERR_BAD_FRAME`.
pub fn call(req: &[u8]) -> Vec<u8> {
    match derive(req) {
        Some(key) => {
            let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
            protocol::encode_vault_key_reply(&hex)
        }
        None => protocol::encode_error(
            ERR_BAD_FRAME,
            "a vault key request is three u32 costs within bounds, then a passphrase, a 16-byte \
             salt and a 16-byte secret, each length-prefixed",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(m: u32, t: u32, p: u32, pw: &[u8], salt: &[u8], secret: &[u8]) -> Vec<u8> {
        let mut f = Vec::new();
        for v in [m, t, p] {
            f.extend_from_slice(&v.to_le_bytes());
        }
        for part in [pw, salt, secret] {
            f.extend_from_slice(&(part.len() as u32).to_le_bytes());
            f.extend_from_slice(part);
        }
        f
    }

    /// RFC 9106 §5.3, the Argon2id test vector, read from rfc-editor.org/rfc/rfc9106.html on
    /// 2026-10-25. `deps/decisions/argon2.md` approved this crate on the condition that the
    /// implementation is pinned against the RFC's vectors; this is the vector WITH a secret input,
    /// which is the path the vault uses.
    #[test]
    fn rfc_9106_argon2id_vector_with_a_secret() {
        use argon2::{AssociatedData, ParamsBuilder};
        let params = ParamsBuilder::new()
            .m_cost(32)
            .t_cost(3)
            .p_cost(4)
            .output_len(32)
            .data(AssociatedData::new(&[0x04; 12]).unwrap())
            .build()
            .unwrap();
        let kdf = Argon2::new_with_secret(&[0x03; 8], Algorithm::Argon2id, Version::V0x13, params)
            .unwrap();
        let mut tag = [0u8; 32];
        kdf.hash_password_into(&[0x01; 32], &[0x02; 16], &mut tag)
            .unwrap();
        let hex: String = tag.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
        );
    }

    #[test]
    fn the_secret_changes_the_key() {
        let a = derive(&frame(19_456, 2, 1, b"correct horse", &[1; 16], &[2; 16])).unwrap();
        let b = derive(&frame(19_456, 2, 1, b"correct horse", &[1; 16], &[3; 16])).unwrap();
        let c = derive(&frame(19_456, 2, 1, b"correct horsf", &[1; 16], &[2; 16])).unwrap();
        assert_ne!(a, b, "the vault key is an input, not decoration");
        assert_ne!(a, c);
        assert_eq!(
            a,
            derive(&frame(19_456, 2, 1, b"correct horse", &[1; 16], &[2; 16])).unwrap()
        );
    }

    #[test]
    fn out_of_bounds_frames_are_refused() {
        let ok = frame(19_456, 2, 1, b"pw", &[0; 16], &[0; 16]);
        assert!(derive(&ok).is_some());
        assert!(derive(&frame(8, 2, 1, b"pw", &[0; 16], &[0; 16])).is_none());
        assert!(derive(&frame(19_456, 1, 1, b"pw", &[0; 16], &[0; 16])).is_none());
        assert!(derive(&frame(1 << 30, 2, 1, b"pw", &[0; 16], &[0; 16])).is_none());
        assert!(derive(&frame(19_456, 2, 1, b"", &[0; 16], &[0; 16])).is_none());
        assert!(derive(&frame(19_456, 2, 1, b"pw", &[0; 15], &[0; 16])).is_none());
        assert!(derive(&frame(19_456, 2, 1, b"pw", &[0; 16], &[0; 17])).is_none());
        let mut trailing = ok.clone();
        trailing.push(0);
        assert!(derive(&trailing).is_none());
        assert!(derive(&ok[..ok.len() - 1]).is_none());
    }
}

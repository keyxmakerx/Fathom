//! The primitives, in one file, with every constant that ever reaches the
//! database.
//!
//! **`docs/PHASE-2-STORAGE-DESIGN.md` §12 decided every choice below and §§11.2
//! and 12.2 fix the exact byte strings.** Nothing here is a preference:
//!
//! | Job | Primitive | Where it is settled |
//! |---|---|---|
//! | AEAD | ChaCha20-Poly1305, RFC 8439, random 96-bit nonce | §4, §12.3 |
//! | Chain MAC | HMAC-SHA-256 | §12.1 |
//! | KDF | HKDF-SHA-256, **Expand only** (`from_prk`) | §12.1 |
//! | CSPRNG | the OS generator, through `getrandom` | §12.4 |
//!
//! # Two rules that cannot be retrofitted
//!
//! **Every variable-length field is length-prefixed** — `LP(x) = u32_le(len(x))
//! ‖ x` (§11.2). §6's original construction concatenated three variable-length
//! values bare, which admits a splice: a different field split producing the
//! same byte string is a different history with the same seal. That line is
//! marked superseded in the design and must not be built. Adding the prefixes
//! later would invalidate every seal ever written, so they are here from the
//! first byte.
//!
//! **Poly1305 is not, and may not become, the chain MAC** (§11.2). RustCrypto's
//! own source: *"Poly1305 is not a traditional MAC and is single-use only
//! (a.k.a. 'one-time authenticator')."* It is sound inside ChaCha20-Poly1305,
//! where the AEAD gives it a fresh one-time key per message. Lifting it out and
//! keying it repeatedly breaks it.

use core::fmt;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::ChaCha20Poly1305;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Every key in this system is 32 bytes. See [`Key32`].
pub const KEY_LEN: usize = 32;

/// RFC 8439's nonce: 96 bits.
pub const NONCE_LEN: usize = 12;

/// Poly1305's tag, appended to every ciphertext by the AEAD.
pub const TAG_LEN: usize = 16;

/// The algorithm identifier stored on every encrypted row.
///
/// **It exists so that the fallback in §12.3 is a schema fact rather than a
/// migration.** If per-design keys were ever relaxed — and §12.3 says they may
/// not be without revisiting that section — XChaCha20-Poly1305 would be id 2,
/// and rows written under each would still be readable.
pub const AEAD_ALG_CHACHA20POLY1305_IETF: i16 = 1;

/// The wrap construction's version, stored on every wrapped key and every
/// payload row, and fed into the storage binding.
///
/// Version 1 is: ChaCha20-Poly1305 over `LP(aad_bytes) ‖ key`, with the AEAD's
/// own associated-data channel **empty** — §4's B1 fix.
pub const WRAP_VERSION: i32 = 1;

/// The point at which `writes_under_key` is shouted about.
///
/// §12.3: with random 96-bit nonces the entire safety margin is the birthday
/// bound — 2^32 messages under one key is ≈2^-33, 2^24 is ≈2^-49. 2^24 writes
/// is 16.7 million versions **of one design**, which this product does not
/// reach; the counter exists to say so out loud if it ever does.
///
/// **This counter is a detector and is never the nonce source** (§12.3). A
/// counter nonce was rejected on an operational ground: restoring a backup
/// moves a counter backwards while the key stays the same, and the next writes
/// reuse nonces already spent. Random nonces have no such failure mode.
pub const WRITES_UNDER_KEY_BUDGET: i64 = 1 << 24;

// ---------------------------------------------------------------------------
// Keys and key ids
// ---------------------------------------------------------------------------

/// The domain tag under which a key's **non-secret** id is computed
/// (ADR-0043 §4).
const KEY_ID_LABEL: &[u8] = b"fathom/key/id/v1";

/// How many bytes of that MAC become the id — 8, rendered as 16 hex
/// characters, short enough for an operator to compare two by eye.
const KEY_ID_BYTES: usize = 8;

/// 32 bytes of key material: a root key, a tenant key or a design key.
///
/// **The wipe on drop is best-effort and is written as such.** `zeroize` is
/// enabled as a feature of `chacha20poly1305` — which is what clears the
/// expanded cipher state and the key inside the cipher — but this crate does
/// not name `zeroize` as a dependency of its own, and a guaranteed wipe needs
/// either that crate or a `write_volatile`, which is `unsafe`. What is claimed
/// is a compiler fence around a plain overwrite; what is *not* claimed is that
/// an optimiser cannot elide it.
///
/// The protection that is real: this value never leaves the process. `Debug`
/// prints the id and not the key, there is no `Display`, no `Clone` to
/// multiply copies silently, and the only accessor borrows.
pub struct Key32([u8; KEY_LEN]);

impl Key32 {
    /// Exactly `KEY_LEN` bytes. Nothing is padded, hashed or truncated to fit
    /// — each of those turns "the wrong input" into a key that silently works.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// A fresh key from the OS CSPRNG.
    pub fn random() -> Result<Self, CryptoError> {
        let mut bytes = [0u8; KEY_LEN];
        getrandom::fill(&mut bytes).map_err(|_| CryptoError::NoRandomness)?;
        Ok(Self(bytes))
    }

    /// The bytes. Only this module and its callers inside the key hierarchy
    /// have any business with them.
    pub fn expose(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    /// This key's non-secret id: `HMAC-SHA-256(key, "fathom/key/id/v1")`,
    /// truncated to [`KEY_ID_BYTES`]. A keyed one-way function of the key, so
    /// publishing it discloses nothing about 32 random bytes.
    pub fn id(&self) -> KeyId {
        let tag = mac(&self.0, KEY_ID_LABEL);
        let mut out = [0u8; KEY_ID_BYTES];
        out.copy_from_slice(&tag[..KEY_ID_BYTES]);
        KeyId(out)
    }
}

impl Drop for Key32 {
    fn drop(&mut self) {
        for b in &mut self.0 {
            *b = 0;
        }
        core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
    }
}

impl fmt::Debug for Key32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Key32({})", self.id())
    }
}

/// A key's non-secret id, rendered as lower-case hex.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KeyId([u8; KEY_ID_BYTES]);

impl KeyId {
    /// Parse one back from the hex an earlier run stamped into the database.
    pub fn parse(s: &str) -> Option<Self> {
        if s.len() != KEY_ID_BYTES * 2 {
            return None;
        }
        let mut out = [0u8; KEY_ID_BYTES];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
        }
        Some(Self(out))
    }

    /// The id's own bytes, for the one place that feeds a key id into a MAC
    /// input (`storage_binding`, §11.2).
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Display for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for b in self.0 {
            write!(f, "{b:02x}")?;
        }
        Ok(())
    }
}

impl fmt::Debug for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "KeyId({self})")
    }
}

// ---------------------------------------------------------------------------
// Length prefixing — §11.2
// ---------------------------------------------------------------------------

/// `LP(x) = u32_le(len(x)) ‖ x`, appended to `out`.
///
/// **The only way a variable-length value may enter a MAC input.** A field
/// longer than `u32::MAX` cannot occur — the payload limit is far below it —
/// and is refused by a saturating conversion rather than wrapping, because a
/// wrapped length is precisely the parser bug `Cargo.toml`'s
/// `overflow-checks = true` comment is about.
pub fn lp(out: &mut Vec<u8>, x: &[u8]) {
    let len = u32::try_from(x.len()).unwrap_or(u32::MAX);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(x);
}

/// `u32_le(n)`, appended. Fixed width, so no prefix.
pub fn u32_le(out: &mut Vec<u8>, n: u32) {
    out.extend_from_slice(&n.to_le_bytes());
}

/// `u64_le(n)`, appended.
pub fn u64_le(out: &mut Vec<u8>, n: u64) {
    out.extend_from_slice(&n.to_le_bytes());
}

/// `u16_le(n)`, appended.
pub fn u16_le(out: &mut Vec<u8>, n: u16) {
    out.extend_from_slice(&n.to_le_bytes());
}

/// Read one length-prefixed field, returning it and the rest.
pub fn read_lp(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let (len_bytes, rest) = bytes.split_at_checked(4)?;
    let len = u32::from_le_bytes(len_bytes.try_into().ok()?) as usize;
    let (value, tail) = rest.split_at_checked(len)?;
    Some((value, tail))
}

// ---------------------------------------------------------------------------
// MAC and KDF
// ---------------------------------------------------------------------------

/// HMAC-SHA-256. §12.1 chose it over keyed BLAKE2b (one extra crate) and KMAC
/// (RustCrypto ships none, and hand-rolling one is forbidden), with
/// constant-time tag comparison read from `digest 0.11.3`'s `Mac` trait rather
/// than assumed.
pub fn mac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut m =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes a key of any length");
    m.update(message);
    m.finalize().into_bytes().into()
}

/// Verify a tag in constant time, through the same `Mac` trait — never `==` on
/// two byte slices.
pub fn mac_verify(key: &[u8], message: &[u8], tag: &[u8]) -> bool {
    let mut m =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes a key of any length");
    m.update(message);
    m.verify_slice(tag).is_ok()
}

/// HKDF-SHA-256, **Expand only** — `from_prk`, never `new` (§12.1).
///
/// The input is already a uniformly random 32-byte key, so there is nothing
/// for Extract to do. Skipping it is not an optimisation; running Extract on a
/// uniform key with no salt would just be a second HMAC.
pub fn hkdf_expand(prk: &Key32, info: &[u8]) -> Key32 {
    let hk = Hkdf::<Sha256>::from_prk(prk.expose()).expect("32 bytes is exactly SHA-256's output");
    let mut out = [0u8; KEY_LEN];
    hk.expand(info, &mut out)
        .expect("32 bytes is one HKDF block and cannot be too long");
    Key32::from_bytes(out)
}

// ---------------------------------------------------------------------------
// The AEAD
// ---------------------------------------------------------------------------

/// A fresh random 96-bit nonce (§4, §12.3).
pub fn random_nonce() -> Result<[u8; NONCE_LEN], CryptoError> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| CryptoError::NoRandomness)?;
    Ok(nonce)
}

/// Encrypt. `aad` is authenticated, not encrypted.
pub fn seal(
    key: &Key32,
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = ChaCha20Poly1305::new(key.expose().into());
    cipher
        .encrypt(
            nonce.into(),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::SealFailed)
}

/// Decrypt, or refuse. A failed tag is [`CryptoError::Refused`] and carries
/// nothing about why.
pub fn open(
    key: &Key32,
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = ChaCha20Poly1305::new(key.expose().into());
    cipher
        .decrypt(
            nonce.into(),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Refused)
}

// ---------------------------------------------------------------------------
// Key wrapping and the B1 binding — §4
// ---------------------------------------------------------------------------

/// A wrapped data key as it is stored: ciphertext (tag included) and the
/// nonce it was sealed under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Wrapped {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; NONCE_LEN],
}

/// Why an unwrap did not produce a key. **Two distinct errors, deliberately**
/// (§4's B1 fix).
#[derive(Debug, PartialEq, Eq)]
pub enum UnwrapError {
    /// The tag did not verify: wrong wrapping key, or the bytes were altered.
    Refused,
    /// The tag verified — so this really is a key wrapped under this wrapping
    /// key — but the identity sealed inside it is not the identity it was
    /// asked for. **This is a row that was moved**: a design key filed under
    /// another design, or a tenant key relabelled.
    Misbound,
    /// The tag verified and the plaintext is not a wrap at all. Unreachable
    /// short of a wrap written by a different construction; never silently
    /// treated as either of the two above.
    Malformed,
}

impl fmt::Display for UnwrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused => f.write_str(
                "the wrapped key did not authenticate: either it is wrapped under a different \
                 key, or its bytes were altered",
            ),
            Self::Misbound => f.write_str(
                "the wrapped key authenticated, but the identity sealed inside it is not the \
                 one it was asked for -- this key row belongs to something else",
            ),
            Self::Malformed => {
                f.write_str("the wrapped key authenticated and is not a wrap of this construction")
            }
        }
    }
}

impl std::error::Error for UnwrapError {}

/// Wrap a data key, binding it to an identity — §4's B1 fix, exactly as
/// written there.
///
/// **The identity goes in the wrapped plaintext, and the AEAD's own
/// associated-data channel stays empty.** WO-12 §4.1 rejected putting identity
/// in the associated-data channel and that rejection stands: with the identity
/// as AAD, a caller that passes the wrong AAD gets a bare tag failure and
/// cannot tell "this is not my key" from "these bytes were corrupted". Sealed
/// as plaintext, the unwrap **recovers** the identity and compares it at
/// exactly one place — [`unwrap_key`] — which is what makes
/// [`UnwrapError::Misbound`] a different word from [`UnwrapError::Refused`].
///
/// Data keys are **random and wrapped, never derived** (§4). Derivation would
/// bind identity for free and destroy the byte-identical re-wrap requirement
/// the same section states; the two readings were mutually exclusive and this
/// is the one that was chosen.
pub fn wrap_key(
    wrapping_key: &Key32,
    aad_bytes: &[u8],
    key: &Key32,
) -> Result<Wrapped, CryptoError> {
    let mut plaintext = Vec::with_capacity(4 + aad_bytes.len() + KEY_LEN);
    lp(&mut plaintext, aad_bytes);
    plaintext.extend_from_slice(key.expose());

    let nonce = random_nonce()?;
    let ciphertext = seal(wrapping_key, &nonce, &plaintext, b"")?;

    // The wrap's own plaintext is key material. Best-effort, exactly as
    // `Key32`'s own drop is -- see its doc comment for what is and is not
    // claimed.
    plaintext.fill(0);
    core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);

    Ok(Wrapped { ciphertext, nonce })
}

/// Unwrap a data key and check its binding — **the one path that compares a
/// recovered identity**, per §4.
pub fn unwrap_key(
    wrapping_key: &Key32,
    wrapped: &Wrapped,
    expected_aad: &[u8],
) -> Result<Key32, UnwrapError> {
    let mut plaintext = open(wrapping_key, &wrapped.nonce, &wrapped.ciphertext, b"")
        .map_err(|_| UnwrapError::Refused)?;

    // **This buffer is `LP(aad) ‖ key` — it holds the data key in the clear**,
    // exactly as `wrap_key`'s does, and it is wiped on every path out for the
    // same reason and with the same caveat: best-effort, a compiler fence
    // around a plain overwrite, see `Key32`'s own doc for what is and is not
    // claimed. `wrap_key` zeroed the identical buffer and this one was left
    // on the heap until the allocator happened to reuse it.
    let outcome = (|| {
        let Some((recovered_aad, rest)) = read_lp(&plaintext) else {
            return Err(UnwrapError::Malformed);
        };
        if rest.len() != KEY_LEN {
            return Err(UnwrapError::Malformed);
        }

        // Constant-time, though the tag has already authenticated both sides:
        // belt to that braces, and it costs one loop.
        if !ct_eq(recovered_aad, expected_aad) {
            return Err(UnwrapError::Misbound);
        }

        let mut bytes = [0u8; KEY_LEN];
        bytes.copy_from_slice(rest);
        Ok(Key32::from_bytes(bytes))
    })();

    plaintext.fill(0);
    core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);

    outcome
}

/// Equality that does not return early. Not a substitute for
/// [`mac_verify`] — that one goes through `digest`'s own constant-time path.
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Anything the primitives can refuse to do.
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// The OS CSPRNG refused. There is no fallback and there must not be one:
    /// a nonce from a degraded generator is how two messages end up under one
    /// (key, nonce) pair, which leaks the XOR of the plaintexts *and* the
    /// Poly1305 one-time key (§12.3).
    NoRandomness,
    /// The AEAD refused to encrypt — in practice, a plaintext beyond its
    /// length limit.
    SealFailed,
    /// The tag did not verify.
    Refused,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoRandomness => f.write_str(
                "the operating system's random generator refused, so no nonce and no key could \
                 be drawn. Nothing was written.",
            ),
            Self::SealFailed => f.write_str("the payload is too large for one AEAD message"),
            Self::Refused => f.write_str("the ciphertext did not authenticate"),
        }
    }
}

impl std::error::Error for CryptoError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_prefixing_separates_what_bare_concatenation_would_not() {
        // §11.2's splice, made concrete. Bare, `"ab" ‖ "c"` and `"a" ‖ "bc"`
        // are the same three bytes; length-prefixed they are not.
        let mut one = Vec::new();
        lp(&mut one, b"ab");
        lp(&mut one, b"c");
        let mut two = Vec::new();
        lp(&mut two, b"a");
        lp(&mut two, b"bc");
        assert_ne!(one, two);

        // And the reader gets back exactly what was written.
        let (first, rest) = read_lp(&one).unwrap();
        assert_eq!(first, b"ab");
        let (second, rest) = read_lp(rest).unwrap();
        assert_eq!(second, b"c");
        assert!(rest.is_empty());

        // A truncated field is None, never a panic and never a short read.
        assert!(read_lp(&one[..3]).is_none());
        assert!(read_lp(&[9, 0, 0, 0, 1, 2]).is_none());
    }

    #[test]
    fn the_aead_round_trips_and_refuses_every_alteration() {
        let key = Key32::from_bytes([3u8; KEY_LEN]);
        let nonce = [4u8; NONCE_LEN];
        let sealed = seal(&key, &nonce, b"a design", b"aad").unwrap();
        assert_eq!(open(&key, &nonce, &sealed, b"aad").unwrap(), b"a design");

        // Tag length is real: the ciphertext is longer than the plaintext by
        // exactly Poly1305's tag.
        assert_eq!(sealed.len(), b"a design".len() + TAG_LEN);

        // Wrong key, wrong nonce, wrong aad, flipped bit: all refusals.
        let other = Key32::from_bytes([5u8; KEY_LEN]);
        assert_eq!(
            open(&other, &nonce, &sealed, b"aad"),
            Err(CryptoError::Refused)
        );
        assert_eq!(
            open(&key, &[9u8; NONCE_LEN], &sealed, b"aad"),
            Err(CryptoError::Refused)
        );
        assert_eq!(
            open(&key, &nonce, &sealed, b"other"),
            Err(CryptoError::Refused)
        );
        let mut flipped = sealed.clone();
        flipped[0] ^= 1;
        assert_eq!(
            open(&key, &nonce, &flipped, b"aad"),
            Err(CryptoError::Refused)
        );
    }

    #[test]
    fn two_nonces_are_never_the_same_two_bytes() {
        // Not a statistical test. It catches the failure that matters: a
        // nonce source that is not random at all.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..256 {
            assert!(seen.insert(random_nonce().unwrap()));
        }
    }

    #[test]
    fn a_wrapped_key_unwraps_and_a_moved_one_is_misbound_not_refused() {
        let master = Key32::from_bytes([1u8; KEY_LEN]);
        let data = Key32::random().unwrap();
        let wrapped = wrap_key(&master, b"tenant=A;design=1", &data).unwrap();

        let back = unwrap_key(&master, &wrapped, b"tenant=A;design=1").unwrap();
        assert_eq!(back.expose(), data.expose());

        // The row was moved: it authenticates, so the wrapping key is right,
        // and the identity inside does not match. That is Misbound, and it is
        // the distinction §4's B1 fix exists for.
        assert_eq!(
            unwrap_key(&master, &wrapped, b"tenant=B;design=1").unwrap_err(),
            UnwrapError::Misbound
        );

        // The wrapping key is wrong, or the bytes were altered: Refused.
        let wrong = Key32::from_bytes([2u8; KEY_LEN]);
        assert_eq!(
            unwrap_key(&wrong, &wrapped, b"tenant=A;design=1").unwrap_err(),
            UnwrapError::Refused
        );
        let mut altered = wrapped.clone();
        altered.ciphertext[0] ^= 1;
        assert_eq!(
            unwrap_key(&master, &altered, b"tenant=A;design=1").unwrap_err(),
            UnwrapError::Refused
        );
    }

    #[test]
    fn the_aeads_own_associated_data_channel_stays_empty_for_key_seals() {
        // §4: identity binds through the WRAPPED PLAINTEXT, not the AAD
        // channel. Proven rather than asserted: the wrap opens with an empty
        // AAD, and the identity is inside what comes out.
        let master = Key32::from_bytes([8u8; KEY_LEN]);
        let data = Key32::random().unwrap();
        let wrapped = wrap_key(&master, b"identity", &data).unwrap();

        let plaintext = open(&master, &wrapped.nonce, &wrapped.ciphertext, b"").unwrap();
        let (aad, key) = read_lp(&plaintext).unwrap();
        assert_eq!(aad, b"identity");
        assert_eq!(key, data.expose());
    }

    #[test]
    fn a_key_id_is_stable_distinct_and_is_not_a_slice_of_the_key() {
        let a = Key32::from_bytes([1u8; KEY_LEN]);
        assert_eq!(a.id(), Key32::from_bytes([1u8; KEY_LEN]).id());
        assert_ne!(a.id(), Key32::from_bytes([2u8; KEY_LEN]).id());

        let rendered = a.id().to_string();
        assert_eq!(KeyId::parse(&rendered), Some(a.id()));
        assert_eq!(KeyId::parse("nothex"), None);

        let key_hex: String = a.expose().iter().map(|b| format!("{b:02x}")).collect();
        assert!(!key_hex.contains(&rendered), "the id is a slice of the key");
        let debugged = format!("{a:?}");
        assert!(!debugged.contains(&key_hex), "{debugged}");
    }

    #[test]
    fn the_two_hkdf_labels_give_two_different_subkeys() {
        // §12.2 renamed these deliberately so that nobody later "tidies" one
        // occurrence and silently changes the other.
        let chain = Key32::from_bytes([6u8; KEY_LEN]);
        let seal_key = hkdf_expand(&chain, b"fathom/chain/kdf/seal/v1");
        let content_key = hkdf_expand(&chain, b"fathom/chain/kdf/content/v1");
        assert_ne!(seal_key.expose(), content_key.expose());
        assert_ne!(seal_key.expose(), chain.expose());
    }

    #[test]
    fn mac_verification_accepts_only_the_right_tag() {
        let tag = mac(b"key", b"message");
        assert!(mac_verify(b"key", b"message", &tag));
        assert!(!mac_verify(b"key", b"messagf", &tag));
        assert!(!mac_verify(b"kez", b"message", &tag));
        assert!(!mac_verify(b"key", b"message", &tag[..31]));
    }
}

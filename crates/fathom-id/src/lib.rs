//! Identifiers: ULID over Crockford base32, and the typed id newtypes.
//!
//! Scope is 71 §3.3's phase-0 row: "ULID, `CommandId`, `ConceptId`, Crockford
//! base32. Node IDs defined but unused." There is deliberately no `new()` that
//! reads a clock or an RNG: invariant 9 quarantines nondeterminism at the host
//! boundary, so a ULID is only ever constructed from parts the caller supplies
//! (in the shipped product, via the `fathom_entropy` / `fathom_now_ms` imports
//! — the only two the WASM core is permitted, 42 §9.4 check 5).

#![forbid(unsafe_code)]

use core::fmt;
use core::str::FromStr;

/// Crockford base32 alphabet, in encode order. Decode is case-insensitive and
/// maps I/L to 1 and O to 0, per the Crockford specification.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn decode_char(c: u8) -> Option<u8> {
    match c {
        b'0' | b'O' | b'o' => Some(0),
        b'1' | b'I' | b'i' | b'L' | b'l' => Some(1),
        b'2'..=b'9' => Some(c - b'0'),
        b'A'..=b'H' | b'a'..=b'h' => Some(c.to_ascii_uppercase() - b'A' + 10),
        b'J' | b'K' | b'j' | b'k' => Some(c.to_ascii_uppercase() - b'A' + 9),
        b'M' | b'N' | b'm' | b'n' => Some(c.to_ascii_uppercase() - b'A' + 8),
        b'P'..=b'T' | b'p'..=b't' => Some(c.to_ascii_uppercase() - b'A' + 7),
        b'V'..=b'Z' | b'v'..=b'z' => Some(c.to_ascii_uppercase() - b'A' + 6),
        _ => None,
    }
}

/// A ULID: 48-bit millisecond timestamp, 80 bits supplied randomness,
/// rendered as 26 Crockford characters. Lexicographic order over the encoding
/// equals numeric order over the u128, which is what makes it a sortable id.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ulid(pub u128);

/// The one constructor error: a timestamp that does not fit 48 bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimestampOverflow;

/// Decode errors, precise enough to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// Length is not 26 characters.
    Length(usize),
    /// A character outside the (case-insensitive, aliased) alphabet.
    Char { index: usize, byte: u8 },
    /// First character above '7': the value would exceed 128 bits.
    Overflow,
}

impl Ulid {
    pub const TIMESTAMP_MAX_MS: u64 = (1 << 48) - 1;

    /// Construct from parts. `random` is masked to its low 80 bits.
    pub fn from_parts(timestamp_ms: u64, random: u128) -> Result<Self, TimestampOverflow> {
        if timestamp_ms > Self::TIMESTAMP_MAX_MS {
            return Err(TimestampOverflow);
        }
        let rand80 = random & ((1u128 << 80) - 1);
        Ok(Ulid(((timestamp_ms as u128) << 80) | rand80))
    }

    pub fn timestamp_ms(self) -> u64 {
        (self.0 >> 80) as u64
    }

    pub fn random(self) -> u128 {
        self.0 & ((1u128 << 80) - 1)
    }

    /// 26-character Crockford encoding, always uppercase.
    pub fn encode(self) -> String {
        let mut out = [0u8; 26];
        let mut v = self.0;
        for slot in out.iter_mut().rev() {
            *slot = ALPHABET[(v & 0x1f) as usize];
            v >>= 5;
        }
        // 26 * 5 = 130 bits; the top 2 are always consumed as zero for a
        // 128-bit value, so nothing remains here by construction.
        String::from_utf8(out.to_vec()).expect("alphabet is ASCII")
    }

    pub fn decode(s: &str) -> Result<Self, DecodeError> {
        let bytes = s.as_bytes();
        if bytes.len() != 26 {
            return Err(DecodeError::Length(bytes.len()));
        }
        // 26 chars carry 130 bits; the first char may only contribute 3 bits
        // (values 0..=7) or the value overflows u128.
        let first = decode_char(bytes[0]).ok_or(DecodeError::Char {
            index: 0,
            byte: bytes[0],
        })?;
        if first > 7 {
            return Err(DecodeError::Overflow);
        }
        let mut v: u128 = first as u128;
        for (i, &b) in bytes.iter().enumerate().skip(1) {
            let d = decode_char(b).ok_or(DecodeError::Char { index: i, byte: b })?;
            v = (v << 5) | d as u128;
        }
        Ok(Ulid(v))
    }
}

impl fmt::Display for Ulid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.encode())
    }
}

impl fmt::Debug for Ulid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ulid({})", self.encode())
    }
}

impl FromStr for Ulid {
    type Err = DecodeError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ulid::decode(s)
    }
}

macro_rules! ulid_newtype {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
        pub struct $name(pub Ulid);

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = DecodeError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok($name(Ulid::decode(s)?))
            }
        }
    };
}

ulid_newtype! {
    /// Graph node id (11 §3). Defined in phase 0, unused until the graph exists.
    NodeId
}
ulid_newtype! {
    /// Graph edge id (11 §3, ADR-0007's first-class edges).
    EdgeId
}

/// Errors for the string-shaped corpus identifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdError {
    Empty,
    /// Byte outside the permitted charset, with its index.
    Charset {
        index: usize,
    },
    /// Structural rule broken (missing separator, empty segment, bad prefix).
    Structure(&'static str),
}

fn check_segment(s: &str, allow_slash: bool) -> Result<(), IdError> {
    if s.is_empty() {
        return Err(IdError::Empty);
    }
    for (i, b) in s.bytes().enumerate() {
        let ok = b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || b == b'.'
            || b == b'-'
            || b == b'_'
            || (allow_slash && b == b'/');
        if !ok {
            return Err(IdError::Charset { index: i });
        }
    }
    Ok(())
}

/// A corpus command entry id: `<platform>/<dotted.path>`, e.g.
/// `junos-srx/ike.sa.show` (61 §3.3, as resolved by the seed corpus header F1).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct CommandId(String);

impl CommandId {
    pub fn parse(s: &str) -> Result<Self, IdError> {
        let (platform, path) = s
            .split_once('/')
            .ok_or(IdError::Structure("missing `/` between platform and path"))?;
        if path.contains('/') {
            return Err(IdError::Structure("more than one `/`"));
        }
        check_segment(platform, false)?;
        check_segment(path, false)?;
        Ok(CommandId(s.to_owned()))
    }

    pub fn platform(&self) -> &str {
        self.0.split_once('/').expect("validated at parse").0
    }

    pub fn path(&self) -> &str {
        self.0.split_once('/').expect("validated at parse").1
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CommandId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A concept id: `concept:<dotted.path>`, e.g. `concept:p2.installed`
/// (16 §3.1's concept layer, as spelled throughout the seed corpus).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ConceptId(String);

impl ConceptId {
    pub fn parse(s: &str) -> Result<Self, IdError> {
        let rest = s
            .strip_prefix("concept:")
            .ok_or(IdError::Structure("missing `concept:` prefix"))?;
        check_segment(rest, false)?;
        Ok(ConceptId(s.to_owned()))
    }

    pub fn path(&self) -> &str {
        self.0.strip_prefix("concept:").expect("validated at parse")
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ConceptId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_known_vector_round_trips() {
        // The ulid-spec's canonical example value.
        let s = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let u = Ulid::decode(s).unwrap();
        assert_eq!(u.encode(), s);
        // Hand-decoded: chars 0,1,A,R,Z,3,N,D,E,K = 0,1,10,24,31,3,21,13,14,19
        // over 3+5*9 bits = 1_469_922_850_259 ms.
        assert_eq!(u.timestamp_ms(), 1_469_922_850_259);
    }

    #[test]
    fn ulid_zero_and_max() {
        assert_eq!(Ulid(0).encode(), "00000000000000000000000000");
        assert_eq!(Ulid(u128::MAX).encode(), "7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
        assert_eq!(
            Ulid::decode("7ZZZZZZZZZZZZZZZZZZZZZZZZZ").unwrap(),
            Ulid(u128::MAX)
        );
        assert_eq!(
            Ulid::decode("80000000000000000000000000"),
            Err(DecodeError::Overflow)
        );
    }

    #[test]
    fn ulid_ordering_is_lexicographic() {
        let a = Ulid::from_parts(1_000, 5).unwrap();
        let b = Ulid::from_parts(1_001, 0).unwrap();
        assert!(a < b);
        assert!(a.encode() < b.encode());
    }

    #[test]
    fn ulid_crockford_aliases_decode() {
        // I/L -> 1, O -> 0, case-insensitive.
        let canonical = Ulid::decode("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        let aliased = Ulid::decode("0iARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        assert_eq!(canonical.0 >> 125, aliased.0 >> 125);
        assert_eq!(Ulid::decode("0O000000000000000000000000").unwrap(), Ulid(0));
        assert_eq!(
            Ulid::decode("0L000000000000000000000000").unwrap(),
            Ulid(1 << 120)
        );
    }

    #[test]
    fn ulid_rejects_bad_input() {
        assert_eq!(Ulid::decode("short"), Err(DecodeError::Length(5)));
        assert!(matches!(
            Ulid::decode("0U000000000000000000000000"),
            Err(DecodeError::Char {
                index: 1,
                byte: b'U'
            })
        ));
    }

    #[test]
    fn ulid_timestamp_overflow() {
        assert!(Ulid::from_parts(1 << 48, 0).is_err());
        assert!(Ulid::from_parts((1 << 48) - 1, 0).is_ok());
    }

    #[test]
    fn ulid_random_masked_to_80_bits() {
        let u = Ulid::from_parts(0, u128::MAX).unwrap();
        assert_eq!(u.timestamp_ms(), 0);
        assert_eq!(u.random(), (1u128 << 80) - 1);
    }

    #[test]
    fn command_id_parses_seed_corpus_forms() {
        for s in [
            "junos-srx/ike.sa.show",
            "junos-srx/ipsec.inactive-tunnels.show",
            "junos-srx/interface.st0.terse",
        ] {
            let id = CommandId::parse(s).unwrap();
            assert_eq!(id.platform(), "junos-srx");
            assert_eq!(id.as_str(), s);
        }
    }

    #[test]
    fn command_id_rejects_bad_forms() {
        assert!(CommandId::parse("no-slash").is_err());
        assert!(CommandId::parse("a/b/c").is_err());
        assert!(CommandId::parse("Junos/x.y").is_err()); // uppercase
        assert!(CommandId::parse("junos-srx/").is_err());
    }

    #[test]
    fn concept_id_parses_seed_corpus_forms() {
        for s in [
            "concept:p2.installed",
            "concept:obj.ike-proposal",
            "concept:act.verify",
        ] {
            let id = ConceptId::parse(s).unwrap();
            assert!(id.path().len() > 1);
        }
        assert!(ConceptId::parse("p2.installed").is_err());
        assert!(ConceptId::parse("concept:").is_err());
    }
}

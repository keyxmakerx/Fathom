//! What an AI app may write for a field besides the spelling read_design shows.
//!
//! An app writes what a person would: `tcp` or `TCP` for a published port's protocol,
//! `EOS 4.18.11M` for a version. The design keeps the protocol as its number and the version
//! alone, since the device's platform already names the OS and `fathom_rules::version`
//! compares bare versions. So those spellings are read into the stored one before the value
//! is checked; nothing else is guessed. A value that still does not fit is refused with what
//! the field takes ([`takes`]), never with the value itself.

use core::any::TypeId;

use fathom_canon::Json;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::accessors::slot_type;
use fathom_ir::scalar;

/// The names `docker run -p`'s `/proto` suffix takes, and the numbers `PublishedPort.protocol`
/// stores for them (schema.yaml cites both).
const PROTOCOLS: [(&str, u8); 3] = [("tcp", 6), ("udp", 17), ("sctp", 132)];

/// `value` as the field's stored spelling, where it is one of the forms above.
pub fn normalise(key: FieldKey, value: &Json) -> Json {
    let Some((tid, _)) = slot_type(key) else {
        return value.clone();
    };
    if tid == TypeId::of::<scalar::IpProtocol>() {
        return match value {
            Json::Int(n) => Json::Str(n.to_string()),
            Json::Str(s) => {
                let s = s.trim();
                let number = PROTOCOLS
                    .iter()
                    .find(|(name, _)| s.eq_ignore_ascii_case(name))
                    .map(|(_, n)| n.to_string());
                Json::Str(number.unwrap_or_else(|| s.to_owned()))
            }
            other => other.clone(),
        };
    }
    if tid == TypeId::of::<scalar::OsVersion>() {
        if let Json::Str(s) = value {
            return Json::Str(bare_version(s).unwrap_or(s).to_owned());
        }
    }
    value.clone()
}

/// `EOS 4.18.11M` -> `4.18.11M`: when exactly one word has a digit in it, that word is the
/// version and the others name the OS or the release (`Ubuntu 26.04 LTS`). Two such words
/// (`Windows Server 2022 21H2`) are not guessed between.
fn bare_version(s: &str) -> Option<&str> {
    let mut numbered = s
        .split_whitespace()
        .filter(|w| w.bytes().any(|b| b.is_ascii_digit()));
    let version = numbered.next()?;
    numbered.next().is_none().then_some(version)
}

/// What the field takes, for a refusal; `None` where read_design's shape says it already.
pub fn takes(key: FieldKey) -> Option<&'static str> {
    let (tid, _) = slot_type(key)?;
    if tid == TypeId::of::<scalar::IpProtocol>() {
        return Some("tcp, udp or sctp in any case, or the protocol's number from 0 to 255");
    }
    if tid == TypeId::of::<scalar::OsVersion>() {
        return Some(
            "a version such as 4.18.11M or 26.04, with an OS name before it if you like \
             (\"EOS 4.18.11M\"); the platform names the OS, so only the version is kept",
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use fathom_ir::generated::ir_types::{DeviceField, PublishedPortField};

    fn s(v: &str) -> Json {
        Json::Str(v.into())
    }

    #[test]
    fn a_protocol_is_read_by_name_in_any_case_or_by_number() {
        let key = PublishedPortField::Protocol.key();
        for (sent, kept) in [
            ("tcp", "6"),
            ("TCP", "6"),
            ("Udp", "17"),
            ("SCTP", "132"),
            ("6", "6"),
        ] {
            assert_eq!(normalise(key, &s(sent)), s(kept), "{sent}");
        }
        assert_eq!(normalise(key, &Json::Int(17)), s("17"));
        assert_eq!(normalise(key, &s("icmpish")), s("icmpish"), "not guessed");
    }

    #[test]
    fn a_version_keeps_the_one_word_with_a_digit() {
        let key = DeviceField::OsVersion.key();
        for (sent, kept) in [
            ("EOS 4.18.11M", "4.18.11M"),
            ("Ubuntu 26.04", "26.04"),
            ("Ubuntu 26.04 LTS", "26.04"),
            ("Junos OS 21.4R3-S1", "21.4R3-S1"),
            ("4.18.11M", "4.18.11M"),
        ] {
            assert_eq!(normalise(key, &s(sent)), s(kept), "{sent}");
        }
        let two = "Windows Server 2022 21H2";
        assert_eq!(normalise(key, &s(two)), s(two), "not guessed");
    }

    #[test]
    fn other_fields_are_left_as_sent() {
        let key = DeviceField::Hostname.key();
        assert_eq!(normalise(key, &s("TCP core 1")), s("TCP core 1"));
        assert_eq!(takes(key), None);
    }
}

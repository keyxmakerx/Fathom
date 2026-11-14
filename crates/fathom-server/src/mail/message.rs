//! One mail, written out as the bytes an SMTP `DATA` carries (ADR-0085 decisions 1 and 8).
//!
//! Every mail is `multipart/alternative` with a plain text part and a plain HTML part, each
//! base64 so no line in either is longer than 76 characters and no byte of a person's text can
//! end a header or the message. No images, no tracking, no AMP.
//!
//! Headers (decision 8): `Message-ID` under the from address's domain, `Auto-Submitted:
//! auto-generated` (RFC 3834 §5), and a `Subject` that is RFC 2047 encoded when it is not plain
//! ASCII. The `List-Unsubscribe` pair belongs to the work and order mails, which do not exist
//! yet; the two kinds sent today (password reset and an invitation link) are not subscriptions.
//!
//! **What may reach a header is checked, not trusted.** An address goes through
//! [`plausible_address`]; a subject has every control character removed before it is encoded.
//! A carriage return or line feed in either would let text start a header of its own.

use crate::crypto;

/// Longest subject, in characters, after control characters are removed.
pub const SUBJECT_MAX: usize = 200;

/// A mail ready to be written out.
pub struct Message {
    pub from: String,
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
    /// The part of the `Message-ID` before the `@`.
    pub id: String,
    pub date_unix: i64,
}

/// One `@`, something either side, no whitespace, no control characters and none of the
/// characters that carry structure in an address header (`<>(),;:"[]\`). Narrower than RFC 5322
/// on purpose: a quoted local part is refused rather than parsed, and the relay refuses an
/// address that is wrong in a way this does not see.
pub fn plausible_address(address: &str) -> bool {
    let Some(at) = address.find('@') else {
        return false;
    };
    at > 0
        && at + 1 < address.len()
        && address.len() <= 254
        && address.rfind('@') == Some(at)
        && address.is_ascii()
        && !address
            .chars()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control() || "<>(),;:\"[]\\".contains(c))
}

/// The domain of an address `plausible_address` accepted.
pub fn domain_of(address: &str) -> &str {
    address.rsplit_once('@').map(|(_, d)| d).unwrap_or(address)
}

impl Message {
    /// The whole message, CRLF line ends, ready for [`super::smtp`] to dot-stuff and send.
    pub fn render(&self) -> Result<Vec<u8>, &'static str> {
        if !plausible_address(&self.from) {
            return Err("the from address");
        }
        if !plausible_address(&self.to) {
            return Err("the recipient's address");
        }
        if self.id.is_empty() || !self.id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("the message id");
        }
        let boundary = {
            let mut b = [0u8; 12];
            getrandom::fill(&mut b).map_err(|_| "random source")?;
            format!("fathom-{}", crypto::hex(&b))
        };
        let mut out = String::with_capacity(self.text.len() * 2 + self.html.len() * 2 + 1024);
        let mut header = |name: &str, value: &str| {
            out.push_str(name);
            out.push_str(": ");
            out.push_str(value);
            out.push_str("\r\n");
        };
        header("From", &self.from);
        header("To", &self.to);
        header("Subject", &encode_subject(&self.subject));
        header("Date", &rfc5322_date(self.date_unix));
        header(
            "Message-ID",
            &format!("<{}@{}>", self.id, domain_of(&self.from)),
        );
        header("Auto-Submitted", "auto-generated");
        header("MIME-Version", "1.0");
        header(
            "Content-Type",
            &format!("multipart/alternative; boundary=\"{boundary}\""),
        );
        out.push_str("\r\n");
        for (kind, body) in [("text/plain", &self.text), ("text/html", &self.html)] {
            out.push_str("--");
            out.push_str(&boundary);
            out.push_str("\r\n");
            out.push_str(&format!("Content-Type: {kind}; charset=utf-8\r\n"));
            out.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
            let crlf = body.replace("\r\n", "\n").replace('\n', "\r\n");
            out.push_str(&base64_lines(crlf.as_bytes()));
        }
        out.push_str("--");
        out.push_str(&boundary);
        out.push_str("--\r\n");
        Ok(out.into_bytes())
    }
}

/// The subject with control characters removed and cut to [`SUBJECT_MAX`], then RFC 2047
/// `B` encoded in words of at most 45 bytes of text when it is not printable ASCII.
pub fn encode_subject(subject: &str) -> String {
    let clean: String = subject
        .chars()
        .filter(|c| !c.is_control())
        .take(SUBJECT_MAX)
        .collect();
    if clean.bytes().all(|b| (0x20..0x7f).contains(&b)) && !clean.contains("=?") {
        return clean;
    }
    // Split on character boundaries so no word holds half a UTF-8 sequence (RFC 2047 §5).
    let mut words = Vec::new();
    let mut chunk = String::new();
    for c in clean.chars() {
        if chunk.len() + c.len_utf8() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", base64(chunk.as_bytes())));
            chunk.clear();
        }
        chunk.push(c);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", base64(chunk.as_bytes())));
    }
    words.join("\r\n ")
}

/// Escape text for the HTML part.
pub fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// RFC 4648 §4 base64, with padding.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = match chunk.len() {
            3 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8 | chunk[2] as u32,
            2 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8,
            _ => (chunk[0] as u32) << 16,
        };
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Base64 in lines of 76 characters, each ended by CRLF (RFC 2045 §6.8).
fn base64_lines(bytes: &[u8]) -> String {
    let flat = base64(bytes);
    let mut out = String::with_capacity(flat.len() + flat.len() / 76 * 2 + 2);
    for line in flat.as_bytes().chunks(76) {
        out.push_str(core::str::from_utf8(line).unwrap_or(""));
        out.push_str("\r\n");
    }
    out
}

/// `Thu, 13 Nov 2026 18:04:05 +0000` (RFC 5322 §3.3), always in UTC.
pub fn rfc5322_date(unix: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} +0000",
        DAYS[days.rem_euclid(7) as usize],
        d,
        MONTHS[(m - 1) as usize],
        y,
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Message {
        Message {
            from: "fathom@example.net".into(),
            to: "sam@example.org".into(),
            subject: "Reset your Fathom password".into(),
            text: "Hello\n.\nbye".into(),
            html: "<p>Hello</p>".into(),
            id: "01ABC".into(),
            date_unix: 1_794_679_445,
        }
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // RFC 4648 §10.
        for (i, o) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn dates_are_rfc5322() {
        assert_eq!(rfc5322_date(0), "Thu, 01 Jan 1970 00:00:00 +0000");
        assert_eq!(rfc5322_date(951_782_400), "Tue, 29 Feb 2000 00:00:00 +0000");
        assert_eq!(
            rfc5322_date(1_794_679_445),
            "Sat, 14 Nov 2026 18:04:05 +0000"
        );
    }

    #[test]
    fn addresses_that_could_carry_a_header_are_refused() {
        assert!(plausible_address("sam@example.org"));
        for bad in [
            "sam@example.org\r\nBcc: x@y.z",
            "sam@example.org\nX: y",
            "Sam <sam@example.org>",
            "sam@exa@mple.org",
            "@example.org",
            "sam@",
            "sam example@org",
            "s,am@example.org",
            "sám@example.org",
            "a-sign-in-name",
        ] {
            assert!(!plausible_address(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_subject_never_starts_a_header() {
        let s = encode_subject("Hi\r\nBcc: victim@example.org");
        assert!(!s.contains('\n') || s.contains("\r\n "));
        assert_eq!(s, "HiBcc: victim@example.org");
        let u = encode_subject("Ölçü — Fathom");
        assert!(u.starts_with("=?UTF-8?B?"));
        for line in u.split("\r\n") {
            assert!(line.len() <= 76, "{line}");
        }
    }

    #[test]
    fn rendered_message_has_the_decided_headers_and_short_lines() {
        let bytes = sample().render().unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("\r\nAuto-Submitted: auto-generated\r\n"));
        assert!(text.contains("\r\nMessage-ID: <01ABC@example.net>\r\n"));
        assert!(text.contains("multipart/alternative"));
        assert!(!text.contains("List-Unsubscribe"));
        for line in text.split("\r\n") {
            assert!(line.len() <= 998, "line too long");
            assert!(!line.contains('\n') && !line.contains('\r'));
        }
        // The bodies are encoded, so no line is a bare period.
        assert!(!text.split("\r\n").any(|l| l == "."));
    }

    #[test]
    fn a_bad_recipient_is_refused_before_anything_is_written() {
        let mut m = sample();
        m.to = "x@y.z\r\nBcc: a@b.c".into();
        assert!(m.render().is_err());
    }
}

//! #104 item 4, for the front ends that came after it: RouterOS and pfSense text that
//! reaches a door their own reader does not guard (the note box, or a fragment the
//! paste box cannot sniff) is gated by the set-form sweep alone.
//!
//! The every-entry sweep is `dict::tests::every_front_end_secret_is_caught_by_every_gate`.
//! These pin the shapes a real export prints (CLAUDE.md rule 2) and the lines that must
//! keep their text.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;

/// The note box's chain: every set-form dictionary in turn (`shell.rs` `redact_text`).
fn note(paste: &str) -> String {
    let root: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf();
    let mut text = paste.as_bytes().to_vec();
    for p in ["edgeos", "junos-ex", "junos-srx"] {
        let d = Dictionary::load_platform(&root, p).expect("ships");
        let out = fathom_ingest::redact_only(&text, &d).expect("within the caps");
        text = out.text.text().as_bytes().to_vec();
    }
    String::from_utf8(text).expect("utf-8")
}

/// pfSense stores private keys base64-encoded inside `<prv>` (README-pfsense.md). The
/// angle brackets kept `base64ish` from seeing the value. This is the base64 of
/// `-----BEGIN PRIVATE KEY-----`, as pfsensible's fixture decodes.
#[test]
fn base64_inside_an_element() {
    let out = note("<prv>LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t</prv>\n");
    assert!(!out.contains("LS0tLS1CRUdJTi"), "{out}");
}

/// A plaintext password element, and a SNMP community whose name runs together.
#[test]
fn secret_elements() {
    for (line, secret) in [
        ("<password>Tr0ub4dor</password>", "Tr0ub4dor"),
        ("<rocommunity>h0me-lab</rocommunity>", "h0me-lab"),
        (
            "<pre-shared-key>correct horse battery</pre-shared-key>",
            "horse",
        ),
    ] {
        let out = note(&format!("{line}\n"));
        assert!(!out.contains(secret), "{line}: {out}");
    }
}

/// RouterOS's floor-invisible names, at a length a device takes: an LTE PIN of four
/// digits, and a MACsec CAK as MikroTik's own MACsec page prints one (16 bytes, read
/// 2026-10-25 at help.mikrotik.com/docs/spaces/ROS/pages/201523202/MACsec).
#[test]
fn routeros_names() {
    for (line, secret) in [
        ("/interface lte set lte1 pin=8841", "8841"),
        ("/tool sms set sim-pin=8841", "8841"),
        (
            "/interface macsec add cak=71a7c363794da400dbde595d3926b0e9 interface=ether1",
            "71a7c363",
        ),
        (
            "/system script add name=up source=\":local s Horse\"",
            "Horse",
        ),
    ] {
        let out = note(&format!("{line}\n"));
        assert!(!out.contains(secret), "{line}: {out}");
    }
}

/// The new names match a whole key only: compounds and other elements keep their text.
#[test]
fn ordinary_lines_keep_their_text() {
    for line in [
        "<descr>Uplink to core</descr>",
        "/system identity set name=home-gw",
        "source-address=192.0.2.10",
        "spinner=on",
    ] {
        let out = note(&format!("{line}\n"));
        assert!(out.contains(line), "{line}: {out}");
    }
}

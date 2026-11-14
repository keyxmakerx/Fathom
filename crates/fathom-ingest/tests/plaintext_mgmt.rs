//! Sign-off r137: the readers that feed `sec.mgmt.plaintext` (telnet or unencrypted HTTP for
//! managing a device). Junos SRX and EX read `system services telnet` and
//! `system services web-management http`; Arista EOS reads `management telnet` with
//! `no shutdown`. Each syntax is cited in its dictionary entry, read 2026-11-14.

use std::path::{Path, PathBuf};

use fathom_ingest::blockcfg::ingest_eos;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::IngestOutput;
use fathom_ir::generated::ir_types::NodeKind;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn junos(platform: &str, paste: &str) -> IngestOutput {
    let dict = Dictionary::load_platform(&repo_root(), platform).expect("dictionary loads");
    fathom_ingest::ingest(paste.as_bytes(), &dict).expect("within the caps")
}

fn eos(paste: &str) -> IngestOutput {
    let dict = Dictionary::load_platform(&repo_root(), "eos").expect("dictionary loads");
    ingest_eos(paste.as_bytes(), &dict).expect("within the caps")
}

/// The one SystemSettings node's fields, as text, or None when there is none.
fn settings(out: &IngestOutput) -> Option<String> {
    let found: Vec<_> = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::SystemSettings)
        .collect();
    assert!(
        found.len() <= 1,
        "one SystemSettings node per device, got {}",
        found.len()
    );
    found.first().map(|n| format!("{:?}", n.fields))
}

fn holds(fields: &str, name: &str, value: bool) -> bool {
    fields
        .split("FieldKey")
        .any(|part| part.contains(name) && part.contains(&format!("Bool({value})")))
}

#[test]
fn junos_telnet_and_plain_http_are_read_on_both_platforms() {
    for platform in ["junos-srx", "junos-ex"] {
        let out = junos(
            platform,
            "set system host-name edge-1\n\
             set system services ssh\n\
             set system services telnet connection-limit 5\n\
             set system services web-management http port 8080\n\
             set system services web-management https system-generated-certificate\n",
        );
        let f = settings(&out).unwrap_or_else(|| panic!("{platform}: no SystemSettings"));
        assert!(
            f.contains("telnet_enabled") || holds(&f, "646", true),
            "{platform}: {f}"
        );
        assert!(
            f.contains("http_enabled") || holds(&f, "647", true),
            "{platform}: {f}"
        );
    }
}

#[test]
fn junos_ssh_and_https_alone_set_nothing() {
    for platform in ["junos-srx", "junos-ex"] {
        let out = junos(
            platform,
            "set system host-name edge-1\n\
             set system services ssh\n\
             set system services web-management https system-generated-certificate\n",
        );
        if let Some(f) = settings(&out) {
            assert!(
                !f.contains("telnet") && !f.contains("http_enabled"),
                "{platform}: {f}"
            );
        }
    }
}

const EOS_ON: &str = "!
hostname leaf-1
!
management telnet
   no shutdown
!
end
";

const EOS_OFF: &str = "!
hostname leaf-1
!
management telnet
   shutdown
!
end
";

#[test]
fn eos_telnet_counts_only_when_turned_on() {
    let on = settings(&eos(EOS_ON)).expect("a SystemSettings node");
    assert!(on.contains("Bool(true)"), "{on}");
    let off = settings(&eos(EOS_OFF)).expect("a SystemSettings node");
    assert!(
        off.contains("Bool(false)") && !off.contains("Bool(true)"),
        "{off}"
    );
    // No block at all: EOS disables telnet by default, and nothing is bound.
    assert!(settings(&eos("!\nhostname leaf-1\n!\nend\n")).is_none());
}

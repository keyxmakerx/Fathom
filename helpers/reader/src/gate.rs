//! The redaction gate, in the reader (ADR-0082 §4.2; CLAUDE.md rule 4). What a device prints over
//! SSH goes through the same Rust gate a pasted config does, `fathom-ingest`, with the platform's
//! own statement dictionary, before it leaves this process. The server never sees the ungated
//! text, and checks again for a credential that survived (`crates/fathom-server`).
//!
//! The dictionaries are read from `FATHOM_READER_ROOT` (default `/fathom`), which holds
//! `corpus/dict/` and `schema/` exactly as the repository does; the image copies them in. A
//! dictionary that does not load stops the read: text is never answered ungated.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use fathom_ingest::dict::Dictionary;

fn root() -> PathBuf {
    if let Some(r) = std::env::var_os("FATHOM_READER_ROOT") {
        return PathBuf::from(r);
    }
    // Tests run from the repository; the image sets the variable.
    if cfg!(test) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    }
    PathBuf::from("/fathom")
}

static LOADED: OnceLock<Mutex<BTreeMap<&'static str, Arc<Dictionary>>>> = OnceLock::new();

fn dictionary(name: &'static str) -> Result<Arc<Dictionary>, String> {
    let cache = LOADED.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Some(d) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(name) {
        return Ok(Arc::clone(d));
    }
    let d = Dictionary::load_platform(&root(), name)
        .map(Arc::new)
        .map_err(|e| format!("the {name} dictionary does not load: {}", e.message))?;
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(name, Arc::clone(&d));
    Ok(d)
}

/// What the gate left of a device's output, and how many secrets it destroyed.
pub struct Gated {
    pub text: String,
    pub drops: usize,
}

/// Gates one command's output with the dictionary `dict` names. An error means nothing may be
/// answered.
pub fn gate(dict: &'static str, output: &[u8]) -> Result<Gated, String> {
    let d = dictionary(dict)?;
    let out = if dict == "eos" {
        fathom_ingest::blockcfg::ingest_eos(output, &d)
    } else {
        fathom_ingest::ingest(output, &d)
    }
    .map_err(|e| format!("the gate refused the output: {e:?}"))?;
    // Control characters are never part of a configuration, and a terminal this text is later
    // pasted into would act on them.
    let text = out
        .capture
        .text()
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    Ok(Gated {
        text,
        drops: out.drops.entries.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // CLAUDE.md rule 2: lengths and shapes a real device prints, not ones made for the detector.
    #[test]
    fn a_junos_hash_and_an_eos_secret_never_leave_the_reader() {
        let junos = b"set system host-name srx-lab\n\
set system root-authentication encrypted-password \"$6$Qm3x$Jx1fZbC9d0a.Kq2hYwN0\"\n\
set interfaces ge-0/0/0 unit 0 family inet address 10.20.0.1/24\n";
        let g = gate("junos-srx", junos).unwrap();
        assert!(!g.text.contains("$6$Qm3x"), "{}", g.text);
        assert!(g.text.contains("srx-lab"));
        assert!(g.drops >= 1);

        let eos = b"hostname leaf1\n\
username admin privilege 15 role network-admin secret sha512 $6$abcd$Zq9\n\
interface Ethernet1\n   description uplink\n";
        let g = gate("eos", eos).unwrap();
        assert!(!g.text.contains("$6$abcd"), "{}", g.text);
        assert!(g.text.contains("leaf1"));
    }

    /// A password with no hash around it: Junos keeps an archive site's URL as it was typed
    /// (`ftp://username<:password>@host`, "Back Up Configurations to an Archive Site", Junos OS
    /// CLI User Guide, read 2026-11-12), and `| display set` prints it back.
    #[test]
    fn a_password_inside_a_url_never_leaves_the_reader() {
        let junos = b"set system host-name srx-lab\n\
set system archival configuration archive-sites \"scp://backup:B4ckup!@10.1.1.20/configs\"\n\
set event-options destinations D archive-sites \"ftp://netops:Summer24@10.1.1.21/logs\"\n\
set system archival configuration archive-sites \"scp://backup@10.1.1.22/configs\" password \"$9$Qz3n6tOrlMX7VwYgoGjHq\"\n";
        let g = gate("junos-srx", junos).unwrap();
        for secret in ["B4ckup!", "Summer24", "$9$Qz3n"] {
            assert!(!g.text.contains(secret), "{secret}: {}", g.text);
        }
        assert!(g.text.contains("srx-lab"));
        assert!(
            g.text.contains("scp://backup@10.1.1.22/configs"),
            "{}",
            g.text
        );
    }

    #[test]
    fn terminal_escapes_a_device_prints_are_dropped() {
        let g = gate("junos-srx", b"set system host-name a\x1b[2J\x07\x01b\n").unwrap();
        assert_eq!(g.text, "set system host-name a[2Jb\n");
    }

    /// The output is answered gated or not at all: bytes that are not text stop the read.
    #[test]
    fn output_the_gate_cannot_read_is_refused_whole() {
        let bad = b"set system host-name a\n\xff\xfeset system radius-server 10.1.1.9 secret \"$9$Qz3n6tOrlMX7\"\n";
        assert!(gate("junos-srx", bad).is_err());
    }
}

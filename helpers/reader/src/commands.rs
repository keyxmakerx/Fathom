//! The fixed SSH command list (ADR-0082 §4.1): for each platform, the exact strings the reader may
//! run, and nothing else. A job names a platform, never a command, so nothing a person types can
//! reach a device. Each string is matched byte for byte before it is sent.
//!
//! Sources, read 3 November 2026 (CLAUDE.md rule 1):
//! - Junos: `show configuration` is the operational-mode command that "display[s] the last
//!   committed configuration, which is the configuration currently running" ("View the
//!   Configuration", Junos OS CLI User Guide, juniper.net). `| display set` shows it "as a series
//!   of configuration mode commands"; Fathom's set-form reader reads that form. The `display`
//!   filter on an operational command is from "Filtering Operational Command Output" (Junos OS
//!   Evolved CLI User Guide, read 1 November 2026, `client/src/components/termix/readOnly.ts`).
//!   Junos shows the portions a login may not view as `ACCESS-DENIED` (the same page), so a
//!   read-only class cannot see what it is not allowed to.
//! - Arista EOS: "show running-config displays the contents of running-config" ("Configuration
//!   Files", EOS 4.37.0F User Manual, arista.com). EOS's `sanitized` keyword is not used: no page
//!   establishing what it removes could be read, and the reader's own gate runs either way.
//!
//! Every one starts with `show`, which writes nothing on either platform. No pipe that saves, tees
//! or sends output is on the list.

/// One platform's fixed commands, and the dictionary (`corpus/dict/<dict>`) its output is gated
/// and read with.
pub struct Platform {
    pub id: &'static str,
    pub dict: &'static str,
    pub commands: &'static [&'static str],
}

/// The platforms the reader can read over SSH, by their `schema/platforms.yaml` ids.
pub const PLATFORMS: &[Platform] = &[
    Platform {
        id: "junos-srx",
        dict: "junos-srx",
        commands: &["show configuration | display set"],
    },
    Platform {
        id: "junos-ex",
        dict: "junos-ex",
        commands: &["show configuration | display set"],
    },
    Platform {
        id: "eos",
        dict: "eos",
        commands: &["show running-config"],
    },
];

pub fn platform(id: &str) -> Option<&'static Platform> {
    PLATFORMS.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_only_shows_and_none_saves_or_sends() {
        for p in PLATFORMS {
            assert!(!p.commands.is_empty(), "{}", p.id);
            for c in p.commands {
                assert!(c.starts_with("show "), "{}: {c}", p.id);
                for word in ["save", "tee", "append", "request", "|&", ";", "`", "$", ">"] {
                    assert!(!c.contains(word), "{}: {c} contains {word}", p.id);
                }
            }
        }
        assert!(
            platform("ios-xe").is_none(),
            "only platforms with a reader are offered"
        );
    }
}

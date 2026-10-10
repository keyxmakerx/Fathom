//! The operator commands `firmware.rs` renders beside a staged image, one set per
//! platform family.
//!
//! **Fathom runs none of these** (ADR-0045 §4.4). Each is text an operator copies;
//! the install line says so. The control order is the same on every platform:
//! check space, clean up *before* the copy, have the device pull the image from the
//! fetch URL, prove the whole file arrived, check the vendor signature where the
//! platform has a command for it, install (the operator's), check afterwards.
//!
//! `docs/UPGRADING-A-JUNIPER.md` and `docs/UPGRADING-A-CISCO-OR-ARISTA.md` are the
//! prose versions. Anything that could not be established from the vendor's own
//! documentation says so in `could_not_establish` rather than being guessed
//! (CLAUDE.md rule 1). Vendor pages were read on 2026-10-10 unless a step says
//! otherwise; Junos is the older, summary-sourced set (ADR-0034).

use std::collections::BTreeMap;

use fathom_canon::Json;

/// Where an image lands on a Junos device (`docs/UPGRADING-A-JUNIPER.md` step 3;
/// trap 4 is that `/var` is what fills).
const JUNOS_STAGING_DIRECTORY: &str = "/var/tmp/";

/// Which vendor's steps apply to a `platform` slug.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Junos,
    IosXe,
    NxOs,
    Eos,
    /// A platform no steps are written for.
    Unknown,
}

impl Family {
    /// `None` is Junos: images declared before `0038` carry no platform and were
    /// always shown Junos steps. A platform that is set but not recognised gets
    /// **no** steps, never Junos ones.
    pub fn of(platform: Option<&str>) -> Self {
        match platform {
            None => Self::Junos,
            Some("junos") => Self::Junos,
            Some(p) if p.starts_with("junos-") => Self::Junos,
            Some("ios-xe") => Self::IosXe,
            Some("nx-os") => Self::NxOs,
            Some("eos") => Self::Eos,
            Some(_) => Self::Unknown,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Junos => "junos",
            Self::IosXe => "ios-xe",
            Self::NxOs => "nx-os",
            Self::Eos => "eos",
            Self::Unknown => "unknown",
        }
    }
}

/// One step: what it is for, the command, and why.
struct Step {
    title: &'static str,
    command: String,
    note: String,
}

fn step(title: &'static str, command: impl Into<String>, note: impl Into<String>) -> Step {
    Step {
        title,
        command: command.into(),
        note: note.into(),
    }
}

/// Everything one family contributes to the answer.
struct Plan {
    device_path: Option<String>,
    steps: Vec<Step>,
    sourced: &'static str,
    sourced_note: String,
    could_not_establish: Vec<&'static str>,
    /// What the device can compute, and what to compare it with. Fathom holds a
    /// SHA-256; where the device offers only another hash, the answer says so
    /// rather than implying the device's output can be compared with it.
    device_hash_algorithm: &'static str,
    device_hash_compares_with: &'static str,
}

const INSTALL_NOTE: &str = "ADR-0045 §4.4: Fathom stages and verifies and never installs. This \
                            line is here so you can copy it, not so that anything runs it.";

/// The commands for one image. `url` is the issued fetch URL when there is one; the
/// read-back has none, because Fathom keeps only the token's hash.
pub fn commands(platform: Option<&str>, filename: &str, sha256: &str, url: Option<&str>) -> Json {
    let family = Family::of(platform);
    let copy_source = match url {
        Some(url) => url.to_string(),
        None => "<the fetch URL, from POST .../fetch-urls — Fathom keeps only its hash and \
                 cannot show you one it already issued>"
            .to_string(),
    };
    let plan = match family {
        Family::Junos => junos(filename, &copy_source),
        Family::IosXe => ios_xe(filename, &copy_source),
        Family::NxOs => nx_os(filename, &copy_source),
        Family::Eos => eos(filename, &copy_source),
        Family::Unknown => unknown(platform.unwrap_or_default()),
    };

    let steps = plan
        .steps
        .into_iter()
        .enumerate()
        .map(|(order, s)| {
            let mut map = BTreeMap::new();
            map.insert("order".to_string(), Json::Int(order as i64 + 1));
            map.insert("step".to_string(), Json::Str(s.title.to_string()));
            map.insert("command".to_string(), Json::Str(s.command));
            map.insert("note".to_string(), Json::Str(s.note));
            map.insert("run_by".to_string(), Json::Str("operator".to_string()));
            Json::Obj(map)
        })
        .collect();

    let mut device_hash = BTreeMap::new();
    device_hash.insert(
        "algorithm".to_string(),
        Json::Str(plan.device_hash_algorithm.to_string()),
    );
    device_hash.insert(
        "compares_with".to_string(),
        Json::Str(plan.device_hash_compares_with.to_string()),
    );

    let mut envelope = BTreeMap::new();
    envelope.insert("expected_sha256".to_string(), Json::Str(sha256.to_string()));
    envelope.insert(
        "platform".to_string(),
        platform.map_or(Json::Null, |p| Json::Str(p.to_string())),
    );
    envelope.insert("family".to_string(), Json::Str(family.name().to_string()));
    envelope.insert(
        "device_path".to_string(),
        plan.device_path.map_or(Json::Null, Json::Str),
    );
    envelope.insert("steps".to_string(), Json::Arr(steps));
    envelope.insert("device_hash".to_string(), Json::Obj(device_hash));
    envelope.insert("sourced".to_string(), Json::Str(plan.sourced.to_string()));
    envelope.insert("sourced_note".to_string(), Json::Str(plan.sourced_note));
    envelope.insert(
        "could_not_establish".to_string(),
        Json::Arr(
            plan.could_not_establish
                .into_iter()
                .map(|s| Json::Str(s.to_string()))
                .collect(),
        ),
    );
    envelope.insert("fathom_runs_none_of_these".to_string(), Json::Bool(true));
    Json::Obj(envelope)
}

fn unknown(platform: &str) -> Plan {
    Plan {
        device_path: None,
        steps: Vec::new(),
        sourced: "none",
        sourced_note: format!(
            "No steps are written for the platform '{platform}'. Fathom still holds the image and \
             its SHA-256 (expected_sha256) and can issue a fetch URL; the upgrade procedure is \
             yours to take from the vendor's documentation. Written: junos, ios-xe, nx-os, eos."
        ),
        could_not_establish: Vec::new(),
        device_hash_algorithm: "sha256",
        device_hash_compares_with: "expected_sha256",
    }
}

// ---- Juniper (unchanged from the first release of this feature) ----

/// `docs/UPGRADING-A-JUNIPER.md` steps 2 to 7 and ADR-0045 §6's traps.
///
/// **The order is a control, not a listing.** Trap 1: `request system storage
/// cleanup` deletes the image just copied, so cleanup comes before the copy. Trap 5
/// is the second snapshot, so there are two. A *summary* of Juniper's
/// documentation, not a verbatim read (ADR-0034), hence `"sourced": "summary"`.
fn junos(filename: &str, copy_source: &str) -> Plan {
    let device_path = format!("{JUNOS_STAGING_DIRECTORY}{filename}");
    let steps = vec![
        step(
            "check space first",
            "show system storage",
            "/var is the partition that fills. On Junos OS Evolved, 90% or more on /soft, /var \
             or /data means there is not enough room to install.",
        ),
        step(
            "make room BEFORE the copy",
            "request system storage cleanup",
            "TRAP 1: cleanup can delete the image you just copied. Run it before the copy, \
             never after. `request system storage cleanup dry-run` shows what it would remove.",
        ),
        step(
            "take the first snapshot",
            "request system snapshot",
            "Copies the running system to alternate media. `request system configuration rescue \
             save` gives `rollback rescue` a known-good configuration to return to.",
        ),
        step(
            "have the device pull the image",
            format!("file copy {copy_source} {JUNOS_STAGING_DIRECTORY}"),
            "The device uses its own transfer stack, so the SCP-versus-SFTP question does not \
             arise. Whether Junos verifies TLS certificates on an https:// source could not be \
             established, so nothing here leans on the transport: the next two steps are what \
             establish that the right bytes arrived.",
        ),
        step(
            "prove the whole file arrived",
            format!("file checksum sha-256 {device_path}"),
            "TRAP 2, and the reason this feature exists. The answer must equal the \
             `expected_sha256` in this response, which Fathom computed over the bytes it holds. \
             If they differ, delete the file and copy it again.",
        ),
        step(
            "prove Juniper made it",
            format!("request system software validate {device_path}"),
            "Checks the vendor signature against a Juniper root certificate. THIS is the \
             authenticity control -- not the published MD5 or SHA-1, which catch a truncated \
             download and not a substituted image. It does not answer 'is this the release I \
             meant', which is yours to check.",
        ),
        step(
            "install -- yours to run, not Fathom's",
            format!("request system software add {device_path}"),
            INSTALL_NOTE,
        ),
        step(
            "and the second snapshot, after it comes back",
            "request system snapshot",
            "TRAP 5: skip this and the alternate boot media stays out of step with the primary. \
             `request system software rollback` reverts the last install if the upgrade went \
             wrong.",
        ),
    ];
    Plan {
        device_path: Some(device_path),
        steps,
        sourced: "summary",
        sourced_note: "juniper.net was unreachable when these were researched (2026-09-14), so \
                       these are search summaries describing Juniper's documentation rather than \
                       verbatim reads of it. Check them against the hardware guide for your \
                       platform and release before a maintenance window you care about. \
                       docs/UPGRADING-A-JUNIPER.md carries the same warning and the per-step \
                       marking."
            .to_string(),
        could_not_establish: vec![
            "whether Junos verifies TLS certificates on an https:// source",
            "whether Juniper publishes SHA-256 or a detached signature beside images today",
        ],
        device_hash_algorithm: "sha256",
        device_hash_compares_with: "expected_sha256",
    }
}

// ---- Cisco IOS XE ----

/// Read 2026-10-10: Cisco's "Upgrading Catalyst 9300 Switches" (222280), "Transferring
/// Files Using HTTP or HTTPS" (IOS XE), and "Cisco IOS XE Integrity Assurance".
fn ios_xe(filename: &str, copy_source: &str) -> Plan {
    let device_path = format!("bootflash:{filename}");
    let steps = vec![
        step(
            "check space first",
            "dir bootflash:",
            "Cisco's Catalyst 9300 guide asks for 1 GB to 1.5 GB free for the image to expand. \
             That guide writes flash: where this writes bootflash:; `show file systems` lists \
             the name your platform uses.",
        ),
        step(
            "make room BEFORE the copy",
            "install remove inactive",
            "Install mode (IOS XE 16.6.2 and later). Cisco's guide runs it before the copy. It \
             removes inactive installed packages; confirm what it will remove at its prompt.",
        ),
        step(
            "have the device pull the image",
            format!("copy {copy_source} {device_path}"),
            "Cisco's HTTPS client page documents `copy https://<url> <destination>`. From \
             17.3.1 the server name must match the certificate's Subject Alternative Name; from \
             17.15.1a the URL must carry an absolute path. Whether the device validates the \
             certificate chain could not be established, so the next steps are what establish \
             that the right bytes arrived.",
        ),
        step(
            "prove the whole file arrived",
            format!("verify /sha512 bootflash:{filename}"),
            "IOS XE's verify takes /md5 or /sha512 (SHA-512 since 16.5.1); an on-device SHA-256 \
             could not be established. Fathom holds SHA-256, so this output is NOT comparable \
             with expected_sha256: compare it with the SHA-512 Cisco shows for this file on its \
             Software Download page. That also shows the file is Cisco's, which is stronger.",
        ),
        step(
            "check Cisco signed it",
            format!("show software authenticity file bootflash:{filename}"),
            "Shows the signer and image type (for example 'Production') from the file's \
             signature. Cisco's integrity-assurance page also shows `verify <file>` to check the \
             digital signature on a .pkg; whether that works on a .bin could not be established.",
        ),
        step(
            "install -- yours to run, not Fathom's",
            format!("install add file bootflash:{filename} activate commit"),
            format!("{INSTALL_NOTE} Cisco's guide notes it prompts that the system will reload."),
        ),
        step(
            "check after it comes back",
            "show version",
            "Confirm the version is the release you meant. Cisco's guide does not give a \
             rollback command on that page; none is listed here.",
        ),
    ];
    Plan {
        device_path: Some(device_path),
        steps,
        sourced: "vendor_docs",
        sourced_note: "Read on 2026-10-10: \
            https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/222280-upgrading-catalyst-9300-switches.html ; \
            https://www.cisco.com/en/US/docs/ios-xml/ios/https/configuration/xe-2/https-xe-2-book.html ; \
            https://www.cisco.com/c/en/us/about/security-center/ios-xe-integrity-assurance.html . \
            The upgrade guide is for Catalyst 9300 in install mode; other IOS XE platforms and \
            bundle mode differ. Check against the guide for your platform and release. \
            docs/UPGRADING-A-CISCO-OR-ARISTA.md has the per-step detail."
            .to_string(),
        could_not_establish: vec![
            "an on-device SHA-256 command on IOS XE (verify offers /md5 and /sha512)",
            "whether the HTTPS copy validates the server certificate chain",
            "whether `verify` checks the signature of a .bin as it does a .pkg",
            "a rollback command, from the pages read",
        ],
        device_hash_algorithm: "sha512",
        device_hash_compares_with: "vendor_published_sha512",
    }
}

// ---- Cisco NX-OS ----

/// Read 2026-10-10: Cisco's "Upgrade Nexus 3000 and 3100 NX-OS Software" (216037),
/// "Validate the Integrity of a Downloaded Software File" (211350, MDS), and the
/// Nexus 9000 10.3(x) troubleshooting guide's file-copy section.
fn nx_os(filename: &str, copy_source: &str) -> Plan {
    let device_path = format!("bootflash:{filename}");
    let steps = vec![
        step(
            "check space first",
            "dir bootflash:",
            "Cisco's Nexus 3000/3100 guide notes bootflash cannot hold two NX-OS images at once \
             on those platforms; check yours.",
        ),
        step(
            "make room BEFORE the copy",
            "delete bootflash:<an old image you no longer need>",
            "Cisco's guide uses `delete bootflash:<file>`. Delete before the copy, and only \
             what you have checked is not the running or next-boot image.",
        ),
        step(
            "have the device pull the image",
            format!("copy {copy_source} {device_path} vrf management"),
            "Change `vrf management` to the VRF that reaches Fathom. Cisco's examples for this \
             command use scp:; its Nexus 9000 troubleshooting guide lists http: among the \
             sources and names HTTPS only in passing, so that `https://` is accepted on your \
             release could not be established. Do NOT add `compact`: it changes the file, and \
             its hash.",
        ),
        step(
            "prove the whole file arrived",
            format!("show file bootflash:{filename} sha256sum"),
            "The answer must equal expected_sha256. Cisco's help output (MDS, 211350) lists \
             sha256sum alongside md5sum and sha512sum; that older NX-OS releases have it could \
             not be established (Cisco says only md5sum is on every version). Where it is \
             missing use sha512sum and compare with the SHA-512 on Cisco's download page.",
        ),
        step(
            "check the image against this switch",
            format!("show install all impact nxos bootflash:{filename}"),
            "The upgrade-impact check. The Cisco page read shows the kickstart form for unified \
             images. A stand-alone command that verifies the image signature could not be \
             established.",
        ),
        step(
            "install -- yours to run, not Fathom's",
            format!("install all nxos bootflash:{filename}"),
            format!("{INSTALL_NOTE} Cisco's guide says the switch reloads."),
        ),
        step(
            "check after it comes back",
            "show version",
            "Then `show module`, which Cisco's guide uses to confirm the target version on every \
             module.",
        ),
    ];
    Plan {
        device_path: Some(device_path),
        steps,
        sourced: "vendor_docs",
        sourced_note: "Read on 2026-10-10: \
            https://www.cisco.com/c/en/us/support/docs/switches/nexus-3000-series-switches/216037-nexus-3000-and-3100-nx-os-software-upgra.html ; \
            https://www.cisco.com/c/en/us/support/docs/storage-networking/mds-9000-san-management/211350-How-to-Validate-the-Integrity-of-a-Downl.html ; \
            https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/troubleshooting/cisco-nexus-9000-series-nx-os-troubleshooting-guide-release-103x/m_before_contacting_technical_support_9x.html . \
            The upgrade page is for Nexus 3000/3100 going to 9.3(x); Nexus 9000 and later \
            releases differ in detail. Check against the guide for your platform and release. \
            docs/UPGRADING-A-CISCO-OR-ARISTA.md has the per-step detail."
            .to_string(),
        could_not_establish: vec![
            "that copy accepts an https:// source on every NX-OS release",
            "that show file ... sha256sum exists on older NX-OS releases",
            "a stand-alone command that verifies the image's signature",
            "a rollback command, from the pages read",
        ],
        device_hash_algorithm: "sha256",
        device_hash_compares_with: "expected_sha256",
    }
}

// ---- Arista EOS ----

/// Read 2026-10-10: Arista's EOS 4.36.2F "Standard Upgrades and Downgrades" and
/// Security Advisory 30. The `bash` form is from a third-party guide.
fn eos(filename: &str, copy_source: &str) -> Plan {
    let device_path = format!("flash:/{filename}");
    let steps = vec![
        step(
            "check space first",
            "dir flash:",
            "Arista asks for room for two copies of the image, and recommends 240 MB free, if \
             available, for diagnostics after a fatal error. Read the 'bytes free' figure.",
        ),
        step(
            "make room BEFORE the copy",
            "delete flash:<an old image you no longer need>",
            "Arista's page says files may be deleted from /mnt/flash to make room but does not \
             give the command; `delete` is not taken from it. Check the file is not the one \
             `show boot-config` names.",
        ),
        step(
            "save the configuration",
            "copy running-config flash:/<a name for this backup>",
            "Arista's page: keep a copy of the running EOS version and the running-config \
             before upgrading.",
        ),
        step(
            "have the device pull the image",
            format!("copy {copy_source} {device_path}"),
            "Arista's upgrade page documents http://, ftp:, scp: and usb sources and no https://. \
             That EOS accepts an https:// source could not be established; if it refuses, this \
             step cannot be done from Fathom's HTTPS fetch URL. The next steps establish that \
             the right bytes arrived either way.",
        ),
        step(
            "prove the whole file arrived",
            format!("bash sha256sum /mnt/flash/{filename}"),
            "The answer must equal expected_sha256. This runs the Linux sha256sum from the EOS \
             CLI; /mnt/flash is flash: (Arista's page), and the one-line `bash <command>` form \
             is from a third-party guide, not read from Arista. Arista's own documented check is \
             `verify /sha512 flash:<file>` (Security Advisory 30), which compares with the \
             SHA-512 Arista publishes, not with expected_sha256.",
        ),
        step(
            "compare with the hash Arista publishes",
            format!("verify /sha512 {device_path}"),
            "Compare with the SHA-512 on Arista's download page for this file. A command that \
             verifies an SWI's signature from the CLI could not be established; Arista's pages \
             read do not give one.",
        ),
        step(
            "point the switch at it -- yours to run, not Fathom's",
            format!("boot system {device_path}"),
            format!(
                "{INSTALL_NOTE} Global configuration mode. Then `write` and `show boot-config` \
                 to check it names this image."
            ),
        ),
        step(
            "reload -- yours to run, not Fathom's",
            "reload",
            "Arista: this resets the switch, with downtime and packet loss on a single-supervisor \
             switch. Dual-supervisor switches use `install source <file> reload` instead.",
        ),
        step(
            "check after it comes back",
            "show version",
            "The 'Software image version' line is the active image. Arista's page gives no \
             rollback command; none is listed here.",
        ),
    ];
    Plan {
        device_path: Some(device_path),
        steps,
        sourced: "vendor_docs",
        sourced_note: "Read on 2026-10-10: \
            https://www.arista.com/en/um-eos/eos-standard-upgrades-and-downgrades ; \
            https://www.arista.com/en/support/advisories-notices/security-advisory/3577-security-advisory-30 . \
            The `bash <command>` form is from the third-party guide at \
            https://acws.duckdns.org/2025.4.ATL/references/arista_eos_guide , not from Arista. \
            Arista's upgrade page still uses 4.13.2 examples under a 4.36.2F title. \
            docs/UPGRADING-A-CISCO-OR-ARISTA.md has the per-step detail."
            .to_string(),
        could_not_establish: vec![
            "that copy accepts an https:// source (Arista's page lists http, ftp, scp, usb)",
            "an Arista-documented SHA-256 command on the switch (verify is documented with /md5 and /sha512)",
            "a CLI command that verifies the SWI's signature",
            "the delete command for making room, from the page read",
            "a rollback command, from the pages read",
        ],
        device_hash_algorithm: "sha256",
        device_hash_compares_with: "expected_sha256",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://fathom.example.net/firmware/fetch/deadbeef";

    fn field<'a>(j: &'a Json, key: &str) -> &'a Json {
        match j {
            Json::Obj(m) => m.get(key).unwrap_or_else(|| panic!("no key {key}")),
            other => panic!("not an object: {other:?}"),
        }
    }

    fn text(j: &Json) -> &str {
        match j {
            Json::Str(s) => s,
            other => panic!("not a string: {other:?}"),
        }
    }

    /// (title, command) pairs in order.
    fn steps(j: &Json) -> Vec<(String, String)> {
        let Json::Arr(items) = field(j, "steps") else {
            panic!("steps is not an array")
        };
        items
            .iter()
            .enumerate()
            .map(|(i, s)| {
                assert_eq!(field(s, "order"), &Json::Int(i as i64 + 1));
                assert_eq!(text(field(s, "run_by")), "operator");
                (
                    text(field(s, "step")).to_string(),
                    text(field(s, "command")).to_string(),
                )
            })
            .collect()
    }

    fn index_of(steps: &[(String, String)], needle: &str) -> usize {
        steps
            .iter()
            .position(|(_, c)| c.contains(needle))
            .unwrap_or_else(|| panic!("no step runs `{needle}`: {steps:?}"))
    }

    /// Per platform: the slug, the cleanup command, the hash command, the install
    /// command.
    const PLATFORMS: [(&str, &str, &str, &str); 4] = [
        (
            "junos",
            "storage cleanup",
            "file checksum sha-256 /var/tmp/img.bin",
            "request system software add /var/tmp/img.bin",
        ),
        (
            "ios-xe",
            "install remove inactive",
            "verify /sha512 bootflash:img.bin",
            "install add file bootflash:img.bin activate commit",
        ),
        (
            "nx-os",
            "delete bootflash:",
            "show file bootflash:img.bin sha256sum",
            "install all nxos bootflash:img.bin",
        ),
        (
            "eos",
            "delete flash:",
            "sha256sum /mnt/flash/img.bin",
            "boot system flash:/img.bin",
        ),
    ];

    #[test]
    fn every_platform_carries_the_hash_and_url_and_keeps_check_copy_verify_install_order() {
        let sha = "c".repeat(64);
        for (platform, cleanup, hash, install) in PLATFORMS {
            let j = commands(Some(platform), "img.bin", &sha, Some(URL));
            assert_eq!(text(field(&j, "expected_sha256")), sha, "{platform}");
            assert_eq!(text(field(&j, "platform")), platform);
            assert_eq!(field(&j, "fathom_runs_none_of_these"), &Json::Bool(true));

            let s = steps(&j);
            let cleanup = index_of(&s, cleanup);
            let copy = index_of(&s, URL);
            let verify = index_of(&s, hash);
            let install_at = index_of(&s, install);
            assert!(
                0 < cleanup && cleanup < copy && copy < verify && verify < install_at,
                "{platform}: space, cleanup, copy, verify, install, in that order: {s:?}"
            );
            let (title, _) = &s[install_at];
            assert!(title.contains("yours to run, not Fathom's"), "{platform}");
            assert!(!text(field(&j, "sourced_note")).is_empty());
        }
    }

    #[test]
    fn the_new_vendors_name_their_sources_and_the_date_read() {
        for platform in ["ios-xe", "nx-os", "eos"] {
            let j = commands(Some(platform), "img.bin", &"d".repeat(64), None);
            let note = text(field(&j, "sourced_note"));
            assert!(note.contains("2026-10-10"), "{platform}");
            assert!(
                note.contains("https://www.cisco.com") || note.contains("https://www.arista.com"),
                "{platform}"
            );
            let Json::Arr(gaps) = field(&j, "could_not_establish") else {
                panic!("not an array")
            };
            assert!(
                !gaps.is_empty(),
                "{platform} states what it could not establish"
            );
        }
    }

    /// IOS XE has no on-device SHA-256 that could be established, and says so
    /// instead of presenting a SHA-512 as comparable with Fathom's hash.
    #[test]
    fn a_device_hash_that_is_not_sha256_says_what_it_compares_with() {
        let j = commands(Some("ios-xe"), "img.bin", &"e".repeat(64), None);
        let dh = field(&j, "device_hash");
        assert_eq!(text(field(dh, "algorithm")), "sha512");
        assert_eq!(text(field(dh, "compares_with")), "vendor_published_sha512");
        let j = commands(Some("nx-os"), "img.bin", &"e".repeat(64), None);
        assert_eq!(text(field(field(&j, "device_hash"), "algorithm")), "sha256");
    }

    #[test]
    fn without_a_url_no_platform_invents_one() {
        for (platform, ..) in PLATFORMS {
            let j = commands(Some(platform), "img.bin", &"f".repeat(64), None);
            let all = String::from_utf8(j.to_canonical_bytes()).unwrap();
            assert!(!all.contains("/firmware/fetch/"), "{platform}");
            assert!(all.contains("cannot show you one"), "{platform}");
        }
    }

    #[test]
    fn junos_family_and_unset_platform_get_the_junos_steps() {
        let sha = "1".repeat(64);
        let unset = commands(None, "img.bin", &sha, Some(URL));
        assert_eq!(text(field(&unset, "family")), "junos");
        assert_eq!(field(&unset, "platform"), &Json::Null);
        for p in ["junos", "junos-evo", "junos-srx"] {
            let j = commands(Some(p), "img.bin", &sha, Some(URL));
            assert_eq!(steps(&j), steps(&unset), "{p}");
            assert_eq!(text(field(&j, "family")), "junos");
        }
        assert_eq!(steps(&unset).len(), 8, "the Junos steps are unchanged");
        assert_eq!(text(field(&unset, "sourced")), "summary");
    }

    /// A platform that is set but not recognised gets no steps, never Junos ones.
    #[test]
    fn an_unknown_platform_gets_no_steps_and_says_so() {
        let sha = "2".repeat(64);
        for p in ["sonic", "ios", "juno", "eos2"] {
            let j = commands(Some(p), "img.bin", &sha, Some(URL));
            assert!(steps(&j).is_empty(), "{p}");
            assert_eq!(text(field(&j, "family")), "unknown");
            assert_eq!(text(field(&j, "expected_sha256")), sha);
            assert_eq!(field(&j, "device_path"), &Json::Null);
            assert!(text(field(&j, "sourced_note")).contains("No steps are written"));
            let all = String::from_utf8(j.to_canonical_bytes()).unwrap();
            assert!(!all.contains(URL), "no step carries the URL: {all}");
        }
    }
}

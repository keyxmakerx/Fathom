//! The same upgrade done without Fathom: from a Windows PC or a Linux box. Fathom is
//! a learning tool, so beside its own route (the device pulls with a one-time link)
//! it shows how the file gets there by hand.
//!
//! Only getting the file onto the device changes. Checking space, proving the whole
//! file arrived on the device, installing and checking afterwards are the steps in
//! `firmware_commands.rs`, whichever way the file travelled. These steps replace the
//! "have the device pull the image" step and nothing else.
//!
//! **Fathom runs none of these** (ADR-0045 §4.4), and holds no device credential for
//! them: `<you>` is the operator's own login. Pages were read on 2026-10-25 unless a
//! step says otherwise; anything a page did not settle is in `could_not_establish`
//! (CLAUDE.md rule 1).

use std::collections::BTreeMap;

use fathom_canon::Json;

use crate::firmware_commands::Family;

/// Where a step is typed.
#[derive(Clone, Copy)]
enum At {
    Computer,
    Device,
}

/// One step. An empty `command` is something done by hand, described in `note`.
struct Step {
    at: At,
    title: &'static str,
    command: String,
    note: String,
}

fn on(at: At, title: &'static str, command: impl Into<String>, note: impl Into<String>) -> Step {
    Step {
        at,
        title,
        command: command.into(),
        note: note.into(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Os {
    Windows,
    Linux,
}

/// How the file crosses.
enum Transfer {
    /// The computer pushes it with `scp -O` to `<you>@<device address>:<target>`.
    Push { target: String, note: &'static str },
    /// The device pulls it from an SSH server on the computer.
    Pull {
        device_command: String,
        note: &'static str,
    },
}

/// What one family needs around the copy.
struct Route {
    /// The hash the vendor publishes, which the computer computes before the copy.
    algorithm: &'static str,
    before: Vec<Step>,
    copy: Transfer,
    after: Vec<Step>,
    could_not_establish: Vec<&'static str>,
}

const SCP_O: &str = "-O makes scp use the old SCP protocol. Since OpenSSH 9.0 scp uses SFTP \
                     by default (scp(1), read 2026-09-14, ADR-0045 §2.2), and a device with no \
                     SFTP server refuses it with an error that does not say why.";

const WINDOWS_SCP: &str = "scp comes with the OpenSSH Client for Windows. If PowerShell says scp \
                           is not recognised, add OpenSSH Client in Settings, Optional features \
                           (Microsoft Learn, 'Get started with OpenSSH for Windows', updated \
                           2025-09-04).";

fn route(family: Family, filename: &str) -> Option<Route> {
    match family {
        Family::Junos => Some(Route {
            algorithm: "sha256",
            before: Vec::new(),
            copy: Transfer::Push {
                target: "/var/tmp/".to_string(),
                note: "Junos turns its SFTP server off by default from 19.1R1, which is why -O \
                       matters here (ADR-0045 §2.2, search summary). Your login class must allow \
                       SCP: the operator and read-only classes cannot receive a file (ADR-0045 \
                       §2.1, search summary). docs/UPGRADING-A-JUNIPER.md step 3 is this route.",
            },
            after: Vec::new(),
            could_not_establish: vec![
                "a current juniper.net page showing scp from a computer (the Junos 13.1 QFX \
                 upgrade page says the package can sit on a remote host reached by HTTP, TFTP, \
                 FTP or scp, and shows FTP)",
            ],
        }),
        Family::IosXe => Some(Route {
            algorithm: "sha512",
            before: vec![on(
                At::Device,
                "let the switch receive a file",
                "ip scp server enable",
                "Global configuration mode. Cisco's guide (215450, 'Copy Cisco IOS Images from \
                 PC to Router', updated 2025-09-15) also has aaa new-model, aaa authentication \
                 login default local, aaa authorization exec default local and a privilege 15 \
                 user; check yours has them before you add any.",
            )],
            copy: Transfer::Push {
                target: filename.to_string(),
                note: "Cisco's guide gives only the file name after the colon, so the file lands \
                       on the default file system; `dir bootflash:` shows it.",
            },
            after: vec![on(
                At::Device,
                "and turn it off again",
                "no ip scp server enable",
                "Global configuration mode. Cisco's guide: disable it after the copy is complete.",
            )],
            could_not_establish: vec![
                "which file system a copy with no prefix lands on, on your platform",
            ],
        }),
        Family::NxOs => Some(Route {
            algorithm: "sha256",
            before: vec![on(
                At::Device,
                "let the switch receive a file",
                "feature scp-server",
                "Configuration mode. Cisco's Nexus 3000 and 9000 NX-API REST SDK guide, \
                 'Configuring SSH', section 'Enabling the SCP Server' (read 2026-10-25).",
            )],
            copy: Transfer::Push {
                target: filename.to_string(),
                note: "Check where it landed with `dir bootflash:`. Do not compact the image \
                       afterwards: that changes the file, and its hash.",
            },
            after: vec![on(
                At::Device,
                "and turn it off again",
                "no feature scp-server",
                "Cisco says this for IOS (215450); the NX-OS page read does not say it, but a \
                 file server left on is a door left open.",
            )],
            could_not_establish: vec![
                "the scp destination form that names bootflash: on NX-OS, from Cisco's pages",
            ],
        }),
        Family::Eos => Some(Route {
            algorithm: "sha256",
            before: Vec::new(),
            copy: Transfer::Pull {
                device_command: format!(
                    "copy scp://<you>@<this computer's address>/<folder>/{filename} flash:/{filename}"
                ),
                note: "Arista's upgrade page shows the switch pulling (scp, ftp, http or a USB \
                       stick) and never a computer copying to the switch, so this route turns \
                       around: this computer is the server. Arista's page also gives \
                       `copy usb1:/<file> flash:/<file>` for a USB stick.",
            },
            after: Vec::new(),
            could_not_establish: vec![
                "copying to an EOS switch from a computer, from Arista's pages (they show only \
                 the switch pulling)",
            ],
        }),
        Family::Unknown => None,
    }
}

fn hash_step(os: Os, algorithm: &'static str, filename: &str) -> Step {
    let words = if algorithm == "sha512" {
        "SHA-512"
    } else {
        "SHA-256"
    };
    let compare = if algorithm == "sha512" {
        "Compare it with the SHA-512 on Cisco's download page for this file. Fathom holds a \
         SHA-256, which is not comparable with it."
    } else {
        "Compare it with the vendor's published value and, if the image is in Fathom, with \
         expected_sha256. Check here first: a bad download is quicker to find on your desk \
         than in the window."
    };
    match os {
        Os::Windows => on(
            At::Computer,
            "check the file on your computer",
            format!(
                "Get-FileHash .\\{filename} -Algorithm {}",
                algorithm.to_uppercase()
            ),
            format!(
                "PowerShell, in the folder you downloaded to. Get-FileHash prints the {words} on \
                 its Hash line (Microsoft Learn, 'Get-FileHash', read 2026-10-25). {compare}"
            ),
        ),
        Os::Linux => on(
            At::Computer,
            "check the file on your computer",
            format!("{algorithm}sum {filename}"),
            format!("Prints the {words} then the file name (GNU coreutils). {compare}"),
        ),
    }
}

fn steps_for(os: Os, filename: &str, r: &Route) -> Vec<Step> {
    let mut out = vec![hash_step(os, r.algorithm, filename)];
    for s in &r.before {
        out.push(on(s.at, s.title, s.command.clone(), s.note.clone()));
    }
    match &r.copy {
        Transfer::Push { target, note } => {
            let source = if os == Os::Windows {
                format!(".\\{filename}")
            } else {
                filename.to_string()
            };
            let windows = if os == Os::Windows { WINDOWS_SCP } else { "" };
            out.push(on(
                At::Computer,
                "copy it to the device",
                format!("scp -O {source} <you>@<device address>:{target}"),
                format!("{SCP_O} {note} {windows}").trim_end().to_string(),
            ));
        }
        Transfer::Pull {
            device_command,
            note,
        } => {
            let serve = if os == Os::Windows {
                "Add and start OpenSSH Server (Settings, Optional features). Microsoft's table \
                 says it is not installed by default on Windows 10 or Server 2019 and 2022, and \
                 installed but not enabled on Server 2025 (Microsoft Learn, 'OpenSSH for \
                 Windows overview', updated 2025-02-20). Allow it through the firewall from the \
                 switch only, and stop it afterwards."
            } else {
                "Start an SSH server on this computer (most distributions call the package \
                 openssh-server), let the switch reach port 22, and stop it afterwards if it \
                 is not normally on."
            };
            out.push(on(
                At::Computer,
                "let the switch reach this computer",
                "",
                serve,
            ));
            out.push(on(
                At::Device,
                "have the switch pull it from you",
                device_command.clone(),
                *note,
            ));
        }
    }
    for s in &r.after {
        out.push(on(s.at, s.title, s.command.clone(), s.note.clone()));
    }
    out
}

fn to_json(steps: Vec<Step>) -> Json {
    Json::Arr(
        steps
            .into_iter()
            .enumerate()
            .map(|(i, s)| {
                let mut m = BTreeMap::new();
                m.insert("order".to_string(), Json::Int(i as i64 + 1));
                let at = match s.at {
                    At::Computer => "computer",
                    At::Device => "device",
                };
                m.insert("at".to_string(), Json::Str(at.to_string()));
                m.insert("step".to_string(), Json::Str(s.title.to_string()));
                m.insert("command".to_string(), Json::Str(s.command));
                m.insert("note".to_string(), Json::Str(s.note));
                m.insert("run_by".to_string(), Json::Str("operator".to_string()));
                Json::Obj(m)
            })
            .collect(),
    )
}

/// Which way the file travels.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Way {
    Scp,
    Usb,
    Tftp,
}

const TFTP_WARNING: &str = "The old way, shown so you know it. TFTP has no login or access \
                            control (RFC 1350, Security Considerations), and nothing in it \
                            encrypts the file: anyone who can reach the server can fetch what it \
                            serves, and anyone on the path can change it. The hash check on the \
                            device is what catches a changed file. Use it only on a closed \
                            management network, and stop the server afterwards.";

/// The device's command that copies from a USB stick, where the vendor documents one.
fn usb_copy(family: Family, filename: &str) -> Option<Step> {
    match family {
        Family::IosXe => Some(on(
            At::Device,
            "copy it from the stick",
            format!("copy usbflash0:{filename} flash:"),
            "Cisco's Catalyst 9300 upgrade guide (222280, updated 2025-10-15), install mode. In \
             bundle mode it copies to flash-x:, where x is the stack member's number.",
        )),
        Family::Eos => Some(on(
            At::Device,
            "copy it from the stick",
            format!("copy usb1:/{filename} flash:/{filename}"),
            "Arista's 'Standard Upgrades and Downgrades' page, 'Transfer the Image File'.",
        )),
        _ => None,
    }
}

/// The device's command that pulls from a TFTP server, where the vendor documents one.
fn tftp_copy(family: Family, filename: &str) -> Option<Step> {
    match family {
        Family::IosXe => Some(on(
            At::Device,
            "have the switch pull it from you",
            format!("copy tftp://<this computer's address>/{filename} flash:"),
            "Cisco's Catalyst 9300 upgrade guide (222280, updated 2025-10-15), install mode.",
        )),
        Family::NxOs => Some(on(
            At::Device,
            "have the switch pull it from you",
            format!("copy tftp://<this computer's address>/{filename} bootflash: vrf management"),
            "Cisco's Nexus 3000 and 9000 NX-API REST SDK guide, 'Copying File to Bootflash:' \
             (read 2026-10-25): its CLI line is copy tftp://... bootflash:, and its payload names \
             the management VRF. Change the VRF to the one that reaches this computer.",
        )),
        _ => None,
    }
}

fn way_steps(way: Way, os: Os, family: Family, filename: &str, r: &Route) -> Option<Vec<Step>> {
    match way {
        Way::Scp => Some(steps_for(os, filename, r)),
        Way::Usb => {
            let copy = usb_copy(family, filename)?;
            Some(vec![
                hash_step(os, r.algorithm, filename),
                on(
                    At::Computer,
                    "put it on a USB stick",
                    "",
                    "Copy the file to the top folder of the stick, eject it safely, and plug it \
                     into the switch.",
                ),
                copy,
            ])
        }
        Way::Tftp => {
            let copy = tftp_copy(family, filename)?;
            let mut out = vec![hash_step(os, r.algorithm, filename)];
            match os {
                Os::Linux => {
                    out.push(on(
                        At::Computer,
                        "start a TFTP server",
                        "sudo apt install tftpd-hpa",
                        "Debian and Ubuntu. It serves /srv/tftp by default (third-party guide, \
                         tecmint.com, 'How to Install and Configure TFTP Server on Ubuntu and \
                         Debian', updated 2023-12-19).",
                    ));
                    out.push(on(
                        At::Computer,
                        "put the file where it serves",
                        format!("sudo cp {filename} /srv/tftp/"),
                        "The folder tftpd-hpa serves unless /etc/default/tftpd-hpa says otherwise.",
                    ));
                }
                Os::Windows => out.push(on(
                    At::Computer,
                    "start a TFTP server",
                    "",
                    "Run a TFTP server on this computer and put the file in the folder it \
                     serves. Fathom names no TFTP server for Windows; whether Windows ships one \
                     could not be established.",
                )),
            }
            out.push(copy);
            out.push(match os {
                Os::Linux => on(
                    At::Computer,
                    "and stop the server",
                    "sudo systemctl stop tftpd-hpa",
                    "Nothing guards what it serves, so it runs only while the copy does.",
                ),
                Os::Windows => on(
                    At::Computer,
                    "and stop the server",
                    "",
                    "Nothing guards what it serves, so it runs only while the copy does.",
                ),
            });
            Some(out)
        }
    }
}

/// The `by_hand` answer for an image: each way the file can get onto the device without
/// Fathom, with Windows and Linux steps, or `Null` for a platform with no steps written.
/// A way the vendor's pages do not document for the platform is left out and named in
/// `could_not_establish`.
pub fn by_hand(family: Family, filename: &str) -> Json {
    let Some(r) = route(family, filename) else {
        return Json::Null;
    };
    let mut gaps = vec![
        "whether Windows 10 and 11 ship with the OpenSSH Client installed (Microsoft's table \
         lists Windows 10 1809 and later as 'not installed, install using optional features')",
    ];
    gaps.extend(r.could_not_establish.iter().copied());
    if usb_copy(family, filename).is_none() {
        gaps.push("a USB copy command for this platform, from the vendor's pages");
    }
    if tftp_copy(family, filename).is_none() {
        gaps.push("a TFTP copy command for this platform, from the vendor's pages");
    }
    let ways = [
        (Way::Scp, "scp", "Over SSH", None),
        (Way::Usb, "usb", "USB stick", None),
        (Way::Tftp, "tftp", "TFTP (old way)", Some(TFTP_WARNING)),
    ]
    .into_iter()
    .filter_map(|(way, key, label, warning)| {
        let windows = way_steps(way, Os::Windows, family, filename, &r)?;
        let linux = way_steps(way, Os::Linux, family, filename, &r)?;
        let mut w = BTreeMap::new();
        w.insert("way".to_string(), Json::Str(key.to_string()));
        w.insert("label".to_string(), Json::Str(label.to_string()));
        w.insert(
            "warning".to_string(),
            warning.map_or(Json::Null, |t: &str| Json::Str(t.to_string())),
        );
        w.insert("windows".to_string(), to_json(windows));
        w.insert("linux".to_string(), to_json(linux));
        Some(Json::Obj(w))
    })
    .collect();
    let mut m = BTreeMap::new();
    m.insert("ways".to_string(), Json::Arr(ways));
    m.insert(
        "replaces_step".to_string(),
        Json::Str("have the device pull the image".to_string()),
    );
    m.insert(
        "sourced_note".to_string(),
        Json::Str(
            "Read on 2026-10-25: \
             https://www.cisco.com/c/en/us/support/docs/security-vpn/secure-shell-ssh/215450-copy-cisco-ios-images-from-pc-to-router.html ; \
             https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/222280-upgrading-catalyst-9300-switches.html ; \
             https://developer.cisco.com/docs/cisco-nexus-3000-and-9000-series-nx-api-rest-sdk-user-guide-and-api-reference/latest/configuring-ssh ; \
             https://developer.cisco.com/docs/cisco-nexus-3000-and-9000-series-nx-api-rest-sdk-user-guide-and-api-reference/latest/copying-file-to-bootflash ; \
             https://www.arista.com/en/um-eos/eos-standard-upgrades-and-downgrades ; \
             https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/get-filehash ; \
             https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview ; \
             https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse ; \
             https://www.rfc-editor.org/rfc/rfc1350 ; \
             https://www.tecmint.com/install-tftp-server-on-ubuntu-debian/ (third-party). \
             The scp -O trap and the Junos login classes are from ADR-0045 (2026-09-14). \
             docs/UPGRADING-A-JUNIPER.md and docs/UPGRADING-A-CISCO-OR-ARISTA.md have the prose."
                .to_string(),
        ),
    );
    m.insert(
        "could_not_establish".to_string(),
        Json::Arr(gaps.into_iter().map(|g| Json::Str(g.to_string())).collect()),
    );
    Json::Obj(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field<'a>(j: &'a Json, key: &str) -> &'a Json {
        let Json::Obj(m) = j else {
            panic!("not an object: {j:?}")
        };
        m.get(key).unwrap_or_else(|| panic!("no {key}"))
    }

    fn text(j: &Json) -> &str {
        let Json::Str(s) = j else {
            panic!("not a string: {j:?}")
        };
        s
    }

    /// (at, command) for each step of one OS.
    fn steps(j: &Json, os: &str) -> Vec<(String, String)> {
        let Json::Arr(items) = field(j, os) else {
            panic!("{os} is not an array")
        };
        items
            .iter()
            .enumerate()
            .map(|(i, s)| {
                assert_eq!(field(s, "order"), &Json::Int(i as i64 + 1));
                assert_eq!(text(field(s, "run_by")), "operator");
                assert!(!text(field(s, "note")).is_empty(), "every step says why");
                (
                    text(field(s, "at")).to_string(),
                    text(field(s, "command")).to_string(),
                )
            })
            .collect()
    }

    /// The way with this key, or None when the platform has no steps for it.
    fn way<'a>(j: &'a Json, key: &str) -> Option<&'a Json> {
        let Json::Arr(ways) = field(j, "ways") else {
            panic!("ways is not an array")
        };
        ways.iter().find(|w| text(field(w, "way")) == key)
    }

    fn scp(j: &Json) -> &Json {
        way(j, "scp").expect("every written platform has an SSH way")
    }

    const FAMILIES: [Family; 4] = [Family::Junos, Family::IosXe, Family::NxOs, Family::Eos];

    #[test]
    fn every_route_checks_the_hash_on_the_computer_before_anything_crosses() {
        for family in FAMILIES {
            let j = by_hand(family, "img.bin");
            for os in ["windows", "linux"] {
                let s = steps(scp(&j), os);
                assert_eq!(s[0].0, "computer", "{os}");
                let hash = &s[0].1;
                assert!(
                    hash.starts_with("Get-FileHash .\\img.bin") || hash.ends_with("sum img.bin"),
                    "{os}: {hash}"
                );
                assert!(
                    s.iter().any(|(_, c)| c.contains("img.bin") && c != hash),
                    "{os}: a copy step names the file: {s:?}"
                );
            }
        }
    }

    /// The trap ADR-0045 found: plain scp speaks SFTP since OpenSSH 9.0.
    #[test]
    fn every_push_uses_scp_dash_o_and_names_no_real_login() {
        for family in [Family::Junos, Family::IosXe, Family::NxOs] {
            let j = by_hand(family, "img.bin");
            for os in ["windows", "linux"] {
                let copy: Vec<_> = steps(scp(&j), os)
                    .into_iter()
                    .filter(|(_, c)| c.starts_with("scp"))
                    .collect();
                assert_eq!(copy.len(), 1, "{os}");
                assert!(copy[0].1.starts_with("scp -O "), "{os}: {}", copy[0].1);
                assert!(copy[0].1.contains("<you>@<device address>:"), "{os}");
            }
        }
    }

    /// What a Cisco switch is opened for is closed again, after the copy.
    #[test]
    fn a_file_server_turned_on_is_turned_off_after_the_copy() {
        for (family, on) in [
            (Family::IosXe, "ip scp server enable"),
            (Family::NxOs, "feature scp-server"),
        ] {
            let j = by_hand(family, "img.bin");
            let s = steps(scp(&j), "linux");
            let at = |c: &str| s.iter().position(|(_, x)| x == c).expect(c);
            let copy = s.iter().position(|(_, c)| c.starts_with("scp")).unwrap();
            let off = format!("no {on}");
            assert!(at(on) < copy && copy < at(&off), "{s:?}");
            assert_eq!(s[at(on)].0, "device");
        }
    }

    /// Arista documents the switch pulling, so the computer serves and the switch copies.
    #[test]
    fn arista_turns_the_route_around() {
        let j = by_hand(Family::Eos, "EOS.swi");
        let s = steps(scp(&j), "windows");
        assert!(s.iter().all(|(_, c)| !c.starts_with("scp")), "{s:?}");
        let pull = s
            .iter()
            .find(|(_, c)| c.starts_with("copy scp://"))
            .unwrap();
        assert_eq!(pull.0, "device");
        assert!(pull.1.ends_with("flash:/EOS.swi"));
    }

    #[test]
    fn ios_xe_hashes_what_cisco_publishes() {
        let j = by_hand(Family::IosXe, "cat9k.bin");
        assert_eq!(steps(scp(&j), "linux")[0].1, "sha512sum cat9k.bin");
        assert_eq!(
            steps(scp(&j), "windows")[0].1,
            "Get-FileHash .\\cat9k.bin -Algorithm SHA512"
        );
        let j = by_hand(Family::Junos, "j.tgz");
        assert_eq!(steps(scp(&j), "linux")[0].1, "sha256sum j.tgz");
    }

    #[test]
    fn it_names_its_sources_and_what_it_could_not_establish() {
        for family in FAMILIES {
            let j = by_hand(family, "img.bin");
            let note = text(field(&j, "sourced_note"));
            assert!(note.contains("2026-10-25") && note.contains("https://www.cisco.com"));
            let Json::Arr(gaps) = field(&j, "could_not_establish") else {
                panic!("not an array")
            };
            assert!(gaps.len() >= 2);
        }
        assert_eq!(by_hand(Family::Unknown, "img.bin"), Json::Null);
    }

    /// USB and TFTP appear only where the vendor's pages give the command, and say so
    /// where they do not.
    #[test]
    fn usb_and_tftp_only_where_a_vendor_page_gives_the_command() {
        let has = |f, k| way(&by_hand(f, "img.bin"), k).is_some();
        assert!(has(Family::IosXe, "usb") && has(Family::Eos, "usb"));
        assert!(!has(Family::Junos, "usb") && !has(Family::NxOs, "usb"));
        assert!(has(Family::IosXe, "tftp") && has(Family::NxOs, "tftp"));
        assert!(!has(Family::Junos, "tftp") && !has(Family::Eos, "tftp"));
        let j = by_hand(Family::Junos, "img.bin");
        let Json::Arr(gaps) = field(&j, "could_not_establish") else {
            panic!("not an array")
        };
        let gaps: Vec<_> = gaps.iter().map(text).collect();
        assert!(gaps.iter().any(|g| g.starts_with("a USB copy command")));
        assert!(gaps.iter().any(|g| g.starts_with("a TFTP copy command")));
    }

    /// TFTP is shown with its warning, and the server is stopped after the copy.
    #[test]
    fn tftp_carries_its_warning_and_stops_the_server_after() {
        let j = by_hand(Family::IosXe, "cat9k.bin");
        let t = way(&j, "tftp").unwrap();
        assert!(text(field(t, "warning")).contains("RFC 1350"));
        assert_eq!(field(scp(&j), "warning"), &Json::Null);
        for os in ["windows", "linux"] {
            let s = steps(t, os);
            let pull = s
                .iter()
                .position(|(_, c)| c.starts_with("copy tftp://"))
                .unwrap();
            assert_eq!(s[pull].0, "device");
            assert_eq!(s.last().unwrap().0, "computer", "{os}: stop comes last");
            assert!(pull < s.len() - 1);
        }
        let usb = steps(way(&j, "usb").unwrap(), "linux");
        assert_eq!(usb.last().unwrap().1, "copy usbflash0:cat9k.bin flash:");
    }
}

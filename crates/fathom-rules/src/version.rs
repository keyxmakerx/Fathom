//! `version_older(platform, have, want)`: is the version a device runs older than another,
//! under the platform's own numbering scheme?
//!
//! The answer is `Some(bool)` only when both strings parse under a scheme this module can
//! source, and the order is settled by the numbers. Anything else is `None` (the VM turns it
//! into null, so the rule does not fire): claim nothing rather than guess. Two versions that
//! tie on every number but differ in a trailing letter are also `None`, because no vendor
//! page read for this module states how those letters order.
//!
//! Sources (each read 2026-10-10; where a page did not say, that is stated):
//! - junos: Juniper, "Junos OS Installation and Upgrade Overview", section "Junos OS Release
//!   Numbers", via https://juniper.net/documentation/us/en/software/junos/srx-upgrade/topics/concept/upgrade-paths.html
//!   (as returned by the fetch): `m.nZb.s`, main, minor, type, build, spin; R = first
//!   revenue ship or maintenance; S = service release, numbered after the R (24.2R2-S1.4).
//!   Junos OS Evolved: https://www.juniper.net/documentation/us/en/software/junos/evo-install-upgrade/topics/concept/evo-installation-packages.html
//!   (`m.nZb.s-EVO`, "-EVO means that it is a Junos OS Evolved package"). COULD NOT ESTABLISH
//!   the X and D forms (20.4X53-D10): the page says only that X "follows a numbering system
//!   that differs" and points to Juniper KB30092, which would not load. F, B, I types are not
//!   explained either. All of those are `None`.
//! - iosxe: Cisco, "Software Lifecycle Support Statement - IOS XE", updated April 10, 2026,
//!   https://www.cisco.com/c/en/us/products/collateral/ios-nx-os-software/ios-xe-16/bulletin-c25-2378701.html
//!   : three numbers (year-or-major, minor, maintenance) and an optional lowercase letter
//!   "special release identifier". The page's examples use the 2026 numbers; 17.9.4a and
//!   16.12.10 have the same shape. How letters order is not stated.
//! - nxos: Cisco, "Cisco NX-OS Software Lifecycle Support Statement" (guide c07-658595, 08/24),
//!   https://cisco.com/c/en/us/products/collateral/ios-nx-os-software/nx-os-software/guide_c07-658595.html
//!   : "A.B(C)x", x = F feature or M maintenance (10.5(1)F, 10.5(4)M). The letter inside the
//!   parentheses (10.3(4a)M appears in Cisco's release-note list) is not explained there.
//! - eos: Arista, "EOS Life Cycle Policy", https://www.arista.com/en/support/product-documentation/eos-life-cycle-policy
//!   (read 2026-10-10): F = new features, M = maintenance. Arista never states the digit
//!   layout; four-part versions (4.18.4.2F, 4.17.5.1M) appear in Arista security advisory
//!   3577, https://www.arista.com/en/support/advisories-notices/security-advisory/3577-security-advisory-30
//!   so up to four numbers are read, a missing fourth as 0. Suffixes like `FX-MDP` are `None`.

use std::cmp::Ordering;

/// Platform id to version scheme. A test holds this against `schema/platforms.yaml`.
pub const SCHEMES: [(&str, &str); 6] = [
    ("junos-srx", "junos"),
    ("junos-mx", "junos"),
    ("junos-ex", "junos"),
    ("ios-xe", "iosxe"),
    ("nx-os", "nxos"),
    ("eos", "eos"),
];

/// The schemes this module can compare.
pub const KNOWN_SCHEMES: [&str; 4] = ["junos", "iosxe", "nxos", "eos"];

/// A parsed version: the numbers that order it, and a tag that must match for a tie to mean
/// anything (trailing letters, release type, product).
struct Parsed {
    nums: Vec<u64>,
    tag: String,
    /// The tag names the product, so a mismatch settles nothing, not even when numbers differ.
    product: bool,
}

pub fn older(platform: &str, have: &str, want: &str) -> Option<bool> {
    let scheme = SCHEMES.iter().find(|(p, _)| *p == platform)?.1;
    let parse = match scheme {
        "junos" => junos,
        "iosxe" => iosxe,
        "nxos" => nxos,
        "eos" => eos,
        _ => return None,
    };
    let (a, b) = (parse(have.trim())?, parse(want.trim())?);
    if a.product && a.tag != b.tag {
        return None;
    }
    match a.nums.cmp(&b.nums) {
        Ordering::Less => Some(true),
        Ordering::Greater => Some(false),
        Ordering::Equal if a.tag == b.tag => Some(false),
        Ordering::Equal => None,
    }
}

/// One run of ASCII digits, no sign, no padding games; `None` if empty or too large.
fn num(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 9 || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// `m.nRb[.s][-Sk[.s]][-EVO]`. Only R releases. The tag is the product (OS or Evolved), so an
/// Evolved version is never ordered against a Junos OS one.
fn junos(v: &str) -> Option<Parsed> {
    let (v, evo) = match v.strip_suffix("-EVO") {
        Some(rest) => (rest, true),
        None => (v, false),
    };
    let (base, svc) = match v.split_once("-S") {
        Some((b, s)) => (b, Some(s)),
        None => (v, None),
    };
    let (mn, rest) = base.split_once('R')?;
    let (m, n) = mn.split_once('.')?;
    let (build, spin) = match rest.split_once('.') {
        Some((b, s)) => (b, Some(s)),
        None => (rest, None),
    };
    // The spin belongs to the last component written: the S release if there is one.
    let (s_num, last_spin) = match svc {
        None => (0, spin),
        Some(s) => {
            if spin.is_some() {
                return None;
            }
            match s.split_once('.') {
                Some((k, sp)) => (num(k)?, Some(sp)),
                None => (num(s)?, None),
            }
        }
    };
    let spin = match last_spin {
        Some(s) => num(s)?,
        None => 0,
    };
    Some(Parsed {
        nums: vec![num(m)?, num(n)?, num(build)?, s_num, spin],
        tag: if evo { "evo" } else { "os" }.to_owned(),
        product: true,
    })
}

/// `A.B.C` and an optional lowercase letter run.
fn iosxe(v: &str) -> Option<Parsed> {
    let end = v.find(|c: char| c.is_ascii_lowercase()).unwrap_or(v.len());
    let (digits, letters) = v.split_at(end);
    if !letters.bytes().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    let parts: Vec<&str> = digits.split('.').collect();
    let [a, b, c] = parts[..] else { return None };
    Some(Parsed {
        nums: vec![num(a)?, num(b)?, num(c)?],
        tag: letters.to_owned(),
        product: false,
    })
}

/// `A.B(C[letters])[F|M]`.
fn nxos(v: &str) -> Option<Parsed> {
    let (ab, rest) = v.split_once('(')?;
    let (inner, kind) = rest.split_once(')')?;
    if !matches!(kind, "" | "F" | "M") {
        return None;
    }
    let (a, b) = ab.split_once('.')?;
    let end = inner
        .find(|c: char| c.is_ascii_lowercase())
        .unwrap_or(inner.len());
    let (c, letters) = inner.split_at(end);
    if !letters.bytes().all(|x| x.is_ascii_lowercase()) {
        return None;
    }
    Some(Parsed {
        nums: vec![num(a)?, num(b)?, num(c)?],
        tag: format!("{letters}/{kind}"),
        product: false,
    })
}

/// `A.B.C[.D][F|M]`.
fn eos(v: &str) -> Option<Parsed> {
    let (digits, kind) = match v.strip_suffix(['F', 'M']) {
        Some(d) => (d, &v[d.len()..]),
        None => (v, ""),
    };
    let parts: Vec<&str> = digits.split('.').collect();
    if !(3..=4).contains(&parts.len()) {
        return None;
    }
    let mut nums = Vec::new();
    for p in &parts {
        nums.push(num(p)?);
    }
    if nums.len() == 3 {
        nums.push(0);
    }
    Some(Parsed {
        nums,
        tag: kind.to_owned(),
        product: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junos_orders_releases_services_and_spins() {
        let o = |a, b| older("junos-srx", a, b);
        assert_eq!(o("21.4R3-S5", "21.4R3-S6"), Some(true));
        assert_eq!(o("21.4R3-S5", "21.4R3-S5"), Some(false));
        assert_eq!(o("21.4R3", "21.4R3-S1"), Some(true));
        assert_eq!(o("21.4R3-S1", "21.4R4"), Some(true));
        assert_eq!(o("23.4R2-S3.9", "23.4R2-S3.10"), Some(true));
        assert_eq!(o("23.4R2-S3.9", "23.4R2-S4"), Some(true));
        assert_eq!(o("22.2R1", "21.4R9-S9"), Some(false));
        assert_eq!(o("9.4R1", "10.0R1"), Some(true));
        assert_eq!(o("24.2R1.13", "24.2R1.14"), Some(true));
        assert_eq!(o("21.1R3-EVO", "21.1R4-EVO"), Some(true));
        assert_eq!(o("21.1R3-EVO", "21.1R4"), None);
    }

    #[test]
    fn junos_forms_that_could_not_be_sourced_are_null() {
        let o = |a, b| older("junos-ex", a, b);
        assert_eq!(o("20.4X53-D10", "20.4X53-D20"), None);
        assert_eq!(o("15.1F6-S10", "15.1F6-S11"), None);
        assert_eq!(o("21.4R3-S5.1.2", "21.4R4"), None);
        assert_eq!(o("21.4R3.1-S5", "21.4R4"), None);
        assert_eq!(o("", "21.4R4"), None);
        assert_eq!(o("junos", "21.4R4"), None);
        assert_eq!(o("21.4R-S5", "21.4R4"), None);
    }

    #[test]
    fn iosxe_orders_numbers_and_leaves_letters_alone() {
        let o = |a, b| older("ios-xe", a, b);
        assert_eq!(o("16.12.10", "17.9.4a"), Some(true));
        assert_eq!(o("17.9.4a", "17.9.5"), Some(true));
        assert_eq!(o("17.9.10", "17.9.9"), Some(false));
        assert_eq!(o("17.9.4a", "17.9.4a"), Some(false));
        assert_eq!(o("17.9.4", "17.9.4a"), None);
        assert_eq!(o("3.16.2S", "17.9.4"), None);
        assert_eq!(o("17.9", "17.9.4"), None);
    }

    #[test]
    fn nxos_orders_train_and_sequence() {
        let o = |a, b| older("nx-os", a, b);
        assert_eq!(o("9.3(10)", "10.3(4a)"), Some(true));
        assert_eq!(o("10.3(4a)", "10.4(1)F"), Some(true));
        assert_eq!(o("10.3(4a)M", "10.3(5)M"), Some(true));
        assert_eq!(o("9.3(9)", "9.3(10)"), Some(true));
        assert_eq!(o("10.4(1)F", "10.3(4a)"), Some(false));
        assert_eq!(o("10.3(4a)", "10.3(4a)"), Some(false));
        assert_eq!(o("10.3(4)", "10.3(4a)"), None);
        assert_eq!(o("10.3(4a)M", "10.3(4a)"), None);
        assert_eq!(o("7.0(3)I7(4)", "10.3(4a)"), None);
        assert_eq!(o("10.3", "10.4(1)F"), None);
    }

    #[test]
    fn eos_orders_up_to_four_numbers() {
        let o = |a, b| older("eos", a, b);
        assert_eq!(o("4.30.2F", "4.31.1.1M"), Some(true));
        assert_eq!(o("4.31.1.1M", "4.31.1.2M"), Some(true));
        assert_eq!(o("4.30.2F", "4.30.2.1F"), Some(true));
        assert_eq!(o("4.31.1.1M", "4.30.9F"), Some(false));
        assert_eq!(o("4.30.2F", "4.30.2F"), Some(false));
        assert_eq!(o("4.30.2F", "4.30.2M"), None);
        assert_eq!(o("4.17.1.1FX-MDP", "4.30.2F"), None);
        assert_eq!(o("4.30F", "4.30.2F"), None);
    }

    #[test]
    fn unknown_platform_or_scheme_is_null() {
        assert_eq!(older("panos", "10.1.1", "10.2.0"), None);
        assert_eq!(older("", "1.0.0", "2.0.0"), None);
        assert_eq!(older("eos", "4.30.2F", ""), None);
    }

    /// The table above is a copy of `version_scheme` in schema/platforms.yaml; this is where
    /// a disagreement is caught.
    #[test]
    fn table_agrees_with_platforms_yaml() {
        use fathom_schema::subset::{parse_profile, Profile};
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/platforms.yaml");
        let text = std::fs::read_to_string(path).unwrap();
        let root = parse_profile(&text, Profile::Schema).unwrap();
        let platforms = root.get("platforms").and_then(|n| n.as_map()).unwrap();
        for (id, row) in platforms {
            let scheme = row.get("version_scheme").and_then(|n| n.as_str()).unwrap();
            let ours = SCHEMES.iter().find(|(p, _)| p == id).map(|(_, s)| *s);
            if KNOWN_SCHEMES.contains(&scheme) {
                assert_eq!(ours, Some(scheme), "{id}: platforms.yaml says {scheme}");
            } else {
                assert_eq!(
                    ours, None,
                    "{id}: the table names a scheme platforms.yaml does not"
                );
            }
        }
        for (p, s) in SCHEMES {
            assert!(
                platforms.iter().any(|(id, _)| id == p),
                "{p} is not in platforms.yaml"
            );
            assert!(KNOWN_SCHEMES.contains(&s));
        }
    }
}

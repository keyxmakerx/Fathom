//! What the reader reads, by purpose: a fixed list of object identifiers each (ADR-0082 §4.1). No
//! full walk, so tables that describe credentials (`usmUserTable`, community tables) are never
//! asked for. A job names purposes; a name this reader does not know is refused, so new purposes
//! can be added later without changing the job's version.
//!
//! Every identifier below was resolved on 2026-11-02 from the MIB modules themselves: SNMPv2-MIB
//! (RFC 3418), IF-MIB (RFC 2863) and IP-MIB (RFC 4293) and BRIDGE-MIB (RFC 4188) from net-snmp's
//! `mibs/`; ENTITY-MIB (RFC 6933), LLDP-MIB (IEEE 802.1AB-2005) and Q-BRIDGE-MIB (RFC 4363) from
//! LibreNMS's `mibs/`.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value as Json};

use crate::ber::Value;
use crate::snmp::{fail, ReadError, ReadPdu, Session};

/// The purposes this reader knows, in the order it reads them.
pub const KNOWN: &[&str] = &["system", "inventory", "interfaces", "lldp", "mac", "arp"];

/// The most rows taken from one table, so an answer always fits one frame. A table cut short is
/// named in the answer's `incomplete`.
pub const MAX_ROWS: usize = 4000;

// SNMPv2-MIB, system group: mib-2 1.
const SYS_DESCR: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 1, 0];
const SYS_OBJECT_ID: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 2, 0];
const SYS_UPTIME: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 3, 0];
const SYS_NAME: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 5, 0];

// ENTITY-MIB entPhysicalEntry: mib-2 47 1 1 1 1, then the column.
const ENT: [u32; 11] = [1, 3, 6, 1, 2, 1, 47, 1, 1, 1, 1];
const ENT_COLUMNS: &[(u32, &str)] = &[
    (2, "descr"),
    (4, "containedIn"),
    (5, "class"),
    (7, "name"),
    (8, "hardwareRev"),
    (9, "firmwareRev"),
    (10, "softwareRev"),
    (11, "serial"),
    (12, "mfgName"),
    (13, "modelName"),
];

// IF-MIB ifEntry (mib-2 2 2 1) and ifXEntry (mib-2 31 1 1 1).
const IF_ENTRY: [u32; 9] = [1, 3, 6, 1, 2, 1, 2, 2, 1];
const IFX_ENTRY: [u32; 10] = [1, 3, 6, 1, 2, 1, 31, 1, 1, 1];
const IF_COLUMNS: &[(bool, u32, &str)] = &[
    (false, 2, "descr"),
    (false, 3, "type"),
    (false, 6, "mac"),
    (false, 7, "adminStatus"),
    (false, 8, "operStatus"),
    (true, 1, "name"),
    (true, 15, "speedMbps"),
    (true, 18, "alias"),
];

// LLDP-MIB: lldpMIB is 1.0.8802.1.1.2; lldpLocPortEntry 1 3 7 1, lldpRemEntry 1 4 1 1.
const LLDP_LOC_PORT: [u32; 10] = [1, 0, 8802, 1, 1, 2, 1, 3, 7, 1];
const LLDP_LOC_COLUMNS: &[(u32, &str)] = &[(3, "portId"), (4, "portDesc")];
const LLDP_REM: [u32; 10] = [1, 0, 8802, 1, 1, 2, 1, 4, 1, 1];
const LLDP_REM_COLUMNS: &[(u32, &str)] = &[
    (4, "chassisIdSubtype"),
    (5, "chassisId"),
    (6, "portIdSubtype"),
    (7, "portId"),
    (8, "portDesc"),
    (9, "sysName"),
    (12, "capEnabled"),
];

// BRIDGE-MIB: dot1dBridge is mib-2 17. dot1dBasePortIfIndex 1 4 1 2; dot1dTpFdbPort 4 3 1 2 and
// dot1dTpFdbStatus 4 3 1 3, indexed by the MAC. Q-BRIDGE-MIB (dot1dBridge 7): dot1qTpFdbPort
// 1 2 2 1 2 and dot1qTpFdbStatus 1 2 2 1 3, indexed by the filtering database id and the MAC.
const BASE_PORT_IFINDEX: [u32; 11] = [1, 3, 6, 1, 2, 1, 17, 1, 4, 1, 2];
const FDB_PORT: [u32; 11] = [1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 2];
const FDB_STATUS: [u32; 11] = [1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 3];
const QFDB_PORT: [u32; 13] = [1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 2];
const QFDB_STATUS: [u32; 13] = [1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 3];

// IP-MIB: ipNetToPhysicalPhysAddress (mib-2 4 35 1 4) and ipNetToPhysicalType (4 35 1 6),
// indexed by ifIndex, address type and the length-prefixed address; the older
// ipNetToMediaPhysAddress (4 22 1 2) and ipNetToMediaType (4 22 1 4), by ifIndex and IPv4.
const NET_PHYS_ADDR: [u32; 10] = [1, 3, 6, 1, 2, 1, 4, 35, 1, 4];
const NET_PHYS_TYPE: [u32; 10] = [1, 3, 6, 1, 2, 1, 4, 35, 1, 6];
const NET_MEDIA_ADDR: [u32; 10] = [1, 3, 6, 1, 2, 1, 4, 22, 1, 2];
const NET_MEDIA_TYPE: [u32; 10] = [1, 3, 6, 1, 2, 1, 4, 22, 1, 4];

/// Text a device holds, as text when it is printable, else as `hex:` and its octets.
pub fn text(b: &[u8]) -> String {
    // Some devices end a string with NUL octets; those alone do not make it binary.
    let end = b.iter().rposition(|x| *x != 0).map_or(0, |i| i + 1);
    match std::str::from_utf8(&b[..end]) {
        Ok(s) if !s.chars().any(|c| c.is_control() && c != '\t') => s.to_string(),
        _ => format!(
            "hex:{}",
            b.iter().map(|x| format!("{x:02x}")).collect::<String>()
        ),
    }
}

/// Six octets as a MAC address; anything else as [`text`].
pub fn mac(b: &[u8]) -> String {
    if b.len() == 6 {
        b.iter()
            .map(|x| format!("{x:02x}"))
            .collect::<Vec<_>>()
            .join(":")
    } else {
        text(b)
    }
}

fn dotted(arcs: &[u32]) -> String {
    arcs.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

fn json_of(v: &Value) -> Json {
    match v {
        Value::Integer(i) => json!(i),
        Value::Octets(b) | Value::Opaque(b) => json!(text(b)),
        Value::Oid(o) => json!(dotted(o)),
        Value::IpAddress(a) => json!(dotted(&a.map(u32::from))),
        Value::Counter32(n) | Value::Gauge32(n) | Value::TimeTicks(n) => json!(n),
        Value::Counter64(n) => json!(n),
        Value::Null | Value::NoSuchObject | Value::NoSuchInstance | Value::EndOfMibView => {
            Json::Null
        }
    }
}

/// One column's rows: the index after the column's identifier, and the value.
pub type Column = Vec<(Vec<u32>, Value)>;

/// Every row of one column: the index after `base`, and its value. `true` when cut short.
pub fn walk(s: &mut Session, base: &[u32]) -> Result<(Column, bool), ReadError> {
    let mut cur = base.to_vec();
    let mut out = Vec::new();
    let mut reps = 25u32;
    loop {
        if out.len() >= MAX_ROWS {
            return Ok((out, true));
        }
        let got = match s.request(
            ReadPdu::GetBulk {
                max_repetitions: reps,
            },
            &[&cur],
        ) {
            Err(e) if e.code == "too_big" && reps > 1 => {
                reps /= 2;
                continue;
            }
            other => other?,
        };
        if got.is_empty() {
            return Ok((out, false));
        }
        for (oid, v) in got {
            if !oid.starts_with(base) || matches!(v, Value::EndOfMibView | Value::NoSuchObject) {
                return Ok((out, false));
            }
            if oid <= cur {
                return Err(fail("malformed", "the device's table did not move forward"));
            }
            out.push((oid[base.len()..].to_vec(), v));
            cur = oid;
            if out.len() >= MAX_ROWS {
                return Ok((out, true));
            }
        }
    }
}

fn column(base: &[u32], col: u32) -> Vec<u32> {
    let mut v = base.to_vec();
    v.push(col);
    v
}

type Rows = BTreeMap<Vec<u32>, Map<String, Json>>;

/// A column to walk, the key it is stored under, and how its value is shown.
type ColumnSpec<'a> = (Vec<u32>, &'a str, fn(&Value) -> Json);

/// Walks several columns of one table and joins them by index.
fn table(s: &mut Session, columns: &[ColumnSpec<'_>], cut: &mut bool) -> Result<Rows, ReadError> {
    let mut rows = Rows::new();
    for (base, name, conv) in columns {
        let (got, short) = walk(s, base)?;
        *cut |= short;
        for (index, v) in got {
            rows.entry(index)
                .or_default()
                .insert((*name).to_string(), conv(&v));
        }
    }
    Ok(rows)
}

fn as_mac(v: &Value) -> Json {
    match v {
        Value::Octets(b) => json!(mac(b)),
        other => json_of(other),
    }
}

fn index_number(index: &[u32]) -> Json {
    match index {
        [one] => json!(one),
        many => json!(dotted(many)),
    }
}

/// One purpose's reading. `cut` is set when a table stopped at [`MAX_ROWS`].
pub fn read(s: &mut Session, purpose: &str, cut: &mut bool) -> Result<Json, ReadError> {
    match purpose {
        "system" => {
            let got = s.request(
                ReadPdu::Get,
                &[SYS_DESCR, SYS_OBJECT_ID, SYS_UPTIME, SYS_NAME],
            )?;
            let mut m = Map::new();
            for (oid, v) in got {
                let key = match oid.as_slice() {
                    o if o == SYS_DESCR => "descr",
                    o if o == SYS_OBJECT_ID => "objectId",
                    o if o == SYS_UPTIME => "uptimeTicks",
                    o if o == SYS_NAME => "name",
                    _ => continue,
                };
                m.insert(key.into(), json_of(&v));
            }
            Ok(Json::Object(m))
        }
        "inventory" => {
            let cols: Vec<_> = ENT_COLUMNS
                .iter()
                .map(|(c, n)| (column(&ENT, *c), *n, json_of as fn(&Value) -> Json))
                .collect();
            Ok(rows_to_list(table(s, &cols, cut)?, "index"))
        }
        "interfaces" => {
            let cols: Vec<_> = IF_COLUMNS
                .iter()
                .map(|(x, c, n)| {
                    let conv: fn(&Value) -> Json = if *n == "mac" { as_mac } else { json_of };
                    (
                        column(if *x { &IFX_ENTRY[..] } else { &IF_ENTRY[..] }, *c),
                        *n,
                        conv,
                    )
                })
                .collect();
            Ok(rows_to_list(table(s, &cols, cut)?, "index"))
        }
        "lldp" => {
            let loc: Vec<_> = LLDP_LOC_COLUMNS
                .iter()
                .map(|(c, n)| {
                    (
                        column(&LLDP_LOC_PORT, *c),
                        *n,
                        json_of as fn(&Value) -> Json,
                    )
                })
                .collect();
            let rem: Vec<_> = LLDP_REM_COLUMNS
                .iter()
                .map(|(c, n)| {
                    let conv: fn(&Value) -> Json = match *n {
                        "chassisId" | "portId" => lldp_id,
                        "capEnabled" => capabilities,
                        _ => json_of,
                    };
                    (column(&LLDP_REM, *c), *n, conv)
                })
                .collect();
            let local = rows_to_list(table(s, &loc, cut)?, "portNum");
            // lldpRemEntry is indexed by lldpRemTimeMark, lldpRemLocalPortNum, lldpRemIndex.
            let mut remote = Vec::new();
            for (index, mut row) in table(s, &rem, cut)? {
                if let [_, port, idx] = index.as_slice() {
                    row.insert("localPortNum".into(), json!(port));
                    row.insert("index".into(), json!(idx));
                    remote.push(Json::Object(row));
                }
            }
            Ok(json!({"local": local, "remote": remote}))
        }
        "mac" => read_mac(s, cut),
        "arp" => read_arp(s, cut),
        other => Err(fail("refused", format!("unknown purpose {other}"))),
    }
}

/// LLDP ids are often a MAC (subtype 4 for a chassis, 3 for a port) and otherwise text.
fn lldp_id(v: &Value) -> Json {
    match v {
        Value::Octets(b) if b.len() == 6 => json!(mac(b)),
        other => json_of(other),
    }
}

/// LldpSystemCapabilitiesMap, a BITS string: bit 0 is the most significant bit of the first
/// octet. The names are LLDP-MIB's: other(0), repeater(1), bridge(2), wlanAccessPoint(3),
/// router(4), telephone(5), docsisCableDevice(6), stationOnly(7).
fn capabilities(v: &Value) -> Json {
    const NAMES: [&str; 8] = [
        "other",
        "repeater",
        "bridge",
        "wlanAccessPoint",
        "router",
        "telephone",
        "docsisCableDevice",
        "stationOnly",
    ];
    match v {
        Value::Octets(b) => {
            let first = b.first().copied().unwrap_or(0);
            json!(NAMES
                .iter()
                .enumerate()
                .filter(|(i, _)| first & (0x80 >> i) != 0)
                .map(|(_, n)| *n)
                .collect::<Vec<_>>())
        }
        other => json_of(other),
    }
}

fn rows_to_list(rows: Rows, key: &str) -> Json {
    Json::Array(
        rows.into_iter()
            .map(|(index, mut row)| {
                row.insert(key.into(), index_number(&index));
                Json::Object(row)
            })
            .collect(),
    )
}

fn mac_of_index(index: &[u32]) -> Option<String> {
    let b: Vec<u8> = index
        .iter()
        .map(|x| u8::try_from(*x).ok())
        .collect::<Option<_>>()?;
    (b.len() == 6).then(|| mac(&b))
}

/// Forwarding tables: Q-BRIDGE first (per VLAN), BRIDGE when a device has no Q-BRIDGE.
fn read_mac(s: &mut Session, cut: &mut bool) -> Result<Json, ReadError> {
    let (ports, short) = walk(s, &BASE_PORT_IFINDEX)?;
    *cut |= short;
    let if_index: BTreeMap<u32, Json> = ports
        .into_iter()
        .filter_map(|(i, v)| Some((*i.first()?, json_of(&v))))
        .collect();
    let mut entries = Vec::new();
    let (q, short) = walk(s, &QFDB_PORT)?;
    *cut |= short;
    if !q.is_empty() {
        let (status, short) = walk(s, &QFDB_STATUS)?;
        *cut |= short;
        let status: BTreeMap<_, _> = status.into_iter().collect();
        for (index, port) in q {
            let (Some(fdb), Some(m)) = (index.first(), mac_of_index(index.get(1..).unwrap_or(&[])))
            else {
                continue;
            };
            entries.push(fdb_row(m, Some(*fdb), &port, status.get(&index), &if_index));
        }
    } else {
        let (plain, short) = walk(s, &FDB_PORT)?;
        *cut |= short;
        let (status, short) = walk(s, &FDB_STATUS)?;
        *cut |= short;
        let status: BTreeMap<_, _> = status.into_iter().collect();
        for (index, port) in plain {
            let Some(m) = mac_of_index(&index) else {
                continue;
            };
            entries.push(fdb_row(m, None, &port, status.get(&index), &if_index));
        }
    }
    Ok(Json::Array(entries))
}

fn fdb_row(
    m: String,
    fdb: Option<u32>,
    port: &Value,
    status: Option<&Value>,
    if_index: &BTreeMap<u32, Json>,
) -> Json {
    let port_n = match port {
        Value::Integer(p) => u32::try_from(*p).ok(),
        _ => None,
    };
    // dot1dTpFdbStatus: other(1), invalid(2), learned(3), self(4), mgmt(5).
    let status = match status {
        Some(Value::Integer(1)) => "other",
        Some(Value::Integer(2)) => "invalid",
        Some(Value::Integer(3)) => "learned",
        Some(Value::Integer(4)) => "self",
        Some(Value::Integer(5)) => "mgmt",
        _ => "unknown",
    };
    json!({
        "mac": m,
        "fdbId": fdb,
        "bridgePort": port_n,
        "ifIndex": port_n.and_then(|p| if_index.get(&p).cloned()),
        "status": status,
    })
}

/// The ARP and neighbour table: IP-MIB's ipNetToPhysicalTable, else the older ipNetToMediaTable.
fn read_arp(s: &mut Session, cut: &mut bool) -> Result<Json, ReadError> {
    let (phys, short) = walk(s, &NET_PHYS_ADDR)?;
    *cut |= short;
    let mut out = Vec::new();
    if !phys.is_empty() {
        let (types, short) = walk(s, &NET_PHYS_TYPE)?;
        *cut |= short;
        let types: BTreeMap<_, _> = types.into_iter().collect();
        for (index, v) in phys {
            // ifIndex, InetAddressType (ipv4(1), ipv6(2)), then the address, length first.
            let [if_i, kind, len, rest @ ..] = index.as_slice() else {
                continue;
            };
            if *len as usize != rest.len() {
                continue;
            }
            let ip = match (kind, rest.len()) {
                (1, 4) => dotted(rest),
                (2, 16) => {
                    let b: Vec<u8> = rest.iter().map(|x| *x as u8).collect();
                    let a: [u8; 16] = b.try_into().unwrap_or([0; 16]);
                    std::net::Ipv6Addr::from(a).to_string()
                }
                _ => continue,
            };
            out.push(arp_row(*if_i, ip, &v, types.get(&index)));
        }
    } else {
        let (media, short) = walk(s, &NET_MEDIA_ADDR)?;
        *cut |= short;
        let (types, short) = walk(s, &NET_MEDIA_TYPE)?;
        *cut |= short;
        let types: BTreeMap<_, _> = types.into_iter().collect();
        for (index, v) in media {
            let [if_i, a, b, c, d] = index.as_slice() else {
                continue;
            };
            out.push(arp_row(
                *if_i,
                dotted(&[*a, *b, *c, *d]),
                &v,
                types.get(&index),
            ));
        }
    }
    Ok(Json::Array(out))
}

fn arp_row(if_index: u32, ip: String, phys: &Value, kind: Option<&Value>) -> Json {
    // ipNetToPhysicalType and ipNetToMediaType: other(1), invalid(2), dynamic(3), static(4),
    // local(5, ipNetToPhysicalType only).
    let kind = match kind {
        Some(Value::Integer(3)) => "dynamic",
        Some(Value::Integer(4)) => "static",
        Some(Value::Integer(5)) => "local",
        Some(Value::Integer(2)) => "invalid",
        _ => "other",
    };
    json!({"ifIndex": if_index, "ip": ip, "mac": as_mac(phys), "type": kind})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_text_is_kept_when_printable_and_shown_as_hex_when_not() {
        assert_eq!(text(b"Cisco IOS Software"), "Cisco IOS Software");
        assert_eq!(text(b"name\0"), "name");
        assert_eq!(text(&[0xff, 0x01]), "hex:ff01");
        assert_eq!(text(b"line\nbreak"), "hex:6c696e650a627265616b");
        assert_eq!(mac(&[0, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f]), "00:1b:2c:3d:4e:5f");
    }

    #[test]
    fn lldp_capabilities_read_most_significant_bit_first() {
        // bridge(2) and router(4): 0b0010_1000.
        assert_eq!(
            capabilities(&Value::Octets(vec![0x28, 0])),
            json!(["bridge", "router"])
        );
    }

    #[test]
    fn forwarding_and_arp_indexes_are_read_as_their_mibs_say() {
        assert_eq!(
            mac_of_index(&[0, 27, 44, 61, 78, 95]).as_deref(),
            Some("00:1b:2c:3d:4e:5f")
        );
        assert_eq!(mac_of_index(&[0, 27, 300, 61, 78, 95]), None);
        assert_eq!(mac_of_index(&[1, 2, 3]), None);
        let mut ports = BTreeMap::new();
        ports.insert(7u32, json!(10107));
        let row = fdb_row(
            "00:1b:2c:3d:4e:5f".into(),
            Some(20),
            &Value::Integer(7),
            Some(&Value::Integer(3)),
            &ports,
        );
        assert_eq!(row["ifIndex"], 10107);
        assert_eq!(row["status"], "learned");
        assert_eq!(row["fdbId"], 20);
    }
}

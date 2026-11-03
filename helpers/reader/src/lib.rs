//! **Fathom's device reader** (ADR-0082 §4.3). The only part of Fathom that may open a connection
//! to a network device, and only to read: SNMPv3 GetRequest, GetNextRequest and GetBulkRequest, and
//! SSH `exec` of an exact command from a fixed per-platform list. Nothing here can write to a
//! device. It answers `ping`, `snmp_read` and `ssh_read`.
//!
//! # The protocol
//!
//! One request per connection on a Unix socket. Each frame is a 4-byte big-endian length, then a
//! JSON object, at most [`MAX_FRAME`] bytes. Every request names `op` and the `protocol` version it
//! speaks ([`PROTOCOL`]); a reader refuses a version it does not know rather than guess. Answers are
//! `{ok: true, protocol, reader, ...}` or `{ok: false, error}`. Unknown fields are refused.
//!
//! The job and its answer are self-contained: everything a read needs travels in the request
//! (address, ranges, port, the fixed OID or command list, and the login in its own envelope), and
//! nothing refers to the server's database. That is what lets a reader later run at a site and call
//! home over an outbound connection (ADR-0089) without the job's shape changing. Each answer names
//! the reader that produced it ([`READER_ID`], `local` here).

use serde_json::{json, Map, Value};

pub mod address;
pub mod ber;
pub mod commands;
pub mod gate;
pub mod purposes;
pub mod snmp;
pub mod ssh;
pub mod usm;

/// The longest frame either way.
pub const MAX_FRAME: usize = 1024 * 1024;

/// The job and answer shapes this reader speaks.
pub const PROTOCOL: u64 = 1;

/// Which reader answered. A reader at a site will carry its own id.
pub const READER_ID: &str = "local";

/// The most device connections this reader holds open at once, whatever the server asks.
pub const MAX_DEVICE_CONNECTIONS: usize = 16;

#[derive(Debug)]
pub struct Refused(pub String);

fn refused(why: impl Into<String>) -> Refused {
    Refused(why.into())
}

fn field<'a>(m: &'a Map<String, Value>, k: &str) -> Result<&'a str, Refused> {
    m.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| refused(format!("the request has no {k}")))
}

/// One request, as the socket carries it, to one answer. Never panics on what it is sent.
pub fn answer(request: &[u8]) -> Vec<u8> {
    let out = match serde_json::from_slice::<Value>(request) {
        Ok(Value::Object(m)) => run(&m),
        _ => Err(refused("the request is not a JSON object")),
    };
    let v = match out {
        Ok(Value::Object(mut m)) => {
            m.insert("ok".into(), Value::Bool(true));
            m.insert("protocol".into(), json!(PROTOCOL));
            m.insert("reader".into(), json!(READER_ID));
            Value::Object(m)
        }
        Ok(_) => json!({"ok": false, "error": "internal"}),
        Err(Refused(why)) => json!({"ok": false, "error": why}),
    };
    serde_json::to_vec(&v).unwrap_or_else(|_| br#"{"ok":false,"error":"internal"}"#.to_vec())
}

fn run(m: &Map<String, Value>) -> Result<Value, Refused> {
    match m.get("protocol").and_then(Value::as_u64) {
        Some(PROTOCOL) => {}
        Some(_) => return Err(refused("this reader speaks protocol 1 only")),
        None => return Err(refused("the request has no protocol")),
    }
    match field(m, "op")? {
        "ping" => {
            only(m, &["op", "protocol"])?;
            Ok(json!({ "maxDeviceConnections": MAX_DEVICE_CONNECTIONS }))
        }
        "snmp_read" => {
            only(m, &["op", "protocol", "job", "login"])?;
            snmp_read(m)
        }
        "ssh_read" => {
            only(m, &["op", "protocol", "job", "login"])?;
            ssh_read(m)
        }
        _ => Err(refused("unknown step")),
    }
}

fn only(m: &Map<String, Value>, allowed: &[&str]) -> Result<(), Refused> {
    match m.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(refused(format!("the request has an unknown field {k}"))),
        None => Ok(()),
    }
}

/// How long one device's read may take, inside the server's 60-second wait.
pub const READ_BUDGET: std::time::Duration = std::time::Duration::from_secs(50);

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || s.len() > 64 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The SHA-256 of a reading's canonical JSON (keys sorted, no spaces), so an unchanged device can
/// be told from a changed one without the whole reading.
pub fn digest(reading: &Value) -> String {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(reading).unwrap_or_default();
    hex(&Sha256::digest(&bytes))
}

/// `snmp_read`. The job is self-contained: `{version: 1, device, address, port, ranges,
/// purposes, engineId}`, and the login comes in its own envelope, `{user, auth, authPassword,
/// privPassword}`, used for this job only.
///
/// - Without `engineId` the reader only discovers the device's engine and answers
///   `outcome: "engine"`: no login is sent to an engine nobody confirmed.
/// - With it, the engine must still match, and the reader reads each purpose in turn. One that
///   fails is named in `failed`; a refused login or a changed engine stops the whole read
///   (`outcome: "failed"`) and is never retried.
fn snmp_read(m: &Map<String, Value>) -> Result<Value, Refused> {
    use std::net::{IpAddr, SocketAddr};
    use std::time::Instant;

    let job = m
        .get("job")
        .and_then(Value::as_object)
        .ok_or_else(|| refused("the request has no job"))?;
    only(
        job,
        &[
            "version", "device", "address", "port", "ranges", "purposes", "engineId",
        ],
    )?;
    if job.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(refused("this reader reads job version 1 only"));
    }
    let device = field(job, "device")?.to_string();
    let ip: IpAddr = field(job, "address")?
        .parse()
        .map_err(|_| refused("the job's address is not an IP address"))?;
    let port = job
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
        .ok_or_else(|| refused("the job has no port"))?;
    if let Some(why) = address::refused(ip) {
        return Err(refused(format!("{ip} is {why} and is never read")));
    }
    let ranges: Vec<&str> = job
        .get("ranges")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !ranges.iter().any(|r| address::inside(ip, r)) {
        return Err(refused(format!(
            "{ip} is not inside a range listed for reading"
        )));
    }
    let purposes: Vec<&str> = job
        .get("purposes")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if purposes.is_empty() {
        return Err(refused("the job names no purpose"));
    }
    if let Some(p) = purposes.iter().find(|p| !purposes::KNOWN.contains(p)) {
        return Err(refused(format!("unknown purpose {p}")));
    }
    let expected = match job.get("engineId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            Some(unhex(s).ok_or_else(|| refused("the job's engineId is not hex"))?)
        }
        Some(_) => return Err(refused("the job's engineId is not hex")),
    };

    let peer = SocketAddr::new(ip, port);
    let started = Instant::now();
    let deadline = started + READ_BUDGET;
    let base = |outcome: &str| json!({"device": device, "address": ip.to_string(), "port": port, "outcome": outcome});
    let failed = |e: snmp::ReadError| {
        let mut v = base("failed");
        v["failure"] = json!({"code": e.code, "message": e.message});
        v["durationMs"] = json!(started.elapsed().as_millis() as u64);
        Ok(v)
    };

    let engine = match snmp::discover(peer, deadline) {
        Ok(e) => e,
        Err(e) => return failed(e),
    };
    let Some(expected) = expected else {
        let mut v = base("engine");
        v["engineId"] = json!(hex(&engine.id));
        v["durationMs"] = json!(started.elapsed().as_millis() as u64);
        return Ok(v);
    };
    if engine.id != expected {
        // The new id travels as its own field too, so the server can ask someone to confirm it
        // without a second round trip; nothing else is sent to an engine nobody confirmed.
        let now = hex(&engine.id);
        let mut v = failed(snmp::fail(
            "engine_changed",
            format!("the device's SNMP engine id is now {now}; someone must confirm it again"),
        ))?;
        v["engineId"] = json!(now);
        return Ok(v);
    }

    let login = login_from(m.get("login"))?;
    let mut session = match snmp::Session::new(peer, engine, &login, deadline) {
        Ok(s) => s,
        Err(e) => return failed(e),
    };
    drop(login);

    let mut reading = Map::new();
    let mut incomplete = Vec::new();
    let mut failures = Map::new();
    for p in purposes::KNOWN.iter().filter(|p| purposes.contains(p)) {
        let mut cut = false;
        match purposes::read(&mut session, p, &mut cut) {
            Ok(v) => {
                reading.insert((*p).to_string(), v);
                if cut {
                    incomplete.push(*p);
                }
            }
            Err(e) if matches!(e.code, "login_refused" | "engine_changed") => return failed(e),
            Err(e) => {
                failures.insert(
                    (*p).to_string(),
                    json!({"code": e.code, "message": e.message}),
                );
            }
        }
    }
    let reading = Value::Object(reading);
    let mut v = base("read");
    v["engineId"] = json!(hex(&expected));
    v["digest"] = json!(digest(&reading));
    v["reading"] = reading;
    v["incomplete"] = json!(incomplete);
    v["failed"] = Value::Object(failures);
    v["durationMs"] = json!(started.elapsed().as_millis() as u64);
    Ok(v)
}

/// The job's address and port, checked against its ranges and the never-read blocks.
fn target(job: &Map<String, Value>) -> Result<(std::net::IpAddr, u16), Refused> {
    let ip: std::net::IpAddr = field(job, "address")?
        .parse()
        .map_err(|_| refused("the job's address is not an IP address"))?;
    let port = job
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
        .ok_or_else(|| refused("the job has no port"))?;
    if let Some(why) = address::refused(ip) {
        return Err(refused(format!("{ip} is {why} and is never read")));
    }
    let ranges: Vec<&str> = job
        .get("ranges")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !ranges.iter().any(|r| address::inside(ip, r)) {
        return Err(refused(format!(
            "{ip} is not inside a range listed for reading"
        )));
    }
    Ok((ip, port))
}

/// `ssh_read`. The job is `{version: 1, device, address, port, ranges, platform, hostKey}` and
/// the login `{user, password}` or `{user, key}` (an unencrypted OpenSSH Ed25519 or ECDSA key).
///
/// - Without `hostKey` the reader only learns the device's host key and answers
///   `outcome: "host_key"`: no login is sent to a key nobody confirmed. The login may be absent.
/// - With it, a different key stops the read (`host_key_changed`, with the new `hostKey`).
/// - Otherwise each of the platform's fixed commands runs once and its output, through the gate,
///   is answered in `outputs`. The job never names a command.
fn ssh_read(m: &Map<String, Value>) -> Result<Value, Refused> {
    use std::net::SocketAddr;
    use std::time::Instant;

    let job = m
        .get("job")
        .and_then(Value::as_object)
        .ok_or_else(|| refused("the request has no job"))?;
    only(
        job,
        &[
            "version", "device", "address", "port", "ranges", "platform", "hostKey",
        ],
    )?;
    if job.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(refused("this reader reads job version 1 only"));
    }
    let device = field(job, "device")?.to_string();
    let (ip, port) = target(job)?;
    let platform = commands::platform(field(job, "platform")?)
        .ok_or_else(|| refused("the reader has no SSH command list for that platform"))?;
    let expected = match job.get("hostKey") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.starts_with("SHA256:") && s.len() <= 64 => Some(s.clone()),
        Some(_) => return Err(refused("the job's hostKey is not a SHA256 fingerprint")),
    };
    let login = if expected.is_some() {
        Some(ssh_login(m.get("login"))?)
    } else {
        None
    };

    let started = Instant::now();
    let base = |outcome: &str| json!({"device": device, "address": ip.to_string(), "port": port, "outcome": outcome});
    let elapsed = || json!(started.elapsed().as_millis() as u64);
    match ssh::read(
        SocketAddr::new(ip, port),
        platform,
        expected,
        login,
        started + READ_BUDGET,
    ) {
        Ok(ssh::Outcome::HostKey {
            fingerprint,
            algorithm,
        }) => {
            let mut v = base("host_key");
            v["hostKey"] = json!(fingerprint);
            v["keyType"] = json!(algorithm);
            v["durationMs"] = elapsed();
            Ok(v)
        }
        Ok(ssh::Outcome::Read { fingerprint, ran }) => {
            let outputs: Vec<Value> = ran
                .into_iter()
                .map(|r| {
                    json!({"command": r.command, "text": r.text, "drops": r.drops,
                           "incomplete": r.incomplete, "exit": r.exit})
                })
                .collect();
            let reading = json!({ "outputs": outputs });
            let mut v = base("read");
            v["hostKey"] = json!(fingerprint);
            v["platform"] = json!(platform.id);
            v["digest"] = json!(digest(&reading));
            v["reading"] = reading;
            v["durationMs"] = elapsed();
            Ok(v)
        }
        Err(f) => {
            let mut v = base("failed");
            if f.code == "host_key_changed" {
                if let Some(fp) = f
                    .message
                    .split_whitespace()
                    .find(|w| w.starts_with("SHA256:"))
                {
                    v["hostKey"] = json!(fp.trim_end_matches(';'));
                }
            }
            v["failure"] = json!({"code": f.code, "message": f.message});
            v["durationMs"] = elapsed();
            Ok(v)
        }
    }
}

fn ssh_login(v: Option<&Value>) -> Result<ssh::Login, Refused> {
    let l = v
        .and_then(Value::as_object)
        .ok_or_else(|| refused("the request has no login"))?;
    let user = field(l, "user")?.to_string();
    match (l.get("password"), l.get("key")) {
        (Some(Value::String(p)), None) => {
            only(l, &["user", "password"])?;
            Ok(ssh::Login::Password {
                user,
                password: p.clone(),
            })
        }
        (None, Some(Value::String(k))) => {
            only(l, &["user", "key"])?;
            ssh::Login::key(user, k).map_err(|f| refused(f.message))
        }
        _ => Err(refused("the login has a password or a key, and not both")),
    }
}

fn login_from(v: Option<&Value>) -> Result<snmp::Login, Refused> {
    let l = v
        .and_then(Value::as_object)
        .ok_or_else(|| refused("the request has no login"))?;
    only(l, &["user", "auth", "authPassword", "privPassword"])?;
    let auth = usm::Auth::parse(field(l, "auth")?).ok_or_else(|| {
        refused("the login's authentication is not one Fathom offers (sha512, sha256 or sha1)")
    })?;
    Ok(snmp::Login {
        user: field(l, "user")?.to_string(),
        auth,
        auth_password: field(l, "authPassword")?.as_bytes().to_vec(),
        priv_password: field(l, "privPassword")?.as_bytes().to_vec(),
    })
}

/// Read one frame: four bytes of length, big-endian, then that many bytes.
pub fn read_frame(r: &mut impl std::io::Read) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too long",
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

/// Write one frame.
pub fn write_frame(w: &mut impl std::io::Write, body: &[u8]) -> std::io::Result<()> {
    let len = u32::try_from(body.len())
        .ok()
        .filter(|l| (*l as usize) <= MAX_FRAME)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too long"))?;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(body)?;
    w.flush()
}

/// Answer one request on one connection.
pub fn serve_one(stream: &mut (impl std::io::Read + std::io::Write)) -> std::io::Result<()> {
    let req = read_frame(stream)?;
    write_frame(stream, &answer(&req))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(v: Value) -> Value {
        serde_json::from_slice(&answer(&serde_json::to_vec(&v).unwrap())).unwrap()
    }

    #[test]
    fn ping_names_the_protocol_and_the_reader() {
        let a = ask(json!({"op": "ping", "protocol": 1}));
        assert_eq!(a["ok"], true);
        assert_eq!(a["protocol"], 1);
        assert_eq!(a["reader"], "local");
        assert_eq!(a["maxDeviceConnections"], MAX_DEVICE_CONNECTIONS);
    }

    #[test]
    fn anything_else_is_refused_and_says_why() {
        for (req, why) in [
            (json!({"op": "ping"}), "the request has no protocol"),
            (
                json!({"op": "ping", "protocol": 2}),
                "this reader speaks protocol 1 only",
            ),
            (json!({"op": "set", "protocol": 1}), "unknown step"),
            (
                json!({"op": "ping", "protocol": 1, "x": 1}),
                "the request has an unknown field x",
            ),
            (json!([1, 2]), "the request is not a JSON object"),
        ] {
            let a = ask(req);
            assert_eq!(a["ok"], false);
            assert_eq!(a["error"], why);
        }
        let a: Value = serde_json::from_slice(&answer(b"not json")).unwrap();
        assert_eq!(a["ok"], false);
    }

    #[test]
    fn a_frame_too_long_is_refused_before_it_is_read() {
        let mut bytes = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        assert!(read_frame(&mut bytes.as_slice()).is_err());
        let mut out = Vec::new();
        write_frame(&mut out, b"{}").unwrap();
        assert_eq!(read_frame(&mut out.as_slice()).unwrap(), b"{}");
    }
}

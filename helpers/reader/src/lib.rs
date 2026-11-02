//! **Fathom's device reader** (ADR-0082 §4.3). The only part of Fathom that may open a connection
//! to a network device, and only to read: SNMPv3 GetRequest, GetNextRequest and GetBulkRequest, and
//! SSH `exec` of an exact command from a fixed per-platform list. Nothing here can write to a
//! device. This first part answers `ping`; the reads come in the next parts.
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
    let allowed: &[&str] = match field(m, "op")? {
        "ping" => &["op", "protocol"],
        _ => return Err(refused("unknown step")),
    };
    if let Some(k) = m.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(refused(format!("the request has an unknown field {k}")));
    }
    Ok(json!({ "maxDeviceConnections": MAX_DEVICE_CONNECTIONS }))
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

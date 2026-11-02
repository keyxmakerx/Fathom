//! The few BER shapes SNMP uses (RFC 3416 §3, RFC 3417 §8, X.690 definite lengths only).
//!
//! The encoder makes only what the reader sends. The decoder reads what an agent answers and
//! refuses anything outside that: multi-byte tags, indefinite lengths, a length past the end, an
//! integer or an arc too long to hold. It never panics on what it is given.

/// What went wrong reading an answer. The text is shown to a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Malformed(pub &'static str);

pub const INTEGER: u8 = 0x02;
pub const OCTET_STRING: u8 = 0x04;
pub const NULL: u8 = 0x05;
pub const OID: u8 = 0x06;
pub const SEQUENCE: u8 = 0x30;

// SMIv2's application types (RFC 3416 §3, ApplicationSyntax).
pub const IP_ADDRESS: u8 = 0x40;
pub const COUNTER32: u8 = 0x41;
pub const GAUGE32: u8 = 0x42;
pub const TIMETICKS: u8 = 0x43;
pub const OPAQUE: u8 = 0x44;
pub const COUNTER64: u8 = 0x46;

// A varbind's exceptions (RFC 3416 §3: noSuchObject [0], noSuchInstance [1], endOfMibView [2]).
pub const NO_SUCH_OBJECT: u8 = 0x80;
pub const NO_SUCH_INSTANCE: u8 = 0x81;
pub const END_OF_MIB_VIEW: u8 = 0x82;

// The PDUs (RFC 3416 §3). The reader SENDS only the first three. SetRequest-PDU is [3], 0xA3: there
// is no constant for it here, and a test asserts the encoder can never emit it.
pub const GET_REQUEST: u8 = 0xA0;
pub const GET_NEXT_REQUEST: u8 = 0xA1;
pub const GET_BULK_REQUEST: u8 = 0xA5;
pub const RESPONSE: u8 = 0xA2;
pub const REPORT: u8 = 0xA8;

fn length(n: usize) -> Vec<u8> {
    if n < 0x80 {
        return vec![n as u8];
    }
    let bytes: Vec<u8> = (n as u64)
        .to_be_bytes()
        .into_iter()
        .skip_while(|b| *b == 0)
        .collect();
    let mut out = vec![0x80 | bytes.len() as u8];
    out.extend(bytes);
    out
}

/// One tag, its length, its value.
pub fn tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(length(value.len()));
    out.extend_from_slice(value);
    out
}

/// The shortest two's-complement form.
pub fn integer(v: i64) -> Vec<u8> {
    let bytes = v.to_be_bytes();
    let mut start = 0;
    while start < 7 {
        let (a, b) = (bytes[start], bytes[start + 1]);
        if (a == 0x00 && b & 0x80 == 0) || (a == 0xff && b & 0x80 != 0) {
            start += 1;
        } else {
            break;
        }
    }
    tlv(INTEGER, &bytes[start..])
}

pub fn octets(b: &[u8]) -> Vec<u8> {
    tlv(OCTET_STRING, b)
}

pub fn null() -> Vec<u8> {
    tlv(NULL, &[])
}

pub fn sequence(parts: &[&[u8]]) -> Vec<u8> {
    tlv(SEQUENCE, &parts.concat())
}

/// An object identifier. Arcs come only from the reader's fixed lists, which all start 1.3 or 1.0.
pub fn oid(arcs: &[u32]) -> Vec<u8> {
    let mut body = Vec::new();
    let (first, rest) = match arcs {
        [a, b, rest @ ..] => (a * 40 + b, rest),
        [a] => (a * 40, &[][..]),
        [] => (0, &[][..]),
    };
    for arc in std::iter::once(first).chain(rest.iter().copied()) {
        let mut chunk = vec![(arc & 0x7f) as u8];
        let mut v = arc >> 7;
        while v > 0 {
            chunk.push(0x80 | (v & 0x7f) as u8);
            v >>= 7;
        }
        chunk.reverse();
        body.extend(chunk);
    }
    tlv(OID, &body)
}

/// Reads one TLV after another from a buffer.
pub struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf }
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// The next tag and its value; the rest stays for the next call.
    pub fn take(&mut self) -> Result<(u8, &'a [u8]), Malformed> {
        let (&tag, rest) = self
            .buf
            .split_first()
            .ok_or(Malformed("an answer ended early"))?;
        if tag & 0x1f == 0x1f {
            return Err(Malformed("an answer used a tag SNMP does not"));
        }
        let (&first, rest) = rest
            .split_first()
            .ok_or(Malformed("an answer ended early"))?;
        let (len, rest) = if first & 0x80 == 0 {
            (first as usize, rest)
        } else {
            let n = (first & 0x7f) as usize;
            if n == 0 || n > 4 {
                return Err(Malformed("an answer used a length SNMP does not"));
            }
            if rest.len() < n {
                return Err(Malformed("an answer ended early"));
            }
            let len = rest[..n].iter().fold(0usize, |a, b| (a << 8) | *b as usize);
            (len, &rest[n..])
        };
        if rest.len() < len {
            return Err(Malformed("an answer ended early"));
        }
        let (value, rest) = rest.split_at(len);
        self.buf = rest;
        Ok((tag, value))
    }

    /// The next TLV, which must carry this tag.
    pub fn expect(&mut self, tag: u8) -> Result<&'a [u8], Malformed> {
        match self.take()? {
            (t, v) if t == tag => Ok(v),
            _ => Err(Malformed("an answer was not shaped as SNMP says")),
        }
    }

    pub fn integer(&mut self) -> Result<i64, Malformed> {
        decode_integer(self.expect(INTEGER)?)
    }
}

pub fn decode_integer(v: &[u8]) -> Result<i64, Malformed> {
    if v.is_empty() || v.len() > 8 {
        return Err(Malformed("an answer held an integer SNMP does not"));
    }
    let mut out: i64 = if v[0] & 0x80 != 0 { -1 } else { 0 };
    for b in v {
        out = (out << 8) | *b as i64;
    }
    Ok(out)
}

/// An unsigned value: Counter32, Gauge32, TimeTicks (at most 32 bits) and Counter64.
pub fn decode_unsigned(v: &[u8], bits: u32) -> Result<u64, Malformed> {
    let v = match v {
        [0, rest @ ..] if !rest.is_empty() => rest,
        _ => v,
    };
    if v.is_empty() || v.len() * 8 > bits as usize + 7 || v.len() > 8 {
        return Err(Malformed("an answer held a number too long"));
    }
    let out = v.iter().fold(0u64, |a, b| (a << 8) | *b as u64);
    if bits < 64 && out >> bits != 0 {
        return Err(Malformed("an answer held a number too long"));
    }
    Ok(out)
}

pub fn decode_oid(v: &[u8]) -> Result<Vec<u32>, Malformed> {
    if v.is_empty() || v.len() > 512 {
        return Err(Malformed(
            "an answer held an object identifier SNMP does not",
        ));
    }
    let mut arcs = Vec::new();
    let mut acc: u64 = 0;
    for (i, b) in v.iter().enumerate() {
        acc = (acc << 7) | (b & 0x7f) as u64;
        if acc > u32::MAX as u64 {
            return Err(Malformed(
                "an answer held an object identifier SNMP does not",
            ));
        }
        if b & 0x80 == 0 {
            if arcs.is_empty() {
                let first = acc.min(80) / 40;
                arcs.push(first as u32);
                arcs.push((acc - first * 40) as u32);
            } else {
                arcs.push(acc as u32);
            }
            acc = 0;
        } else if i + 1 == v.len() {
            return Err(Malformed(
                "an answer held an object identifier SNMP does not",
            ));
        }
    }
    Ok(arcs)
}

/// A varbind's value, decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Integer(i64),
    Octets(Vec<u8>),
    Null,
    Oid(Vec<u32>),
    IpAddress([u8; 4]),
    Counter32(u32),
    Gauge32(u32),
    TimeTicks(u32),
    Opaque(Vec<u8>),
    Counter64(u64),
    NoSuchObject,
    NoSuchInstance,
    EndOfMibView,
}

pub fn decode_value(tag: u8, v: &[u8]) -> Result<Value, Malformed> {
    Ok(match tag {
        INTEGER => Value::Integer(decode_integer(v)?),
        OCTET_STRING => Value::Octets(v.to_vec()),
        NULL => Value::Null,
        OID => Value::Oid(decode_oid(v)?),
        IP_ADDRESS => Value::IpAddress(
            v.try_into()
                .map_err(|_| Malformed("an answer held an address SNMP does not"))?,
        ),
        COUNTER32 => Value::Counter32(decode_unsigned(v, 32)? as u32),
        GAUGE32 => Value::Gauge32(decode_unsigned(v, 32)? as u32),
        TIMETICKS => Value::TimeTicks(decode_unsigned(v, 32)? as u32),
        OPAQUE => Value::Opaque(v.to_vec()),
        COUNTER64 => Value::Counter64(decode_unsigned(v, 64)?),
        NO_SUCH_OBJECT => Value::NoSuchObject,
        NO_SUCH_INSTANCE => Value::NoSuchInstance,
        END_OF_MIB_VIEW => Value::EndOfMibView,
        _ => return Err(Malformed("an answer held a value type SNMP does not")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_are_shortest_and_read_back() {
        for (v, bytes) in [
            (0i64, vec![2, 1, 0]),
            (127, vec![2, 1, 0x7f]),
            (128, vec![2, 2, 0, 0x80]),
            (-1, vec![2, 1, 0xff]),
            (-129, vec![2, 2, 0xff, 0x7f]),
            (65536, vec![2, 3, 1, 0, 0]),
        ] {
            assert_eq!(integer(v), bytes, "{v}");
            assert_eq!(Reader::new(&bytes).integer().unwrap(), v);
        }
    }

    #[test]
    fn object_identifiers_round_trip() {
        // sysDescr.0 and lldpRemSysName, the two shapes the reader sends (1.3... and 1.0...).
        for arcs in [
            vec![1, 3, 6, 1, 2, 1, 1, 1, 0],
            vec![1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 9],
            vec![1, 3, 6, 1, 4, 1, 4294967295],
        ] {
            let enc = oid(&arcs);
            let mut r = Reader::new(&enc);
            assert_eq!(decode_oid(r.expect(OID).unwrap()).unwrap(), arcs);
        }
        assert_eq!(
            oid(&[1, 3, 6, 1, 2, 1, 1, 1, 0]),
            [6, 8, 0x2b, 6, 1, 2, 1, 1, 1, 0]
        );
    }

    #[test]
    fn long_lengths_are_written_and_read() {
        let body = vec![7u8; 300];
        let enc = octets(&body);
        assert_eq!(&enc[..4], &[4, 0x82, 1, 44]);
        assert_eq!(Reader::new(&enc).expect(OCTET_STRING).unwrap(), &body[..]);
    }

    #[test]
    fn what_an_agent_cannot_send_is_refused_not_panicked_on() {
        for bad in [
            &[][..],
            &[4],
            &[4, 5, 1],
            &[4, 0x80, 0],
            &[4, 0x85, 1, 1, 1, 1, 1],
            &[0x1f, 1, 0],
            &[4, 0x82, 0xff],
        ] {
            assert!(Reader::new(bad).take().is_err(), "{bad:?}");
        }
        assert!(decode_integer(&[]).is_err());
        assert!(decode_integer(&[1; 9]).is_err());
        assert!(decode_oid(&[0x2b, 0x81]).is_err());
        assert!(decode_oid(&[0x2b, 0x90, 0x80, 0x80, 0x80, 0x80, 1]).is_err());
        assert!(decode_unsigned(&[1, 0, 0, 0, 0], 32).is_err());
        assert_eq!(
            decode_unsigned(&[0, 0xff, 0xff, 0xff, 0xff], 32).unwrap(),
            u32::MAX as u64
        );
        assert!(decode_value(0x45, &[]).is_err());
        assert!(decode_value(IP_ADDRESS, &[1, 2, 3]).is_err());
    }
}

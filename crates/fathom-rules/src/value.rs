//! Static types and runtime values. Deliberately small: no floats, no time, no maps
//! (12 §3.4). Integers are checked; an overflow is an evaluation error, never a wrap.

use std::rc::Rc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KindId(pub u16);
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EdgeId(pub u16);
/// The field's wire key (`schema/field-keys.yaml`), unique across nodes and edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FieldId(pub u32);
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EnumId(pub u16);

/// What a list holds. Lists exist only as selector `many` bindings, `filter` results and
/// literals, so the element is always one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Elem {
    Int,
    Str,
    Enum(EnumId),
    Addr,
    Node(KindId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    Null,
    Bool,
    Int,
    Str,
    Enum(EnumId),
    Addr,
    Prefix,
    /// An address with its prefix length and host bits preserved (`10.0.0.1/24`).
    Iface,
    Node(KindId),
    List(Elem),
    /// A field whose value a rule may only ask the existence of (`has`, `known_absent`,
    /// `is_known`): structured values with no scalar reading.
    Opaque,
    /// A secret. No rule may read one, not even its presence (CLAUDE.md rule 4).
    Secret,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ip {
    pub v6: bool,
    /// An IPv4 address occupies the low 32 bits.
    pub bits: u128,
}

impl Ip {
    pub fn width(self) -> u8 {
        if self.v6 {
            128
        } else {
            32
        }
    }

    /// The address with every host bit (below `len`) cleared.
    pub fn network(self, len: u8) -> Ip {
        let w = self.width();
        let len = len.min(w);
        let host = u32::from(w - len);
        let mask = if host >= 128 {
            0
        } else {
            (u128::MAX << host) & self.mask_all()
        };
        Ip {
            v6: self.v6,
            bits: self.bits & mask,
        }
    }

    fn mask_all(self) -> u128 {
        if self.v6 {
            u128::MAX
        } else {
            u128::from(u32::MAX)
        }
    }

    /// The host bits (below `len`) as a number.
    pub fn host_bits(self, len: u8) -> u128 {
        self.bits & !self.network(len).bits & self.mask_all()
    }
}

pub fn parse_ip(s: &str) -> Option<Ip> {
    if s.contains(':') {
        parse_v6(s)
    } else {
        parse_v4(s)
    }
}

fn parse_v4(s: &str) -> Option<Ip> {
    let mut bits: u128 = 0;
    let mut n = 0;
    for part in s.split('.') {
        n += 1;
        if n > 4 || part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let v: u32 = part.parse().ok()?;
        if v > 255 {
            return None;
        }
        bits = (bits << 8) | u128::from(v);
    }
    (n == 4).then_some(Ip { v6: false, bits })
}

fn parse_v6(s: &str) -> Option<Ip> {
    let (head, tail) = match s.split_once("::") {
        Some((h, t)) => (h, Some(t)),
        None => (s, None),
    };
    let groups = |part: &str| -> Option<Vec<u16>> {
        if part.is_empty() {
            return Some(Vec::new());
        }
        part.split(':')
            .map(|g| {
                if g.is_empty() || g.len() > 4 {
                    None
                } else {
                    u16::from_str_radix(g, 16).ok()
                }
            })
            .collect()
    };
    let h = groups(head)?;
    let all: Vec<u16> = match tail {
        None => h,
        Some(t) => {
            let t = groups(t)?;
            if h.len() + t.len() > 7 {
                return None;
            }
            let mut v = h;
            v.resize(8 - t.len(), 0);
            v.extend(t);
            v
        }
    };
    if all.len() != 8 {
        return None;
    }
    let bits = all.iter().fold(0u128, |a, g| (a << 16) | u128::from(*g));
    Some(Ip { v6: true, bits })
}

/// `addr/len`, the length within the family's width.
pub fn parse_net(s: &str) -> Option<(Ip, u8)> {
    let (a, l) = s.split_once('/')?;
    let ip = parse_ip(a)?;
    if l.is_empty() || l.len() > 3 || !l.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let len: u8 = l.parse().ok()?;
    (len <= ip.width()).then_some((ip, len))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Val<N> {
    Null,
    Bool(bool),
    Int(i64),
    /// Strings and enum tokens alike; the type checker keeps them apart.
    Str(Rc<str>),
    Addr(Ip),
    Prefix(Ip, u8),
    Iface(Ip, u8),
    Node(N),
    List(Rc<Vec<Val<N>>>),
}

/// A field as the store reports it: the three-way presence of `11` §8, with the value
/// only when set.
#[derive(Debug, Clone, PartialEq)]
pub enum Field {
    /// Nobody has said (the store's `Unknown`).
    Unset,
    /// Looked for and known not to be there.
    Absent,
    Set(Scalar),
}

/// What a store can hand a rule: no node references (a rule reaches nodes through its
/// selector only).
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    Bool(bool),
    Int(i64),
    Str(String),
    Addr(Ip),
    Prefix(Ip, u8),
    Iface(Ip, u8),
    /// A value present but with no scalar reading (`Opaque` fields).
    Present,
}

impl Scalar {
    pub fn into_val<N>(self) -> Val<N> {
        match self {
            Scalar::Bool(b) => Val::Bool(b),
            Scalar::Int(i) => Val::Int(i),
            Scalar::Str(s) => Val::Str(Rc::from(s)),
            Scalar::Addr(a) => Val::Addr(a),
            Scalar::Prefix(a, l) => Val::Prefix(a, l),
            Scalar::Iface(a, l) => Val::Iface(a, l),
            Scalar::Present => Val::Null,
        }
    }
}

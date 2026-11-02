//! An SNMPv3 session that can only read: discovery, then authPriv GetRequest, GetNextRequest and
//! GetBulkRequest (RFC 3412 §6 for the message, RFC 3414 for USM, RFC 3416 for the PDUs).
//!
//! The message builder takes a PDU tag only from [`ReadPdu`], which has no variant for
//! SetRequest-PDU, so nothing here can be made to send one (ADR-0082 §4.1).

use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use crate::ber::{self, Malformed, Reader, Value};
use crate::usm::{self, Auth};

/// The PDUs the reader sends. There is no other way to choose a PDU tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadPdu {
    Get,
    GetNext,
    GetBulk { max_repetitions: u32 },
}

impl ReadPdu {
    fn tag(self) -> u8 {
        match self {
            ReadPdu::Get => ber::GET_REQUEST,
            ReadPdu::GetNext => ber::GET_NEXT_REQUEST,
            ReadPdu::GetBulk { .. } => ber::GET_BULK_REQUEST,
        }
    }
}

/// Why a read stopped. `code` is stable for the server; `message` is shown to a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError {
    pub code: &'static str,
    pub message: String,
}

pub fn fail(code: &'static str, message: impl Into<String>) -> ReadError {
    ReadError {
        code,
        message: message.into(),
    }
}

impl From<Malformed> for ReadError {
    fn from(m: Malformed) -> Self {
        fail("malformed", m.0)
    }
}

/// The login, as `use_login` gave it to the server and the server passed it on in the job's own
/// envelope. Dropped (and its buffers overwritten) when the job ends.
pub struct Login {
    pub user: String,
    pub auth: Auth,
    pub auth_password: Vec<u8>,
    pub priv_password: Vec<u8>,
}

impl Drop for Login {
    fn drop(&mut self) {
        self.auth_password.fill(0);
        self.priv_password.fill(0);
        // Keeps the writes above from being optimised away as dead.
        std::hint::black_box((&self.auth_password, &self.priv_password));
    }
}

/// What discovery learns about the device's SNMP engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engine {
    pub id: Vec<u8>,
    pub boots: u32,
    pub time: u32,
}

// usmStats (RFC 3414 §5, SNMP-USER-BASED-SM-MIB: snmpUsmMIB = snmpModules 15, usmStats = 1.1).
const USM_STATS: [u32; 9] = [1, 3, 6, 1, 6, 3, 15, 1, 1];
const UNSUPPORTED_SEC_LEVELS: u32 = 1;
const NOT_IN_TIME_WINDOWS: u32 = 2;
const UNKNOWN_USER_NAMES: u32 = 3;
const UNKNOWN_ENGINE_IDS: u32 = 4;
const WRONG_DIGESTS: u32 = 5;
const DECRYPTION_ERRORS: u32 = 6;

// msgFlags (RFC 3412 §6.4).
const AUTH: u8 = 0x01;
const PRIV: u8 = 0x02;
const REPORTABLE: u8 = 0x04;
/// User-based security model (RFC 3412 §6.6, RFC 3411 §5).
const USM: i64 = 3;
/// The largest answer this reader can take: a UDP payload over IPv4.
const MAX_SIZE: i64 = 65507;
/// How long one request waits for its answer, and how many times it is sent when nothing comes.
const WAIT: Duration = Duration::from_secs(3);
const SENDS: usize = 2;

pub struct Session {
    sock: UdpSocket,
    peer: SocketAddr,
    engine: Engine,
    /// When `engine.time` was learnt, so the time sent stays inside the 150-second window.
    learnt: Instant,
    user: Vec<u8>,
    auth: Auth,
    auth_key: Vec<u8>,
    priv_key: Vec<u8>,
    next_id: u32,
    next_salt: u64,
    deadline: Instant,
    /// Whether any signed request has been answered yet.
    answered: bool,
}

fn random_u64() -> u64 {
    getrandom::u64().unwrap_or_else(|_| {
        // No random source: fall back to the clock. The salt need only be unique (RFC 3826 §3.1.2.1).
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1)
    })
}

fn open(peer: SocketAddr) -> Result<UdpSocket, ReadError> {
    let local: SocketAddr = if peer.is_ipv4() {
        "0.0.0.0:0".parse().expect("a literal address")
    } else {
        "[::]:0".parse().expect("a literal address")
    };
    let sock =
        UdpSocket::bind(local).map_err(|e| fail("unreachable", format!("no socket: {e}")))?;
    sock.connect(peer)
        .map_err(|e| fail("unreachable", format!("cannot reach {peer}: {e}")))?;
    Ok(sock)
}

/// Sends `msg` and waits for an answer `accept` takes, resending once on silence.
fn exchange<T>(
    sock: &UdpSocket,
    msg: &[u8],
    deadline: Instant,
    mut accept: impl FnMut(&[u8]) -> Option<Result<T, ReadError>>,
) -> Result<T, ReadError> {
    let mut buf = vec![0u8; 65536];
    for _ in 0..SENDS {
        sock.send(msg)
            .map_err(|e| fail("unreachable", format!("could not send: {e}")))?;
        let until = (Instant::now() + WAIT).min(deadline);
        loop {
            let now = Instant::now();
            if now >= until {
                break;
            }
            let _ = sock.set_read_timeout(Some(until - now));
            match sock.recv(&mut buf) {
                Ok(n) => {
                    if let Some(r) = accept(&buf[..n]) {
                        return r;
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break
                }
                Err(e) => return Err(fail("unreachable", format!("the device refused: {e}"))),
            }
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    Err(fail("timeout", "the device did not answer over SNMP"))
}

/// A parsed SNMPv3 message, with where its authentication parameters sit in the bytes.
struct Incoming<'a> {
    msg_id: i64,
    flags: u8,
    engine: Engine,
    user: &'a [u8],
    auth_params: &'a [u8],
    auth_at: usize,
    priv_params: &'a [u8],
    data_tag: u8,
    data: &'a [u8],
}

fn parse_message(bytes: &[u8]) -> Result<Incoming<'_>, ReadError> {
    let mut top = Reader::new(bytes);
    let body = top.expect(ber::SEQUENCE)?;
    let mut m = Reader::new(body);
    if m.integer()? != 3 {
        return Err(fail("malformed", "the answer is not SNMPv3"));
    }
    let mut global = Reader::new(m.expect(ber::SEQUENCE)?);
    let msg_id = global.integer()?;
    let _max = global.integer()?;
    let flags = *global
        .expect(ber::OCTET_STRING)?
        .first()
        .ok_or(fail("malformed", "the answer has no flags"))?;
    if global.integer()? != USM {
        return Err(fail(
            "malformed",
            "the answer does not use the user-based security model",
        ));
    }
    let mut sec = Reader::new(m.expect(ber::OCTET_STRING)?);
    let mut usm = Reader::new(sec.expect(ber::SEQUENCE)?);
    let id = usm.expect(ber::OCTET_STRING)?.to_vec();
    let boots = u32::try_from(usm.integer()?).map_err(|_| fail("malformed", "bad engine boots"))?;
    let time = u32::try_from(usm.integer()?).map_err(|_| fail("malformed", "bad engine time"))?;
    let user = usm.expect(ber::OCTET_STRING)?;
    let auth_params = usm.expect(ber::OCTET_STRING)?;
    let priv_params = usm.expect(ber::OCTET_STRING)?;
    let (data_tag, data) = m.take()?;
    let auth_at = auth_params.as_ptr() as usize - bytes.as_ptr() as usize;
    Ok(Incoming {
        msg_id,
        flags,
        engine: Engine { id, boots, time },
        user,
        auth_params,
        auth_at,
        priv_params,
        data_tag,
        data,
    })
}

struct Scoped {
    tag: u8,
    request_id: i64,
    error_status: i64,
    error_index: i64,
    varbinds: Vec<(Vec<u32>, Value)>,
}

fn parse_scoped(bytes: &[u8]) -> Result<Scoped, ReadError> {
    let mut r = Reader::new(bytes);
    let mut s = Reader::new(r.expect(ber::SEQUENCE)?);
    let _context_engine = s.expect(ber::OCTET_STRING)?;
    let _context_name = s.expect(ber::OCTET_STRING)?;
    let (tag, pdu) = s.take()?;
    if tag != ber::RESPONSE && tag != ber::REPORT {
        return Err(fail("malformed", "the answer was not a response"));
    }
    let mut p = Reader::new(pdu);
    let request_id = p.integer()?;
    let error_status = p.integer()?;
    let error_index = p.integer()?;
    let mut list = Reader::new(p.expect(ber::SEQUENCE)?);
    let mut varbinds = Vec::new();
    while !list.is_empty() {
        let mut vb = Reader::new(list.expect(ber::SEQUENCE)?);
        let name = ber::decode_oid(vb.expect(ber::OID)?)?;
        let (t, v) = vb.take()?;
        varbinds.push((name, ber::decode_value(t, v)?));
    }
    Ok(Scoped {
        tag,
        request_id,
        error_status,
        error_index,
        varbinds,
    })
}

fn pdu(kind: ReadPdu, request_id: u32, oids: &[&[u32]]) -> Vec<u8> {
    let list: Vec<Vec<u8>> = oids
        .iter()
        .map(|o| ber::sequence(&[&ber::oid(o), &ber::null()]))
        .collect();
    let list = ber::sequence(&list.iter().map(Vec::as_slice).collect::<Vec<_>>());
    let (a, b) = match kind {
        // non-repeaters 0, max-repetitions N (RFC 3416 §4.2.3).
        ReadPdu::GetBulk { max_repetitions } => (0, max_repetitions as i64),
        _ => (0, 0),
    };
    let body = [
        ber::integer(request_id as i64),
        ber::integer(a),
        ber::integer(b),
        list,
    ]
    .concat();
    ber::tlv(kind.tag(), &body)
}

fn scoped(engine_id: &[u8], pdu: &[u8]) -> Vec<u8> {
    ber::sequence(&[&ber::octets(engine_id), &ber::octets(b""), pdu])
}

#[allow(clippy::too_many_arguments)]
fn message(
    msg_id: u32,
    flags: u8,
    engine: &Engine,
    user: &[u8],
    auth_params: &[u8],
    priv_params: &[u8],
    data: &[u8],
) -> Vec<u8> {
    let global = ber::sequence(&[
        &ber::integer(msg_id as i64),
        &ber::integer(MAX_SIZE),
        &ber::octets(&[flags]),
        &ber::integer(USM),
    ]);
    let usm = ber::sequence(&[
        &ber::octets(&engine.id),
        &ber::integer(engine.boots as i64),
        &ber::integer(engine.time as i64),
        &ber::octets(user),
        &ber::octets(auth_params),
        &ber::octets(priv_params),
    ]);
    ber::sequence(&[&ber::integer(3), &global, &ber::octets(&usm), data])
}

/// Learns the device's engine id, boots and time with an unauthenticated, empty request. No
/// login is sent (RFC 3414 §4).
pub fn discover(peer: SocketAddr, deadline: Instant) -> Result<Engine, ReadError> {
    let sock = open(peer)?;
    let id = (random_u64() as u32) & 0x7fff_ffff;
    let empty = Engine {
        id: Vec::new(),
        boots: 0,
        time: 0,
    };
    let data = scoped(b"", &pdu(ReadPdu::Get, id, &[]));
    let msg = message(id, REPORTABLE, &empty, b"", b"", b"", &data);
    exchange(&sock, &msg, deadline, |bytes| {
        let m = parse_message(bytes).ok()?;
        if m.msg_id != id as i64 {
            return None;
        }
        if m.engine.id.is_empty() || m.engine.id.len() > 32 {
            return Some(Err(fail(
                "malformed",
                "the device sent no usable engine id",
            )));
        }
        Some(Ok(m.engine))
    })
}

impl Session {
    /// A session with an engine already confirmed. Keys are made here and live only as long as
    /// the session.
    pub fn new(
        peer: SocketAddr,
        engine: Engine,
        login: &Login,
        deadline: Instant,
    ) -> Result<Session, ReadError> {
        if login.auth_password.len() < usm::MIN_PASSWORD
            || login.priv_password.len() < usm::MIN_PASSWORD
        {
            return Err(fail(
                "login_refused",
                "SNMPv3 passwords are at least 8 characters (RFC 3414 §11.2)",
            ));
        }
        let auth_key = usm::localise(
            login.auth,
            &usm::password_to_key(login.auth, &login.auth_password),
            &engine.id,
        );
        // The privacy key is localised with the authentication protocol's hash (RFC 3414 §5,
        // usmUserPrivKeyChange: "The associated hash algorithm is the algorithm used by the user's
        // usmUserAuthProtocol").
        let priv_key = usm::localise(
            login.auth,
            &usm::password_to_key(login.auth, &login.priv_password),
            &engine.id,
        );
        Ok(Session {
            sock: open(peer)?,
            peer,
            engine,
            learnt: Instant::now(),
            user: login.user.as_bytes().to_vec(),
            auth: login.auth,
            auth_key,
            priv_key,
            next_id: (random_u64() as u32) & 0x7fff_ffff,
            next_salt: random_u64(),
            deadline,
            answered: false,
        })
    }

    pub fn peer(&self) -> SocketAddr {
        self.peer
    }

    pub fn out_of_time(&self) -> bool {
        Instant::now() >= self.deadline
    }

    fn engine_now(&self) -> Engine {
        let elapsed = self.learnt.elapsed().as_secs().min(u32::MAX as u64) as u32;
        Engine {
            id: self.engine.id.clone(),
            boots: self.engine.boots,
            time: self.engine.time.saturating_add(elapsed),
        }
    }

    /// One read. A report that the clock was out of the window is taken once and the request sent
    /// again; every other report ends the read, and a refused login is never retried.
    pub fn request(
        &mut self,
        kind: ReadPdu,
        oids: &[&[u32]],
    ) -> Result<Vec<(Vec<u32>, Value)>, ReadError> {
        match self.request_once(kind, oids) {
            Err(e) if e.code == "time_window" => self.request_once(kind, oids),
            other => other,
        }
    }

    fn request_once(
        &mut self,
        kind: ReadPdu,
        oids: &[&[u32]],
    ) -> Result<Vec<(Vec<u32>, Value)>, ReadError> {
        if self.out_of_time() {
            return Err(fail("timeout", "the read ran out of time"));
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1) & 0x7fff_ffff;
        let salt = self.next_salt.to_be_bytes();
        self.next_salt = self.next_salt.wrapping_add(1);
        let engine = self.engine_now();

        let mut data = scoped(&engine.id, &pdu(kind, id, oids));
        usm::encrypt(&self.priv_key, engine.boots, engine.time, &salt, &mut data);
        let data = ber::octets(&data);
        let flags = AUTH | PRIV | REPORTABLE;
        let zeros = vec![0u8; self.auth.mac_len()];
        let unsigned = message(id, flags, &engine, &self.user, &zeros, &salt, &data);
        let mac = usm::mac(self.auth, &self.auth_key, &unsigned);
        let msg = message(id, flags, &engine, &self.user, &mac, &salt, &data);

        let (auth, auth_key, priv_key) = (self.auth, self.auth_key.clone(), self.priv_key.clone());
        let our_engine = engine.id.clone();
        let user = self.user.clone();
        let deadline = self.deadline;
        let answered = self.answered;
        let answer = exchange(&self.sock, &msg, deadline, |bytes| {
            let m = parse_message(bytes).ok()?;
            if m.msg_id != id as i64 {
                return None;
            }
            Some(open_answer(
                bytes,
                &m,
                auth,
                &auth_key,
                &priv_key,
                &our_engine,
                &user,
                id,
            ))
        })
        .map_err(|e| {
            // The device answered discovery but drops every signed request: net-snmp does this
            // when it cannot decrypt (a wrong privacy password or protocol), without a report.
            if e.code == "timeout" && !answered {
                fail(
                    "login_refused",
                    "the device answered SNMP but not this login: check the privacy password and protocol",
                )
            } else {
                e
            }
        })?;
        self.answered = true;
        match answer {
            Answer::Varbinds(v) => Ok(v),
            Answer::Clock(e) => {
                self.engine.boots = e.boots;
                self.engine.time = e.time;
                self.learnt = Instant::now();
                Err(fail(
                    "time_window",
                    "the device's clock moved; trying once more",
                ))
            }
        }
    }
}

enum Answer {
    Varbinds(Vec<(Vec<u32>, Value)>),
    Clock(Engine),
}

#[allow(clippy::too_many_arguments)]
fn open_answer(
    bytes: &[u8],
    m: &Incoming<'_>,
    auth: Auth,
    auth_key: &[u8],
    priv_key: &[u8],
    our_engine: &[u8],
    user: &[u8],
    id: u32,
) -> Result<Answer, ReadError> {
    if m.engine.id != our_engine {
        return Err(fail(
            "engine_changed",
            "the device answered with a different SNMP engine id; someone must confirm it again",
        ));
    }
    let authenticated = m.flags & AUTH != 0;
    if authenticated {
        if m.user != user || m.auth_params.len() != auth.mac_len() {
            return Err(fail("malformed", "the answer's login does not match"));
        }
        let mut zeroed = bytes.to_vec();
        zeroed[m.auth_at..m.auth_at + m.auth_params.len()].fill(0);
        if !usm::same_mac(&usm::mac(auth, auth_key, &zeroed), m.auth_params) {
            return Err(fail(
                "malformed",
                "the answer's signature does not match; it was ignored",
            ));
        }
    }
    let plain = if m.flags & PRIV != 0 {
        if !authenticated || m.data_tag != ber::OCTET_STRING {
            return Err(fail(
                "malformed",
                "the answer was encrypted without being signed",
            ));
        }
        let salt: [u8; 8] = m.priv_params.try_into().map_err(|_| {
            fail(
                "malformed",
                "the answer's privacy parameters are not 8 octets",
            )
        })?;
        let mut d = m.data.to_vec();
        usm::decrypt(priv_key, m.engine.boots, m.engine.time, &salt, &mut d);
        d
    } else {
        // Only a report may come back in the clear (for example an unknown user).
        ber::tlv(m.data_tag, m.data)
    };
    let s = parse_scoped(&plain).map_err(|_| {
        if m.flags & PRIV != 0 {
            fail(
                "login_refused",
                "the answer could not be decrypted: check the privacy password",
            )
        } else {
            fail("malformed", "the answer was not shaped as SNMP says")
        }
    })?;
    if s.tag == ber::REPORT {
        let counter = s
            .varbinds
            .first()
            .and_then(|(o, _)| o.strip_prefix(&USM_STATS[..]))
            .and_then(|rest| rest.first().copied());
        return match counter {
            Some(NOT_IN_TIME_WINDOWS) if authenticated => Ok(Answer::Clock(m.engine.clone())),
            Some(UNKNOWN_USER_NAMES) => Err(fail(
                "login_refused",
                "the device does not know this SNMPv3 user",
            )),
            Some(WRONG_DIGESTS) => Err(fail(
                "login_refused",
                "the device refused the login: check the authentication password and protocol",
            )),
            Some(DECRYPTION_ERRORS) => Err(fail(
                "login_refused",
                "the device could not decrypt the request: check the privacy password",
            )),
            Some(UNSUPPORTED_SEC_LEVELS) => Err(fail(
                "login_refused",
                "the device does not allow this user with both authentication and privacy",
            )),
            Some(UNKNOWN_ENGINE_IDS) => Err(fail(
                "engine_changed",
                "the device's SNMP engine id changed",
            )),
            _ => Err(fail(
                "refused",
                "the device sent a report Fathom does not read",
            )),
        };
    }
    if !authenticated || m.flags & PRIV == 0 {
        return Err(fail(
            "malformed",
            "the device answered without authentication and privacy",
        ));
    }
    if s.request_id != id as i64 {
        return Err(fail("malformed", "the answer is for another request"));
    }
    if s.error_status != 0 {
        // tooBig (1) is handled by the caller asking for fewer rows.
        let what = match s.error_status {
            1 => return Err(fail("too_big", "the answer would have been too big")),
            2 => "noSuchName",
            5 => "genErr",
            6 => "noAccess",
            16 => "authorizationError",
            _ => "an error",
        };
        return Err(fail(
            "refused",
            format!("the device answered {what} (index {})", s.error_index),
        ));
    }
    Ok(Answer::Varbinds(s.varbinds))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reader_can_never_build_a_set_request() {
        // RFC 3416 §3: SetRequest-PDU is [3], 0xA3. Every PDU the reader can build, by type.
        for kind in [
            ReadPdu::Get,
            ReadPdu::GetNext,
            ReadPdu::GetBulk {
                max_repetitions: 10,
            },
        ] {
            let p = pdu(kind, 1, &[&[1, 3, 6, 1, 2, 1, 1, 1, 0]]);
            assert_ne!(p[0], 0xA3);
            assert!(matches!(p[0], 0xA0 | 0xA1 | 0xA5));
        }
    }

    #[test]
    fn a_signed_message_verifies_and_a_changed_byte_does_not() {
        let engine = Engine {
            id: vec![0x80, 0, 0x1f, 0x88, 4],
            boots: 2,
            time: 100,
        };
        let auth = Auth::Sha256;
        let key = usm::localise(
            auth,
            &usm::password_to_key(auth, b"authpassword"),
            &engine.id,
        );
        let zeros = vec![0u8; auth.mac_len()];
        let data = ber::octets(b"encrypted bytes");
        let unsigned = message(7, AUTH | PRIV, &engine, b"fathom", &zeros, &[1; 8], &data);
        let mac = usm::mac(auth, &key, &unsigned);
        let signed = message(7, AUTH | PRIV, &engine, b"fathom", &mac, &[1; 8], &data);
        let m = parse_message(&signed).unwrap();
        assert_eq!(m.msg_id, 7);
        assert_eq!(m.engine, engine);
        assert_eq!(m.user, b"fathom");
        let mut zeroed = signed.clone();
        zeroed[m.auth_at..m.auth_at + m.auth_params.len()].fill(0);
        assert_eq!(zeroed, unsigned);
        assert!(usm::same_mac(&usm::mac(auth, &key, &zeroed), m.auth_params));
    }
}

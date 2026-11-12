//! **The server's one outbound HTTPS client** (ADR-0071 part four): HTTP/1.1 over rustls, to an
//! outside vault and nowhere else.
//!
//! **C7's one exception lives here.** rustls's `ring` provider carries C and assembly; the owner
//! allowed it on 2026-10-26 (sign-off card r34-vault-ring, A) only underneath `rustls` and only
//! for this. `deny.toml` keeps `ring` banned for every other parent, and nothing outside this
//! module names `rustls` or `tokio_rustls`.
//!
//! What it does, so a reviewer need not read rustls to know:
//! - **Certificates are checked** against Mozilla's roots (`webpki-roots`), plus the operator's
//!   own CA when `FATHOM_OUTSIDE_VAULT_CA` names a PEM file, for a vault on a home network with
//!   a private CA. There is no "skip verification" switch, by design.
//! - TLS 1.2 and 1.3 with rustls's safe defaults; no ALPN, so the server speaks HTTP/1.1.
//! - One request per connection (`Connection: close`), no redirects followed (a 3xx is answered
//!   in words), at most [`super::MAX_ANSWER_BYTES`] read, and [`TIMEOUT`] for the whole round.
//! - **Where it may connect** ([`choose`]): a host the operator listed in
//!   `FATHOM_OUTSIDE_VAULT_HOSTS`, wherever it resolves; any other host only when every address
//!   it resolves to is a public one ([`internal`]). The name is resolved once and the connection
//!   goes to the address that was checked, so a name cannot answer one address for the check and
//!   another for the connection.
//!
//! It is ~200 lines rather than a client crate because the job is two requests, and hyper's
//! client feature would add crates the owner did not approve.

use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{HttpAnswer, HttpRequest, Net, NetError, NetFuture, MAX_ANSWER_BYTES};

/// Connect, TLS, request and answer, all of it.
pub const TIMEOUT: Duration = Duration::from_secs(20);

pub struct Https {
    connector: tokio_rustls::TlsConnector,
    /// The hosts the operator listed: the only ones reached at a private address.
    listed: Vec<String>,
}

/// What a person is told when a host the operator did not list could not be reached, whatever
/// the reason: one sentence, so the server's answers do not map the network around it.
const NOT_REACHED: &str = "Fathom could not reach a vault at that address. If the vault is on a private network, this server's operator lists its host in FATHOM_OUTSIDE_VAULT_HOSTS first";

/// Whether an address is one the public internet does not route: this machine, a private or
/// shared network, link-local (where cloud metadata services live), documentation, multicast or
/// reserved space. The blocks are IANA's special-purpose registries, IPv4 and IPv6, every entry
/// not marked globally reachable (both last updated 2025-10-09, read 2026-11-12), with multicast.
/// An IPv4 address written as IPv6 (mapped, or behind the NAT64 prefix 64:ff9b::/96) is judged
/// as the IPv4 address it carries, as OWASP's SSRF cheat sheet asks (read 2026-11-12). Teredo
/// and 6to4 carry an IPv4 address too and are refused whole.
pub fn internal(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            matches!(
                o,
                [0, ..]
                    | [10, ..]
                    | [100, 64..=127, ..]
                    | [127, ..]
                    | [169, 254, ..]
                    | [172, 16..=31, ..]
                    | [192, 0, 0, _]
                    | [192, 0, 2, _]
                    | [192, 88, 99, _]
                    | [192, 168, ..]
                    | [198, 18..=19, ..]
                    | [198, 51, 100, _]
                    | [203, 0, 113, _]
                    | [224..=255, ..]
            )
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return internal(IpAddr::V4(v4));
            }
            let s = v6.segments();
            if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let [a, b] = s[6].to_be_bytes();
                let [c, d] = s[7].to_be_bytes();
                return internal(IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d)));
            }
            // Global unicast is 2000::/3; everything else is loopback, unspecified, unique-local,
            // link-local, multicast or reserved.
            s[0] & 0xe000 != 0x2000
                || (s[0] == 0x2001 && s[1] < 0x0200)
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || s[0] == 0x2002
                || s[0] & 0xfff0 == 0x3ff0
        }
    }
}

/// The address to connect to, from the ones a host resolved to. A host the operator listed is
/// reached at its first address. Any other is reached only when every address is public: a name
/// with one public and one private address is refused, not tried.
pub fn choose(
    addresses: &[std::net::SocketAddr],
    listed: bool,
) -> Result<std::net::SocketAddr, NetError> {
    let first = *addresses
        .first()
        .ok_or_else(|| NetError(NOT_REACHED.to_string()))?;
    if !listed && addresses.iter().any(|a| internal(a.ip())) {
        return Err(NetError(NOT_REACHED.to_string()));
    }
    Ok(first)
}

impl Https {
    /// `extra_ca`: a PEM file of certificates to trust beside Mozilla's roots. `listed`: the
    /// hosts in `FATHOM_OUTSIDE_VAULT_HOSTS`.
    pub fn new(extra_ca: Option<&std::path::Path>, listed: Vec<String>) -> Result<Self, String> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Some(path) = extra_ca {
            let mut added = 0;
            for cert in CertificateDer::pem_file_iter(path)
                .map_err(|e| format!("FATHOM_OUTSIDE_VAULT_CA: {e}"))?
            {
                let cert = cert.map_err(|e| format!("FATHOM_OUTSIDE_VAULT_CA: {e}"))?;
                roots
                    .add(cert)
                    .map_err(|e| format!("FATHOM_OUTSIDE_VAULT_CA: {e}"))?;
                added += 1;
            }
            if added == 0 {
                return Err("FATHOM_OUTSIDE_VAULT_CA holds no certificate".to_string());
            }
        }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
        Ok(Self {
            connector: tokio_rustls::TlsConnector::from(Arc::new(config)),
            listed,
        })
    }

    async fn round(&self, req: HttpRequest) -> Result<HttpAnswer, NetError> {
        let say = |s: &str| NetError(s.to_string());
        let host = req.url.bare_host().to_string();
        let name = ServerName::try_from(host.clone())
            .map_err(|_| say("that address is not a name a certificate can carry"))?;
        let listed = self.listed.iter().any(|h| h == &req.url.host);
        let unreached = || {
            say(if listed {
                "Fathom could not reach that address; check it, and that this server can reach it"
            } else {
                NOT_REACHED
            })
        };
        // Resolved once; the connection goes to the address that was checked.
        let addresses: Vec<std::net::SocketAddr> =
            tokio::net::lookup_host((host.as_str(), req.url.port))
                .await
                .map_err(|_| unreached())?
                .collect();
        let address = choose(&addresses, listed)?;
        let tcp = tokio::net::TcpStream::connect(address)
            .await
            .map_err(|_| unreached())?;
        let mut tls = self.connector.connect(name, tcp).await.map_err(|e| {
            tracing::info!(error = %e, "outside vault TLS failed");
            say("the vault's certificate was not one Fathom trusts, or TLS failed; a vault with a private CA needs FATHOM_OUTSIDE_VAULT_CA")
        })?;
        let mut head = format!(
            "{} {}{} HTTP/1.1\r\nHost: {}\r\nUser-Agent: Fathom\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n",
            req.method,
            req.url.prefix,
            req.path,
            req.url.host_header(),
            req.body.len()
        );
        for (k, v) in &req.headers {
            if v.contains(['\r', '\n']) {
                return Err(say("a header carried a line break"));
            }
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(&req.body);
        tls.write_all(&out)
            .await
            .map_err(|_| say("the vault closed the connection"))?;
        out.iter_mut().for_each(|b| *b = 0);
        let mut raw = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match tls.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    raw.extend_from_slice(&buf[..n]);
                    if raw.len() > MAX_ANSWER_BYTES + 64 * 1024 {
                        return Err(say("the vault's answer was larger than Fathom reads"));
                    }
                }
                // A server that closes without close_notify after a complete answer is common;
                // the framing below decides whether the answer was complete.
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(_) => return Err(say("the connection to the vault broke")),
            }
        }
        parse_answer(&raw)
    }
}

impl Net for Https {
    fn send(&self, req: HttpRequest) -> NetFuture<'_> {
        Box::pin(async move {
            tokio::time::timeout(TIMEOUT, self.round(req))
                .await
                .unwrap_or_else(|_| Err(NetError("the vault took too long to answer".to_string())))
        })
    }
}

/// One HTTP/1.1 answer: status, headers, then a body framed by chunks, a length, or the close.
pub fn parse_answer(raw: &[u8]) -> Result<HttpAnswer, NetError> {
    let say = |s: &str| NetError(s.to_string());
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| say("the vault's answer was cut short"))?;
    let head =
        std::str::from_utf8(&raw[..end]).map_err(|_| say("the vault's answer was not HTTP"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let (Some(version), Some(code)) = (parts.next(), parts.next()) else {
        return Err(say("the vault's answer was not HTTP"));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(say("the vault's answer was not HTTP/1.1"));
    }
    let status: u16 = code
        .parse()
        .ok()
        .filter(|c| (100..600).contains(c))
        .ok_or_else(|| say("the vault's answer was not HTTP"))?;
    if (300..400).contains(&status) {
        return Err(say(
            "the vault's address redirects; give Fathom the address it redirects to",
        ));
    }
    let mut length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            return Err(say("the vault's answer was not HTTP"));
        };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "content-length" {
            let n: usize = v
                .parse()
                .map_err(|_| say("the vault's answer was not HTTP"))?;
            if length.is_some_and(|l| l != n) {
                return Err(say("the vault's answer was not HTTP"));
            }
            length = Some(n);
        } else if k == "transfer-encoding" {
            if !v.eq_ignore_ascii_case("chunked") {
                return Err(say(
                    "the vault's answer used an encoding Fathom does not read",
                ));
            }
            chunked = true;
        }
    }
    let rest = &raw[end + 4..];
    let body = if chunked {
        let mut body = Vec::new();
        let mut at = 0;
        loop {
            let nl = rest[at..]
                .windows(2)
                .position(|w| w == b"\r\n")
                .ok_or_else(|| say("the vault's answer was cut short"))?;
            let size_text = std::str::from_utf8(&rest[at..at + nl])
                .map_err(|_| say("the vault's answer was not HTTP"))?;
            let size_text = size_text.split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(size_text, 16)
                .map_err(|_| say("the vault's answer was not HTTP"))?;
            at += nl + 2;
            if size == 0 {
                break;
            }
            if size > MAX_ANSWER_BYTES || at + size + 2 > rest.len() {
                return Err(say("the vault's answer was cut short"));
            }
            body.extend_from_slice(&rest[at..at + size]);
            if body.len() > MAX_ANSWER_BYTES {
                return Err(say("the vault's answer was larger than Fathom reads"));
            }
            at += size;
            if &rest[at..at + 2] != b"\r\n" {
                return Err(say("the vault's answer was not HTTP"));
            }
            at += 2;
        }
        body
    } else if let Some(n) = length {
        if rest.len() < n {
            return Err(say("the vault's answer was cut short"));
        }
        rest[..n].to_vec()
    } else {
        rest.to_vec()
    };
    if body.len() > MAX_ANSWER_BYTES {
        return Err(say("the vault's answer was larger than Fathom reads"));
    }
    Ok(HttpAnswer { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_reads_a_length_a_chunked_body_and_a_close() {
        let a = parse_answer(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!((a.status, a.body.as_slice()), (200, &b"{}"[..]));
        let a = parse_answer(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4;x=y\r\n\":1}\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(a.body, b"{\"a\":1}");
        let a = parse_answer(b"HTTP/1.0 401 Unauthorized\r\n\r\nno").unwrap();
        assert_eq!((a.status, a.body.as_slice()), (401, &b"no"[..]));
    }

    fn ip(s: &str) -> std::net::IpAddr {
        s.parse().unwrap()
    }

    /// The addresses a member could type, or point a name of their own at, to make the server
    /// call something beside it: itself, the private networks, a cloud's metadata service, and
    /// each of those written as IPv6.
    #[test]
    fn only_a_public_address_is_reached_unless_the_operator_listed_the_host() {
        for inside in [
            "127.0.0.1",
            "0.0.0.0",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.10",
            "100.64.0.1",
            "169.254.169.254",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "64:ff9b::a00:5",
            "64:ff9b::7f00:1",
            "fe80::1",
            "fd00:ec2::254",
            "fc00::1",
            "ff02::1",
            "2001:db8::1",
            "2001::1",
            "2002:7f00:1::",
            "3fff::1",
            "5f00::1",
        ] {
            assert!(internal(ip(inside)), "{inside}");
        }
        for public in [
            "1.1.1.1",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "192.0.1.1",
            "198.20.0.1",
            "223.255.255.254",
            "2606:4700:4700::1111",
            "2a00:1450:4001:81b::200e",
            "64:ff9b::808:808",
        ] {
            assert!(!internal(ip(public)), "{public}");
        }

        let at = |a: &str| std::net::SocketAddr::new(ip(a), 443);
        assert_eq!(choose(&[at("1.1.1.1")], false).unwrap(), at("1.1.1.1"));
        assert!(choose(&[at("192.168.1.10")], false).is_err());
        // One public and one private address: a name set up to pass the check and then
        // connect inside. Refused whole.
        assert!(choose(&[at("1.1.1.1"), at("127.0.0.1")], false).is_err());
        assert!(choose(&[], false).is_err());
        // The operator's list is how a vault on a private network is reached.
        assert_eq!(
            choose(&[at("192.168.1.10")], true).unwrap(),
            at("192.168.1.10")
        );
    }

    #[test]
    fn it_refuses_what_it_cannot_frame() {
        for bad in [
            &b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{}"[..],
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{}",
            b"HTTP/1.1 302 Found\r\nLocation: http://x\r\n\r\n",
            b"HTTP/2 200\r\n\r\n",
            b"garbage",
        ] {
            assert!(
                parse_answer(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }
}

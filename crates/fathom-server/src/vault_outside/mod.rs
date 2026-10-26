//! **Outside vaults: logins Fathom reads from a person's own Vaultwarden or Delinea Secret
//! Server** (ADR-0071 part four; owner's answers 2026-10-26: r34-vault-read A, "Make sure this is
//! per user, but the Admin can reject/pull whatever as needed", r34-vault-crates, r34-vault-ring
//! A). `migrations/0045_vault_outside.sql` carries the reasoning for the tables;
//! `0047_vault_delinea.sql` adds the second provider.
//!
//! # The shape
//!
//! A member connects an account in their own Vaultwarden that sees **one collection and nothing
//! else** (the three [`vaultwarden::checks`]). Their browser opens the account's keys with its
//! master password and hands Fathom only the organisation key that collection is under, with the
//! account's personal API key; the server seals both under `vault.key` and never sees the
//! master password. The person then **pulls** logins from that collection into Fathom, one at a
//! time, each marked with the devices it is used on. Fathom reads a pulled login's user name and
//! password from the outside vault each time it uses it, after the checks pass again; it keeps
//! no copy.
//!
//! **Secret Server** ([`delinea`]) has the same shape with one folder for the collection: the
//! server signs in with an application account's user name and password (sealed the same way),
//! the two [`delinea::checks`] run on what the account can see, and a use reads the one secret.
//! Secret Server names folders and secrets in the clear, so nothing is opened in a browser.
//!
//! **Passbolt** ([`passbolt`]) is the third, and optional: it seals everything with OpenPGP, which
//! the server leaves to a separate helper process. Fathom finishes an invited account's setup
//! with a key of its own, the connection **waits** until one folder is shared with that account,
//! and the first passing check binds it ([`set_up`], [`after_check`]).
//!
//! # What enforces what, by function
//!
//! - [`connect`]: any member, for themselves. The checks pass, and the organisation key opens the
//!   collection's sealed name and that name is the one the person typed, so the key handed over
//!   is the key of that collection and no other.
//! - [`plan`] / [`after_check`]: the owner or an admin re-runs the checks ("Check now"); a failed
//!   check **stops** the connection, with the reason on the admins' page and the history.
//! - [`pull`]: the owner only, on a connection that is on, for a login in its collection. A login
//!   an admin removed is not pulled again by its owner; an admin restores it ([`restore`]).
//! - [`remove`], [`disconnect`]: the owner or any admin. Disconnecting empties the sealed
//!   secrets; the rows stay.
//! - [`use_plan`] / [`use_finish`]: Fathom opens a pulled login for one purpose on one device it
//!   is marked as used on, for a person who may draw on that design, after the checks pass again.
//!   The `vault_outside_read` chain entry is filed BEFORE the item is opened.
//!
//! **What this protects against, and what it does not**, in the same words as Mode B: the sealed
//! secrets protect against a stolen database or backup without `vault.key`. They do not protect
//! against someone who has taken over the running server, who can ask this module to read the
//! outside vault. The connect screen says so before anyone connects.

pub mod bitwarden;
pub mod delinea;
pub mod https;
pub mod passbolt;
pub mod vaultwarden;

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::authority::Capability;
use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{self};
use crate::foreign_json;
use crate::grants::{self, Authority, AuthorityError};
use crate::vault::{entry_metadata, hex, is_steward, unhex, Meta, VaultError};
use crate::vault_fathom::{wipe, wipe_string, FathomKey, UsedLogin, PURPOSES};

use bitwarden::{BwKey, OpenError};
use vaultwarden::{CheckLine, SyncAnswer};

const TAG_SECRET_KEY: &[u8] = b"fathom/vault/outside/secret/key/v1";
const TAG_SECRET_AAD: &[u8] = b"fathom/vault/outside/secret/v1";
const TAG_META_KEY: &[u8] = b"fathom/vault/outside/meta/key/v1";
const TAG_META_AAD: &[u8] = b"fathom/vault/outside/meta/v1";

/// The longest answer Fathom reads from an outside vault. A collection Fathom may use is small;
/// a vault that answers more is not one this was built for.
pub const MAX_ANSWER_BYTES: usize = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The network seam
// ---------------------------------------------------------------------------

/// Where an outside vault is: always `https`, a host, a port, and the path it is served under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutsideUrl {
    pub host: String,
    pub port: u16,
    /// Empty, or starting with `/` and not ending with one.
    pub prefix: String,
}

impl OutsideUrl {
    /// `https://host[:port][/path]`, nothing else: no user name, no query, no fragment. The
    /// host is lower-cased; an IPv6 literal keeps its brackets.
    pub fn parse(text: &str) -> Result<Self, VaultError> {
        let bad = || {
            VaultError::Malformed(
                "the vault's address is https:// and a host name, like https://vault.example.org",
            )
        };
        let text = text.trim();
        if text.len() > 300 || text.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(bad());
        }
        let rest = text.strip_prefix("https://").ok_or(VaultError::Malformed(
            "Fathom reaches an outside vault over https only",
        ))?;
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        if authority.contains('@') || path.contains(['?', '#']) || authority.is_empty() {
            return Err(bad());
        }
        let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
            let end = v6.find(']').ok_or_else(bad)?;
            let host = &v6[..end];
            if host.parse::<std::net::Ipv6Addr>().is_err() {
                return Err(bad());
            }
            let after = &v6[end + 1..];
            (format!("[{}]", host.to_ascii_lowercase()), after)
        } else {
            match authority.rfind(':') {
                Some(i) => (authority[..i].to_ascii_lowercase(), &authority[i..]),
                None => (authority.to_ascii_lowercase(), ""),
            }
        };
        let port = match port {
            "" => 443,
            p => p
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .filter(|p| *p != 0)
                .ok_or_else(bad)?,
        };
        if !host.starts_with('[')
            && (host.is_empty()
                || host.len() > 253
                || !host
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
                || host.starts_with(['.', '-'])
                || host.ends_with(['.', '-']))
        {
            return Err(bad());
        }
        let prefix = path.trim_end_matches('/').to_string();
        if !prefix
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'-' | b'_' | b'.' | b'~'))
            || prefix.contains("//")
            || prefix.split('/').any(|s| s == ".." || s == ".")
        {
            return Err(bad());
        }
        Ok(Self { host, port, prefix })
    }

    /// The host as a TLS name or socket address takes it: an IPv6 literal without brackets.
    pub fn bare_host(&self) -> &str {
        self.host.trim_start_matches('[').trim_end_matches(']')
    }

    pub fn to_text(&self) -> String {
        if self.port == 443 {
            format!("https://{}{}", self.host, self.prefix)
        } else {
            format!("https://{}:{}{}", self.host, self.port, self.prefix)
        }
    }

    /// The `Host` header.
    pub fn host_header(&self) -> String {
        if self.port == 443 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

pub struct HttpRequest {
    pub method: &'static str,
    pub url: OutsideUrl,
    /// Starts with `/`, after the prefix.
    pub path: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

pub struct HttpAnswer {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Why the network failed. The words are for a person and carry no secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetError(pub String);

pub type NetFuture<'a> = Pin<Box<dyn Future<Output = Result<HttpAnswer, NetError>> + Send + 'a>>;

/// One request to an outside vault. [`https::Https`] in the server; a stand-in in tests.
pub trait Net: Send + Sync {
    fn send(&self, req: HttpRequest) -> NetFuture<'_>;
}

/// What the server reaches outside vaults with, and where it may reach them.
pub struct Outside {
    pub net: Box<dyn Net>,
    /// `FATHOM_OUTSIDE_VAULT_HOSTS`: when set, the only hosts a person may connect to.
    pub allowed_hosts: Option<Vec<String>>,
    /// `FATHOM_PASSBOLT_HELPER`: the Passbolt helper, when the operator runs one.
    pub pgp: Option<Box<dyn passbolt::Pgp>>,
}

struct Refusing;

impl Net for Refusing {
    fn send(&self, _req: HttpRequest) -> NetFuture<'_> {
        Box::pin(async { Err(NetError("this server reaches no outside vault".to_string())) })
    }
}

impl Outside {
    /// A server that reaches nothing: for tests and tools that build a state without one.
    pub fn refusing() -> Self {
        Self {
            net: Box::new(Refusing),
            allowed_hosts: None,
            pgp: None,
        }
    }

    pub fn check_host(&self, url: &OutsideUrl) -> Result<(), VaultError> {
        match &self.allowed_hosts {
            Some(list) if !list.iter().any(|h| h == &url.host) => Err(VaultError::NotAllowed(
                "this server's operator has not allowed outside vaults at that address",
            )),
            _ => Ok(()),
        }
    }
}

fn form_encode(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut out = String::new();
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        for (j, part) in [k, v].iter().enumerate() {
            if j == 1 {
                out.push('=');
            }
            for b in part.bytes() {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                    out.push(b as char);
                } else {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out.into_bytes()
}

fn unreachable(why: impl Into<String>) -> VaultError {
    VaultError::OutsideUnreachable(why.into())
}

/// An API key as Vaultwarden issues one: `user.<uuid>` and a secret of plain characters.
pub fn check_api_key(client_id: &str, secret: &str) -> Result<(), VaultError> {
    let id_ok = client_id.strip_prefix("user.").is_some_and(|u| {
        (1..=64).contains(&u.len()) && u.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
    });
    if !id_ok {
        return Err(VaultError::Malformed(
            "the client id is the one Vaultwarden shows under Account settings › Security › Keys, starting user.",
        ));
    }
    if secret.is_empty() || secret.len() > 200 || !secret.bytes().all(|c| c.is_ascii_graphic()) {
        return Err(VaultError::Malformed(
            "the client secret is the one Vaultwarden shows beside the client id",
        ));
    }
    Ok(())
}

/// A device id as Vaultwarden stores one: a UUID, fixed per connection.
pub fn new_device_id() -> Result<String, VaultError> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| VaultError::Corrupt("no randomness"))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

pub fn check_device_id(id: &str) -> Result<(), VaultError> {
    let ok = id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        });
    if ok {
        Ok(())
    } else {
        Err(VaultError::Malformed("device id"))
    }
}

/// `POST /identity/connect/token`, the personal API key login.
pub async fn vw_login(
    outside: &Outside,
    url: &OutsideUrl,
    client_id: &str,
    secret: &str,
    device_id: &str,
) -> Result<vaultwarden::Token, VaultError> {
    outside.check_host(url)?;
    let body = form_encode(&[
        ("grant_type", "client_credentials"),
        ("scope", "api"),
        ("client_id", client_id),
        ("client_secret", secret),
        ("device_identifier", device_id),
        ("device_name", vaultwarden::DEVICE_NAME),
        ("device_type", vaultwarden::DEVICE_TYPE_SERVER),
    ]);
    let answer = outside
        .net
        .send(HttpRequest {
            method: "POST",
            url: url.clone(),
            path: "/identity/connect/token".to_string(),
            headers: vec![(
                "Content-Type",
                "application/x-www-form-urlencoded; charset=utf-8".to_string(),
            )],
            body,
        })
        .await
        .map_err(|e| unreachable(e.0))?;
    match answer.status {
        200 => {}
        400 | 401 => {
            return Err(VaultError::OutsideRefused(
                "the vault refused the API key: check the client id and secret, and that the account is enabled"
                    .to_string(),
            ))
        }
        429 => return Err(unreachable("the vault asked Fathom to slow down; try again in a minute")),
        s => return Err(unreachable(format!("the vault answered {s} to the sign-in"))),
    }
    let v = foreign_json::parse(&answer.body)
        .map_err(|_| unreachable("the vault's sign-in answer was not one Fathom reads; is that address a Vaultwarden server?"))?;
    vaultwarden::read_token(&v).map_err(|e| unreachable(e.0))
}

/// `GET /api/sync?excludeDomains=true`.
pub async fn vw_sync(
    outside: &Outside,
    url: &OutsideUrl,
    token: &vaultwarden::Token,
) -> Result<SyncAnswer, VaultError> {
    outside.check_host(url)?;
    let answer = outside
        .net
        .send(HttpRequest {
            method: "GET",
            url: url.clone(),
            path: "/api/sync?excludeDomains=true".to_string(),
            headers: vec![("Authorization", format!("Bearer {}", token.access_token))],
            body: Vec::new(),
        })
        .await
        .map_err(|e| unreachable(e.0))?;
    if answer.status != 200 {
        return Err(unreachable(format!(
            "the vault answered {} when Fathom asked for the collection",
            answer.status
        )));
    }
    let v = foreign_json::parse(&answer.body)
        .map_err(|_| unreachable("the vault's answer was not one Fathom reads"))?;
    vaultwarden::read_sync(&v).map_err(|e| unreachable(e.0))
}

/// Sign in and read, the two calls every check makes.
pub async fn vw_read(
    outside: &Outside,
    url: &OutsideUrl,
    client_id: &str,
    secret: &str,
    device_id: &str,
) -> Result<(vaultwarden::Token, SyncAnswer), VaultError> {
    let token = vw_login(outside, url, client_id, secret, device_id).await?;
    let sync = vw_sync(outside, url, &token).await?;
    Ok((token, sync))
}

/// A Secret Server application account's user name and password, as Fathom accepts them.
pub fn check_account(user: &str, password: &str) -> Result<(), VaultError> {
    if user.is_empty() || user.chars().count() > 256 || user.chars().any(char::is_control) {
        return Err(VaultError::Malformed("the account's user name"));
    }
    if password.is_empty() || password.len() > 1024 || password.chars().any(char::is_control) {
        return Err(VaultError::Malformed("the account's password"));
    }
    Ok(())
}

async fn dl_json(
    outside: &Outside,
    url: &OutsideUrl,
    token: &str,
    path: String,
) -> Result<Json, VaultError> {
    let answer = outside
        .net
        .send(HttpRequest {
            method: "GET",
            url: url.clone(),
            path,
            headers: vec![("Authorization", format!("Bearer {token}"))],
            body: Vec::new(),
        })
        .await
        .map_err(|e| unreachable(e.0))?;
    match answer.status {
        200 => {}
        401 | 403 => {
            return Err(VaultError::OutsideRefused(
                "the vault refused the account Fathom reads with; it may need View on its folder, or a secret may need a check-out or a comment, which Fathom does not do"
                    .to_string(),
            ))
        }
        s => return Err(unreachable(format!("the vault answered {s} when Fathom read it"))),
    }
    foreign_json::parse(&answer.body)
        .map_err(|_| unreachable("the vault's answer was not one Fathom reads"))
}

/// Sign in to Secret Server and read what the account sees: its folders, its secrets, and the
/// one secret `item` when a use asks for it.
pub async fn dl_read(
    outside: &Outside,
    url: &OutsideUrl,
    user: &str,
    password: &str,
    item: Option<&str>,
) -> Result<delinea::Answer, VaultError> {
    outside.check_host(url)?;
    let body = form_encode(&[
        ("username", user),
        ("password", password),
        ("grant_type", "password"),
    ]);
    let answer = outside
        .net
        .send(HttpRequest {
            method: "POST",
            url: url.clone(),
            path: "/oauth2/token".to_string(),
            headers: vec![(
                "Content-Type",
                "application/x-www-form-urlencoded; charset=utf-8".to_string(),
            )],
            body,
        })
        .await
        .map_err(|e| unreachable(e.0))?;
    match answer.status {
        200 => {}
        400 | 401 => {
            return Err(VaultError::OutsideRefused(
                "the vault refused the account: check its user name and password, and that it may sign in to the API (an account that needs a one-time code cannot be used)"
                    .to_string(),
            ))
        }
        s => return Err(unreachable(format!("the vault answered {s} to the sign-in"))),
    }
    let v = foreign_json::parse(&answer.body).map_err(|_| {
        unreachable(
            "the vault's sign-in answer was not one Fathom reads; is that address a Secret Server?",
        )
    })?;
    let mut token = delinea::read_token(&v).map_err(|e| unreachable(e.0))?;
    let take = delinea::TAKE;
    let read = async {
        let folders = delinea::read_folders(
            &dl_json(outside, url, &token, format!("/api/v1/folders?take={take}")).await?,
        )
        .map_err(|e| unreachable(e.0))?;
        let secrets = delinea::read_secrets(
            &dl_json(outside, url, &token, format!("/api/v1/secrets?take={take}")).await?,
        )
        .map_err(|e| unreachable(e.0))?;
        let secret = match item {
            None => None,
            Some(id) => {
                if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(VaultError::Malformed("the secret"));
                }
                Some(
                    delinea::read_secret(
                        &dl_json(outside, url, &token, format!("/api/v1/secrets/{id}")).await?,
                    )
                    .map_err(|e| unreachable(e.0))?,
                )
            }
        };
        Ok(delinea::Answer {
            folders,
            secrets,
            secret,
        })
    }
    .await;
    wipe_string(&mut token);
    read
}

/// One round's answer from either kind of vault.
pub enum Answer {
    Vaultwarden(SyncAnswer),
    Delinea(delinea::Answer),
    Passbolt(passbolt::Answer),
}

impl From<SyncAnswer> for Answer {
    fn from(s: SyncAnswer) -> Self {
        Self::Vaultwarden(s)
    }
}

impl Answer {
    /// The checks, for the connection's collection or folder.
    pub fn checks(&self, collection: Option<&str>, name: Option<&str>) -> Vec<CheckLine> {
        match self {
            Self::Vaultwarden(s) => vaultwarden::checks(s, collection, name),
            Self::Delinea(a) => delinea::checks(a, collection, name),
            Self::Passbolt(a) => passbolt::checks(a, collection, name),
        }
    }
}

/// Sign in and read, with a connection's own secrets. `item` is the secret a use needs, read in
/// the same round (Secret Server answers a password only for one secret at a time; Vaultwarden's
/// sync already holds every item).
pub async fn read(
    outside: &Outside,
    url: &OutsideUrl,
    s: &Secrets,
    device_id: &str,
    item: Option<&str>,
) -> Result<Answer, VaultError> {
    match s.provider {
        Provider::Vaultwarden => vw_read(outside, url, &s.client_id, &s.client_secret, device_id)
            .await
            .map(|(_, sync)| Answer::Vaultwarden(sync)),
        Provider::Delinea => dl_read(outside, url, &s.client_id, &s.client_secret, item)
            .await
            .map(Answer::Delinea),
        Provider::Passbolt => passbolt::read(outside, url, s, item)
            .await
            .map(Answer::Passbolt),
    }
}

// ---------------------------------------------------------------------------
// What is sealed under vault.key
// ---------------------------------------------------------------------------

/// Which kind of outside vault a connection is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Vaultwarden,
    Delinea,
    Passbolt,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vaultwarden => "vaultwarden",
            Self::Delinea => "delinea",
            Self::Passbolt => "passbolt",
        }
    }

    pub fn parse(s: &str) -> Result<Self, VaultError> {
        match s {
            "vaultwarden" => Ok(Self::Vaultwarden),
            "delinea" => Ok(Self::Delinea),
            "passbolt" => Ok(Self::Passbolt),
            _ => Err(VaultError::Malformed("provider")),
        }
    }
}

/// A connection's secrets as the server holds them while it uses them. No `Debug`, `Clone`;
/// wiped on drop. `client_id` and `client_secret` are a Vaultwarden personal API key, or a Secret Server
/// application account's user name and password, or a Passbolt account's user id and Fathom's
/// own private key for it, armored. `org_key` is Vaultwarden's alone; the two pins Passbolt's.
pub struct Secrets {
    pub provider: Provider,
    pub client_id: String,
    pub client_secret: String,
    pub org_key: Option<BwKey>,
    /// Passbolt: the server key's fingerprint, as the person confirmed it at setup.
    pub server_fp: Option<String>,
    /// Passbolt: the shared metadata key's fingerprint, pinned when the connection was bound.
    pub metadata_fp: Option<String>,
}

impl Drop for Secrets {
    fn drop(&mut self) {
        wipe_string(&mut self.client_id);
        wipe_string(&mut self.client_secret);
    }
}

fn aad(tag: &[u8], organisation: &str, row: &str, key_id: &str) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, tag);
    crypto::lp(&mut a, organisation.as_bytes());
    crypto::lp(&mut a, row.as_bytes());
    crypto::lp(&mut a, key_id.as_bytes());
    a
}

fn seal(
    fk: &FathomKey,
    key_tag: &[u8],
    aad_tag: &[u8],
    organisation: &str,
    row: &str,
    mut plain: Vec<u8>,
) -> Result<(Vec<u8>, Vec<u8>, String), VaultError> {
    let key_id = fk.id().to_string();
    let nonce = crypto::random_nonce()?;
    let sealed = crypto::seal(
        &fk.subkey(key_tag, organisation),
        &nonce,
        &plain,
        &aad(aad_tag, organisation, row, &key_id),
    );
    wipe(&mut plain);
    Ok((sealed?, nonce.to_vec(), key_id))
}

#[allow(clippy::too_many_arguments)]
fn open(
    fk: &FathomKey,
    key_tag: &[u8],
    aad_tag: &[u8],
    organisation: &str,
    row: &str,
    key_id: &str,
    nonce: &[u8],
    ct: &[u8],
) -> Result<Vec<u8>, VaultError> {
    if key_id != fk.id().to_string() {
        return Err(VaultError::NotAllowed(
            "this was sealed under a different vault.key than this server has; restore that key file, or connect the outside vault again",
        ));
    }
    let nonce: [u8; crypto::NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| VaultError::Corrupt("outside vault nonce"))?;
    crypto::open(
        &fk.subkey(key_tag, organisation),
        &nonce,
        ct,
        &aad(aad_tag, organisation, row, key_id),
    )
    .map_err(|_| VaultError::Corrupt("an outside vault row did not open"))
}

fn seal_secrets(
    fk: &FathomKey,
    organisation: &str,
    connection: &str,
    s: &Secrets,
) -> Result<(Vec<u8>, Vec<u8>, String), VaultError> {
    let mut m = BTreeMap::new();
    m.insert("ci".to_string(), Json::Str(s.client_id.clone()));
    m.insert("cs".to_string(), Json::Str(s.client_secret.clone()));
    m.insert("pv".to_string(), Json::Str(s.provider.as_str().to_string()));
    if let Some(k) = &s.org_key {
        m.insert("ok".to_string(), Json::Str(hex(k.expose())));
    }
    if let Some(f) = &s.server_fp {
        m.insert("sf".to_string(), Json::Str(f.clone()));
    }
    if let Some(f) = &s.metadata_fp {
        m.insert("mf".to_string(), Json::Str(f.clone()));
    }
    let plain = Json::Obj(m).to_canonical_bytes();
    seal(
        fk,
        TAG_SECRET_KEY,
        TAG_SECRET_AAD,
        organisation,
        connection,
        plain,
    )
}

fn open_secrets(
    fk: &FathomKey,
    organisation: &str,
    connection: &str,
    key_id: &str,
    nonce: &[u8],
    ct: &[u8],
) -> Result<Secrets, VaultError> {
    let mut plain = open(
        fk,
        TAG_SECRET_KEY,
        TAG_SECRET_AAD,
        organisation,
        connection,
        key_id,
        nonce,
        ct,
    )?;
    let parsed = Json::parse_canonical(&plain);
    wipe(&mut plain);
    let Ok(Json::Obj(mut m)) = parsed else {
        return Err(VaultError::Corrupt("outside vault secrets"));
    };
    let (Some(Json::Str(ci)), Some(Json::Str(cs)), Some(Json::Str(pv))) =
        (m.remove("ci"), m.remove("cs"), m.remove("pv"))
    else {
        return Err(VaultError::Corrupt("outside vault secrets"));
    };
    let provider =
        Provider::parse(&pv).map_err(|_| VaultError::Corrupt("outside vault secrets"))?;
    let org_key = match (provider, m.remove("ok")) {
        (Provider::Vaultwarden, Some(Json::Str(mut ok))) => {
            let mut raw = unhex(&ok, Some(64), "organisation key")
                .map_err(|_| VaultError::Corrupt("outside vault secrets"))?;
            wipe_string(&mut ok);
            let k = BwKey::from_slice(&raw).ok_or(VaultError::Corrupt("outside vault secrets"));
            wipe(&mut raw);
            Some(k?)
        }
        (Provider::Delinea | Provider::Passbolt, None) => None,
        _ => return Err(VaultError::Corrupt("outside vault secrets")),
    };
    let fp = |v: Option<Json>| match v {
        None => Ok(None),
        Some(Json::Str(f)) if provider == Provider::Passbolt => Ok(Some(f)),
        _ => Err(VaultError::Corrupt("outside vault secrets")),
    };
    let server_fp = fp(m.remove("sf"))?;
    let metadata_fp = fp(m.remove("mf"))?;
    if provider == Provider::Passbolt && server_fp.is_none() {
        return Err(VaultError::Corrupt("outside vault secrets"));
    }
    Ok(Secrets {
        provider,
        client_id: ci,
        client_secret: cs,
        org_key,
        server_fp,
        metadata_fp,
    })
}

fn seal_meta(
    fk: &FathomKey,
    organisation: &str,
    item: &str,
    meta: &Meta,
) -> Result<(Vec<u8>, Vec<u8>, String), VaultError> {
    seal(
        fk,
        TAG_META_KEY,
        TAG_META_AAD,
        organisation,
        item,
        meta.to_canonical(),
    )
}

fn open_meta(
    fk: &FathomKey,
    organisation: &str,
    item: &str,
    key_id: &str,
    nonce: &[u8],
    ct: &[u8],
) -> Result<Meta, VaultError> {
    let plain = open(
        fk,
        TAG_META_KEY,
        TAG_META_AAD,
        organisation,
        item,
        key_id,
        nonce,
        ct,
    )?;
    Meta::from_canonical(&plain)
}

// ---------------------------------------------------------------------------
// Opening items with the organisation key
// ---------------------------------------------------------------------------

fn opened(e: OpenError) -> VaultError {
    match e {
        OpenError::Mac => VaultError::OutsideRefused(
            "an item in the vault did not open with the key Fathom was given; connect the vault again"
                .to_string(),
        ),
        _ => unreachable("an item in the vault is not in a form Fathom reads"),
    }
}

/// A login in the connection's collection, as the person picking one sees it.
#[derive(Clone, Debug)]
pub struct OutsideLogin {
    pub cipher_id: String,
    pub name: String,
    pub has_password: bool,
}

/// Every login in `collection` (a Vaultwarden collection or a Secret Server folder), by name.
fn logins_in(
    answer: &Answer,
    collection: &str,
    secrets: &Secrets,
) -> Result<Vec<OutsideLogin>, VaultError> {
    match answer {
        Answer::Vaultwarden(sync) => {
            let org = secrets
                .org_key
                .as_ref()
                .ok_or(VaultError::Corrupt("outside vault secrets"))?;
            vw_logins_in(sync, collection, org)
        }
        Answer::Delinea(a) => {
            let mut out: Vec<OutsideLogin> = a
                .secrets
                .iter()
                .filter(|s| s.folder_id.as_deref() == Some(collection))
                .map(|s| OutsideLogin {
                    cipher_id: s.id.clone(),
                    name: s.name.clone(),
                    // A summary does not say; the read at use does.
                    has_password: true,
                })
                .collect();
            out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            Ok(out)
        }
        Answer::Passbolt(a) => {
            let mut out: Vec<OutsideLogin> = a
                .items
                .iter()
                .filter(|i| i.folder_id.as_deref() == Some(collection) && !i.personal)
                .map(|i| OutsideLogin {
                    cipher_id: i.id.clone(),
                    name: i.name.clone().unwrap_or_default(),
                    has_password: true,
                })
                .collect();
            out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            Ok(out)
        }
    }
}

/// Every login in a Vaultwarden collection, opened with the item's own key where it has one.
fn vw_logins_in(
    sync: &SyncAnswer,
    collection: &str,
    org: &BwKey,
) -> Result<Vec<OutsideLogin>, VaultError> {
    let mut out = Vec::new();
    for c in &sync.ciphers {
        if c.deleted
            || c.kind != vaultwarden::CIPHER_LOGIN
            || !c.collection_ids.iter().any(|i| i == collection)
        {
            continue;
        }
        let own = bitwarden::item_key(c.protected_key.as_deref(), org).map_err(opened)?;
        let key = own.as_ref().unwrap_or(org);
        out.push(OutsideLogin {
            cipher_id: c.id.clone(),
            name: bitwarden::open_text(&c.protected_name, key).map_err(opened)?,
            has_password: c.protected_password.is_some() && c.view_password,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ItemView {
    pub id: String,
    pub cipher_id: String,
    pub name: String,
    pub kind: String,
    pub used_on: Vec<(String, String)>,
    pub state: String,
    pub removed_by: Option<String>,
    pub removed_by_name: Option<String>,
    pub reads: i64,
    pub last_read_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct ConnectionView {
    pub id: String,
    pub owner: String,
    pub owner_name: String,
    pub provider: String,
    pub url: String,
    pub collection_name: String,
    pub state: String,
    pub stopped_reason: Option<String>,
    pub checked_ms: Option<i64>,
    pub created_ms: i64,
    pub items: Vec<ItemView>,
}

fn opt(v: &Option<String>) -> Json {
    v.as_ref().map_or(Json::Null, |s| Json::Str(s.clone()))
}

fn obj(fields: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

impl ItemView {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("id", Json::Str(self.id.clone())),
            ("cipherId", Json::Str(self.cipher_id.clone())),
            ("name", Json::Str(self.name.clone())),
            ("kind", Json::Str(self.kind.clone())),
            (
                "usedOn",
                Json::Arr(
                    self.used_on
                        .iter()
                        .map(|(d, e)| {
                            obj(vec![
                                ("design", Json::Str(d.clone())),
                                ("element", Json::Str(e.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("state", Json::Str(self.state.clone())),
            ("removedBy", opt(&self.removed_by)),
            ("removedByName", opt(&self.removed_by_name)),
            ("reads", Json::Int(self.reads)),
            ("lastRead", self.last_read_ms.map_or(Json::Null, Json::Int)),
        ])
    }
}

impl ConnectionView {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("id", Json::Str(self.id.clone())),
            ("owner", Json::Str(self.owner.clone())),
            ("ownerName", Json::Str(self.owner_name.clone())),
            ("provider", Json::Str(self.provider.clone())),
            ("url", Json::Str(self.url.clone())),
            ("collectionName", Json::Str(self.collection_name.clone())),
            ("state", Json::Str(self.state.clone())),
            ("stoppedReason", opt(&self.stopped_reason)),
            ("checkedAt", self.checked_ms.map_or(Json::Null, Json::Int)),
            ("createdAt", Json::Int(self.created_ms)),
            (
                "items",
                Json::Arr(self.items.iter().map(ItemView::to_json).collect()),
            ),
        ])
    }
}

pub fn checks_json(lines: &[CheckLine]) -> Json {
    Json::Arr(
        lines
            .iter()
            .map(|l| {
                obj(vec![
                    ("id", Json::Str(l.id.to_string())),
                    ("passed", Json::Bool(l.passed)),
                    ("text", Json::Str(l.text.clone())),
                ])
            })
            .collect(),
    )
}

pub fn logins_json(logins: &[OutsideLogin]) -> Json {
    Json::Arr(
        logins
            .iter()
            .map(|l| {
                obj(vec![
                    ("cipherId", Json::Str(l.cipher_id.clone())),
                    ("name", Json::Str(l.name.clone())),
                    ("hasPassword", Json::Bool(l.has_password)),
                ])
            })
            .collect(),
    )
}

const CONNECTION_COLUMNS: &str = "c.id, c.owner, \
    coalesce((SELECT a.display_name FROM accounts a WHERE a.id = c.owner), ''), c.provider, \
    c.base_url, c.collection_name, c.state, c.stopped_reason, \
    (extract(epoch from c.checked_at) * 1000)::bigint, \
    (extract(epoch from c.created_at) * 1000)::bigint";

async fn items_of(
    tx: &Transaction<'_>,
    fk: &FathomKey,
    tenant: &str,
    connection: &str,
) -> Result<Vec<ItemView>, VaultError> {
    let rows = tx
        .query(
            "SELECT i.id, i.cipher_id, i.state, i.meta_key_id, i.meta_nonce, i.meta_ct, \
                    (SELECT a.display_name FROM accounts a WHERE a.id = i.removed_by), \
                    (SELECT count(*) FROM vault.outside_reads r WHERE r.organisation_id = i.organisation_id \
                        AND r.item_id = i.id), \
                    (SELECT (extract(epoch from max(r.read_at)) * 1000)::bigint FROM vault.outside_reads r \
                        WHERE r.organisation_id = i.organisation_id AND r.item_id = i.id), \
                    i.removed_by \
             FROM vault.outside_items i WHERE i.organisation_id = $1 AND i.connection_id = $2 \
             ORDER BY i.created_at, i.id",
            &[&tenant, &connection],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let id: String = r.get(0);
        let meta = open_meta(
            fk,
            tenant,
            &id,
            &r.get::<_, String>(3),
            &r.get::<_, Vec<u8>>(4),
            &r.get::<_, Vec<u8>>(5),
        );
        // A row sealed under another vault.key still shows, by its outside id, so an admin
        // can remove it; it is never used (`use_plan` opens the same seal and refuses).
        let (name, kind, used_on) = match meta {
            Ok(m) => (m.name, m.kind, m.used_on),
            Err(VaultError::NotAllowed(_)) => (
                "(sealed under another vault.key)".to_string(),
                "other".to_string(),
                Vec::new(),
            ),
            Err(e) => return Err(e),
        };
        out.push(ItemView {
            cipher_id: r.get(1),
            state: r.get(2),
            removed_by: r.get(9),
            removed_by_name: r.get(6),
            reads: r.get(7),
            last_read_ms: r.get(8),
            id,
            name,
            kind,
            used_on,
        });
    }
    Ok(out)
}

fn connection_view(r: &tokio_postgres::Row) -> ConnectionView {
    ConnectionView {
        id: r.get(0),
        owner: r.get(1),
        owner_name: r.get(2),
        provider: r.get(3),
        url: r.get(4),
        collection_name: r.get(5),
        state: r.get(6),
        stopped_reason: r.get(7),
        checked_ms: r.get(8),
        created_ms: r.get(9),
        items: Vec::new(),
    }
}

/// The connections this person sees: their own, and every one for an admin.
pub async fn list(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
) -> Result<Vec<ConnectionView>, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let steward = is_steward(tx, auth).await?;
    let rows = tx
        .query(
            &format!(
                "SELECT {CONNECTION_COLUMNS} FROM vault.outside_connections c \
                 WHERE c.organisation_id = $1 AND ($2 OR c.owner = $3) \
                 ORDER BY c.created_at, c.id"
            ),
            &[&tenant, &steward, &me],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let mut v = connection_view(r);
        v.items = items_of(tx, fk, &tenant, &v.id).await?;
        out.push(v);
    }
    Ok(out)
}

async fn view_of(
    tx: &Transaction<'_>,
    fk: &FathomKey,
    tenant: &str,
    connection: &str,
) -> Result<ConnectionView, VaultError> {
    let r = tx
        .query_opt(
            &format!(
                "SELECT {CONNECTION_COLUMNS} FROM vault.outside_connections c \
                 WHERE c.organisation_id = $1 AND c.id = $2"
            ),
            &[&tenant, &connection],
        )
        .await?
        .ok_or(VaultError::NotFound)?;
    let mut v = connection_view(&r);
    v.items = items_of(tx, fk, tenant, connection).await?;
    Ok(v)
}

// ---------------------------------------------------------------------------
// The acts
// ---------------------------------------------------------------------------

fn changed(
    stage: &str,
    connection: &str,
    owner: &str,
    by: &str,
    extra: Vec<(&'static str, Json)>,
) -> Vec<u8> {
    let mut fields: Vec<(&str, Json)> = vec![
        ("stage", Json::Str(stage.to_string())),
        ("connection", Json::Str(connection.to_string())),
        ("owner", Json::Str(owner.to_string())),
        ("by", Json::Str(by.to_string())),
    ];
    fields.extend(extra);
    entry_metadata(EntryType::VaultOutsideChanged, &fields)
}

async fn file_changed(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    metadata: &[u8],
) -> Result<i64, VaultError> {
    Ok(chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultOutsideChanged,
        metadata,
    )
    .await?
    .seq)
}

/// What a person sends to connect. The organisation key is the one their browser opened.
pub struct ConnectIn {
    pub provider: Provider,
    pub url: OutsideUrl,
    pub client_id: String,
    pub client_secret: String,
    pub device_id: String,
    pub collection_id: String,
    pub collection_name: String,
    /// Vaultwarden's, opened in the person's browser; `None` for Secret Server.
    pub org_key: Option<BwKey>,
}

/// Connect, after [`read`]'s first round with the same credentials. See the module comment.
pub async fn connect(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    input: ConnectIn,
    answer: &Answer,
) -> Result<ConnectionView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let name = input
        .collection_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() || name.chars().count() > 200 {
        return Err(VaultError::Malformed("the collection's name"));
    }
    let lines = answer.checks(Some(&input.collection_id), Some(&name));
    if let Some(why) = vaultwarden::first_failure(&lines) {
        return Err(VaultError::OutsideRefused(why));
    }
    let outside_org = match (answer, input.provider, &input.org_key) {
        (Answer::Vaultwarden(sync), Provider::Vaultwarden, Some(org_key)) => {
            let col = &sync.collections[0];
            // The key handed over opens this collection's sealed name, and the name is the one
            // the person typed: the key is this collection's organisation key and no other.
            let opened_name = bitwarden::open_text(&col.protected_name, org_key).map_err(|e| match e {
                OpenError::Mac => VaultError::OutsideRefused(
                    "the key your browser opened is not this collection's; open the vault again with its master password".to_string(),
                ),
                _ => unreachable("the collection's name is not in a form Fathom reads"),
            })?;
            if opened_name.split_whitespace().collect::<Vec<_>>().join(" ") != name {
                return Err(VaultError::OutsideRefused(format!(
                    "the account's one collection is not called “{name}”; check the name"
                )));
            }
            col.org_id.clone()
        }
        // Secret Server names its folders in the clear; the checks compared the name.
        (Answer::Delinea(_), Provider::Delinea, None) => input.collection_id.clone(),
        // Passbolt connects through `set_up`, and binds at its first passing check.
        _ => return Err(VaultError::Malformed("provider")),
    };
    let id = format!("out_{}", crate::ids::new_ulid());
    let secrets = Secrets {
        provider: input.provider,
        client_id: input.client_id.clone(),
        client_secret: input.client_secret.clone(),
        org_key: input.org_key,
        server_fp: None,
        metadata_fp: None,
    };
    // Every login in it opens, so a later read will not fail half way.
    logins_in(answer, &input.collection_id, &secrets)?;
    let (ct, nonce, key_id) = seal_secrets(fk, &tenant, &id, &secrets)?;
    drop(secrets);
    file_changed(
        tx,
        auth,
        &changed(
            "connected",
            &id,
            &me,
            &me,
            vec![
                ("provider", Json::Str(input.provider.as_str().to_string())),
                ("url", Json::Str(input.url.to_text())),
                ("collection", Json::Str(input.collection_id.clone())),
                ("server_key", Json::Str(key_id.clone())),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.outside_connections (organisation_id, id, owner, provider, base_url, \
            outside_org_id, collection_id, collection_name, device_id, state, server_key_id, \
            secret_nonce, secret_ct, checked_at, updated_by) \
         VALUES ($1, $2, $3, $12, $4, $5, $6, $7, $8, 'on', $9, $10, $11, now(), $3)",
        &[
            &tenant,
            &id,
            &me,
            &input.url.to_text(),
            &outside_org,
            &input.collection_id,
            &name,
            &input.device_id,
            &key_id,
            &nonce,
            &ct,
            &input.provider.as_str(),
        ],
    )
    .await?;
    view_of(tx, fk, &tenant, &id).await
}

/// Passbolt: record the account Fathom has just set up there, with its own key, as a connection
/// that **waits** for one folder to be shared with it. Its owner is the person who pasted the
/// invitation; the server key's fingerprint is the one they were shown and confirmed.
#[allow(clippy::too_many_arguments)]
pub async fn set_up(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    url: &OutsideUrl,
    user_id: &str,
    done: &passbolt::SetUp,
    server_fp: &str,
    folder_name: &str,
) -> Result<ConnectionView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let name = folder_name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > 200 {
        return Err(VaultError::Malformed("the folder's name"));
    }
    let id = format!("out_{}", crate::ids::new_ulid());
    let secrets = Secrets {
        provider: Provider::Passbolt,
        client_id: user_id.to_string(),
        client_secret: done.secret.clone(),
        org_key: None,
        server_fp: Some(server_fp.to_string()),
        metadata_fp: None,
    };
    let (ct, nonce, key_id) = seal_secrets(fk, &tenant, &id, &secrets)?;
    drop(secrets);
    file_changed(
        tx,
        auth,
        &changed(
            "set_up",
            &id,
            &me,
            &me,
            vec![
                (
                    "provider",
                    Json::Str(Provider::Passbolt.as_str().to_string()),
                ),
                ("url", Json::Str(url.to_text())),
                ("outside_account", Json::Str(user_id.to_string())),
                ("account_key", Json::Str(done.fingerprint.clone())),
                ("outside_server_key", Json::Str(server_fp.to_string())),
                ("server_key", Json::Str(key_id.clone())),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.outside_connections (organisation_id, id, owner, provider, base_url, \
            outside_org_id, collection_id, collection_name, device_id, state, server_key_id, \
            secret_nonce, secret_ct, updated_by) \
         VALUES ($1, $2, $3, 'passbolt', $4, $5, NULL, $6, $7, 'waiting', $8, $9, $10, $3)",
        &[
            &tenant,
            &id,
            &me,
            &url.to_text(),
            &user_id,
            &name,
            &new_device_id()?,
            &key_id,
            &nonce,
            &ct,
        ],
    )
    .await?;
    view_of(tx, fk, &tenant, &id).await
}

/// What a network round needs, read and authorised in one transaction and used after it.
pub struct Plan {
    pub connection: String,
    pub owner: String,
    pub url: OutsideUrl,
    pub device_id: String,
    pub collection_id: String,
    pub collection_name: String,
    pub secrets: Secrets,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// "Check now": the owner or an admin.
    Check,
    /// Pulling a login: the owner only.
    Pull,
}

async fn load_plan(
    tx: &Transaction<'_>,
    fk: &FathomKey,
    tenant: &str,
    connection: &str,
    lock: bool,
) -> Result<(Plan, String), VaultError> {
    let r = tx
        .query_opt(
            &format!(
                "SELECT owner, base_url, device_id, collection_id, collection_name, state, \
                        server_key_id, secret_nonce, secret_ct, provider \
                 FROM vault.outside_connections WHERE organisation_id = $1 AND id = $2{}",
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&tenant, &connection],
        )
        .await?
        .ok_or(VaultError::NotFound)?;
    let state: String = r.get(5);
    if state == "disconnected" {
        return Err(VaultError::NotAllowed(
            "this outside vault was disconnected",
        ));
    }
    let secrets = open_secrets(
        fk,
        tenant,
        connection,
        &r.get::<_, String>(6),
        &r.get::<_, Vec<u8>>(7),
        &r.get::<_, Vec<u8>>(8),
    )?;
    if secrets.provider.as_str() != r.get::<_, String>(9) {
        return Err(VaultError::Corrupt("an outside vault's provider"));
    }
    Ok((
        Plan {
            connection: connection.to_string(),
            owner: r.get(0),
            url: OutsideUrl::parse(&r.get::<_, String>(1))
                .map_err(|_| VaultError::Corrupt("a stored outside vault address"))?,
            device_id: r.get(2),
            // Empty while a Passbolt connection waits for its folder.
            collection_id: r.get::<_, Option<String>>(3).unwrap_or_default(),
            collection_name: r.get(4),
            secrets,
        },
        state,
    ))
}

pub async fn plan(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    connection: &str,
    why: Why,
) -> Result<Plan, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let (plan, state) = load_plan(tx, fk, &tenant, connection, false).await?;
    match why {
        Why::Check => {
            if plan.owner != me && !is_steward(tx, auth).await? {
                return Err(VaultError::NotFound);
            }
        }
        Why::Pull => {
            if plan.owner != me {
                return Err(VaultError::NotAllowed(
                    "only the person who connected this vault pulls logins from it",
                ));
            }
            if state != "on" {
                return Err(VaultError::NotAllowed(
                    "this outside vault is stopped; check it again first",
                ));
            }
        }
    }
    Ok(plan)
}

/// What "Check now" answers.
pub struct Checked {
    pub view: ConnectionView,
    pub lines: Vec<CheckLine>,
    pub logins: Vec<OutsideLogin>,
}

/// Record a check's outcome. A failed check stops the connection, on the history, and the
/// outer `Err` carries why; **the transaction is committed either way** (the caller commits
/// before it returns the inner error).
///
/// A Passbolt connection that is **waiting** is not stopped by a failed check: it answers the
/// lines, and the first check that passes binds it to the one folder it sees.
pub async fn after_check(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    plan: &Plan,
    read: Result<Answer, VaultError>,
) -> Result<Result<Checked, VaultError>, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    // The connection may have been disconnected while the network round ran.
    let (_, state) = load_plan(tx, fk, &tenant, &plan.connection, true).await?;
    let waiting = state == "waiting";
    let answer = match read {
        Err(VaultError::OutsideRefused(why)) if !waiting => {
            stop(
                tx,
                auth,
                &tenant,
                &plan.connection,
                &plan.owner,
                &me,
                &why,
                &state,
            )
            .await?;
            return Ok(Err(VaultError::OutsideRefused(why)));
        }
        Err(e) => return Ok(Err(e)),
        Ok(answer) => answer,
    };
    let collection = (!waiting).then_some(plan.collection_id.as_str());
    let lines = answer.checks(collection, Some(&plan.collection_name));
    let failure = vaultwarden::first_failure(&lines);
    if waiting {
        let bound = match (&answer, failure) {
            (Answer::Passbolt(a), None) => Some((
                a.folders[0].id.clone(),
                a.metadata_key.as_ref().map(|k| k.fingerprint.clone()),
            )),
            _ => None,
        };
        let Some((folder, metadata_fp)) = bound else {
            return Ok(Ok(Checked {
                view: view_of(tx, fk, &tenant, &plan.connection).await?,
                lines,
                logins: Vec::new(),
            }));
        };
        let logins = match logins_in(&answer, &folder, &plan.secrets) {
            Ok(l) => l,
            Err(e) => return Ok(Err(e)),
        };
        let pinned = Secrets {
            provider: plan.secrets.provider,
            client_id: plan.secrets.client_id.clone(),
            client_secret: plan.secrets.client_secret.clone(),
            org_key: None,
            server_fp: plan.secrets.server_fp.clone(),
            metadata_fp,
        };
        let (ct, nonce, key_id) = seal_secrets(fk, &tenant, &plan.connection, &pinned)?;
        drop(pinned);
        file_changed(
            tx,
            auth,
            &changed(
                "bound",
                &plan.connection,
                &plan.owner,
                &me,
                vec![("collection", Json::Str(folder.clone()))],
            ),
        )
        .await?;
        tx.execute(
            "UPDATE vault.outside_connections SET state = 'on', collection_id = $3, \
                server_key_id = $4, secret_nonce = $5, secret_ct = $6, checked_at = now(), \
                updated_by = $7, updated_at = now() \
             WHERE organisation_id = $1 AND id = $2",
            &[
                &tenant,
                &plan.connection,
                &folder,
                &key_id,
                &nonce,
                &ct,
                &me,
            ],
        )
        .await?;
        return Ok(Ok(Checked {
            view: view_of(tx, fk, &tenant, &plan.connection).await?,
            lines,
            logins,
        }));
    }
    let failure = match failure {
        Some(why) => Some(why),
        None => match logins_in(&answer, &plan.collection_id, &plan.secrets) {
            Ok(logins) => {
                if state == "stopped" {
                    file_changed(
                        tx,
                        auth,
                        &changed("resumed", &plan.connection, &plan.owner, &me, vec![]),
                    )
                    .await?;
                }
                tx.execute(
                    "UPDATE vault.outside_connections SET state = 'on', stopped_reason = NULL, \
                        checked_at = now(), updated_by = $3, updated_at = now() \
                     WHERE organisation_id = $1 AND id = $2",
                    &[&tenant, &plan.connection, &me],
                )
                .await?;
                return Ok(Ok(Checked {
                    view: view_of(tx, fk, &tenant, &plan.connection).await?,
                    lines,
                    logins,
                }));
            }
            Err(VaultError::OutsideRefused(why)) => Some(why),
            Err(e) => return Ok(Err(e)),
        },
    };
    let why = failure.unwrap_or_default();
    stop(
        tx,
        auth,
        &tenant,
        &plan.connection,
        &plan.owner,
        &me,
        &why,
        &state,
    )
    .await?;
    Ok(Err(VaultError::OutsideRefused(why)))
}

#[allow(clippy::too_many_arguments)]
async fn stop(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    tenant: &str,
    connection: &str,
    owner: &str,
    me: &str,
    why: &str,
    state: &str,
) -> Result<(), VaultError> {
    let why: String = why.chars().take(400).collect();
    if state != "stopped" {
        file_changed(
            tx,
            auth,
            &changed(
                "stopped",
                connection,
                owner,
                me,
                vec![("reason", Json::Str(why.clone()))],
            ),
        )
        .await?;
    }
    tx.execute(
        "UPDATE vault.outside_connections SET state = 'stopped', stopped_reason = $3, \
            checked_at = now(), updated_by = $4, updated_at = now() \
         WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &connection, &why, &me],
    )
    .await?;
    Ok(())
}

/// Pull one login from the connection's collection into Fathom, or change the devices it is
/// marked on. The owner only; the name is the outside vault's, read in this round.
#[allow(clippy::too_many_arguments)]
pub async fn pull(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    plan: &Plan,
    answer: &Answer,
    cipher_id: &str,
    kind: &str,
    used_on: Vec<(String, String)>,
) -> Result<Result<ConnectionView, VaultError>, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let (_, state) = load_plan(tx, fk, &tenant, &plan.connection, true).await?;
    if state != "on" {
        return Ok(Err(VaultError::NotAllowed(
            "this outside vault is stopped; check it again first",
        )));
    }
    let lines = answer.checks(Some(&plan.collection_id), Some(&plan.collection_name));
    if let Some(why) = vaultwarden::first_failure(&lines) {
        stop(
            tx,
            auth,
            &tenant,
            &plan.connection,
            &plan.owner,
            &me,
            &why,
            &state,
        )
        .await?;
        return Ok(Err(VaultError::OutsideRefused(why)));
    }
    let logins = match logins_in(answer, &plan.collection_id, &plan.secrets) {
        Ok(l) => l,
        Err(e) => return Ok(Err(e)),
    };
    let Some(login) = logins.iter().find(|l| l.cipher_id == cipher_id) else {
        return Ok(Err(VaultError::NotAllowed(
            "that login is not in this vault's collection any more",
        )));
    };
    let meta = Meta::clean(&login.name, kind, used_on)?;
    let existing = tx
        .query_opt(
            "SELECT id, state FROM vault.outside_items \
             WHERE organisation_id = $1 AND connection_id = $2 AND cipher_id = $3 FOR UPDATE",
            &[&tenant, &plan.connection, &cipher_id],
        )
        .await?;
    match existing {
        Some(r) => {
            let (id, item_state): (String, String) = (r.get(0), r.get(1));
            if item_state == "removed" {
                return Ok(Err(VaultError::NotAllowed(
                    "an admin removed this login from Fathom; an admin can restore it",
                )));
            }
            let (ct, nonce, key_id) = seal_meta(fk, &tenant, &id, &meta)?;
            file_changed(
                tx,
                auth,
                &changed(
                    "changed",
                    &plan.connection,
                    &plan.owner,
                    &me,
                    vec![("item", Json::Str(id.clone()))],
                ),
            )
            .await?;
            tx.execute(
                "UPDATE vault.outside_items SET meta_key_id = $3, meta_nonce = $4, meta_ct = $5, \
                    updated_by = $6, updated_at = now() WHERE organisation_id = $1 AND id = $2",
                &[&tenant, &id, &key_id, &nonce, &ct, &me],
            )
            .await?;
        }
        None => {
            let id = format!("oit_{}", crate::ids::new_ulid());
            let (ct, nonce, key_id) = seal_meta(fk, &tenant, &id, &meta)?;
            file_changed(
                tx,
                auth,
                &changed(
                    "pulled",
                    &plan.connection,
                    &plan.owner,
                    &me,
                    vec![
                        ("item", Json::Str(id.clone())),
                        ("cipher", Json::Str(cipher_id.to_string())),
                    ],
                ),
            )
            .await?;
            tx.execute(
                "INSERT INTO vault.outside_items (organisation_id, id, connection_id, cipher_id, \
                    state, meta_key_id, meta_nonce, meta_ct, pulled_by, updated_by) \
                 VALUES ($1, $2, $3, $4, 'on', $5, $6, $7, $8, $8)",
                &[
                    &tenant,
                    &id,
                    &plan.connection,
                    &cipher_id,
                    &key_id,
                    &nonce,
                    &ct,
                    &me,
                ],
            )
            .await?;
        }
    }
    tx.execute(
        "UPDATE vault.outside_connections SET checked_at = now(), updated_by = $3, updated_at = now() \
         WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &plan.connection, &me],
    )
    .await?;
    Ok(Ok(view_of(tx, fk, &tenant, &plan.connection).await?))
}

async fn lock_item(
    tx: &Transaction<'_>,
    tenant: &str,
    item: &str,
) -> Result<(String, String, String), VaultError> {
    let r = tx
        .query_opt(
            "SELECT i.connection_id, i.state, c.owner FROM vault.outside_items i \
             JOIN vault.outside_connections c ON c.organisation_id = i.organisation_id \
               AND c.id = i.connection_id \
             WHERE i.organisation_id = $1 AND i.id = $2 FOR UPDATE OF i",
            &[&tenant, &item],
        )
        .await?
        .ok_or(VaultError::NotFound)?;
    Ok((r.get(0), r.get(1), r.get(2)))
}

/// Take one pulled login out of Fathom's use. Its owner or any admin; an admin's removal is
/// the one its owner cannot undo.
pub async fn remove(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    item: &str,
) -> Result<ConnectionView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let (connection, state, owner) = lock_item(tx, &tenant, item).await?;
    let steward = is_steward(tx, auth).await?;
    if owner != me && !steward {
        return Err(VaultError::NotFound);
    }
    if state == "removed" {
        return Err(VaultError::NotAllowed("that login is already removed"));
    }
    file_changed(
        tx,
        auth,
        &changed(
            "removed",
            &connection,
            &owner,
            &me,
            vec![("item", Json::Str(item.to_string()))],
        ),
    )
    .await?;
    tx.execute(
        "UPDATE vault.outside_items SET state = 'removed', removed_by = $3, removed_at = now(), \
            updated_by = $3, updated_at = now() WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &item, &me],
    )
    .await?;
    view_of(tx, fk, &tenant, &connection).await
}

/// Put a removed login back. An admin; or its owner, when the owner removed it themselves.
pub async fn restore(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    item: &str,
) -> Result<ConnectionView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let (connection, state, owner) = lock_item(tx, &tenant, item).await?;
    if state != "removed" {
        return Err(VaultError::NotAllowed("that login is not removed"));
    }
    let removed_by: String = tx
        .query_one(
            "SELECT removed_by FROM vault.outside_items WHERE organisation_id = $1 AND id = $2",
            &[&tenant, &item],
        )
        .await?
        .get(0);
    let steward = is_steward(tx, auth).await?;
    if !(steward || (owner == me && removed_by == me)) {
        return Err(VaultError::NotAllowed(
            "an admin removed this login from Fathom; an admin can restore it",
        ));
    }
    file_changed(
        tx,
        auth,
        &changed(
            "restored",
            &connection,
            &owner,
            &me,
            vec![("item", Json::Str(item.to_string()))],
        ),
    )
    .await?;
    tx.execute(
        "UPDATE vault.outside_items SET state = 'on', removed_by = NULL, removed_at = NULL, \
            updated_by = $3, updated_at = now() WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &item, &me],
    )
    .await?;
    view_of(tx, fk, &tenant, &connection).await
}

/// Disconnect: the sealed API key and organisation key are emptied; the rows and the history
/// stay. Its owner or any admin. The API key itself still works in the outside vault until
/// someone rotates it there, and the answer says so.
pub async fn disconnect(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    connection: &str,
) -> Result<ConnectionView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let r = tx
        .query_opt(
            "SELECT owner, state FROM vault.outside_connections \
             WHERE organisation_id = $1 AND id = $2 FOR UPDATE",
            &[&tenant, &connection],
        )
        .await?
        .ok_or(VaultError::NotFound)?;
    let (owner, state): (String, String) = (r.get(0), r.get(1));
    if owner != me && !is_steward(tx, auth).await? {
        return Err(VaultError::NotFound);
    }
    if state == "disconnected" {
        return Err(VaultError::NotAllowed(
            "this outside vault is already disconnected",
        ));
    }
    file_changed(
        tx,
        auth,
        &changed("disconnected", connection, &owner, &me, vec![]),
    )
    .await?;
    tx.execute(
        "UPDATE vault.outside_connections SET state = 'disconnected', stopped_reason = NULL, \
            secret_ct = ''::bytea, updated_by = $3, updated_at = now() \
         WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &connection, &me],
    )
    .await?;
    view_of(tx, fk, &tenant, connection).await
}

// ---------------------------------------------------------------------------
// Fathom using a pulled login
// ---------------------------------------------------------------------------

enum Found<'a> {
    Vaultwarden(&'a vaultwarden::Cipher),
    Delinea(&'a delinea::Secret),
    Passbolt(&'a passbolt::Item, &'a passbolt::Secret),
}

pub struct UsePlan {
    pub plan: Plan,
    pub item: String,
    pub cipher_id: String,
    pub design: String,
    pub element: String,
    pub purpose: String,
}

/// Authorise and read what a use needs, before the network round.
#[allow(clippy::too_many_arguments)]
pub async fn use_plan(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    item: &str,
    design: &str,
    element: &str,
    purpose: &str,
) -> Result<UsePlan, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    if !PURPOSES.contains(&purpose) {
        return Err(VaultError::Malformed("purpose"));
    }
    let scope = tx
        .query_opt(
            "SELECT scope_id FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design, &tenant],
        )
        .await?
        .ok_or(VaultError::NotFound)?
        .get::<_, String>(0)
        .parse::<crate::repo::ScopeId>()
        .map_err(|_| VaultError::Corrupt("design scope id"))?;
    match grants::authorise_account(tx, auth, Some(scope), Capability::Draw).await {
        Ok(_) => {}
        Err(AuthorityError::NotAuthorised) => {
            return Err(VaultError::NotAllowed(
                "Fathom uses a login only for someone who can draw on that design",
            ))
        }
        Err(e) => return Err(e.into()),
    }
    let r = tx
        .query_opt(
            "SELECT connection_id, cipher_id, state, meta_key_id, meta_nonce, meta_ct \
             FROM vault.outside_items WHERE organisation_id = $1 AND id = $2",
            &[&tenant, &item],
        )
        .await?
        .ok_or(VaultError::NotFound)?;
    if r.get::<_, String>(2) != "on" {
        return Err(VaultError::NotAllowed("this login was removed from Fathom"));
    }
    let meta = open_meta(
        fk,
        &tenant,
        item,
        &r.get::<_, String>(3),
        &r.get::<_, Vec<u8>>(4),
        &r.get::<_, Vec<u8>>(5),
    )?;
    if !meta
        .used_on
        .iter()
        .any(|(d, e)| d == design && e == element)
    {
        return Err(VaultError::NotAllowed(
            "this login is not marked as used on that device",
        ));
    }
    let connection: String = r.get(0);
    let (plan, state) = load_plan(tx, fk, &tenant, &connection, false).await?;
    if state != "on" {
        return Err(VaultError::NotAllowed(
            "the outside vault this login comes from is stopped; its owner or an admin checks it again",
        ));
    }
    Ok(UsePlan {
        plan,
        item: item.to_string(),
        cipher_id: r.get(1),
        design: design.to_string(),
        element: element.to_string(),
        purpose: purpose.to_string(),
    })
}

/// After the network round: the checks again, the history, then the item. A failed check
/// stops the connection and is committed (see [`after_check`]).
pub async fn use_finish(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    up: &UsePlan,
    read: Result<Answer, VaultError>,
) -> Result<Result<UsedLogin, VaultError>, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let (_, state) = load_plan(tx, fk, &tenant, &up.plan.connection, true).await?;
    let item_state: String = tx
        .query_one(
            "SELECT state FROM vault.outside_items WHERE organisation_id = $1 AND id = $2 FOR UPDATE",
            &[&tenant, &up.item],
        )
        .await?
        .get(0);
    if state != "on" || item_state != "on" {
        return Ok(Err(VaultError::NotAllowed(
            "this login, or the outside vault it comes from, changed while Fathom read it",
        )));
    }
    let answer = match read {
        Ok(s) => s,
        Err(VaultError::OutsideRefused(why)) => {
            stop(
                tx,
                auth,
                &tenant,
                &up.plan.connection,
                &up.plan.owner,
                &me,
                &why,
                &state,
            )
            .await?;
            return Ok(Err(VaultError::OutsideRefused(why)));
        }
        Err(e) => return Ok(Err(e)),
    };
    let lines = answer.checks(Some(&up.plan.collection_id), Some(&up.plan.collection_name));
    if let Some(why) = vaultwarden::first_failure(&lines) {
        stop(
            tx,
            auth,
            &tenant,
            &up.plan.connection,
            &up.plan.owner,
            &me,
            &why,
            &state,
        )
        .await?;
        return Ok(Err(VaultError::OutsideRefused(why)));
    }
    let gone = || {
        Ok(Err(VaultError::NotAllowed(
            "that login is not in the outside vault's collection any more",
        )))
    };
    let found = match &answer {
        Answer::Vaultwarden(sync) => {
            let Some(cipher) = sync.ciphers.iter().find(|c| {
                c.id == up.cipher_id
                    && !c.deleted
                    && c.kind == vaultwarden::CIPHER_LOGIN
                    && c.collection_ids.contains(&up.plan.collection_id)
            }) else {
                return gone();
            };
            if !cipher.view_password {
                return Ok(Err(VaultError::NotAllowed(
                    "the outside vault hides this login's password from the account Fathom uses",
                )));
            }
            Found::Vaultwarden(cipher)
        }
        Answer::Delinea(a) => {
            let Some(secret) = a.secret.as_ref().filter(|x| {
                x.id == up.cipher_id
                    && x.folder_id.as_deref() == Some(up.plan.collection_id.as_str())
            }) else {
                return gone();
            };
            if secret.password.is_none() {
                return Ok(Err(VaultError::NotAllowed(
                    "that secret has no password field Fathom can read",
                )));
            }
            Found::Delinea(secret)
        }
        Answer::Passbolt(a) => {
            let found = a.item(&up.cipher_id).filter(|i| {
                i.folder_id.as_deref() == Some(up.plan.collection_id.as_str()) && !i.personal
            });
            let (Some(item), Some(secret)) =
                (found, a.secret.as_ref().filter(|x| x.id == up.cipher_id))
            else {
                return gone();
            };
            Found::Passbolt(item, secret)
        }
    };
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultOutsideRead,
        &entry_metadata(
            EntryType::VaultOutsideRead,
            &[
                ("item", Json::Str(up.item.clone())),
                ("connection", Json::Str(up.plan.connection.clone())),
                ("cipher", Json::Str(up.cipher_id.clone())),
                ("purpose", Json::Str(up.purpose.clone())),
                ("design", Json::Str(up.design.clone())),
                ("element", Json::Str(up.element.clone())),
                ("asked_by", Json::Str(me.clone())),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.outside_reads (organisation_id, id, item_id, purpose, design_id, \
            element_id, asked_by, chain_seq) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        &[
            &tenant,
            &crate::ids::new_ulid().to_string(),
            &up.item,
            &up.purpose,
            &up.design,
            &up.element,
            &me,
            &appended.seq,
        ],
    )
    .await?;
    tx.execute(
        "UPDATE vault.outside_connections SET checked_at = now() WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &up.plan.connection],
    )
    .await?;
    let (user, password) = match found {
        Found::Delinea(secret) => (
            secret.user.clone().unwrap_or_default(),
            secret.password.clone().unwrap_or_default(),
        ),
        Found::Passbolt(item, secret) => (
            item.user.clone().unwrap_or_default(),
            secret.password.clone(),
        ),
        Found::Vaultwarden(cipher) => {
            let Some(org) = up.plan.secrets.org_key.as_ref() else {
                return Err(VaultError::Corrupt("outside vault secrets"));
            };
            let own = match bitwarden::item_key(cipher.protected_key.as_deref(), org) {
                Ok(k) => k,
                Err(e) => return Ok(Err(opened(e))),
            };
            let key = own.as_ref().unwrap_or(org);
            let text = |v: &Option<String>| -> Result<String, VaultError> {
                match v {
                    None => Ok(String::new()),
                    Some(v) => bitwarden::open_text(v, key).map_err(opened),
                }
            };
            match (
                text(&cipher.protected_username),
                text(&cipher.protected_password),
            ) {
                (Ok(u), Ok(p)) => (u, p),
                (Err(e), _) | (_, Err(e)) => return Ok(Err(e)),
            }
        }
    };
    Ok(Ok(UsedLogin { user, password }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_https_a_host_and_nothing_else() {
        let u = OutsideUrl::parse("https://Vault.Example.org/").unwrap();
        assert_eq!(
            u,
            OutsideUrl {
                host: "vault.example.org".into(),
                port: 443,
                prefix: String::new()
            }
        );
        assert_eq!(u.to_text(), "https://vault.example.org");
        let u = OutsideUrl::parse("https://10.0.0.5:8443/vw").unwrap();
        assert_eq!(
            (u.port, u.prefix.as_str(), u.host_header().as_str()),
            (8443, "/vw", "10.0.0.5:8443")
        );
        let u = OutsideUrl::parse("https://[::1]:8443").unwrap();
        assert_eq!(
            (u.bare_host(), u.to_text().as_str()),
            ("::1", "https://[::1]:8443")
        );
        for bad in [
            "http://vault.example.org",
            "https://user:pw@vault.example.org",
            "https://vault.example.org/?x=1",
            "https://vault.example.org/#a",
            "https://vault.example.org:0",
            "https://vault.example.org:99999",
            "https://vault example.org",
            "https://-vault.example.org",
            "https://vault.example.org/../admin",
            "https://[nothost]",
            "https://",
        ] {
            assert!(OutsideUrl::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_sign_in_body_is_form_encoded() {
        assert_eq!(
            form_encode(&[("client_secret", "a+b c/d=&"), ("scope", "api")]),
            b"client_secret=a%2Bb%20c%2Fd%3D%26&scope=api".to_vec()
        );
    }

    #[test]
    fn an_api_key_and_a_device_id_are_shaped_as_vaultwarden_issues_them() {
        assert!(check_api_key("user.0a1b2c3d-0000-4000-8000-123456789abc", "AbCdEf0123").is_ok());
        assert!(check_api_key("organization.x", "s").is_err());
        assert!(check_api_key("user.", "s").is_err());
        assert!(check_api_key("user.abc", "has space").is_err());
        let d = new_device_id().unwrap();
        assert!(check_device_id(&d).is_ok(), "{d}");
        assert!(check_device_id("not-a-uuid").is_err());
    }

    #[test]
    fn secrets_open_only_for_their_organisation_and_connection() {
        let fk = FathomKey::from_key(crypto::Key32::from_bytes([7; 32]));
        let s = Secrets {
            provider: Provider::Vaultwarden,
            client_id: "user.abc".into(),
            client_secret: "secret".into(),
            org_key: Some(BwKey::from_slice(&[5u8; 64]).unwrap()),
            server_fp: None,
            metadata_fp: None,
        };
        let (ct, nonce, key_id) = seal_secrets(&fk, "01JORG", "out_X", &s).unwrap();
        let back = open_secrets(&fk, "01JORG", "out_X", &key_id, &nonce, &ct).unwrap();
        assert_eq!(
            (back.client_id.as_str(), back.client_secret.as_str()),
            ("user.abc", "secret")
        );
        assert_eq!(back.org_key.as_ref().unwrap().expose(), &[5u8; 64]);
        let d = Secrets {
            provider: Provider::Delinea,
            client_id: "svc-fathom".into(),
            client_secret: "pw".into(),
            org_key: None,
            server_fp: None,
            metadata_fp: None,
        };
        let (ct2, nonce2, _) = seal_secrets(&fk, "01JORG", "out_D", &d).unwrap();
        let back = open_secrets(&fk, "01JORG", "out_D", &key_id, &nonce2, &ct2).unwrap();
        assert_eq!(back.provider, Provider::Delinea);
        assert!(back.org_key.is_none());
        assert!(open_secrets(&fk, "01JOTHER", "out_X", &key_id, &nonce, &ct).is_err());
        assert!(open_secrets(&fk, "01JORG", "out_Y", &key_id, &nonce, &ct).is_err());
        let other = FathomKey::from_key(crypto::Key32::from_bytes([8; 32]));
        assert!(matches!(
            open_secrets(&other, "01JORG", "out_X", &key_id, &nonce, &ct),
            Err(VaultError::NotAllowed(_))
        ));
    }
}

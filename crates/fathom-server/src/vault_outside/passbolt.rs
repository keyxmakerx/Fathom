//! **Passbolt** (ADR-0071 part four, Passbolt third; owner's answers 2026-10-26: r34-passbolt v2
//! B, r34-passbolt-crates A "but let this be an optional thing"): how Fathom signs in to a
//! Passbolt with a key of its own, what it reads, and the checks before every read.
//!
//! Passbolt seals everything with OpenPGP. The server does none of that itself: every OpenPGP
//! step goes to the **helper** (`helpers/passbolt/`), a separate process with no network, no
//! files and no capabilities, over a Unix socket ([`Pgp`]). Without one configured
//! (`FATHOM_PASSBOLT_HELPER`), Passbolt is not offered.
//!
//! # The shape
//!
//! An administrator of the Passbolt invites a new **user** for Fathom. The person pastes the
//! invitation link here; Fathom makes its own Curve25519 key in the helper and finishes the
//! account's setup with it, so the key is Fathom's from the start and no person ever holds it.
//! The connection then **waits**: the Passbolt's administrator shares one folder with that
//! user (and, on Passbolt 5, its shared metadata key), and the first "Check now" whose checks
//! all pass binds the connection to that folder. From then on it is the same as the others.
//!
//! # The checks ([`checks`]), before binding and before every read
//!
//! 1. The account is a plain user, not an administrator.
//! 2. It sees exactly one folder, the one it is bound to, by the name the person typed.
//! 3. Every item it sees is in that folder, and none is personal.
//! 4. The shared metadata key, when the Passbolt has one, is Curve25519 throughout, is the one
//!    pinned at binding, and has been given to this account. Fathom opens with it, a private
//!    key step; an RSA or NIST-curve key would put rpgp's flagged code on it (r34-passbolt v2).
//!
//! And at every sign-in: the server key's fingerprint is the one the person was shown and
//! confirmed at setup, the answer is signed by it, and the account's key is Fathom's.
//!
//! # Sources (read 2026-10-26)
//!
//! passbolt/passbolt_api at 5de65b8 (2026-10-20):
//! - every answer is `{"header":{…,"status":"success"},"body":…}` (`AppController::success`);
//! - `GET /auth/verify.json` → `body.fingerprint`, `body.keydata` (`AuthVerifyController`);
//! - the invitation is `/setup/start/{userId}/{tokenId}` and `POST /setup/complete/{userId}.json`
//!   takes `{"authentication_token":{"token":…},"gpgkey":{"armored_key":…}}`, from a guest, with
//!   no CSRF token (`config/default.php` `unlockedActions`);
//! - JWT sign-in, `plugins/PassboltCe/JwtAuthentication`: `POST /auth/jwt/login.json` with
//!   `{user_id, challenge}`, the challenge `{version:"1.0.0", domain, verify_token,
//!   verify_token_expiry}` signed by the user and encrypted to the server; the answer's
//!   `body.challenge` is encrypted to the user and signed by the server and carries
//!   `access_token`; later calls send `Authorization: Bearer`; the verify token may expire at
//!   most `PASSBOLT_AUTH_JWT_VERIFY_TOKEN` ahead (default 1 hour);
//! - `GET /users/me.json` contains `role` and `gpgkey` by default (`UsersFindersTrait::findIndex`);
//! - resources and folders carry `name` (v4) or sealed `metadata` with `metadata_key_id` and
//!   `metadata_key_type` (`shared_key` | `user_key`); the Folders plugin adds `folder_parent_id`
//!   and `personal`;
//! - `GET /metadata/keys.json?contain[metadata_private_keys]=1`, each private key sealed to a
//!   user (`MetadataKeysIndexController`); `GET /secrets/resource/{id}.json` → `body.data`.
//!
//! passbolt.com documentation: "Authentication" (updated 2026-06-16), a sign-in with
//! multi-factor on answers 403 with `mfa_providers`, which Fathom refuses; "v5 encrypted
//! metadata" (updated 2026-08-25), the object types read below.
//!
//! **Not established**: Fathom has signed in to no real Passbolt. The helper's tests run
//! against GnuPG, which a Passbolt server uses; the drive uses a stand-in of these shapes.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use fathom_canon::Json;

use crate::foreign_json::{self, get, get_arr, get_str};
use crate::vault::VaultError;
use crate::vault_fathom::wipe_string;

use super::{new_device_id, unreachable, HttpRequest, NetError, Outside, OutsideUrl, Secrets};

pub use super::vaultwarden::{CheckLine, ShapeError};

/// How many folders or items one account may see. A folder Fathom reads is small.
pub const MAX_ITEMS: usize = 500;

/// What Fathom's own Passbolt key is called inside it.
pub const KEY_NAME: &str = "Fathom";

// ---------------------------------------------------------------------------
// The seam to the helper
// ---------------------------------------------------------------------------

pub type PgpFuture<'a> = Pin<Box<dyn Future<Output = Result<Json, NetError>> + Send + 'a>>;

/// One request to the helper: a JSON object in, a JSON object out (`helpers/passbolt/src/lib.rs`).
/// [`SocketPgp`] in the server; a stand-in in tests.
pub trait Pgp: Send + Sync {
    fn call(&self, request: Json) -> PgpFuture<'_>;
}

/// The helper over its Unix socket: four bytes of length, big-endian, then the JSON; one
/// request per connection.
pub struct SocketPgp {
    pub path: PathBuf,
}

/// The longest answer read from the helper.
const MAX_FRAME: usize = 1024 * 1024;

impl Pgp for SocketPgp {
    fn call(&self, request: Json) -> PgpFuture<'_> {
        Box::pin(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let lost = |_| NetError("the Passbolt helper did not answer".to_string());
            let body = request.to_canonical_bytes();
            let len = u32::try_from(body.len())
                .ok()
                .filter(|l| (*l as usize) <= MAX_FRAME)
                .ok_or_else(|| NetError("a request to the Passbolt helper is too long".into()))?;
            let round = async {
                let mut s = tokio::net::UnixStream::connect(&self.path)
                    .await
                    .map_err(lost)?;
                s.write_all(&len.to_be_bytes()).await.map_err(lost)?;
                s.write_all(&body).await.map_err(lost)?;
                let mut n = [0u8; 4];
                s.read_exact(&mut n).await.map_err(lost)?;
                let n = u32::from_be_bytes(n) as usize;
                if n > MAX_FRAME {
                    return Err(NetError("the Passbolt helper answered too much".into()));
                }
                let mut buf = vec![0u8; n];
                s.read_exact(&mut buf).await.map_err(lost)?;
                Ok(buf)
            };
            let mut buf = tokio::time::timeout(std::time::Duration::from_secs(20), round)
                .await
                .map_err(|_| NetError("the Passbolt helper took too long".into()))??;
            let parsed = foreign_json::parse(&buf);
            crate::vault_fathom::wipe(&mut buf);
            parsed.map_err(|_| NetError("the Passbolt helper's answer was not JSON".into()))
        })
    }
}

fn s(v: &str) -> Json {
    Json::Str(v.to_string())
}

fn req(fields: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

fn pgp_of(outside: &Outside) -> Result<&dyn Pgp, VaultError> {
    outside.pgp.as_deref().ok_or(VaultError::NotAllowed(
        "this server has no Passbolt helper; its operator switches on the passbolt profile",
    ))
}

/// One step. A refusal from the helper is the outside vault's problem, said in its words.
async fn step(pgp: &dyn Pgp, request: Json) -> Result<BTreeMap<String, Json>, VaultError> {
    let answer = pgp.call(request).await.map_err(|e| unreachable(e.0))?;
    let Json::Obj(mut m) = answer else {
        return Err(unreachable(
            "the Passbolt helper's answer was not one Fathom reads",
        ));
    };
    match m.remove("ok") {
        Some(Json::Bool(true)) => Ok(m),
        _ => {
            let why = get_str(&Json::Obj(m), "error")
                .unwrap_or("the Passbolt helper refused")
                .to_string();
            Err(VaultError::OutsideRefused(format!(
                "Passbolt's answer did not open: {why}"
            )))
        }
    }
}

fn take_str(m: &mut BTreeMap<String, Json>, k: &str) -> Result<String, VaultError> {
    match m.remove(k) {
        Some(Json::Str(v)) => Ok(v),
        _ => Err(unreachable(
            "the Passbolt helper's answer was not one Fathom reads",
        )),
    }
}

/// Is the helper there? What the connect screen asks before it offers Passbolt.
pub async fn available(outside: &Outside) -> bool {
    match &outside.pgp {
        None => false,
        Some(p) => step(p.as_ref(), req(vec![("op", s("ping"))])).await.is_ok(),
    }
}

/// Fathom's new key: `(armored private key, fingerprint)`.
async fn make_key(pgp: &dyn Pgp) -> Result<(String, String, String), VaultError> {
    let mut m = step(pgp, req(vec![("op", s("make_key")), ("uid", s(KEY_NAME))])).await?;
    Ok((
        take_str(&mut m, "secret")?,
        take_str(&mut m, "public")?,
        take_str(&mut m, "fingerprint")?,
    ))
}

/// `(fingerprint, curve25519 throughout)` of a public key.
async fn key_info(pgp: &dyn Pgp, key: &str) -> Result<(String, bool), VaultError> {
    let mut m = step(pgp, req(vec![("op", s("key_info")), ("key", s(key))])).await?;
    let fp = take_str(&mut m, "fingerprint")?;
    Ok((fp, matches!(m.get("curve25519"), Some(Json::Bool(true)))))
}

async fn seal_for(
    pgp: &dyn Pgp,
    secret: &str,
    to: &str,
    plain: &str,
) -> Result<String, VaultError> {
    let mut m = step(
        pgp,
        req(vec![
            ("op", s("seal_for")),
            ("secret", s(secret)),
            ("to", s(to)),
            ("plain", s(plain)),
        ]),
    )
    .await?;
    take_str(&mut m, "data")
}

async fn open(
    pgp: &dyn Pgp,
    secret: &str,
    password: &str,
    data: &str,
    signer: Option<&str>,
) -> Result<String, VaultError> {
    let mut fields = vec![
        ("op", s("open")),
        ("secret", s(secret)),
        ("password", s(password)),
        ("data", s(data)),
    ];
    if let Some(k) = signer {
        fields.push(("signer", s(k)));
    }
    let mut m = step(pgp, req(fields)).await?;
    if signer.is_some() && !matches!(m.get("signed"), Some(Json::Bool(true))) {
        return Err(VaultError::OutsideRefused(
            "Passbolt's answer was not signed by its server key".to_string(),
        ));
    }
    take_str(&mut m, "plain")
}

// ---------------------------------------------------------------------------
// The invitation
// ---------------------------------------------------------------------------

/// A Passbolt id: a UUID, lower-cased.
pub fn uuid(text: &str) -> Option<String> {
    let t = text.to_ascii_lowercase();
    let ok = t.len() == 36
        && t.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    ok.then_some(t)
}

/// What the invitation link says: the Passbolt's address, the invited user and the one-time
/// token. `https://passbolt.example.org/setup/start/{user}/{token}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invite {
    pub url: OutsideUrl,
    pub user_id: String,
    pub token: String,
}

pub fn parse_invite(text: &str) -> Result<Invite, VaultError> {
    let bad = VaultError::Malformed(
        "the invitation is the link in Passbolt's email, ending /setup/start/ and two ids",
    );
    let text = text.trim();
    let Some(i) = text.find("/setup/start/") else {
        return Err(bad);
    };
    let (base, rest) = (&text[..i], &text[i + "/setup/start/".len()..]);
    let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    let [user, token] = parts.as_slice() else {
        return Err(bad);
    };
    let (Some(user_id), Some(token)) = (uuid(user), uuid(token)) else {
        return Err(bad);
    };
    Ok(Invite {
        url: OutsideUrl::parse(base)?,
        user_id,
        token,
    })
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

async fn call(
    outside: &Outside,
    url: &OutsideUrl,
    method: &'static str,
    path: String,
    token: Option<&str>,
    body: Option<Json>,
) -> Result<(u16, Json), VaultError> {
    let mut headers = vec![("Accept", "application/json".to_string())];
    if body.is_some() {
        headers.push(("Content-Type", "application/json".to_string()));
    }
    if let Some(t) = token {
        headers.push(("Authorization", format!("Bearer {t}")));
    }
    let answer = outside
        .net
        .send(HttpRequest {
            method,
            url: url.clone(),
            path,
            headers,
            body: body.map(|b| b.to_canonical_bytes()).unwrap_or_default(),
        })
        .await
        .map_err(|e| unreachable(e.0))?;
    let v = foreign_json::parse(&answer.body).map_err(|_| {
        unreachable(format!(
            "Passbolt answered {} with something that is not its JSON; is that address a Passbolt?",
            answer.status
        ))
    })?;
    Ok((answer.status, v))
}

/// The `body` of a successful answer.
fn body_of(v: Json) -> Result<Json, VaultError> {
    let ok = get(&v, "header").and_then(|h| get_str(h, "status")) == Some("success");
    match v {
        Json::Obj(mut m) if ok => Ok(m.remove("body").unwrap_or(Json::Null)),
        _ => Err(unreachable("Passbolt's answer was not one Fathom reads")),
    }
}

fn message_of(v: &Json) -> String {
    get(v, "header")
        .and_then(|h| get_str(h, "message"))
        .map(|m| m.chars().take(200).collect())
        .unwrap_or_default()
}

/// `GET /auth/verify.json`: the server key, armored, and its fingerprint as the helper reads it
/// (not as the answer says it).
pub async fn server_key(
    outside: &Outside,
    url: &OutsideUrl,
) -> Result<(String, String), VaultError> {
    outside.check_host(url)?;
    let pgp = pgp_of(outside)?;
    let (status, v) = call(outside, url, "GET", "/auth/verify.json".into(), None, None).await?;
    if status != 200 {
        return Err(unreachable(format!(
            "Passbolt answered {status} when Fathom asked for its server key"
        )));
    }
    let b = body_of(v)?;
    let key = get_str(&b, "keydata")
        .filter(|k| k.len() <= 64 * 1024)
        .ok_or_else(|| unreachable("Passbolt gave no server key"))?
        .to_string();
    let (fp, _) = key_info(pgp, &key).await?;
    if get_str(&b, "fingerprint").is_some_and(|f| !f.eq_ignore_ascii_case(&fp)) {
        return Err(VaultError::OutsideRefused(
            "Passbolt's server key is not the one its fingerprint names".to_string(),
        ));
    }
    Ok((key, fp.to_ascii_lowercase()))
}

/// What setting up Fathom's account leaves: its private key, armored, and its fingerprint.
pub struct SetUp {
    pub secret: String,
    pub fingerprint: String,
}

impl Drop for SetUp {
    fn drop(&mut self) {
        wipe_string(&mut self.secret);
    }
}

/// Make Fathom's key and finish the invited account's setup with it. The server key must be
/// the one the person confirmed (`server_fp`). The invitation is spent whatever happens next.
pub async fn set_up(
    outside: &Outside,
    invite: &Invite,
    server_fp: &str,
) -> Result<SetUp, VaultError> {
    let pgp = pgp_of(outside)?;
    let (_, fp) = server_key(outside, &invite.url).await?;
    if !fp.eq_ignore_ascii_case(server_fp) {
        return Err(VaultError::OutsideRefused(
            "Passbolt's server key is not the one you were shown; check the address".to_string(),
        ));
    }
    let (secret, public, fingerprint) = make_key(pgp).await?;
    let done = SetUp {
        secret,
        fingerprint: fingerprint.to_ascii_lowercase(),
    };
    let body = req(vec![
        (
            "authentication_token",
            req(vec![("token", s(&invite.token))]),
        ),
        ("gpgkey", req(vec![("armored_key", s(&public))])),
    ]);
    let (status, v) = call(
        outside,
        &invite.url,
        "POST",
        format!("/setup/complete/{}.json", invite.user_id),
        None,
        Some(body),
    )
    .await?;
    match status {
        200 => {
            body_of(v)?;
            Ok(done)
        }
        400 | 403 | 404 => Err(VaultError::OutsideRefused(format!(
                "Passbolt refused the invitation{}; it may be used or out of date, so ask for a new one",
                match message_of(&v) {
                    m if m.is_empty() => String::new(),
                    m => format!(" (“{m}”)"),
                }
            ))),
        s => Err(unreachable(format!("Passbolt answered {s} to the setup"))),
    }
}

/// Seconds since 1970, for the challenge's expiry.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// The JWT sign-in: answers the access token.
async fn sign_in(
    outside: &Outside,
    url: &OutsideUrl,
    sec: &Secrets,
    server_key: &str,
) -> Result<String, VaultError> {
    let pgp = pgp_of(outside)?;
    let verify = new_device_id()?;
    let domain = url.to_text();
    let challenge = req(vec![
        ("version", s("1.0.0")),
        ("domain", s(&domain)),
        ("verify_token", s(&verify)),
        ("verify_token_expiry", Json::Int(now_secs() + 120)),
    ]);
    let sealed = seal_for(
        pgp,
        &sec.client_secret,
        server_key,
        &String::from_utf8(challenge.to_canonical_bytes()).unwrap_or_default(),
    )
    .await?;
    let (status, v) = call(
        outside,
        url,
        "POST",
        "/auth/jwt/login.json".into(),
        None,
        Some(req(vec![
            ("user_id", s(&sec.client_id)),
            ("challenge", s(&sealed)),
        ])),
    )
    .await?;
    match status {
        200 => {}
        400 | 404 => {
            return Err(VaultError::OutsideRefused(
                "Passbolt refused Fathom's sign-in: the account may be disabled or deleted, or the address is not Passbolt's own full address"
                    .to_string(),
            ))
        }
        s => return Err(unreachable(format!("Passbolt answered {s} to the sign-in"))),
    }
    let b = body_of(v)?;
    let data = get_str(&b, "challenge")
        .ok_or_else(|| unreachable("Passbolt's sign-in answer had no challenge"))?;
    let mut plain = open(pgp, &sec.client_secret, "", data, Some(server_key)).await?;
    let parsed = foreign_json::parse(plain.as_bytes());
    wipe_string(&mut plain);
    let a =
        parsed.map_err(|_| unreachable("Passbolt's sign-in answer was not one Fathom reads"))?;
    let same_domain = get_str(&a, "domain")
        .is_some_and(|d| d.trim_end_matches('/') == domain.trim_end_matches('/'));
    if get_str(&a, "verify_token") != Some(verify.as_str()) || !same_domain {
        return Err(VaultError::OutsideRefused(
            "Passbolt's sign-in answer was not for this challenge".to_string(),
        ));
    }
    get_str(&a, "access_token")
        .filter(|t| !t.is_empty() && t.len() <= 8192)
        .map(str::to_string)
        .ok_or_else(|| unreachable("Passbolt gave no access token"))
}

async fn get_body(
    outside: &Outside,
    url: &OutsideUrl,
    token: &str,
    path: String,
) -> Result<Json, VaultError> {
    let (status, v) = call(outside, url, "GET", path, Some(token), None).await?;
    match status {
        200 => body_of(v),
        403 if get(&v, "body").and_then(|b| get(b, "mfa_providers")).is_some() => {
            Err(VaultError::OutsideRefused(
                "the Passbolt account has multi-factor sign-in on; Fathom cannot answer it, so its account goes without"
                    .to_string(),
            ))
        }
        401 | 403 => Err(VaultError::OutsideRefused(
            "Passbolt refused the account Fathom reads with".to_string(),
        )),
        s => Err(unreachable(format!("Passbolt answered {s} when Fathom read it"))),
    }
}

// ---------------------------------------------------------------------------
// What one round reads
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    /// `None` when its name is sealed with a key this account was not given.
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub name: Option<String>,
    pub user: Option<String>,
    pub folder_id: Option<String>,
    pub personal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetadataKey {
    pub fingerprint: String,
    pub curve25519: bool,
    /// The Passbolt has given this account its private half.
    pub given: bool,
}

/// One secret's password. No `Debug`.
pub struct Secret {
    pub id: String,
    pub password: String,
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe_string(&mut self.password);
    }
}

pub struct Answer {
    pub role: String,
    pub folders: Vec<Folder>,
    pub items: Vec<Item>,
    /// The active shared metadata key, when the Passbolt has one (Passbolt 5).
    pub metadata_key: Option<MetadataKey>,
    /// The one pinned when the connection was bound.
    pub pinned_metadata: Option<String>,
    pub secret: Option<Secret>,
}

impl Answer {
    pub fn item(&self, id: &str) -> Option<&Item> {
        self.items.iter().find(|i| i.id == id)
    }
}

fn list<'a>(b: &'a Json, what: &'static str) -> Result<&'a [Json], VaultError> {
    let Json::Arr(rows) = b else {
        return Err(unreachable(format!("Passbolt's {what} were not a list")));
    };
    if rows.len() > MAX_ITEMS {
        return Err(VaultError::OutsideRefused(format!(
            "the account sees more {what} than Fathom reads; give it one small folder"
        )));
    }
    Ok(rows)
}

fn id_of(v: &Json, k: &str) -> Option<String> {
    get_str(v, k).and_then(uuid)
}

/// The private halves of metadata keys this account was given, by key id: `(armored, passphrase)`.
struct Opened(BTreeMap<String, (String, String)>);

impl Drop for Opened {
    fn drop(&mut self) {
        for (k, p) in self.0.values_mut() {
            wipe_string(k);
            wipe_string(p);
        }
    }
}

/// Open an item's sealed metadata, when it has some. `Ok(None)` when its key was not given.
async fn metadata_of(
    pgp: &dyn Pgp,
    v: &Json,
    sec: &Secrets,
    keys: &Opened,
    want: &str,
) -> Result<Option<Json>, VaultError> {
    let Some(data) = get_str(v, "metadata") else {
        return Ok(None);
    };
    let mut plain = match get_str(v, "metadata_key_type") {
        Some("user_key") => open(pgp, &sec.client_secret, "", data, None).await?,
        Some("shared_key") => {
            let Some((key, pass)) = get_str(v, "metadata_key_id")
                .and_then(uuid)
                .and_then(|id| keys.0.get(&id))
            else {
                return Ok(None);
            };
            open(pgp, key, pass, data, None).await?
        }
        _ => return Err(unreachable("an item's metadata names no key Fathom knows")),
    };
    let parsed = foreign_json::parse(plain.as_bytes());
    wipe_string(&mut plain);
    let m = parsed.map_err(|_| unreachable("an item's metadata was not one Fathom reads"))?;
    if get_str(&m, "object_type") != Some(want) {
        return Err(unreachable(
            "an item's metadata is not of the kind it should be",
        ));
    }
    Ok(Some(m))
}

/// The active metadata key, and the private halves of every key this account was given.
async fn metadata_keys(
    pgp: &dyn Pgp,
    b: &Json,
    sec: &Secrets,
) -> Result<(Option<MetadataKey>, Opened), VaultError> {
    let mut opened = Opened(BTreeMap::new());
    let mut active = None;
    for k in list(b, "metadata keys")? {
        if matches!(get(k, "deleted"), Some(Json::Str(_))) {
            continue;
        }
        let (Some(id), Some(armored)) = (id_of(k, "id"), get_str(k, "armored_key")) else {
            return Err(unreachable("a metadata key without an id or a key"));
        };
        let (fp, curve) = key_info(pgp, armored).await?;
        let mut given = false;
        for p in get_arr(k, "metadata_private_keys").unwrap_or(&[]) {
            if id_of(p, "user_id").as_deref() != Some(sec.client_id.as_str()) {
                continue;
            }
            let Some(data) = get_str(p, "data") else {
                continue;
            };
            given = true;
            // Never handed to the helper unless it is Curve25519: the check refuses it instead.
            if !curve {
                continue;
            }
            let mut plain = open(pgp, &sec.client_secret, "", data, None).await?;
            let parsed = foreign_json::parse(plain.as_bytes());
            wipe_string(&mut plain);
            let m = parsed
                .map_err(|_| unreachable("a metadata private key was not one Fathom reads"))?;
            let same = get_str(&m, "object_type") == Some("PASSBOLT_METADATA_PRIVATE_KEY")
                && get_str(&m, "fingerprint").is_some_and(|f| f.eq_ignore_ascii_case(&fp));
            if !same {
                return Err(VaultError::OutsideRefused(
                    "a metadata private key Passbolt gave is not the key it is listed as"
                        .to_string(),
                ));
            }
            if let (Some(key), pass) = (get_str(&m, "armored_key"), get_str(&m, "passphrase")) {
                opened.0.insert(
                    id.clone(),
                    (key.to_string(), pass.unwrap_or("").to_string()),
                );
            }
        }
        // The active key is the one not expired; Passbolt keeps one.
        if matches!(get(k, "expired"), None | Some(Json::Null)) {
            if active.is_some() {
                return Err(unreachable("Passbolt lists two active metadata keys"));
            }
            active = Some(MetadataKey {
                fingerprint: fp.to_ascii_lowercase(),
                curve25519: curve,
                given,
            });
        }
    }
    Ok((active, opened))
}

/// The password in a decrypted secret: v5 and v4 secrets are a JSON object with `password`;
/// a "password string" type is the password itself.
pub fn password_of(plain: &str) -> String {
    match foreign_json::parse(plain.as_bytes()) {
        Ok(v @ Json::Obj(_)) => get_str(&v, "password").unwrap_or("").to_string(),
        _ => plain.to_string(),
    }
}

/// Sign in and read what the account sees, opening names in the helper; and the one secret
/// `item` when a use asks for it.
pub async fn read(
    outside: &Outside,
    url: &OutsideUrl,
    sec: &Secrets,
    item: Option<&str>,
) -> Result<Answer, VaultError> {
    let pgp = pgp_of(outside)?;
    let (server, fp) = server_key(outside, url).await?;
    if sec.server_fp.as_deref() != Some(fp.as_str()) {
        return Err(VaultError::OutsideRefused(
            "Passbolt's server key changed since Fathom was set up there; connect it again if that was meant"
                .to_string(),
        ));
    }
    let mut token = sign_in(outside, url, sec, &server).await?;
    let round = async {
        let me = get_body(outside, url, &token, "/users/me.json".into()).await?;
        let role = get(&me, "role")
            .and_then(|r| get_str(r, "name"))
            .ok_or_else(|| unreachable("Passbolt did not say the account's role"))?
            .to_string();
        // The account's key is Fathom's: nobody replaced it in Passbolt since setup.
        let (mine, _) = key_info(pgp, &sec.client_secret).await?;
        let theirs = get(&me, "gpgkey").and_then(|g| get_str(g, "fingerprint"));
        if !theirs.is_some_and(|f| f.eq_ignore_ascii_case(&mine)) {
            return Err(VaultError::OutsideRefused(
                "the Passbolt account's key is not the one Fathom made for it".to_string(),
            ));
        }
        let keys_body = match call(
            outside,
            url,
            "GET",
            "/metadata/keys.json?contain%5Bmetadata_private_keys%5D=1".into(),
            Some(&token),
            None,
        )
        .await?
        {
            (200, v) => body_of(v)?,
            // Before Passbolt 5 there are no metadata keys.
            (404, _) => Json::Arr(Vec::new()),
            (s, _) => {
                return Err(unreachable(format!(
                    "Passbolt answered {s} for its metadata keys"
                )))
            }
        };
        let (metadata_key, opened) = metadata_keys(pgp, &keys_body, sec).await?;

        let mut folders = Vec::new();
        for f in list(
            &get_body(outside, url, &token, "/folders.json".into()).await?,
            "folders",
        )? {
            let id = id_of(f, "id").ok_or_else(|| unreachable("a folder without an id"))?;
            let name = match get_str(f, "name") {
                Some(n) => Some(n.to_string()),
                None => metadata_of(pgp, f, sec, &opened, "PASSBOLT_FOLDER_METADATA")
                    .await?
                    .and_then(|m| get_str(&m, "name").map(str::to_string)),
            };
            folders.push(Folder { id, name });
        }
        let mut items = Vec::new();
        for r in list(
            &get_body(outside, url, &token, "/resources.json".into()).await?,
            "items",
        )? {
            let id = id_of(r, "id").ok_or_else(|| unreachable("an item without an id"))?;
            let meta = metadata_of(pgp, r, sec, &opened, "PASSBOLT_RESOURCE_METADATA").await?;
            let field = |k: &str| {
                get_str(r, k)
                    .or_else(|| meta.as_ref().and_then(|m| get_str(m, k)))
                    .map(str::to_string)
            };
            items.push(Item {
                name: field("name"),
                user: field("username"),
                folder_id: id_of(r, "folder_parent_id"),
                personal: matches!(get(r, "personal"), Some(Json::Bool(true)))
                    || get_str(r, "metadata_key_type") == Some("user_key"),
                id,
            });
        }
        let secret = match item {
            None => None,
            Some(id) => {
                let id = uuid(id).ok_or(VaultError::Malformed("the item"))?;
                let b =
                    get_body(outside, url, &token, format!("/secrets/resource/{id}.json")).await?;
                let data = get_str(&b, "data")
                    .ok_or_else(|| unreachable("Passbolt's secret had no data"))?;
                let mut plain = open(pgp, &sec.client_secret, "", data, None).await?;
                let password = password_of(&plain);
                wipe_string(&mut plain);
                Some(Secret { id, password })
            }
        };
        Ok(Answer {
            role,
            folders,
            items,
            metadata_key,
            pinned_metadata: sec.metadata_fp.clone(),
            secret,
        })
    }
    .await;
    wipe_string(&mut token);
    round
}

/// The four checks. `folder` is the connection's folder once it is bound; `name` the name the
/// person typed.
pub fn checks(a: &Answer, folder: Option<&str>, name: Option<&str>) -> Vec<CheckLine> {
    let tidy = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let role = CheckLine {
        id: "role",
        passed: a.role == "user",
        text: if a.role == "user" {
            "It is a plain user, not an administrator".to_string()
        } else {
            format!(
                "It is a Passbolt {}; Fathom reads only as a plain user",
                a.role
            )
        },
    };
    let the_one = (a.folders.len() == 1).then(|| &a.folders[0]);
    let right = the_one.is_some_and(|f| {
        folder.is_none_or(|want| f.id == want)
            && name.is_none_or(|n| f.name.as_deref().map(tidy) == Some(tidy(n)))
    });
    let folder_line = CheckLine {
        id: "collection",
        passed: right,
        text: match (a.folders.len(), the_one) {
            (1, Some(f)) if right => {
                format!("It can see 1 folder: {}", f.name.as_deref().unwrap_or(""))
            }
            (1, Some(f)) => match (f.name.as_deref(), name) {
                (None, _) => "It can see 1 folder, whose name it cannot open yet".to_string(),
                (Some(have), Some(n)) if tidy(have) != tidy(n) => {
                    format!("Its one folder is called “{have}”, not “{}”", tidy(n))
                }
                _ => "It can see 1 folder, but not the one it was connected to".to_string(),
            },
            (0, _) => "It must see exactly 1 folder; it sees none yet".to_string(),
            (n, _) => format!("It must see exactly 1 folder; it sees {n}"),
        },
    };
    let stray = a
        .items
        .iter()
        .filter(|i| {
            i.personal || the_one.is_none_or(|f| i.folder_id.as_deref() != Some(f.id.as_str()))
        })
        .count();
    let items_line = CheckLine {
        id: "personal",
        passed: stray == 0 && the_one.is_some(),
        text: if the_one.is_none() {
            "Its items are checked once it sees 1 folder".to_string()
        } else if stray == 0 {
            "Every item it can see is in that folder, and none is personal".to_string()
        } else {
            format!(
                "It can see {stray} item{} outside its one folder, or personal",
                if stray == 1 { "" } else { "s" }
            )
        },
    };
    let sealed = a.folders.iter().filter(|f| f.name.is_none()).count()
        + a.items.iter().filter(|i| i.name.is_none()).count();
    let (passed, text) = match &a.metadata_key {
        None if sealed == 0 => (
            true,
            "This Passbolt keeps names without a shared metadata key".to_string(),
        ),
        None => (
            false,
            "Some names are sealed with a key this Passbolt does not list".to_string(),
        ),
        Some(k) if !k.curve25519 => (
            false,
            "Passbolt's shared metadata key is not Curve25519; Fathom will not open with it".to_string(),
        ),
        Some(k) if a.pinned_metadata.as_deref().is_some_and(|p| p != k.fingerprint) => (
            false,
            "Passbolt's shared metadata key changed since this was connected; connect it again if that was meant"
                .to_string(),
        ),
        Some(k) if !k.given => (
            false,
            "Passbolt has not given this account its shared metadata key yet; an administrator signs in to Passbolt to share it"
                .to_string(),
        ),
        Some(_) if sealed > 0 => (
            false,
            format!("{sealed} name{} sealed with a key this account was not given", if sealed == 1 { " is" } else { "s are" }),
        ),
        Some(_) => (true, "Passbolt's shared metadata key is Curve25519".to_string()),
    };
    vec![
        role,
        folder_line,
        items_line,
        CheckLine {
            id: "metadata",
            passed,
            text,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "0a1b2c3d-0000-4000-8000-123456789abc";
    const T: &str = "1a1b2c3d-0000-4000-8000-123456789abc";

    #[test]
    fn an_invitation_is_an_address_and_two_ids() {
        let i = parse_invite(&format!("https://pb.example.org/setup/start/{U}/{T}")).unwrap();
        assert_eq!(
            (i.url.to_text(), i.user_id.as_str(), i.token.as_str()),
            ("https://pb.example.org".to_string(), U, T)
        );
        let i = parse_invite(&format!(
            "https://pb.example.org:8443/pass/setup/start/{}/{T}/",
            U.to_uppercase()
        ))
        .unwrap();
        assert_eq!((i.url.prefix.as_str(), i.user_id.as_str()), ("/pass", U));
        for bad in [
            format!("http://pb.example.org/setup/start/{U}/{T}"),
            format!("https://pb.example.org/setup/install/{U}/{T}"),
            format!("https://pb.example.org/setup/start/{U}"),
            format!("https://pb.example.org/setup/start/{U}/not-a-uuid"),
            format!("https://pb.example.org/setup/start/{U}/{T}/x"),
        ] {
            assert!(parse_invite(&bad).is_err(), "{bad}");
        }
    }

    fn answer() -> Answer {
        Answer {
            role: "user".into(),
            folders: vec![Folder {
                id: U.into(),
                name: Some("Fathom".into()),
            }],
            items: vec![Item {
                id: T.into(),
                name: Some("core-sw1".into()),
                user: Some("admin".into()),
                folder_id: Some(U.into()),
                personal: false,
            }],
            metadata_key: Some(MetadataKey {
                fingerprint: "ab".into(),
                curve25519: true,
                given: true,
            }),
            pinned_metadata: Some("ab".into()),
            secret: None,
        }
    }

    #[test]
    fn a_plain_user_seeing_one_shared_folder_with_a_curve25519_key_passes() {
        let lines = checks(&answer(), Some(U), Some(" Fathom "));
        assert!(super::super::vaultwarden::all_pass(&lines), "{lines:?}");
        assert_eq!(lines[1].text, "It can see 1 folder: Fathom");
    }

    #[test]
    fn each_check_fails_on_what_it_guards() {
        let fails = |a: &Answer, id: &str| {
            checks(a, Some(U), Some("Fathom"))
                .iter()
                .any(|l| l.id == id && !l.passed)
        };
        let mut a = answer();
        a.role = "admin".into();
        assert!(fails(&a, "role"));
        let mut a = answer();
        a.folders.push(Folder {
            id: T.into(),
            name: Some("Other".into()),
        });
        assert!(fails(&a, "collection"));
        let mut a = answer();
        a.items[0].personal = true;
        assert!(fails(&a, "personal"));
        let mut a = answer();
        a.items[0].folder_id = None;
        assert!(fails(&a, "personal"));
        for change in [
            |k: &mut MetadataKey| k.curve25519 = false,
            |k: &mut MetadataKey| k.given = false,
            |k: &mut MetadataKey| k.fingerprint = "cd".into(),
        ] {
            let mut a = answer();
            change(a.metadata_key.as_mut().unwrap());
            assert!(fails(&a, "metadata"));
        }
        let mut a = answer();
        a.items[0].name = None;
        assert!(fails(&a, "metadata"));
        // Waiting: nothing shared yet.
        let mut a = answer();
        a.folders.clear();
        a.items.clear();
        let lines = checks(&a, None, Some("Fathom"));
        assert_eq!(
            lines[1].text,
            "It must see exactly 1 folder; it sees none yet"
        );
    }

    #[test]
    fn the_password_is_the_secret_s_password_field_or_the_whole_string() {
        assert_eq!(
            password_of(
                r#"{"object_type":"PASSBOLT_SECRET_DATA","password":"p4ss","description":"d"}"#
            ),
            "p4ss"
        );
        assert_eq!(password_of("plain-password"), "plain-password");
    }
}

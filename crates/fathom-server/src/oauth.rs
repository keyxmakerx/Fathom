//! The connector sign-in: Fathom as its own OAuth authorization server for `/mcp`
//! (ADR-0072 decisions 13 to 19).
//!
//! An AI app such as Claude adds `<public url>/mcp` as a connector. Its first request has no
//! token, so `/mcp` answers `401` with a pointer to [`Connector::protected_resource`]; the app
//! reads [`Connector::authorization_server`], sends the person's browser to the sign-in page
//! (`/oauth/authorize`, the client), and the person signs in and chooses what the app may
//! read. Allow makes a grant, which is an `ai_keys` row of kind `connector`, and a one-minute
//! code; the app trades the code at `/oauth/token` for an access token (one hour) and a
//! refresh token (single use). Every rule a helper key obeys, a connector obeys too, because
//! `/mcp` turns its token into the same [`VerifiedAi`] and the same `ai::open`.
//!
//! What this file decides, and the source for each (read 2026-10-25):
//!
//! - **Discovery.** Protected-resource metadata (RFC 9728) at both well-known paths and a
//!   `resource_metadata` pointer on every `401`; authorization-server metadata (RFC 8414)
//!   advertising S256 PKCE, `none` client authentication, Client ID Metadata Documents and the
//!   `iss` response parameter (RFC 9207). MCP authorization 2025-11-25 and 2026-07-28;
//!   Claude's "Authentication for connectors".
//! - **Which apps.** Claude and Claude Code are pinned here by the client ids and redirects
//!   their published metadata documents name, so Fathom fetches nothing it is shown (there is
//!   no outbound HTTP client in this server, and a fetch of an unknown URL is an SSRF door).
//!   Any other app registers itself (RFC 7591) with `https` or loopback redirects only.
//! - **Redirects** match exactly, except that a loopback redirect matches on any port
//!   (RFC 8252 section 7.3), which Claude Code needs.
//! - **Codes** last [`CODE_SECS`], are spent once, and need the S256 verifier, the same
//!   client and the same redirect. A code presented twice ends every token its grant has.
//! - **Tokens** are 32 random bytes; only a labelled SHA-256 is stored. A refresh token is
//!   spent on use and replaced; one presented after it was spent ends its whole sign-in
//!   (OAuth 2.1 section 4.3.1). Nothing outlives the grant.
//! - **Is it Claude?** A grant to Claude's hosted apps can only be used from Anthropic's
//!   published outbound range, `160.79.104.0/21` by default (Anthropic, "IP addresses").

use std::collections::BTreeMap;
use std::net::IpAddr;

use deadpool_postgres::{Object, Pool, Transaction};
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::ai::{self, AiError, AiKey, NewConnector, VerifiedAi};
use crate::client_address::Cidr;
use crate::crypto;
use crate::grants::Authority;
use crate::keys::KeyRing;
use crate::repo;

/// Hash tag of an authorization code as stored.
const TAG_CODE: &[u8] = b"fathom/ai/oauth/code/v1";
/// Hash tag of an access or refresh token as stored.
const TAG_TOKEN: &[u8] = b"fathom/ai/oauth/token/v1";

/// Every label this module introduces, as `ai::LABELS` lists that module's.
pub const LABELS: &[(&str, &str)] = &[
    (
        "fathom/ai/oauth/code/v1",
        "hash tag of a connector sign-in code",
    ),
    (
        "fathom/ai/oauth/token/v1",
        "hash tag of a connector access or refresh token",
    ),
];

/// How long an access token lasts.
pub const ACCESS_SECS: i64 = 3600;
/// How long a sign-in code lasts.
pub const CODE_SECS: i64 = 60;
/// The one scope there is: read and recommend, as the grant itself says.
pub const SCOPE: &str = "fathom";
/// Anthropic's published outbound range ("IP addresses", read 2026-10-25).
pub const CLAUDE_RANGES_DEFAULT: &str = "160.79.104.0/21";
/// Registrations nobody has signed in with, at most, before registering waits.
pub const MAX_UNUSED_REGISTRATIONS: i64 = 500;
/// The MCP revisions `/mcp` speaks, newest first.
pub const PROTOCOL_VERSIONS: [&str; 4] = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// The operator's connector settings. None of `/mcp` or `/oauth/*` exists without them.
#[derive(Clone, Debug)]
pub struct Connector {
    public_url: String,
    sign_in_url: String,
    claude_ranges: Vec<Cidr>,
}

/// `https://host[:port]`, or `http://` to a loopback host for a server on one computer;
/// no path, query, fragment or user.
fn base_url(text: &str) -> Option<String> {
    let text = text.trim().trim_end_matches('/');
    let (scheme, rest) = text.split_once("://")?;
    if rest.is_empty()
        || rest
            .chars()
            .any(|c| matches!(c, '/' | '?' | '#' | '@' | ' ') || c.is_control())
    {
        return None;
    }
    let host = host_of_authority(rest);
    match scheme {
        "https" => Some(format!("https://{}", rest.to_ascii_lowercase())),
        "http" if is_loopback_host(&host) => Some(format!("http://{}", rest.to_ascii_lowercase())),
        _ => None,
    }
}

fn host_of_authority(authority: &str) -> String {
    let lower = authority.to_ascii_lowercase();
    if let Some(end) = lower.strip_prefix('[').and_then(|r| r.find(']')) {
        return lower[..end + 2].to_string();
    }
    lower.split(':').next().unwrap_or("").to_string()
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

impl Connector {
    /// `FATHOM_AI_PUBLIC_URL`, `FATHOM_AI_SIGN_IN_URL` (default: the public one) and
    /// `FATHOM_AI_CLAUDE_RANGES` (default [`CLAUDE_RANGES_DEFAULT`]; empty to switch the
    /// check off).
    pub fn new(
        public_url: &str,
        sign_in_url: Option<&str>,
        claude_ranges: Option<&str>,
    ) -> Result<Self, &'static str> {
        let public_url = base_url(public_url).ok_or("FATHOM_AI_PUBLIC_URL")?;
        let sign_in_url = match sign_in_url.filter(|s| !s.trim().is_empty()) {
            None => public_url.clone(),
            Some(s) => base_url(s).ok_or("FATHOM_AI_SIGN_IN_URL")?,
        };
        let ranges = claude_ranges.unwrap_or(CLAUDE_RANGES_DEFAULT);
        let claude_ranges = ranges
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| Cidr::parse(s).ok_or("FATHOM_AI_CLAUDE_RANGES"))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            public_url,
            sign_in_url,
            claude_ranges,
        })
    }

    /// The canonical URI of `/mcp` (RFC 8707), and the audience of every token.
    pub fn resource(&self) -> String {
        format!("{}/mcp", self.public_url)
    }

    pub fn issuer(&self) -> &str {
        &self.public_url
    }

    /// The origin a person's browser signs in at.
    pub fn sign_in_origin(&self) -> &str {
        &self.sign_in_url
    }

    fn resource_metadata_url(&self) -> String {
        format!(
            "{}/.well-known/oauth-protected-resource/mcp",
            self.public_url
        )
    }

    /// RFC 9728.
    pub fn protected_resource(&self) -> Json {
        obj(&[
            ("resource", Json::Str(self.resource())),
            (
                "authorization_servers",
                Json::Arr(vec![Json::Str(self.public_url.clone())]),
            ),
            (
                "bearer_methods_supported",
                Json::Arr(vec![Json::Str("header".into())]),
            ),
            ("scopes_supported", Json::Arr(vec![Json::Str(SCOPE.into())])),
            ("resource_name", Json::Str("Fathom".into())),
        ])
    }

    /// RFC 8414. The sign-in page may be on another address than the rest ("split metadata").
    pub fn authorization_server(&self) -> Json {
        let strs = |v: &[&str]| Json::Arr(v.iter().map(|s| Json::Str((*s).into())).collect());
        obj(&[
            ("issuer", Json::Str(self.public_url.clone())),
            (
                "authorization_endpoint",
                Json::Str(format!("{}/oauth/authorize", self.sign_in_url)),
            ),
            (
                "token_endpoint",
                Json::Str(format!("{}/oauth/token", self.public_url)),
            ),
            (
                "registration_endpoint",
                Json::Str(format!("{}/oauth/register", self.public_url)),
            ),
            ("scopes_supported", strs(&[SCOPE])),
            ("response_types_supported", strs(&["code"])),
            (
                "grant_types_supported",
                strs(&["authorization_code", "refresh_token"]),
            ),
            ("token_endpoint_auth_methods_supported", strs(&["none"])),
            ("code_challenge_methods_supported", strs(&["S256"])),
            ("client_id_metadata_document_supported", Json::Bool(true)),
            (
                "authorization_response_iss_parameter_supported",
                Json::Bool(true),
            ),
        ])
    }

    /// The `WWW-Authenticate` value on a `401` from `/mcp`.
    pub fn challenge(&self, error: Option<&str>) -> String {
        let mut out = String::from("Bearer ");
        if let Some(e) = error {
            out.push_str(&format!("error=\"{e}\", "));
        }
        out.push_str(&format!(
            "resource_metadata=\"{}\", scope=\"{SCOPE}\"",
            self.resource_metadata_url()
        ));
        out
    }

    /// A Claude grant is held to Anthropic's range; with no ranges set, it is not.
    fn is_claude_address(&self, address: &str) -> bool {
        if self.claude_ranges.is_empty() {
            return true;
        }
        match address.parse::<IpAddr>() {
            Ok(ip) => self.claude_ranges.iter().any(|c| c.contains(ip)),
            Err(_) => false,
        }
    }

    /// The `resource` a client named, if it named one, is this server's `/mcp`.
    fn names_this_resource(&self, resource: Option<&str>) -> bool {
        match resource {
            None => true,
            Some(r) => {
                let r = r.trim_end_matches('/');
                match r.split_once("://") {
                    Some((scheme, rest)) => {
                        let (authority, path) = match rest.find('/') {
                            Some(i) => (&rest[..i], &rest[i..]),
                            None => (rest, ""),
                        };
                        format!(
                            "{}://{}{}",
                            scheme.to_ascii_lowercase(),
                            authority.to_ascii_lowercase(),
                            path
                        ) == self.resource()
                    }
                    None => false,
                }
            }
        }
    }
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Obj(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// The apps
// ---------------------------------------------------------------------------

struct Known {
    id: &'static str,
    name: &'static str,
    app: &'static str,
    redirects: &'static [&'static str],
}

/// Claude's two published client metadata documents, fetched 2026-10-25.
const KNOWN: [Known; 2] = [
    Known {
        id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
        name: "Claude",
        app: "claude",
        redirects: &["https://claude.ai/api/mcp/auth_callback"],
    },
    Known {
        id: "https://claude.ai/oauth/claude-code-client-metadata",
        name: "Claude Code",
        app: "claude-code",
        redirects: &["http://localhost/callback", "http://127.0.0.1/callback"],
    },
];

/// Which of `ai::APPS` a client id is.
pub fn app_of(client_id: &str) -> &'static str {
    KNOWN
        .iter()
        .find(|k| k.id == client_id)
        .map(|k| k.app)
        .unwrap_or("other")
}

/// An app that may ask for a sign-in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub app: &'static str,
    pub redirects: Vec<String>,
}

/// A transaction under `app.ai_custody`, as `ai::verify_request` opens one.
async fn custody(client: &mut Object) -> Result<Transaction<'_>, AiError> {
    let tx = client.transaction().await?;
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.ai_custody', 'yes', true)", &[])
        .await?;
    Ok(tx)
}

async fn find_client(tx: &Transaction<'_>, id: &str) -> Result<Option<Client>, AiError> {
    if let Some(k) = KNOWN.iter().find(|k| k.id == id) {
        return Ok(Some(Client {
            id: k.id.into(),
            name: k.name.into(),
            app: k.app,
            redirects: k.redirects.iter().map(|r| (*r).to_string()).collect(),
        }));
    }
    if id.starts_with("https://") || id.starts_with("http://") {
        // A metadata document Fathom has not pinned is not fetched (decision 16).
        return Ok(None);
    }
    let row = tx
        .query_opt(
            "SELECT client_name, redirect_uris FROM ai_oauth_clients WHERE id = $1",
            &[&id],
        )
        .await?;
    Ok(row.map(|r| Client {
        id: id.to_string(),
        name: r.get(0),
        app: "other",
        redirects: r.get(1),
    }))
}

/// `(host, path and query)` of a loopback `http` redirect, or `None`.
fn loopback(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let host = host_of_authority(authority);
    if !is_loopback_host(&host) {
        return None;
    }
    let port = &authority[host.len().min(authority.len())..];
    if !(port.is_empty()
        || (port.starts_with(':') && port[1..].bytes().all(|b| b.is_ascii_digit())))
    {
        return None;
    }
    Some((host, path.to_string()))
}

/// Exact, except that a loopback redirect matches on any port.
pub fn redirect_matches(registered: &[String], asked: &str) -> bool {
    registered.iter().any(|r| {
        r == asked
            || match (loopback(r), loopback(asked)) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            }
    })
}

/// The host a person is shown for where the sign-in returns to.
pub fn redirect_host(uri: &str) -> String {
    if loopback(uri).is_some() {
        return "this computer".into();
    }
    let rest = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    host_of_authority(authority)
}

/// A redirect an app may register: `https` to a host, or loopback `http`. No fragment, no
/// user, at most 300 characters.
fn registrable_redirect(uri: &str) -> bool {
    if uri.len() > 300 || uri.contains('#') || uri.chars().any(|c| c.is_control() || c == ' ') {
        return false;
    }
    if loopback(uri).is_some() {
        return true;
    }
    let Some(rest) = uri.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    !authority.is_empty() && !authority.contains('@')
}

// ---------------------------------------------------------------------------
// Small encodings
// ---------------------------------------------------------------------------

pub fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(A[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(A[n as usize & 63] as char);
        }
    }
    out
}

/// `application/x-www-form-urlencoded`, as a query string or a token request body. A
/// parameter named twice is refused (RFC 6749 section 3.1).
pub fn form(text: &str) -> Result<BTreeMap<String, String>, &'static str> {
    let mut out = BTreeMap::new();
    for pair in text.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let k = pct_decode(k)?;
        if out.insert(k, pct_decode(v)?).is_some() {
            return Err("a parameter is named twice");
        }
    }
    Ok(out)
}

fn pct_decode(text: &str) -> Result<String, &'static str> {
    let b = text.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = b.get(i + 1..i + 3).ok_or("a broken % escape")?;
                let hex = std::str::from_utf8(hex).map_err(|_| "a broken % escape")?;
                out.push(u8::from_str_radix(hex, 16).map_err(|_| "a broken % escape")?);
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8(out).map_err(|_| "not UTF-8")
}

fn pct_encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `uri` with `params` added to its query.
fn with_params(uri: &str, params: &[(&str, &str)]) -> String {
    let mut out = uri.to_string();
    let mut sep = if uri.contains('?') { '&' } else { '?' };
    for (k, v) in params {
        out.push(sep);
        out.push_str(k);
        out.push('=');
        out.push_str(&pct_encode(v));
        sep = '&';
    }
    out
}

fn hash(tag: &[u8], secret: &str) -> Vec<u8> {
    let mut msg = Vec::new();
    crypto::lp(&mut msg, tag);
    crypto::lp(&mut msg, secret.as_bytes());
    Sha256::digest(&msg).to_vec()
}

fn secret(prefix: &str) -> Result<String, AiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AiError::Crypto(crypto::CryptoError::NoRandomness))?;
    Ok(format!("{prefix}{}", b64url(&bytes)))
}

/// A PKCE challenge as S256 makes one: 43 base64url characters.
fn is_challenge(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// RFC 7636 section 4.1: 43 to 128 unreserved characters.
fn is_verifier(text: &str) -> bool {
    (43..=128).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

// ---------------------------------------------------------------------------
// Registration (RFC 7591)
// ---------------------------------------------------------------------------

/// What an app learns from a refused registration or token request.
#[derive(Debug)]
pub struct OAuthError {
    pub status: u16,
    pub error: &'static str,
    pub description: &'static str,
}

impl OAuthError {
    fn bad(error: &'static str, description: &'static str) -> Self {
        Self {
            status: 400,
            error,
            description,
        }
    }

    pub fn to_json(&self) -> Json {
        obj(&[
            ("error", Json::Str(self.error.into())),
            ("error_description", Json::Str(self.description.into())),
        ])
    }
}

/// Either an answer for the app, or a fault on this side.
#[derive(Debug)]
pub enum Refusal {
    OAuth(OAuthError),
    Ai(AiError),
}

impl From<AiError> for Refusal {
    fn from(e: AiError) -> Self {
        Self::Ai(e)
    }
}

impl From<OAuthError> for Refusal {
    fn from(e: OAuthError) -> Self {
        Self::OAuth(e)
    }
}

impl From<tokio_postgres::Error> for Refusal {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Ai(e.into())
    }
}

impl From<deadpool_postgres::PoolError> for Refusal {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Ai(e.into())
    }
}

/// `POST /oauth/register`. Public clients only; nothing to sign in with is returned, because
/// there is nothing: the client id names a list of redirects and a name to show.
pub async fn register(pool: &Pool, body: &[u8]) -> Result<Json, Refusal> {
    let bad = |d| OAuthError::bad("invalid_client_metadata", d);
    let Json::Obj(m) = crate::json_in::parse(body).map_err(|_| bad("the body is not JSON"))? else {
        return Err(bad("the body is not a JSON object").into());
    };
    let redirects: Vec<String> = match m.get("redirect_uris") {
        Some(Json::Arr(items)) if (1..=5).contains(&items.len()) => items
            .iter()
            .map(|i| match i {
                Json::Str(s) if registrable_redirect(s) => Ok(s.clone()),
                _ => Err(OAuthError::bad(
                    "invalid_redirect_uri",
                    "redirects are https, or http to this computer",
                )),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(bad("one to five redirect_uris").into()),
    };
    match m.get("token_endpoint_auth_method") {
        None => {}
        Some(Json::Str(s)) if s == "none" => {}
        _ => return Err(bad("this server registers public clients only (none)").into()),
    }
    if let Some(Json::Arr(types)) = m.get("grant_types") {
        if types.iter().any(
            |t| !matches!(t, Json::Str(s) if s == "authorization_code" || s == "refresh_token"),
        ) {
            return Err(bad("grant_types are authorization_code and refresh_token").into());
        }
    }
    let name = match m.get("client_name") {
        Some(Json::Str(s)) if !s.trim().is_empty() => {
            ai::clean_line(s, 100, false).map_err(|_| bad("client_name is not plain text"))?
        }
        _ => redirect_host(&redirects[0]),
    };

    let mut client = pool.get().await?;
    let tx = custody(&mut client).await?;
    tx.execute(
        "DELETE FROM ai_oauth_clients WHERE NOT used AND created_at < now() - interval '1 hour'",
        &[],
    )
    .await?;
    let unused: i64 = tx
        .query_one("SELECT count(*) FROM ai_oauth_clients WHERE NOT used", &[])
        .await?
        .get(0);
    if unused >= MAX_UNUSED_REGISTRATIONS {
        return Err(OAuthError {
            status: 429,
            error: "temporarily_unavailable",
            description: "too many registrations nobody has signed in with; try again later",
        }
        .into());
    }
    let id = secret("fathom-app-")?;
    tx.execute(
        "INSERT INTO ai_oauth_clients (id, client_name, redirect_uris) VALUES ($1, $2, $3)",
        &[&id, &name, &redirects],
    )
    .await?;
    tx.commit().await?;
    let strs = |v: &[&str]| Json::Arr(v.iter().map(|s| Json::Str((*s).into())).collect());
    Ok(obj(&[
        ("client_id", Json::Str(id)),
        ("client_name", Json::Str(name)),
        (
            "redirect_uris",
            Json::Arr(redirects.into_iter().map(Json::Str).collect()),
        ),
        (
            "grant_types",
            strs(&["authorization_code", "refresh_token"]),
        ),
        ("response_types", strs(&["code"])),
        ("token_endpoint_auth_method", Json::Str("none".into())),
        ("client_id_issued_at", Json::Int(ai::now_unix())),
    ]))
}

// ---------------------------------------------------------------------------
// The sign-in request
// ---------------------------------------------------------------------------

/// The query `/oauth/authorize` was opened with, as the client page passes it on.
#[derive(Clone, Debug, Default)]
pub struct AuthRequest {
    pub response_type: Option<String>,
    pub client_id: Option<String>,
    pub redirect_uri: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub resource: Option<String>,
    pub state: Option<String>,
}

impl AuthRequest {
    pub fn from_form(f: &BTreeMap<String, String>) -> Self {
        let get = |k: &str| f.get(k).cloned();
        Self {
            response_type: get("response_type"),
            client_id: get("client_id"),
            redirect_uri: get("redirect_uri"),
            code_challenge: get("code_challenge"),
            code_challenge_method: get("code_challenge_method"),
            resource: get("resource"),
            state: get("state"),
        }
    }
}

/// A sign-in request that stands: the app, where it returns to, and the challenge.
#[derive(Clone, Debug)]
pub struct Checked {
    pub client: Client,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub state: Option<String>,
}

/// Why a sign-in request cannot go ahead. `back` is where the person's browser is sent
/// with the error, when the redirect itself stood; otherwise the page shows it and goes
/// nowhere (OAuth 2.1 section 4.1.2.1).
#[derive(Clone, Debug)]
pub struct AuthProblem {
    pub error: &'static str,
    pub description: &'static str,
    pub back: Option<String>,
}

impl AuthProblem {
    pub fn to_json(&self) -> Json {
        obj(&[
            ("error", Json::Str(self.error.into())),
            ("description", Json::Str(self.description.into())),
            (
                "back",
                match &self.back {
                    Some(b) => Json::Str(b.clone()),
                    None => Json::Null,
                },
            ),
        ])
    }
}

impl Connector {
    fn back(&self, redirect: &str, state: Option<&str>, params: &[(&str, &str)]) -> String {
        let mut all: Vec<(&str, &str)> = params.to_vec();
        if let Some(s) = state {
            all.push(("state", s));
        }
        all.push(("iss", self.issuer()));
        with_params(redirect, &all)
    }

    /// Check a sign-in request without anyone signed in: what the page shows before Allow.
    pub async fn check(
        &self,
        pool: &Pool,
        req: &AuthRequest,
    ) -> Result<Result<Checked, AuthProblem>, AiError> {
        let mut client = pool.get().await?;
        let tx = custody(&mut client).await?;
        let found = match &req.client_id {
            Some(id) => find_client(&tx, id).await?,
            None => None,
        };
        tx.commit().await?;
        let stop = |description| AuthProblem {
            error: "invalid_request",
            description,
            back: None,
        };
        let Some(found) = found else {
            return Ok(Err(stop(
                "Fathom does not know this app. It may need to register again.",
            )));
        };
        let Some(redirect) = req.redirect_uri.clone() else {
            return Ok(Err(stop("The app did not say where to return to.")));
        };
        if !redirect_matches(&found.redirects, &redirect) {
            return Ok(Err(stop(
                "The app asked to return somewhere it did not register, so the sign-in stops here.",
            )));
        }
        let state = req.state.clone().filter(|s| s.len() <= 500);
        let back = |error, description| AuthProblem {
            error,
            description,
            back: Some(self.back(
                &redirect,
                state.as_deref(),
                &[("error", error), ("error_description", description)],
            )),
        };
        if req.response_type.as_deref() != Some("code") {
            return Ok(Err(back(
                "unsupported_response_type",
                "Only response_type=code is supported.",
            )));
        }
        if req.code_challenge_method.as_deref() != Some("S256")
            || !req.code_challenge.as_deref().is_some_and(is_challenge)
        {
            return Ok(Err(back(
                "invalid_request",
                "A PKCE S256 code_challenge is required.",
            )));
        }
        if !self.names_this_resource(req.resource.as_deref()) {
            return Ok(Err(back(
                "invalid_target",
                "The resource is not this server's /mcp.",
            )));
        }
        Ok(Ok(Checked {
            client: found,
            redirect_uri: redirect,
            code_challenge: req.code_challenge.clone().unwrap_or_default(),
            state,
        }))
    }

    /// Where "Don't allow" sends the browser.
    pub fn denied(&self, checked: &Checked) -> String {
        self.back(
            &checked.redirect_uri,
            checked.state.as_deref(),
            &[
                ("error", "access_denied"),
                ("error_description", "The person did not allow it."),
            ],
        )
    }

    /// Allow: make the grant in the person's organisation and a one-minute code for it, and
    /// say where the browser goes next. `tx` is the person's signed request's transaction.
    pub async fn allow(
        &self,
        tx: &Transaction<'_>,
        auth: &Authority<'_>,
        checked: &Checked,
        choice: NewConnector,
    ) -> Result<(AiKey, String), AiError> {
        if choice.client_id != checked.client.id {
            return Err(AiError::Malformed(
                "the app changed between the check and Allow",
            ));
        }
        let key = ai::make_connector(tx, auth, choice).await?;
        let code = secret("fac_")?;
        tx.execute(
            "INSERT INTO ai_oauth_codes (code_hash, organisation_id, key_id, client_id, \
                 redirect_uri, code_challenge, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))",
            &[
                &hash(TAG_CODE, &code),
                &key.organisation,
                &key.id,
                &checked.client.id,
                &checked.redirect_uri,
                &checked.code_challenge,
                &(CODE_SECS as f64),
            ],
        )
        .await?;
        let to = self.back(
            &checked.redirect_uri,
            checked.state.as_deref(),
            &[("code", &code)],
        );
        Ok((key, to))
    }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

fn invalid_grant(description: &'static str) -> Refusal {
    OAuthError::bad("invalid_grant", description).into()
}

/// Everything a grant must still be for a token to be issued or used on it.
async fn still_stands(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    connector: &Connector,
    organisation: &str,
    key_id: &str,
    address: &str,
) -> Result<Option<AiKey>, AiError> {
    if !ai::read_switch(tx, ring).await?.allowed {
        return Ok(None);
    }
    repo::set_custody_tenant(tx, organisation).await?;
    let Some(key) = ai::read_key(tx, ring, organisation, key_id, false).await? else {
        return Ok(None);
    };
    if key.kind != "connector" || !key.is_live(ai::now_unix()) {
        return Ok(None);
    }
    let policy = ai::read_policy(tx, ring, organisation, false).await?;
    if !policy.allowed
        || !policy.makers.contains(&key.owner)
        || !policy.apps.iter().any(|a| a == key.app())
    {
        return Ok(None);
    }
    if key.app() == "claude" && !connector.is_claude_address(address) {
        tracing::warn!(key = %key.id, "a Claude grant was used from outside Anthropic's range");
        return Ok(None);
    }
    Ok(Some(key))
}

async fn issue(
    tx: &Transaction<'_>,
    key: &AiKey,
    family: &str,
    refresh_ends_unix: i64,
) -> Result<Json, AiError> {
    let now = ai::now_unix();
    let access = secret("fat_")?;
    let refresh = secret("far_")?;
    let access_ends = (now + ACCESS_SECS).min(key.expires_unix);
    let refresh_ends = refresh_ends_unix.min(key.expires_unix);
    for (token, kind, ends) in [
        (&access, "access", access_ends),
        (&refresh, "refresh", refresh_ends),
    ] {
        tx.execute(
            "INSERT INTO ai_oauth_tokens (token_hash, organisation_id, key_id, family, kind, \
                 expires_at) VALUES ($1, $2, $3, $4, $5, to_timestamp($6::bigint))",
            &[
                &hash(TAG_TOKEN, token),
                &key.organisation,
                &key.id,
                &family,
                &kind,
                &ends,
            ],
        )
        .await?;
    }
    Ok(obj(&[
        ("access_token", Json::Str(access)),
        ("token_type", Json::Str("Bearer".into())),
        ("expires_in", Json::Int((access_ends - now).max(0))),
        ("refresh_token", Json::Str(refresh)),
        ("scope", Json::Str(SCOPE.into())),
    ]))
}

/// End every token a grant has: a code was presented twice.
async fn end_grant_tokens(tx: &Transaction<'_>, key_id: &str) -> Result<(), AiError> {
    tx.execute(
        "UPDATE ai_oauth_tokens SET expires_at = now() WHERE key_id = $1 AND expires_at > now()",
        &[&key_id],
    )
    .await?;
    Ok(())
}

impl Connector {
    /// `POST /oauth/token`, `application/x-www-form-urlencoded`.
    pub async fn token(
        &self,
        pool: &Pool,
        ring: &KeyRing,
        f: &BTreeMap<String, String>,
        address: &str,
    ) -> Result<Json, Refusal> {
        let get = |k: &str| f.get(k).map(String::as_str);
        let client_id = get("client_id").ok_or_else(|| {
            Refusal::OAuth(OAuthError {
                status: 401,
                error: "invalid_client",
                description: "client_id is required",
            })
        })?;
        if !self.names_this_resource(get("resource")) {
            return Err(OAuthError::bad(
                "invalid_target",
                "the resource is not this server's /mcp",
            )
            .into());
        }
        let mut client = pool.get().await?;
        let tx = custody(&mut client).await?;
        let answer = match get("grant_type") {
            Some("authorization_code") => {
                let (Some(code), Some(verifier), Some(redirect)) =
                    (get("code"), get("code_verifier"), get("redirect_uri"))
                else {
                    return Err(OAuthError::bad(
                        "invalid_request",
                        "code, code_verifier and redirect_uri are required",
                    )
                    .into());
                };
                // Spent in the same statement that reads it, so two presentations cannot
                // both see it unspent. A row the policy no longer shows is a spent one (the
                // UPDATE policy hides it), which the plain read below tells apart.
                let row = tx
                    .query_opt(
                        "UPDATE ai_oauth_codes SET used_at = now() \
                         WHERE code_hash = $1 AND used_at IS NULL \
                         RETURNING organisation_id, key_id, client_id, redirect_uri, \
                                   code_challenge, expires_at > now()",
                        &[&hash(TAG_CODE, code)],
                    )
                    .await?;
                let Some(row) = row else {
                    let seen = tx
                        .query_opt(
                            "SELECT key_id FROM ai_oauth_codes WHERE code_hash = $1",
                            &[&hash(TAG_CODE, code)],
                        )
                        .await?;
                    let Some(seen) = seen else {
                        return Err(invalid_grant("that code is not one this server gave"));
                    };
                    // A code presented twice: whoever has it, end what it bought.
                    end_grant_tokens(&tx, &seen.get::<_, String>(0)).await?;
                    tx.commit().await?;
                    tracing::warn!("a spent sign-in code was presented again");
                    return Err(invalid_grant("that code was already used"));
                };
                let (organisation, key_id): (String, String) = (row.get(0), row.get(1));
                let challenge: String = row.get(4);
                let expected = b64url(&Sha256::digest(verifier.as_bytes()));
                if !row.get::<_, bool>(5)
                    || row.get::<_, String>(2) != client_id
                    || row.get::<_, String>(3) != redirect
                    || !is_verifier(verifier)
                    || !crypto::ct_eq(expected.as_bytes(), challenge.as_bytes())
                {
                    // Not committed, so the code stays unspent for the app that has its
                    // verifier, until its minute is up.
                    return Err(invalid_grant(
                        "the code, verifier, client or redirect does not match the sign-in",
                    ));
                }
                tx.execute(
                    "UPDATE ai_oauth_clients SET used = true WHERE id = $1 AND NOT used",
                    &[&client_id],
                )
                .await?;
                let Some(key) =
                    still_stands(&tx, ring, self, &organisation, &key_id, address).await?
                else {
                    tx.commit().await?;
                    return Err(invalid_grant("the grant is no longer on"));
                };
                let family = crate::ids::new_ulid().to_string();
                let answer = issue(&tx, &key, &family, key.expires_unix).await?;
                tx.commit().await?;
                answer
            }
            Some("refresh_token") => {
                let Some(refresh) = get("refresh_token") else {
                    return Err(
                        OAuthError::bad("invalid_request", "refresh_token is required").into(),
                    );
                };
                let row = tx
                    .query_opt(
                        "SELECT organisation_id, key_id, family, used_at IS NOT NULL, \
                                expires_at > now(), extract(epoch FROM expires_at)::bigint \
                         FROM ai_oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' \
                         FOR UPDATE",
                        &[&hash(TAG_TOKEN, refresh)],
                    )
                    .await?;
                let Some(row) = row else {
                    return Err(invalid_grant(
                        "that refresh token is not one this server gave",
                    ));
                };
                let (organisation, key_id, family): (String, String, String) =
                    (row.get(0), row.get(1), row.get(2));
                if row.get::<_, bool>(3) {
                    // Spent already: one of two holders is not the app. End the sign-in.
                    tx.execute(
                        "UPDATE ai_oauth_tokens SET expires_at = now() \
                         WHERE family = $1 AND expires_at > now()",
                        &[&family],
                    )
                    .await?;
                    tx.commit().await?;
                    tracing::warn!(key = %key_id, "a spent refresh token was presented again");
                    return Err(invalid_grant("that refresh token was already used"));
                }
                if !row.get::<_, bool>(4) {
                    return Err(invalid_grant("that refresh token has expired"));
                }
                let ends: i64 = row.get(5);
                tx.execute(
                    "UPDATE ai_oauth_tokens SET used_at = now() WHERE token_hash = $1",
                    &[&hash(TAG_TOKEN, refresh)],
                )
                .await?;
                let Some(key) =
                    still_stands(&tx, ring, self, &organisation, &key_id, address).await?
                else {
                    tx.commit().await?;
                    return Err(invalid_grant("the grant is no longer on"));
                };
                if key.client_id.as_deref() != Some(client_id) {
                    tx.commit().await?;
                    return Err(invalid_grant("that refresh token belongs to another app"));
                }
                let answer = issue(&tx, &key, &family, ends).await?;
                tx.commit().await?;
                answer
            }
            _ => {
                return Err(OAuthError::bad(
                    "unsupported_grant_type",
                    "authorization_code or refresh_token",
                )
                .into())
            }
        };
        Ok(answer)
    }
}

// ---------------------------------------------------------------------------
// Using a token
// ---------------------------------------------------------------------------

/// Why `/mcp` did not take a request's token.
#[derive(Debug)]
pub enum BearerRefusal {
    /// A token that is not, or is no longer, good for anything.
    Invalid,
    Ai(AiError),
}

impl From<AiError> for BearerRefusal {
    fn from(e: AiError) -> Self {
        match e {
            AiError::Refused => Self::Invalid,
            other => Self::Ai(other),
        }
    }
}

impl From<tokio_postgres::Error> for BearerRefusal {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Ai(e.into())
    }
}

impl From<deadpool_postgres::PoolError> for BearerRefusal {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Ai(e.into())
    }
}

/// The token in an `Authorization` header (RFC 6750 section 2.1).
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let value = header?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

impl Connector {
    /// Turn an access token into a verified request, as `ai::verify_request` turns a
    /// signature into one: switch, token hash and expiry, the grant's seal and state, the
    /// policy, Claude's range, and the key's request limit. Committed before the handler
    /// opens its own transaction.
    pub async fn verify_bearer(
        &self,
        pool: &Pool,
        ring: &KeyRing,
        token: &str,
        address: &str,
    ) -> Result<VerifiedAi, BearerRefusal> {
        let mut client = pool.get().await?;
        let tx = custody(&mut client).await?;
        if !ai::read_switch(&tx, ring).await?.allowed {
            return Err(BearerRefusal::Ai(AiError::SiteOff));
        }
        let row = tx
            .query_opt(
                "SELECT organisation_id, key_id FROM ai_oauth_tokens \
                 WHERE token_hash = $1 AND kind = 'access' AND expires_at > now()",
                &[&hash(TAG_TOKEN, token)],
            )
            .await?;
        let Some(row) = row else {
            return Err(BearerRefusal::Invalid);
        };
        let (organisation, key_id): (String, String) = (row.get(0), row.get(1));
        let Some(key) = still_stands(&tx, ring, self, &organisation, &key_id, address).await?
        else {
            return Err(BearerRefusal::Invalid);
        };
        let mut nonce = [0u8; 32];
        getrandom::fill(&mut nonce)
            .map_err(|_| AiError::Crypto(crypto::CryptoError::NoRandomness))?;
        ai::spend(&tx, &key.id, &nonce, ai::now_unix() + ai::WINDOW_SECS + 1).await?;
        tx.execute("SELECT set_config('app.ai_custody', 'no', true)", &[])
            .await?;
        tx.commit().await?;
        Ok(VerifiedAi::for_connector(
            organisation,
            key.id,
            key.owner,
            address,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connector() -> Connector {
        Connector::new("https://Fathom.Example.org/", None, None).unwrap()
    }

    #[test]
    fn the_public_address_is_one_spelling_and_https_unless_loopback() {
        let c = connector();
        assert_eq!(c.resource(), "https://fathom.example.org/mcp");
        assert!(Connector::new("http://fathom.example.org", None, None).is_err());
        assert!(Connector::new("https://fathom.example.org/x", None, None).is_err());
        assert!(Connector::new("https://user@fathom.example.org", None, None).is_err());
        assert!(Connector::new("http://127.0.0.1:8080", None, None).is_ok());
        assert!(Connector::new("https://a.example", None, Some("not a range")).is_err());
    }

    #[test]
    fn a_resource_names_this_server_or_nothing() {
        let c = connector();
        assert!(c.names_this_resource(None));
        assert!(c.names_this_resource(Some("https://fathom.example.org/mcp")));
        assert!(c.names_this_resource(Some("HTTPS://FATHOM.example.org/mcp/")));
        assert!(!c.names_this_resource(Some("https://fathom.example.org/MCP")));
        assert!(!c.names_this_resource(Some("https://evil.example/mcp")));
        assert!(!c.names_this_resource(Some("https://fathom.example.org")));
    }

    #[test]
    fn redirects_match_exactly_except_a_loopback_port() {
        let claude = vec!["https://claude.ai/api/mcp/auth_callback".to_string()];
        assert!(redirect_matches(
            &claude,
            "https://claude.ai/api/mcp/auth_callback"
        ));
        assert!(!redirect_matches(
            &claude,
            "https://claude.ai/api/mcp/auth_callback/"
        ));
        assert!(!redirect_matches(
            &claude,
            "https://claude.ai.evil.example/api/mcp/auth_callback"
        ));
        assert!(!redirect_matches(
            &claude,
            "https://claude.ai/api/mcp/auth_callback?x=1"
        ));
        let code = vec![
            "http://localhost/callback".to_string(),
            "http://127.0.0.1/callback".to_string(),
        ];
        assert!(redirect_matches(&code, "http://localhost:3118/callback"));
        assert!(redirect_matches(&code, "http://127.0.0.1:50211/callback"));
        assert!(!redirect_matches(&code, "http://localhost:3118/other"));
        assert!(!redirect_matches(
            &code,
            "http://localhost.evil.example:3118/callback"
        ));
        assert!(!redirect_matches(&code, "http://localhost:31x8/callback"));
        assert!(!redirect_matches(&code, "https://localhost:3118/callback"));
    }

    #[test]
    fn only_https_or_loopback_redirects_register() {
        assert!(registrable_redirect("https://app.example/cb"));
        assert!(registrable_redirect("http://127.0.0.1:9/cb"));
        assert!(!registrable_redirect("http://app.example/cb"));
        assert!(!registrable_redirect("https://app.example/cb#frag"));
        assert!(!registrable_redirect("https://user@app.example/cb"));
        assert!(!registrable_redirect("javascript:alert(1)"));
        assert!(!registrable_redirect("https:///cb"));
    }

    #[test]
    fn the_apps_are_known_by_their_published_ids() {
        assert_eq!(
            app_of("https://claude.ai/oauth/mcp-oauth-client-metadata"),
            "claude"
        );
        assert_eq!(
            app_of("https://claude.ai/oauth/claude-code-client-metadata"),
            "claude-code"
        );
        assert_eq!(app_of("fathom-app-xyz"), "other");
        assert_eq!(
            app_of("https://claude.ai/oauth/mcp-oauth-client-metadata/"),
            "other"
        );
    }

    #[test]
    fn claude_is_held_to_its_range() {
        let c = connector();
        assert!(c.is_claude_address("160.79.104.10"));
        assert!(c.is_claude_address("160.79.111.255"));
        assert!(!c.is_claude_address("160.79.112.0"));
        assert!(!c.is_claude_address("unknown"));
        let open = Connector::new("https://a.example", None, Some("")).unwrap();
        assert!(open.is_claude_address("203.0.113.9"));
    }

    #[test]
    fn pkce_s256_is_the_rfc_7636_vector() {
        // RFC 7636 appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert!(is_verifier(verifier));
        assert_eq!(
            b64url(&Sha256::digest(verifier.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(is_challenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!is_challenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c"));
        assert!(!is_verifier("short"));
    }

    #[test]
    fn forms_decode_once_and_refuse_a_parameter_twice() {
        let f = form("a=1+2&b=%2Fx%3F&c=").unwrap();
        assert_eq!(f["a"], "1 2");
        assert_eq!(f["b"], "/x?");
        assert_eq!(f["c"], "");
        assert!(form("a=1&a=2").is_err());
        assert!(form("a=%zz").is_err());
        assert_eq!(
            with_params("https://x.example/cb?k=v", &[("code", "a b&c")]),
            "https://x.example/cb?k=v&code=a%20b%26c"
        );
    }

    #[test]
    fn a_bearer_header_is_read_one_way() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn every_label_used_here_is_listed_once_and_new() {
        for tag in [TAG_CODE, TAG_TOKEN] {
            let text = std::str::from_utf8(tag).unwrap();
            assert!(LABELS.iter().any(|(n, _)| *n == text), "{text}");
        }
        for (name, _) in LABELS {
            assert!(!ai::LABELS.iter().any(|(n, _)| n == name));
            assert!(!crate::authority::LABELS.iter().any(|(n, _)| n == name));
        }
    }
}

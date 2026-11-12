//! Reading one device and keeping what it said (ADR-0082 §4.1, §4.2 and §4.6; sign-offs r90,
//! r91 and r100; migration `0073`).
//!
//! A read goes like this, and every step can refuse:
//!
//! 1. **Who and where.** The person can draw on the design; reading is on for the organisation
//!    and allowed by the server; the device's management address, read from the design itself and
//!    never from the request, is inside a range a Steward listed ([`crate::device_read`]).
//! 2. **Which agent.** Before any login is sent, what answers at that address is confirmed: the
//!    SNMPv3 agent's engine id, or the SSH server's host key (ADR-0082 §4.4). Confirmed for this
//!    one device by someone typing its last 8 characters, or for a whole range by a Steward (r90
//!    "keys": A). Something nobody confirmed is only asked who it is, and sent no login.
//! 3. **Which login.** A vault login Fathom may use (Mode B), ticked read-only: for SNMP an SNMP
//!    login that names its authentication, for SSH a login; marked on the device, or the login
//!    the Steward set for the range (r90 "logins": A). Opening it files `vault_read` with purpose
//!    `read`.
//! 4. **The reader reads**, outside the database transaction, and answers.
//! 5. **Through the gate, then sealed.** Every string the device answered passes the redaction
//!    gate's detector ([`fathom_ingest::redact::looks_like_credential_bare`]) before it is
//!    stored or sent on (CLAUDE.md rule 4); SSH text has already been through the whole gate in
//!    the reader, and is checked again here line by line. The answer is sealed under a key of its own and one
//!    `device_read_done` entry is filed with its SHA-256.
//!
//! Nothing here acts on what was read. The differences from the drawing are worked out in the
//! browser, which shows them as suggestions; a person's Accept is an ordinary edit of the design.

use std::collections::BTreeMap;
use std::net::IpAddr;

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::authority::Capability;
use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{self, Key32, NONCE_LEN};
use crate::device_read::{Range, Settings, Transport, PROTOCOL};
use crate::grants::{self, Authority, AuthorityError, StewardCheck};
use crate::keys::DataKey;
use crate::repo::{DesignId, ScopeId};
use crate::vault::{entry_metadata, VaultError};
use crate::vault_fathom::{self, FathomKey, UsedLogin};

/// The purposes of a device reading, and of a MAC and ARP reading (r91: on request).
pub const DEVICE_PURPOSES: [&str; 4] = ["system", "inventory", "interfaces", "lldp"];
/// MAC and ARP, with what decides which ports are edge ports: the interfaces and the LLDP
/// neighbours, read in the same pass so the filter uses one moment's facts.
pub const MACARP_PURPOSES: [&str; 4] = ["interfaces", "lldp", "mac", "arp"];

/// How a device is read. Each has its own confirmed identity at an address: an SNMPv3 agent's
/// engine id, an SSH server's host key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    Snmp,
    Ssh,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Snmp => "snmp",
            Protocol::Ssh => "ssh",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "snmp" => Some(Protocol::Snmp),
            "ssh" => Some(Protocol::Ssh),
            _ => None,
        }
    }

    /// The protocol a reading's kind is read with: `config` over SSH, the rest over SNMP.
    pub fn of_kind(kind: &str) -> Self {
        if kind == "config" {
            Protocol::Ssh
        } else {
            Protocol::Snmp
        }
    }
}

/// How many readings of each kind a device keeps (r90: the latest plus what changed).
pub const KEEP: i64 = 10;

/// What a string the gate stopped reads as instead.
pub const WITHHELD: &str = "[withheld: it looked like a password]";

// ---------------------------------------------------------------------------
// One read per device at a time
// ---------------------------------------------------------------------------

/// The devices this server is reading now, by organisation and address.
static READING_NOW: std::sync::Mutex<std::collections::BTreeSet<(String, IpAddr)>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// The failure code when a device is being read already.
pub const ALREADY_READING: &str = "already_reading";

/// A claim on one device for the length of one read (sign-off r106: one read per device at a
/// time). A second Read now on the same address in the same organisation is turned away until
/// the first is answered; dropping the claim frees it, on every path out of the handler.
///
/// The claim is held in this server's memory. Behind a load balancer two servers could each read
/// the same device once at the same moment; both reads are read-only, so that costs the device a
/// second walk and nothing more.
#[derive(Debug)]
pub struct ReadingNow {
    key: (String, IpAddr),
}

impl ReadingNow {
    /// The claim, or `None` when this server is reading that address for that organisation now.
    pub fn claim(tenant: &str, address: IpAddr) -> Option<Self> {
        let key = (tenant.to_string(), address);
        let fresh = READING_NOW
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone());
        // The lock is released before a claim exists: a refused claim must never be built, since
        // dropping one frees the key it names (and would wait on this same lock).
        if fresh {
            Some(Self { key })
        } else {
            None
        }
    }
}

impl Drop for ReadingNow {
    fn drop(&mut self) {
        let mut now = READING_NOW.lock().unwrap_or_else(|e| e.into_inner());
        now.remove(&self.key);
    }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// The reading store's keys, derived from the tenant key under their own label, so they open
/// nothing else and nothing else opens them.
pub struct ReadingKeys {
    seal: Key32,
    address: Key32,
    field: Key32,
    epoch: i32,
}

impl ReadingKeys {
    pub fn derive(tenant_key: &DataKey, organisation: &str) -> Self {
        let mut info = b"fathom/device-reading/v1|".to_vec();
        info.extend_from_slice(organisation.as_bytes());
        let root = crypto::hkdf_expand(&tenant_key.key, &info);
        Self {
            seal: crypto::hkdf_expand(&root, b"seal"),
            address: crypto::hkdf_expand(&root, b"address"),
            field: crypto::hkdf_expand(&root, b"field"),
            epoch: tenant_key.epoch,
        }
    }

    /// The row key for an address: an HMAC, so the address is never in the clear. An SSH host
    /// key's row is keyed apart from the SNMP agent's at the same address (an SNMP row keeps the
    /// key it had before SSH existed).
    fn address_mac(&self, protocol: Protocol, address: IpAddr) -> Vec<u8> {
        let ip = canonical_ip(address);
        let what = match protocol {
            Protocol::Snmp => ip,
            Protocol::Ssh => format!("ssh|{ip}"),
        };
        crypto::mac(self.address.expose(), what.as_bytes()).to_vec()
    }

    fn field_mac(&self, design: &str, element: &str, field: &str) -> Vec<u8> {
        let mut m = Vec::new();
        for part in [design, element, field] {
            crypto::lp(&mut m, part.as_bytes());
        }
        crypto::mac(self.field.expose(), &m).to_vec()
    }

    fn seal(&self, what: &[u8], aad: &[u8]) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
        let nonce = crypto::random_nonce()?;
        let sealed = crypto::seal(&self.seal, &nonce, what, aad)?;
        Ok((sealed, nonce.to_vec()))
    }

    fn open(
        &self,
        epoch: i32,
        sealed: &[u8],
        nonce: &[u8],
        aad: &[u8],
    ) -> Result<Json, VaultError> {
        if epoch != self.epoch {
            return Err(VaultError::Corrupt(
                "a reading sealed under another key epoch",
            ));
        }
        let nonce: [u8; NONCE_LEN] = nonce
            .try_into()
            .map_err(|_| VaultError::Corrupt("a reading's nonce"))?;
        let plain = crypto::open(&self.seal, &nonce, sealed, aad)
            .map_err(|_| VaultError::Corrupt("a sealed reading"))?;
        Json::parse_canonical(&plain).map_err(|_| VaultError::Corrupt("a reading's body"))
    }
}

fn aad(table: &str, parts: &[&str]) -> Vec<u8> {
    let mut a = b"fathom device reading 1".to_vec();
    crypto::lp(&mut a, table.as_bytes());
    for p in parts {
        crypto::lp(&mut a, p.as_bytes());
    }
    a
}

/// An address as one spelling: an IPv4-mapped IPv6 address is the IPv4 one.
fn canonical_ip(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4).to_string(),
        v4 => v4.to_string(),
    }
}

fn s(v: &str) -> Json {
    Json::Str(v.to_string())
}

fn obj(fields: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

fn now_ms() -> i64 {
    crypto::now_unix() * 1000
}

// ---------------------------------------------------------------------------
// 1. Who and where
// ---------------------------------------------------------------------------

/// The device a read is for, as the design says.
#[derive(Clone, Debug)]
pub struct Target {
    pub design: String,
    pub element: String,
    pub address: IpAddr,
    pub range: Range,
    /// The device's platform (`schema/platforms.yaml`), which picks the SSH reader's fixed
    /// commands: as the design says, or for a device the design names none for (drawn by hand),
    /// the one the person chose for this read. Every list holds only `show` commands, so a wrong
    /// choice reads nothing it should not; it reads nothing useful, and says so.
    pub platform: Option<String>,
}

/// The design's folder, or not found.
async fn scope_of(
    tx: &Transaction<'_>,
    organisation: &str,
    design: &str,
) -> Result<ScopeId, VaultError> {
    tx.query_opt(
        "SELECT scope_id FROM designs WHERE id = $1 AND organisation_id = $2",
        &[&design, &organisation],
    )
    .await?
    .ok_or(VaultError::NotFound)?
    .get::<_, String>(0)
    .parse::<ScopeId>()
    .map_err(|_| VaultError::Corrupt("design scope id"))
}

/// Refused unless the signed-in person holds `capability` on the design.
pub async fn require(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: &str,
    capability: Capability,
) -> Result<ScopeId, VaultError> {
    let scope = scope_of(tx, &auth.ctx.tenant().to_string(), design).await?;
    match grants::authorise_account(tx, auth, Some(scope), capability).await {
        Ok(_) => Ok(scope),
        Err(AuthorityError::NotAuthorised) => Err(VaultError::NotAllowed(match capability {
            Capability::Read => "you can't see that design",
            _ => "reading a device needs Draw on its design",
        })),
        Err(e) => Err(e.into()),
    }
}

/// The device's management address and platform, from the design's head. The request never
/// names the address, so nobody can have one device's reading filed under another.
pub fn management_address(
    plain: &[u8],
    element: &str,
) -> Result<(String, Option<String>), &'static str> {
    use fathom_ir::generated::ir_types::{DeviceField, NodeKind};
    let graph = fathom_workspace::read_plain(plain).map_err(|_| "the design could not be read")?;
    let snap = graph
        .to_snapshot()
        .map_err(|_| "the design could not be read")?;
    let node = snap
        .nodes
        .iter()
        .find(|n| n.absent_since.is_none() && n.id.to_string() == element)
        .ok_or("that device is not in the design")?;
    if node.id.kind != NodeKind::Device {
        return Err("only a device is read");
    }
    let value = node
        .fields
        .iter()
        .find(|f| f.key == DeviceField::ManagementAddress.key())
        .and_then(|f| match &f.value {
            Some(Json::Str(v)) => Some(v.trim().to_string()),
            _ => None,
        })
        .unwrap_or_default();
    if value.is_empty() {
        return Err("the device has no management address; add one on Details › Management");
    }
    let platform = node
        .fields
        .iter()
        .find(|f| f.key == DeviceField::Platform.key())
        .and_then(|f| match &f.value {
            Some(Json::Str(v)) if !v.trim().is_empty() => Some(v.trim().to_string()),
            _ => None,
        });
    Ok((value, platform))
}

/// Steps 1 of a read: the person, the switches, the address, the range.
pub async fn target(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    settings: &Settings,
    reader_present: bool,
    design: &str,
    element: &str,
) -> Result<Target, VaultError> {
    if !reader_present {
        return Err(VaultError::NotAllowed(
            "this server does not read devices; its operator turns it on with FATHOM_DEVICE_READ=on",
        ));
    }
    if !settings.on {
        return Err(VaultError::NotAllowed(
            "reading is off for this organisation; a Steward turns it on under Device reading",
        ));
    }
    let scope = require(tx, auth, design, Capability::Draw).await?;
    let design_id: DesignId = design
        .parse()
        .map_err(|_| VaultError::Malformed("design"))?;
    let head = crate::designs::read_version_in_tx(tx, auth, None, design_id, Some(scope), None)
        .await
        .map_err(|_| VaultError::Corrupt("the design's head"))?;
    let (text, platform) =
        management_address(&head.payload, element).map_err(VaultError::NotAllowed)?;
    let bare = text.split('/').next().unwrap_or("");
    let address: IpAddr = bare.parse().map_err(|_| {
        VaultError::NotAllowed("the device's management address is not an IP address")
    })?;
    let range = settings
        .range_for(address)
        .map_err(VaultError::NotAllowed)?
        .clone();
    Ok(Target {
        design: design.to_string(),
        element: element.to_string(),
        address,
        range,
        platform,
    })
}

// ---------------------------------------------------------------------------
// 2. Which agent
// ---------------------------------------------------------------------------

/// What answered at an address, as the store holds it: an SNMPv3 agent's engine id or an SSH
/// server's host key fingerprint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub protocol: Protocol,
    pub state: String,
    pub address: String,
    /// The engine id (lower-case hex) or the host key's fingerprint (`SHA256:` and base64).
    pub value: String,
    /// An SSH host key's algorithm, such as `ssh-ed25519`.
    pub key_type: Option<String>,
    /// The value that was approved before, for a `changed` one.
    pub previous: Option<String>,
    pub design: String,
    pub element: String,
    pub seen_at_ms: i64,
    pub approved_by: Option<String>,
    /// Whether the person who confirmed it was a Steward then. Sealed with the rest, so a row
    /// edited in the database cannot claim it.
    pub by_steward: bool,
}

impl Identity {
    /// The sealed body. An SNMP agent's keeps the shape it had before SSH (`engineId`).
    fn body(&self) -> Json {
        let mut fields = vec![
            ("address", s(&self.address)),
            ("design", s(&self.design)),
            ("element", s(&self.element)),
            ("previous", self.previous.as_deref().map_or(Json::Null, s)),
        ];
        if self.by_steward {
            fields.push(("bySteward", Json::Bool(true)));
        }
        match self.protocol {
            Protocol::Snmp => fields.push(("engineId", s(&self.value))),
            Protocol::Ssh => {
                fields.push(("hostKey", s(&self.value)));
                fields.push(("keyType", self.key_type.as_deref().map_or(Json::Null, s)));
            }
        }
        obj(fields)
    }

    pub fn to_json(&self) -> Json {
        let mut m = match self.body() {
            Json::Obj(m) => m,
            _ => BTreeMap::new(),
        };
        m.insert("protocol".into(), s(self.protocol.as_str()));
        m.insert("state".into(), s(&self.state));
        m.insert("seenAt".into(), Json::Int(self.seen_at_ms));
        m.insert(
            "approvedBy".into(),
            self.approved_by.as_deref().map_or(Json::Null, s),
        );
        Json::Obj(m)
    }
}

fn identity_from_row(
    keys: &ReadingKeys,
    organisation: &str,
    row: &tokio_postgres::Row,
) -> Result<Identity, VaultError> {
    let mac: Vec<u8> = row.get("address_mac");
    let protocol = Protocol::parse(row.get::<_, &str>("protocol"))
        .ok_or(VaultError::Corrupt("an identity row's protocol"))?;
    let body = keys.open(
        row.get("key_epoch"),
        &row.get::<_, Vec<u8>>("sealed"),
        &row.get::<_, Vec<u8>>("nonce"),
        &aad("engines", &[organisation, &crate::crypto::hex(&mac)]),
    )?;
    let Json::Obj(m) = body else {
        return Err(VaultError::Corrupt("an identity row"));
    };
    let get = |k: &str| match m.get(k) {
        Some(Json::Str(v)) => Ok(v.clone()),
        _ => Err(VaultError::Corrupt("an identity row")),
    };
    let opt = |k: &str| match m.get(k) {
        Some(Json::Str(v)) => Some(v.clone()),
        _ => None,
    };
    Ok(Identity {
        protocol,
        state: row.get("state"),
        address: get("address")?,
        value: get(match protocol {
            Protocol::Snmp => "engineId",
            Protocol::Ssh => "hostKey",
        })?,
        key_type: opt("keyType"),
        previous: opt("previous"),
        design: get("design")?,
        element: get("element")?,
        seen_at_ms: row.get("seen_ms"),
        approved_by: row.get("approved_by"),
        by_steward: matches!(m.get("bySteward"), Some(Json::Bool(true))),
    })
}

const IDENTITY_COLUMNS: &str = "address_mac, protocol, state, key_epoch, sealed, nonce, \
    approved_by, (extract(epoch from seen_at) * 1000)::bigint AS seen_ms";

/// What is on record as answering at an address over `protocol`, if anything.
pub async fn identity_at(
    tx: &Transaction<'_>,
    keys: &ReadingKeys,
    organisation: &str,
    protocol: Protocol,
    address: IpAddr,
) -> Result<Option<Identity>, VaultError> {
    let row = tx
        .query_opt(
            &format!(
                "SELECT {IDENTITY_COLUMNS} FROM device_read_engines \
                  WHERE organisation_id = $1 AND address_mac = $2 AND protocol = $3 FOR UPDATE"
            ),
            &[
                &organisation,
                &keys.address_mac(protocol, address),
                &protocol.as_str(),
            ],
        )
        .await?;
    row.map(|r| identity_from_row(keys, organisation, &r))
        .transpose()
}

async fn write_identity(
    tx: &Transaction<'_>,
    keys: &ReadingKeys,
    organisation: &str,
    actor: &str,
    address: IpAddr,
    identity: &Identity,
) -> Result<(), VaultError> {
    let mac = keys.address_mac(identity.protocol, address);
    let (sealed, nonce) = keys.seal(
        &identity.body().to_canonical_bytes(),
        &aad("engines", &[organisation, &crate::crypto::hex(&mac)]),
    )?;
    let approved = identity.state == "approved";
    tx.execute(
        "INSERT INTO device_read_engines \
             (organisation_id, address_mac, protocol, state, key_epoch, sealed, nonce, seen_by, \
              approved_by, approved_at) \
         VALUES ($1, $2, $9, $3, $4, $5, $6, $7, \
                 CASE WHEN $8 THEN $7 ELSE NULL END, CASE WHEN $8 THEN now() ELSE NULL END) \
         ON CONFLICT (organisation_id, address_mac) DO UPDATE SET \
             state = EXCLUDED.state, key_epoch = EXCLUDED.key_epoch, sealed = EXCLUDED.sealed, \
             nonce = EXCLUDED.nonce, \
             seen_by = CASE WHEN $8 THEN device_read_engines.seen_by ELSE EXCLUDED.seen_by END, \
             seen_at = CASE WHEN $8 THEN device_read_engines.seen_at ELSE now() END, \
             approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at",
        &[
            &organisation,
            &mac,
            &identity.state,
            &keys.epoch,
            &sealed,
            &nonce,
            &actor,
            &approved,
            &identity.protocol.as_str(),
        ],
    )
    .await?;
    Ok(())
}

/// Record what answered at an address. A new one is `seen`; one that differs from the approved
/// value is `changed`, keeping the approved value as `previous`; an approved one that answers
/// with its own value stays as it is.
pub async fn record_seen(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &ReadingKeys,
    target: &Target,
    protocol: Protocol,
    value: &str,
    key_type: Option<&str>,
) -> Result<Identity, VaultError> {
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();
    let current = identity_at(tx, keys, &organisation, protocol, target.address).await?;
    let (state, previous) = match &current {
        Some(e) if e.state == "approved" && e.value == value => return Ok(e.clone()),
        Some(e) if e.state == "approved" => ("changed", Some(e.value.clone())),
        Some(e) if e.state == "changed" => ("changed", e.previous.clone()),
        _ => ("seen", None),
    };
    let identity = Identity {
        protocol,
        state: state.to_string(),
        address: canonical_ip(target.address),
        value: value.to_string(),
        key_type: key_type.map(str::to_string),
        previous,
        design: target.design.clone(),
        element: target.element.clone(),
        seen_at_ms: now_ms(),
        approved_by: None,
        by_steward: false,
    };
    write_identity(tx, keys, &organisation, &actor, target.address, &identity).await?;
    Ok(identity)
}

/// An engine id as the reader writes it: lower-case hex, 10 to 64 characters (RFC 3411
/// SnmpEngineID is 5 to 32 octets).
pub fn engine_id_ok(id: &str) -> bool {
    (10..=64).contains(&id.len())
        && id.len().is_multiple_of(2)
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A host key fingerprint as the reader writes it, and as `ssh-keygen -l` prints one:
/// `SHA256:` and 43 characters of unpadded base64 (a SHA-256 digest is 32 bytes).
pub fn host_key_ok(fp: &str) -> bool {
    fp.strip_prefix("SHA256:").is_some_and(|b64| {
        b64.len() == 43
            && b64
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    })
}

/// An SSH host key algorithm name as the reader writes it, such as `ssh-ed25519` or
/// `ecdsa-sha2-nistp256`: short, and only letters, digits, `-`, `@` and `.`.
pub fn key_type_ok(t: &str) -> bool {
    (1..=64).contains(&t.len())
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'@' | b'.'))
}

/// Whether `typed` is the last 8 characters of `value`, ignoring spaces. An engine id is hex,
/// so its case is ignored; a host key fingerprint is base64, where case is part of the value.
pub fn last_eight_match(protocol: Protocol, value: &str, typed: &str) -> bool {
    let typed: String = typed.chars().filter(|c| !c.is_whitespace()).collect();
    let typed = match protocol {
        Protocol::Snmp => typed.to_ascii_lowercase(),
        Protocol::Ssh => typed,
    };
    typed.chars().count() == 8 && value.len() >= 8 && value.ends_with(&typed)
}

/// Someone with Draw confirms what answers at one device by typing the last 8 characters of it.
pub async fn approve_typed(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &ReadingKeys,
    target: &Target,
    protocol: Protocol,
    typed: &str,
) -> Result<Identity, VaultError> {
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();
    let Some(mut identity) = identity_at(tx, keys, &organisation, protocol, target.address).await?
    else {
        return Err(VaultError::NotAllowed(
            "nothing has answered at that address yet; press Read now to ask it",
        ));
    };
    // A Steward typing the characters of one a member confirmed makes it Steward-confirmed.
    let steward = is_steward(tx, auth).await?;
    if identity.state == "approved" && (identity.by_steward || !steward) {
        return Ok(identity);
    }
    if !last_eight_match(protocol, &identity.value, typed) {
        return Err(VaultError::NotAllowed(match protocol {
            Protocol::Snmp => {
                "those are not the last 8 characters of the engine id the device gave"
            }
            Protocol::Ssh => {
                "those are not the last 8 characters of the host key the device gave; capitals count"
            }
        }));
    }
    identity.state = "approved".to_string();
    identity.previous = None;
    identity.design = target.design.clone();
    identity.element = target.element.clone();
    identity.approved_by = Some(actor.clone());
    identity.by_steward = steward;
    write_identity(tx, keys, &organisation, &actor, target.address, &identity).await?;
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::DeviceReadEngineApproved,
        &entry_metadata(
            EntryType::DeviceReadEngineApproved,
            &[
                ("actor", s(&actor)),
                ("count", Json::Int(1)),
                ("design", s(&target.design)),
                ("element", s(&target.element)),
                ("how", s("typed")),
                ("protocol", s(protocol.as_str())),
            ],
        ),
    )
    .await?;
    Ok(identity)
}

/// Whether the signed-in person is a Steward now.
pub async fn is_steward(tx: &Transaction<'_>, auth: &Authority<'_>) -> Result<bool, VaultError> {
    let verified = grants::verify_authority_state(tx, auth).await?;
    let mut check = StewardCheck::new();
    Ok(!grants::steward_anchors(tx, auth, &verified, &mut check)
        .await?
        .is_empty())
}

async fn require_steward(tx: &Transaction<'_>, auth: &Authority<'_>) -> Result<(), VaultError> {
    if !is_steward(tx, auth).await? {
        return Err(VaultError::NotAllowed(
            "only a Steward approves agents for a whole range",
        ));
    }
    Ok(())
}

/// What a person who is not a Steward is told when a range's login would go to a host key no
/// Steward confirmed.
pub const RANGE_LOGIN_NEEDS_A_STEWARD: &str = "this device would be read with the login set for its whole range, so a Steward confirms its SSH host key first: a Steward reads it once, or confirms it under Device reading";

/// Whether this read must wait for a Steward. Over SSH the password itself is handed to
/// whatever holds the host key (RFC 4252 §8), and a range's login is one the person reading
/// need not hold. So it goes only to a host key a Steward confirmed; otherwise anyone who can
/// draw could put a machine of their own at an address in the range, confirm its key
/// themselves and be sent the password.
pub fn range_login_waits_for_a_steward(
    protocol: Protocol,
    by_range: bool,
    identity: Option<&Identity>,
) -> bool {
    protocol == Protocol::Ssh && by_range && !identity.is_some_and(|i| i.by_steward)
}

/// The Steward's list: every agent and host key waiting for someone, newest first.
pub async fn waiting(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &ReadingKeys,
) -> Result<Vec<Identity>, VaultError> {
    require_steward(tx, auth).await?;
    let organisation = auth.ctx.tenant().to_string();
    let rows = tx
        .query(
            &format!(
                "SELECT {IDENTITY_COLUMNS} FROM device_read_engines \
                  WHERE organisation_id = $1 AND state <> 'approved' \
                  ORDER BY seen_at DESC LIMIT 2000"
            ),
            &[&organisation],
        )
        .await?;
    rows.iter()
        .map(|r| identity_from_row(keys, &organisation, r))
        .collect()
}

/// A Steward approves agents or host keys in one batch, by address: one entry on the log for
/// the batch (r90 "log": A). A `changed` one is approved only on its own, never with the rest
/// (r100).
pub async fn approve_batch(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &ReadingKeys,
    protocol: Protocol,
    addresses: &[IpAddr],
) -> Result<usize, VaultError> {
    require_steward(tx, auth).await?;
    if addresses.is_empty() || addresses.len() > 2000 {
        return Err(VaultError::Malformed("addresses"));
    }
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();
    let mut found = Vec::with_capacity(addresses.len());
    for a in addresses {
        let Some(e) = identity_at(tx, keys, &organisation, protocol, *a).await? else {
            return Err(VaultError::NotFound);
        };
        if e.state == "changed" && addresses.len() > 1 {
            return Err(VaultError::NotAllowed(
                "one whose id or host key changed is approved on its own, never with the rest",
            ));
        }
        found.push((*a, e));
    }
    let mut count = 0;
    for (a, mut e) in found {
        if e.state == "approved" && e.by_steward {
            continue;
        }
        e.state = "approved".to_string();
        e.previous = None;
        e.approved_by = Some(actor.clone());
        e.by_steward = true;
        write_identity(tx, keys, &organisation, &actor, a, &e).await?;
        count += 1;
    }
    if count > 0 {
        chains::append_org(
            tx,
            auth.ring,
            auth.ctx,
            auth.tenant_key,
            EntryType::DeviceReadEngineApproved,
            &entry_metadata(
                EntryType::DeviceReadEngineApproved,
                &[
                    ("actor", s(&actor)),
                    ("count", Json::Int(count as i64)),
                    ("how", s("range")),
                    ("protocol", s(protocol.as_str())),
                ],
            ),
        )
        .await?;
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// 3. Which login
// ---------------------------------------------------------------------------

/// The login for this read: the one asked for, which the vault then checks; `by_range` when it
/// is the login the Steward set for the device's range. Answers, over SNMP, its authentication.
pub async fn open_login(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    target: &Target,
    protocol: Protocol,
    login: &str,
) -> Result<(UsedLogin, Option<String>), VaultError> {
    let by_range = target.range.login.as_deref() == Some(login);
    vault_fathom::use_login_to_read(
        tx,
        auth,
        fk,
        login,
        &target.design,
        &target.element,
        by_range,
        protocol,
    )
    .await
}

// ---------------------------------------------------------------------------
// 4. The reader
// ---------------------------------------------------------------------------

/// The SNMP job the reader takes (`helpers/reader/src/lib.rs`, `snmp_read`): self-contained and
/// versioned, so a reader elsewhere (ADR-0089) takes the same.
pub fn job(target: &Target, purposes: &[&str], engine_id: Option<&str>) -> Json {
    obj(vec![
        ("version", Json::Int(1)),
        ("device", s(&target.element)),
        ("address", s(&canonical_ip(target.address))),
        ("port", Json::Int(target.range.snmp_port as i64)),
        ("ranges", Json::Arr(vec![s(&target.range.cidr())])),
        (
            "purposes",
            Json::Arr(purposes.iter().map(|p| s(p)).collect()),
        ),
        ("engineId", engine_id.map_or(Json::Null, s)),
    ])
}

/// The SSH platforms the reader has fixed commands for (`helpers/reader/src/commands.rs`). A
/// device on another platform is not offered an SSH read.
pub const SSH_PLATFORMS: [&str; 3] = ["junos-srx", "junos-ex", "eos"];

/// The SSH job the reader takes (`ssh_read`). It names the platform, never a command: the
/// reader holds the only list of what may run. Without a confirmed host key the reader learns
/// the key, sends no login and runs nothing.
pub fn ssh_job(target: &Target, platform: &str, host_key: Option<&str>) -> Json {
    obj(vec![
        ("version", Json::Int(1)),
        ("device", s(&target.element)),
        ("address", s(&canonical_ip(target.address))),
        ("port", Json::Int(target.range.ssh_port as i64)),
        ("ranges", Json::Arr(vec![s(&target.range.cidr())])),
        ("platform", s(platform)),
        ("hostKey", host_key.map_or(Json::Null, s)),
    ])
}

/// The SSH request, with the login in its own envelope. The caller drops it once it is sent.
pub fn ssh_request(job: Json, login: Option<&UsedLogin>) -> Json {
    let mut m = BTreeMap::from([
        ("op".to_string(), s("ssh_read")),
        ("protocol".to_string(), Json::Int(PROTOCOL)),
        ("job".to_string(), job),
    ]);
    if let Some(l) = login {
        m.insert(
            "login".to_string(),
            obj(vec![("user", s(&l.user)), ("password", s(&l.password))]),
        );
    }
    Json::Obj(m)
}

/// The SNMP request, with the login in its own envelope. The caller drops it as soon as it is
/// sent.
pub fn request(job: Json, login: Option<(&UsedLogin, &str)>) -> Json {
    let mut m = BTreeMap::from([
        ("op".to_string(), s("snmp_read")),
        ("protocol".to_string(), Json::Int(PROTOCOL)),
        ("job".to_string(), job),
    ]);
    if let Some((l, auth)) = login {
        m.insert(
            "login".to_string(),
            obj(vec![
                ("user", s(&l.user)),
                ("auth", s(auth)),
                ("authPassword", s(&l.password)),
                (
                    "privPassword",
                    s(l.privacy.as_deref().unwrap_or(&l.password)),
                ),
            ]),
        );
    }
    Json::Obj(m)
}

/// Ask the reader. Its words, when it refuses, are its own; they never carry a password.
pub async fn ask(transport: &dyn Transport, request: Json) -> Result<Json, VaultError> {
    match transport.call(request).await {
        Ok(Json::Obj(m)) => {
            if matches!(m.get("ok"), Some(Json::Bool(false))) {
                tracing::warn!(error = ?m.get("error"), "the device reader refused a job");
                return Err(VaultError::NotAllowed(
                    "the device reader refused this read; its log says why",
                ));
            }
            Ok(Json::Obj(m))
        }
        Ok(_) => Err(VaultError::Corrupt("the device reader's answer")),
        Err(e) => {
            tracing::warn!(error = %e, "the device reader did not answer");
            Err(VaultError::NotAllowed("the device reader did not answer"))
        }
    }
}

// ---------------------------------------------------------------------------
// 5. Through the gate, sealed, filed
// ---------------------------------------------------------------------------

/// Every string in `v` the redaction gate's detector reads as a credential is replaced by
/// [`WITHHELD`]. Answers how many were. Object keys are the reader's own words and are kept.
pub fn gate(v: &mut Json) -> usize {
    match v {
        Json::Str(text) => {
            if fathom_ingest::redact::looks_like_credential_bare(text) {
                *text = WITHHELD.to_string();
                1
            } else {
                0
            }
        }
        Json::Arr(items) => items.iter_mut().map(gate).sum(),
        Json::Obj(m) => m.values_mut().map(gate).sum(),
        _ => 0,
    }
}

/// What a line the second check stopped reads as instead.
pub const WITHHELD_LINE: &str = "[withheld: this line looked like it held a password]";

/// The second check over SSH text, which the reader's gate has already been through: each line
/// the detector reads as a credential is replaced by [`WITHHELD_LINE`]. A line is checked with
/// the gate's own redaction markers taken out, since a marker is where a secret was destroyed,
/// not a secret. Answers how many lines were withheld.
pub fn gate_lines(text: &mut String) -> usize {
    let mut withheld = 0;
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let unmarked: String = line
            .split_whitespace()
            .filter(|t| !(t.starts_with("<REDACTED:") && t.ends_with('>')))
            .collect::<Vec<_>>()
            .join(" ");
        if fathom_ingest::redact::looks_like_credential_bare(&unmarked) {
            out.push_str(WITHHELD_LINE);
            withheld += 1;
        } else {
            out.push_str(line);
        }
    }
    *text = out;
    withheld
}

/// The second check over an SSH reading: every output's text line by line, and every other
/// string as [`gate`] checks it.
fn gate_config(reading: &mut Json) -> usize {
    let Json::Obj(r) = reading else {
        return gate(reading);
    };
    let mut withheld = 0;
    if let Some(Json::Arr(outputs)) = r.get_mut("outputs") {
        for o in outputs.iter_mut() {
            let Json::Obj(o) = o else {
                withheld += gate(o);
                continue;
            };
            for (k, v) in o.iter_mut() {
                withheld += match (k.as_str(), v) {
                    ("text", Json::Str(t)) => gate_lines(t),
                    // The command is the reader's own fixed string; checked like any other.
                    (_, v) => gate(v),
                };
            }
        }
    }
    for (k, v) in r.iter_mut() {
        if k != "outputs" {
            withheld += gate(v);
        }
    }
    withheld
}

/// SHA-256 over the canonical bytes, hex: what the reader computes over the same JSON.
pub fn digest(v: &Json) -> String {
    crate::crypto::hex(&Sha256::digest(v.to_canonical_bytes()))
}

/// MAC rows learned on edge ports only (r90): a port where LLDP sees a neighbour that says it is
/// a bridge or a router faces another switch, and what it learned is that switch's. Answers the
/// rows kept and how many were left out.
pub fn edge_macs(mac: &Json, lldp: Option<&Json>) -> (Json, usize) {
    let mut inner_ports: std::collections::BTreeSet<i64> = Default::default();
    if let Some(Json::Arr(neighbours)) = lldp {
        for n in neighbours {
            let Json::Obj(m) = n else { continue };
            let switchy = matches!(m.get("capEnabled"), Some(Json::Arr(caps)) if caps.iter().any(|c| matches!(c, Json::Str(c) if c == "bridge" || c == "router")));
            if !switchy {
                continue;
            }
            if let Some(Json::Int(i)) = m.get("ifIndex") {
                inner_ports.insert(*i);
            }
        }
    }
    let Json::Arr(rows) = mac else {
        return (Json::Arr(Vec::new()), 0);
    };
    let mut kept = Vec::new();
    let mut left = 0;
    for r in rows {
        let on_inner = matches!(r, Json::Obj(m) if matches!(m.get("ifIndex"), Some(Json::Int(i)) if inner_ports.contains(i)));
        if on_inner {
            left += 1;
        } else {
            kept.push(r.clone());
        }
    }
    (Json::Arr(kept), left)
}

/// What is kept of a reader's answer: the reading, and the facts about the read.
pub fn kept(answer: &Json, kind: &str) -> Json {
    let Json::Obj(m) = answer else {
        return Json::Null;
    };
    let mut out = BTreeMap::new();
    for k in [
        "outcome",
        "engineId",
        "hostKey",
        "platform",
        "incomplete",
        "failed",
        "durationMs",
        "reader",
    ] {
        if let Some(v) = m.get(k) {
            out.insert(k.to_string(), v.clone());
        }
    }
    let mut reading = m
        .get("reading")
        .cloned()
        .unwrap_or(Json::Obj(BTreeMap::new()));
    if kind == "macarp" {
        if let Json::Obj(r) = &mut reading {
            let lldp = r.get("lldp").cloned();
            if let Some(mac) = r.get("mac").cloned() {
                let (edge, left) = edge_macs(&mac, lldp.as_ref());
                r.insert("mac".into(), edge);
                out.insert("macLeftOut".into(), Json::Int(left as i64));
            }
        }
    }
    let withheld = if kind == "config" {
        gate_config(&mut reading)
    } else {
        gate(&mut reading)
    };
    out.insert("withheld".into(), Json::Int(withheld as i64));
    out.insert("digest".into(), s(&digest(&reading)));
    out.insert("reading".into(), reading);
    Json::Obj(out)
}

/// File one read and keep it. Answers the reading's id.
#[allow(clippy::too_many_arguments)]
pub async fn store(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &ReadingKeys,
    target: &Target,
    kind: &str,
    login: &str,
    body: &Json,
) -> Result<String, VaultError> {
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();
    let field = |k: &str| match body {
        Json::Obj(m) => m.get(k).cloned().unwrap_or(Json::Null),
        _ => Json::Null,
    };
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::DeviceReadDone,
        &entry_metadata(
            EntryType::DeviceReadDone,
            &[
                ("actor", s(&actor)),
                ("design", s(&target.design)),
                ("digest", field("digest")),
                ("element", s(&target.element)),
                ("kind", s(kind)),
                ("login", s(login)),
                ("outcome", field("outcome")),
                ("reader", field("reader")),
            ],
        ),
    )
    .await?;
    let id = crate::ids::new_ulid().to_string();
    let (sealed, nonce) = keys.seal(
        &body.to_canonical_bytes(),
        &aad(
            "readings",
            &[&organisation, &id, &target.design, &target.element, kind],
        ),
    )?;
    tx.execute(
        "INSERT INTO device_readings (organisation_id, id, design_id, element_id, kind, read_by, \
             chain_seq, key_epoch, sealed, nonce) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        &[
            &organisation,
            &id,
            &target.design,
            &target.element,
            &kind,
            &actor,
            &appended.seq,
            &keys.epoch,
            &sealed,
            &nonce,
        ],
    )
    .await?;
    tx.execute(
        "DELETE FROM device_readings WHERE organisation_id = $1 AND design_id = $2 \
            AND element_id = $3 AND kind = $4 AND id NOT IN ( \
              SELECT id FROM device_readings WHERE organisation_id = $1 AND design_id = $2 \
                 AND element_id = $3 AND kind = $4 ORDER BY read_at DESC, id DESC LIMIT $5)",
        &[&organisation, &target.design, &target.element, &kind, &KEEP],
    )
    .await?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// What a device's panel shows
// ---------------------------------------------------------------------------

/// What changed between two MAC-and-ARP readings: MACs and ARP entries new and gone.
pub fn table_changes(newer: &Json, older: &Json) -> Json {
    fn keys_of(v: &Json, table: &str, key: &[&str]) -> std::collections::BTreeSet<String> {
        let mut out = std::collections::BTreeSet::new();
        if let Json::Obj(m) = v {
            if let Some(Json::Obj(r)) = m.get("reading") {
                if let Some(Json::Arr(rows)) = r.get(table) {
                    for row in rows {
                        if let Json::Obj(f) = row {
                            let k: Vec<String> = key
                                .iter()
                                .map(|k| match f.get(*k) {
                                    Some(Json::Str(v)) => v.clone(),
                                    Some(Json::Int(n)) => n.to_string(),
                                    _ => String::new(),
                                })
                                .collect();
                            out.insert(k.join("|"));
                        }
                    }
                }
            }
        }
        out
    }
    let count = |table: &str, key: &[&str]| {
        let a = keys_of(newer, table, key);
        let b = keys_of(older, table, key);
        obj(vec![
            ("new", Json::Int(a.difference(&b).count() as i64)),
            ("gone", Json::Int(b.difference(&a).count() as i64)),
        ])
    };
    obj(vec![
        ("mac", count("mac", &["mac", "ifIndex"])),
        ("arp", count("arp", &["ip", "mac"])),
    ])
}

/// Everything the Readings tab shows for one device: the latest reading in full, the earlier
/// ones as a line each, the latest MAC and ARP tables with what changed since the one before,
/// the latest configuration read over SSH in full and the earlier ones as a line each, and what
/// was dismissed.
pub async fn panel(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &ReadingKeys,
    design: &str,
    element: &str,
) -> Result<Json, VaultError> {
    require(tx, auth, design, Capability::Read).await?;
    let organisation = auth.ctx.tenant().to_string();
    let rows = tx
        .query(
            "SELECT id, kind, read_by, (extract(epoch from read_at) * 1000)::bigint, key_epoch, \
                    sealed, nonce, \
                    (SELECT display_name FROM accounts a WHERE a.id = r.read_by) \
               FROM device_readings r \
              WHERE organisation_id = $1 AND design_id = $2 AND element_id = $3 \
              ORDER BY read_at DESC, id DESC",
            &[&organisation, &design, &element],
        )
        .await?;
    let mut device: Vec<Json> = Vec::new();
    let mut macarp: Vec<Json> = Vec::new();
    let mut config: Vec<Json> = Vec::new();
    for r in rows.iter() {
        let id: String = r.get(0);
        let kind: String = r.get(1);
        let latest_of_kind = match kind.as_str() {
            "device" => device.is_empty(),
            "config" => config.is_empty(),
            _ => macarp.len() < 2,
        };
        let mut line = BTreeMap::from([
            ("id".to_string(), s(&id)),
            ("readBy".to_string(), s(&r.get::<_, String>(2))),
            (
                "readByName".to_string(),
                r.get::<_, Option<String>>(7).map_or(Json::Null, Json::Str),
            ),
            ("readAt".to_string(), Json::Int(r.get(3))),
        ]);
        let body = keys.open(
            r.get(4),
            &r.get::<_, Vec<u8>>(5),
            &r.get::<_, Vec<u8>>(6),
            &aad("readings", &[&organisation, &id, design, element, &kind]),
        )?;
        if let Json::Obj(b) = &body {
            for (k, v) in b {
                if k != "reading" || latest_of_kind {
                    line.insert(k.clone(), v.clone());
                }
            }
        }
        match kind.as_str() {
            "device" => device.push(Json::Obj(line)),
            "config" => config.push(Json::Obj(line)),
            _ => macarp.push(Json::Obj(line)),
        }
    }
    let changes = match (macarp.first(), macarp.get(1)) {
        (Some(a), Some(b)) => table_changes(a, b),
        _ => Json::Null,
    };
    let dismissed = tx
        .query(
            "SELECT key_epoch, sealed, nonce, field_mac FROM device_read_dismissals \
              WHERE organisation_id = $1 AND design_id = $2 AND element_id = $3",
            &[&organisation, &design, &element],
        )
        .await?
        .iter()
        .map(|r| {
            keys.open(
                r.get(0),
                &r.get::<_, Vec<u8>>(1),
                &r.get::<_, Vec<u8>>(2),
                &aad(
                    "dismissals",
                    &[
                        &organisation,
                        design,
                        element,
                        &crate::crypto::hex(&r.get::<_, Vec<u8>>(3)),
                    ],
                ),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(obj(vec![
        ("readings", Json::Arr(device)),
        ("macArp", Json::Arr(macarp.into_iter().take(1).collect())),
        ("macArpChanges", changes),
        ("configs", Json::Arr(config)),
        ("dismissed", Json::Arr(dismissed)),
    ]))
}

/// Dismiss one difference: `field` is the browser's name for it (`serial`, `port:<id>:alias`),
/// `value` what the device read. A later read with another value shows it again (r100).
pub async fn dismiss(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &ReadingKeys,
    design: &str,
    element: &str,
    field: &str,
    value: &str,
) -> Result<(), VaultError> {
    require(tx, auth, design, Capability::Draw).await?;
    if field.is_empty()
        || field.len() > 200
        || value.len() > 2000
        || field.chars().any(char::is_control)
        || value.chars().any(char::is_control)
    {
        return Err(VaultError::Malformed("field or value"));
    }
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();
    let mac = keys.field_mac(design, element, field);
    let (sealed, nonce) = keys.seal(
        &obj(vec![("field", s(field)), ("value", s(value))]).to_canonical_bytes(),
        &aad(
            "dismissals",
            &[&organisation, design, element, &crate::crypto::hex(&mac)],
        ),
    )?;
    tx.execute(
        "INSERT INTO device_read_dismissals (organisation_id, design_id, element_id, field_mac, \
             key_epoch, sealed, nonce, dismissed_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (organisation_id, design_id, element_id, field_mac) DO UPDATE SET \
             key_epoch = EXCLUDED.key_epoch, sealed = EXCLUDED.sealed, nonce = EXCLUDED.nonce, \
             dismissed_by = EXCLUDED.dismissed_by, dismissed_at = now()",
        &[
            &organisation,
            &design,
            &element,
            &mac,
            &keys.epoch,
            &sealed,
            &nonce,
            &actor,
        ],
    )
    .await?;
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::DeviceReadDismissed,
        &entry_metadata(
            EntryType::DeviceReadDismissed,
            &[
                ("actor", s(&actor)),
                ("design", s(design)),
                ("element", s(element)),
            ],
        ),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn one_read_per_device_at_a_time() {
        let a: std::net::IpAddr = "192.0.2.77".parse().unwrap();
        let b: std::net::IpAddr = "192.0.2.78".parse().unwrap();
        let first = super::ReadingNow::claim("org-r106", a).expect("free");
        assert!(
            super::ReadingNow::claim("org-r106", a).is_none(),
            "the same device twice"
        );
        let other = super::ReadingNow::claim("org-r106", b).expect("another device");
        let elsewhere =
            super::ReadingNow::claim("org-r106-other", a).expect("another organisation");
        drop(first);
        assert!(
            super::ReadingNow::claim("org-r106", a).is_some(),
            "free again once answered"
        );
        drop((other, elsewhere));
    }

    use super::*;

    fn j(text: &str) -> Json {
        crate::foreign_json::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn the_last_eight_must_be_typed_whole() {
        let snmp = Protocol::Snmp;
        let id = "80000009030001c2b3d4e5f60";
        assert!(last_eight_match(snmp, id, "3d4e5f60"));
        assert!(last_eight_match(snmp, id, "3D4E 5F60"));
        assert!(!last_eight_match(snmp, id, "d4e5f60"), "seven is not eight");
        assert!(!last_eight_match(snmp, id, "2b3d4e5f"));
        assert!(!last_eight_match(snmp, id, ""));
        // A host key is base64: case is part of it (the reader's test server's key, as
        // `ssh-keygen -l` printed it).
        let fp = "SHA256:/d1tvcieVX3qdA57VhyjGjMJOESBaYv/AxSs54GFg+0";
        assert!(host_key_ok(fp));
        assert!(last_eight_match(Protocol::Ssh, fp, "s54GFg+0"));
        assert!(last_eight_match(Protocol::Ssh, fp, "s54G Fg+0"));
        assert!(
            !last_eight_match(Protocol::Ssh, fp, "S54GFG+0"),
            "capitals count in a host key"
        );
        assert!(!host_key_ok("SHA256:short"));
        assert!(!host_key_ok("MD5:aa:bb"));
        assert!(key_type_ok("ssh-ed25519") && key_type_ok("ecdsa-sha2-nistp256"));
        assert!(!key_type_ok("ssh ed25519"));
        assert!(engine_id_ok("80000009030001c2b3d4"));
        assert!(
            !engine_id_ok("80000009030001C2B3D4"),
            "the reader writes lower case"
        );
        assert!(!engine_id_ok("8000"));
    }

    /// Rule 2: what a real switch lets a person type into a port description. Cisco IOS takes
    /// up to 200 characters of free text in `description`, so a password typed there arrives.
    #[test]
    fn a_password_typed_into_a_description_never_arrives() {
        let mut v = j(
            r#"{"interfaces":[{"descr":"Gi1/0/7","alias":"enable secret cisco123"},{"descr":"Gi1/0/8","alias":"AP-2F-east"}],"system":{"name":"access-sw3"}}"#,
        );
        assert_eq!(gate(&mut v), 1);
        let text = String::from_utf8(v.to_canonical_bytes()).unwrap();
        assert!(!text.contains("cisco123"), "{text}");
        assert!(text.contains("AP-2F-east"));
        assert!(text.contains(WITHHELD));
    }

    #[test]
    fn only_macs_on_edge_ports_are_kept() {
        let lldp = j(
            r#"[{"ifIndex":48,"capEnabled":["bridge","router"]},{"ifIndex":7,"capEnabled":["telephone"]}]"#,
        );
        let mac = j(
            r#"[{"mac":"3c:22:fb:10:aa:01","ifIndex":7},{"mac":"00:1b:63:84:45:e6","ifIndex":48},{"mac":"f0:18:98:2c:11:07","ifIndex":4}]"#,
        );
        let (kept, left) = edge_macs(&mac, Some(&lldp));
        assert_eq!(left, 1);
        let text = String::from_utf8(kept.to_canonical_bytes()).unwrap();
        assert!(
            text.contains("3c:22:fb:10:aa:01"),
            "a phone's port is an edge port"
        );
        assert!(
            !text.contains("00:1b:63:84:45:e6"),
            "the uplink's MACs are the other switch's"
        );
    }

    #[test]
    fn what_changed_counts_new_and_gone() {
        let a = j(
            r#"{"reading":{"mac":[{"mac":"a","ifIndex":1},{"mac":"b","ifIndex":2}],"arp":[{"ip":"10.0.0.1","mac":"a"}]}}"#,
        );
        let b =
            j(r#"{"reading":{"mac":[{"mac":"a","ifIndex":1},{"mac":"c","ifIndex":3}],"arp":[]}}"#);
        assert_eq!(
            table_changes(&a, &b).to_canonical_bytes(),
            br#"{"arp":{"gone":0,"new":1},"mac":{"gone":1,"new":1}}"#
                .iter()
                .copied()
                .chain(*b"\n")
                .collect::<Vec<u8>>()
        );
    }

    #[test]
    fn the_job_names_the_address_from_the_design_and_one_range() {
        let target = Target {
            design: "01K8DESIGN0000000000000000".into(),
            element: "dev-1".into(),
            address: "::ffff:10.20.0.14".parse().unwrap(),
            range: Range::parse("10.20.0.0/24", Some(1161), None).unwrap(),
            platform: Some("junos-srx".into()),
        };
        let text =
            String::from_utf8(job(&target, &DEVICE_PURPOSES, Some("8000aa")).to_canonical_bytes())
                .unwrap();
        assert!(text.contains(r#""address":"10.20.0.14""#), "{text}");
        assert!(text.contains(r#""port":1161"#));
        assert!(text.contains(r#""ranges":["10.20.0.0/24"]"#));
        let no_login = request(job(&target, &["system"], None), None);
        assert!(!String::from_utf8(no_login.to_canonical_bytes())
            .unwrap()
            .contains("login"));
        // Over SSH: port 22 unless the range says otherwise, the platform, never a command.
        let ssh = String::from_utf8(
            ssh_request(ssh_job(&target, "junos-srx", None), None).to_canonical_bytes(),
        )
        .unwrap();
        assert!(ssh.contains(r#""op":"ssh_read""#), "{ssh}");
        assert!(ssh.contains(r#""port":22"#), "{ssh}");
        assert!(ssh.contains(r#""platform":"junos-srx""#));
        assert!(ssh.contains(r#""hostKey":null"#));
        assert!(!ssh.contains("login") && !ssh.contains("show "));
    }

    /// Rule 2: what the reader answers for a real Junos read (the fake device's set-form, after
    /// the reader's gate), and a line the reader's dictionary would not know, as a person might
    /// type one into an `annotate` or a description on the device.
    #[test]
    fn the_second_check_keeps_gated_lines_and_withholds_a_password_the_reader_missed() {
        let mut text = "set system host-name srx-lab\n\
set system root-authentication encrypted-password <REDACTED:password>\n\
set system login user ro-fathom class read-only\n\
set interfaces ge-0/0/0 description \"enable secret cisco123\"\n\
set interfaces ge-0/0/0 unit 0 family inet address 10.20.0.1/24\n"
            .to_string();
        assert_eq!(gate_lines(&mut text), 1, "{text}");
        assert!(!text.contains("cisco123"), "{text}");
        assert!(text.contains("set system host-name srx-lab"));
        assert!(
            text.contains("encrypted-password <REDACTED:password>"),
            "a line the reader already gated is kept: {text}"
        );
        assert!(text.contains("10.20.0.1/24"));
        assert!(text.contains(WITHHELD_LINE));

        let answer = j(
            r#"{"outcome":"read","hostKey":"SHA256:/d1tvcieVX3qdA57VhyjGjMJOESBaYv/AxSs54GFg+0","platform":"junos-srx","reading":{"outputs":[{"command":"show configuration | display set","text":"set system host-name a\nset snmp community s3cr3tR0 authorization read-only\n","drops":0,"incomplete":false,"exit":0}]}}"#,
        );
        let kept = kept(&answer, "config");
        let text = String::from_utf8(kept.to_canonical_bytes()).unwrap();
        assert!(!text.contains("s3cr3tR0"), "{text}");
        assert!(text.contains(r#""withheld":1"#), "{text}");
        assert!(text.contains(r#""hostKey":"SHA256:"#));
    }
}

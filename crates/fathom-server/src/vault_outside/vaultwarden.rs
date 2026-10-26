//! **What a Vaultwarden server answers, and the three checks** (ADR-0071 part four).
//!
//! Sources, read 2026-10-26 at dani-garcia/vaultwarden `0f44744` (2026-10-25):
//!
//! - `src/api/identity.rs`: `grant_type=client_credentials` with `scope=api` and a `client_id`
//!   of `user.<uuid>` is the personal API key login (`user_api_key_login`). It requires
//!   `device_identifier`, `device_name` and `device_type`, and answers `access_token`, `Key` (the
//!   user key, sealed by the master key), `PrivateKey` (sealed by the user key), `Kdf`,
//!   `KdfIterations` and, under `UserDecryptionOptions.MasterPasswordUnlock`, the `Salt`, which
//!   is the account's e-mail. **"API key logins bypass 2FA"**, in its own words: the API key is
//!   as strong as the account, which is why it is sealed under `vault.key` and why the account
//!   must be one that sees one collection and nothing else.
//! - `src/api/core/ciphers.rs` `sync`: `profile` (with `organizations`), `ciphers` (every cipher
//!   the user can see) and `collections` (every collection the user can see). Without a client
//!   version header, SSH keys are left out; they are not logins either way.
//! - `src/db/models/organization.rs` `Membership::to_json`: `id`, `key` (the organisation key,
//!   sealed to the user's public key, type 4), `status` and `type`, where `MembershipType` is
//!   Owner 0, Admin 1, User 2, Manager 3, and a Manager is reported as 4 ("Custom").
//! - `src/db/models/cipher.rs` `to_json`: `id`, `type` (1 is a login), `deletedDate`,
//!   `organizationId`, `key` (an item key, sealed by the organisation key, or null),
//!   `collectionIds`, `name`, `login.username`, `login.password`, and `viewPassword`.
//! - `src/db/models/device.rs`: device type 22 is "Server".
//!
//! Every field is read defensively: a missing or mistyped field is a refusal that names the
//! field, never a panic and never a default that would pass a check.

use fathom_canon::Json;

use crate::foreign_json::{get, get_arr, get_int, get_str};

/// `MembershipType::User`. Nothing else may pass the role check: an Owner or Admin sees every
/// collection, and a Manager (reported as Custom, 4) can be given more without the account
/// changing.
pub const MEMBERSHIP_USER: i64 = 2;
/// `MembershipStatus::Confirmed`: only a confirmed membership carries the organisation key.
pub const MEMBERSHIP_CONFIRMED: i64 = 2;
/// `CipherType::Login`.
pub const CIPHER_LOGIN: i64 = 1;
/// `DeviceType::Server`.
pub const DEVICE_TYPE_SERVER: &str = "22";
pub const DEVICE_NAME: &str = "Fathom";

/// Why an answer could not be used. The words are for a person and name no secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShapeError(pub &'static str);

/// `POST /identity/connect/token`'s answer, as far as Fathom uses it.
#[derive(Clone, Debug)]
pub struct Token {
    pub access_token: String,
    pub protected_user_key: String,
    pub protected_private_key: String,
    pub kdf_type: i64,
    pub kdf_iterations: i64,
    pub kdf_memory: Option<i64>,
    pub kdf_parallelism: Option<i64>,
    pub salt: Option<String>,
}

pub fn read_token(v: &Json) -> Result<Token, ShapeError> {
    let s = |k: &str, why: &'static str| get_str(v, k).map(str::to_string).ok_or(ShapeError(why));
    let salt = get(v, "UserDecryptionOptions")
        .and_then(|o| get(o, "MasterPasswordUnlock"))
        .and_then(|o| get_str(o, "Salt"))
        .map(str::to_string);
    Ok(Token {
        access_token: s("access_token", "the vault gave no access token")?,
        protected_user_key: s(
            "Key",
            "this account has no keys yet; sign in to it once first",
        )?,
        protected_private_key: s(
            "PrivateKey",
            "this account has no private key yet; sign in to it once first",
        )?,
        kdf_type: get_int(v, "Kdf")
            .ok_or(ShapeError("the vault did not say how its keys are made"))?,
        kdf_iterations: get_int(v, "KdfIterations")
            .ok_or(ShapeError("the vault did not say how its keys are made"))?,
        kdf_memory: get_int(v, "KdfMemory"),
        kdf_parallelism: get_int(v, "KdfParallelism"),
        salt,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Membership {
    pub org_id: String,
    pub name: String,
    pub role: i64,
    pub status: i64,
    pub protected_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Collection {
    pub id: String,
    pub org_id: String,
    /// Sealed by the organisation key.
    pub protected_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cipher {
    pub id: String,
    pub kind: i64,
    pub org_id: Option<String>,
    pub collection_ids: Vec<String>,
    pub deleted: bool,
    pub protected_key: Option<String>,
    pub protected_name: String,
    pub protected_username: Option<String>,
    pub protected_password: Option<String>,
    pub view_password: bool,
}

/// `GET /api/sync?excludeDomains=true`'s answer, as far as Fathom uses it.
#[derive(Clone, Debug)]
pub struct SyncAnswer {
    pub memberships: Vec<Membership>,
    pub collections: Vec<Collection>,
    pub ciphers: Vec<Cipher>,
}

fn opt_str(v: &Json, k: &str) -> Result<Option<String>, ShapeError> {
    match get(v, k) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Str(s)) => Ok(Some(s.clone())),
        _ => Err(ShapeError(
            "the vault's answer has a field of the wrong type",
        )),
    }
}

pub fn read_sync(v: &Json) -> Result<SyncAnswer, ShapeError> {
    let profile = get(v, "profile").ok_or(ShapeError("the vault's answer has no profile"))?;
    let orgs = get_arr(profile, "organizations")
        .ok_or(ShapeError("the vault's answer lists no organisations"))?;
    let mut memberships = Vec::new();
    for o in orgs {
        memberships.push(Membership {
            org_id: get_str(o, "id")
                .ok_or(ShapeError("an organisation without an id"))?
                .to_string(),
            name: get_str(o, "name").unwrap_or("").to_string(),
            role: get_int(o, "type").ok_or(ShapeError("an organisation without a role"))?,
            status: get_int(o, "status").ok_or(ShapeError("an organisation without a status"))?,
            protected_key: opt_str(o, "key")?,
        });
    }
    let mut collections = Vec::new();
    for c in get_arr(v, "collections").ok_or(ShapeError("the vault's answer has no collections"))? {
        collections.push(Collection {
            id: get_str(c, "id")
                .ok_or(ShapeError("a collection without an id"))?
                .to_string(),
            org_id: get_str(c, "organizationId")
                .ok_or(ShapeError("a collection without an organisation"))?
                .to_string(),
            protected_name: get_str(c, "name")
                .ok_or(ShapeError("a collection without a name"))?
                .to_string(),
        });
    }
    let mut ciphers = Vec::new();
    for c in get_arr(v, "ciphers").ok_or(ShapeError("the vault's answer has no items"))? {
        let login = get(c, "login").filter(|l| !matches!(l, Json::Null));
        let collection_ids = match get(c, "collectionIds") {
            None | Some(Json::Null) => Vec::new(),
            Some(Json::Arr(ids)) => ids
                .iter()
                .map(|i| match i {
                    Json::Str(s) => Ok(s.clone()),
                    _ => Err(ShapeError("an item's collections are not ids")),
                })
                .collect::<Result<_, _>>()?,
            _ => return Err(ShapeError("an item's collections are not a list")),
        };
        ciphers.push(Cipher {
            id: get_str(c, "id")
                .ok_or(ShapeError("an item without an id"))?
                .to_string(),
            kind: get_int(c, "type").ok_or(ShapeError("an item without a type"))?,
            org_id: opt_str(c, "organizationId")?,
            collection_ids,
            deleted: !matches!(get(c, "deletedDate"), None | Some(Json::Null)),
            protected_key: opt_str(c, "key")?,
            protected_name: get_str(c, "name")
                .ok_or(ShapeError("an item without a name"))?
                .to_string(),
            protected_username: login.map(|l| opt_str(l, "username")).transpose()?.flatten(),
            protected_password: login.map(|l| opt_str(l, "password")).transpose()?.flatten(),
            // Absent means the vault did not restrict it; `false` is a "hide passwords" grant.
            view_password: !matches!(get(c, "viewPassword"), Some(Json::Bool(false))),
        });
    }
    Ok(SyncAnswer {
        memberships,
        collections,
        ciphers,
    })
}

/// One line of the "Checked before it connects" list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckLine {
    pub id: &'static str,
    pub passed: bool,
    pub text: String,
}

/// The three checks (mockup r32-vault-external), run before connecting and again before every
/// read. `collection` is the connection's collection once there is one; before, the one
/// collection the account sees is the candidate. `name` is what to call it in the words.
pub fn checks(sync: &SyncAnswer, collection: Option<&str>, name: Option<&str>) -> Vec<CheckLine> {
    let confirmed: Vec<&Membership> = sync
        .memberships
        .iter()
        .filter(|m| m.status == MEMBERSHIP_CONFIRMED)
        .collect();
    let elevated = sync
        .memberships
        .iter()
        .filter(|m| m.role != MEMBERSHIP_USER)
        .count();
    let role = CheckLine {
        id: "role",
        passed: elevated == 0 && !confirmed.is_empty(),
        text: if confirmed.is_empty() {
            "The account is a plain User in an organisation: it is not a confirmed member of one yet"
                .to_string()
        } else if elevated == 0 {
            "The account is a plain User, not Admin or Owner (those see every collection)"
                .to_string()
        } else {
            format!(
                "The account must be a plain User; in {elevated} organisation{} it is Admin, Owner or Manager, which can see more than one collection",
                if elevated == 1 { "" } else { "s" }
            )
        },
    };
    let seen = sync.collections.len();
    let one = seen == 1
        && collection.is_none_or(|want| sync.collections[0].id == want)
        && confirmed
            .iter()
            .any(|m| m.org_id == sync.collections[0].org_id);
    let collection_line = CheckLine {
        id: "collection",
        passed: one,
        text: match (seen, name) {
            (1, Some(n)) if one => format!("It can see 1 collection: {n}"),
            (1, _) if one => "It can see 1 collection".to_string(),
            (1, _) => "It can see 1 collection, but not the one it was connected to".to_string(),
            (0, _) => "It must see exactly 1 collection; it sees none".to_string(),
            (n, _) => format!("It must see exactly 1 collection; it sees {n}"),
        },
    };
    let personal = sync.ciphers.iter().filter(|c| c.org_id.is_none()).count();
    let stray = sync
        .ciphers
        .iter()
        .filter(|c| {
            c.org_id.is_some()
                && sync
                    .collections
                    .first()
                    .is_none_or(|col| !c.collection_ids.contains(&col.id))
        })
        .count();
    let personal_line = CheckLine {
        id: "personal",
        passed: personal == 0 && stray == 0,
        text: if personal > 0 {
            format!(
                "Its own personal vault must be empty; it holds {personal} item{} (the trash counts)",
                if personal == 1 { "" } else { "s" }
            )
        } else if stray > 0 {
            format!(
                "It can see {stray} item{} outside its one collection",
                if stray == 1 { "" } else { "s" }
            )
        } else {
            "Its own personal vault is empty, so nothing is mixed in".to_string()
        },
    };
    vec![role, collection_line, personal_line]
}

pub fn all_pass(lines: &[CheckLine]) -> bool {
    lines.iter().all(|l| l.passed)
}

/// The first failed line's words: why a read was refused and the connection stopped.
pub fn first_failure(lines: &[CheckLine]) -> Option<String> {
    lines.iter().find(|l| !l.passed).map(|l| l.text.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foreign_json::parse;

    fn sync_json(role: i64, collections: &str, ciphers: &str) -> Json {
        parse(
            format!(
                r#"{{"object":"sync","profile":{{"organizations":[{{"id":"org1","name":"Lab","type":{role},"status":2,"key":"4.AAAA"}}]}},
                   "collections":[{collections}],"ciphers":[{ciphers}],"folders":[],"sends":[]}}"#
            )
            .as_bytes(),
        )
        .expect("fixture parses")
    }

    const ONE: &str = r#"{"id":"col1","organizationId":"org1","name":"2.a|b|c"}"#;
    const ITEM: &str = r#"{"id":"c1","type":1,"organizationId":"org1","collectionIds":["col1"],"key":null,"name":"2.n|n|n","deletedDate":null,"login":{"username":"2.u|u|u","password":"2.p|p|p","uris":[]},"viewPassword":true}"#;

    #[test]
    fn a_plain_user_with_one_collection_and_nothing_else_passes() {
        let s = read_sync(&sync_json(2, ONE, ITEM)).unwrap();
        let lines = checks(&s, Some("col1"), Some("fathom-7k2q"));
        assert!(all_pass(&lines), "{lines:?}");
        assert_eq!(lines[1].text, "It can see 1 collection: fathom-7k2q");
        assert_eq!(s.ciphers[0].protected_password.as_deref(), Some("2.p|p|p"));
    }

    #[test]
    fn each_check_fails_on_what_it_guards() {
        for role in [0, 1, 4] {
            let s = read_sync(&sync_json(role, ONE, ITEM)).unwrap();
            assert!(!checks(&s, None, None)[0].passed, "role {role}");
        }
        let two = format!("{ONE},{}", ONE.replace("col1", "col2"));
        let s = read_sync(&sync_json(2, &two, ITEM)).unwrap();
        assert_eq!(
            checks(&s, None, None)[1].text,
            "It must see exactly 1 collection; it sees 2"
        );
        let s = read_sync(&sync_json(2, ONE, ITEM)).unwrap();
        assert!(
            !checks(&s, Some("col9"), None)[1].passed,
            "a different collection"
        );
        let personal = ITEM.replace(r#""organizationId":"org1""#, r#""organizationId":null"#);
        let s = read_sync(&sync_json(2, ONE, &personal)).unwrap();
        assert!(!checks(&s, None, None)[2].passed);
        let trashed = format!(
            "{ITEM},{}",
            personal.replace(r#""id":"c1""#, r#""id":"c2""#).replace(
                r#""deletedDate":null"#,
                r#""deletedDate":"2026-10-01T00:00:00Z""#
            )
        );
        let s = read_sync(&sync_json(2, ONE, &trashed)).unwrap();
        assert!(!checks(&s, None, None)[2].passed, "the trash counts");
    }

    #[test]
    fn a_missing_field_is_a_refusal_not_a_pass() {
        let v = parse(
            br#"{"profile":{"organizations":[{"id":"o","type":2}]},"collections":[],"ciphers":[]}"#,
        )
        .unwrap();
        assert!(read_sync(&v).is_err(), "status missing");
        let t = parse(br#"{"access_token":"x","Kdf":0,"KdfIterations":600000}"#).unwrap();
        assert!(read_token(&t).is_err(), "no keys");
    }
}

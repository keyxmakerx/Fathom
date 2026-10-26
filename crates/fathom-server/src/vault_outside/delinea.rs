//! **Delinea Secret Server's answers** (ADR-0071 part four, Delinea second): the shapes Fathom
//! reads, and the checks before every read.
//!
//! Sources, read 2026-10-26:
//! - docs.delinea.com, Secret Server 12.3.x, "Script Authentication Using Tokens":
//!   `POST {server}/oauth2/token` with `username`, `password` and `grant_type=password`; the
//!   token goes back as `Authorization: Bearer`. It advises a least-privilege application
//!   account, "restricted from logging in the UI".
//! - docs.delinea.com, 12.3.x, "REST API PowerShell Scripts": `GET {server}/api/v1/secrets/{id}`.
//! - DelineaXPM/python-tss-sdk `delinea/secrets/server.py` (main): `API_PATH_URI = "/api/v1"`,
//!   searches `/api/v1/secrets` and reads `records[].id`, takes `filter.folderId`, reads
//!   `secret["items"]` with `slug` and `itemValue`.
//! - DelineaXPM/tss-sdk-go `server/secret.go` (main): a secret is `Name`, `FolderID`, `ID` and
//!   `Items` of `FieldName`, `Slug`, `ItemValue`, `IsPassword`; a search answers `Records`.
//! - xsoar.pan.dev "Delinea Secret Server" integration: a secret's `folderId`, `id`, and `items`
//!   with `slug`, `isPassword`, `itemValue`; a folder's `folderName` and `parentFolderId`.
//!
//! **Not established**: the folder list's own field names in a published reference (the REST
//! guide on updates.thycotic.net refused this build machine), and whether the API states an
//! account's permission level on a folder. So the checks are two, both on what the account can
//! *see*, and the connect screen asks for View only rather than claiming Fathom checks it. No
//! real Secret Server was reachable; the drive and tests use a stand-in of these shapes.
//!
//! Every field is read defensively: a missing or mistyped one is a refusal that names it.

use fathom_canon::Json;

use crate::foreign_json::{get, get_arr, get_int, get_str};

pub use super::vaultwarden::{CheckLine, ShapeError};

/// How many secrets or folders one answer may list. A folder Fathom reads is small; an account
/// that sees more is not one this was built for, and a partial page could hide what the checks
/// are for.
pub const TAKE: i64 = 500;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub folder_id: Option<String>,
}

/// One secret, read in full. No `Debug`: it carries a password.
pub struct Secret {
    pub id: String,
    pub folder_id: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
}

impl Drop for Secret {
    fn drop(&mut self) {
        for s in [&mut self.user, &mut self.password].into_iter().flatten() {
            crate::vault_fathom::wipe_string(s);
        }
    }
}

/// What one round reads: the folders and secrets the account sees, and one secret when a use
/// asked for it.
pub struct Answer {
    pub folders: Vec<Folder>,
    pub secrets: Vec<Summary>,
    pub secret: Option<Secret>,
}

/// An id as Secret Server writes one: a number. Kept as text, as the tables keep every id.
fn id_of(v: &Json, key: &str, why: &'static str) -> Result<String, ShapeError> {
    match get(v, key) {
        Some(Json::Int(i)) => Ok(i.to_string()),
        Some(Json::Str(s)) if !s.is_empty() && s.len() <= 64 => Ok(s.clone()),
        _ => Err(ShapeError(why)),
    }
}

fn opt_id(v: &Json, key: &str) -> Result<Option<String>, ShapeError> {
    match get(v, key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Int(i)) if *i >= 0 => Ok(Some(i.to_string())),
        // Secret Server writes -1 for "no folder" (a secret at the root).
        Some(Json::Int(_)) => Ok(None),
        _ => Err(ShapeError("a secret's folder is not an id")),
    }
}

/// A search answer's `records`, refusing one that says there are more than it listed.
fn records<'a>(v: &'a Json, what: &'static str) -> Result<&'a [Json], ShapeError> {
    let rows = get_arr(v, "records").ok_or(ShapeError(what))?;
    if let Some(total) = get_int(v, "total") {
        if total > rows.len() as i64 {
            return Err(ShapeError(
                "the account sees more than Fathom reads in one answer; give it one small folder",
            ));
        }
    }
    Ok(rows)
}

/// `POST /oauth2/token`'s answer.
pub fn read_token(v: &Json) -> Result<String, ShapeError> {
    get_str(v, "access_token")
        .filter(|t| !t.is_empty() && t.len() <= 8192)
        .map(str::to_string)
        .ok_or(ShapeError("the vault gave no access token"))
}

/// `GET /api/v1/folders`.
pub fn read_folders(v: &Json) -> Result<Vec<Folder>, ShapeError> {
    records(v, "the vault's answer lists no folders")?
        .iter()
        .map(|f| {
            Ok(Folder {
                id: id_of(f, "id", "a folder without an id")?,
                name: get_str(f, "folderName")
                    .ok_or(ShapeError("a folder without a name"))?
                    .to_string(),
            })
        })
        .collect()
}

/// `GET /api/v1/secrets`.
pub fn read_secrets(v: &Json) -> Result<Vec<Summary>, ShapeError> {
    records(v, "the vault's answer lists no secrets")?
        .iter()
        .map(|s| {
            Ok(Summary {
                id: id_of(s, "id", "a secret without an id")?,
                name: get_str(s, "name")
                    .ok_or(ShapeError("a secret without a name"))?
                    .to_string(),
                folder_id: opt_id(s, "folderId")?,
            })
        })
        .collect()
}

/// `GET /api/v1/secrets/{id}`: the user name is the item whose slug is `username`, the password
/// the one item marked `isPassword` (a secret with two is refused rather than guessed).
pub fn read_secret(v: &Json) -> Result<Secret, ShapeError> {
    let items = get_arr(v, "items").ok_or(ShapeError("a secret without fields"))?;
    let mut user = None;
    let mut password = None;
    for i in items {
        let value = match get(i, "itemValue") {
            None | Some(Json::Null) => None,
            Some(Json::Str(s)) => Some(s.clone()),
            _ => return Err(ShapeError("a secret's field is not text")),
        };
        if matches!(get(i, "isPassword"), Some(Json::Bool(true))) {
            if password.is_some() {
                return Err(ShapeError(
                    "the secret has two password fields; Fathom will not guess which",
                ));
            }
            password = Some(value.unwrap_or_default());
        } else if get_str(i, "slug") == Some("username") {
            user = value;
        }
    }
    Ok(Secret {
        id: id_of(v, "id", "a secret without an id")?,
        folder_id: opt_id(v, "folderId")?,
        user,
        password,
    })
}

/// The two checks, before connecting and before every read. `folder` is the connection's
/// folder once there is one; `name` the name the person typed.
pub fn checks(answer: &Answer, folder: Option<&str>, name: Option<&str>) -> Vec<CheckLine> {
    let seen = answer.folders.len();
    let tidy = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let the_one = (seen == 1).then(|| &answer.folders[0]);
    let right = the_one.is_some_and(|f| {
        folder.is_none_or(|want| f.id == want) && name.is_none_or(|n| tidy(&f.name) == tidy(n))
    });
    let folder_line = CheckLine {
        id: "collection",
        passed: right,
        text: match (seen, the_one) {
            (1, Some(f)) if right => format!("It can see 1 folder: {}", f.name),
            (1, Some(f)) => match name {
                Some(n) if tidy(&f.name) != tidy(n) => {
                    format!("Its one folder is called “{}”, not “{}”", f.name, tidy(n))
                }
                _ => "It can see 1 folder, but not the one it was connected to".to_string(),
            },
            (0, _) => "It must see exactly 1 folder; it sees none".to_string(),
            (n, _) => format!("It must see exactly 1 folder; it sees {n}"),
        },
    };
    let stray = answer
        .secrets
        .iter()
        .filter(|s| the_one.is_none_or(|f| s.folder_id.as_deref() != Some(f.id.as_str())))
        .count();
    let secrets_line = CheckLine {
        id: "personal",
        passed: stray == 0 && the_one.is_some(),
        text: if the_one.is_none() {
            "Its secrets are checked once it sees 1 folder".to_string()
        } else if stray == 0 {
            "Every secret it can see is in that folder".to_string()
        } else {
            format!(
                "It can see {stray} secret{} outside its one folder",
                if stray == 1 { "" } else { "s" }
            )
        },
    };
    vec![folder_line, secrets_line]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foreign_json::parse;

    fn answer(folders: &str, secrets: &str) -> Answer {
        Answer {
            folders: read_folders(&parse(folders.as_bytes()).unwrap()).unwrap(),
            secrets: read_secrets(&parse(secrets.as_bytes()).unwrap()).unwrap(),
            secret: None,
        }
    }

    const ONE: &str =
        r#"{"records":[{"id":5,"folderName":"Fathom","parentFolderId":-1}],"total":1}"#;
    const IN: &str = r#"{"records":[{"id":12,"name":"core-sw1","folderId":5}],"total":1}"#;

    #[test]
    fn one_folder_holding_everything_it_sees_passes() {
        let a = answer(ONE, IN);
        let lines = checks(&a, Some("5"), Some(" Fathom "));
        assert!(super::super::vaultwarden::all_pass(&lines), "{lines:?}");
        assert_eq!(lines[0].text, "It can see 1 folder: Fathom");
    }

    #[test]
    fn each_check_fails_on_what_it_guards() {
        let two =
            r#"{"records":[{"id":5,"folderName":"Fathom"},{"id":6,"folderName":"Everything"}]}"#;
        assert!(!checks(&answer(two, IN), None, None)[0].passed);
        assert!(!checks(&answer(ONE, IN), Some("6"), None)[0].passed);
        assert!(!checks(&answer(ONE, IN), None, Some("Other"))[0].passed);
        let out =
            r#"{"records":[{"id":12,"name":"a","folderId":5},{"id":13,"name":"b","folderId":-1}]}"#;
        let lines = checks(&answer(ONE, out), None, None);
        assert_eq!(lines[1].text, "It can see 1 secret outside its one folder");
        let lines = checks(&answer(two, IN), None, None);
        assert_eq!(
            lines[1].text,
            "Its secrets are checked once it sees 1 folder"
        );
    }

    #[test]
    fn a_partial_page_or_a_missing_field_is_a_refusal() {
        let more = r#"{"records":[{"id":5,"folderName":"F"}],"total":2}"#;
        assert!(read_folders(&parse(more.as_bytes()).unwrap()).is_err());
        assert!(read_secrets(&parse(br#"{"records":[{"id":1,"folderId":5}]}"#).unwrap()).is_err());
        assert!(read_token(&parse(br#"{"token_type":"bearer"}"#).unwrap()).is_err());
    }

    #[test]
    fn the_password_is_the_one_password_field() {
        let s = read_secret(&parse(br#"{"id":12,"folderId":5,"items":[{"slug":"username","itemValue":"admin","isPassword":false},{"slug":"password","itemValue":"p4ss","isPassword":true},{"slug":"notes","itemValue":"x","isPassword":false}]}"#).unwrap()).unwrap();
        assert_eq!(
            (s.user.as_deref(), s.password.as_deref()),
            (Some("admin"), Some("p4ss"))
        );
        let two = br#"{"id":12,"items":[{"slug":"password","itemValue":"a","isPassword":true},{"slug":"pin","itemValue":"b","isPassword":true}]}"#;
        assert!(read_secret(&parse(two).unwrap()).is_err());
    }
}

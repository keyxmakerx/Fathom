//! **Termix, a self-hosted SSH manager, beside Fathom** (ADR-0078).
//!
//! The operator names one Termix with `FATHOM_TERMIX_URL`. The server does two things with it and
//! nothing else: it adds that one origin to the client's `connect-src` (`client.rs`), and it tells
//! a signed-in member the address (`GET /organisations/{o}/termix`). The server never calls Termix.
//!
//! A person's browser does the rest with the person's own Termix API key, which never reaches this
//! server: it finds the Termix host whose address is a device's management address, adds one when
//! there is none, and opens Termix's full-screen terminal on it in a new tab. No password goes to
//! Termix from Fathom; Termix keeps its own credentials.
//!
//! **Invariant 2 still holds.** Fathom opens no connection to a device. Termix does, in a tab the
//! person opened, as the Termix user the key belongs to.
//!
//! **Who may use it** (ADR-0078 decision 6). Termix is per person: each person uses their own
//! Termix API key, and what they can reach is what their Termix user can. The operator turns it
//! off for the whole deployment by leaving `FATHOM_TERMIX_URL` unset. Inside an organisation a
//! steward of any folder turns it off for everyone there, or for one person (migration `0056`);
//! a person cannot turn back on what a steward turned off. Every change is sealed on the
//! organisation chain as `termix_access_set`.
//!
//! **That switch is a product switch, not a security boundary.** While it is off the client hides
//! Termix and this server does not give out its address, but someone who knows the address can
//! still open Termix in another tab with their own key. Taking Termix from a person is done in
//! Termix, by its admin revoking their key.
//!
//! **Why the origin is parsed so strictly.** It is written into a response header, so a value with
//! a space, a semicolon or a quote could add a CSP directive or a source. Only a scheme, a host of
//! letters, digits, dots and hyphens, and a port are accepted, and the whole value is refused
//! otherwise at startup.

use std::collections::{BTreeMap, BTreeSet};

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::chain::EntryType;
use crate::chains;
use crate::grants::{self, Authority, AuthorityError, StewardCheck};
use crate::invitations::InviteError;

/// The one Termix this deployment names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Termix {
    origin: String,
}

impl Termix {
    /// `https://host[:port]`, with an optional trailing `/`; `http://` only to a loopback host
    /// (`localhost`, `127.0.0.1`), for a Termix on the same machine. No user name, path, query or
    /// fragment.
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        const VARIABLE: &str = "FATHOM_TERMIX_URL";
        let value = value.trim();
        let value = value.strip_suffix('/').unwrap_or(value);
        let (scheme, rest) = value.split_once("://").ok_or(VARIABLE)?;
        let scheme = scheme.to_ascii_lowercase();
        let (host, port) = match rest.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        };
        let host = host.to_ascii_lowercase();
        let host_ok = !host.is_empty()
            && host.len() <= 253
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && !host.starts_with(['.', '-'])
            && !host.ends_with(['.', '-']);
        if !host_ok {
            return Err(VARIABLE);
        }
        if let Some(p) = port {
            match p.parse::<u16>() {
                Ok(n) if n > 0 && p.bytes().all(|b| b.is_ascii_digit()) => {}
                _ => return Err(VARIABLE),
            }
        }
        let loopback = host == "localhost" || host == "127.0.0.1";
        match scheme.as_str() {
            "https" => {}
            "http" if loopback => {}
            _ => return Err(VARIABLE),
        }
        let origin = match port {
            Some(p) => format!("{scheme}://{host}:{p}"),
            None => format!("{scheme}://{host}"),
        };
        Ok(Self { origin })
    }

    /// The origin, as the browser compares it: `https://termix.example.lan`.
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

/// Who turned Termix off for `account` in `organisation`: `"everyone"` when a steward turned it
/// off for the whole organisation, `"you"` when for this person, `None` when it is on. The caller
/// has opened a tenant context for `organisation`.
pub(crate) async fn off_for(
    tx: &Transaction<'_>,
    organisation: &str,
    account: &str,
) -> Result<Option<&'static str>, tokio_postgres::Error> {
    if off_for_everyone(tx, organisation).await? {
        return Ok(Some("everyone"));
    }
    let row = tx
        .query_opt(
            "SELECT 1 FROM member_termix \
              WHERE organisation_id = $1 AND account_id = $2 AND termix_off",
            &[&organisation, &account],
        )
        .await?;
    Ok(row.map(|_| "you"))
}

/// Whether a steward turned it off for the whole of `organisation`.
pub(crate) async fn off_for_everyone(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<bool, tokio_postgres::Error> {
    Ok(tx
        .query_opt(
            "SELECT 1 FROM organisation_termix WHERE organisation_id = $1 AND termix_off",
            &[&organisation],
        )
        .await?
        .is_some())
}

/// The members of `organisation` a steward turned it off for, one by one.
pub(crate) async fn off_in_organisation(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<BTreeSet<String>, tokio_postgres::Error> {
    let rows = tx
        .query(
            "SELECT account_id FROM member_termix WHERE organisation_id = $1 AND termix_off",
            &[&organisation],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// A steward turns Termix off, or back on, for everyone in the organisation (`account` `None`)
/// or for one member. Answers `{"account", "termix_off", "changed", "changed_seq"}`, `account`
/// null for everyone; setting it to what it already is seals nothing.
pub async fn set(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    account: Option<&str>,
    off: bool,
) -> Result<Json, InviteError> {
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();

    // A steward, asked before any row is read, so a member cannot probe who is in.
    let verified = grants::verify_authority_state(tx, auth).await?;
    let mut check = StewardCheck::new();
    if grants::steward_anchors(tx, auth, &verified, &mut check)
        .await?
        .is_empty()
    {
        return Err(InviteError::Authority(AuthorityError::NotAuthorised));
    }

    let current = match account {
        None => tx
            .query_opt(
                "SELECT termix_off FROM organisation_termix \
                  WHERE organisation_id = $1 FOR UPDATE",
                &[&organisation],
            )
            .await?
            .is_some_and(|r| r.get(0)),
        Some(account) => {
            let member = tx
                .query_opt(
                    "SELECT 1 FROM memberships WHERE organisation_id = $1 AND account_id = $2",
                    &[&organisation, &account],
                )
                .await?;
            if member.is_none() {
                return Err(InviteError::Malformed(
                    "no such person in this organisation",
                ));
            }
            tx.query_opt(
                "SELECT termix_off FROM member_termix \
                  WHERE organisation_id = $1 AND account_id = $2 FOR UPDATE",
                &[&organisation, &account],
            )
            .await?
            .is_some_and(|r| r.get(0))
        }
    };

    let mut answer = BTreeMap::new();
    answer.insert(
        "account".to_string(),
        account.map_or(Json::Null, |a| Json::Str(a.to_string())),
    );
    answer.insert("termix_off".to_string(), Json::Bool(off));
    if current == off {
        answer.insert("changed".to_string(), Json::Bool(false));
        answer.insert("changed_seq".to_string(), Json::Null);
        return Ok(Json::Obj(answer));
    }

    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::TermixAccessSet,
        &metadata(&organisation, &actor, account, off),
    )
    .await?;
    match account {
        None => {
            tx.execute(
                "INSERT INTO organisation_termix (organisation_id, termix_off, set_by) \
                 VALUES ($1, $2, $3) \
                 ON CONFLICT (organisation_id) DO UPDATE \
                 SET termix_off = EXCLUDED.termix_off, set_by = EXCLUDED.set_by, set_at = now()",
                &[&organisation, &off, &actor],
            )
            .await?;
        }
        Some(account) => {
            tx.execute(
                "INSERT INTO member_termix (organisation_id, account_id, termix_off, set_by) \
                 VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (organisation_id, account_id) DO UPDATE \
                 SET termix_off = EXCLUDED.termix_off, set_by = EXCLUDED.set_by, set_at = now()",
                &[&organisation, &account, &off, &actor],
            )
            .await?;
        }
    }

    answer.insert("changed".to_string(), Json::Bool(true));
    answer.insert("changed_seq".to_string(), Json::Int(appended.seq));
    Ok(Json::Obj(answer))
}

fn metadata(organisation: &str, actor: &str, account: Option<&str>, off: bool) -> Vec<u8> {
    let mut map = BTreeMap::new();
    match account {
        Some(a) => map.insert("account".to_string(), Json::Str(a.to_string())),
        None => map.insert("everyone".to_string(), Json::Bool(true)),
    };
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::TermixAccessSet.as_str().to_string()),
    );
    map.insert("off".to_string(), Json::Bool(off));
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    Json::Obj(map).to_canonical_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_https_origin_is_kept_as_an_origin() {
        let t = Termix::parse(" https://Termix.Example.lan/ ").unwrap();
        assert_eq!(t.origin(), "https://termix.example.lan");
        let t = Termix::parse("https://10.0.0.5:8443").unwrap();
        assert_eq!(t.origin(), "https://10.0.0.5:8443");
    }

    #[test]
    fn plain_http_only_to_this_machine() {
        assert_eq!(
            Termix::parse("http://localhost:8080").unwrap().origin(),
            "http://localhost:8080"
        );
        assert!(Termix::parse("http://termix.example.lan").is_err());
        assert!(Termix::parse("ftp://termix.example.lan").is_err());
    }

    #[test]
    fn anything_that_could_add_to_a_header_is_refused() {
        for bad in [
            "https://termix.example.lan; script-src *",
            "https://termix.example.lan *",
            "https://termix.example.lan/path",
            "https://user@termix.example.lan",
            "https://termix.example.lan?x=1",
            "https://termix.example.lan#x",
            "https://\"termix\"",
            "https://termix.example.lan:0",
            "https://termix.example.lan:99999",
            "https://termix.example.lan:+80",
            "https://",
            "https://-termix",
            "termix.example.lan",
            "https://[::1]",
        ] {
            assert!(Termix::parse(bad).is_err(), "{bad}");
        }
    }
}

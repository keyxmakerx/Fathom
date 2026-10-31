//! The estate index's routes and its rebuilds (ADR-0079 decisions 2 to 4; the index itself is
//! `crate::estate`).
//!
//! - `POST /organisations/{organisation}/estate/search`, body `{"q": text, "kind": text?}`:
//!   things matching every word, across every design the caller may read.
//! - `POST /organisations/{organisation}/estate/page`, body `{"kind": text?, "after":
//!   [design, element]?}`: Inventory's Everywhere view, one page at a time.
//!
//! - `POST /organisations/{organisation}/estate/far`, body `{"ends": [[design, element], ...]}`:
//!   for each far end of a link between sites (ADR-0079 decision 5), whether the caller may
//!   open that design, whether the port is still there, its device and name, and where that
//!   port's own link points, so the near design can say a link is one-sided.
//!
//! Search and page answer `{"hits": [...], "designs": n, "behind": n}`: `behind` counts the readable
//! designs whose rows are older than the design, which this request has queued for a rebuild
//! under the caller's own session. POST because the query is free text and a signed GET's
//! query string is read without percent-decoding.
//!
//! A rebuild reads the design the way opening it does, under the session of the person whose
//! save, change or search asked for it, so it can never index what that person could not read.

use std::collections::BTreeMap;

use axum::extract::{Path as PathExtractor, State};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use fathom_canon::Json;

use super::{
    begin_org_keep, design_scope, json_response, object_body, DesignApiState, RouteError, Signed,
};
use crate::authority::Capability;
use crate::designs;
use crate::estate::{self, IndexKeys};
use crate::grants::{self, Authority};
use crate::repo::{DesignId, OrganisationId, ScopeId};
use crate::sessions::{self, SessionError, VerifiedSession};

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route(
            "/organisations/{organisation}/estate/search",
            post(search_handler),
        )
        .route(
            "/organisations/{organisation}/estate/page",
            post(page_handler),
        )
        .route(
            "/organisations/{organisation}/estate/far",
            post(far_handler),
        )
}

/// The most far ends one request may ask about.
const FAR_PER_REQUEST: usize = 64;

/// A far port as the index has it: its device's name, its own name, and where its own
/// link points.
type FarPort = (String, String, Option<(String, String)>);

/// How many designs one request may queue for a rebuild, so the first search on a large
/// estate does not start a thousand rebuilds at once. The next search queues the next ones.
const QUEUE_PER_REQUEST: usize = 16;

const KINDS: [&str; 5] = ["device", "card", "optic", "power_supply", "spare"];

fn kind_of(m: &mut BTreeMap<String, Json>) -> Result<Option<String>, RouteError> {
    match m.remove("kind") {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Str(k)) if KINDS.contains(&k.as_str()) => Ok(Some(k)),
        Some(_) => Err(SessionError::Malformed("kind").into()),
    }
}

/// Queue `design` for a rebuild after [`estate::QUIET`], unless it is already waiting.
pub(super) fn schedule(
    state: &DesignApiState,
    tenant: OrganisationId,
    design: DesignId,
    session: VerifiedSession,
) {
    let design_text = design.to_string();
    if !state.live.estate.claim(&design_text) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(estate::QUIET).await;
        state.live.estate.release(&design_text);
        if let Err(why) = rebuild(&state, tenant, design, &session).await {
            tracing::info!(design = %design_text, %why, "estate index not rebuilt");
        }
    });
}

async fn rebuild(
    state: &DesignApiState,
    tenant: OrganisationId,
    design: DesignId,
    session: &VerifiedSession,
) -> Result<(), String> {
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(|e| e.to_string())?;
    let tx = client.transaction().await.map_err(|e| e.to_string())?;
    let standing = state.sessions.check_session_standing(&tx, session).await;
    let _ = tx.commit().await;
    standing.map_err(|e| e.to_string())?;

    let tx = client.transaction().await.map_err(|e| e.to_string())?;
    let ctx = sessions::open_tenant_context(&tx, tenant, session)
        .await
        .map_err(|e| e.to_string())?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(|e| e.to_string())?;
    let scope = design_scope(&tx, &ctx, design)
        .await
        .map_err(|e| e.to_string())?;
    if scope.is_none() {
        return Ok(());
    }
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let stored =
        designs::read_version_in_tx(&tx, &auth, Some(&state.live.heads), design, scope, None)
            .await
            .map_err(|e| format!("{e:?}"))?;
    let payload = stored.payload;
    let rows = tokio::task::spawn_blocking(move || estate::rows_of(&payload))
        .await
        .map_err(|e| e.to_string())??;
    let organisation = tenant.to_string();
    let keys = IndexKeys::derive(&tenant_key, &organisation);
    estate::replace_design(
        &tx,
        &keys,
        &organisation,
        &design.to_string(),
        stored.version,
        &rows,
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// The designs the caller may read, with their newest version and name.
struct Readable {
    ids: Vec<String>,
    latest: BTreeMap<String, i64>,
    names: BTreeMap<String, Option<String>>,
}

async fn readable(
    tx: &deadpool_postgres::Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<Readable, RouteError> {
    let verified = grants::verify_authority_state(tx, auth)
        .await
        .map_err(SessionError::Authority)?;
    let rows = tx
        .query(
            "SELECT d.id, d.scope_id, \
                    greatest( \
                        coalesce((SELECT max(p.design_version) FROM design_payload p \
                                   WHERE p.design_id = d.id \
                                     AND p.organisation_id = d.organisation_id), 0), \
                        coalesce((SELECT max(c.design_version) FROM design_change c \
                                   WHERE c.design_id = d.id \
                                     AND c.organisation_id = d.organisation_id), 0)), \
                    d.name_ciphertext, d.name_nonce, d.name_key_epoch \
             FROM designs d WHERE d.organisation_id = $1 ORDER BY d.id",
            &[&auth.ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;
    let mut opener = designs::NameOpener::new(auth);
    let mut out = Readable {
        ids: Vec::new(),
        latest: BTreeMap::new(),
        names: BTreeMap::new(),
    };
    for row in rows {
        let id: String = row.get(0);
        let scope_text: String = row.get(1);
        let latest: i64 = row.get(2);
        let scope: ScopeId = scope_text
            .parse()
            .map_err(|_| SessionError::Corrupt("design scope id"))?;
        match grants::authorise_in_verified_state(
            tx,
            auth,
            &verified,
            Some(scope),
            Capability::Read,
        )
        .await
        {
            Ok(_) => {}
            Err(grants::AuthorityError::NotAuthorised)
            | Err(grants::AuthorityError::QuorumNotMet { .. }) => continue,
            Err(other) => return Err(SessionError::Authority(other).into()),
        }
        let sealed = match (
            row.get::<_, Option<Vec<u8>>>(3),
            row.get::<_, Option<Vec<u8>>>(4),
            row.get::<_, Option<i32>>(5),
        ) {
            (Some(c), Some(n), Some(e)) => Some((c, n, e)),
            _ => None,
        };
        let name = opener.open(tx, &id, sealed).await?;
        out.names.insert(id.clone(), name);
        out.latest.insert(id.clone(), latest);
        out.ids.push(id);
    }
    Ok(out)
}

fn answer(hits: Vec<estate::Hit>, readable: &Readable, behind: usize) -> Response {
    let hits = hits
        .into_iter()
        .map(|hit| {
            let mut m = match hit.row {
                Json::Obj(m) => m,
                _ => BTreeMap::new(),
            };
            let name = readable.names.get(&hit.design).cloned().flatten();
            m.insert("design".into(), Json::Str(hit.design));
            m.insert("designName".into(), name.map_or(Json::Null, Json::Str));
            Json::Obj(m)
        })
        .collect();
    let mut m = BTreeMap::new();
    m.insert("hits".into(), Json::Arr(hits));
    m.insert("designs".into(), Json::Int(readable.ids.len() as i64));
    m.insert("behind".into(), Json::Int(behind as i64));
    json_response(Json::Obj(m))
}

/// Count the readable designs whose rows are older than the design, and queue a few.
async fn catch_up(
    state: &DesignApiState,
    tx: &deadpool_postgres::Transaction<'_>,
    tenant: OrganisationId,
    session: &VerifiedSession,
    readable: &Readable,
) -> Result<usize, RouteError> {
    let built = estate::built_versions(tx, &tenant.to_string(), &readable.ids)
        .await
        .map_err(|_| SessionError::Corrupt("estate index"))?;
    let behind: Vec<&String> = readable
        .ids
        .iter()
        .filter(|id| {
            let latest = readable.latest.get(*id).copied().unwrap_or(0);
            latest > 0 && built.get(*id).copied().unwrap_or(0) < latest
        })
        .collect();
    for id in behind.iter().take(QUEUE_PER_REQUEST) {
        if let Ok(design) = id.parse::<DesignId>() {
            schedule(state, tenant, design, session.clone());
        }
    }
    Ok(behind.len())
}

async fn search_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(&signed.body, &["q", "kind"])?;
    let q = match body.remove("q") {
        Some(Json::Str(q)) if q.chars().count() <= 200 => q,
        _ => return Err(SessionError::Malformed("q").into()),
    };
    let kind = kind_of(&mut body)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key, session) =
        begin_org_keep(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let readable = readable(&tx, &auth).await?;
    let tenant = ctx.tenant();
    let keys = IndexKeys::derive(&tenant_key, &tenant.to_string());
    let hits = estate::search(
        &tx,
        &keys,
        &tenant.to_string(),
        &readable.ids,
        &q,
        kind.as_deref(),
        estate::PAGE,
    )
    .await
    .map_err(|_| SessionError::Corrupt("estate index"))?;
    let behind = catch_up(&state, &tx, tenant, &session, &readable).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(answer(hits, &readable, behind))
}

async fn page_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(&signed.body, &["kind", "after"])?;
    let kind = kind_of(&mut body)?;
    let after = match body.remove("after") {
        None | Some(Json::Null) => None,
        Some(Json::Arr(pair)) => match pair.as_slice() {
            [Json::Str(d), Json::Str(e)] => Some((d.clone(), e.clone())),
            _ => return Err(SessionError::Malformed("after").into()),
        },
        Some(_) => return Err(SessionError::Malformed("after").into()),
    };
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key, session) =
        begin_org_keep(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let readable = readable(&tx, &auth).await?;
    let tenant = ctx.tenant();
    let keys = IndexKeys::derive(&tenant_key, &tenant.to_string());
    let hits = estate::page(
        &tx,
        &keys,
        &tenant.to_string(),
        &readable.ids,
        kind.as_deref(),
        after.as_ref().map(|(d, e)| (d.as_str(), e.as_str())),
        estate::PAGE,
    )
    .await
    .map_err(|_| SessionError::Corrupt("estate index"))?;
    let behind = catch_up(&state, &tx, tenant, &session, &readable).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(answer(hits, &readable, behind))
}

async fn far_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(&signed.body, &["ends"])?;
    let mut ends: Vec<(String, String)> = Vec::new();
    match body.remove("ends") {
        Some(Json::Arr(items)) if items.len() <= FAR_PER_REQUEST => {
            for item in items {
                match item {
                    Json::Arr(pair) => match pair.as_slice() {
                        [Json::Str(d), Json::Str(e)] => ends.push((d.clone(), e.clone())),
                        _ => return Err(SessionError::Malformed("ends").into()),
                    },
                    _ => return Err(SessionError::Malformed("ends").into()),
                }
            }
        }
        _ => return Err(SessionError::Malformed("ends").into()),
    }
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key, session) =
        begin_org_keep(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let readable = readable(&tx, &auth).await?;
    let tenant = ctx.tenant();
    let org = tenant.to_string();
    let keys = IndexKeys::derive(&tenant_key, &org);

    // Only designs the caller may read are looked in; any other is "closed", the
    // same answer whether it exists or not.
    let mut wanted: Vec<String> = ends
        .iter()
        .map(|(d, _)| d.clone())
        .filter(|d| readable.names.contains_key(d))
        .collect();
    wanted.sort();
    wanted.dedup();
    let built = estate::built_versions(&tx, &org, &wanted)
        .await
        .map_err(|_| SessionError::Corrupt("estate index"))?;
    let asked: Vec<(String, String)> = ends
        .iter()
        .filter(|(d, _)| readable.names.contains_key(d))
        .cloned()
        .collect();
    let devices = estate::devices_holding(&tx, &keys, &org, &asked)
        .await
        .map_err(|_| SessionError::Corrupt("estate index"))?;
    // (design, port) -> (device name, port name, the port's own far end).
    let mut ports: BTreeMap<(String, String), FarPort> = BTreeMap::new();
    for hit in &devices {
        let Json::Obj(row) = &hit.row else { continue };
        let device = match row.get("name") {
            Some(Json::Str(n)) => n.clone(),
            _ => String::new(),
        };
        let Some(Json::Arr(list)) = row.get("ports") else {
            continue;
        };
        for port in list {
            let Json::Obj(p) = port else { continue };
            let get = |k: &str| match p.get(k) {
                Some(Json::Str(v)) => Some(v.clone()),
                _ => None,
            };
            let Some(id) = get("id") else { continue };
            let back = get("farDesign").zip(get("farElement"));
            ports.insert(
                (hit.design.clone(), id),
                (device.clone(), get("name").unwrap_or_default(), back),
            );
        }
    }
    let behind = catch_up(&state, &tx, tenant, &session, &readable).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    let answers = ends
        .into_iter()
        .map(|(design, element)| {
            let mut m = BTreeMap::new();
            let name = readable.names.get(&design).cloned().flatten();
            let stateword = if !readable.names.contains_key(&design) {
                "closed"
            } else if let Some((device, port, back)) = ports.get(&(design.clone(), element.clone()))
            {
                m.insert("device".into(), Json::Str(device.clone()));
                m.insert("port".into(), Json::Str(port.clone()));
                if let Some((d, e)) = back {
                    m.insert(
                        "back".into(),
                        Json::Arr(vec![Json::Str(d.clone()), Json::Str(e.clone())]),
                    );
                }
                "here"
            } else if built.get(&design).copied().unwrap_or(0)
                < readable.latest.get(&design).copied().unwrap_or(0)
            {
                "behind"
            } else {
                "gone"
            };
            m.insert("state".into(), Json::Str(stateword.into()));
            if stateword != "closed" {
                m.insert("designName".into(), name.map_or(Json::Null, Json::Str));
            }
            m.insert("design".into(), Json::Str(design));
            m.insert("element".into(), Json::Str(element));
            Json::Obj(m)
        })
        .collect();
    let mut m = BTreeMap::new();
    m.insert("ends".into(), Json::Arr(answers));
    m.insert("behind".into(), Json::Int(behind as i64));
    Ok(json_response(Json::Obj(m)))
}

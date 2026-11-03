//! Orders (ADR-0084 piece 2, sign-off r103 and r105): an organisation's order types, the orders
//! opened from them, and each order's history (migration `0074`).
//!
//! The rules are `fathom-orders`'. This module stores and loads; it decides only what the engine
//! cannot: who is a Steward, which teams stand and where the caller stands on them, and that
//! nothing a person typed reads like a credential.
//!
//! - **An order type** is the Steward's YAML file as written, the shared field sets it used, and
//!   the team each of its slugs was matched to (decision 8), sealed as one blob under the
//!   organisation content key. Saving again makes a new version; an open order keeps the version
//!   it was opened from.
//! - **An order** is that version plus its history. Every event (who, when, the action word, and
//!   the action's words sealed) is a row, filed on the organisation chain as `order_event` with
//!   ids and the action word only. Where an order stands is `Order::replay` over its history:
//!   there is no second copy of the state to drift from it. History is trusted for who could
//!   act (the engine's `replay`), so a team change later never rewrites what happened.
//! - **Who may act** is asked of the engine with the caller's standing read once per request
//!   ([`crate::teams::order_people`]): counting membership, roles and powers on each team the
//!   order names, and whether the caller is a Steward of the organisation.
//!
//! Every text a person writes into an order type, an answer or a reason goes through the
//! redaction gate's bare check (CLAUDE.md rule 4; ADR-0084 decision 2), as a correction's does.
//! The server refuses one that reads like a credential; it never stores it.

use std::collections::{BTreeMap, BTreeSet};

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use fathom_orders::engine::{
    Action, Actor, Event, JobStatus, Order, OrderStatus, People, Ref, StageStatus, Value,
};
use fathom_orders::{Definition, FieldKind, FieldSet, Problem};

use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{self, now_unix};
use crate::designs::DesignError;
use crate::grants::{entry_metadata, Authority, AuthorityError};
use crate::keys;
use crate::roles::Power;
use crate::teams::{self, OrderPeople};

const AAD_ORDER_TYPE: &[u8] = b"fathom/order-type/v1";
const AAD_ORDER_EVENT: &[u8] = b"fathom/order-event/v1";

/// The design id an order's W- number is filed under in `work_numbers`. Not a design: a ULID is
/// 26 characters and this is not, so it never names one.
pub const NUMBERS_DESIGN: &str = "orders";

/// A definition file, or one shared field set, at most this many bytes.
pub const MAX_SOURCE_BYTES: usize = 256 * 1024;
/// At most this many shared field sets carried with one order type.
pub const MAX_FIELD_SETS: usize = 32;
/// One answer's text, or one list of choices joined, at most this many characters.
pub const MAX_ANSWER_CHARS: usize = 4000;
/// A reason, at most this many characters.
pub const MAX_REASON_CHARS: usize = 2000;
/// At most this many order types in one organisation, counting each once however many versions.
pub const MAX_ORDER_TYPES: i64 = 500;
/// At most this many events on one order. Far past any real order; it keeps a loop of ticks
/// from growing one without end.
pub const MAX_EVENTS: i64 = 10_000;

/// Why an order act was refused.
#[derive(Debug)]
pub enum OrderError {
    Design(DesignError),
    Authority(AuthorityError),
    /// The file has problems, each at a line.
    Problems(Vec<Problem>),
    /// Team slugs the file names that no standing team matched (decision 8).
    Unmatched(Vec<String>),
    /// The engine refused the action; the order is unchanged.
    Refused(String),
    /// No such order type or order in this organisation.
    NotFound,
    /// A text that reads like a password or key.
    LooksSecret(String),
    /// A request the server can't read.
    Malformed(&'static str),
    /// The organisation has as many order types as it may, or the order as many events.
    Limit(&'static str),
}

impl From<DesignError> for OrderError {
    fn from(e: DesignError) -> Self {
        Self::Design(e)
    }
}
impl From<AuthorityError> for OrderError {
    fn from(e: AuthorityError) -> Self {
        Self::Authority(e)
    }
}
impl From<tokio_postgres::Error> for OrderError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Design(e.into())
    }
}
impl From<keys::KeyStoreError> for OrderError {
    fn from(e: keys::KeyStoreError) -> Self {
        Self::Design(e.into())
    }
}
impl From<crypto::CryptoError> for OrderError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Design(e.into())
    }
}
impl From<crate::chains::ChainStoreError> for OrderError {
    fn from(e: crate::chains::ChainStoreError) -> Self {
        Self::Authority(e.into())
    }
}

fn corrupt(what: &'static str) -> OrderError {
    OrderError::Design(DesignError::Corrupt(what))
}

// ---------------------------------------------------------------------------
// The people, as the engine asks about them
// ---------------------------------------------------------------------------

/// The caller's standing, read once for this request. The engine only ever asks about the
/// person acting; anyone else gets no.
struct Standing<'a> {
    account: &'a str,
    people: &'a OrderPeople,
}

impl People for Standing<'_> {
    fn on_team(&self, account: &str, team: &str) -> bool {
        account == self.account
            && self
                .people
                .standing
                .get(team)
                .is_some_and(|s| s.member || !s.roles.is_empty())
    }
    fn has_power(&self, account: &str, team: &str, power: &str) -> bool {
        let Some(power) = Power::parse(power) else {
            return false;
        };
        account == self.account
            && self
                .people
                .standing
                .get(team)
                .is_some_and(|s| s.powers.contains(&power))
    }
    fn has_role(&self, account: &str, team: &str, role: &str) -> bool {
        account == self.account
            && self
                .people
                .standing
                .get(team)
                .is_some_and(|s| s.roles.contains(role))
    }
    fn is_steward(&self, account: &str) -> bool {
        account == self.account && self.people.steward
    }
}

/// Every team id an installed definition names.
fn teams_of(def: &Definition) -> BTreeSet<String> {
    def.team_slugs().into_iter().map(str::to_owned).collect()
}

// ---------------------------------------------------------------------------
// Text checks
// ---------------------------------------------------------------------------

/// The redaction gate's bare check over every text a person wrote into a definition: its name,
/// each field's label, help and choices, and each lane's, stage's and job's name, steps and
/// send-back label. Keys and ids are not checked: the reader allows them only a narrow
/// alphabet, and a key such as `key:` would read as the word that introduces a secret.
fn check_definition_texts(def: &Definition, problems: &mut Vec<Problem>) {
    let mut texts: Vec<(usize, &str)> = vec![(1, def.name.as_str())];
    for f in &def.fields {
        texts.push((f.line, &f.label));
        if let Some(h) = &f.help {
            texts.push((f.line, h));
        }
        texts.extend(f.choices.iter().map(|c| (f.line, c.as_str())));
    }
    for lane in &def.lanes {
        texts.push((lane.line, &lane.name));
        for stage in &lane.stages {
            texts.push((stage.line, &stage.name));
            for job in &stage.jobs {
                texts.push((job.line, &job.name));
                texts.extend(job.steps.iter().map(|t| (job.line, t.as_str())));
                if let Some(sb) = &job.send_back {
                    texts.push((job.line, &sb.label));
                }
            }
        }
    }
    for (line, text) in texts {
        if fathom_ingest::redact::looks_like_credential_bare(text) {
            problems.push(Problem {
                line,
                message: "this reads like a password or key; Fathom does not keep one in an \
                          order type"
                    .into(),
            });
        }
    }
}

fn check_text(text: &str, max: usize, what: &'static str) -> Result<(), OrderError> {
    if text.chars().count() > max {
        return Err(OrderError::Malformed(what));
    }
    if text
        .chars()
        .any(|c| c != '\n' && c != '\t' && crate::field_defs::is_unsafe_char(c))
    {
        return Err(OrderError::Malformed(what));
    }
    if fathom_ingest::redact::looks_like_credential_bare(text) {
        return Err(OrderError::LooksSecret(what.to_string()));
    }
    Ok(())
}

fn check_value(v: &Value) -> Result<(), OrderError> {
    match v {
        Value::Text(t) | Value::Date(t) => check_text(t, MAX_ANSWER_CHARS, "an answer"),
        Value::List(items) => {
            for t in items {
                check_text(t, MAX_ANSWER_CHARS, "an answer")?;
            }
            Ok(())
        }
        Value::Ref(r) => {
            for t in [Some(&r.design), Some(&r.device), r.port.as_ref()]
                .into_iter()
                .flatten()
            {
                if t.is_empty() || t.chars().count() > 128 || t.chars().any(char::is_control) {
                    return Err(OrderError::Malformed("a device or port"));
                }
            }
            Ok(())
        }
        Value::Int(_) | Value::Bool(_) => Ok(()),
    }
}

/// Every text a person put into an action.
fn check_action(a: &Action) -> Result<(), OrderError> {
    match a {
        Action::Open { answers } => {
            for (_, v) in answers {
                check_value(v)?;
            }
            Ok(())
        }
        Action::Answer { value, reason, .. } => {
            if let Some(v) = value {
                check_value(v)?;
            }
            if let Some(r) = reason {
                check_text(r, MAX_REASON_CHARS, "a reason")?;
            }
            Ok(())
        }
        Action::SendBack { reason, .. }
        | Action::Cancel { reason, .. }
        | Action::CancelOrder { reason } => check_text(reason, MAX_REASON_CHARS, "a reason"),
        Action::LinkPlan { design, plan, .. } => {
            check_text(design, 64, "a design id")?;
            check_text(plan, 64, "a plan id")
        }
        Action::PickUp { .. }
        | Action::Tick { .. }
        | Action::Finish { .. }
        | Action::Approve { .. } => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// JSON: values and actions, for the store and the API alike
// ---------------------------------------------------------------------------

fn obj(entries: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

fn opt_str(v: &Option<String>) -> Json {
    v.as_ref().map_or(Json::Null, |s| Json::Str(s.clone()))
}

pub fn value_to_json(v: &Value) -> Json {
    match v {
        Value::Text(t) | Value::Date(t) => Json::Str(t.clone()),
        Value::Int(i) => Json::Int(*i),
        Value::Bool(b) => Json::Bool(*b),
        Value::List(items) => Json::Arr(items.iter().cloned().map(Json::Str).collect()),
        Value::Ref(r) => obj(vec![
            ("design", Json::Str(r.design.clone())),
            ("device", Json::Str(r.device.clone())),
            ("port", opt_str(&r.port)),
        ]),
    }
}

/// A value for a field of `kind`, from its JSON. The engine checks the rest (choices, range,
/// a date's shape).
pub fn value_from_json(kind: FieldKind, j: Json) -> Result<Value, OrderError> {
    let bad = || OrderError::Malformed("an answer does not fit its field");
    Ok(match (kind, j) {
        (FieldKind::Number, Json::Int(i)) => Value::Int(i),
        (FieldKind::YesNo, Json::Bool(b)) => Value::Bool(b),
        (FieldKind::Date, Json::Str(s)) => Value::Date(s),
        (FieldKind::Choices, Json::Arr(items)) => Value::List(
            items
                .into_iter()
                .map(|i| match i {
                    Json::Str(s) => Ok(s),
                    _ => Err(bad()),
                })
                .collect::<Result<_, _>>()?,
        ),
        (FieldKind::Device | FieldKind::Port, Json::Obj(mut m)) => {
            let (Some(Json::Str(design)), Some(Json::Str(device))) =
                (m.remove("design"), m.remove("device"))
            else {
                return Err(bad());
            };
            let port = match m.remove("port") {
                None | Some(Json::Null) => None,
                Some(Json::Str(p)) => Some(p),
                Some(_) => return Err(bad()),
            };
            if !m.is_empty() {
                return Err(bad());
            }
            Value::Ref(Ref {
                design,
                device,
                port,
            })
        }
        (
            FieldKind::Text
            | FieldKind::LongText
            | FieldKind::Choice
            | FieldKind::Site
            | FieldKind::Team
            | FieldKind::Person
            | FieldKind::Prefix,
            Json::Str(s),
        ) => Value::Text(s),
        _ => return Err(bad()),
    })
}

fn kind_of(def: &Definition, field: &str) -> Result<FieldKind, OrderError> {
    def.field(field)
        .map(|f| f.kind)
        .ok_or(OrderError::Refused(format!(
            "this order has no field `{field}`"
        )))
}

/// The action's word, as the plain column and the chain entry carry it.
pub fn action_word(a: &Action) -> &'static str {
    match a {
        Action::Open { .. } => "open",
        Action::Answer { .. } => "answer",
        Action::PickUp { .. } => "pick_up",
        Action::Tick { .. } => "tick",
        Action::LinkPlan { .. } => "link_plan",
        Action::Finish { .. } => "finish",
        Action::SendBack { .. } => "send_back",
        Action::Cancel { .. } => "cancel",
        Action::Approve { .. } => "approve",
        Action::CancelOrder { .. } => "cancel_order",
    }
}

/// The action's own words, without its kind (the kind is the plain `action` column).
pub fn action_to_json(a: &Action) -> Json {
    match a {
        Action::Open { answers } => obj(vec![(
            "answers",
            Json::Arr(
                answers
                    .iter()
                    .map(|(k, v)| Json::Arr(vec![Json::Str(k.clone()), value_to_json(v)]))
                    .collect(),
            ),
        )]),
        Action::Answer {
            field,
            value,
            reason,
        } => obj(vec![
            ("field", Json::Str(field.clone())),
            ("value", value.as_ref().map_or(Json::Null, value_to_json)),
            ("reason", opt_str(reason)),
        ]),
        Action::PickUp { job } | Action::Finish { job } => {
            obj(vec![("job", Json::Str(job.clone()))])
        }
        Action::Tick { job, step, done } => obj(vec![
            ("job", Json::Str(job.clone())),
            ("step", Json::Int(*step as i64)),
            ("done", Json::Bool(*done)),
        ]),
        Action::LinkPlan { job, design, plan } => obj(vec![
            ("job", Json::Str(job.clone())),
            ("design", Json::Str(design.clone())),
            ("plan", Json::Str(plan.clone())),
        ]),
        Action::SendBack { job, reason } | Action::Cancel { job, reason } => obj(vec![
            ("job", Json::Str(job.clone())),
            ("reason", Json::Str(reason.clone())),
        ]),
        Action::Approve { stage } => obj(vec![("stage", Json::Str(stage.clone()))]),
        Action::CancelOrder { reason } => obj(vec![("reason", Json::Str(reason.clone()))]),
    }
}

/// An action from its word and its JSON, as a request or the store gives it. Every key the word
/// takes must be there and no other.
pub fn action_from_json(
    def: &Definition,
    word: &str,
    mut m: BTreeMap<String, Json>,
) -> Result<Action, OrderError> {
    fn bad() -> OrderError {
        OrderError::Malformed("an order action")
    }
    fn take(m: &mut BTreeMap<String, Json>, k: &str) -> Result<String, OrderError> {
        match m.remove(k) {
            Some(Json::Str(v)) => Ok(v),
            _ => Err(bad()),
        }
    }
    let action = match word {
        "open" => {
            let Some(Json::Arr(items)) = m.remove("answers") else {
                return Err(bad());
            };
            let mut answers = Vec::with_capacity(items.len());
            for item in items {
                let Json::Arr(pair) = item else {
                    return Err(bad());
                };
                let [Json::Str(k), v] = <[Json; 2]>::try_from(pair).map_err(|_| bad())? else {
                    return Err(bad());
                };
                let v = value_from_json(kind_of(def, &k)?, v)?;
                answers.push((k, v));
            }
            Action::Open { answers }
        }
        "answer" => {
            let field = take(&mut m, "field")?;
            let value = match m.remove("value") {
                None | Some(Json::Null) => None,
                Some(j) => Some(value_from_json(kind_of(def, &field)?, j)?),
            };
            let reason = match m.remove("reason") {
                None | Some(Json::Null) => None,
                Some(Json::Str(r)) => Some(r),
                Some(_) => return Err(bad()),
            };
            Action::Answer {
                field,
                value,
                reason,
            }
        }
        "pick_up" => Action::PickUp {
            job: take(&mut m, "job")?,
        },
        "finish" => Action::Finish {
            job: take(&mut m, "job")?,
        },
        "tick" => {
            let job = take(&mut m, "job")?;
            let (Some(Json::Int(step)), Some(Json::Bool(done))) =
                (m.remove("step"), m.remove("done"))
            else {
                return Err(bad());
            };
            Action::Tick {
                job,
                step: usize::try_from(step).map_err(|_| bad())?,
                done,
            }
        }
        "link_plan" => Action::LinkPlan {
            job: take(&mut m, "job")?,
            design: take(&mut m, "design")?,
            plan: take(&mut m, "plan")?,
        },
        "send_back" => Action::SendBack {
            job: take(&mut m, "job")?,
            reason: take(&mut m, "reason")?,
        },
        "cancel" => Action::Cancel {
            job: take(&mut m, "job")?,
            reason: take(&mut m, "reason")?,
        },
        "approve" => Action::Approve {
            stage: take(&mut m, "stage")?,
        },
        "cancel_order" => Action::CancelOrder {
            reason: take(&mut m, "reason")?,
        },
        _ => return Err(bad()),
    };
    if !m.is_empty() {
        return Err(bad());
    }
    Ok(action)
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

fn type_aad(tenant: &str, id: &str, version: i32, saved_by: &str, epoch: i32) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_ORDER_TYPE);
    crypto::lp(&mut a, tenant.as_bytes());
    crypto::lp(&mut a, id.as_bytes());
    crypto::u32_le(&mut a, version as u32);
    crypto::lp(&mut a, saved_by.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

#[allow(clippy::too_many_arguments)]
fn event_aad(
    tenant: &str,
    order: &str,
    seq: i32,
    at: i64,
    by: Option<&str>,
    word: &str,
    epoch: i32,
) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_ORDER_EVENT);
    crypto::lp(&mut a, tenant.as_bytes());
    crypto::lp(&mut a, order.as_bytes());
    crypto::u32_le(&mut a, seq as u32);
    crypto::u64_le(&mut a, at as u64);
    crypto::lp(&mut a, by.unwrap_or("").as_bytes());
    crypto::lp(&mut a, word.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

struct Sealed {
    ciphertext: Vec<u8>,
    nonce: Vec<u8>,
    epoch: i32,
}

/// Seals `plain` under the organisation content key now, with the AAD `aad(epoch)` gives.
async fn seal(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    plain: &[u8],
    aad: impl Fn(i32) -> Vec<u8>,
) -> Result<Sealed, OrderError> {
    let tenant = auth.ctx.tenant().to_string();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce()?;
    let ciphertext = crypto::seal(&key.key, &nonce, plain, &aad(key.epoch))?;
    keys::count_write_under_org_content_key(tx, &tenant, key.epoch).await?;
    Ok(Sealed {
        ciphertext,
        nonce: nonce.to_vec(),
        epoch: key.epoch,
    })
}

/// Opens rows sealed under the organisation content key, fetching each epoch's key once.
struct Opener<'a> {
    auth: &'a Authority<'a>,
    keys: BTreeMap<i32, crypto::Key32>,
}

impl<'a> Opener<'a> {
    fn new(auth: &'a Authority<'a>) -> Self {
        Opener {
            auth,
            keys: BTreeMap::new(),
        }
    }

    async fn open(
        &mut self,
        tx: &Transaction<'_>,
        epoch: i32,
        nonce: &[u8],
        ciphertext: &[u8],
        aad: &[u8],
        what: &'static str,
    ) -> Result<Json, OrderError> {
        if !self.keys.contains_key(&epoch) {
            let key =
                keys::org_content_key_at_epoch(tx, self.auth.ctx, self.auth.tenant_key, epoch)
                    .await?;
            self.keys.insert(epoch, key);
        }
        let nonce: [u8; crypto::NONCE_LEN] = nonce.try_into().map_err(|_| corrupt(what))?;
        let plain = crypto::open(&self.keys[&epoch], &nonce, ciphertext, aad)
            .map_err(|_| OrderError::Design(DesignError::Refused))?;
        Json::parse_canonical(&plain).map_err(|_| corrupt(what))
    }
}

// ---------------------------------------------------------------------------
// Order types
// ---------------------------------------------------------------------------

/// What a Steward sends to save an order type.
pub struct TypeRequest {
    /// The order type to save a new version of; `None` makes a new one.
    pub id: Option<String>,
    pub source: String,
    /// Shared field set files the definition's `use:` names.
    pub field_sets: Vec<String>,
    /// Slugs matched by hand to team ids. A slug left out matches the standing team with that
    /// slug, if there is one.
    pub teams: BTreeMap<String, String>,
}

/// One saved version of an order type, opened.
pub struct OrderType {
    pub id: String,
    pub version: i32,
    pub saved_by: String,
    pub saved_at: i64,
    pub source: String,
    pub field_sets: Vec<String>,
    /// Slug to team id, as matched when it was saved.
    pub teams: BTreeMap<String, String>,
    /// The definition as installed: team ids, not slugs.
    pub definition: Definition,
}

/// Read and check a definition with its sets, the way it is read every time it is loaded.
fn read_type(source: &str, sets: &[String]) -> Result<Definition, Vec<Problem>> {
    let mut problems = Vec::new();
    let mut library: Vec<FieldSet> = Vec::new();
    for set in sets {
        match fathom_orders::read_field_set(set) {
            Ok(s) => library.push(s),
            Err(ps) => problems.extend(ps.into_iter().map(|p| Problem {
                line: p.line,
                message: format!("in a shared field set: {}", p.message),
            })),
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let def = fathom_orders::read_definition(source, &library)?;
    check_definition_texts(&def, &mut problems);
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(def)
}

/// Save an order type, or a new version of one. A Steward's act (ADR-0084 decision 1).
pub async fn save_type(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    req: TypeRequest,
) -> Result<OrderType, OrderError> {
    let people = teams::order_people(tx, auth, &BTreeSet::new()).await?;
    if !people.steward {
        return Err(AuthorityError::NotAuthorised.into());
    }
    if req.source.len() > MAX_SOURCE_BYTES
        || req.field_sets.len() > MAX_FIELD_SETS
        || req.field_sets.iter().any(|s| s.len() > MAX_SOURCE_BYTES)
    {
        return Err(OrderError::Malformed("an order type is too large"));
    }
    let def = read_type(&req.source, &req.field_sets).map_err(OrderError::Problems)?;

    // Decision 8: every slug matched to a team that stands now.
    let by_slug: BTreeMap<&str, &str> = people
        .live
        .iter()
        .map(|(id, slug)| (slug.as_str(), id.as_str()))
        .collect();
    let mut matched = BTreeMap::new();
    let mut missing = Vec::new();
    for slug in def.team_slugs() {
        match req.teams.get(slug) {
            Some(id) if people.live.contains_key(id) => {
                matched.insert(slug.to_string(), id.clone());
            }
            Some(_) => missing.push(slug.to_string()),
            None => match by_slug.get(slug) {
                Some(id) => {
                    matched.insert(slug.to_string(), (*id).to_string());
                }
                None => missing.push(slug.to_string()),
            },
        }
    }
    if !missing.is_empty() {
        return Err(OrderError::Unmatched(missing));
    }
    let installed = def.installed(&matched).map_err(OrderError::Unmatched)?;

    let tenant = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended('fathom order types|' || $1, 0))",
        &[&tenant],
    )
    .await?;
    let (id, version) = match req.id {
        Some(id) => {
            let top: Option<i32> = tx
                .query_one(
                    "SELECT max(version) FROM order_types WHERE organisation_id = $1 AND id = $2",
                    &[&tenant, &id],
                )
                .await?
                .get(0);
            let top = top.ok_or(OrderError::NotFound)?;
            (id, top + 1)
        }
        None => {
            let count: i64 = tx
                .query_one(
                    "SELECT count(DISTINCT id) FROM order_types WHERE organisation_id = $1",
                    &[&tenant],
                )
                .await?
                .get(0);
            if count >= MAX_ORDER_TYPES {
                return Err(OrderError::Limit(
                    "this organisation has as many order types as it may",
                ));
            }
            (crate::ids::new_ulid().to_string(), 1)
        }
    };

    let body = obj(vec![
        ("source", Json::Str(req.source.clone())),
        (
            "field_sets",
            Json::Arr(req.field_sets.iter().cloned().map(Json::Str).collect()),
        ),
        (
            "teams",
            Json::Obj(
                matched
                    .iter()
                    .map(|(k, v)| (k.clone(), Json::Str(v.clone())))
                    .collect(),
            ),
        ),
    ]);
    let sealed = seal(tx, auth, &body.to_canonical_bytes(), |epoch| {
        type_aad(&tenant, &id, version, &actor, epoch)
    })
    .await?;
    let at = now_unix();
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::OrderTypeSaved,
        &entry_metadata(
            EntryType::OrderTypeSaved,
            &[
                ("definition", Json::Str(id.clone())),
                ("version", Json::Int(i64::from(version))),
                ("actor", Json::Str(actor.clone())),
                ("at", Json::Int(at)),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO order_types \
         (organisation_id, id, version, saved_by, saved_at, chain_seq, key_epoch, ciphertext, \
          nonce) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            &tenant,
            &id,
            &version,
            &actor,
            &at,
            &appended.seq,
            &sealed.epoch,
            &sealed.ciphertext,
            &sealed.nonce,
        ],
    )
    .await?;
    Ok(OrderType {
        id,
        version,
        saved_by: actor,
        saved_at: at,
        source: req.source,
        field_sets: req.field_sets,
        teams: matched,
        definition: installed,
    })
}

const TYPE_COLUMNS: &str = "id, version, saved_by, saved_at, key_epoch, nonce, ciphertext";

async fn open_type(
    tx: &Transaction<'_>,
    opener: &mut Opener<'_>,
    row: &tokio_postgres::Row,
) -> Result<OrderType, OrderError> {
    let tenant = opener.auth.ctx.tenant().to_string();
    let id: String = row.get(0);
    let version: i32 = row.get(1);
    let saved_by: String = row.get(2);
    let epoch: i32 = row.get(4);
    let body = opener
        .open(
            tx,
            epoch,
            &row.get::<_, Vec<u8>>(5),
            &row.get::<_, Vec<u8>>(6),
            &type_aad(&tenant, &id, version, &saved_by, epoch),
            "order type",
        )
        .await?;
    let Json::Obj(mut m) = body else {
        return Err(corrupt("order type"));
    };
    let (Some(Json::Str(source)), Some(Json::Arr(sets)), Some(Json::Obj(teams))) = (
        m.remove("source"),
        m.remove("field_sets"),
        m.remove("teams"),
    ) else {
        return Err(corrupt("order type"));
    };
    let field_sets = sets
        .into_iter()
        .map(|s| match s {
            Json::Str(s) => Ok(s),
            _ => Err(corrupt("order type")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let teams = teams
        .into_iter()
        .map(|(k, v)| match v {
            Json::Str(v) => Ok((k, v)),
            _ => Err(corrupt("order type")),
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let definition = read_type(&source, &field_sets)
        .ok()
        .and_then(|d| d.installed(&teams).ok())
        .ok_or_else(|| corrupt("order type no longer reads"))?;
    Ok(OrderType {
        id,
        version,
        saved_by,
        saved_at: row.get(3),
        source,
        field_sets,
        teams,
        definition,
    })
}

/// One version of an order type; the latest when `version` is `None`. Any member may read.
pub async fn get_type(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    version: Option<i32>,
) -> Result<OrderType, OrderError> {
    let tenant = auth.ctx.tenant().to_string();
    let row = match version {
        Some(v) => {
            tx.query_opt(
                &format!(
                    "SELECT {TYPE_COLUMNS} FROM order_types \
                     WHERE organisation_id = $1 AND id = $2 AND version = $3"
                ),
                &[&tenant, &id, &v],
            )
            .await?
        }
        None => {
            tx.query_opt(
                &format!(
                    "SELECT {TYPE_COLUMNS} FROM order_types \
                     WHERE organisation_id = $1 AND id = $2 ORDER BY version DESC LIMIT 1"
                ),
                &[&tenant, &id],
            )
            .await?
        }
    }
    .ok_or(OrderError::NotFound)?;
    open_type(tx, &mut Opener::new(auth), &row).await
}

/// The latest version of every order type, by name. Any member may read.
pub async fn list_types(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<Vec<OrderType>, OrderError> {
    let rows = tx
        .query(
            &format!(
                "SELECT DISTINCT ON (id) {TYPE_COLUMNS} FROM order_types \
                 WHERE organisation_id = $1 ORDER BY id, version DESC"
            ),
            &[&auth.ctx.tenant().to_string()],
        )
        .await?;
    let mut opener = Opener::new(auth);
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(open_type(tx, &mut opener, row).await?);
    }
    out.sort_by(|a, b| {
        (a.definition.name.as_str(), a.id.as_str()).cmp(&(b.definition.name.as_str(), &b.id))
    });
    Ok(out)
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/// An order as it stands, with what it was opened from.
pub struct OrderView {
    pub id: String,
    pub number: i64,
    pub type_id: String,
    pub type_version: i32,
    pub opened_at: i64,
    pub order: Order,
}

fn status_word(s: OrderStatus) -> &'static str {
    match s {
        OrderStatus::Open => "open",
        OrderStatus::Done => "done",
        OrderStatus::Cancelled => "cancelled",
    }
}

/// The next W- number in the organisation, in the shared `work_numbers` counter so an order and
/// a plan never share one (r74).
async fn give_number(tx: &Transaction<'_>, tenant: &str, order: &str) -> Result<i64, OrderError> {
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended('fathom work numbers|' || $1, 0))",
        &[&tenant],
    )
    .await?;
    let number: i64 = tx
        .query_one(
            "SELECT coalesce(max(number), 0) + 1 FROM work_numbers WHERE organisation_id = $1",
            &[&tenant],
        )
        .await?
        .get(0);
    tx.execute(
        "INSERT INTO work_numbers (organisation_id, design_id, element_id, number) \
         VALUES ($1, $2, $3, $4)",
        &[&tenant, &NUMBERS_DESIGN, &order, &number],
    )
    .await?;
    Ok(number)
}

/// Seal and store one event, filed on the organisation chain.
async fn store_event(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    order: &str,
    seq: i32,
    event: &Event,
) -> Result<(), OrderError> {
    let tenant = auth.ctx.tenant().to_string();
    let at = i64::try_from(event.at).map_err(|_| OrderError::Malformed("a time"))?;
    let by = match &event.by {
        Actor::Person(p) => Some(p.as_str()),
        Actor::Engine => None,
    };
    let word = action_word(&event.action);
    let body = action_to_json(&event.action).to_canonical_bytes();
    let sealed = seal(tx, auth, &body, |epoch| {
        event_aad(&tenant, order, seq, at, by, word, epoch)
    })
    .await?;
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::OrderEvent,
        &entry_metadata(
            EntryType::OrderEvent,
            &[
                ("order", Json::Str(order.to_string())),
                ("seq", Json::Int(i64::from(seq))),
                ("action", Json::Str(word.to_string())),
                ("actor", by.map_or(Json::Null, |b| Json::Str(b.to_string()))),
                ("at", Json::Int(at)),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO order_events \
         (organisation_id, order_id, seq, at, by_account, action, chain_seq, key_epoch, \
          ciphertext, nonce) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        &[
            &tenant,
            &order,
            &seq,
            &at,
            &by,
            &word,
            &appended.seq,
            &sealed.epoch,
            &sealed.ciphertext,
            &sealed.nonce,
        ],
    )
    .await?;
    Ok(())
}

/// Open an order from the latest version of an order type. Any member of the organisation may
/// open one; the engine checks the answers. `answers` arrive as JSON keyed by field and are put
/// in the definition's order.
pub async fn open_order(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    type_id: &str,
    mut answers: BTreeMap<String, Json>,
) -> Result<OrderView, OrderError> {
    let ty = get_type(tx, auth, type_id, None).await?;
    let def = ty.definition;
    let mut pairs = Vec::new();
    for f in &def.fields {
        if let Some(j) = answers.remove(&f.key) {
            if j != Json::Null {
                pairs.push((f.key.clone(), value_from_json(f.kind, j)?));
            }
        }
    }
    if let Some(k) = answers.keys().next() {
        return Err(OrderError::Refused(format!(
            "this order has no field `{k}`"
        )));
    }
    let action = Action::Open { answers: pairs };
    check_action(&action)?;
    let Action::Open { answers } = action else {
        unreachable!("built above")
    };
    let actor = auth.ctx.actor().to_string();
    let at = now_unix();
    let order = Order::open(def, &actor, at.max(0) as u64, answers)
        .map_err(|r| OrderError::Refused(r.0))?;

    let tenant = auth.ctx.tenant().to_string();
    let id = crate::ids::new_ulid().to_string();
    let number = give_number(tx, &tenant, &id).await?;
    tx.execute(
        "INSERT INTO orders \
         (organisation_id, id, number, type_id, type_version, opened_by, opened_at, status, \
          updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)",
        &[
            &tenant,
            &id,
            &number,
            &ty.id,
            &ty.version,
            &actor,
            &at,
            &status_word(order.status()),
        ],
    )
    .await?;
    store_event(tx, auth, &id, 1, &order.events()[0]).await?;
    Ok(OrderView {
        id,
        number,
        type_id: ty.id,
        type_version: ty.version,
        opened_at: at,
        order,
    })
}

/// Load an order and replay its history. `lock` takes the order's row for an act.
async fn load(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    lock: bool,
) -> Result<OrderView, OrderError> {
    let tenant = auth.ctx.tenant().to_string();
    let row = tx
        .query_opt(
            &format!(
                "SELECT number, type_id, type_version, opened_at FROM orders \
                 WHERE organisation_id = $1 AND id = $2{}",
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&tenant, &id],
        )
        .await?
        .ok_or(OrderError::NotFound)?;
    let type_id: String = row.get(1);
    let type_version: i32 = row.get(2);
    let ty = get_type(tx, auth, &type_id, Some(type_version)).await?;
    let rows = tx
        .query(
            "SELECT seq, at, by_account, action, key_epoch, nonce, ciphertext FROM order_events \
             WHERE organisation_id = $1 AND order_id = $2 ORDER BY seq",
            &[&tenant, &id],
        )
        .await?;
    let mut opener = Opener::new(auth);
    let mut events = Vec::with_capacity(rows.len());
    for (i, r) in rows.iter().enumerate() {
        let seq: i32 = r.get(0);
        if seq as usize != i + 1 {
            return Err(corrupt("order history has a gap"));
        }
        let at: i64 = r.get(1);
        let by: Option<String> = r.get(2);
        let word: String = r.get(3);
        let epoch: i32 = r.get(4);
        let body = opener
            .open(
                tx,
                epoch,
                &r.get::<_, Vec<u8>>(5),
                &r.get::<_, Vec<u8>>(6),
                &event_aad(&tenant, id, seq, at, by.as_deref(), &word, epoch),
                "order event",
            )
            .await?;
        let Json::Obj(m) = body else {
            return Err(corrupt("order event"));
        };
        let action =
            action_from_json(&ty.definition, &word, m).map_err(|_| corrupt("order event"))?;
        events.push(Event {
            at: u64::try_from(at).map_err(|_| corrupt("order event"))?,
            by: by.map_or(Actor::Engine, Actor::Person),
            action,
        });
    }
    let order = Order::replay(ty.definition, &events)
        .map_err(|_| corrupt("order history no longer replays"))?;
    Ok(OrderView {
        id: id.to_string(),
        number: row.get(0),
        type_id,
        type_version,
        opened_at: row.get(3),
        order,
    })
}

/// An order as it stands. Any member may read.
pub async fn get_order(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
) -> Result<OrderView, OrderError> {
    load(tx, auth, id, false).await
}

/// Take one action on an order, as the caller. The engine decides; a refusal changes nothing.
pub async fn act(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    word: &str,
    body: BTreeMap<String, Json>,
) -> Result<OrderView, OrderError> {
    if word == "open" {
        return Err(OrderError::Malformed("an order action"));
    }
    let mut view = load(tx, auth, id, true).await?;
    if view.order.events().len() as i64 >= MAX_EVENTS {
        return Err(OrderError::Limit("this order has as many events as it may"));
    }
    let action = action_from_json(view.order.definition(), word, body)?;
    check_action(&action)?;
    let people = teams::order_people(tx, auth, &teams_of(view.order.definition())).await?;
    let actor = auth.ctx.actor().to_string();
    let last = view.order.events().last().map_or(0, |e| e.at);
    let event = Event {
        at: (now_unix().max(0) as u64).max(last),
        by: Actor::Person(actor.clone()),
        action,
    };
    let standing = Standing {
        account: &actor,
        people: &people,
    };
    view.order
        .apply(event, &standing)
        .map_err(|r| OrderError::Refused(r.0))?;
    let seq = i32::try_from(view.order.events().len()).map_err(|_| corrupt("order history"))?;
    let stored = view.order.events().last().cloned().expect("just applied");
    store_event(tx, auth, id, seq, &stored).await?;
    tx.execute(
        "UPDATE orders SET status = $3, updated_at = $4 \
         WHERE organisation_id = $1 AND id = $2 AND status = 'open'",
        &[
            &auth.ctx.tenant().to_string(),
            &id,
            &status_word(view.order.status()),
            &(stored.at as i64),
        ],
    )
    .await?;
    Ok(view)
}

/// One line of the list of orders: nothing sealed is opened for it.
pub struct OrderLine {
    pub id: String,
    pub number: i64,
    pub type_id: String,
    pub type_version: i32,
    pub opened_by: String,
    pub opened_at: i64,
    pub status: String,
    pub updated_at: i64,
}

/// Orders, newest number first: open ones, or finished ones with `done`. At most `limit`.
pub async fn list_orders(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    done: bool,
    limit: i64,
) -> Result<Vec<OrderLine>, OrderError> {
    let rows = tx
        .query(
            "SELECT id, number, type_id, type_version, opened_by, opened_at, status, updated_at \
             FROM orders WHERE organisation_id = $1 AND (status = 'open') <> $2 \
             ORDER BY number DESC LIMIT $3",
            &[&auth.ctx.tenant().to_string(), &done, &limit.clamp(1, 500)],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| OrderLine {
            id: r.get(0),
            number: r.get(1),
            type_id: r.get(2),
            type_version: r.get(3),
            opened_by: r.get(4),
            opened_at: r.get(5),
            status: r.get(6),
            updated_at: r.get(7),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// The order as JSON
// ---------------------------------------------------------------------------

fn job_status_word(s: JobStatus) -> &'static str {
    match s {
        JobStatus::NotStarted => "not_started",
        JobStatus::LeftOut => "left_out",
        JobStatus::Waiting => "waiting",
        JobStatus::Ready => "ready",
        JobStatus::Done => "done",
        JobStatus::Cancelled => "cancelled",
    }
}

fn stage_status_word(s: StageStatus) -> &'static str {
    match s {
        StageStatus::NotStarted => "not_started",
        StageStatus::Running => "running",
        StageStatus::AwaitingSignOff => "awaiting_sign_off",
        StageStatus::Done => "done",
    }
}

fn actor_json(a: &Actor) -> Json {
    match a {
        Actor::Person(p) => Json::Str(p.clone()),
        Actor::Engine => Json::Str("engine".into()),
    }
}

fn opt_int(v: Option<u64>) -> Json {
    v.map_or(Json::Null, |n| Json::Int(n as i64))
}

impl OrderView {
    pub fn to_json(&self) -> Json {
        let o = &self.order;
        let def = o.definition();
        let answers = Json::Obj(
            def.fields
                .iter()
                .filter_map(|f| o.answer(&f.key).map(|v| (f.key.clone(), value_to_json(v))))
                .collect(),
        );
        let lanes = def
            .lanes
            .iter()
            .map(|lane| {
                let stages = lane
                    .stages
                    .iter()
                    .map(|stage| {
                        let st = o.stage(&stage.id);
                        let jobs = stage
                            .jobs
                            .iter()
                            .map(|job| {
                                let Some(js) = o.job(&job.id) else {
                                    return Json::Null;
                                };
                                obj(vec![
                                    ("id", Json::Str(job.id.clone())),
                                    ("name", Json::Str(job.name.clone())),
                                    ("team", Json::Str(job.team.clone())),
                                    ("status", Json::Str(job_status_word(js.status).into())),
                                    ("picked_by", opt_str(&js.picked_by)),
                                    (
                                        "steps",
                                        Json::Arr(
                                            job.steps.iter().cloned().map(Json::Str).collect(),
                                        ),
                                    ),
                                    (
                                        "ticks",
                                        Json::Arr(
                                            js.ticks.iter().map(|t| Json::Int(*t as i64)).collect(),
                                        ),
                                    ),
                                    (
                                        "asks",
                                        Json::Arr(
                                            job.asks.iter().cloned().map(Json::Str).collect(),
                                        ),
                                    ),
                                    ("ready_at", opt_int(js.ready_at)),
                                    ("finished_at", opt_int(js.finished_at)),
                                    (
                                        "finished_by",
                                        js.finished_by.as_ref().map_or(Json::Null, actor_json),
                                    ),
                                    ("note", opt_str(&js.note)),
                                    (
                                        "plan",
                                        js.plan.as_ref().map_or(Json::Null, |(d, p)| {
                                            obj(vec![
                                                ("design", Json::Str(d.clone())),
                                                ("plan", Json::Str(p.clone())),
                                            ])
                                        }),
                                    ),
                                ])
                            })
                            .collect();
                        obj(vec![
                            ("id", Json::Str(stage.id.clone())),
                            ("name", Json::Str(stage.name.clone())),
                            ("approval", opt_str(&stage.approval)),
                            (
                                "status",
                                Json::Str(
                                    st.map_or("not_started", |s| stage_status_word(s.status))
                                        .into(),
                                ),
                            ),
                            (
                                "approved_by",
                                st.map_or(Json::Null, |s| opt_str(&s.approved_by)),
                            ),
                            ("jobs", Json::Arr(jobs)),
                        ])
                    })
                    .collect();
                obj(vec![
                    ("id", Json::Str(lane.id.clone())),
                    ("name", Json::Str(lane.name.clone())),
                    ("stages", Json::Arr(stages)),
                ])
            })
            .collect();
        let holds = o
            .holds()
            .into_iter()
            .map(|h| {
                obj(vec![
                    ("job", Json::Str(h.job)),
                    ("field", Json::Str(h.field)),
                    ("design", Json::Str(h.what.design)),
                    ("device", Json::Str(h.what.device)),
                    ("port", opt_str(&h.what.port)),
                ])
            })
            .collect();
        let history = o
            .events()
            .iter()
            .enumerate()
            .map(|(i, e)| {
                obj(vec![
                    ("seq", Json::Int(i as i64 + 1)),
                    ("at", Json::Int(e.at as i64)),
                    ("by", actor_json(&e.by)),
                    ("action", Json::Str(action_word(&e.action).into())),
                    ("detail", action_to_json(&e.action)),
                ])
            })
            .collect();
        obj(vec![
            ("id", Json::Str(self.id.clone())),
            ("number", Json::Int(self.number)),
            ("type", Json::Str(self.type_id.clone())),
            ("type_version", Json::Int(i64::from(self.type_version))),
            ("name", Json::Str(def.name.clone())),
            ("code", opt_str(&def.number)),
            ("status", Json::Str(status_word(o.status()).into())),
            ("opened_by", Json::Str(o.opened_by().to_string())),
            ("opened_at", Json::Int(self.opened_at)),
            ("answers", answers),
            ("lanes", Json::Arr(lanes)),
            ("holds", Json::Arr(holds)),
            ("history", Json::Arr(history)),
        ])
    }
}

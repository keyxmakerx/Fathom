//! Live co-editing: the hub, the stream, presence and the limits (ADR-0063).
//!
//! The routes live in `design_api.rs`; this is what they share. A stream is a
//! task that owns the write half of an in-memory pipe whose read half is the
//! response body. It wakes on a version signal (from this process after a
//! commit, or from `NOTIFY` through the one listener), an authority signal, or
//! a timer, and before every delivery it opens a short transaction that
//! re-checks the session, the membership and, if the organisation's authority
//! head moved, the grant. Failing any of them ends the stream before a frame
//! is written.
//!
//! Presence is held per process. Changes cross processes through `NOTIFY`;
//! presence does not (a deviation from ADR-0063 #1, noted in the report).

use std::collections::{BTreeMap, BTreeSet};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::authority::Capability;
use crate::design_api::DesignApiState;
use crate::designs::{self, LiveBatch};
use crate::grants::{self, Authority};
use crate::heads::HeadStore;
use crate::repo::{DesignId, OrganisationId, ScopeId};
use crate::sessions::{self, VerifiedSession};

pub const FRAME_CHANGE: u8 = 1;
pub const FRAME_RELOAD: u8 = 2;
pub const FRAME_PRESENCE: u8 = 3;
pub const FRAME_HEARTBEAT: u8 = 4;
pub const FRAME_RESYNC: u8 = 5;
pub const FRAME_AUTHOR: u8 = 6;

/// ADR-0063 #13 and #14.
pub const HEARTBEAT: Duration = Duration::from_secs(25);
pub const RECHECK: Duration = Duration::from_secs(15);
pub const STREAM_LIFE: Duration = Duration::from_secs(10 * 60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const PAGE: i64 = 64;

pub const STREAMS_PER_ACCOUNT_PER_DESIGN: usize = 2;
pub const STREAMS_PER_ACCOUNT: usize = 8;
pub const STREAMS_PER_DESIGN: usize = 50;
pub const CHANGES_PER_SECOND: f64 = 20.0;
pub const CHANGE_BURST: f64 = 30.0;
pub const PRESENCE_PER_SECOND: f64 = 2.0;
pub const PRESENCE_BURST: f64 = 2.0;
/// A presence post is at most this many bytes.
pub const PRESENCE_BODY_MAX: usize = 256;

/// Workers and bytes for the head store when nothing says otherwise.
pub const DEFAULT_HEAD_THREADS: usize = 4;
pub const DEFAULT_HEAD_BYTES: usize = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

/// What wakes a stream.
#[derive(Default)]
struct Signal {
    wake: Notify,
    /// Authority may have moved: recheck the grant before the next delivery.
    authority: AtomicBool,
    /// Who is in this stream's view may have changed.
    presence: AtomicBool,
    /// A newer stream from the same session on the same design took this
    /// one's place: end without writing more.
    replaced: AtomicBool,
}

impl Signal {
    fn poke(&self) {
        self.wake.notify_one();
    }
}

struct Entry {
    design: String,
    org: String,
    session: String,
    account: String,
    /// The account's display name, read when the stream opened.
    name: String,
    signal: Arc<Signal>,
}

/// Where a person is: their view, and the element they have selected.
struct Person {
    view: &'static str,
    selected: Option<String>,
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn take(&mut self, rate: f64, burst: f64) -> bool {
        let now = Instant::now();
        let gained = now.duration_since(self.at).as_secs_f64() * rate;
        self.tokens = (self.tokens + gained).min(burst);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
struct Inner {
    next: u64,
    streams: BTreeMap<u64, Entry>,
    by_design: BTreeMap<String, BTreeSet<u64>>,
    /// design -> account -> person present there.
    people: BTreeMap<String, BTreeMap<String, Person>>,
    change_rate: BTreeMap<String, Bucket>,
    presence_rate: BTreeMap<(String, String), Bucket>,
}

/// Why a stream was not admitted.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Account,
    AccountDesign,
    Design,
}

pub struct Registered {
    pub id: u64,
    signal: Arc<Signal>,
}

#[derive(Default)]
pub struct Hub {
    inner: Mutex<Inner>,
}

/// A bucket map this large is swept of buckets that have refilled.
const BUCKET_SWEEP: usize = 4096;

impl Hub {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // Nothing here panics while holding the lock.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn admit(
        &self,
        design: &str,
        org: &str,
        session: &str,
        account: &str,
        name: &str,
    ) -> Result<Registered, Refusal> {
        let mut h = self.lock();
        // A reconnect whose predecessor the server still holds (a connection
        // that died without closing: sleep, a network change, a proxy) would
        // otherwise be refused until that stream's writes fail, minutes later.
        // At a limit, the session's own oldest stream on this design makes way.
        let at_limit = {
            let on_design = h.by_design.get(design).map_or(0, BTreeSet::len);
            let mine = h.streams.values().filter(|e| e.account == account);
            let (total, here) = mine.fold((0, 0), |(t, d), e| {
                (t + 1, d + usize::from(e.design == design))
            });
            on_design >= STREAMS_PER_DESIGN
                || total >= STREAMS_PER_ACCOUNT
                || here >= STREAMS_PER_ACCOUNT_PER_DESIGN
        };
        if at_limit {
            let oldest = h
                .streams
                .iter()
                .find(|(_, e)| e.design == design && e.session == session)
                .map(|(id, _)| *id);
            if let Some(old) = oldest {
                if let Some(e) = h.streams.remove(&old) {
                    e.signal.replaced.store(true, Ordering::SeqCst);
                    e.signal.poke();
                }
                if let Some(set) = h.by_design.get_mut(design) {
                    set.remove(&old);
                }
            }
        }
        let on_design = h.by_design.get(design).map_or(0, BTreeSet::len);
        if on_design >= STREAMS_PER_DESIGN {
            return Err(Refusal::Design);
        }
        let mine = h
            .streams
            .values()
            .filter(|e| e.account == account)
            .collect::<Vec<_>>();
        if mine.len() >= STREAMS_PER_ACCOUNT {
            return Err(Refusal::Account);
        }
        if mine.iter().filter(|e| e.design == design).count() >= STREAMS_PER_ACCOUNT_PER_DESIGN {
            return Err(Refusal::AccountDesign);
        }
        h.next += 1;
        let id = h.next;
        let signal = Arc::new(Signal::default());
        signal.presence.store(true, Ordering::SeqCst);
        h.streams.insert(
            id,
            Entry {
                design: design.to_owned(),
                org: org.to_owned(),
                session: session.to_owned(),
                account: account.to_owned(),
                name: name.to_owned(),
                signal: signal.clone(),
            },
        );
        h.by_design.entry(design.to_owned()).or_default().insert(id);
        Ok(Registered { id, signal })
    }

    /// Remove a stream. True if it was the last on its design.
    fn leave(&self, id: u64) -> bool {
        let mut h = self.lock();
        let Some(entry) = h.streams.remove(&id) else {
            return false;
        };
        let mut last = false;
        if let Some(set) = h.by_design.get_mut(&entry.design) {
            set.remove(&id);
            last = set.is_empty();
        }
        if last {
            h.by_design.remove(&entry.design);
            h.people.remove(&entry.design);
        } else {
            let still_here = h
                .streams
                .values()
                .any(|e| e.design == entry.design && e.account == entry.account);
            if !still_here {
                if let Some(people) = h.people.get_mut(&entry.design) {
                    people.remove(&entry.account);
                }
                Self::poke_presence(&h, &entry.design);
            }
        }
        last
    }

    fn poke_presence(h: &Inner, design: &str) {
        if let Some(ids) = h.by_design.get(design) {
            for id in ids {
                if let Some(e) = h.streams.get(id) {
                    e.signal.presence.store(true, Ordering::SeqCst);
                    e.signal.poke();
                }
            }
        }
    }

    /// A change or whole save committed on `design`.
    pub fn wake_design(&self, design: &str) {
        let h = self.lock();
        if let Some(ids) = h.by_design.get(design) {
            for id in ids {
                if let Some(e) = h.streams.get(id) {
                    e.signal.poke();
                }
            }
        }
    }

    /// Authority moved for `scope` (`org`, `session` or `account`) `id`.
    fn wake_authority(&self, scope: &str, id: &str) {
        let h = self.lock();
        for e in h.streams.values() {
            let hit = match scope {
                "org" => e.org == id,
                "session" => e.session == id,
                "account" => e.account == id,
                _ => true,
            };
            if hit {
                e.signal.authority.store(true, Ordering::SeqCst);
                e.signal.poke();
            }
        }
    }

    /// Notifications may have been lost: every stream rechecks and reads.
    fn wake_all(&self) {
        let h = self.lock();
        for e in h.streams.values() {
            e.signal.authority.store(true, Ordering::SeqCst);
            e.signal.poke();
        }
    }

    fn dispatch(&self, channel: &str, payload: &str) {
        match channel {
            "fathom_live" => {
                if let Some((design, _)) = payload.split_once(':') {
                    self.wake_design(design);
                }
            }
            "fathom_authority" => match payload.split_once(':') {
                Some((scope, id)) => self.wake_authority(scope, id),
                None => self.wake_all(),
            },
            _ => {}
        }
    }

    /// One more change from `account` against the rate limit.
    pub fn allow_change(&self, account: &str) -> bool {
        let mut h = self.lock();
        if h.change_rate.len() > BUCKET_SWEEP {
            let now = Instant::now();
            h.change_rate
                .retain(|_, b| now.duration_since(b.at) < Duration::from_secs(5));
        }
        h.change_rate
            .entry(account.to_owned())
            .or_insert(Bucket {
                tokens: CHANGE_BURST,
                at: Instant::now(),
            })
            .take(CHANGES_PER_SECOND, CHANGE_BURST)
    }

    pub fn allow_presence(&self, account: &str, design: &str) -> bool {
        let mut h = self.lock();
        if h.presence_rate.len() > BUCKET_SWEEP {
            let now = Instant::now();
            h.presence_rate
                .retain(|_, b| now.duration_since(b.at) < Duration::from_secs(5));
        }
        h.presence_rate
            .entry((account.to_owned(), design.to_owned()))
            .or_insert(Bucket {
                tokens: PRESENCE_BURST,
                at: Instant::now(),
            })
            .take(PRESENCE_PER_SECOND, PRESENCE_BURST)
    }

    /// Record where `account` is. Held only while the account has a stream on
    /// the design in this process; false (and nothing kept) otherwise.
    pub fn set_presence(
        &self,
        design: &str,
        account: &str,
        view: &'static str,
        selected: Option<String>,
    ) -> bool {
        let mut h = self.lock();
        let here = h
            .streams
            .values()
            .any(|e| e.design == design && e.account == account);
        if !here {
            return false;
        }
        h.people
            .entry(design.to_owned())
            .or_default()
            .insert(account.to_owned(), Person { view, selected });
        Self::poke_presence(&h, design);
        true
    }

    /// The presence frame's JSON for `account`: itself, and the others in the
    /// same view (none until it has said which view it is in).
    fn presence_json(&self, design: &str, account: &str) -> String {
        let h = self.lock();
        let name_of = |who: &str| -> String {
            h.streams
                .values()
                .find(|e| e.design == design && e.account == who)
                .map(|e| e.name.clone())
                .unwrap_or_default()
        };
        let mut out = format!(
            "{{\"self\":{},\"others\":[",
            person_json(account, &name_of(account), None)
        );
        if let Some(people) = h.people.get(design) {
            if let Some(me) = people.get(account) {
                let mut first = true;
                for (other, p) in people {
                    if other == account || p.view != me.view {
                        continue;
                    }
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    out.push_str(&person_json(
                        other,
                        &name_of(other),
                        Some(p.selected.as_deref()),
                    ));
                }
            }
        }
        out.push_str("]}");
        out
    }

    #[cfg(test)]
    fn stream_count(&self) -> usize {
        self.lock().streams.len()
    }
}

/// `{"account","initials","name"}`, plus `"selected"` when given (`Some(None)`
/// is an explicit null). Every string is escaped.
fn person_json(account: &str, name: &str, selected: Option<Option<&str>>) -> String {
    let mut out = format!(
        "{{\"account\":\"{}\",\"initials\":\"{}\",\"name\":\"{}\"",
        json_text(account),
        json_text(&initials_of(name)),
        json_text(name)
    );
    if let Some(sel) = selected {
        match sel {
            Some(id) => out.push_str(&format!(",\"selected\":\"{}\"", json_text(id))),
            None => out.push_str(",\"selected\":null"),
        }
    }
    out.push('}');
    out
}

/// A presence post: `{"view": "canvas" | "inventory", "selected": <element id> | null}`.
/// Whitespace and key order are free; nothing else is: no other keys, no
/// escapes, no repeats, at most [`PRESENCE_BODY_MAX`] bytes, and an element id
/// is a well-formed id. `None` for anything else.
pub fn parse_presence(body: &[u8]) -> Option<(&'static str, Option<String>)> {
    if body.len() > PRESENCE_BODY_MAX {
        return None;
    }
    let text = core::str::from_utf8(body).ok()?;
    let mut at = text.trim_start();
    at = at.strip_prefix('{')?.trim_start();
    let mut view: Option<&'static str> = None;
    let mut selected: Option<Option<String>> = None;
    loop {
        let rest = at.strip_prefix('"')?;
        let (key, rest) = rest.split_once('"')?;
        let rest = rest.trim_start().strip_prefix(':')?.trim_start();
        let (value, rest) = if let Some(r) = rest.strip_prefix("null") {
            (None, r)
        } else {
            let r = rest.strip_prefix('"')?;
            let (v, r) = r.split_once('"')?;
            // No escapes and nothing but printable ASCII in a value.
            if !v.bytes().all(|b| (0x20..0x7f).contains(&b) && b != b'\\') {
                return None;
            }
            (Some(v), r)
        };
        match (key, value) {
            ("view", Some("canvas")) if view.is_none() => view = Some("canvas"),
            ("view", Some("inventory")) if view.is_none() => view = Some("inventory"),
            ("selected", v) if selected.is_none() => {
                // `<kebab-kind>:<ulid>`, a declared kind and a canonical ulid.
                if let Some(id) = v {
                    fathom_graph::ElementId::parse(id).ok()?;
                }
                selected = Some(v.map(str::to_owned));
            }
            _ => return None,
        }
        let rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix(',') {
            at = r.trim_start();
        } else {
            let r = rest.strip_prefix('}')?;
            if !r.trim().is_empty() {
                return None;
            }
            return Some((view?, selected?));
        }
    }
}

fn json_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Two letters from a display name: the first letters of its first two words,
/// or the first two letters of a single word.
pub fn initials_of(display_name: &str) -> String {
    let words: Vec<&str> = display_name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let letters: String = match words.as_slice() {
        [] => return "-".to_owned(),
        [one] => one.chars().take(2).collect(),
        [a, b, ..] => a.chars().take(1).chain(b.chars().take(1)).collect(),
    };
    letters.to_uppercase()
}

// ---------------------------------------------------------------------------
// The live state a route set carries
// ---------------------------------------------------------------------------

pub struct Live {
    pub heads: HeadStore,
    pub hub: Hub,
}

impl Live {
    pub fn new(threads: usize, head_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            heads: HeadStore::new(threads, head_bytes),
            hub: Hub::default(),
        })
    }

    /// Hold `LISTEN` on its own connection, draining it as it goes, and
    /// reconnect with a pause when it drops. After every (re)connect all
    /// streams recheck, since notifications are lost while disconnected.
    pub fn listen(self: &Arc<Self>, config: tokio_postgres::Config) {
        let live = self.clone();
        tokio::spawn(async move {
            let mut pause = Duration::from_millis(250);
            loop {
                match listen_once(&live, &config).await {
                    Ok(()) => pause = Duration::from_millis(250),
                    Err(why) => tracing::warn!(%why, "the live listener dropped; reconnecting"),
                }
                tokio::time::sleep(pause).await;
                pause = (pause * 2).min(Duration::from_secs(10));
            }
        });
    }
}

async fn listen_once(live: &Arc<Live>, config: &tokio_postgres::Config) -> Result<(), String> {
    let (client, mut connection) = config
        .connect(tokio_postgres::NoTls)
        .await
        .map_err(|e| e.to_string())?;
    let hub = live.clone();
    let driver = tokio::spawn(async move {
        loop {
            match std::future::poll_fn(|cx| connection.poll_message(cx)).await {
                Some(Ok(tokio_postgres::AsyncMessage::Notification(n))) => {
                    hub.hub.dispatch(n.channel(), n.payload());
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            }
        }
    });
    let listening = client
        .batch_execute("LISTEN fathom_live; LISTEN fathom_authority")
        .await
        .map_err(|e| e.to_string());
    if let Err(e) = listening {
        driver.abort();
        return Err(e);
    }
    live.hub.wake_all();
    let _ = driver.await;
    Err("the connection closed".to_owned())
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/// The read half, which tells the stream task when the response is dropped.
pub struct Tail {
    inner: DuplexStream,
    gone: Arc<Notify>,
}

impl AsyncRead for Tail {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl Drop for Tail {
    fn drop(&mut self) {
        self.gone.notify_one();
    }
}

/// What a stream needs to start.
pub struct Opening {
    pub state: DesignApiState,
    pub tenant: OrganisationId,
    pub design: DesignId,
    pub scope: Option<ScopeId>,
    pub session: VerifiedSession,
    pub account: String,
    /// The account's display name, for presence.
    pub name: String,
    pub since: i64,
    /// The organisation's authority head as the opening request saw it.
    pub head: Vec<u8>,
}

/// Admit and start a stream. The reader is the response body.
pub fn open(opening: Opening) -> Result<Tail, Refusal> {
    let live = opening.state.live.clone();
    let registered = live.hub.admit(
        &opening.design.to_string(),
        &opening.tenant.to_string(),
        opening.session.id(),
        &opening.account,
        &opening.name,
    )?;
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    let gone = Arc::new(Notify::new());
    let tail = Tail {
        inner: reader,
        gone: gone.clone(),
    };
    tokio::spawn(run(opening, registered, writer, gone));
    Ok(tail)
}

enum Stop {
    /// Authority, session or the reader said stop; nothing more is written.
    Closed,
    /// The client is too far behind; a resync frame was written.
    Resync,
}

struct Stream {
    o: Opening,
    signal: Arc<Signal>,
    writer: DuplexStream,
    head: Vec<u8>,
    last_write: Instant,
    last_presence: Option<String>,
    /// Authors this stream has already named in an author frame.
    named: BTreeSet<String>,
    /// Display names of authors read with the rows, by account.
    names: BTreeMap<String, String>,
}

async fn run(o: Opening, registered: Registered, writer: DuplexStream, gone: Arc<Notify>) {
    let id = registered.id;
    let live = o.state.live.clone();
    let design = o.design;
    let tenant = o.tenant;
    let scope = o.scope;
    let session = o.session.clone();
    let state = o.state.clone();
    let mut s = Stream {
        head: o.head.clone(),
        o,
        signal: registered.signal,
        writer,
        last_write: Instant::now(),
        last_presence: None,
        named: BTreeSet::new(),
        names: BTreeMap::new(),
    };
    let end = Instant::now() + STREAM_LIFE;
    let mut last_check = Instant::now();
    let mut force = true;
    loop {
        if s.signal.replaced.load(Ordering::SeqCst) || s.deliver(force).await.is_err() {
            break;
        }
        if force {
            last_check = Instant::now();
            force = false;
        }
        let wake_at = (last_check + RECHECK)
            .min(s.last_write + HEARTBEAT)
            .min(end);
        tokio::select! {
            _ = s.signal.wake.notified() => {}
            _ = gone.notified() => break,
            _ = tokio::time::sleep_until(wake_at) => {}
        }
        let now = Instant::now();
        if now >= end || s.signal.replaced.load(Ordering::SeqCst) {
            break;
        }
        if now >= last_check + RECHECK {
            force = true;
        }
        if now >= s.last_write + HEARTBEAT && s.frame(FRAME_HEARTBEAT, 0, &[]).await.is_err() {
            break;
        }
    }
    drop(s);
    let last = live.hub.leave(id);
    if last {
        checkpoint(&state, tenant, design, scope, &session).await;
    }
}

/// The last stream on a design closed: write a checkpoint if one is due.
async fn checkpoint(
    state: &DesignApiState,
    tenant: OrganisationId,
    design: DesignId,
    scope: Option<ScopeId>,
    session: &VerifiedSession,
) {
    let work = async {
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
        let auth = Authority {
            ring: &state.ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &state.watch,
        };
        let written =
            designs::checkpoint_if_due_in_tx(&tx, &auth, &state.live.heads, design, scope)
                .await
                .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok::<bool, String>(written)
    };
    match tokio::time::timeout(Duration::from_secs(20), work).await {
        Ok(Ok(_)) => {}
        Ok(Err(why)) => tracing::info!(%design, %why, "no checkpoint written on stream close"),
        Err(_) => tracing::warn!(%design, "checkpoint on stream close timed out"),
    }
}

impl Stream {
    async fn frame(&mut self, kind: u8, version: i64, bytes: &[u8]) -> Result<(), Stop> {
        let mut out = Vec::with_capacity(13 + bytes.len());
        out.push(kind);
        out.extend_from_slice(&(version.max(0) as u64).to_le_bytes());
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
        match tokio::time::timeout(WRITE_TIMEOUT, self.writer.write_all(&out)).await {
            Ok(Ok(())) => {
                self.last_write = Instant::now();
                Ok(())
            }
            // A reader that is gone, or too slow to drain in time.
            _ => Err(Stop::Closed),
        }
    }

    /// Everything after `since`, then who is present. Rechecks authority
    /// first, in the transaction that reads.
    async fn deliver(&mut self, force: bool) -> Result<(), Stop> {
        let mut force = force || self.signal.authority.swap(false, Ordering::SeqCst);
        loop {
            let batch = match self.read(force).await {
                Ok(b) => b,
                Err(why) => {
                    tracing::info!(design = %self.o.design, %why, "a live stream ended");
                    return Err(Stop::Closed);
                }
            };
            match batch {
                LiveBatch::Resync => {
                    let since = self.o.since;
                    self.frame(FRAME_RESYNC, since, &[]).await?;
                    return Err(Stop::Resync);
                }
                LiveBatch::Rows(rows) => {
                    let full = rows.len() as i64 >= PAGE;
                    for row in rows {
                        if let (Some(_), Some(author)) = (&row.change, &row.author) {
                            if !self.named.contains(author) {
                                let name = self.names.get(author).cloned().unwrap_or_default();
                                let json = person_json(author, &name, None);
                                self.frame(FRAME_AUTHOR, row.version, json.as_bytes())
                                    .await?;
                                self.named.insert(author.clone());
                            }
                        }
                        match &row.change {
                            Some(doc) => self.frame(FRAME_CHANGE, row.version, doc).await?,
                            None => self.frame(FRAME_RELOAD, row.version, &[]).await?,
                        }
                        self.o.since = row.version;
                    }
                    if !full {
                        break;
                    }
                }
            }
            force = false;
        }
        if self.signal.presence.swap(false, Ordering::SeqCst) {
            let json = self
                .o
                .state
                .live
                .hub
                .presence_json(&self.o.design.to_string(), &self.o.account);
            let changed = match &self.last_presence {
                Some(prev) => *prev != json,
                None => true,
            };
            if changed {
                let since = self.o.since;
                self.frame(FRAME_PRESENCE, since, json.as_bytes()).await?;
                self.last_presence = Some(json);
            }
        }
        Ok(())
    }

    /// One transaction: session standing, membership, the grant if the
    /// authority head moved (or `force`), then the rows after `since`.
    async fn read(&mut self, force: bool) -> Result<LiveBatch, String> {
        let state = &self.o.state;
        let mut client = tokio::time::timeout(Duration::from_secs(10), state.sessions.pool().get())
            .await
            .map_err(|_| "no database connection".to_owned())?
            .map_err(|e| e.to_string())?;
        let tx = client.transaction().await.map_err(|e| e.to_string())?;

        // Committed whatever the outcome: an ending the check made (an expired
        // or idle session) must stick.
        let standing = state
            .sessions
            .check_session_standing(&tx, &self.o.session)
            .await;
        if let Err(e) = standing {
            let _ = tx.commit().await;
            return Err(format!("session: {e}"));
        }
        let ctx = sessions::open_tenant_context(&tx, self.o.tenant, &self.o.session)
            .await
            .map_err(|e| format!("membership: {e}"))?;
        let head: Vec<u8> = tx
            .query_opt(
                "SELECT head_seal FROM organisation_auth_head WHERE organisation_id = $1",
                &[&self.o.tenant.to_string()],
            )
            .await
            .map_err(|e| e.to_string())?
            .map(|r| r.get(0))
            .ok_or_else(|| "no authority head".to_owned())?;
        if force || head != self.head {
            let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
                .await
                .map_err(|e| e.to_string())?;
            let auth = Authority {
                ring: &state.ring,
                ctx: &ctx,
                tenant_key: &tenant_key,
                watch: &state.watch,
            };
            grants::authorise_account(&tx, &auth, self.o.scope, Capability::Read)
                .await
                .map_err(|e| format!("grant: {e}"))?;
        }
        let batch =
            designs::live_rows_after(&tx, &state.ring, &ctx, self.o.design, self.o.since, PAGE)
                .await
                .map_err(|e| e.to_string())?;
        // The display names of authors this stream has not named yet.
        if let LiveBatch::Rows(rows) = &batch {
            let unnamed: Vec<String> = rows
                .iter()
                .filter_map(|r| r.author.clone())
                .filter(|a| !self.named.contains(a) && !self.names.contains_key(a))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            if !unnamed.is_empty() {
                let found = tx
                    .query(
                        "SELECT id, display_name FROM accounts WHERE id = ANY($1)",
                        &[&unnamed],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                for row in found {
                    self.names.insert(row.get(0), row.get(1));
                }
            }
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        self.head = head;
        Ok(batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_come_from_the_name() {
        assert_eq!(initials_of("Kim Marsh"), "KM");
        assert_eq!(initials_of("rowan"), "RO");
        assert_eq!(initials_of("  "), "-");
    }

    #[test]
    fn a_stream_limit_holds_per_account_and_per_design() {
        let hub = Hub::default();
        let a = hub.admit("d1", "o", "s1", "alice", "Alice A").unwrap();
        let _b = hub.admit("d1", "o", "s2", "alice", "Alice A").unwrap();
        assert_eq!(
            hub.admit("d1", "o", "s3", "alice", "Alice A").err(),
            Some(Refusal::AccountDesign)
        );
        for d in 2..=4 {
            let name = format!("d{d}");
            hub.admit(&name, "o", "s1", "alice", "Alice A").unwrap();
            hub.admit(&name, "o", "s2", "alice", "Alice A").unwrap();
        }
        assert_eq!(
            hub.admit("d5", "o", "s3", "alice", "Alice A").err(),
            Some(Refusal::Account)
        );
        assert!(!hub.leave(a.id));
        assert_eq!(hub.stream_count(), 7);
    }

    #[test]
    fn a_reconnect_at_the_limit_replaces_its_own_oldest_stream() {
        let hub = Hub::default();
        // Two streams the server still holds for one session: the connections
        // died without closing, so neither has noticed yet.
        let stale = hub.admit("d1", "o", "s", "alice", "Alice A").unwrap();
        let other = hub.admit("d1", "o", "s", "alice", "Alice A").unwrap();
        let fresh = hub.admit("d1", "o", "s", "alice", "Alice A").unwrap();
        assert!(stale.signal.replaced.load(Ordering::SeqCst));
        assert!(!other.signal.replaced.load(Ordering::SeqCst));
        assert!(!fresh.signal.replaced.load(Ordering::SeqCst));
        assert_eq!(hub.stream_count(), 2);
        // The replaced stream's own leave finds nothing and is not the last.
        assert!(!hub.leave(stale.id));
        assert_eq!(hub.stream_count(), 2);
        // Another session of the same account is still refused: it cannot
        // push out streams that are not its own.
        assert_eq!(
            hub.admit("d1", "o", "s2", "alice", "Alice A").err(),
            Some(Refusal::AccountDesign)
        );
        assert!(!other.signal.replaced.load(Ordering::SeqCst));
    }

    #[test]
    fn the_change_rate_has_a_burst_then_stops() {
        let hub = Hub::default();
        let allowed = (0..40).filter(|_| hub.allow_change("alice")).count();
        assert_eq!(allowed, CHANGE_BURST as usize);
        assert!(hub.allow_change("bob"));
    }

    const ID_A: &str = "chassis:01HF7YAT00000000000000000C";

    #[test]
    fn a_presence_body_is_validated_by_shape_and_length() {
        let ok = |b: &str| parse_presence(b.as_bytes());
        assert_eq!(
            ok(r#"{"view":"canvas","selected":null}"#),
            Some(("canvas", None))
        );
        assert_eq!(
            ok(&format!(
                r#" {{ "selected" : "{ID_A}" , "view" : "inventory" }} "#
            )),
            Some(("inventory", Some(ID_A.to_owned())))
        );
        for bad in [
            "",
            "{}",
            r#"{"view":"canvas"}"#,
            r#"{"selected":null}"#,
            r#"{"view":"elevation","selected":null}"#,
            r#"{"view":"canvas","selected":"not-an-id"}"#,
            r#"{"view":"canvas","selected":"01HF7YAT00000000000000000C"}"#,
            r#"{"view":"canvas","selected":"chassis:01HF7YAT00000000000000000C0"}"#,
            r#"{"view":"canvas","selected":"chassi:01HF7YAT00000000000000000C"}"#,
            r#"{"view":"canvas","selected":"chassis:01hf7yat00000000000000000c"}"#,
            r#"{"view":"canvas","selected":null,"extra":null}"#,
            r#"{"view":"canvas","view":"canvas","selected":null}"#,
            r#"{"view":"canvas","selected":null"#,
            r#"{"view":"canvas","selected":null} x"#,
            r#"{"view":"can\u0076as","selected":null}"#,
            r#"{"view":null,"selected":null}"#,
            r#"[1]"#,
        ] {
            assert_eq!(ok(bad), None, "{bad}");
        }
        let long = format!(
            r#"{{"view":"canvas","selected":null,"pad":"{}"}}"#,
            "x".repeat(300)
        );
        assert_eq!(ok(&long), None);
    }

    #[test]
    fn presence_shows_self_and_only_others_in_the_same_view() {
        let hub = Hub::default();
        hub.admit("d", "o", "s1", "alice", "Alice \"Al\" Ames")
            .unwrap();
        hub.admit("d", "o", "s2", "bob", "Bob Brown").unwrap();
        hub.admit("d", "o", "s3", "carol", "Carol Cho").unwrap();
        assert!(hub.set_presence("d", "alice", "canvas", None));
        assert!(hub.set_presence("d", "bob", "canvas", Some(ID_A.to_owned())));
        assert!(hub.set_presence("d", "carol", "inventory", None));
        assert_eq!(
            hub.presence_json("d", "alice"),
            format!(
                "{{\"self\":{{\"account\":\"alice\",\"initials\":\"AA\",\"name\":\"Alice \\\"Al\\\" Ames\"}},\"others\":[{{\"account\":\"bob\",\"initials\":\"BB\",\"name\":\"Bob Brown\",\"selected\":\"{ID_A}\"}}]}}"
            )
        );
        assert_eq!(
            hub.presence_json("d", "carol"),
            "{\"self\":{\"account\":\"carol\",\"initials\":\"CC\",\"name\":\"Carol Cho\"},\"others\":[]}"
        );
        assert!(!hub.set_presence("d", "dave", "canvas", None));
    }

    #[test]
    fn presence_goes_when_the_last_stream_of_an_account_does() {
        let hub = Hub::default();
        let a = hub.admit("d", "o", "s1", "alice", "Alice A").unwrap();
        let b = hub.admit("d", "o", "s2", "bob", "Bob B").unwrap();
        hub.set_presence("d", "alice", "canvas", None);
        hub.set_presence("d", "bob", "canvas", None);
        assert!(!hub.leave(a.id));
        assert!(hub.presence_json("d", "bob").ends_with("\"others\":[]}"));
        assert!(hub.leave(b.id));
    }
}

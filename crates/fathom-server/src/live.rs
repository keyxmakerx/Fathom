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
//! Presence is held per process and crosses processes through `NOTIFY` too,
//! on `fathom_presence`, so people whose browsers reach different servers
//! behind a load balancer still see each other (see [`Hub::dispatch`]). Each
//! process sends what changed as it changes and everyone it holds every
//! [`PRESENCE_REFRESH`]; another process's people are dropped after
//! [`PRESENCE_TTL`] without word, so a server that dies leaves no ghosts.

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
/// Pointer posts have their own bucket; the client sends at most 8 a second.
pub const POINTER_PER_SECOND: f64 = 10.0;
pub const POINTER_BURST: f64 = 10.0;
/// A pointer post is at most this many bytes.
pub const POINTER_BODY_MAX: usize = 128;
/// A pointer coordinate is within this many canvas units of the origin.
pub const POINTER_RANGE: f64 = 10_000_000.0;
/// Pointer frames reach one stream at most this often.
const POINTER_GAP: Duration = Duration::from_millis(100);

/// How often a process tells the others who it holds, so that they keep
/// showing them.
pub const PRESENCE_REFRESH: Duration = Duration::from_secs(20);
/// Another process's person is dropped when nothing about them has arrived for
/// this long: that process has gone, or lost its database connection.
pub const PRESENCE_TTL: Duration = Duration::from_secs(60);
/// The channel presence crosses processes on. Changes and authority have
/// their own (`fathom_live`, `fathom_authority`).
pub const PRESENCE_CHANNEL: &str = "fathom_presence";

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
    /// Someone else's pointer may have moved. Apart from `wake` so that a
    /// pointer never costs a database read.
    pointer: Notify,
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
    /// The pointer on the canvas in tenths of a canvas unit. Held in memory
    /// with the rest; never stored.
    pointer: Option<(i64, i64)>,
}

/// Someone present on a design through another server process.
struct Remote {
    name: String,
    view: &'static str,
    selected: Option<String>,
    pointer: Option<(i64, i64)>,
    heard: Instant,
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
    /// design -> (account, process) -> person present there through another
    /// process. Keyed by both: one account can be on two other servers.
    remote: BTreeMap<String, BTreeMap<(String, u64), Remote>>,
    change_rate: BTreeMap<String, Bucket>,
    presence_rate: BTreeMap<(String, String), Bucket>,
    pointer_rate: BTreeMap<(String, String), Bucket>,
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

pub struct Hub {
    inner: Mutex<Inner>,
    /// This process, among the others sharing the database. Random, so that a
    /// process hears its own `NOTIFY` and knows to skip it.
    origin: u64,
    /// Presence for the other processes, sent by the listener's connection.
    /// Unset until it connects; while it is down, presence stays local.
    outbound: Mutex<Option<tokio::sync::mpsc::Sender<String>>>,
}

impl Default for Hub {
    fn default() -> Self {
        let mut bytes = [0u8; 8];
        // Not a secret: only distinct. A clock is the fallback.
        if getrandom::fill(&mut bytes).is_err() {
            bytes = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos() as u64))
            .to_le_bytes();
        }
        Self {
            inner: Mutex::new(Inner::default()),
            origin: u64::from_le_bytes(bytes),
            outbound: Mutex::new(None),
        }
    }
}

/// One presence message between processes: tab-separated, the name last so
/// that it may hold anything. `p` is a person and where they are, `g` is
/// gone. Ids and views never hold a tab; [`parse_presence`] admits none.
fn presence_message(
    origin: u64,
    design: &str,
    account: &str,
    person: Option<(&Person, &str)>,
) -> String {
    match person {
        None => format!("{origin:x}\tg\t{design}\t{account}"),
        Some((p, name)) => {
            let pointer = p
                .pointer
                .map_or_else(|| "-".to_owned(), |(x, y)| format!("{x},{y}"));
            format!(
                "{origin:x}\tp\t{design}\t{account}\t{}\t{}\t{pointer}\t{name}",
                p.view,
                p.selected.as_deref().unwrap_or("-"),
            )
        }
    }
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
        let first_here = !h.by_design.contains_key(design);
        h.by_design.entry(design.to_owned()).or_default().insert(id);
        drop(h);
        if first_here {
            self.ask(design);
        }
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
        let still_here = h
            .streams
            .values()
            .any(|e| e.design == entry.design && e.account == entry.account);
        if last {
            h.remote.remove(&entry.design);
        }
        drop(h);
        if !still_here {
            self.publish(presence_message(
                self.origin,
                &entry.design,
                &entry.account,
                None,
            ));
        }
        last
    }

    /// Send a presence message to the other processes, if the listener is up.
    /// Dropped when it is not, or when it is behind: presence is a hint, and
    /// the next refresh repairs it.
    fn publish(&self, message: String) {
        let outbound = self.outbound.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tx) = outbound.as_ref() {
            let _ = tx.try_send(message);
        }
    }

    /// Everyone this process holds, as messages for the other processes.
    fn refresh_messages(&self) -> Vec<String> {
        let mut h = self.lock();
        let now = Instant::now();
        for people in h.remote.values_mut() {
            people.retain(|_, r| now.duration_since(r.heard) < PRESENCE_TTL);
        }
        h.remote.retain(|_, people| !people.is_empty());
        let mut out = Vec::new();
        for (design, people) in &h.people {
            for (account, p) in people {
                let name = Self::local_name(&h, design, account);
                out.push(presence_message(
                    self.origin,
                    design,
                    account,
                    Some((p, &name)),
                ));
            }
        }
        out
    }

    fn local_name(h: &Inner, design: &str, account: &str) -> String {
        h.streams
            .values()
            .find(|e| e.design == design && e.account == account)
            .map(|e| e.name.clone())
            .unwrap_or_default()
    }

    /// Ask the other processes who they hold on `design`, when this process
    /// opens its first stream there.
    fn ask(&self, design: &str) {
        self.publish(format!("{:x}\tq\t{design}", self.origin));
    }

    /// A presence message from another process.
    fn hear(&self, payload: &str) {
        let mut parts = payload.splitn(8, '\t');
        let (Some(origin), Some(kind), Some(design)) = (parts.next(), parts.next(), parts.next())
        else {
            return;
        };
        let Ok(origin) = u64::from_str_radix(origin, 16) else {
            return;
        };
        if origin == self.origin {
            return;
        }
        if kind == "q" {
            let h = self.lock();
            let mine: Vec<String> = h
                .people
                .get(design)
                .map(|people| {
                    people
                        .iter()
                        .map(|(account, p)| {
                            let name = Self::local_name(&h, design, account);
                            presence_message(self.origin, design, account, Some((p, &name)))
                        })
                        .collect()
                })
                .unwrap_or_default();
            drop(h);
            for m in mine {
                self.publish(m);
            }
            return;
        }
        let Some(account) = parts.next() else { return };
        let mut h = self.lock();
        // Only designs someone here is watching; the ask on opening fills in
        // the rest.
        if !h.by_design.contains_key(design) {
            return;
        }
        let pointer_moved;
        match kind {
            "g" => {
                // Only the process that held them: the same account may still be
                // present through a third.
                let gone = h
                    .remote
                    .get_mut(design)
                    .and_then(|people| people.remove(&(account.to_owned(), origin)));
                pointer_moved = gone.is_some_and(|r| r.pointer.is_some());
            }
            "p" => {
                let (Some(view), Some(selected), Some(pointer), Some(name)) =
                    (parts.next(), parts.next(), parts.next(), parts.next())
                else {
                    return;
                };
                let view = match view {
                    "canvas" => "canvas",
                    "inventory" => "inventory",
                    _ => return,
                };
                let selected = (selected != "-").then(|| selected.to_owned());
                let pointer = pointer
                    .split_once(',')
                    .and_then(|(x, y)| Some((x.parse::<i64>().ok()?, y.parse::<i64>().ok()?)));
                let people = h.remote.entry(design.to_owned()).or_default();
                let key = (account.to_owned(), origin);
                let before = people.get(&key).and_then(|r| r.pointer);
                pointer_moved = before != pointer;
                people.insert(
                    key,
                    Remote {
                        name: name.to_owned(),
                        view,
                        selected,
                        pointer,
                        heard: Instant::now(),
                    },
                );
            }
            _ => return,
        }
        Self::poke_presence(&h, design);
        if pointer_moved {
            if let Some(ids) = h.by_design.get(design) {
                for id in ids {
                    if let Some(e) = h.streams.get(id) {
                        e.signal.pointer.notify_one();
                    }
                }
            }
        }
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
            PRESENCE_CHANNEL => self.hear(payload),
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
        // The pointer stays while the person stays in the same view.
        let pointer = h
            .people
            .get(design)
            .and_then(|people| people.get(account))
            .filter(|p| p.view == view)
            .and_then(|p| p.pointer);
        let person = Person {
            view,
            selected,
            pointer,
        };
        let name = Self::local_name(&h, design, account);
        let message = presence_message(self.origin, design, account, Some((&person, &name)));
        h.people
            .entry(design.to_owned())
            .or_default()
            .insert(account.to_owned(), person);
        Self::poke_presence(&h, design);
        drop(h);
        self.publish(message);
        true
    }

    pub fn allow_pointer(&self, account: &str, design: &str) -> bool {
        let mut h = self.lock();
        if h.pointer_rate.len() > BUCKET_SWEEP {
            let now = Instant::now();
            h.pointer_rate
                .retain(|_, b| now.duration_since(b.at) < Duration::from_secs(5));
        }
        h.pointer_rate
            .entry((account.to_owned(), design.to_owned()))
            .or_insert(Bucket {
                tokens: POINTER_BURST,
                at: Instant::now(),
            })
            .take(POINTER_PER_SECOND, POINTER_BURST)
    }

    /// Record where `account`'s pointer is (`None` clears it). Only a person
    /// who has said they are on the canvas has one; false (and nothing kept)
    /// otherwise. Wakes the other streams in that view, with no database read.
    pub fn set_pointer(&self, design: &str, account: &str, pointer: Option<(i64, i64)>) -> bool {
        let mut h = self.lock();
        let Some(me) = h.people.get_mut(design).and_then(|p| p.get_mut(account)) else {
            return false;
        };
        if me.view != "canvas" {
            return false;
        }
        if me.pointer == pointer {
            return true;
        }
        me.pointer = pointer;
        if let (Some(ids), Some(people)) = (h.by_design.get(design), h.people.get(design)) {
            for id in ids {
                let Some(e) = h.streams.get(id) else { continue };
                if e.account != account
                    && people.get(&e.account).is_some_and(|p| p.view == "canvas")
                {
                    e.signal.pointer.notify_one();
                }
            }
        }
        let name = Self::local_name(&h, design, account);
        let message = h
            .people
            .get(design)
            .and_then(|people| people.get(account))
            .map(|p| presence_message(self.origin, design, account, Some((p, &name))));
        drop(h);
        if let Some(message) = message {
            self.publish(message);
        }
        true
    }

    /// The presence frame's JSON for `account`: itself, and the others in the
    /// same view (none until it has said which view it is in).
    fn presence_json(&self, design: &str, account: &str) -> String {
        let h = self.lock();
        let mut out = format!(
            "{{\"self\":{},\"others\":[",
            person_json(account, &Self::local_name(&h, design, account), None)
        );
        let me = h.people.get(design).and_then(|people| people.get(account));
        if let Some(me) = me {
            // Everyone in the same view, here or through another process; one
            // account once, the copy in this process first.
            let mut others: BTreeMap<&str, Seen<'_>> = BTreeMap::new();
            if let Some(people) = h.people.get(design) {
                for (other, p) in people {
                    if other != account && p.view == me.view {
                        others.insert(
                            other,
                            (
                                Self::local_name(&h, design, other),
                                p.selected.as_deref(),
                                p.pointer,
                            ),
                        );
                    }
                }
            }
            if let Some(people) = h.remote.get(design) {
                let now = Instant::now();
                for ((other, _), r) in people {
                    if other != account
                        && r.view == me.view
                        && now.duration_since(r.heard) < PRESENCE_TTL
                    {
                        others.entry(other).or_insert((
                            r.name.clone(),
                            r.selected.as_deref(),
                            r.pointer,
                        ));
                    }
                }
            }
            let mut first = true;
            for (other, (name, selected, pointer)) in others {
                if !first {
                    out.push(',');
                }
                first = false;
                let mut one = person_json(other, &name, Some(selected));
                if let (Some((x, y)), "canvas") = (pointer, me.view) {
                    one.pop();
                    one.push_str(&format!(
                        ",\"pointer\":{{\"x\":{},\"y\":{}}}}}",
                        tenths(x),
                        tenths(y)
                    ));
                }
                out.push_str(&one);
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

/// Another person as one presence frame shows them: name, selection, pointer.
type Seen<'a> = (String, Option<&'a str>, Option<(i64, i64)>);

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

/// A coordinate in tenths of a unit as decimal text: `-5` is `-0.5`.
fn tenths(v: i64) -> String {
    let sign = if v < 0 { "-" } else { "" };
    format!("{sign}{}.{}", v.abs() / 10, v.abs() % 10)
}

/// One plain JSON number: optional `-`, digits, optional `.` and up to six
/// more digits; no exponent, no leading zeros. Returns it in tenths of a unit
/// (rounded) and the text after it. `None` outside [`POINTER_RANGE`].
fn plain_number(at: &str) -> Option<(i64, &str)> {
    let end = at
        .find(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.'))
        .unwrap_or(at.len());
    let (text, rest) = at.split_at(end);
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, frac) = match digits.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (digits, None),
    };
    let plain = !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && (whole == "0" || !whole.starts_with('0'))
        && frac.is_none_or(|f| (1..=6).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()));
    if !plain {
        return None;
    }
    let v: f64 = text.parse().ok()?;
    if !v.is_finite() || v.abs() > POINTER_RANGE {
        return None;
    }
    Some(((v * 10.0).round() as i64, rest))
}

/// A pointer post: `{"pointer": {"x": <number>, "y": <number>}}` to say where
/// it is, `{"pointer": null}` to say it has left. Whitespace and the order of
/// `x` and `y` are free; nothing else is. At most [`POINTER_BODY_MAX`] bytes.
/// The outer `None` is a refusal.
pub fn parse_pointer(body: &[u8]) -> Option<Option<(i64, i64)>> {
    if body.len() > POINTER_BODY_MAX {
        return None;
    }
    let text = core::str::from_utf8(body).ok()?;
    let at = text.trim_start().strip_prefix('{')?.trim_start();
    let at = at.strip_prefix("\"pointer\"")?.trim_start();
    let at = at.strip_prefix(':')?.trim_start();
    // The closing brace of the whole body and nothing after it.
    fn end(rest: &str) -> Option<()> {
        let rest = rest.trim_start().strip_prefix('}')?;
        rest.trim().is_empty().then_some(())
    }
    if let Some(rest) = at.strip_prefix("null") {
        end(rest)?;
        return Some(None);
    }
    let mut at = at.strip_prefix('{')?.trim_start();
    let (mut x, mut y) = (None, None);
    loop {
        let rest = at.strip_prefix('"')?;
        let (key, rest) = rest.split_once('"')?;
        let rest = rest.trim_start().strip_prefix(':')?.trim_start();
        let (value, rest) = plain_number(rest)?;
        match key {
            "x" if x.is_none() => x = Some(value),
            "y" if y.is_none() => y = Some(value),
            _ => return None,
        }
        let rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix(',') {
            at = r.trim_start();
        } else {
            end(rest.strip_prefix('}')?)?;
            return Some(Some((x?, y?)));
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
        .batch_execute("LISTEN fathom_live; LISTEN fathom_authority; LISTEN fathom_presence")
        .await
        .map_err(|e| e.to_string());
    if let Err(e) = listening {
        driver.abort();
        return Err(e);
    }
    // Presence goes out on this same connection. Bounded: a slow database
    // drops presence messages rather than holding memory for them.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(1024);
    *live.hub.outbound.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
    live.hub.wake_all();
    let mut driver = driver;
    let mut refresh = tokio::time::interval(PRESENCE_REFRESH);
    let why = loop {
        tokio::select! {
            _ = &mut driver => break "the connection closed".to_owned(),
            message = rx.recv() => {
                let Some(message) = message else { break "the presence queue closed".to_owned() };
                if let Err(e) = client
                    .execute("SELECT pg_notify($1, $2)", &[&PRESENCE_CHANNEL, &message])
                    .await
                {
                    break e.to_string();
                }
            }
            _ = refresh.tick() => {
                for message in live.hub.refresh_messages() {
                    if let Err(e) = client
                        .execute("SELECT pg_notify($1, $2)", &[&PRESENCE_CHANNEL, &message])
                        .await
                    {
                        return Err(e.to_string());
                    }
                }
            }
        }
    };
    *live.hub.outbound.lock().unwrap_or_else(|p| p.into_inner()) = None;
    driver.abort();
    Err(why)
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
    // A pointer frame is due at this time; pointers wake the stream without a read.
    let mut pointer_due: Option<Instant> = None;
    let mut pointer_sent = Instant::now()
        .checked_sub(POINTER_GAP)
        .unwrap_or_else(Instant::now);
    let mut read = true;
    loop {
        if s.signal.replaced.load(Ordering::SeqCst) || (read && s.deliver(force).await.is_err()) {
            break;
        }
        if force {
            last_check = Instant::now();
            force = false;
        }
        let base_wake = (last_check + RECHECK)
            .min(s.last_write + HEARTBEAT)
            .min(end);
        let wake_at = pointer_due.map_or(base_wake, |due| due.min(base_wake));
        read = true;
        tokio::select! {
            _ = s.signal.wake.notified() => {}
            _ = s.signal.pointer.notified() => {
                read = false;
                if pointer_due.is_none() {
                    pointer_due = Some(Instant::now().max(pointer_sent + POINTER_GAP));
                }
            }
            _ = gone.notified() => break,
            _ = tokio::time::sleep_until(wake_at) => {
                read = Instant::now() >= base_wake;
            }
        }
        let now = Instant::now();
        if now >= end || s.signal.replaced.load(Ordering::SeqCst) {
            break;
        }
        if now >= last_check + RECHECK {
            force = true;
            read = true;
        }
        if now >= s.last_write + HEARTBEAT && s.frame(FRAME_HEARTBEAT, 0, &[]).await.is_err() {
            break;
        }
        if pointer_due.is_some_and(|due| now >= due) {
            pointer_due = None;
            pointer_sent = now;
            if s.send_presence().await.is_err() {
                break;
            }
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
            self.send_presence().await?;
        }
        Ok(())
    }

    /// Who is present, if it differs from what this stream last sent.
    async fn send_presence(&mut self) -> Result<(), Stop> {
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

    /// Two server processes behind one load balancer, with the database's
    /// `NOTIFY` played by hand: what one sends, the other hears.
    fn wired() -> (
        Hub,
        Hub,
        tokio::sync::mpsc::Receiver<String>,
        tokio::sync::mpsc::Receiver<String>,
    ) {
        let (a, b) = (Hub::default(), Hub::default());
        let (ta, ra) = tokio::sync::mpsc::channel(64);
        let (tb, rb) = tokio::sync::mpsc::channel(64);
        *a.outbound.lock().unwrap() = Some(ta);
        *b.outbound.lock().unwrap() = Some(tb);
        (a, b, ra, rb)
    }

    /// Deliver everything queued on `from` to both hubs, as `NOTIFY` does:
    /// the sender hears itself too, and must skip it.
    fn carry(from: &mut tokio::sync::mpsc::Receiver<String>, a: &Hub, b: &Hub) -> usize {
        let mut n = 0;
        while let Ok(m) = from.try_recv() {
            a.dispatch(PRESENCE_CHANNEL, &m);
            b.dispatch(PRESENCE_CHANNEL, &m);
            n += 1;
        }
        n
    }

    #[test]
    fn people_on_different_servers_see_each_other_and_leave_cleanly() {
        let (a, b, mut ra, mut rb) = wired();
        a.admit("d", "o", "s1", "alice", "Alice Ames").unwrap();
        b.admit("d", "o", "s2", "bob", "Bob Brown").unwrap();
        carry(&mut ra, &a, &b);
        carry(&mut rb, &a, &b);
        assert!(a.set_presence("d", "alice", "canvas", None));
        assert!(b.set_presence("d", "bob", "canvas", Some(ID_A.to_owned())));
        assert!(b.set_pointer("d", "bob", Some((125, -30))));
        carry(&mut ra, &a, &b);
        carry(&mut rb, &a, &b);
        assert_eq!(
            a.presence_json("d", "alice"),
            format!(
                "{{\"self\":{{\"account\":\"alice\",\"initials\":\"AA\",\"name\":\"Alice Ames\"}},\"others\":[{{\"account\":\"bob\",\"initials\":\"BB\",\"name\":\"Bob Brown\",\"selected\":\"{ID_A}\",\"pointer\":{{\"x\":12.5,\"y\":-3.0}}}}]}}"
            )
        );
        assert!(b
            .presence_json("d", "bob")
            .contains("\"account\":\"alice\""));
        // A process never counts itself as another.
        assert!(a
            .lock()
            .remote
            .get("d")
            .is_none_or(|p| p.keys().all(|(who, _)| who != "alice")));

        // Bob's server closes his stream: Alice's server hears he has gone.
        let id = b.lock().streams.keys().copied().next().unwrap();
        b.leave(id);
        carry(&mut rb, &a, &b);
        assert!(!a.presence_json("d", "alice").contains("bob"));
    }

    #[test]
    fn a_server_opening_a_design_asks_who_is_there_and_a_dead_one_fades() {
        let (a, b, mut ra, mut rb) = wired();
        a.admit("d", "o", "s1", "alice", "Alice Ames").unwrap();
        assert!(a.set_presence("d", "alice", "canvas", None));
        carry(&mut ra, &a, &b);
        // Bob's server had nobody on the design, so it kept nothing; opening
        // the design asks, and Alice's server answers.
        b.admit("d", "o", "s2", "bob", "Bob Brown").unwrap();
        assert!(b.set_presence("d", "bob", "canvas", None));
        assert!(carry(&mut rb, &a, &b) >= 1);
        carry(&mut ra, &a, &b);
        assert!(b
            .presence_json("d", "bob")
            .contains("\"account\":\"alice\""));

        // Alice's server dies without a word: past the TTL she is gone.
        b.lock()
            .remote
            .get_mut("d")
            .unwrap()
            .values_mut()
            .next()
            .unwrap()
            .heard = Instant::now() - PRESENCE_TTL;
        assert!(!b.presence_json("d", "bob").contains("alice"));
        assert!(b
            .refresh_messages()
            .iter()
            .all(|m| !m.contains("\talice\t")));
        assert!(b.lock().remote.is_empty());
    }

    #[test]
    fn a_gone_from_one_server_does_not_remove_someone_still_on_another() {
        let (a, b, mut ra, mut rb) = wired();
        let c = Hub::default();
        let (tc, mut rc) = tokio::sync::mpsc::channel(64);
        *c.outbound.lock().unwrap() = Some(tc);
        let all = |m: &str| {
            a.dispatch(PRESENCE_CHANNEL, m);
            b.dispatch(PRESENCE_CHANNEL, m);
            c.dispatch(PRESENCE_CHANNEL, m);
        };
        a.admit("d", "o", "s1", "alice", "Alice Ames").unwrap();
        assert!(a.set_presence("d", "alice", "canvas", None));
        b.admit("d", "o", "s2", "bob", "Bob Brown").unwrap();
        assert!(b.set_presence("d", "bob", "canvas", None));
        c.admit("d", "o", "s3", "bob", "Bob Brown").unwrap();
        assert!(c.set_presence("d", "bob", "canvas", None));
        for r in [&mut ra, &mut rb, &mut rc] {
            while let Ok(m) = r.try_recv() {
                all(&m);
            }
        }
        // Bob closes his tab on server c; he is still on server b.
        let id = c.lock().streams.keys().copied().next().unwrap();
        c.leave(id);
        while let Ok(m) = rc.try_recv() {
            all(&m);
        }
        assert!(a
            .presence_json("d", "alice")
            .contains("\"account\":\"bob\""));
    }

    /// The same, through a real PostgreSQL: two processes' listeners, and
    /// `pg_notify` between them. The database is the one the integration
    /// tests use (`tests/support`), as the runtime role.
    #[tokio::test]
    async fn presence_crosses_two_servers_through_the_database() {
        let migrate = std::env::var("FATHOM_MIGRATE_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://fathom_test:fathom_test_pw@127.0.0.1:5432/fathom_test".to_owned()
        });
        let url = std::env::var("DATABASE_URL").unwrap_or(migrate);
        let config: tokio_postgres::Config = url.parse().expect("a database url");
        let (a, b) = (Live::new(1, 1 << 20), Live::new(1, 1 << 20));
        a.listen(config.clone());
        b.listen(config);
        let up = |l: &Arc<Live>| l.hub.outbound.lock().unwrap().is_some();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !(up(&a) && up(&b)) {
            assert!(Instant::now() < deadline, "both listeners connect");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // A design no other test watches.
        let design = format!("presence-{:x}", a.hub.origin);
        a.hub
            .admit(&design, "o", "s1", "alice", "Alice Ames")
            .unwrap();
        b.hub.admit(&design, "o", "s2", "bob", "Bob Brown").unwrap();
        loop {
            // Repeated until heard: a message sent before the other side's
            // LISTEN took effect is lost, as it would be in production, and
            // the refresh repairs it there.
            assert!(a.hub.set_presence(&design, "alice", "canvas", None));
            assert!(b.hub.set_presence(&design, "bob", "canvas", None));
            tokio::time::sleep(Duration::from_millis(100)).await;
            let seen_by_a = a
                .hub
                .presence_json(&design, "alice")
                .contains("\"account\":\"bob\"");
            let seen_by_b = b
                .hub
                .presence_json(&design, "bob")
                .contains("\"account\":\"alice\"");
            if seen_by_a && seen_by_b {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "each server sees the other's person"
            );
        }
    }

    #[test]
    fn a_presence_message_from_outside_the_shape_is_ignored() {
        let hub = Hub::default();
        hub.admit("d", "o", "s1", "alice", "Alice Ames").unwrap();
        assert!(hub.set_presence("d", "alice", "canvas", None));
        for bad in [
            "",
            "zz\tp\td\tbob\tcanvas\t-\t-\tBob",
            "1\tp\td\tbob\tdesk\t-\t-\tBob",
            "1\tp\td\tbob\tcanvas",
            "1\tx\td\tbob",
        ] {
            hub.dispatch(PRESENCE_CHANNEL, bad);
        }
        assert!(hub.lock().remote.is_empty());
        // A design nobody here watches is not kept.
        hub.dispatch(PRESENCE_CHANNEL, "1\tp\tother\tbob\tcanvas\t-\t-\tBob");
        assert!(hub.lock().remote.is_empty());
    }

    #[test]
    fn a_pointer_body_is_validated_by_shape_range_and_length() {
        let ok = |b: &str| parse_pointer(b.as_bytes());
        assert_eq!(
            ok(r#"{"pointer":{"x":12.5,"y":-3}}"#),
            Some(Some((125, -30)))
        );
        assert_eq!(
            ok(r#" { "pointer" : { "y" : 0.04 , "x" : -0.25 } } "#),
            Some(Some((-3, 0)))
        );
        assert_eq!(ok(r#"{"pointer":null}"#), Some(None));
        assert_eq!(
            ok(r#"{"pointer":{"x":10000000,"y":-10000000}}"#),
            Some(Some((100_000_000, -100_000_000)))
        );
        for bad in [
            "",
            "{}",
            r#"{"pointer":{}}"#,
            r#"{"pointer":{"x":1}}"#,
            r#"{"pointer":{"x":1,"y":2,"z":3}}"#,
            r#"{"pointer":{"x":1,"x":2,"y":3}}"#,
            r#"{"pointer":{"x":1,"y":2},"view":"canvas"}"#,
            r#"{"pointer":{"x":1e3,"y":2}}"#,
            r#"{"pointer":{"x":+1,"y":2}}"#,
            r#"{"pointer":{"x":01,"y":2}}"#,
            r#"{"pointer":{"x":.5,"y":2}}"#,
            r#"{"pointer":{"x":1.,"y":2}}"#,
            r#"{"pointer":{"x":1.1234567,"y":2}}"#,
            r#"{"pointer":{"x":--1,"y":2}}"#,
            r#"{"pointer":{"x":"1","y":2}}"#,
            r#"{"pointer":{"x":null,"y":2}}"#,
            r#"{"pointer":{"x":NaN,"y":2}}"#,
            r#"{"pointer":{"x":10000001,"y":2}}"#,
            r#"{"pointer":{"x":1,"y":-10000000.1}}"#,
            r#"{"pointer":{"x":1,"y":2}"#,
            r#"{"pointer":{"x":1,"y":2}} x"#,
            r#"{"pointer":nul}"#,
            r#"{"pointer":null,"pointer":null}"#,
            r#"[1]"#,
        ] {
            assert_eq!(ok(bad), None, "{bad}");
        }
        let long = format!(
            r#"{{"pointer":{{"x":1,"y":2}},"pad":"{}"}}"#,
            "x".repeat(200)
        );
        assert_eq!(ok(&long), None);
        let padded = format!(r#"{{"pointer":{{"x":1,"y":2}}}}{}"#, " ".repeat(120));
        assert_eq!(ok(&padded), None);
    }

    #[test]
    fn a_pointer_reaches_only_others_on_the_canvas_and_is_never_kept_across_views() {
        let hub = Hub::default();
        hub.admit("d", "o", "s1", "alice", "Alice A").unwrap();
        hub.admit("d", "o", "s2", "bob", "Bob B").unwrap();
        hub.admit("d", "o", "s3", "carol", "Carol C").unwrap();
        // Nobody has said where they are yet.
        assert!(!hub.set_pointer("d", "alice", Some((15, -5))));
        hub.set_presence("d", "alice", "canvas", None);
        hub.set_presence("d", "bob", "canvas", None);
        hub.set_presence("d", "carol", "inventory", None);
        assert!(hub.set_pointer("d", "alice", Some((15, -5))));
        // Not on the canvas: nothing to point with.
        assert!(!hub.set_pointer("d", "carol", Some((1, 1))));
        assert!(!hub.set_pointer("d", "dave", Some((1, 1))));
        let bob = hub.presence_json("d", "bob");
        assert!(
            bob.contains(",\"selected\":null,\"pointer\":{\"x\":1.5,\"y\":-0.5}}"),
            "{bob}"
        );
        // You do not hear your own, and another view does not hear it at all.
        assert!(!hub.presence_json("d", "alice").contains("pointer"));
        assert!(!hub.presence_json("d", "carol").contains("pointer"));
        // A new selection keeps the pointer; a new view drops it; null clears it.
        hub.set_presence("d", "alice", "canvas", Some(ID_A.to_owned()));
        assert!(hub.presence_json("d", "bob").contains("\"pointer\""));
        assert!(hub.set_pointer("d", "alice", None));
        assert!(!hub.presence_json("d", "bob").contains("pointer"));
        assert!(hub.set_pointer("d", "alice", Some((0, 0))));
        hub.set_presence("d", "alice", "inventory", None);
        hub.set_presence("d", "alice", "canvas", None);
        assert!(!hub.presence_json("d", "bob").contains("pointer"));
    }

    #[test]
    fn pointer_posts_have_their_own_bucket() {
        let hub = Hub::default();
        let pointers = (0..40).filter(|_| hub.allow_pointer("alice", "d")).count();
        assert_eq!(pointers, POINTER_BURST as usize);
        assert!(hub.allow_pointer("bob", "d"));
        // Presence is neither used up by pointers nor given more room.
        let presence = (0..40).filter(|_| hub.allow_presence("alice", "d")).count();
        assert_eq!(presence, PRESENCE_BURST as usize);
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

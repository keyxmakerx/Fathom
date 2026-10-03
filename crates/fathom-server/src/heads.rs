//! The head of each design being edited live (ADR-0063 §3).
//!
//! `Graph` is not `Send`, so heads live on a few worker threads, each owning
//! the heads of the designs that hash to it. A request sends a job and awaits
//! the answer; only bytes cross the boundary. Each shard keeps its heads in an
//! LRU capped by (estimated) bytes, and each head is keyed by the version and
//! the design chain's tip seal it was built at, so a head that no longer
//! matches storage is rebuilt rather than trusted.
//!
//! A change is applied to a copy, and the copy is held as the shard's pending
//! head until the caller reports the transaction's outcome: [`HeadStore::commit`]
//! swaps it in, [`HeadStore::abort`] drops it. A lost report only costs a
//! rebuild, because the next lookup compares the key.

use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::thread;

use fathom_graph::{Actor, Graph, UserId};
use fathom_id::Ulid;
use fathom_workspace::{apply_change_in_place, read_change, read_plain, write_plain};
use tokio::sync::oneshot;

/// What a head was built at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeadKey {
    pub design: String,
    pub version: i64,
    /// The newest seal on the design's chain.
    pub tip: Vec<u8>,
}

/// What it takes to build a head from storage: a full face, and the changes
/// after it with their authors, in version order.
pub struct Rebuild {
    pub base: Vec<u8>,
    pub changes: Vec<(Vec<u8>, Ulid)>,
}

#[derive(Debug)]
pub enum HeadError {
    /// No head at that key; send the inputs to build one.
    NeedRebuild,
    /// The inputs would not load. The caller may try an older base.
    Rebuild(String),
    /// The change was refused; the reason is one sentence for the person.
    Refused(String),
    /// The worker is gone (a panic dropped the job).
    Gone,
}

/// A change applied to a copy of the head and awaiting the commit.
pub struct Applied {
    pub ticket: u64,
    /// The full face of the new head, when asked for (a checkpoint).
    pub plain: Option<Vec<u8>>,
}

/// In-memory bytes are several times the serialised size.
const COST_FACTOR: usize = 6;

struct Head {
    graph: Graph,
    version: i64,
    tip: Vec<u8>,
    cost: usize,
    used: u64,
}

#[derive(Default)]
struct Shard {
    heads: BTreeMap<String, Head>,
    pending: BTreeMap<String, (u64, Graph, usize)>,
    clock: u64,
    next_ticket: u64,
    bytes: usize,
    cap: usize,
}

type Job = Box<dyn FnOnce(&mut Shard) + Send>;

pub struct HeadStore {
    shards: Vec<mpsc::Sender<Job>>,
}

fn build(rebuild: &Rebuild) -> Result<(Graph, usize), String> {
    let mut graph = read_plain(&rebuild.base).map_err(|e| format!("base face: {e:?}"))?;
    let mut cost = rebuild.base.len();
    for (doc, author) in &rebuild.changes {
        let change = read_change(doc).map_err(|e| format!("stored change: {e}"))?;
        apply_change_in_place(&mut graph, &change, Actor::User(UserId(*author)))
            .map_err(|e| format!("stored change: {e}"))?;
        cost += doc.len();
    }
    Ok((graph, cost.saturating_mul(COST_FACTOR)))
}

impl Shard {
    fn touch(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn insert(&mut self, design: &str, mut head: Head) {
        head.used = self.touch();
        if let Some(old) = self.heads.remove(design) {
            self.bytes -= old.cost;
        }
        self.bytes += head.cost;
        self.heads.insert(design.to_owned(), head);
        // Evict least recently used until under the cap; the head just
        // inserted stays even if it alone is over.
        while self.bytes > self.cap && self.heads.len() > 1 {
            let oldest = self
                .heads
                .iter()
                .filter(|(d, _)| d.as_str() != design)
                .min_by_key(|(_, h)| h.used)
                .map(|(d, _)| d.clone());
            let Some(oldest) = oldest else { break };
            if let Some(h) = self.heads.remove(&oldest) {
                self.bytes -= h.cost;
            }
        }
    }

    /// The head at `key`, or build it from `rebuild`.
    fn head_at(&mut self, key: &HeadKey, rebuild: Option<&Rebuild>) -> Result<(), HeadError> {
        let hit = self
            .heads
            .get(&key.design)
            .is_some_and(|h| h.version == key.version && h.tip == key.tip);
        if hit {
            let used = self.touch();
            if let Some(h) = self.heads.get_mut(&key.design) {
                h.used = used;
            }
            return Ok(());
        }
        let Some(rebuild) = rebuild else {
            return Err(HeadError::NeedRebuild);
        };
        let (graph, cost) = build(rebuild).map_err(HeadError::Rebuild)?;
        self.insert(
            &key.design,
            Head {
                graph,
                version: key.version,
                tip: key.tip.clone(),
                cost,
                used: 0,
            },
        );
        Ok(())
    }

    fn apply(
        &mut self,
        key: &HeadKey,
        rebuild: Option<&Rebuild>,
        change: &[u8],
        actor: Ulid,
        want_plain: bool,
    ) -> Result<Applied, HeadError> {
        self.head_at(key, rebuild)?;
        let head = &self.heads[&key.design];
        let doc = read_change(change).map_err(|e| HeadError::Refused(e.to_string()))?;
        let mut next = head.graph.clone();
        apply_change_in_place(&mut next, &doc, Actor::User(UserId(actor)))
            .map_err(|e| HeadError::Refused(e.to_string()))?;
        let plain = if want_plain {
            Some(write_plain(&next).map_err(|e| HeadError::Rebuild(format!("{e:?}")))?)
        } else {
            None
        };
        let cost = head.cost.saturating_add(change.len() * COST_FACTOR);
        self.next_ticket += 1;
        let ticket = self.next_ticket;
        self.pending
            .insert(key.design.clone(), (ticket, next, cost));
        Ok(Applied { ticket, plain })
    }
}

impl HeadStore {
    /// `threads` workers sharing `cap_bytes` between them.
    pub fn new(threads: usize, cap_bytes: usize) -> Self {
        let threads = threads.max(1);
        let mut shards = Vec::with_capacity(threads);
        for i in 0..threads {
            let (tx, rx) = mpsc::channel::<Job>();
            let cap = cap_bytes / threads;
            let spawned = thread::Builder::new()
                .name(format!("fathom-heads-{i}"))
                .spawn(move || {
                    let mut shard = Shard {
                        cap,
                        ..Shard::default()
                    };
                    for job in rx {
                        // A panic drops the job (its caller sees `Gone`) and
                        // the shard's heads, which are rebuilt on demand.
                        if catch_unwind(AssertUnwindSafe(|| job(&mut shard))).is_err() {
                            shard.heads.clear();
                            shard.pending.clear();
                            shard.bytes = 0;
                        }
                    }
                });
            if spawned.is_err() {
                tracing::error!("could not start a head worker thread");
            }
            shards.push(tx);
        }
        Self { shards }
    }

    fn shard_of(&self, design: &str) -> &mpsc::Sender<Job> {
        // FNV-1a over the id: stable, no extra state.
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in design.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        &self.shards[(h % self.shards.len() as u64) as usize]
    }

    async fn run<T: Send + 'static>(
        &self,
        design: &str,
        job: impl FnOnce(&mut Shard) -> T + Send + 'static,
    ) -> Result<T, HeadError> {
        let (tx, rx) = oneshot::channel();
        let boxed: Job = Box::new(move |shard| {
            let _ = tx.send(job(shard));
        });
        self.shard_of(design)
            .send(boxed)
            .map_err(|_| HeadError::Gone)?;
        rx.await.map_err(|_| HeadError::Gone)
    }

    /// The head's full face at `key`.
    pub async fn plain(
        &self,
        key: &HeadKey,
        rebuild: Option<Rebuild>,
    ) -> Result<Vec<u8>, HeadError> {
        let key = key.clone();
        self.run(&key.design.clone(), move |shard| {
            shard.head_at(&key, rebuild.as_ref())?;
            write_plain(&shard.heads[&key.design].graph)
                .map_err(|e| HeadError::Rebuild(format!("{e:?}")))
        })
        .await?
    }

    /// Apply a change document to a copy of the head at `key`.
    pub async fn apply(
        &self,
        key: &HeadKey,
        rebuild: Option<Rebuild>,
        change: Vec<u8>,
        actor: Ulid,
        want_plain: bool,
    ) -> Result<Applied, HeadError> {
        let key = key.clone();
        self.run(&key.design.clone(), move |shard| {
            shard.apply(&key, rebuild.as_ref(), &change, actor, want_plain)
        })
        .await?
    }

    /// The transaction that stored `ticket`'s change committed: the copy
    /// becomes the head at `version`, `tip`.
    pub fn commit(&self, design: &str, ticket: u64, version: i64, tip: Vec<u8>) {
        let shard = self.shard_of(design);
        let design = design.to_owned();
        let job: Job = Box::new(move |shard| {
            if shard.pending.get(&design).is_some_and(|p| p.0 == ticket) {
                if let Some((_, graph, cost)) = shard.pending.remove(&design) {
                    shard.insert(
                        &design,
                        Head {
                            graph,
                            version,
                            tip,
                            cost,
                            used: 0,
                        },
                    );
                }
            }
        });
        let _ = shard.send(job);
    }

    /// The transaction did not commit: drop the copy.
    pub fn abort(&self, design: &str, ticket: u64) {
        let shard = self.shard_of(design);
        let design = design.to_owned();
        let job: Job = Box::new(move |shard| {
            if shard.pending.get(&design).is_some_and(|p| p.0 == ticket) {
                shard.pending.remove(&design);
            }
        });
        let _ = shard.send(job);
    }
}

/// A face rebuilt from storage without touching any cache (a past version, or
/// a caller with no store).
pub async fn replay(rebuild: Rebuild) -> Result<Vec<u8>, HeadError> {
    tokio::task::spawn_blocking(move || {
        let (graph, _) = build(&rebuild).map_err(HeadError::Rebuild)?;
        write_plain(&graph).map_err(|e| HeadError::Rebuild(format!("{e:?}")))
    })
    .await
    .map_err(|_| HeadError::Gone)?
}

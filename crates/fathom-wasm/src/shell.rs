//! Opcode dispatch over WO-07 §4.4's byte protocol. One call, one reply; a
//! failure is a typed error record, never a trap or an unwind across the
//! boundary (41 §3.9).
//!
//! The shell owns the module's only mutable state: the finder, absent until
//! `OP_INIT` succeeds. Nothing here reads a clock, draws entropy or touches a
//! filesystem, which is why the built module's import section is empty
//! (`wasmbin::IMPORT_ALLOWLIST`).

use fathom_corpus::{CorpusIndex, Section, SourceFile};
use fathom_find::Finder;

use crate::protocol::{
    self, ERR_BAD_FRAME, ERR_BAD_UTF8, ERR_CABLE_COUNT, ERR_CABLE_END, ERR_CORPUS_LOAD,
    ERR_EQUIP_FRAME, ERR_EQUIP_STORE, ERR_FIELD_VALUE, ERR_INGEST_REFUSED, ERR_LINK_CHOICE,
    ERR_NOTHING_UNDERSTOOD, ERR_NOT_INITIALISED, ERR_NO_CABLE, ERR_NO_DICTIONARY, ERR_NO_ELEMENT,
    ERR_NO_LINK, ERR_PASTE_CHOICE, ERR_PASTE_FRAME, ERR_PLAIN_REFUSED, ERR_RESYNC, ERR_UNKNOWN_OP,
    ERR_WELD_REFUSED,
};
#[cfg(feature = "demo-estate")]
use crate::OP_ESTATE_DEMO;
use crate::{
    OP_CABLE, OP_CHECKS, OP_CHECK_GESTURE, OP_DIAGRAM, OP_DICT, OP_ELEMENT, OP_ELEMENT_REMOVE,
    OP_EQUIPMENT, OP_EQUIP_ADD, OP_EXPORT_PLAIN, OP_FIELD_SET, OP_FINDINGS, OP_INIT, OP_INSIDE,
    OP_INV_ROWS, OP_LINK, OP_LOAD_PLAIN, OP_PASTE, OP_PASTE_INTO, OP_PLACE, OP_QUERY,
    OP_RACK_ELEVATION, OP_RACK_PLACE, OP_REDACT_TEXT, OP_SYNC, OP_TRACE,
};

pub struct Shell {
    finder: Option<Finder>,
    /// The inventory face's graph (WO-08 §4.4). Absent until `OP_PASTE` or
    /// `OP_EQUIP_ADD` succeeds; the only workspace this build holds. `OP_ESTATE_DEMO`
    /// is gone from the shipping module (see `estate_demo`).
    estate: Option<fathom_graph::Graph>,
    /// The schema version `OP_LOAD_PLAIN` last read the estate under; a delta must declare it.
    estate_schema: String,
    /// The junos-srx statement dictionary, handed in over `OP_DICT` and held for the
    /// module's lifetime. Absent until that succeeds, so `OP_PASTE` can refuse with
    /// `ERR_NO_DICTIONARY`.
    dict: Option<fathom_ingest::dict::Dictionary>,
    /// The OPNsense firewall-rules dictionary, likewise. A second slot, not a
    /// replacement: a paste chooses one and the other must remain for the next.
    csv_dict: Option<fathom_ingest::dict::Dictionary>,
    /// The rule pack and its cache over `estate` (ADR-0061 §5).
    checks: crate::checks::Checks,
}

impl Shell {
    pub fn new() -> Shell {
        Shell {
            finder: None,
            estate: None,
            estate_schema: fathom_ir::generated::ir_types::SCHEMA_VERSION.to_owned(),
            dict: None,
            csv_dict: None,
            checks: crate::checks::Checks::new(),
        }
    }

    /// One call, one reply (empty = success with nothing to say).
    pub fn handle(&mut self, op: u32, req: &[u8]) -> Vec<u8> {
        match op {
            OP_INIT => match self.init(req) {
                Ok(()) => Vec::new(),
                Err((code, detail)) => protocol::encode_error(code, &detail),
            },
            OP_QUERY => self.query(req),
            // Called ONCE PER PLATFORM; the dictionary's own `platform:` line decides the
            // slot, not call order or a frame field. `from_sources` already refuses a file
            // set whose platforms disagree, so a dictionary has exactly one platform.
            //
            // A platform byte in the frame was rejected: it would let a page label a
            // dictionary something its YAML does not say, so one platform's grammar would
            // read a paste provenanced as another's, unnoticed.
            OP_DICT => match crate::dictframe::load(req) {
                Ok(d) => {
                    if d.platform() == "opnsense" {
                        self.csv_dict = Some(d);
                    } else {
                        self.dict = Some(d);
                    }
                    Vec::new()
                }
                Err((code, detail)) => protocol::encode_error(code, &detail),
            },
            #[cfg(feature = "demo-estate")]
            OP_ESTATE_DEMO => self.estate_demo(req),
            OP_PASTE => self.paste(req),
            OP_PASTE_INTO => self.paste_into(req),
            OP_REDACT_TEXT => self.redact_text(req),
            OP_LOAD_PLAIN => self.load_plain(req),
            OP_SYNC => self.sync(req),
            OP_EXPORT_PLAIN => self.export_plain(req),
            OP_EQUIP_ADD => self.equip_add(req),
            OP_FIELD_SET => self.field_set(req),
            OP_ELEMENT_REMOVE => self.element_remove(req),
            OP_PLACE => self.place(req),
            OP_LINK => self.link(req),
            OP_CABLE => self.cable(req),
            OP_DIAGRAM => self.diagram(req),
            OP_INV_ROWS => self.inv_rows(req),
            OP_ELEMENT => self.element(req),
            OP_EQUIPMENT => self.equipment(req),
            OP_RACK_PLACE => self.rack_place(req),
            OP_RACK_ELEVATION => self.rack_elevation(req),
            OP_FINDINGS => self.findings(req),
            OP_CHECKS => self.checks(req),
            OP_CHECK_GESTURE => self.check_gesture(req),
            OP_INSIDE => self.inside(req),
            OP_TRACE => self.trace(req),
            _ => protocol::encode_error(
                ERR_UNKNOWN_OP,
                &format!("opcode {op} is not implemented by this module"),
            ),
        }
    }

    /// No request bytes. Re-init is permitted, as `OP_INIT`: the held estate is
    /// replaced.
    ///
    /// **Not in the shipping module.** The fixture costs 35,272 bytes of `44` §5.2's
    /// ceiling, so `fathom-inventory`'s `demo-estate` feature is off except in test
    /// builds. Without it, opcode 11 falls to the `_` arm and is refused by number
    /// with `ERR_UNKNOWN_OP`, a typed refusal. The NUMBER stays reserved: 41 §3.7's
    /// table is append-only.
    #[cfg(feature = "demo-estate")]
    fn estate_demo(&mut self, req: &[u8]) -> Vec<u8> {
        if !req.is_empty() {
            return protocol::encode_error(
                ERR_BAD_FRAME,
                &format!("OP_ESTATE_DEMO takes no request; got {} bytes", req.len()),
            );
        }
        self.estate = Some(fathom_inventory::demo_estate());
        Vec::new()
    }

    /// The dictionary choice, the ingest run, and the two typed refusals both paste
    /// doors share (`OP_PASTE`, `OP_PASTE_INTO`, ADR-0052 §4): no dictionary yet, and
    /// a paste that bound nothing.
    ///
    /// Returns the platform name as an owned `String`, since the caller's weld needs
    /// `self.estate` mutably borrowed while `platform` is live, and a borrow of
    /// `self.dict`/`self.csv_dict` cannot outlive that.
    fn ingest_paste_text(
        &self,
        text: &[u8],
    ) -> Result<(fathom_ingest::IngestOutput, String), Vec<u8>> {
        // Which grammar? The sniff is exact: the first non-blank line must begin `@uuid`
        // then `;` or `,`, the OPNsense Migration assistant's header (`64` §1.1). A
        // fuzzy sniff would sometimes read Junos as a table and replace the estate with
        // nonsense.
        let table = fathom_ingest::csv::looks_like_rules_csv(text);

        // No fallback, by design: the dictionary bytes live in the page
        // (`crate::dictframe`), and carrying on with an empty one binds nothing, telling
        // the operator their config is unrecognised when the page never finished
        // booting.
        //
        // Two slots, and the refusals are worded apart: a page that booted one
        // dictionary but not the other is a different defect from one that booted
        // neither, and "no dictionary" would send the reader to the wrong place.
        let held = if table {
            self.csv_dict.as_ref()
        } else {
            self.dict.as_ref()
        };
        let Some(dict) = held else {
            return Err(protocol::encode_error(
                ERR_NO_DICTIONARY,
                if table {
                    "no table dictionary is loaded: OP_DICT must hand in a rules-CSV \
                     dictionary before a rules export can be read"
                } else {
                    "no statement dictionary is loaded: OP_DICT must succeed before OP_PASTE"
                },
            ));
        };

        let read = if table {
            fathom_ingest::csv::ingest_csv(text, dict)
        } else {
            fathom_ingest::ingest(text, dict)
        };
        let ingest = match read {
            Ok(o) => o,
            Err(e) => return Err(protocol::encode_error(ERR_INGEST_REFUSED, &refusal_text(e))),
        };

        // A paste that bound nothing is not an estate. The binder seeds a `Device` root
        // before reading a statement, so a Cisco config, or Junos in curly-brace form,
        // would validate, weld and **silently replace the operator's estate with an empty
        // device**.
        //
        // The criterion is exact (zero `Bound` lines); only the *wording* below guesses.
        if bound_lines(&ingest) == 0 {
            return Err(protocol::encode_error(
                ERR_NOTHING_UNDERSTOOD,
                &nothing_understood(&ingest),
            ));
        }

        Ok((ingest, dict.platform().to_owned()))
    }

    /// `OP_REDACT_TEXT`: the gate alone, for a pasted note (ADR-0053 §6); see
    /// [`crate::OP_REDACT_TEXT`] for the frame and reply.
    ///
    /// Set-form dictionary only: a note has no platform to sniff, and
    /// `fathom_ingest::redact_only`'s stages are the Junos-set-form ones `self.dict`
    /// was loaded for. Writes nothing: `self.estate` is untouched on success or
    /// refusal.
    fn redact_text(&self, req: &[u8]) -> Vec<u8> {
        let Some(dict) = self.dict.as_ref() else {
            return protocol::encode_error(
                ERR_NO_DICTIONARY,
                "no statement dictionary is loaded: OP_DICT must succeed before OP_REDACT_TEXT",
            );
        };
        match fathom_ingest::redact_only(req, dict) {
            Ok(out) => {
                let drops = drop_rows(&out.drops);
                protocol::encode_redact_reply(&protocol::RedactReply {
                    capture: out.text.text(),
                    drops: &drops,
                })
            }
            Err(e) => protocol::encode_error(ERR_INGEST_REFUSED, &refusal_text(e)),
        }
    }

    /// `OP_PASTE`: pasted text in, an estate out.
    ///
    /// Frame: a fixed 25-byte prefix (clock, entropy, confirm), then the paste:
    ///
    /// ```text
    ///   0   8   at_ms   (u64) the host's clock, once, for the whole apply
    ///   8  16   entropy (u128) the host's CSPRNG, once, the mint's base
    ///  24   ..  the pasted bytes, verbatim and un-decoded
    /// ```
    ///
    /// The host supplies clock and entropy because this module has neither and must
    /// not acquire either (`wasmbin::IMPORT_ALLOWLIST`; invariant 9). The paste stays
    /// **un-decoded** so `ingest` can report the first bad byte's offset.
    ///
    /// On success the held estate is replaced. A refusal leaves the previous one.
    fn paste(&mut self, req: &[u8]) -> Vec<u8> {
        // 25, not 24: the clock, the entropy, and one byte of CONFIRMATION. `confirm ==
        // 1` means the operator was shown `ERR_PASTE_CHOICE` and said the two boxes are
        // different. It is not a mode; there is deliberately no "replace" flag.
        const PREFIX: usize = 25;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!(
                    "OP_PASTE needs a {PREFIX}-byte clock, entropy and confirm prefix; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let (at_bytes, rest) = head.split_at(8);
        let (entropy_bytes, confirm_bytes) = rest.split_at(16);
        let mut at = [0u8; 8];
        at.copy_from_slice(at_bytes);
        let mut entropy = [0u8; 16];
        entropy.copy_from_slice(entropy_bytes);
        let at = fathom_graph::Timestamp(u64::from_le_bytes(at));
        let entropy = u128::from_le_bytes(entropy);
        let confirmed = confirm_bytes[0] == 1;
        let text = req.get(PREFIX..).unwrap_or_default();

        let (ingest, platform) = match self.ingest_paste_text(text) {
            Ok(v) => v,
            Err(reply) => return reply,
        };

        // THE BATCH ID IS DERIVED FROM THE ENTROPY, NOT A CONSTANT. A fixed discriminator
        // was safe only while a paste discarded the estate; once pastes became additive a
        // second paste reused the batch id and the store refused it with `BatchIdReused`.
        //
        // Fresh entropy per call gives each paste its own batch and is still
        // deterministic: the same `(at, entropy)` gives the same bytes (replay). A clash
        // with an ELEMENT ulid is harmless: batches are checked only against batches.
        let Ok(batch) = fathom_id::Ulid::from_parts(at.0, entropy) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!(
                    "the clock reads {} ms, which is past the ULID ceiling",
                    at.0
                ),
            );
        };
        let manifest = fathom_weld::Manifest {
            at,
            entropy,
            actor: fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
            batch: fathom_graph::BatchId(batch),
            label: PASTE_LABEL,
            platform: fathom_ir::scalar::PlatformId(platform.clone()),
        };

        // ---- 1. THE DRY RUN, into a graph nobody will see ----
        //
        // The weld runs twice on purpose: every refusal it can raise happens BEFORE the
        // operator's estate is touched, and the identity check gets a real `Device`.
        // `apply_new_device` leaves a partial batch OPEN on error (`fathom-graph` has no
        // rollback), harmless on a throwaway.
        let mut dry = fathom_graph::Graph::new();
        let dry_weld = match fathom_weld::apply_new_device(&mut dry, &ingest, &manifest) {
            Ok(w) => w,
            Err(e) => return protocol::encode_error(ERR_WELD_REFUSED, &format!("{e:?}")),
        };

        // ---- 2. IS THIS A BOX THE DESIGN ALREADY HOLDS? ----
        if !confirmed {
            if let Some(existing) = self.estate.as_ref() {
                if let Some(clash) = identity_clash(existing, &dry) {
                    return protocol::encode_error(ERR_PASTE_CHOICE, &clash);
                }
            }
        }

        // ---- 2b. THE RANGE PRE-FLIGHT: read-only, so the real weld cannot fail ----
        //
        // `apply_new_device` opens its batch first and there is no rollback, so an id
        // collision mid-weld would leave a partial batch in the operator's estate. The
        // dry run makes the check exact: the mint walks a contiguous 80-bit counter from
        // `entropy & mask` with one timestamp, and `dry_weld.minted` is how many ids the
        // real weld will issue. Each is asked about read-only (elements and provenance
        // are separate namespaces; the batch id is scanned in the log).
        if let Some(existing) = self.estate.as_ref() {
            let base = entropy & ((1u128 << 80) - 1);
            let collides = (0..u128::from(dry_weld.minted)).any(|i| {
                let counter = (base + i) & ((1u128 << 80) - 1);
                let Ok(ulid) = fathom_id::Ulid::from_parts(at.0, counter) else {
                    return true;
                };
                existing.resolve_ref(fathom_id::NodeId(ulid)).is_some()
                    || existing
                        .provenance(fathom_graph::ProvenanceId(ulid))
                        .is_some()
            }) || existing
                .log()
                .iter()
                .any(|b| b.id == fathom_graph::BatchId(batch));
            if collides {
                return protocol::encode_error(
                    ERR_WELD_REFUSED,
                    &format!(
                        "this paste needs {} fresh identifiers and the ones it was given \
                         overlap identifiers this design already uses, so nothing was \
                         added. Nothing is wrong with the config or the design — paste \
                         it again and it will be given different ones.",
                        dry_weld.minted
                    ),
                );
            }
        }

        // ---- 3. THE REAL WELD, into the held estate ----
        //
        // ADDITIVE. A paste once REPLACED the design, which `49` §10b calls a bomb still
        // in the room: with many designs of thousands of devices, pasting a second
        // switch must not delete the first.
        //
        // `get_or_insert_with` is `equip_add`'s pattern, so an empty page and a
        // populated one take the same path.
        let graph = self.estate.get_or_insert_with(fathom_graph::Graph::new);
        let weld = match fathom_weld::apply_new_device(graph, &ingest, &manifest) {
            Ok(w) => w,
            Err(e) => {
                // THE STORE'S ID-COLLISION ERRORS MUST NOT REACH A PERSON AS RUST (a test saw
                // `Store(ProvenanceIdReused { .. })` rendered at an operator). Additive pastes
                // made them reachable: the mint walks a counter from the host's entropy, so two
                // pastes within `minted` of each other overlap. Vanishingly unlikely with sixteen
                // CSPRNG bytes, not impossible.
                //
                // `dry_weld.minted` says how much room was needed. With the pre-flight a
                // collision here should be unreachable; if one fires the estate MAY hold a
                // partial batch, so the sentence must not claim nothing was added. It must match
                // all three collision errors (`UlidReused` lacks "IdReused").
                let detail = format!("{e:?}");
                if detail.contains("Reused") {
                    return protocol::encode_error(
                        ERR_WELD_REFUSED,
                        "an identifier collision was hit part-way through writing this \
                         paste, which the pre-flight should have made impossible. The \
                         design may hold a partial copy of it: export what you have, \
                         then reopen the export to get back to a clean state, and \
                         please report this — it is a bug in Fathom, not in your config.",
                    );
                }
                return protocol::encode_error(ERR_WELD_REFUSED, &detail);
            }
        };

        paste_reply(graph, &ingest, &weld, &platform)
    }

    /// `OP_PASTE_INTO`: a config pasted under a device the operator has already placed
    /// (ADR-0052 §4); frame in [`crate::OP_PASTE_INTO`].
    ///
    /// **No identity-clash question**: choosing this faceplate is ADR-0010's human
    /// answer to "is this the same box". No dry-run pre-flight either; it guards an id
    /// collision this door cannot hit on a first paste. A second paste onto a device
    /// already carrying a `Capture` would duplicate its children, so `apply`
    /// (`fathom-weld`) refuses it (`WeldError::AlreadyCaptured`, surfaced as
    /// `ERR_WELD_REFUSED`) until reconciliation exists.
    fn paste_into(&mut self, req: &[u8]) -> Vec<u8> {
        const PREFIX: usize = 27;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!(
                    "OP_PASTE_INTO needs a {PREFIX}-byte clock, entropy, confirm and id-length \
                     prefix; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let at = fathom_graph::Timestamp(u64::from_le_bytes(le8(head, 0)));
        let entropy = u128::from_le_bytes(le16(head, 8));
        // Byte 24 is the confirm flag `OP_PASTE` carries; unused here.
        let id_len = usize::from(u16::from_le_bytes([
            *head.get(25).unwrap_or(&0),
            *head.get(26).unwrap_or(&0),
        ]));
        let Some(id_bytes) = req.get(PREFIX..PREFIX + id_len) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!("the display id claims {id_len} bytes and the frame has fewer"),
            );
        };
        let Ok(display) = core::str::from_utf8(id_bytes) else {
            return protocol::encode_error(ERR_BAD_UTF8, "the display id is not UTF-8");
        };
        let text = req.get(PREFIX + id_len..).unwrap_or_default();

        let device = match self.resolve(display) {
            Ok(fathom_graph::ElementId::Node(n))
                if n.kind == fathom_ir::generated::ir_types::NodeKind::Device =>
            {
                n
            }
            Ok(_) => {
                return protocol::encode_error(
                    ERR_NO_ELEMENT,
                    &format!("{display} does not name a live Device"),
                )
            }
            Err(reply) => return reply,
        };

        let (ingest, platform) = match self.ingest_paste_text(text) {
            Ok(v) => v,
            Err(reply) => return reply,
        };

        let Ok(batch) = fathom_id::Ulid::from_parts(at.0, entropy) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!(
                    "the clock reads {} ms, which is past the ULID ceiling",
                    at.0
                ),
            );
        };
        let manifest = fathom_weld::Manifest {
            at,
            entropy,
            actor: fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
            batch: fathom_graph::BatchId(batch),
            label: PASTE_INTO_LABEL,
            platform: fathom_ir::scalar::PlatformId(platform.clone()),
        };

        let Some(graph) = self.estate.as_mut() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        let weld = match fathom_weld::apply_into_device(graph, &ingest, &manifest, device) {
            Ok(w) => w,
            Err(e) => return protocol::encode_error(ERR_WELD_REFUSED, &format!("{e:?}")),
        };

        paste_reply(graph, &ingest, &weld, &platform)
    }

    /// `OP_LOAD_PLAIN`: the plain face in, the held estate out. Frame in
    /// [`crate::OP_LOAD_PLAIN`].
    fn load_plain(&mut self, req: &[u8]) -> Vec<u8> {
        let (graph, schema) = match fathom_workspace::read_plain_declared(req) {
            Ok(g) => g,
            Err(e) => return protocol::encode_error(ERR_PLAIN_REFUSED, &format!("{e:?}")),
        };
        let reply = load_plain_reply(&graph);
        self.estate = Some(graph);
        self.estate_schema = schema;
        reply
    }

    /// `OP_SYNC`: append the batches the module has not seen. Frame in [`crate::OP_SYNC`].
    fn sync(&mut self, req: &[u8]) -> Vec<u8> {
        let resync = |why: String| protocol::encode_error(ERR_RESYNC, &why);
        if req.len() > crate::SYNC_FRAME_MAX {
            return resync(format!(
                "the delta is {} bytes; the most OP_SYNC takes is {}",
                req.len(),
                crate::SYNC_FRAME_MAX
            ));
        }
        let Some(graph) = self.estate.as_mut() else {
            return resync("no estate loaded".to_owned());
        };
        let delta = match fathom_workspace::read_delta(req) {
            Ok(d) => d,
            Err(e) => return resync(format!("{e:?}")),
        };
        if delta.schema != self.estate_schema {
            return resync(format!(
                "the delta is schema {}, the estate was loaded as {}",
                delta.schema, self.estate_schema
            ));
        }
        if delta.base != graph.log().last().map(|b| b.id) {
            return resync(
                "the module does not end at the batch the delta starts after".to_owned(),
            );
        }
        // "From nothing" means an empty estate, not one that merely has no log.
        if delta.base.is_none()
            && (graph.nodes().next().is_some() || graph.edges().next().is_some())
        {
            return resync("the delta starts from nothing and the estate is not empty".to_owned());
        }
        match graph.apply_batches(&delta.fragment) {
            Ok(()) => {
                // The live node and edge counts the page checks against its document.
                let live_nodes = graph.nodes().filter(|n| n.absent_since.is_none()).count();
                let live_edges = graph.edges().filter(|e| e.absent_since.is_none()).count();
                let mut counts = (live_nodes as u32).to_le_bytes().to_vec();
                counts.extend_from_slice(&(live_edges as u32).to_le_bytes());
                counts
            }
            Err(e) => resync(format!("{e:?}")),
        }
    }

    /// `OP_EXPORT_PLAIN`: the held estate out as the plain face's raw bytes. See
    /// [`crate::OP_EXPORT_PLAIN`] for why the reply is not wrapped in `KIND_FACE_ROW`.
    fn export_plain(&self, req: &[u8]) -> Vec<u8> {
        if !req.is_empty() {
            return protocol::encode_error(
                ERR_BAD_FRAME,
                &format!("OP_EXPORT_PLAIN takes no request; got {} bytes", req.len()),
            );
        }
        let Some(graph) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        match fathom_workspace::write_plain(graph) {
            Ok(bytes) => bytes,
            Err(e) => protocol::encode_error(ERR_PLAIN_REFUSED, &format!("{e:?}")),
        }
    }

    /// `OP_EQUIP_ADD`: one piece of equipment, entered by hand.
    ///
    /// Frame: the 24-byte `OP_PASTE` prefix, then a field list:
    ///
    /// ```text
    ///   0   8   at_ms   (u64) the host's clock
    ///   8  16   entropy (u128) the host's CSPRNG
    ///  24   1   count   (u8) how many fields follow
    ///  25  ..   count x [u16 field_key][u16 byte_len][utf8 value]
    /// ```
    ///
    /// `Device` has no `model` field: model and serial live on `Chassis` (a cluster is
    /// one `Device` with two). So this opcode creates the `Chassis` silently
    /// (`member_index` 0 unless supplied) and routes each field to the kind that
    /// declares it, **derived** from `DeviceField::ALL` then `ChassisField::ALL`
    /// (generated from `schema/`), so a field moving between kinds needs no edit. The
    /// containment edge comes from `fathom_weld::containment_edge`.
    ///
    /// No `Site`: `11` §7.2's containment rule is an upper bound at write time, and
    /// inventing a site would assert an unasserted fact. No reconciliation: adding the
    /// same box twice makes two devices, as pasting twice does (`11` §10.4,
    /// unimplemented).
    fn equip_add(&mut self, req: &[u8]) -> Vec<u8> {
        use fathom_graph::{Actor, BatchId, ElementId, Timestamp, UserId};
        use fathom_ir::generated::ir_types::{ChassisField, DeviceField, NodeKind};

        const PREFIX: usize = 24;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!(
                    "OP_EQUIP_ADD needs a {PREFIX}-byte clock and entropy prefix; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let (at_bytes, entropy_bytes) = head.split_at(8);
        let mut at_raw = [0u8; 8];
        at_raw.copy_from_slice(at_bytes);
        let mut ent_raw = [0u8; 16];
        ent_raw.copy_from_slice(entropy_bytes);
        let at = Timestamp(u64::from_le_bytes(at_raw));
        let entropy = u128::from_le_bytes(ent_raw);

        let fields = match parse_field_list(req.get(PREFIX..).unwrap_or_default()) {
            Ok(f) => f,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &e),
        };

        // Both `Device` identity tuples need `platform`, and the schema declares hostname
        // and platform `card: "1"`. A device missing either can never be re-identified
        // or merged with a later paste, so it is refused at the door rather than stored
        // as an orphan. Nothing else is demanded.
        for (key, name) in [
            (DeviceField::Hostname.key(), "hostname"),
            (DeviceField::Platform.key(), "platform"),
        ] {
            if !fields.iter().any(|(k, _)| *k == key) {
                return protocol::encode_error(
                    ERR_EQUIP_FRAME,
                    &format!("a device needs a {name}: the schema declares it required, and both identity tuples use platform"),
                );
            }
        }

        // Route every field to the kind that declares it, from the generated tables. An
        // unroutable key is a page defect and says so.
        let mut on_device: Vec<(fathom_ir::bag::FieldKey, String)> = Vec::new();
        let mut on_chassis: Vec<(fathom_ir::bag::FieldKey, String)> = Vec::new();
        for (key, text) in fields {
            if DeviceField::ALL.iter().any(|f| f.key() == key) {
                on_device.push((key, text));
            } else if ChassisField::ALL.iter().any(|f| f.key() == key) {
                on_chassis.push((key, text));
            } else {
                return protocol::encode_error(
                    ERR_EQUIP_FRAME,
                    &format!(
                        "field key {} is declared by neither Device nor Chassis",
                        key.0
                    ),
                );
            }
        }

        // `Chassis.member_index` is `card: "1"`. Someone adding a standalone box need not
        // know that, so it is defaulted and overridden if the form sent one.
        if !on_chassis
            .iter()
            .any(|(k, _)| *k == ChassisField::MemberIndex.key())
        {
            on_chassis.push((ChassisField::MemberIndex.key(), "0".to_owned()));
        }

        // Parse everything BEFORE touching the store: a refusal must leave the estate
        // exactly as it was, since a half-written device is worse than a rejected form.
        let mut device_values = Vec::with_capacity(on_device.len());
        for (key, text) in &on_device {
            match fathom_inventory::parse_into_slot(*key, text) {
                Ok(v) => device_values.push((*key, v)),
                Err(e) => return protocol::encode_error(ERR_FIELD_VALUE, &author_text(e, text)),
            }
        }
        let mut chassis_values = Vec::with_capacity(on_chassis.len());
        for (key, text) in &on_chassis {
            match fathom_inventory::parse_into_slot(*key, text) {
                Ok(v) => chassis_values.push((*key, v)),
                Err(e) => return protocol::encode_error(ERR_FIELD_VALUE, &author_text(e, text)),
            }
        }

        // THE BATCH ID IS DERIVED FROM THE ENTROPY, as the paste's is, for the same
        // reason. `Ulid(at, 2)` (millisecond plus a fixed discriminator) was harmless
        // while every write landed in a fresh graph and collides once estates
        // accumulate: two hand edits in one millisecond (an import replays dozens) would
        // reuse a batch id and the second is refused as `BatchIdReused`. (The author
        // half is `UserId::LOCAL`; see its doc.)
        let Ok(batch) = fathom_id::Ulid::from_parts(at.0, entropy) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!(
                    "the clock reads {} ms, which is past the ULID ceiling",
                    at.0
                ),
            );
        };
        let actor = Actor::User(UserId::LOCAL);
        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };

        // The estate is CREATED when absent and MUTATED when present: you can start from
        // nothing, and adding a second device must not delete the first.
        let graph = self.estate.get_or_insert_with(fathom_graph::Graph::new);

        if let Err(e) = graph.begin_batch(BatchId(batch), EQUIP_LABEL) {
            return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
        }

        let build = || -> Result<(fathom_graph::NodeId, usize), String> {
            let mut written = 0usize;
            let device = graph
                .insert_node(
                    NodeKind::Device,
                    mint.next().map_err(|e| format!("{e:?}"))?,
                    hand_record(&mut mint, at, actor)?,
                )
                .map_err(|e| format!("{e:?}"))?;
            let chassis = graph
                .insert_node(
                    NodeKind::Chassis,
                    mint.next().map_err(|e| format!("{e:?}"))?,
                    hand_record(&mut mint, at, actor)?,
                )
                .map_err(|e| format!("{e:?}"))?;
            let edge = fathom_weld::containment_edge(NodeKind::Device, NodeKind::Chassis)
                .ok_or_else(|| {
                    "the schema declares no containment edge Device -> Chassis".to_owned()
                })?;
            graph
                .insert_edge(
                    edge,
                    mint.next().map_err(|e| format!("{e:?}"))?,
                    device,
                    chassis,
                    hand_record(&mut mint, at, actor)?,
                )
                .map_err(|e| format!("{e:?}"))?;

            for (element, values) in [
                (ElementId::Node(device), device_values),
                (ElementId::Node(chassis), chassis_values),
            ] {
                for (key, value) in values {
                    graph
                        .set_field_boxed(element, key, value, hand_record(&mut mint, at, actor)?)
                        .map_err(|e| format!("{e:?}"))?;
                    written += 1;
                }
            }
            Ok((device, written))
        };

        let built = build();
        // The batch closes either way: leaving one open would refuse every later write
        // with `BatchOpen`, turning one bad form into a dead page.
        let closed = graph.end_batch();
        match (built, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &e),
            (Ok(_), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok((device, written)), Ok(_)) => equip_reply(device, written),
        }
    }

    /// `OP_FIELD_SET`: correct one field of one element.
    ///
    /// Frame: the usual prefix, then the key, then text:
    ///
    /// ```text
    ///   0   8   at_ms   (u64)
    ///   8  16   entropy (u128)
    ///  24   4   field key (u32)
    ///  28   2   display-id byte length (u16)
    ///  30  ..   the display id, utf8
    ///   ..  ..  the new value, utf8, to the end of the frame
    /// ```
    ///
    /// The value is parsed **before** the batch opens, so a refusal leaves no open
    /// batch or half-written slot.
    fn field_set(&mut self, req: &[u8]) -> Vec<u8> {
        use fathom_graph::{Actor, BatchId, ElementId, Timestamp, UserId};

        const PREFIX: usize = 30;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!(
                    "OP_FIELD_SET needs a {PREFIX}-byte header; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let at = Timestamp(u64::from_le_bytes(le8(head, 0)));
        let entropy = u128::from_le_bytes(le16(head, 8));
        let key = fathom_ir::bag::FieldKey(u32::from_le_bytes(le4(head, 24)));
        let id_len = usize::from(u16::from_le_bytes([
            *head.get(28).unwrap_or(&0),
            *head.get(29).unwrap_or(&0),
        ]));

        let Some(id_bytes) = req.get(PREFIX..PREFIX + id_len) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!("the display id claims {id_len} bytes and the frame has fewer"),
            );
        };
        let (Ok(display), Ok(value)) = (
            core::str::from_utf8(id_bytes),
            core::str::from_utf8(req.get(PREFIX + id_len..).unwrap_or_default()),
        ) else {
            return protocol::encode_error(
                ERR_BAD_UTF8,
                "the display id or the value is not UTF-8",
            );
        };

        // Parse first: a refused value must not open a batch.
        let parsed = match fathom_inventory::parse_into_slot(key, value) {
            Ok(v) => v,
            Err(e) => return protocol::encode_error(ERR_FIELD_VALUE, &author_text(e, value)),
        };

        let element = match self.resolve(display) {
            Ok(e) => e,
            Err(reply) => return reply,
        };

        // Batch and provenance ids come off the MINT, not clock plus a discriminator as
        // `OP_PASTE` derives its two (safe there: one batch from a fresh graph). Here,
        // two corrections in one millisecond, one keystroke apart, would mint the same
        // BatchId and ProvenanceId and the store refuses both as reused. The mint walks
        // a counter from the host's entropy.
        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };
        // The author is UserId::LOCAL, a constant, so only the two mints can fail. A
        // host-clock author made every millisecond a different "user".
        let (Ok(batch), Ok(prov)) = (mint.next(), mint.next()) else {
            return protocol::encode_error(ERR_EQUIP_FRAME, "the clock is past the ULID ceiling");
        };

        let Some(graph) = self.estate.as_mut() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        if let Err(e) = graph.begin_batch(BatchId(batch), EDIT_LABEL) {
            return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
        }
        let record = fathom_graph::ProvenanceRecord {
            id: fathom_graph::ProvenanceId(prov),
            origin: fathom_graph::Origin::Hand,
            asserted_at: at,
            asserted_by: Actor::User(UserId::LOCAL),
            confidence: fathom_graph::Confidence::Asserted,
            supersedes: None,
        };
        let wrote = graph.set_field_boxed(element, key, parsed, record);
        let closed = graph.end_batch();
        match (wrote, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok(()), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok(()), Ok(_)) => {
                let id = match element {
                    ElementId::Node(n) => n.to_string(),
                    ElementId::Edge(_) => display.to_owned(),
                };
                equip_reply_text(&id, "1")
            }
        }
    }

    /// `OP_ELEMENT_REMOVE`: tombstone an element and its subtree. Frame: the 24-byte
    /// prefix, then the display id to the end.
    fn element_remove(&mut self, req: &[u8]) -> Vec<u8> {
        use fathom_graph::{BatchId, Timestamp};

        const PREFIX: usize = 24;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!(
                    "OP_ELEMENT_REMOVE needs a {PREFIX}-byte header; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let at = Timestamp(u64::from_le_bytes(le8(head, 0)));
        let entropy = u128::from_le_bytes(le16(head, 8));
        let Ok(display) = core::str::from_utf8(req.get(PREFIX..).unwrap_or_default()) else {
            return protocol::encode_error(ERR_BAD_UTF8, "the display id is not UTF-8");
        };

        let element = match self.resolve(display) {
            Ok(e) => e,
            Err(reply) => return reply,
        };
        // Off the mint, as `field_set`: two removals in one millisecond must not collide
        // on a BatchId.
        let batch = match fathom_weld::Mint::new(at, entropy).and_then(|mut m| m.next()) {
            Ok(b) => b,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };
        let Some(graph) = self.estate.as_mut() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        if let Err(e) = graph.begin_batch(BatchId(batch), REMOVE_LABEL) {
            return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
        }
        let removed = graph.tombstone(
            element,
            at,
            fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
        );
        let closed = graph.end_batch();
        match (removed, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok(()), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok(()), Ok(_)) => equip_reply_text(display, "0"),
        }
    }

    /// `OP_PLACE`: put a box somewhere, or put it back under computed layout.
    ///
    /// Frame: the 24-byte prefix, a mode byte, the point, then the display id to the
    /// end:
    ///
    /// ```text
    ///   0   8   at_ms   (u64)
    ///   8  16   entropy (u128)
    ///  24   1   mode    (u8) 0 = free (drop the pin), 1 = place at (x, y)
    ///  25   4   x       (i32, little-endian)
    ///  29   4   y       (i32, little-endian)
    ///  33  ..   the display id, utf8, to the end of the frame
    /// ```
    ///
    /// The page must not reimplement these:
    ///
    /// **Snapping happens here**: `56` §3.5's 4 px grid via `fathom_layout::snap`, so
    /// every host agrees where a gesture landed (invariant 9).
    ///
    /// **Moving a placed box is a supersession, not a second pin.** The pin's `x` and
    /// `y` are set again and `Graph::set_field_boxed` archives the old slots, keeping
    /// *"where was this before, and who moved it"*. A second pin would break
    /// `HasLayoutPin`'s `out: "0..1"`.
    ///
    /// **Mode 0 on an unpinned element succeeds and does nothing**: "put it back under
    /// computed layout" describes the end state, so pressing it twice is no error.
    ///
    /// Every id comes off the `Mint`: dragging is a stream of gestures a millisecond
    /// apart (see `field_set`).
    fn place(&mut self, req: &[u8]) -> Vec<u8> {
        use fathom_graph::{Actor, BatchId, ElementId, Timestamp, UserId};
        use fathom_ir::generated::ir_types::{EdgeKind, LayoutPinField, NodeKind};

        const PREFIX: usize = 33;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!(
                    "OP_PLACE needs a {PREFIX}-byte header; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let at = Timestamp(u64::from_le_bytes(le8(head, 0)));
        let entropy = u128::from_le_bytes(le16(head, 8));
        let mode = *head.get(24).unwrap_or(&0);
        let x = fathom_layout::snap(i32::from_le_bytes(le4(head, 25)));
        let y = fathom_layout::snap(i32::from_le_bytes(le4(head, 29)));
        let Ok(display) = core::str::from_utf8(req.get(PREFIX..).unwrap_or_default()) else {
            return protocol::encode_error(ERR_BAD_UTF8, "the display id is not UTF-8");
        };

        // A NODE, not an element. An edge is a line between two boxes with no position
        // of its own; it is routed from its ends. Refusing here, rather than storing a
        // pin the schema forbids (`HasLayoutPin` runs from `Placeable`, which is kinds),
        // keeps the refusal legible.
        let subject = match self.resolve(display) {
            Ok(ElementId::Node(n)) => n,
            Ok(ElementId::Edge(_)) => {
                return protocol::encode_error(
                    ERR_NO_ELEMENT,
                    &format!("{display} is a link, and a link is drawn from its ends, not placed"),
                )
            }
            Err(reply) => return reply,
        };

        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };
        // The author is a CONSTANT, so only the batch mint can fail. See
        // `UserId::LOCAL`.
        let Ok(batch) = mint.next() else {
            return protocol::encode_error(ERR_EQUIP_FRAME, "the clock is past the ULID ceiling");
        };
        let actor = Actor::User(UserId::LOCAL);

        let existing = self
            .estate
            .as_ref()
            .and_then(|g| fathom_layout::pin_node(g, subject));
        let Some(graph) = self.estate.as_mut() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        let label = if mode == 0 { FREE_LABEL } else { PLACE_LABEL };
        if let Err(e) = graph.begin_batch(BatchId(batch), label) {
            return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
        }

        let mut write = || -> Result<(), String> {
            if mode == 0 {
                // Tombstone, never delete (`11` §10.5): the record keeps "this box was placed
                // here and then released", more honest than "it was never placed".
                if let Some(pin) = existing {
                    graph
                        .tombstone(ElementId::Node(pin), at, actor)
                        .map_err(|e| format!("{e:?}"))?;
                }
                return Ok(());
            }
            let pin = match existing {
                Some(p) => p,
                None => {
                    let p = graph
                        .insert_node(
                            NodeKind::LayoutPin,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    graph
                        .insert_edge(
                            EdgeKind::HasLayoutPin,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            subject,
                            p,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    p
                }
            };
            for (key, value) in [(LayoutPinField::X.key(), x), (LayoutPinField::Y.key(), y)] {
                graph
                    .set_field(
                        ElementId::Node(pin),
                        key,
                        value,
                        hand_record(&mut mint, at, actor)?,
                    )
                    .map_err(|e| format!("{e:?}"))?;
            }
            Ok(())
        };

        let wrote = write();
        // The batch closes either way: an open batch refuses every later write with
        // `BatchOpen`, turning one refused drag into a dead page.
        let closed = graph.end_batch();
        match (wrote, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &e),
            (Ok(()), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok(()), Ok(_)) => equip_reply_text(display, if mode == 0 { "0" } else { "1" }),
        }
    }

    /// `OP_LINK`: draw a link between two boxes by hand, or cut one.
    ///
    /// Frame: the 24-byte prefix, a mode byte, two lengths, then three strings back to
    /// back:
    ///
    /// ```text
    ///   0   8   at_ms   (u64)
    ///   8  16   entropy (u128)
    ///  24   1   mode    (u8) 0 = cut the link, 1 = draw it
    ///  25   2   a_len   (u16, little-endian)
    ///  27   2   b_len   (u16, little-endian)
    ///  29  ..   the FROM display id, utf8, a_len bytes
    ///  ..  ..   the TO display id, utf8, b_len bytes
    ///  ..  ..   the edge kind's NAME, utf8, to the end. Empty means
    ///           "you choose, if the schema leaves you only one choice".
    /// ```
    ///
    /// **Both ends are live nodes**: the schema cannot express a line between a line
    /// and a box, and a line onto a removed box is never drawn. Refused in
    /// `resolve_node`, not left to the store.
    ///
    /// **A pair with several legal edges is a QUESTION, not a guess.** With no kind
    /// named and several candidates this writes nothing and returns the names under
    /// `ERR_LINK_CHOICE`. Picking the first would look like working until an estate
    /// of record said two devices were vPC peers because somebody drew a patch lead
    /// (`fathom_weld::hand_link_candidates`).
    ///
    /// **Cutting is a tombstone, never a delete** (`11` §10.5): *"these two were
    /// connected and then they were not"* is more honest than *"they never were"*. It
    /// cuts a parsed edge as readily as a hand-drawn one.
    ///
    /// **Refusals the page can word itself, it words.** `ERR_NO_LINK` has an empty
    /// detail: the page knows both kinds, and building the sentence here cost **345
    /// module bytes** (`44` §5.2). Where the module knows something the page does not
    /// (cardinality bounds) it writes the words: see `link_refusal`.
    ///
    /// Ids come off the `Mint` (see `field_set`).
    fn link(&mut self, req: &[u8]) -> Vec<u8> {
        use fathom_graph::{Actor, BatchId, Timestamp, UserId};

        const PREFIX: usize = 29;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_LINK_FRAME);
        };
        let at = Timestamp(u64::from_le_bytes(le8(head, 0)));
        let entropy = u128::from_le_bytes(le16(head, 8));
        let mode = *head.get(24).unwrap_or(&0);
        let a_len = usize::from(u16::from_le_bytes(le2(head, 25)));
        let b_len = usize::from(u16::from_le_bytes(le2(head, 27)));
        let body = req.get(PREFIX..).unwrap_or_default();
        let (Some(a_raw), Some(b_raw), Some(k_raw)) = (
            body.get(..a_len),
            body.get(a_len..a_len + b_len),
            body.get(a_len + b_len..),
        ) else {
            return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_LINK_FRAME);
        };
        let (Ok(a_id), Ok(b_id), Ok(want)) = (
            core::str::from_utf8(a_raw),
            core::str::from_utf8(b_raw),
            core::str::from_utf8(k_raw),
        ) else {
            return protocol::encode_error(ERR_BAD_UTF8, "an id or the edge kind is not UTF-8");
        };

        let (from, to) = match (self.resolve_node(a_id), self.resolve_node(b_id)) {
            (Some(f), Some(t)) => (f, t),
            _ => return protocol::encode_error(ERR_NO_ELEMENT, NOT_TWO_BOXES),
        };
        // A box may not be linked to itself. The store would take it, but the diagram
        // draws nothing (`route` counts a same-box edge as interior), and a gesture whose
        // whole effect is an invisible fact is worse than a refusal.
        if from == to {
            return protocol::encode_error(ERR_NO_ELEMENT, ONE_BOX);
        }
        // **A CUT ASKS THE GRAPH WHAT IS THERE; A DRAW ASKS THE SCHEMA WHAT IS LEGAL.**
        // Asking the schema for both made a CUT on a pair with several LEGAL kinds return
        // the chooser, and answering it DREW an edge: a gesture meant to remove a fact
        // silently asserted one. A link of an ambiguous kind could then never be cut.
        // Eleven pairs are ambiguous, including `IpsecVpn` to `LogicalUnit`.
        //
        // Narrowed IN PLACE with a plain loop: a separate scan plus `.filter().collect()`
        // cost 1,562 bytes against 5,117 free (each closure monomorphises its adapter
        // chain). The kind is IN the id (`NodeId` embeds a `Copy` `NodeKind`, 62 §13.1).
        let mut candidates = fathom_weld::hand_link_candidates(from.kind, to.kind);
        if mode == 0 {
            let mut live: Vec<fathom_ir::generated::ir_types::EdgeKind> = Vec::new();
            if let Some(g) = self.estate.as_ref() {
                for k in &candidates {
                    if live_link(g, from, to, *k).is_some() {
                        live.push(*k);
                    }
                }
            }
            candidates = live;
        }
        let chosen = if want.is_empty() {
            match candidates.as_slice() {
                // Nothing joins these two, but WHICH nothing depends on the verb. For a draw the
                // list is what the SCHEMA admits, so empty means *"nothing in the schema connects
                // a Device to a Device"* (the page composes it). For a cut it is what is LIVE, so
                // empty means no such fact, and saying the schema forbids it would be false
                // (`2026-08-16-hand-link-drive.mjs` caught exactly that).
                [] => {
                    return protocol::encode_error(
                        ERR_NO_LINK,
                        if mode == 0 { NOTHING_TO_CUT } else { "" },
                    )
                }
                [only] => *only,
                // Several. Write NOTHING and return the names, space separated, under a code of
                // their own so the page can tell a question from a failure.
                //
                // AN ERROR RECORD, not a face reply: a reply built on `encode_paste_reply` cost
                // over a kilobyte of module to carry names `encode_error` already carries. The
                // opcode did refuse to write, and the detail says what it needs.
                many => {
                    let mut names = String::new();
                    for k in many {
                        if !names.is_empty() {
                            names.push(' ');
                        }
                        names.push_str(k.name());
                    }
                    return protocol::encode_error(ERR_LINK_CHOICE, &names);
                }
            }
        } else {
            match fathom_weld::edge_kind_named(want) {
                Some(k) if candidates.contains(&k) => k,
                // One arm for "no such edge kind" and "not between these two": only a page
                // defect produces either (the page posts a name this module gave it), so the
                // operator gets one true sentence.
                _ => return protocol::encode_error(ERR_NO_LINK, ""),
            }
        };

        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };
        // The author is a CONSTANT, so only the batch mint can fail. See
        // `UserId::LOCAL`.
        let Ok(batch) = mint.next() else {
            return protocol::encode_error(ERR_EQUIP_FRAME, "the clock is past the ULID ceiling");
        };
        let actor = Actor::User(UserId::LOCAL);

        let Some(graph) = self.estate.as_mut() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        // Is there already a live link of this kind between these two? Asked BEFORE the
        // batch opens: `out` borrows the graph immutably and the writes want it mutably.
        //
        // BOTH DIRECTIONS FOR A SYMMETRIC KIND, and only then. `11` §7.4 has the store
        // normalise a symmetric edge so the smaller `NodeId` is `from`; an `out(from)`
        // scan alone would miss a link drawn B to A and draw a second, refused as
        // `SymmetricDuplicate`. For an asymmetric kind A→B and B→A are two claims.
        //
        // ONE id, not a list; `cut` re-asks after every tombstone. Plain loops, not
        // `filter().map().next()`: closures monomorphise their adapter chains, and this
        // file is measured against `44` §5.2's ceiling.
        let held = live_link(graph, from, to, chosen);

        let wrote: Result<(), &'static str> = match (mode, held.is_none()) {
            // Nothing there to cut. The store would not raise it (there is simply no such
            // fact), so it is said here in words.
            (0, true) => return protocol::encode_error(ERR_NO_LINK, NOTHING_TO_CUT),
            // Drawing the same link twice is not a second fact: succeed without writing, as
            // `place`'s mode 0 on an unpinned box does.
            //
            // **BUT SAY SO, WITH A WORD OF ITS OWN.** The shared `Ok(())` reply sends `"1"`,
            // which the page reads as *"drew a link … marked as drawn by hand"*. On a link a
            // PASTE built that is false: nothing was drawn and the edge stays machine-read. A
            // sentence claiming a hand assertion that does not exist is as bad as writing
            // one. The page also skips the journal push on this word, or replay would draw a
            // hand link never drawn (`2026-08-16-the-cut-that-drew.mjs`).
            (1, false) => return equip_reply_text(chosen.name(), ALREADY_THERE),
            (mode, _) => {
                let label = if mode == 0 { CUT_LABEL } else { LINK_LABEL };
                if let Err(e) = graph.begin_batch(BatchId(batch), label) {
                    return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
                }
                let mut w = if mode == 0 {
                    cut(graph, from, to, chosen, at, Actor::User(UserId::LOCAL))
                } else {
                    draw(graph, from, to, chosen, at, actor, &mut mint)
                };
                // The batch closes either way: an open batch refuses every later write with
                // `BatchOpen`, turning one refused link into a dead page.
                if let (Ok(()), Err(_)) = (&w, graph.end_batch()) {
                    w = Err(BATCH_DID_NOT_CLOSE);
                }
                w
            }
        };
        match wrote {
            Err(e) => protocol::encode_error(ERR_EQUIP_STORE, e),
            // NO EDGE ID IN THE REPLY, a byte decision: `ElementId::Edge(..).to_string()`
            // would instantiate the id formatter a second time (127 bytes, against a 5,117
            // budget for the feature), and nothing needs it. The journal records the two
            // ENDS and the kind, which is what replays through this opcode. A future "select
            // this link" gesture will have to pay for the id then.
            Ok(()) => equip_reply_text(chosen.name(), if mode == 0 { "0" } else { "1" }),
        }
    }

    /// `OP_CABLE`: draw a cable between two ports by hand, or cut one (ADR-0038).
    ///
    /// Frame: the usual 24-byte prefix, then:
    ///
    /// ```text
    ///   24   1   mode    (u8) 0 = cut; any other value draws, `link`'s own
    ///                     convention for the second word of a two-way switch
    ///   25   1   count   (u8) must be 1 in this cut (D7) — refused otherwise
    ///   26  ..   draw: near end spec, far end spec, label(len u8, utf8;
    ///                  empty = unlabelled)
    ///            cut:  cable(len u8, display id)
    /// ```
    ///
    /// One end spec is `tag(u8)` then:
    /// `0` an existing port (`len u8` + display id) · `1` mint a port on a box
    /// (`len u8` + box display id, `len u8` + port label, empty = unlabelled; a
    /// `Device` or `Chassis`, and a `Device` with none gets one minted first, D5) ·
    /// `2` unknown far end, no bytes, far end only (D4) · `3` reserved for
    /// `ExternalPeer`, refused in this cut.
    ///
    /// **Not `OP_LINK` on two ports.** The only reference edge the schema admits
    /// between two `PhysicalPort`s is `PassThrough` ("the same hole"). `Cable` is a
    /// third, MINTED node with two `Terminates` edges, so this writes a compound batch
    /// and never calls `hand_link_candidates`, which would silently write
    /// `PassThrough` (ADR-0038 D2).
    ///
    /// **Reply words, as `OP_LINK`:** `1` drew, `0` cut, `2` a live cable already
    /// terminates both named ports (checked only when BOTH ends are existing ports).
    /// `1` also carries the display ids minted, in order: cable, near port, far port,
    /// near chassis, far chassis (empty if not minted), so the page can journal the
    /// write and select the cable without a second call.
    ///
    /// **Refusals** carry empty details (the page knows what it sent; `ERR_NO_LINK`'s
    /// reason): `ERR_CABLE_COUNT` (count is not 1), `ERR_CABLE_END` (not a live port or
    /// box, both ends the same port, tag `3`, or tag `2` on the near end),
    /// `ERR_NO_CABLE` (cut names nothing live). `ERR_EQUIP_FRAME`/`ERR_BAD_UTF8` mean
    /// a malformed frame, a page defect.
    fn cable(&mut self, req: &[u8]) -> Vec<u8> {
        use fathom_graph::{Actor, BatchId, ElementId, Timestamp, UserId};
        use fathom_ir::generated::ir_types::{
            CableEnd, CableField, EdgeKind, NodeKind, TerminatesField,
        };

        const PREFIX: usize = 26;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_CABLE_FRAME);
        };
        let at = Timestamp(u64::from_le_bytes(le8(head, 0)));
        let entropy = u128::from_le_bytes(le16(head, 8));
        let mode = head[24];
        let count = head[25];
        if count != 1 {
            return protocol::encode_error(ERR_CABLE_COUNT, "");
        }
        let body = req.get(PREFIX..).unwrap_or_default();
        let actor = Actor::User(UserId::LOCAL);

        // --- cut ---
        if mode == 0 {
            let Some((idbytes, rest)) = take_len_bytes(body) else {
                return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_CABLE_FRAME);
            };
            if !rest.is_empty() {
                return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_CABLE_FRAME);
            }
            let Ok(display) = core::str::from_utf8(idbytes) else {
                return protocol::encode_error(ERR_BAD_UTF8, "the cable id is not UTF-8");
            };
            let cable = match self.resolve_node(display) {
                Some(n) if n.kind == NodeKind::Cable => n,
                _ => return protocol::encode_error(ERR_NO_CABLE, NOTHING_TO_CUT_CABLE),
            };

            // Off the mint, as `field_set`/`element_remove`: two cuts in one millisecond must
            // not collide on a `BatchId`.
            let batch = match fathom_weld::Mint::new(at, entropy).and_then(|mut m| m.next()) {
                Ok(b) => b,
                Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
            };
            let Some(graph) = self.estate.as_mut() else {
                return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
            };
            if let Err(e) = graph.begin_batch(BatchId(batch), CUT_CABLE_LABEL) {
                return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
            }
            // D8: tombstone the Cable AND both `Terminates` edges. Node tombstone cascades
            // through containment only (`Terminates` is `class: reference`), so a generic
            // remove would strand two live reference edges pointing at a gone node and
            // `cabled_peer` would keep reporting the cut cable as live.
            let cut = (|| -> Result<(), String> {
                let edges: Vec<_> = graph
                    .out(cable, EdgeKind::Terminates)
                    .filter(|e| e.absent_since.is_none())
                    .map(|e| e.id)
                    .collect();
                for id in edges {
                    graph
                        .tombstone(ElementId::Edge(id), at, actor)
                        .map_err(|e| format!("{e:?}"))?;
                }
                graph
                    .tombstone(ElementId::Node(cable), at, actor)
                    .map_err(|e| format!("{e:?}"))?;
                Ok(())
            })();
            let closed = graph.end_batch();
            return match (cut, closed) {
                (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &e),
                (Ok(()), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
                (Ok(()), Ok(_)) => cable_reply("0", display, "", "", "", ""),
            };
        }

        // --- draw ---
        let (near_raw, rest) = match take_cable_end(body) {
            Ok(v) => v,
            Err(CableFrameErr::Short) => {
                return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_CABLE_FRAME)
            }
            Err(CableFrameErr::Utf8) => {
                return protocol::encode_error(ERR_BAD_UTF8, "an end id or label is not UTF-8")
            }
        };
        let (far_raw, rest) = match take_cable_end(rest) {
            Ok(v) => v,
            Err(CableFrameErr::Short) => {
                return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_CABLE_FRAME)
            }
            Err(CableFrameErr::Utf8) => {
                return protocol::encode_error(ERR_BAD_UTF8, "an end id or label is not UTF-8")
            }
        };
        let Some((lblbytes, rest)) = take_len_bytes(rest) else {
            return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_CABLE_FRAME);
        };
        if !rest.is_empty() {
            return protocol::encode_error(ERR_EQUIP_FRAME, SHORT_CABLE_FRAME);
        }
        let Ok(label) = core::str::from_utf8(lblbytes) else {
            return protocol::encode_error(ERR_BAD_UTF8, "the cable label is not UTF-8");
        };

        // Near may not be unknown (D4: only the far end may be) or reserved.
        let near = match self.resolve_cable_end(near_raw, false) {
            Ok(v) => v,
            Err(reply) => return reply,
        };
        let far = match self.resolve_cable_end(far_raw, true) {
            Ok(v) => v,
            Err(reply) => return reply,
        };

        // Both ends the same port is a false fact: a wire has two ends and the operator
        // named one twice.
        if let (FinalCableEnd::Port(a), FinalCableEnd::Port(b)) = (&near, &far) {
            if a == b {
                return protocol::encode_error(ERR_CABLE_END, "");
            }
        }

        // ALREADY THERE, checked only when both ends already exist. A minted port cannot
        // already be cabled, so the check would always miss for a `1` tag and is skipped.
        if let (FinalCableEnd::Port(a), FinalCableEnd::Port(b)) = (&near, &far) {
            if let Some(g) = self.estate.as_ref() {
                if let Some(existing) = live_cable_between(g, *a, *b) {
                    return cable_reply(ALREADY_THERE, &existing.to_string(), "", "", "", "");
                }
            }
        }

        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };
        let Ok(batch) = mint.next() else {
            return protocol::encode_error(ERR_EQUIP_FRAME, "the clock is past the ULID ceiling");
        };
        let Some(graph) = self.estate.as_mut() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        if let Err(e) = graph.begin_batch(BatchId(batch), DRAW_CABLE_LABEL) {
            return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
        }

        // Write sequence, ADR-0038 §4: chassis (D5) and ports (D1) minted first (near,
        // then far), then the `Cable`, root-owned and never carrying a `HasCable` EDGE
        // (`11` §7.2: the workspace root is not a node, and `insert_edge` refuses a
        // root-containment kind; `Graph::owner` names `Cable` among the root kinds),
        // then `Terminates` to A then B with `end` normalised by `NodeId` (D6), then the
        // label if given.
        let build = || -> Result<CableWrite, String> {
            let (near_port, near_minted_port, near_minted_chassis) =
                materialize_cable_end(graph, &mut mint, at, actor, near)?;
            let far_materialized = match far {
                FinalCableEnd::Unknown => None,
                other => Some(materialize_cable_end(graph, &mut mint, at, actor, other)?),
            };

            let cable = graph
                .insert_node(
                    NodeKind::Cable,
                    mint.next().map_err(|e| format!("{e:?}"))?,
                    hand_record(&mut mint, at, actor)?,
                )
                .map_err(|e| format!("{e:?}"))?;

            let (far_port, far_minted_port, far_minted_chassis) = match far_materialized {
                Some((p, mp, mc)) => (Some(p), mp, mc),
                None => (None, None, None),
            };

            match far_port {
                Some(fp) => {
                    let (a, b) = if near_port < fp {
                        (near_port, fp)
                    } else {
                        (fp, near_port)
                    };
                    let ea = graph
                        .insert_edge(
                            EdgeKind::Terminates,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            cable,
                            a,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    graph
                        .set_field(
                            ElementId::Edge(ea),
                            TerminatesField::End.key(),
                            CableEnd::A,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    let eb = graph
                        .insert_edge(
                            EdgeKind::Terminates,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            cable,
                            b,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    graph
                        .set_field(
                            ElementId::Edge(eb),
                            TerminatesField::End.key(),
                            CableEnd::B,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                }
                // A one-ended cable (D4): one `Terminates` edge, called A; there is no B to
                // normalise against.
                None => {
                    let ea = graph
                        .insert_edge(
                            EdgeKind::Terminates,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            cable,
                            near_port,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    graph
                        .set_field(
                            ElementId::Edge(ea),
                            TerminatesField::End.key(),
                            CableEnd::A,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                }
            }

            if !label.is_empty() {
                let v = fathom_inventory::parse_into_slot(CableField::Label.key(), label)
                    .map_err(|e| author_text(e, label))?;
                graph
                    .set_field_boxed(
                        ElementId::Node(cable),
                        CableField::Label.key(),
                        v,
                        hand_record(&mut mint, at, actor)?,
                    )
                    .map_err(|e| format!("{e:?}"))?;
            }

            Ok(CableWrite {
                cable,
                near_port: near_minted_port,
                far_port: far_minted_port,
                near_chassis: near_minted_chassis,
                far_chassis: far_minted_chassis,
            })
        };

        let built = build();
        // The batch closes either way: an open batch refuses every later write with
        // `BatchOpen`, turning one refused cable into a dead page.
        let closed = graph.end_batch();
        match (built, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &e),
            (Ok(_), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok(w), Ok(_)) => cable_reply(
                "1",
                &w.cable.to_string(),
                &w.near_port.map(|n| n.to_string()).unwrap_or_default(),
                &w.far_port.map(|n| n.to_string()).unwrap_or_default(),
                &w.near_chassis.map(|n| n.to_string()).unwrap_or_default(),
                &w.far_chassis.map(|n| n.to_string()).unwrap_or_default(),
            ),
        }
    }

    /// One end spec, resolved against the live estate: an existing live
    /// `PhysicalPort`, a mint plan (an existing live `Chassis` or `Device` to mint
    /// the port under, minting a `Chassis` first when a `Device` has none, D5), or
    /// `Unknown` where `allow_unknown` permits (far end only, D4). Every refusal is
    /// `ERR_CABLE_END` with an empty detail; the page knows what it sent.
    fn resolve_cable_end(
        &self,
        raw: RawCableEnd,
        allow_unknown: bool,
    ) -> Result<FinalCableEnd, Vec<u8>> {
        use fathom_ir::generated::ir_types::NodeKind;

        match raw {
            RawCableEnd::Unknown if allow_unknown => Ok(FinalCableEnd::Unknown),
            RawCableEnd::Unknown | RawCableEnd::Reserved => {
                Err(protocol::encode_error(ERR_CABLE_END, ""))
            }
            RawCableEnd::Port(id) => match self.resolve_node(&id) {
                Some(n) if n.kind == NodeKind::PhysicalPort => Ok(FinalCableEnd::Port(n)),
                _ => Err(protocol::encode_error(ERR_CABLE_END, "")),
            },
            RawCableEnd::Mint(box_id, label) => match self.resolve_node(&box_id) {
                Some(n) if n.kind == NodeKind::Chassis => Ok(FinalCableEnd::Mint {
                    chassis: ChassisSource::Existing(n),
                    label,
                }),
                Some(n) if n.kind == NodeKind::Device => {
                    let existing = self.estate.as_ref().and_then(|g| existing_chassis(g, n));
                    let chassis = match existing {
                        Some(c) => ChassisSource::Existing(c),
                        None => ChassisSource::MintUnder(n),
                    };
                    Ok(FinalCableEnd::Mint { chassis, label })
                }
                _ => Err(protocol::encode_error(ERR_CABLE_END, "")),
            },
        }
    }

    /// A display id to the LIVE NODE it names, or `None`.
    ///
    /// `insert_edge` checks a node exists, not that it is still asserted, so a link
    /// onto a removed box would be stored and drawn nowhere (`lay_out` excludes
    /// tombstones): the invisible-fact defect `link`'s self-link check also stops.
    ///
    /// `Option`: the caller writes one refusal for all failures, since only a page
    /// defect produces any, and that saves 200 module bytes of unreachable encoder.
    fn resolve_node(&self, display: &str) -> Option<fathom_graph::NodeId> {
        let estate = self.estate.as_ref()?;
        match fathom_inventory::parse_display_id(estate, display)? {
            fathom_graph::ElementId::Node(n) => estate
                .node(n)
                .filter(|node| node.absent_since.is_none())
                .map(|node| node.id),
            fathom_graph::ElementId::Edge(_) => None,
        }
    }

    /// A display id to the element it names, or the refusal to hand back. Separate
    /// from `node_request`, which also returns the graph and so holds an immutable
    /// borrow these two writers cannot take.
    fn resolve(&self, display: &str) -> Result<fathom_graph::ElementId, Vec<u8>> {
        let Some(estate) = self.estate.as_ref() else {
            return Err(protocol::encode_error(
                ERR_NOT_INITIALISED,
                "no estate loaded",
            ));
        };
        fathom_inventory::parse_display_id(estate, display)
            .ok_or_else(|| protocol::encode_error(ERR_NO_ELEMENT, display))
    }

    /// `OP_DIAGRAM`: the whole estate, laid out.
    ///
    /// The request is zero bytes, or one byte carrying `56` §4's 5-bit `LayerMask`,
    /// **or that byte then the aggregation view preference**
    /// (`fathom_layout::agg::View::parse`'s one-line-per-group form). Byte 0 is always
    /// the mask, so older callers keep their meaning.
    ///
    /// A read: it holds nothing, and the layout is a pure function of the graph.
    /// **The shell stores no part of the view preference**: expansion is not an estate
    /// fact, so it travels with the request, keeping this opcode a pure function of
    /// (estate, request) (invariant 9; `fathom_layout::agg`'s header).
    ///
    /// **Zero bytes is not `0b11111`.** No mask means the union scene with no layer
    /// projection; all five bits set projects through §4.1, which draws two kinds fewer
    /// (`AddressObject`, `Application`). Collapsing them would silently drop elements
    /// for old callers.
    ///
    /// The mask is applied AFTER layout so a toggle cannot move a box (`56` §3.6, §11
    /// row 6); `fathom_layout::lay_out` takes no mask, which enforces it.
    fn diagram(&mut self, req: &[u8]) -> Vec<u8> {
        let (mask, rest) = match req.split_first() {
            None => (None, &[][..]),
            Some((bits, rest)) => match fathom_layout::layers::LayerMask::from_bits(*bits) {
                Some(m) => (Some(m), rest),
                None => {
                    return protocol::encode_error(
                        ERR_BAD_FRAME,
                        &format!(
                            "layer mask {bits:#010b} sets a bit above the {} layers 56 §4 declares",
                            fathom_layout::layers::LayerMask::WIDTH
                        ),
                    )
                }
            },
        };
        let Ok(text) = core::str::from_utf8(rest) else {
            return protocol::encode_error(
                ERR_BAD_FRAME,
                "OP_DIAGRAM's view preference must be UTF-8",
            );
        };
        let Some(estate) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        // No bytes past the mask is the **folded** picture. `59` §3.1 is a DECISION and
        // the collapse is the default drawing; a caller wanting every node asks with `*`,
        // `59` §3.7's retained control, not a compatibility shim.
        let union = fathom_layout::lay_out_with(estate, &fathom_layout::agg::View::parse(text));
        match mask {
            None => protocol::encode_diagram(&union, None),
            Some(m) => {
                let (drawn, filter) = fathom_layout::layers::filter(&union, m);
                protocol::encode_diagram(&drawn, Some(&filter))
            }
        }
    }

    /// `OP_FINDINGS`: what the estate does not know yet. No request bytes.
    ///
    /// Refuses with `ERR_NOT_INITIALISED` when no estate is held, as every face
    /// opcode does. That is not "nothing is missing" and must never render the same:
    /// telling an operator their estate is complete because they have pasted nothing
    /// would be the worst sentence in the product.
    fn findings(&mut self, req: &[u8]) -> Vec<u8> {
        if !req.is_empty() {
            return protocol::encode_error(
                ERR_BAD_FRAME,
                &format!("OP_FINDINGS takes no request; got {} bytes", req.len()),
            );
        }
        let Some(estate) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        protocol::encode_findings_reply(&fathom_inventory::findings(estate))
    }

    /// `OP_CHECKS`: the standing findings. No request bytes.
    fn checks(&mut self, req: &[u8]) -> Vec<u8> {
        if !req.is_empty() {
            return protocol::encode_error(
                ERR_BAD_FRAME,
                &format!("OP_CHECKS takes no request; got {} bytes", req.len()),
            );
        }
        let Some(estate) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        let rows = self.checks.standing(estate);
        let counts = crate::checks::Checks::severity_counts(&rows);
        let head = (
            counts,
            self.checks.load_error.is_some(),
            self.checks.rule_count(),
            self.checks.unfinished,
        );
        protocol::encode_checks_reply(Some(head), &rows)
    }

    /// `OP_CHECK_GESTURE`: what a proposed cable or field edit would break, if anything.
    /// Frame in `lib.rs`. Reads only; a frame that does not parse answers with no rows.
    fn check_gesture(&mut self, req: &[u8]) -> Vec<u8> {
        use crate::checks::{cable_proposal, field_proposal, End};
        let none = || protocol::encode_checks_reply(None, &[]);
        let Some(estate) = self.estate.as_ref() else {
            return none();
        };
        let Some((kind, body)) = req.split_first() else {
            return none();
        };
        let proposal = match kind {
            0 => {
                let Ok((near, rest)) = take_cable_end(body) else {
                    return none();
                };
                let Ok((far, rest)) = take_cable_end(rest) else {
                    return none();
                };
                let Some((media, rest)) = take_len_bytes(rest) else {
                    return none();
                };
                let (Ok(media), true) = (core::str::from_utf8(media), rest.is_empty()) else {
                    return none();
                };
                let end = |raw: RawCableEnd| match raw {
                    RawCableEnd::Port(id) => match self.resolve_node(&id) {
                        Some(n)
                            if n.kind == fathom_ir::generated::ir_types::NodeKind::PhysicalPort =>
                        {
                            Some(End::Port(n))
                        }
                        _ => None,
                    },
                    RawCableEnd::Mint(..) => Some(End::Minted),
                    RawCableEnd::Unknown => Some(End::Unknown),
                    RawCableEnd::Reserved => None,
                };
                let (Some(near), Some(far)) = (end(near), end(far)) else {
                    return none();
                };
                cable_proposal(&near, &far, media)
            }
            1 => {
                let (Some(key), Some(len)) = (body.get(..4), body.get(4..6)) else {
                    return none();
                };
                let key = fathom_ir::bag::FieldKey(u32::from_le_bytes(le4(key, 0)));
                let len = usize::from(u16::from_le_bytes([len[0], len[1]]));
                let (Some(id), Some(value)) = (body.get(6..6 + len), body.get(6 + len..)) else {
                    return none();
                };
                let (Ok(id), Ok(value)) = (core::str::from_utf8(id), core::str::from_utf8(value))
                else {
                    return none();
                };
                let Some(node) = self.resolve_node(id) else {
                    return none();
                };
                match field_proposal(node, key, value) {
                    Some(p) => p,
                    None => return none(),
                }
            }
            _ => return none(),
        };
        protocol::encode_checks_reply(None, &self.checks.gesture(estate, &proposal))
    }

    fn inv_rows(&mut self, req: &[u8]) -> Vec<u8> {
        // The kind byte indexes `InvKind::ALL`, not a hand-written table. A table went
        // stale when the strip grew from three kinds to nine, leaving six row sets
        // unreachable through the browser's only door. Indexing declaration order makes
        // that drift unrepresentable, so `ALL`'s order is the wire order: **a kind is
        // appended, never inserted**.
        let kind = match req {
            [b] => match fathom_inventory::InvKind::ALL.get(usize::from(*b)) {
                Some(k) => *k,
                None => {
                    return protocol::encode_error(
                        ERR_BAD_FRAME,
                        &format!(
                            "kind byte {b} is not in 0..{}",
                            fathom_inventory::InvKind::ALL.len()
                        ),
                    )
                }
            },
            other => {
                return protocol::encode_error(
                    ERR_BAD_FRAME,
                    &format!("OP_INV_ROWS takes exactly one byte; got {}", other.len()),
                )
            }
        };
        let Some(estate) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        protocol::encode_inv_reply(
            kind.label(),
            &fathom_inventory::columns(kind),
            &fathom_inventory::column_keys(kind),
            &fathom_inventory::rows(estate, kind),
        )
    }

    /// `OP_RACK_PLACE`: put one chassis in one rack at one unit (ADR-0035).
    ///
    /// Frame: the 24-byte clock+entropy prefix, then:
    ///
    /// ```text
    ///  24   2   len   (u16) chassis display id length
    ///  26  ..   utf8  the chassis display id
    ///  ..  ..   a field list, exactly OP_EQUIP_ADD's shape
    /// ```
    ///
    /// The field list mixes `Rack.*` and `MountedIn.*` keys, routed by declarer as
    /// `OP_EQUIP_ADD` routes `Device` and `Chassis`.
    ///
    /// **Found or created, by label.** A `Rack.label` matching an existing rack
    /// REUSES it (the schema's tier-1 identity tuple `[owner(Premises), label]`);
    /// otherwise "node1 is at U7 in the same rack" would create a second R12 and make
    /// the elevation a lie. On reuse the supplied `height_u` and `unit_numbering` are
    /// IGNORED, so a form about one box cannot resize the frame another is drawn in.
    ///
    /// No `Premises`: `HasRack` is `in: "1"` but `11` §7.2 is an upper bound at write
    /// time, and inventing a building asserts an unasserted fact. No move: placing an
    /// already-placed chassis is refused (`MountedIn` is `out: "0..1"`; a move is a
    /// different gesture with a different undo label), and the refusal says so.
    fn rack_place(&mut self, req: &[u8]) -> Vec<u8> {
        use fathom_graph::{Actor, BatchId, ElementId, Timestamp, UserId};
        use fathom_ir::generated::ir_types::{EdgeKind, MountedInField, NodeKind, RackField};

        const PREFIX: usize = 24;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!(
                    "OP_RACK_PLACE needs a {PREFIX}-byte clock and entropy prefix; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let at = Timestamp(u64::from_le_bytes(le8(head, 0)));
        let entropy = u128::from_le_bytes(le16(head, 8));

        let rest = req.get(PREFIX..).unwrap_or_default();
        let Some(lenb) = rest.get(..2) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                "OP_RACK_PLACE needs a 2-byte chassis id length",
            );
        };
        let idlen = usize::from(u16::from_le_bytes([lenb[0], lenb[1]]));
        let Some(idbytes) = rest.get(2..2 + idlen) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!("the chassis id claims {idlen} bytes and the frame is shorter"),
            );
        };
        let Ok(idtext) = std::str::from_utf8(idbytes) else {
            return protocol::encode_error(ERR_BAD_UTF8, "the chassis display id is not UTF-8");
        };
        let idtext = idtext.to_owned();

        let fields = match parse_field_list(rest.get(2 + idlen..).unwrap_or_default()) {
            Ok(f) => f,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &e),
        };

        // Route by declarer, from the generated tables; never hand-written.
        let mut on_rack: Vec<(fathom_ir::bag::FieldKey, String)> = Vec::new();
        let mut on_edge: Vec<(fathom_ir::bag::FieldKey, String)> = Vec::new();
        for (k, text) in fields {
            if RackField::ALL.iter().any(|f| f.key() == k) {
                on_rack.push((k, text));
            } else if MountedInField::ALL.iter().any(|f| f.key() == k) {
                on_edge.push((k, text));
            } else {
                return protocol::encode_error(
                    ERR_EQUIP_FRAME,
                    &format!(
                        "field key {} is declared by neither Rack nor MountedIn",
                        k.0
                    ),
                );
            }
        }

        // Every `card: "1"` field is demanded at the door. `unit_numbering` matters most:
        // ADR-0035 gives it no default because an elevation drawn the wrong way up is
        // wrong in every position while looking plausible. Defaulting it would restore
        // the guess the schema refuses.
        for (k, name) in [
            (RackField::Label.key(), "Rack.label"),
            (RackField::HeightU.key(), "Rack.height_u"),
            (RackField::UnitNumbering.key(), "Rack.unit_numbering"),
        ] {
            if !on_rack.iter().any(|(x, _)| *x == k) {
                return protocol::encode_error(
                    ERR_EQUIP_FRAME,
                    &format!("a rack needs {name}: the schema declares it required"),
                );
            }
        }
        if !on_edge
            .iter()
            .any(|(k, _)| *k == MountedInField::PositionU.key())
        {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                "a placement needs MountedIn.position_u: the lowest-numbered unit the box occupies",
            );
        }

        // THE `range:` CONSTRAINT, ENFORCED HERE BECAUSE NOTHING ELSE ENFORCES IT.
        // `schema/schema.yaml` declares `range: { min: 1, max: 100 }` on these fields, but
        // `fathom-schemagen` does not carry `range:` into `ir_types.rs` (`height_u = 0`
        // drew zero rows; `200` drew two hundred DOM rows). Teaching the generator is the
        // long-term fix and is filed. Meanwhile the door checks the value, with the
        // numbers in one const, and `crates/fathom-wasm/tests/rack.rs` reads the DECLARED
        // range from the schema and fails if they disagree (ADR-0008: drift is a red
        // test).
        for (k, name) in [
            (RackField::HeightU.key(), "Rack.height_u"),
            (MountedInField::PositionU.key(), "MountedIn.position_u"),
            (MountedInField::HeightU.key(), "MountedIn.height_u"),
        ] {
            let found = on_rack
                .iter()
                .chain(on_edge.iter())
                .find(|(x, _)| *x == k)
                .map(|(_, t)| t.as_str());
            let Some(text) = found else { continue };
            // Out-of-range and unparseable are told apart: `parse_into_slot` reports the
            // second with its vendor-shaped message, so this only claims the range.
            if let Ok(v) = text.trim().parse::<u32>() {
                if !(u32::from(RACK_U_MIN)..=u32::from(RACK_U_MAX)).contains(&v) {
                    return protocol::encode_error(
                        ERR_FIELD_VALUE,
                        &format!(
                            "{name} is {v}; the schema declares range {RACK_U_MIN}..={RACK_U_MAX}. \
                             A frame with no units cannot hold anything and a unit number outside \
                             the frame is a typo, not a rack."
                        ),
                    );
                }
            }
        }

        // Parse everything BEFORE touching the store, so a FIELD refusal leaves the
        // estate as it was (as `OP_EQUIP_ADD`).
        //
        // THE LIMIT: this holds for parse and door-check refusals above this line, NOT
        // for a store error inside `build()`. `Graph` has no rollback, so an
        // `insert_edge` failing after `insert_node` succeeded leaves an empty `Rack`
        // while the caller is told the placement failed. Rollback is a `fathom-graph`
        // change, filed; an orphan rack is visible and removable.
        let mut rack_values = Vec::with_capacity(on_rack.len());
        for (k, text) in &on_rack {
            match fathom_inventory::parse_into_slot(*k, text) {
                Ok(v) => rack_values.push((*k, v)),
                Err(e) => return protocol::encode_error(ERR_FIELD_VALUE, &author_text(e, text)),
            }
        }
        let mut edge_values = Vec::with_capacity(on_edge.len());
        for (k, text) in &on_edge {
            match fathom_inventory::parse_into_slot(*k, text) {
                Ok(v) => edge_values.push((*k, v)),
                Err(e) => return protocol::encode_error(ERR_FIELD_VALUE, &author_text(e, text)),
            }
        }

        let label_text = on_rack
            .iter()
            .find(|(k, _)| *k == RackField::Label.key())
            .map(|(_, t)| t.clone())
            .unwrap_or_default();

        let Some(estate) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        let chassis = match fathom_inventory::parse_display_id(estate, &idtext) {
            Some(ElementId::Node(n)) if n.kind == NodeKind::Chassis => n,
            Some(_) => {
                return protocol::encode_error(
                    ERR_NO_ELEMENT,
                    &format!(
                        "{idtext} is not a Chassis. A rack holds boxes, and a Device may have \
                         two of them in two different racks -- which is why placement hangs \
                         off Chassis and not off Device."
                    ),
                )
            }
            None => return protocol::encode_error(ERR_NO_ELEMENT, &idtext),
        };
        if estate.out(chassis, EdgeKind::MountedIn).next().is_some() {
            return protocol::encode_error(
                ERR_EQUIP_STORE,
                &format!(
                    "{idtext} is already in a rack. MountedIn is out: \"0..1\", so moving a box \
                     is a separate gesture with its own undo label; this build does not have it."
                ),
            );
        }
        // Reuse by label (the tier-1 identity tuple). Ordered by NodeId so the choice is
        // deterministic if two racks share a label (invariant 9).
        let mut existing: Vec<fathom_graph::NodeId> = estate
            .nodes_of_kind(NodeKind::Rack)
            .filter(|n| {
                fathom_inventory::rack_label(estate, n.id).as_deref() == Some(label_text.as_str())
            })
            .map(|n| n.id)
            .collect();
        existing.sort();
        let found = existing.first().copied();

        // THE BATCH ID IS DERIVED FROM THE ENTROPY, as the paste's is, for the same
        // reason (see `paste`): `Ulid(at, 2)` collides once estates accumulate, and two
        // hand edits in one millisecond would reuse a batch id and be refused as
        // `BatchIdReused`. (The author half is `UserId::LOCAL`.)
        let Ok(batch) = fathom_id::Ulid::from_parts(at.0, entropy) else {
            return protocol::encode_error(
                ERR_EQUIP_FRAME,
                &format!(
                    "the clock reads {} ms, which is past the ULID ceiling",
                    at.0
                ),
            );
        };
        let actor = Actor::User(UserId::LOCAL);
        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };

        let graph = self.estate.as_mut().expect("checked above");
        if let Err(e) = graph.begin_batch(BatchId(batch), RACK_LABEL) {
            return protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}"));
        }

        let build = || -> Result<(fathom_graph::NodeId, usize), String> {
            let mut written = 0usize;
            let rack = match found {
                Some(r) => r,
                None => {
                    let r = graph
                        .insert_node(
                            NodeKind::Rack,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            hand_record(&mut mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    for (k, v) in rack_values {
                        graph
                            .set_field_boxed(
                                ElementId::Node(r),
                                k,
                                v,
                                hand_record(&mut mint, at, actor)?,
                            )
                            .map_err(|e| format!("{e:?}"))?;
                        written += 1;
                    }
                    r
                }
            };
            let edge = graph
                .insert_edge(
                    EdgeKind::MountedIn,
                    mint.next().map_err(|e| format!("{e:?}"))?,
                    chassis,
                    rack,
                    hand_record(&mut mint, at, actor)?,
                )
                .map_err(|e| format!("{e:?}"))?;
            for (k, v) in edge_values {
                graph
                    .set_field_boxed(
                        ElementId::Edge(edge),
                        k,
                        v,
                        hand_record(&mut mint, at, actor)?,
                    )
                    .map_err(|e| format!("{e:?}"))?;
                written += 1;
            }
            Ok((rack, written))
        };

        let built = build();
        // The batch closes either way: an open batch refuses every later write with
        // `BatchOpen`, turning one bad form into a dead page.
        let closed = graph.end_batch();
        match (built, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &e),
            (Ok(_), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok((rack, written)), Ok(_)) => {
                equip_reply_text(&ElementId::Node(rack).to_string(), &written.to_string())
            }
        }
    }

    /// `OP_RACK_ELEVATION`: one rack's frame and contents, by display id.
    fn rack_elevation(&mut self, req: &[u8]) -> Vec<u8> {
        let (estate, node) = match self.node_request(req) {
            Ok(pair) => pair,
            Err(reply) => return reply,
        };
        // `None` is the empty state, not an error: a rack whose height was never stated
        // cannot be drawn, and the page says so.
        protocol::encode_rack_reply(fathom_inventory::elevation(estate, node).as_ref())
    }

    /// Inside one box (`57` §7). A display id naming anything but a live `Device`
    /// yields the empty reply: the page descends only from a device box, and a stale
    /// id after a paste or import is a rung to climb out of, not a fault.
    fn inside(&mut self, req: &[u8]) -> Vec<u8> {
        let (estate, node) = match self.node_request(req) {
            Ok(pair) => pair,
            Err(reply) => return reply,
        };
        protocol::encode_inside_reply(fathom_inventory::inside(estate, node).as_ref())
    }

    /// `OP_TRACE`: see [`crate::OP_TRACE`] for the frame.
    fn trace(&mut self, req: &[u8]) -> Vec<u8> {
        let Some(estate) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        let Ok(text) = std::str::from_utf8(req) else {
            return protocol::encode_error(ERR_BAD_UTF8, "the trace request is not UTF-8");
        };
        let mut lines = text.split('\n');
        let (Some(from), Some(to), Some(flow), None) =
            (lines.next(), lines.next(), lines.next(), lines.next())
        else {
            return protocol::encode_error(
                ERR_BAD_FRAME,
                "a trace request is three lines: start, end, flow",
            );
        };
        let flow = flow.trim();
        let flow = if flow.is_empty() {
            None
        } else {
            let mut parts = flow.split_whitespace();
            let parsed = match (parts.next(), parts.next(), parts.next()) {
                (Some(p), Some(port), None) => p
                    .parse()
                    .ok()
                    .zip(port.parse().ok())
                    .map(|(protocol, port)| fathom_inventory::Flow { protocol, port }),
                _ => None,
            };
            if parsed.is_none() {
                return protocol::encode_error(
                    ERR_BAD_FRAME,
                    "the flow line is `<protocol number> <port>` or empty",
                );
            }
            parsed
        };
        protocol::encode_trace_reply(&fathom_inventory::trace(
            estate,
            from.trim(),
            to.trim(),
            flow,
        ))
    }

    fn element(&mut self, req: &[u8]) -> Vec<u8> {
        let (estate, node) = match self.node_request(req) {
            Ok(pair) => pair,
            Err(reply) => return reply,
        };
        match fathom_inventory::element_page(estate, node) {
            Some(page) => protocol::encode_element_reply(&page),
            None => protocol::encode_error(ERR_NO_ELEMENT, &String::from_utf8_lossy(req)),
        }
    }

    fn equipment(&mut self, req: &[u8]) -> Vec<u8> {
        let (estate, node) = match self.node_request(req) {
            Ok(pair) => pair,
            Err(reply) => return reply,
        };
        // The anchor rule yielding None is the empty state, not an error.
        protocol::encode_equipment_reply(fathom_inventory::equipment_page(estate, node).as_ref())
    }

    /// The raw UTF-8 display id both element opcodes take, resolved against the held
    /// estate. An edge id is `ERR_NO_ELEMENT`: this face renders nodes.
    fn node_request<'a>(
        &'a self,
        req: &[u8],
    ) -> Result<(&'a fathom_graph::Graph, fathom_graph::NodeId), Vec<u8>> {
        let text = match std::str::from_utf8(req) {
            Ok(t) => t,
            Err(e) => {
                return Err(protocol::encode_error(
                    ERR_BAD_UTF8,
                    &format!("display id is not UTF-8: {e}"),
                ))
            }
        };
        let Some(estate) = self.estate.as_ref() else {
            return Err(protocol::encode_error(
                ERR_NOT_INITIALISED,
                "no estate loaded",
            ));
        };
        match fathom_inventory::parse_display_id(estate, text) {
            Some(fathom_graph::ElementId::Node(n)) => Ok((estate, n)),
            _ => Err(protocol::encode_error(ERR_NO_ELEMENT, text)),
        }
    }

    fn init(&mut self, req: &[u8]) -> Result<(), (u16, String)> {
        let files = parse_init_frame(req)?;
        let index =
            CorpusIndex::from_sources(&files).map_err(|e| (ERR_CORPUS_LOAD, e.to_string()))?;
        self.finder = Some(Finder::new(index));
        Ok(())
    }

    fn query(&mut self, req: &[u8]) -> Vec<u8> {
        let Some(finder) = self.finder.as_ref() else {
            return protocol::encode_error(
                ERR_NOT_INITIALISED,
                "no corpus is loaded: OP_INIT must succeed before OP_QUERY",
            );
        };
        let query = match std::str::from_utf8(req) {
            Ok(q) => q,
            Err(e) => {
                return protocol::encode_error(ERR_BAD_UTF8, &format!("query is not UTF-8: {e}"))
            }
        };
        let result = finder.search(query);
        protocol::encode_query_reply(finder, &result)
    }
}

impl Default for Shell {
    fn default() -> Shell {
        Shell::new()
    }
}

// --- the paste reply ---

/// The batch's undo label (`53` §7.2, at most 60 bytes).
const PASTE_LABEL: &str = "Paste junos-srx config";
const PASTE_INTO_LABEL: &str = "Paste config into device";

/// The undo label of one hand-added device (`53` §7.2). Names the gesture, not
/// the opcode: it is what the person reads in a list of things to undo.
const EQUIP_LABEL: &str = "Add equipment by hand";

/// The undo labels for the two edit gestures (`53` §7.2), named for what the
/// person did.
const EDIT_LABEL: &str = "Correct a field";
const REMOVE_LABEL: &str = "Remove equipment";
/// ADR-0036. Named for the gesture: the person put a box in a rack, and the undo
/// stack should offer to take that back.
const RACK_LABEL: &str = "Place equipment in a rack";

/// `schema/schema.yaml`'s `range: { min: 1, max: 100 }`, transcribed once for
/// `rack_place`'s door-check because codegen does not carry `range:` yet.
///
/// **These two integers are the only hand-copied schema numbers in this file**;
/// `crates/fathom-wasm/tests/rack.rs::the_declared_range_is_the_range_the_door_enforces`
/// fails if they drift. The bound is a typo check, not a claim about what racks
/// exist: 42U is standard but NetBox allows arbitrary heights, so the max is
/// deliberately far above anything real.
const RACK_U_MIN: u8 = 1;
const RACK_U_MAX: u8 = 100;

/// The two placement gestures (`53` §7.2), named for what the person did ("Place a
/// box", not "OP_PLACE mode 1").
const PLACE_LABEL: &str = "Place a box on the diagram";
const FREE_LABEL: &str = "Let the layout place it again";

/// The undo labels for the two halves of `OP_LINK`, named for the gesture.
const LINK_LABEL: &str = "Draw a link by hand";
const CUT_LABEL: &str = "Cut a link";

/// The undo labels for `OP_CABLE`'s two halves (ADR-0038), named likewise.
const DRAW_CABLE_LABEL: &str = "Draw a cable by hand";
const CUT_CABLE_LABEL: &str = "Cut a cable";

/// `OP_CABLE`'s frame-malformed and nothing-to-cut sentences, on `OP_LINK`'s
/// precedent: a short frame is a page defect and gets a message nobody needs to
/// read; a cut with nothing there is a reachable state and says so.
const SHORT_CABLE_FRAME: &str = "that cable request is malformed";
const NOTHING_TO_CUT_CABLE: &str = "there is no such cable to cut";

/// `OP_LINK`'s three fixed sentences. Constants, not `format!` sites: nothing in
/// them varies (a short frame is a page defect), and each avoided `format!` is
/// argument machinery not linked.
const SHORT_LINK_FRAME: &str = "that link request is malformed";
const NOT_TWO_BOXES: &str = "pick two boxes that are both still in the estate";
const ONE_BOX: &str = "that is one box, linked to itself — pick a second one";
const NOTHING_TO_CUT: &str = "there is no such link to cut";
const CLOCK_CEILING: &str = "the clock is past the ULID ceiling";
const STORE_REFUSED_CUT: &str = "the store would not record the cut";
const BATCH_DID_NOT_CLOSE: &str = "the change did not close cleanly — reload before changing more";

/// `OP_LINK`'s third answer, in the reply's `written` slot beside `"0"` (cut) and
/// `"1"` (drew): **the link was already there and nothing was written.**
///
/// A word, not a fourth error code, since it is no refusal: the end state asked
/// for is the end state held. It lets the page say which happened, and the
/// journal record only the draws that were draws.
const ALREADY_THERE: &str = "2";

/// One live edge of `kind` between `from` and `to`, or `None`.
///
/// The one place `OP_LINK` decides whether a link is already there, so the draw
/// path's "already true" and the cut path's "here is what to tombstone" cannot
/// disagree.
fn live_link(
    graph: &fathom_graph::Graph,
    from: fathom_graph::NodeId,
    to: fathom_graph::NodeId,
    kind: fathom_ir::generated::ir_types::EdgeKind,
) -> Option<fathom_graph::EdgeId> {
    for e in graph.out(from, kind) {
        if e.to == to && e.absent_since.is_none() {
            return Some(e.id);
        }
    }
    if kind.symmetric() {
        for e in graph.out(to, kind) {
            if e.to == from && e.absent_since.is_none() {
                return Some(e.id);
            }
        }
    }
    None
}

/// Tombstone every live edge of `kind` between the two, never delete (`11`
/// §10.5): the record keeps *"these two were connected and then they were not"*.
///
/// Re-asks after every tombstone rather than holding a list. That is also the
/// termination argument: `live_link` returns only an edge with no `absent_since`
/// and each pass sets one, so the loop shrinks a finite set.
fn cut(
    graph: &mut fathom_graph::Graph,
    from: fathom_graph::NodeId,
    to: fathom_graph::NodeId,
    kind: fathom_ir::generated::ir_types::EdgeKind,
    at: fathom_graph::Timestamp,
    by: fathom_graph::Actor,
) -> Result<(), &'static str> {
    while let Some(id) = live_link(graph, from, to, kind) {
        graph
            .tombstone(fathom_graph::ElementId::Edge(id), at, by)
            .map_err(|_| STORE_REFUSED_CUT)?;
    }
    Ok(())
}

/// One hand-drawn edge, with `Origin::Hand` provenance.
fn draw(
    graph: &mut fathom_graph::Graph,
    from: fathom_graph::NodeId,
    to: fathom_graph::NodeId,
    kind: fathom_ir::generated::ir_types::EdgeKind,
    at: fathom_graph::Timestamp,
    actor: fathom_graph::Actor,
    mint: &mut fathom_weld::Mint,
) -> Result<(), &'static str> {
    // `&'static str` all the way down, the last of the 451 bytes this round had to
    // find: every message on this path is a constant, and a `String` return drags the
    // allocator and `format!` into a path that needs neither.
    let ulid = mint.next().map_err(|_| CLOCK_CEILING)?;
    let record = hand_record(mint, at, actor).map_err(|_| CLOCK_CEILING)?;
    graph
        .insert_edge(kind, ulid, from, to, record)
        .map(|_| ())
        .map_err(|e| link_refusal(e, kind))
}

/// What the store refused, as TWO WORDS the page turns into a sentence.
///
/// **The wording lives in the page**, per `link`'s `ERR_NO_LINK` arm (see the
/// fourth property). Composing it here cost **433 bytes** of a ceiling with 451 to
/// find: `format!`, `concat` and prose all instantiate in the module, while the
/// page holds strings for free. The module sends what only it knows (which bound
/// was exceeded, which edge kind) and the page says it in English.
fn link_refusal(
    e: fathom_graph::WriteError,
    kind: fathom_ir::generated::ir_types::EdgeKind,
) -> &'static str {
    use fathom_graph::WriteError;
    let end = match e {
        WriteError::OutBoundExceeded { .. } => "out",
        WriteError::InBoundExceeded { .. } => "in",
        // Reachable only through the store's normalisation, and only if the
        // both-directions scan in `link` stops covering it.
        WriteError::SymmetricDuplicate { .. } => "sym",
        _ => "store",
    };
    // The kind's NAME is not sent, the last of the 451 bytes: building a `String`
    // instantiates the allocator path for a value the page already has (it chose the
    // kind from the chooser or received it in the reply). Where it does not, "a link
    // of that kind" is true and actionable.
    let _ = kind;
    end
}

// --- OP_CABLE (ADR-0038) ---

/// One end spec off the wire, before it is checked against the graph.
enum RawCableEnd {
    /// Tag 0: an existing port, by display id.
    Port(String),
    /// Tag 1: mint a port on this box, with this label (empty = unlabelled).
    Mint(String, String),
    /// Tag 2: the far end is not known. Legal only on the far end (D4).
    Unknown,
    /// Tag 3: `ExternalPeer`, reserved and refused in this cut.
    Reserved,
}

/// Why `take_cable_end`/`take_len_bytes` could not read a value, so the caller can
/// tell a truncated frame (`ERR_EQUIP_FRAME`) from non-UTF-8 (`ERR_BAD_UTF8`).
enum CableFrameErr {
    Short,
    Utf8,
}

/// `[u8 len][len bytes]`, bounds-checked. Returns the bytes and the rest.
fn take_len_bytes(b: &[u8]) -> Option<(&[u8], &[u8])> {
    let (len, rest) = b.split_first()?;
    let n = usize::from(*len);
    Some((rest.get(..n)?, rest.get(n..)?))
}

/// One end spec: `tag(u8)` then the tag's own bytes, ADR-0038 §4. Reads exactly
/// one and returns the rest of `b`.
fn take_cable_end(b: &[u8]) -> Result<(RawCableEnd, &[u8]), CableFrameErr> {
    let (tag, rest) = b.split_first().ok_or(CableFrameErr::Short)?;
    match tag {
        0 => {
            let (idb, rest) = take_len_bytes(rest).ok_or(CableFrameErr::Short)?;
            let id = core::str::from_utf8(idb).map_err(|_| CableFrameErr::Utf8)?;
            Ok((RawCableEnd::Port(id.to_owned()), rest))
        }
        1 => {
            let (boxb, rest) = take_len_bytes(rest).ok_or(CableFrameErr::Short)?;
            let boxid = core::str::from_utf8(boxb).map_err(|_| CableFrameErr::Utf8)?;
            let (lblb, rest) = take_len_bytes(rest).ok_or(CableFrameErr::Short)?;
            let lbl = core::str::from_utf8(lblb).map_err(|_| CableFrameErr::Utf8)?;
            Ok((RawCableEnd::Mint(boxid.to_owned(), lbl.to_owned()), rest))
        }
        2 => Ok((RawCableEnd::Unknown, rest)),
        3 => Ok((RawCableEnd::Reserved, rest)),
        // Not one of the four declared tags: a page defect, not a legal-but-refused
        // choice, so a frame error rather than `ERR_CABLE_END`.
        _ => Err(CableFrameErr::Short),
    }
}

/// Where a minted port's `Chassis` comes from: one that exists, or one to mint
/// under a `Device` that has none (D5).
enum ChassisSource {
    Existing(fathom_graph::NodeId),
    MintUnder(fathom_graph::NodeId),
}

/// One end spec resolved against the live estate; [`Shell::resolve_cable_end`] is
/// the only builder.
enum FinalCableEnd {
    Port(fathom_graph::NodeId),
    Mint {
        chassis: ChassisSource,
        label: String,
    },
    Unknown,
}

/// What one `OP_CABLE` draw minted, for the reply: the cable always, and each
/// port/chassis only when this call minted it.
struct CableWrite {
    cable: fathom_graph::NodeId,
    near_port: Option<fathom_graph::NodeId>,
    far_port: Option<fathom_graph::NodeId>,
    near_chassis: Option<fathom_graph::NodeId>,
    far_chassis: Option<fathom_graph::NodeId>,
}

/// The first live `Chassis` a `Device` owns, smallest `NodeId` first (invariant
/// 9); `None` when it has none (every pasted device, and D5's trigger to mint).
fn existing_chassis(
    g: &fathom_graph::Graph,
    device: fathom_graph::NodeId,
) -> Option<fathom_graph::NodeId> {
    use fathom_ir::generated::ir_types::EdgeKind;
    g.out(device, EdgeKind::HasChassis)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .filter(|c| g.node(*c).is_some_and(|n| n.absent_since.is_none()))
        .min()
}

/// Is there already a live `Cable` terminating both `a` and `b`? Asked only when
/// both ends already exist: a freshly minted port cannot already be cabled.
fn live_cable_between(
    g: &fathom_graph::Graph,
    a: fathom_graph::NodeId,
    b: fathom_graph::NodeId,
) -> Option<fathom_graph::NodeId> {
    use fathom_ir::generated::ir_types::EdgeKind;
    g.inn(a, EdgeKind::Terminates)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.from)
        .filter(|c| g.node(*c).is_some_and(|n| n.absent_since.is_none()))
        .find(|c| {
            g.out(*c, EdgeKind::Terminates)
                .any(|e| e.absent_since.is_none() && e.to == b)
        })
}

/// Materialise one draw end inside the open batch: an existing port as-is, or a
/// newly minted one (with its `Chassis` minted first if the box had none, D5).
/// Returns the port to terminate and what this call minted, for the reply and
/// journal.
///
/// `Text::parse` cannot fail (`Ok` for every `&str`), so parsing a label here
/// rather than before the batch opens cannot leave an orphan chassis or port
/// behind a refusal (`OP_RACK_PLACE` notes the risk where a parse is fallible).
fn materialize_cable_end(
    graph: &mut fathom_graph::Graph,
    mint: &mut fathom_weld::Mint,
    at: fathom_graph::Timestamp,
    actor: fathom_graph::Actor,
    end: FinalCableEnd,
) -> Result<
    (
        fathom_graph::NodeId,
        Option<fathom_graph::NodeId>,
        Option<fathom_graph::NodeId>,
    ),
    String,
> {
    use fathom_graph::ElementId;
    use fathom_ir::generated::ir_types::{ChassisField, NodeKind, PhysicalPortField};

    match end {
        FinalCableEnd::Unknown => {
            Err("an unknown end cannot be materialised: the caller filters it first".to_owned())
        }
        FinalCableEnd::Port(p) => Ok((p, None, None)),
        FinalCableEnd::Mint { chassis, label } => {
            let (chassis_id, minted_chassis) = match chassis {
                ChassisSource::Existing(c) => (c, None),
                ChassisSource::MintUnder(device) => {
                    let c = graph
                        .insert_node(
                            NodeKind::Chassis,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            hand_record(mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    let edge = fathom_weld::containment_edge(NodeKind::Device, NodeKind::Chassis)
                        .ok_or_else(|| {
                        "the schema declares no containment edge Device -> Chassis".to_owned()
                    })?;
                    graph
                        .insert_edge(
                            edge,
                            mint.next().map_err(|e| format!("{e:?}"))?,
                            device,
                            c,
                            hand_record(mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    let zero =
                        fathom_inventory::parse_into_slot(ChassisField::MemberIndex.key(), "0")
                            .map_err(|e| author_text(e, "0"))?;
                    graph
                        .set_field_boxed(
                            ElementId::Node(c),
                            ChassisField::MemberIndex.key(),
                            zero,
                            hand_record(mint, at, actor)?,
                        )
                        .map_err(|e| format!("{e:?}"))?;
                    (c, Some(c))
                }
            };
            let port = graph
                .insert_node(
                    NodeKind::PhysicalPort,
                    mint.next().map_err(|e| format!("{e:?}"))?,
                    hand_record(mint, at, actor)?,
                )
                .map_err(|e| format!("{e:?}"))?;
            let edge = fathom_weld::containment_edge(NodeKind::Chassis, NodeKind::PhysicalPort)
                .ok_or_else(|| {
                    "the schema declares no containment edge Chassis -> PhysicalPort".to_owned()
                })?;
            graph
                .insert_edge(
                    edge,
                    mint.next().map_err(|e| format!("{e:?}"))?,
                    chassis_id,
                    port,
                    hand_record(mint, at, actor)?,
                )
                .map_err(|e| format!("{e:?}"))?;
            if !label.is_empty() {
                let v = fathom_inventory::parse_into_slot(PhysicalPortField::Label.key(), &label)
                    .map_err(|e| author_text(e, &label))?;
                graph
                    .set_field_boxed(
                        ElementId::Node(port),
                        PhysicalPortField::Label.key(),
                        v,
                        hand_record(mint, at, actor)?,
                    )
                    .map_err(|e| format!("{e:?}"))?;
            }
            Ok((port, Some(port), minted_chassis))
        }
    }
}

/// `OP_CABLE`'s reply: the word, then the display ids the batch minted. Reuses
/// `encode_paste_reply`'s `FACE_PASTE` row as `equip_reply_text` does: one row of
/// up to eight strings, no new wire shape.
fn cable_reply(
    word: &str,
    cable: &str,
    near_port: &str,
    far_port: &str,
    near_chassis: &str,
    far_chassis: &str,
) -> Vec<u8> {
    protocol::encode_paste_reply(&protocol::PasteReply {
        summary: [
            word,
            cable,
            near_port,
            far_port,
            near_chassis,
            far_chassis,
            "",
            "",
        ],
        residue: &[],
        unresolved: &[],
        capture: "",
        shape: "",
        lines: &[],
        drops: &[],
    })
}

/// How many residue rows one reply carries. The summary states the **total**, so
/// a page rendering both can say how many it is not showing (`78` §5 forbids the
/// silent cap, not the cap).
const RESIDUE_ROW_CAP: usize = 500;
/// The same, for references the capture named and did not contain.
const UNRESOLVED_ROW_CAP: usize = 200;
/// [`protocol::FACE_LINE`] caps generously: unlike residue (already filtered to
/// failures) this face carries ONE ROW PER LEDGER LINE, bound lines included, so
/// an ordinary config crosses hundreds of rows.
const LINE_ROW_CAP: usize = 5_000;
/// [`protocol::FACE_DROP`]'s cap. Thousands of individually destroyed values is
/// not realistic; this guards the pathological case.
const DROP_ROW_CAP: usize = 1_000;

/// How many lines became facts: the exact criterion behind the refusal above.
/// `LineOutcome::Bound` is the parser's word for "now in the graph", so this asks
/// the parser rather than inferring from node counts (wrong: the binder already
/// seeded a `Device`).
fn bound_lines(ingest: &fathom_ingest::IngestOutput) -> usize {
    ingest
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, fathom_ingest::frame::LineOutcome::Bound { .. }))
        .count()
}

/// The message for a paste that bound nothing. Names the most likely cause it can
/// evidence and never claims more than it checked.
fn nothing_understood(ingest: &fathom_ingest::IngestOutput) -> String {
    use fathom_ingest::frame::{LineOutcome, ShapeError};
    let text = ingest.capture.text();
    let lines: Vec<&str> = ingest
        .residue
        .iter()
        .map(|r| {
            text.get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default()
                .trim()
        })
        .filter(|l| !l.is_empty())
        .collect();

    if lines.is_empty() {
        return "there is nothing here to read — the paste is empty, or every line is blank"
            .to_owned();
    }

    let not_verb_initial = ingest
        .residue
        .iter()
        .filter(|r| {
            matches!(
                r.outcome,
                LineOutcome::Unshaped {
                    reason: ShapeError::NotVerbInitial
                }
            )
        })
        .count();

    // Curly-brace Junos, as `show configuration` prints without `| display set`.
    // Evidenced, not assumed: braces AND semicolon-terminated statements, which no
    // `set`-form capture has.
    let braces = lines
        .iter()
        .filter(|l| l.ends_with('{') || **l == "}")
        .count();
    let semis = lines.iter().filter(|l| l.ends_with(';')).count();
    if braces > 0 && semis > 0 {
        return format!(
            "none of these {} lines is a `set` statement, and {braces} of them open or close a \
             brace — this looks like `show configuration` in its normal form. Fathom reads the \
             flattened form: run `show configuration | display set` and paste that instead. \
             Nothing was changed; what you had is still loaded.",
            lines.len()
        );
    }

    if not_verb_initial > 0 {
        return format!(
            "none of these {} lines starts with a Junos configuration verb, so nothing here \
             could be read as a Juniper `set` statement — the first line reads `{}`. If this is \
             a different vendor, Fathom only knows Juniper SRX today. Nothing was changed; what \
             you had is still loaded.",
            lines.len(),
            lines.first().copied().unwrap_or_default()
        );
    }

    format!(
        "these {} lines are Junos statements Fathom does not know yet, so none of them became a \
         fact. Nothing was changed; what you had is still loaded.",
        lines.len()
    )
}

fn refusal_text(e: fathom_ingest::IngestRefusal) -> String {
    match e {
        fathom_ingest::IngestRefusal::Undecodable { offset } => {
            format!("the paste is not UTF-8: the first bad byte is at offset {offset}")
        }
        fathom_ingest::IngestRefusal::TooLarge { bytes, lines } => format!(
            "the paste is {bytes} bytes over {lines} lines; the caps are {} and {}",
            fathom_ingest::MAX_PASTE_BYTES,
            fathom_ingest::MAX_PASTE_LINES
        ),
        // **The most likely real input on this path, and it must not read as "your
        // firewall is empty".** A header with no records is what OPNsense issue #10595
        // produces: the Migration assistant reports 47 legacy rules and writes a 0-byte
        // `download_rules.csv` (opened 22 July 2026 against 26.7.1, still open with no fix
        // found, re-established 2026-08-16, ADR-0034). An empty export and a firewall
        // with no rules are the same file, so an operator told nothing may document a
        // firewall as having no rules.
        //
        // The message says what the file is, whose bug it is, and where the rules still
        // are, naming the version. It suggests no workaround, since none was established.
        fathom_ingest::IngestRefusal::EmptyTable { columns } => format!(
            "this is a rules table with {columns} columns and not one rule under them. \
             THIS DOES NOT MEAN YOUR FIREWALL HAS NO RULES. If it came from OPNsense's \
             Firewall → Rules → Migration assistant, an empty export is a known bug in \
             the assistant, not a fact about your firewall: opnsense/core issue #10595 \
             reports it writing a 0-byte download_rules.csv while telling the operator it \
             had found 47 rules (opened 22 July 2026 against 26.7.1, still open and \
             unanswered on 2026-08-16). Your rules are in /conf/config.xml and your \
             firewall is still enforcing them. Fathom has refused this file rather than \
             record an estate with no policies in it, and has not touched what you had."
        ),
    }
}

/// Why one line was not bound, in the words the person who pasted it would use.
/// Every arm names something they can act on: *"Fathom does not know this
/// statement yet"* differs from *"the paste is clipped"*, and "unparsed" would hide
/// which.
fn residue_reason(outcome: &fathom_ingest::frame::LineOutcome) -> String {
    use fathom_ingest::frame::{LineOutcome, ShapeError};
    match outcome {
        LineOutcome::Unmapped { known_prefix } => match known_prefix {
            0 => "not in the dictionary".to_owned(),
            1 => "not in the dictionary past the first word".to_owned(),
            n => format!("not in the dictionary past the first {n} words"),
        },
        LineOutcome::Unshaped { reason } => match reason {
            ShapeError::NotVerbInitial => {
                "does not start with a config verb — a clipped or wrapped line".to_owned()
            }
            ShapeError::UnsupportedVerb => "not a `set` statement".to_owned(),
            ShapeError::UnterminatedQuote => "an unclosed quote".to_owned(),
            ShapeError::UnterminatedBracket => "an unclosed bracket".to_owned(),
            ShapeError::UnterminatedContinuation => {
                "ends in a continuation with nothing after it".to_owned()
            }
            ShapeError::KeyUnparsable => {
                "the name this statement configures could not be read".to_owned()
            }
            ShapeError::TooManySegments => "more than 64 words deep".to_owned(),
            // Said in full: the one residue reason whose remedy is a specific edit to the
            // file. The operator can find the stray delimiter in a description, quote it, and
            // paste again.
            ShapeError::RowWidth { cells, columns } => format!(
                "this row has {cells} fields where the header names {columns} columns, so \
                 which value belongs to which column is not known — most often an \
                 unquoted `;` inside a description. The whole row is shown rather than \
                 guessed at: a rule read one column out would say `any` where your file \
                 says a network."
            ),
        },
        // THE BYTE COUNT IS GONE, as the shape sketch lost its per-token length: a
        // quarantined line is one the gate believes carries a secret, so its exact length
        // bounds that secret. `14` §9.5: `orig_len` is "for the in-session report only;
        // the persistence layer must not store it", and this string is journalled with
        // the residue and travels with the export. The label says WHAT was held back,
        // which is what a person acts on.
        LineOutcome::Quarantined { label, .. } => {
            format!("held back at the redaction gate: {}", label.token())
        }
        // Reachable only through `csv.rs`, and never as residue (a header is
        // understood). Named so the `{other:?}` arm below never prints a Rust debug
        // string at a person.
        LineOutcome::Header { columns } => {
            format!("the header row — it named {columns} columns")
        }
        // `ingest` builds `residue` from exactly the three arms above, so this is
        // unreachable through it. Naming the outcome keeps a future fourth arm visible.
        other => format!("{other:?}"),
    }
}

fn target_text(target: &fathom_ingest::bind::PendingTarget) -> String {
    use fathom_ingest::bind::PendingTarget;
    match target {
        PendingTarget::ByName { kind, name } => format!("{} {}", kind.name(), name.0),
        PendingTarget::InterfaceUnit { kind, name, unit } => {
            format!("{} {}.{unit}", kind.name(), name.0)
        }
    }
}

/// `key`'s wire name from the generated registry (ADR-0008), or empty if a future
/// key named nothing there (refused loudly by the schema gate long before this).
fn field_name(key: fathom_ir::bag::FieldKey) -> &'static str {
    fathom_ir::generated::ir_types::FIELD_KEYS
        .iter()
        .find(|(_, k)| *k == key.0)
        .map(|(name, _)| *name)
        .unwrap_or_default()
}

/// The comma-joined detectors that fired on one destroyed value (`14` §9.2:
/// "redacted once and the manifest records both reasons").
fn detector_names(d: fathom_ingest::redact::DetectorSet) -> String {
    use fathom_ingest::redact::DetectorSet;
    const NAMED: [(u8, &str); 6] = [
        (DetectorSet::PATH, "path"),
        (DetectorSet::CRYPT_PREFIX, "crypt-prefix"),
        (DetectorSet::PEM_ARMOUR, "pem-armour"),
        (DetectorSet::LONG_HEX, "long-hex"),
        (DetectorSet::BASE64, "base64"),
        (DetectorSet::LEAF_NAME, "leaf-name"),
    ];
    NAMED
        .iter()
        .filter(|(bit, _)| d.0 & bit != 0)
        .map(|(_, name)| *name)
        .collect::<Vec<_>>()
        .join(",")
}

/// The gutter word for one terminal-noise class, never the Rust variant name (see
/// [`protocol::FACE_LINE`]).
fn noise_class_word(c: fathom_ingest::frame::NoiseClass) -> &'static str {
    use fathom_ingest::frame::NoiseClass;
    match c {
        NoiseClass::Prompt => "prompt",
        NoiseClass::CommandEcho => "command-echo",
        NoiseClass::ClusterBanner => "cluster-banner",
        NoiseClass::Pagination => "pagination",
    }
}

/// [`protocol::FACE_LINE`]'s rows: one per ledger line, in ledger order.
///
/// The "built fields" column is read off the FRAGMENT, not the outcome's counters
/// (`LineOutcome::Bound.fields` is a count). A field assertion's `BindProv.line`
/// names its ledger line (`bind.rs`), so every field the weld wrote lands under the
/// line that asserted it. Pending edges' fields are excluded: `apply`'s step 9
/// never writes them (`14` §7.3), so including them would claim a field was built
/// that nothing holds.
fn line_rows(
    ingest: &fathom_ingest::IngestOutput,
    weld: &fathom_weld::WeldOutput,
) -> Vec<[String; 7]> {
    use fathom_ingest::frame::LineOutcome;
    use std::collections::BTreeMap;

    let mut fields_by_line: BTreeMap<u32, Vec<&'static str>> = BTreeMap::new();
    for node in &ingest.fragment.nodes {
        for a in &node.fields {
            fields_by_line
                .entry(a.prov.line.0)
                .or_default()
                .push(field_name(a.key));
        }
    }
    for edge in &ingest.fragment.edges {
        for a in &edge.fields {
            fields_by_line
                .entry(a.prov.line.0)
                .or_default()
                .push(field_name(a.key));
        }
    }

    ingest
        .ledger
        .lines
        .iter()
        .take(LINE_ROW_CAP)
        .map(|r| {
            let (token, node_id, reason): (&str, String, String) = match &r.outcome {
                LineOutcome::Bound { node, .. } => (
                    "built",
                    weld.nodes
                        .get(node.0 as usize)
                        .map(fathom_graph::NodeId::to_string)
                        .unwrap_or_default(),
                    String::new(),
                ),
                LineOutcome::Quarantined { label, .. } => {
                    ("quarantined", String::new(), label.token().to_owned())
                }
                LineOutcome::Noise { class } => {
                    ("noise", String::new(), noise_class_word(*class).to_owned())
                }
                LineOutcome::Blank => ("noise", String::new(), String::new()),
                other => ("kept", String::new(), residue_reason(other)),
            };
            let fields = fields_by_line
                .get(&r.ordinal.0)
                .map(|v| v.join(","))
                .unwrap_or_default();
            [
                r.ordinal.0.to_string(),
                token.to_owned(),
                r.span.start.to_string(),
                r.span.end.to_string(),
                node_id,
                fields,
                reason,
            ]
        })
        .collect()
}

/// [`protocol::FACE_DROP`]'s rows: one per destroyed value. Never reads
/// `RedactionEntry::orig_len` (see that face).
///
/// Takes the manifest, not `&IngestOutput`, so `OP_REDACT_TEXT`'s
/// `fathom_ingest::redact_only` (a `DropManifest`, no `IngestOutput`) reads it
/// too: one row shape for both doors.
fn drop_rows(drops: &fathom_ingest::redact::DropManifest) -> Vec<[String; 5]> {
    drops
        .entries
        .iter()
        .take(DROP_ROW_CAP)
        .map(|e| {
            [
                e.ordinal.0.to_string(),
                e.span.start.to_string(),
                e.span.end.to_string(),
                e.label.token().to_owned(),
                detector_names(e.detectors),
            ]
        })
        .collect()
}

/// The reply one successful paste produces: what was understood, what was not,
/// and what was named and not found.
fn paste_reply(
    graph: &fathom_graph::Graph,
    ingest: &fathom_ingest::IngestOutput,
    weld: &fathom_weld::WeldOutput,
    platform: &str,
) -> Vec<u8> {
    let text = ingest.capture.text();

    let residue: Vec<[String; 3]> = ingest
        .residue
        .iter()
        .take(RESIDUE_ROW_CAP)
        .map(|r| {
            let line = text
                .get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default();
            [
                (r.ordinal.0 + 1).to_string(),
                line.to_owned(),
                residue_reason(&r.outcome),
            ]
        })
        .collect();

    let unresolved: Vec<[String; 3]> = weld
        .unresolved
        .iter()
        .take(UNRESOLVED_ROW_CAP)
        .map(|u| {
            [
                target_text(&u.target),
                u.kind.name().to_owned(),
                (u.line.0 + 1).to_string(),
            ]
        })
        .collect();

    let page = fathom_inventory::element_page(graph, weld.device);
    let (device_id, hostname) = match &page {
        Some(p) => (p.id.as_str(), p.name.as_str()),
        None => ("", ""),
    };

    // Edges: the fragment's own plus the containment edges the weld materialised.
    // Both are edges in the store; counting only the first would under-report by
    // roughly the node count.
    let edges = (weld.edges.len() + weld.containment.len()).to_string();
    let nodes = weld.nodes.len().to_string();
    let residue_total = ingest.residue.len().to_string();
    let secrets = ingest.drops.entries.len().to_string();
    let unresolved_total = weld.unresolved.len().to_string();

    // WHAT THIS PASTE PRODUCED, in sixteen characters (`49` §19 phase 0, item 3).
    //
    // The journal records the redacted TEXT and replay re-runs the parser, so a build
    // with a better dictionary rebuilds a DIFFERENT estate from the same file,
    // silently. This digest lets the page notice (`fathom_graph::shape` argues what
    // is in it, and why it is drift detection, never a seal).
    //
    // It rides the paste reply, not its own opcode: a paste is the only step whose
    // output depends on a dictionary that changes underneath it. 448 module bytes
    // cheaper, at 203 bytes of headroom.
    let shape = fathom_graph::shape_hex(graph);
    let lines = line_rows(ingest, weld);
    let drops = drop_rows(&ingest.drops);

    protocol::encode_paste_reply(&protocol::PasteReply {
        summary: [
            &nodes,
            &edges,
            &residue_total,
            &secrets,
            &unresolved_total,
            device_id,
            hostname,
            platform,
        ],
        residue: &residue,
        unresolved: &unresolved,
        capture: text,
        shape: &shape,
        lines: &lines,
        drops: &drops,
    })
}

/// One hand-authoring assertion's provenance: `Origin::Hand`, the host's clock,
/// and `Confidence::Asserted`.
///
/// `Asserted` is right: the values mean *how directly the thing was observed*
/// (`11` §8.3), not *how much we trust the source*. Someone typing what is in front
/// of them observed it as directly as anything. Grading hand entry lower would
/// confuse confidence with authority.
///
/// A fresh id per record: `Graph::check_prov` fills `supersedes` from the slot's
/// current provenance, so a reused id becomes `ProvenanceIdReused`.
fn hand_record(
    mint: &mut fathom_weld::Mint,
    at: fathom_graph::Timestamp,
    actor: fathom_graph::Actor,
) -> Result<fathom_graph::ProvenanceRecord, String> {
    Ok(fathom_graph::ProvenanceRecord {
        id: fathom_graph::ProvenanceId(mint.next().map_err(|e| format!("{e:?}"))?),
        origin: fathom_graph::Origin::Hand,
        asserted_at: at,
        asserted_by: actor,
        confidence: fathom_graph::Confidence::Asserted,
        supersedes: None,
    })
}

/// `[u8 count]` then `count` x `[u16 key][u16 len][utf8]`.
///
/// Every read is bounds-checked and every failure names the field index, so a
/// malformed frame points at which field.
fn parse_field_list(bytes: &[u8]) -> Result<Vec<(fathom_ir::bag::FieldKey, String)>, String> {
    let Some((count, mut rest)) = bytes.split_first() else {
        return Err("the field list is missing its count byte".to_owned());
    };
    let count = usize::from(*count);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let Some(head) = rest.get(..4) else {
            return Err(format!(
                "field {i} of {count} is truncated: {} bytes left, 4 needed for its header",
                rest.len()
            ));
        };
        let key = u16::from_le_bytes([*head.first().unwrap_or(&0), *head.get(1).unwrap_or(&0)]);
        let len = usize::from(u16::from_le_bytes([
            *head.get(2).unwrap_or(&0),
            *head.get(3).unwrap_or(&0),
        ]));
        let Some(value) = rest.get(4..4 + len) else {
            return Err(format!(
                "field {i} of {count} claims {len} bytes and only {} remain",
                rest.len().saturating_sub(4)
            ));
        };
        let text = core::str::from_utf8(value).map_err(|e| {
            format!(
                "field {i} of {count} is not UTF-8 at byte {}",
                e.valid_up_to()
            )
        })?;
        out.push((fathom_ir::bag::FieldKey(u32::from(key)), text.to_owned()));
        rest = rest.get(4 + len..).unwrap_or_default();
    }
    if !rest.is_empty() {
        return Err(format!(
            "the field list declares {count} fields and {} trailing bytes remain",
            rest.len()
        ));
    }
    Ok(out)
}

/// A refused hand-entered value, in the words of the person who typed it. Quotes
/// their text back: "invalid" alone makes them guess which of four boxes.
fn author_text(e: fathom_inventory::AuthorError, text: &str) -> String {
    match e {
        fathom_inventory::AuthorError::Parse(p) => {
            match p.kind {
                fathom_ir::scalar::ScalarParseErrorKind::Syntax { expected } => {
                    format!("{:?} is not a {}: expected {expected}", text, p.scalar)
                }
                fathom_ir::scalar::ScalarParseErrorKind::Range { what } => {
                    format!("{:?} is out of range for {}: {what}", text, p.scalar)
                }
                fathom_ir::scalar::ScalarParseErrorKind::Charset { offset } => format!(
                    "{:?} has a character {} does not allow, at byte {offset}",
                    text, p.scalar
                ),
                fathom_ir::scalar::ScalarParseErrorKind::HostBits => {
                    format!("{text:?} sets host bits: a prefix must name a network, not an address in it")
                }
            }
        }
        fathom_inventory::AuthorError::UnsupportedType { key, declared } => format!(
            "field {} is declared {declared}, which cannot be typed in yet",
            key.0
        ),
        fathom_inventory::AuthorError::UnknownKey(key) => {
            format!("field key {} is not in the schema", key.0)
        }
    }
}

/// What one hand-added piece of equipment produced: the display id to select, and
/// how many fields were stored.
fn equip_reply(device: fathom_graph::NodeId, written: usize) -> Vec<u8> {
    equip_reply_text(&device.to_string(), &written.to_string())
}

/// The same reply from strings, so edit and remove opcodes answer in the shape
/// the page already reads.
fn equip_reply_text(id: &str, written: &str) -> Vec<u8> {
    protocol::encode_paste_reply(&protocol::PasteReply {
        summary: [id, written, "", "", "", id, "", ""],
        residue: &[],
        unresolved: &[],
        capture: "",
        shape: "",
        lines: &[],
        drops: &[],
    })
}

/// `OP_LOAD_PLAIN`'s success reply: nodes, edges and the shape digest, the same
/// three numbers a paste reports. Residue and unresolved are always empty:
/// nothing was PARSED, every stated field loaded whole through the writer's
/// inverse (`fathom_workspace::read_plain`).
fn load_plain_reply(graph: &fathom_graph::Graph) -> Vec<u8> {
    let nodes = graph.nodes().count().to_string();
    let edges = graph.edges().count().to_string();
    let shape = fathom_graph::shape_hex(graph);
    protocol::encode_paste_reply(&protocol::PasteReply {
        summary: [&nodes, &edges, "", "", "", "", "", ""],
        residue: &[],
        unresolved: &[],
        capture: "",
        shape: &shape,
        lines: &[],
        drops: &[],
    })
}

/// Fixed-width little-endian reads that never index out of bounds; the three
/// widths the frames use.
fn le4(b: &[u8], at: usize) -> [u8; 4] {
    let mut o = [0u8; 4];
    for (i, slot) in o.iter_mut().enumerate() {
        *slot = *b.get(at + i).unwrap_or(&0);
    }
    o
}

fn le2(b: &[u8], at: usize) -> [u8; 2] {
    let mut o = [0u8; 2];
    for (i, slot) in o.iter_mut().enumerate() {
        *slot = *b.get(at + i).unwrap_or(&0);
    }
    o
}

fn le8(b: &[u8], at: usize) -> [u8; 8] {
    let mut o = [0u8; 8];
    for (i, slot) in o.iter_mut().enumerate() {
        *slot = *b.get(at + i).unwrap_or(&0);
    }
    o
}

fn le16(b: &[u8], at: usize) -> [u8; 16] {
    let mut o = [0u8; 16];
    for (i, slot) in o.iter_mut().enumerate() {
        *slot = *b.get(at + i).unwrap_or(&0);
    }
    o
}

/// A cursor over the request bytes that refuses every short read.
///
/// `pub(crate)` so `dictframe` decodes `OP_DICT`'s frame with the same reader as
/// `OP_INIT`'s: two cursors for two same-shape frames is how an off-by-one hides.
pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Cursor<'a> {
        Cursor { bytes, at: 0 }
    }

    /// How far the cursor has read: the trailing-bytes check both frames make.
    pub(crate) fn at(&self) -> usize {
        self.at
    }

    pub(crate) fn u8(&mut self) -> Result<u8, (u16, String)> {
        if self.at >= self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let b = self.bytes[self.at];
        self.at += 1;
        Ok(b)
    }

    pub(crate) fn u32(&mut self) -> Result<u32, (u16, String)> {
        if self.at + 4 > self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let v = u32::from_le_bytes([
            self.bytes[self.at],
            self.bytes[self.at + 1],
            self.bytes[self.at + 2],
            self.bytes[self.at + 3],
        ]);
        self.at += 4;
        Ok(v)
    }

    pub(crate) fn text(&mut self, len: u32) -> Result<String, (u16, String)> {
        let len = len as usize;
        let end = self.at.checked_add(len).ok_or_else(|| {
            (
                ERR_BAD_FRAME,
                format!("length overflows at byte {}", self.at),
            )
        })?;
        if end > self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let slice = &self.bytes[self.at..end];
        self.at = end;
        std::str::from_utf8(slice).map(str::to_owned).map_err(|e| {
            (
                ERR_BAD_UTF8,
                format!("not UTF-8 at byte {}: {e}", self.at - len),
            )
        })
    }
}

/// §4.4's OP_INIT frame. Names are labels, never opened; each is prefixed with its
/// section directory so a load error reads as `load_corpus`'s does.
fn parse_init_frame(req: &[u8]) -> Result<Vec<SourceFile>, (u16, String)> {
    let mut c = Cursor::new(req);
    let file_count = c.u32()?;
    let mut files: Vec<SourceFile> = Vec::new();
    for _ in 0..file_count {
        let section = match c.u8()? {
            0 => Section::Commands,
            1 => Section::Explainers,
            2 => Section::Rules,
            3 => Section::Concepts,
            other => {
                return Err((
                    ERR_BAD_FRAME,
                    format!(
                        "section byte {other} at byte {} is not 0, 1, 2 or 3",
                        c.at - 1
                    ),
                ))
            }
        };
        let name_len = c.u32()?;
        let name = c.text(name_len)?;
        let source_len = c.u32()?;
        let source = c.text(source_len)?;
        let name = format!("{}{name}", section_prefix(section));
        if files.iter().any(|f| f.section == section && f.name == name) {
            return Err((
                ERR_BAD_FRAME,
                format!("duplicate source `{name}` in the init frame"),
            ));
        }
        files.push(SourceFile {
            section,
            name,
            source,
        });
    }
    if c.at != req.len() {
        return Err((
            ERR_BAD_FRAME,
            format!(
                "{} trailing bytes after {file_count} sources",
                req.len() - c.at
            ),
        ));
    }
    Ok(files)
}

fn section_prefix(section: Section) -> &'static str {
    match section {
        Section::Commands => "commands/",
        Section::Explainers => "explainers/",
        Section::Rules => "rules/",
        Section::Concepts => "concepts/",
    }
}

/// A read path into the held estate, **for tests only**. The opcodes answer with
/// rendered faces, not the graph, so a test could see what a face SAID and never
/// who a fact was ATTRIBUTED TO (why the clock-derived author survived).
///
/// Gated behind `inspect`, enabled only by this crate's dev-dependency;
/// `artifact_gates.rs` proves it is absent from the shipping module.
#[cfg(feature = "inspect")]
impl Shell {
    pub fn estate_for_test(&self) -> Option<&fathom_graph::Graph> {
        self.estate.as_ref()
    }

    /// The rules the last `OP_CHECKS` ran again (indexes into `checks::RULES`).
    pub fn checks_last_run_for_test(&self) -> &[usize] {
        self.checks.last_run()
    }
}

/// **IS THIS A BOX THE DESIGN ALREADY HOLDS?** The answer is never a merge, only a
/// question or a no.
///
/// Returns the refusal text when a live `Device` in `estate` matches the
/// freshly-welded `Device` in `dry` on any identity tier the SCHEMA declares, else
/// `None`.
///
/// **The tiers come from `schema/`**: `NodeKind::identity_tiers()` is generated
/// from `schema/schema.yaml`. Hard-coding "hostname and platform" is the
/// hand-written per-kind rule ADR-0008 forbids.
///
/// **A tier counts only when every term in it is present.** `Device` declares
/// `[hostname, platform]` and `[platform, management_address]`. With no `set
/// system host-name` the first is unevaluable, and **no junos-srx dictionary entry
/// populates `management_address`** (zero hits in `corpus/dict/`), so the second
/// is too. Such a device always welds as new, and the reply says so rather than
/// letting the estate fill with duplicates.
///
/// A term not resolvable to a field is likewise unevaluable, never a match.
/// `Interface`'s `owner(Device)` makes every sub-device tier unusable: none can be
/// evaluated until two devices are known to be the same, the decision being
/// refused.
fn identity_clash(estate: &fathom_graph::Graph, dry: &fathom_graph::Graph) -> Option<String> {
    use fathom_ir::generated::ir_types::{DeviceField, NodeKind};

    // The paste's device; `apply_new_device` seeds exactly one.
    let fresh = dry.nodes_of_kind(NodeKind::Device).next()?;

    // Resolve each declared term to a field key. Only `Device`'s own fields resolve
    // here; anything else leaves the tier unevaluable.
    let term_key = |term: &str| -> Option<fathom_ir::bag::FieldKey> {
        DeviceField::ALL
            .iter()
            .find(|f| f.name() == term)
            .map(|f| f.key())
    };

    for tier in NodeKind::Device.identity_tiers() {
        let mut wanted = Vec::new();
        let mut evaluable = true;
        for term in *tier {
            match term_key(term).and_then(|k| fathom_inventory::field_text(dry, fresh.id, k)) {
                Some(text) => wanted.push((term_key(term).expect("resolved above"), text)),
                None => {
                    evaluable = false;
                    break;
                }
            }
        }
        if !evaluable || wanted.is_empty() {
            continue;
        }

        // Ordered by NodeId so the device named in the refusal is the same every time
        // (invariant 9).
        let mut hits: Vec<fathom_graph::NodeId> = estate
            .nodes_of_kind(NodeKind::Device)
            .filter(|n| {
                n.absent_since.is_none()
                    && wanted.iter().all(|(k, text)| {
                        fathom_inventory::field_text(estate, n.id, *k).as_deref()
                            == Some(text.as_str())
                    })
            })
            .map(|n| n.id)
            .collect();
        hits.sort();
        let Some(hit) = hits.first().copied() else {
            continue;
        };

        let name = term_key("hostname")
            .and_then(|k| fathom_inventory::field_text(estate, hit, k))
            .unwrap_or_else(|| "that device".to_owned());
        let terms: Vec<&str> = tier.to_vec();
        return Some(format!(
            "{name} is already in this design — the same {}. Fathom will not \
             merge a second reading of a box it already has: it cannot yet, and \
             guessing would put two half-true versions of one device in your \
             estate of record. If this is a DIFFERENT box that happens to match, \
             say so and it will be added as a second device. If it is the SAME \
             box and this config is newer, there is no update yet — that is \
             re-identification and nothing in this build implements it.|{}|{}",
            terms.join(" and "),
            fathom_graph::ElementId::Node(hit),
            name
        ));
    }
    None
}

//! Opcode dispatch over WO-07 §4.4's byte protocol. One call, one reply; a
//! failure is a typed error record, never a trap and never an unwind across
//! the boundary (41 §3.9).
//!
//! The shell owns the only mutable state in the module: the finder, absent
//! until `OP_INIT` succeeds. Nothing here reads a clock, draws entropy or
//! touches a filesystem — which is why the built module's import section is
//! empty (`wasmbin::IMPORT_ALLOWLIST`).

use fathom_corpus::{CorpusIndex, Section, SourceFile};
use fathom_find::Finder;

use crate::protocol::{
    self, ERR_BAD_FRAME, ERR_BAD_UTF8, ERR_CORPUS_LOAD, ERR_EQUIP_FRAME, ERR_EQUIP_STORE,
    ERR_FIELD_VALUE, ERR_INGEST_REFUSED, ERR_LINK_CHOICE, ERR_NOTHING_UNDERSTOOD,
    ERR_NOT_INITIALISED, ERR_NO_DICTIONARY, ERR_NO_ELEMENT, ERR_NO_LINK, ERR_PASTE_FRAME,
    ERR_UNKNOWN_OP, ERR_WELD_REFUSED,
};
#[cfg(feature = "demo-estate")]
use crate::OP_ESTATE_DEMO;
use crate::{
    OP_DIAGRAM, OP_DICT, OP_ELEMENT, OP_ELEMENT_REMOVE, OP_EQUIPMENT, OP_EQUIP_ADD, OP_FIELD_SET,
    OP_INIT, OP_INV_ROWS, OP_LINK, OP_PASTE, OP_PLACE, OP_QUERY, OP_RACK_ELEVATION, OP_RACK_PLACE,
};

pub struct Shell {
    finder: Option<Finder>,
    /// The inventory face's graph (WO-08 §4.4). Absent until `OP_PASTE` or
    /// `OP_EQUIP_ADD` succeeds; the only workspace this build ever holds.
    /// `OP_ESTATE_DEMO` was a third door and is gone from the shipping module
    /// with the fixture it loaded — see `estate_demo`.
    estate: Option<fathom_graph::Graph>,
    /// The junos-srx statement dictionary, handed in by the host over
    /// `OP_DICT` and held for the module's lifetime. Absent until that call
    /// succeeds, which is why `OP_PASTE` can refuse with `ERR_NO_DICTIONARY`.
    dict: Option<fathom_ingest::dict::Dictionary>,
    /// The OPNsense firewall-rules dictionary, on the same terms. A second
    /// slot rather than a replacement: a paste chooses one, and the one it did
    /// not choose must still be there for the next paste.
    csv_dict: Option<fathom_ingest::dict::Dictionary>,
}

impl Shell {
    pub fn new() -> Shell {
        Shell {
            finder: None,
            estate: None,
            dict: None,
            csv_dict: None,
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
            // Called ONCE PER PLATFORM, and the frame decides which slot it
            // fills — the dictionary's own `platform:` line, not the call
            // order and not a new frame field. `from_sources` already refuses
            // a file set whose platforms disagree, so by the time a dictionary
            // exists it has exactly one platform and asking it is free.
            //
            // The rejected alternative was a platform byte in the frame: it
            // would let a page label a dictionary something the YAML does not
            // say, and then a paste would be read by one platform's grammar
            // and provenanced as another's. Nothing downstream could notice.
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
            OP_EQUIP_ADD => self.equip_add(req),
            OP_FIELD_SET => self.field_set(req),
            OP_ELEMENT_REMOVE => self.element_remove(req),
            OP_PLACE => self.place(req),
            OP_LINK => self.link(req),
            OP_DIAGRAM => self.diagram(req),
            OP_INV_ROWS => self.inv_rows(req),
            OP_ELEMENT => self.element(req),
            OP_EQUIPMENT => self.equipment(req),
            OP_RACK_PLACE => self.rack_place(req),
            OP_RACK_ELEVATION => self.rack_elevation(req),
            _ => protocol::encode_error(
                ERR_UNKNOWN_OP,
                &format!("opcode {op} is not implemented by this module"),
            ),
        }
    }

    /// No request bytes. Re-init is permitted, mirroring `OP_INIT`: the held
    /// estate is replaced.
    ///
    /// **Not in the shipping module.** The fixture it loads costs 35,272 bytes
    /// of `44` §5.2's ceiling and the product has had real inputs since the
    /// on-ramp landed, so `fathom-inventory`'s `demo-estate` feature is off in
    /// every build except a test build (see that crate's Cargo.toml). With the
    /// feature off, opcode 11 falls through to the `_` arm and is refused by
    /// number with `ERR_UNKNOWN_OP` — a typed refusal the page renders, not a
    /// trap and not a silent no-op. The opcode NUMBER stays reserved forever
    /// either way: 41 §3.7's table is append-only, so 11 is never reused.
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

    /// `OP_PASTE`: pasted text in, an estate out.
    ///
    /// Frame — a fixed 24-byte prefix, then the paste:
    ///
    /// ```text
    ///   0   8   at_ms   (u64) the host's clock, once, for the whole apply
    ///   8  16   entropy (u128) the host's CSPRNG, once, the mint's base
    ///  24   ..  the pasted bytes, verbatim and un-decoded
    /// ```
    ///
    /// Both are the host's because this module has neither and must not
    /// acquire either — the import section is empty and stays empty
    /// (`wasmbin::IMPORT_ALLOWLIST`). `fathom_weld::Manifest` is shaped for
    /// exactly this: invariant 9 puts nondeterminism at the host boundary and
    /// nowhere else.
    ///
    /// The paste is handed on **un-decoded**. `ingest` does its own UTF-8
    /// check and reports the offset of the first bad byte, which is a better
    /// answer than this layer's "not UTF-8".
    ///
    /// On success the held estate is replaced. A refusal leaves the previous
    /// estate in place: a paste that Fathom could not read is not a reason to
    /// throw away the one it could.
    fn paste(&mut self, req: &[u8]) -> Vec<u8> {
        const PREFIX: usize = 24;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!(
                    "OP_PASTE needs a {PREFIX}-byte clock and entropy prefix; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let (at_bytes, entropy_bytes) = head.split_at(8);
        let mut at = [0u8; 8];
        at.copy_from_slice(at_bytes);
        let mut entropy = [0u8; 16];
        entropy.copy_from_slice(entropy_bytes);
        let at = fathom_graph::Timestamp(u64::from_le_bytes(at));
        let entropy = u128::from_le_bytes(entropy);
        let text = req.get(PREFIX..).unwrap_or_default();

        // Which grammar is this? The sniff is exact — the first non-blank line
        // must begin `@uuid` followed by `;` or `,`, which is the OPNsense
        // Migration assistant's header and nothing else (`64` §1.1). A fuzzy
        // sniff would occasionally read a Junos paste as a table, and the cost
        // of that is the operator's estate replaced by nonsense.
        let table = fathom_ingest::csv::looks_like_rules_csv(text);

        // No fallback, by design. Until 2026-08-15 this built a compiled-in
        // dictionary here; the bytes moved to the page (`crate::dictframe`) and
        // what is left is a typed refusal. It is stated rather than tolerated
        // because the tolerant version — carry on with an empty dictionary —
        // binds nothing, and the operator is then told their config is
        // unrecognised when in fact the page never finished booting.
        //
        // Two slots, one per grammar, and the refusals are worded apart: a page
        // that booted the set-form dictionary and forgot the table one is a
        // different defect from a page that booted neither, and "no dictionary"
        // would send whoever reads it to the wrong place.
        let held = if table {
            self.csv_dict.as_ref()
        } else {
            self.dict.as_ref()
        };
        let Some(dict) = held else {
            return protocol::encode_error(
                ERR_NO_DICTIONARY,
                if table {
                    "no table dictionary is loaded: OP_DICT must hand in a rules-CSV \
                     dictionary before a rules export can be read"
                } else {
                    "no statement dictionary is loaded: OP_DICT must succeed before OP_PASTE"
                },
            );
        };

        let read = if table {
            fathom_ingest::csv::ingest_csv(text, dict)
        } else {
            fathom_ingest::ingest(text, dict)
        };
        let ingest = match read {
            Ok(o) => o,
            Err(e) => return protocol::encode_error(ERR_INGEST_REFUSED, &refusal_text(e)),
        };

        // A paste that bound nothing is not an estate, and applying it anyway
        // is the worst thing this module can do: the binder seeds a `Device`
        // root before it reads a single statement, so a Cisco config — or Junos
        // in its curly-brace form, which is what `show configuration` prints
        // without `| display set` — validates, welds, and **replaces the
        // operator's real estate with an empty device**. Silently. That was
        // live from the day `OP_PASTE` landed until 2026-08-10.
        //
        // The refusal criterion is exact, not a heuristic: zero lines with
        // outcome `Bound`. Only the *wording* below guesses, and guessing at
        // wording costs nothing. A heuristic that refused a legitimate paste
        // would be worse than the bug.
        if bound_lines(&ingest) == 0 {
            return protocol::encode_error(ERR_NOTHING_UNDERSTOOD, &nothing_understood(&ingest));
        }

        // The user and batch ids: the millisecond plus a fixed discriminator,
        // the pattern `fathom-inventory`'s demo estate and the weld's own
        // tests both use. Colliding with a minted element ULID is harmless —
        // `by_ulid` covers nodes and edges only, and batch ids are checked
        // against other batch ids, of which a fresh graph has none.
        // `ids` mints the BATCH only. The author was `ids(1)` until 2026-08-21
        // — derived from the host clock, so a fifty-op estate carried up to
        // fifty distinct "users", none of them anybody. See `UserId::LOCAL`.
        let ids = |n: u128| fathom_id::Ulid::from_parts(at.0, n);
        let Ok(batch) = ids(2) else {
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
            platform: fathom_ir::scalar::PlatformId(dict.platform().to_owned()),
        };

        let mut graph = fathom_graph::Graph::new();
        let weld = match fathom_weld::apply_new_device(&mut graph, &ingest, &manifest) {
            Ok(w) => w,
            Err(e) => return protocol::encode_error(ERR_WELD_REFUSED, &format!("{e:?}")),
        };

        let reply = paste_reply(&graph, &ingest, &weld, dict);
        self.estate = Some(graph);
        reply
    }

    /// `OP_EQUIP_ADD`: one piece of equipment, entered by hand.
    ///
    /// Frame — the same 24-byte prefix `OP_PASTE` uses, then a field list:
    ///
    /// ```text
    ///   0   8   at_ms   (u64) the host's clock
    ///   8  16   entropy (u128) the host's CSPRNG
    ///  24   1   count   (u8) how many fields follow
    ///  25  ..   count x [u16 field_key][u16 byte_len][utf8 value]
    /// ```
    ///
    /// # What it builds, and why it is more than one node
    ///
    /// `Device` has twelve fields and **`model` is not among them** — model and
    /// serial live on `Chassis`, because a chassis cluster is one `Device` with
    /// two `Chassis` and the model belongs to the box, not to the logical
    /// device. That is right, and it is also invisible to the person typing
    /// "SRX345" into a form. So this opcode creates the `Chassis` silently, with
    /// `member_index` 0 unless one is supplied, and routes each field to
    /// whichever kind declares it.
    ///
    /// The routing is **derived, never hand-written**: a key is looked up in
    /// `DeviceField::ALL` and then `ChassisField::ALL`, both generated from
    /// `schema/`. A field that moves between kinds in a later schema version
    /// moves here with no edit. The containment edge is likewise computed by
    /// `fathom_weld::containment_edge`, not named.
    ///
    /// # What it does not do
    ///
    /// No `Site`. `11` §7.2's containment rule is an upper bound at write time,
    /// so a `Device` with no `HasDevice` in-edge is valid — the weld already
    /// relies on this for every paste. Inventing a site nobody asked for would
    /// put a fact in the estate that no human asserted.
    ///
    /// No reconciliation. Adding the same box twice makes two devices, exactly
    /// as pasting the same config twice does (`11` §10.4 has no implementation
    /// anywhere). That is a known hole, not a behaviour of this opcode.
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

        // Both `Device` identity tuples need `platform`, and the schema declares
        // hostname and platform `card: "1"`. A device missing either can never
        // be re-identified or merged with a later paste of the same box, so it
        // is refused at the door rather than stored as an orphan nobody can
        // reconcile. Nothing else is demanded.
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

        // Route every field to the kind that declares it, from the generated
        // tables. An unroutable key is a page defect and says so.
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

        // `Chassis.member_index` is `card: "1"`. Supplying it is not something a
        // person adding a standalone box should have to know about, so it is
        // defaulted here and overridden if the form sent one.
        if !on_chassis
            .iter()
            .any(|(k, _)| *k == ChassisField::MemberIndex.key())
        {
            on_chassis.push((ChassisField::MemberIndex.key(), "0".to_owned()));
        }

        // Parse everything BEFORE touching the store. A refusal must leave the
        // estate exactly as it was; a half-written device the user then has to
        // find and delete is worse than a rejected form.
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

        // `ids` mints the BATCH only. The author was `ids(1)` until 2026-08-21
        // — derived from the host clock, so a fifty-op estate carried up to
        // fifty distinct "users", none of them anybody. See `UserId::LOCAL`.
        let ids = |n: u128| fathom_id::Ulid::from_parts(at.0, n);
        let Ok(batch) = ids(2) else {
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

        // The estate is CREATED when absent and MUTATED when present. This is
        // the first opcode that does not replace it, and that is the whole point
        // of the door: you can start from nothing, and adding a second device
        // must not delete the first.
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
        // The batch closes either way. Leaving one open would refuse every
        // later write with `BatchOpen`, turning one bad form into a dead page.
        let closed = graph.end_batch();
        match (built, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &e),
            (Ok(_), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok((device, written)), Ok(_)) => equip_reply(device, written),
        }
    }

    /// `OP_FIELD_SET`: correct one field of one element.
    ///
    /// Frame — the usual prefix, then the key, then two lengths' worth of text:
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
    /// The value is parsed **before** the batch opens, so a refusal cannot leave
    /// a batch open or a slot half-written.
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

        // Parse first. A refused value must not open a batch.
        let parsed = match fathom_inventory::parse_into_slot(key, value) {
            Ok(v) => v,
            Err(e) => return protocol::encode_error(ERR_FIELD_VALUE, &author_text(e, value)),
        };

        let element = match self.resolve(display) {
            Ok(e) => e,
            Err(reply) => return reply,
        };

        // The batch and provenance ids come off the MINT, not from the clock
        // plus a fixed discriminator the way `OP_PASTE` derives its two. That
        // pattern is safe there because a paste builds one batch from a fresh
        // graph; it is not safe here. Two corrections inside the same
        // millisecond — one keystroke apart, which is ordinary — would mint the
        // same BatchId and the same ProvenanceId, and the store refuses both as
        // reused. The mint walks a counter from the host's entropy, so the
        // second edit in a millisecond gets its own ids.
        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };
        // The author is UserId::LOCAL, a constant, so only the two mints can
        // fail. It was `Ulid::from_parts(at.0, 1)` until 2026-08-21 — the host
        // clock — which made every millisecond a different "user".
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

    /// `OP_ELEMENT_REMOVE`: tombstone an element and its subtree.
    ///
    /// Frame: the 24-byte prefix, then the display id to the end.
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
        // Off the mint for the same reason `field_set` does: two removals in one
        // millisecond must not collide on a BatchId.
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
    /// Frame — the usual 24-byte prefix, then a mode byte, then the point, then
    /// the display id to the end:
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
    /// # Three properties this opcode has and the page must not reimplement
    ///
    /// **Snapping happens here.** `56` §3.5 puts pins on a 4 px grid, and the
    /// grid is `fathom_layout::snap` so every host agrees about where a gesture
    /// landed (invariant 9).
    ///
    /// **Moving a placed box is a supersession, not a second pin.** The existing
    /// pin's `x` and `y` are set again, and `Graph::set_field_boxed` archives the
    /// replaced slots, so the estate can answer *"where was this before, and who
    /// moved it"*. Creating a second pin would break `HasLayoutPin`'s `out:
    /// "0..1"` and lose the history in the same move.
    ///
    /// **Mode 0 on an unpinned element succeeds and does nothing.** "Put it back
    /// under computed layout" is a statement about the end state, and an
    /// operator who presses it twice has not made an error. It is the same
    /// reasoning `OP_ELEMENT_REMOVE` does not get to use — a second removal is a
    /// second claim about a thing that exists, where a second unpin is a claim
    /// about a thing that does not.
    ///
    /// Every id comes off the `Mint`, not from the clock plus a discriminator.
    /// Dragging is a *stream* of gestures: two placements one millisecond apart
    /// are ordinary, and the clock-plus-discriminator pattern would mint the same
    /// `BatchId` twice and the store would refuse the second. `field_set` records
    /// the same lesson.
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

        // A NODE, not an element. An edge is a line between two boxes and a line
        // has no position of its own — it is routed from its ends. Refusing here
        // rather than storing a pin the schema forbids (`HasLayoutPin` runs from
        // `Placeable`, which is kinds) keeps the refusal legible.
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
        // The author is a CONSTANT, so only the batch mint can fail here. It
        // used to be `Ulid::from_parts(at.0, 1)` — the host clock — which made
        // every millisecond a different "user". See `UserId::LOCAL`.
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
                // Tombstone, never delete: `11` §10.5 again. The record keeps
                // "this box was placed here and then released", which is a
                // different and more honest claim than "it was never placed".
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
        // The batch closes either way — an open batch refuses every later write
        // with `BatchOpen`, which turns one refused drag into a dead page.
        let closed = graph.end_batch();
        match (wrote, closed) {
            (Err(e), _) => protocol::encode_error(ERR_EQUIP_STORE, &e),
            (Ok(()), Err(e)) => protocol::encode_error(ERR_EQUIP_STORE, &format!("{e:?}")),
            (Ok(()), Ok(_)) => equip_reply_text(display, if mode == 0 { "0" } else { "1" }),
        }
    }

    /// `OP_LINK`: draw a link between two boxes by hand, or cut one.
    ///
    /// Frame — the usual 24-byte prefix, a mode byte, two lengths, then three
    /// strings back to back:
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
    /// # Four properties, and the second one is the whole design
    ///
    /// **Both ends are live nodes.** An edge is a line between two boxes; a line
    /// between a line and a box is not a thing the schema can express, and a
    /// line onto a removed box is a fact the diagram will never draw. Both are
    /// refused in `resolve_node` rather than left to the store.
    ///
    /// **A pair with several legal edges is a QUESTION, not a guess.** With no
    /// kind named and more than one candidate this writes nothing and hands the
    /// candidate names back under `ERR_LINK_CHOICE`, which the page turns into
    /// a choice. Picking the first would be indistinguishable from working,
    /// right up until an estate of record said two devices were vPC peers
    /// because somebody drew a patch lead.
    /// `fathom_weld::hand_link_candidates` carries the derivation and the
    /// rejected alternatives.
    ///
    /// **Cutting is a tombstone, never a delete** (`11` §10.5). The record
    /// keeps *"these two were connected and then they were not"*, which is a
    /// different and more honest claim than *"they never were"*. It cuts a
    /// parsed edge as readily as a hand-drawn one, because a person saying *"a
    /// config once said this and it is no longer true"* is making a legitimate
    /// assertion and the alternative is a mistake nobody can take back.
    ///
    /// **The refusals the page can word itself, it words itself.** `ERR_NO_LINK`
    /// travels with an empty detail where a sentence naming both kinds would
    /// have gone, because the page picked both boxes and knows both kinds, and
    /// building that sentence here measured **345 module bytes** — 7 % of this
    /// feature's whole budget for prose the page can write for free (`44` §5.2
    /// measures the module; the artifact has 2.2 MB of its 4.5 MB left). Where
    /// the module knows something the page does not — the schema's cardinality
    /// bounds — it still writes the words itself: see `link_refusal`.
    ///
    /// Every id comes off the `Mint`, not from the clock plus a discriminator:
    /// drawing three links in one millisecond is ordinary and the
    /// clock-plus-discriminator pattern would mint the same `BatchId` twice.
    /// `field_set` and `place` record the same lesson.
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
        // A box may not be linked to itself. The store would take it — no
        // cardinality forbids a self-edge — and the diagram would draw nothing,
        // because `route` treats both ends landing in one box as an interior
        // edge and counts it instead of drawing it. A gesture whose whole
        // effect is an invisible fact is worse than a refusal.
        if from == to {
            return protocol::encode_error(ERR_NO_ELEMENT, ONE_BOX);
        }
        // **A CUT ASKS THE GRAPH WHAT IS THERE; A DRAW ASKS THE SCHEMA WHAT IS
        // LEGAL.** They are different questions and the first version asked the
        // second one for both, which produced two blockers from one root:
        //
        //   * a CUT on a pair with several LEGAL kinds returned the chooser, and
        //     answering it DREW an edge — the gesture whose whole purpose is to
        //     remove a fact silently asserted one, journalled and permanent;
        //   * and so a link of an ambiguous kind could never be cut at all: it
        //     re-asked forever and every answer drew.
        //
        // Eleven pairs are ambiguous under the shipped candidate set, including
        // `IpsecVpn` to `LogicalUnit`.
        //
        // Narrowed IN PLACE, with a plain loop and one `Vec`. A first attempt
        // used a separate scan plus `.filter().collect()` and cost 1,562 bytes
        // against a ceiling with 5,117 free — this file's own comment thirty
        // lines below says why, and it was written after the same lesson: each
        // distinct closure monomorphises its whole adapter chain.
        //
        // The kind is IN the id: `NodeId` embeds a `Copy` `NodeKind` (62 §13.1),
        // so neither end needs a second lookup.
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
                // Nothing joins these two — but WHICH nothing depends on the
                // verb, because the list this arm sees is a different list for
                // each. For a draw it is what the SCHEMA admits, so empty means
                // *"nothing in the schema connects a Device to a Device"*, and
                // the page composes that sentence from the two kinds it already
                // knows (see this function's fourth property for why it is not
                // built here). For a cut it is what is LIVE, so empty means the
                // schema is perfectly happy and there is simply no such fact —
                // and telling an operator the schema forbids what they are
                // looking at is a false statement about their own estate.
                //
                // Narrowing the cut's list is what made this arm ambiguous:
                // before it, an empty list could only ever mean the schema, and
                // `2026-08-16-hand-link-drive.mjs` caught the second cut of the
                // same pair answering "nothing in the schema connects a Device
                // to a Device" over two devices the schema connects four ways.
                [] => {
                    return protocol::encode_error(
                        ERR_NO_LINK,
                        if mode == 0 { NOTHING_TO_CUT } else { "" },
                    )
                }
                [only] => *only,
                // Several. Write NOTHING and hand the names back, space
                // separated, under a code of their own so the page can tell a
                // question from a failure.
                //
                // AN ERROR RECORD, not a face reply, and the measurement is the
                // reason: a reply built on `encode_paste_reply` cost over a
                // kilobyte of module to carry a list of names `encode_error`
                // already carries. It is not a lie either — the opcode refused
                // to write, and the detail says what it needs before it will.
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
                // One arm for "no such edge kind" and "not between these two"
                // alike. They are different mistakes but only a page defect
                // produces either — the page posts a name this module handed it
                // — so the operator gets one true sentence rather than two.
                _ => return protocol::encode_error(ERR_NO_LINK, ""),
            }
        };

        let mut mint = match fathom_weld::Mint::new(at, entropy) {
            Ok(m) => m,
            Err(e) => return protocol::encode_error(ERR_EQUIP_FRAME, &format!("{e:?}")),
        };
        // The author is a CONSTANT, so only the batch mint can fail here. It
        // used to be `Ulid::from_parts(at.0, 1)` — the host clock — which made
        // every millisecond a different "user". See `UserId::LOCAL`.
        let Ok(batch) = mint.next() else {
            return protocol::encode_error(ERR_EQUIP_FRAME, "the clock is past the ULID ceiling");
        };
        let actor = Actor::User(UserId::LOCAL);

        let Some(graph) = self.estate.as_mut() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        // Is there already a live link of this kind between these two? Asked
        // BEFORE the batch opens, because `out` borrows the graph immutably and
        // every write below wants it mutably.
        //
        // BOTH DIRECTIONS FOR A SYMMETRIC KIND, and only then. `11` §7.4 has
        // the store normalise a symmetric edge so the smaller `NodeId` becomes
        // `from`, so a `Link` the operator drew from B to A is stored A to B
        // and an `out(from)` scan alone would miss it — then draw a second one,
        // which the store refuses as `SymmetricDuplicate`, turning a no-op into
        // an error message. For an asymmetric kind A→B and B→A are genuinely
        // two different claims and must not be conflated.
        //
        // ONE id, not a list, and `cut` re-asks after every tombstone.
        // Parallel edges of one kind between one pair arise only from a paste,
        // because the no-op rule below stops this opcode making a second, so
        // the list a `Vec` would carry has at most one entry almost always.
        // Plain loops rather than `filter().map().next()`: each distinct
        // closure monomorphises its whole adapter chain, and this file is
        // measured against `44` §5.2's ceiling.
        let held = live_link(graph, from, to, chosen);

        let wrote: Result<(), &'static str> = match (mode, held.is_none()) {
            // Nothing there to cut. Not an error the store would raise — there
            // is simply no such fact — so it is said here, in words.
            (0, true) => return protocol::encode_error(ERR_NO_LINK, NOTHING_TO_CUT),
            // Drawing the same link twice is not a second fact. Succeeding
            // without writing is right for the same reason `place`'s mode 0 on
            // an unpinned box is: "these two are connected" is a statement
            // about the end state, and an operator who presses it twice has not
            // made an error.
            //
            // **BUT IT SAYS SO, WITH A WORD OF ITS OWN.** This arm used to fall
            // through to the shared `Ok(())` reply, which sends `"1"` — and the
            // page reads `"1"` as *"drew a BindsInterface link … it is marked as
            // drawn by hand"*. On a link a PASTE built, every clause of that
            // sentence is false: nothing was drawn, and the existing edge is
            // machine-read, unmarked, and stays unmarked. In an estate of record
            // a sentence claiming a hand assertion that does not exist is the
            // same class of defect as writing one. Driven in
            // `2026-08-16-the-cut-that-drew.mjs`; the page also skips the
            // journal push on this word, because a journal entry for a draw that
            // did not happen replays as a hand link that was never drawn.
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
                // The batch closes either way — an open batch refuses every
                // later write with `BatchOpen`, which turns one refused link
                // into a dead page.
                if let (Ok(()), Err(_)) = (&w, graph.end_batch()) {
                    w = Err(BATCH_DID_NOT_CLOSE);
                }
                w
            }
        };
        match wrote {
            Err(e) => protocol::encode_error(ERR_EQUIP_STORE, e),
            // NO EDGE ID IN THE REPLY, and it is a byte decision with a
            // consequence worth naming. `ElementId::Edge(..).to_string()` is a
            // second instantiation of the id formatter — only the node one is
            // linked today — and nothing needs the answer: the journal records
            // the two ENDS and the kind, not the edge, because those are what
            // replay through this opcode. A future "select this link" gesture
            // will want the id and will have to pay for it then. Measured at
            // 127 bytes, against a budget of 5,117 for the whole feature.
            Ok(()) => equip_reply_text(chosen.name(), if mode == 0 { "0" } else { "1" }),
        }
    }

    /// A display id to the LIVE NODE it names, or `None`.
    ///
    /// Both ends of a link are nodes and both must still be true. `insert_edge`
    /// checks that a node exists, not that it is still asserted, so a link onto
    /// a removed box would be taken by the store and then drawn nowhere —
    /// `lay_out` excludes tombstoned nodes — which is the invisible-fact defect
    /// `link`'s self-link check also exists to stop.
    ///
    /// `Option`, not `Result<_, Vec<u8>>`, and the caller writes one refusal
    /// for all three ways this can fail. They are different mistakes, but only
    /// a page defect produces any of them — the page posts ids the module gave
    /// it — so the operator is better served by one true sentence than by three
    /// it cannot act on differently. It is also 200 module bytes of encoder that
    /// nothing reachable would ever run.
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

    /// A display id to the element it names, or the refusal to hand back.
    /// Separate from `node_request` because that one hands back the graph too,
    /// which holds an immutable borrow these two writers cannot take.
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
    /// The request is zero bytes, or one byte carrying `56` §4's 5-bit
    /// `LayerMask`, **or that byte followed by the aggregation view
    /// preference** in `fathom_layout::agg::View::parse`'s one-line-per-group
    /// form. Byte 0 is always the mask when there is one, so every caller
    /// written before aggregation existed still means what it meant.
    ///
    /// A read, like the other face opcodes: it computes positions and returns
    /// them, and holds nothing. Re-asking after any change is how the page
    /// refreshes, which is correct because the layout is a pure function of the
    /// graph and so cannot drift from it.
    ///
    /// **The shell stores no part of the view preference, deliberately.**
    /// Expansion is not an estate fact, so it travels with the request rather
    /// than accumulating here — which keeps this opcode a pure function of
    /// (estate, request) and therefore keeps invariant 9 checkable on it. See
    /// `fathom_layout::agg`'s header for the argument, and for why it does not
    /// answer the same question for pins.
    ///
    /// **Zero bytes is not the same request as `0b11111`.** With no mask the
    /// reply is the union scene with no layer projection applied at all — what
    /// every caller before layers existed meant, unchanged. With all five bits
    /// set it is the union scene projected through §4.1, which draws two kinds
    /// fewer: `AddressObject` and `Application` are `— (inspector only)` in that
    /// table. Collapsing the two would make an old caller silently lose
    /// elements to a feature it never asked for.
    ///
    /// The mask is applied AFTER layout, never as an input to it, so a toggle
    /// cannot move a box (`56` §3.6, and §11 row 6 for what happens if it can).
    /// `fathom_layout::lay_out` takes no mask, which is how that is enforced
    /// rather than merely intended.
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
        // No bytes past the mask is the **folded** picture. `59` §3.1 is a
        // DECISION and the collapse is the default drawing, so the default
        // request has to be the one that gets it; a caller wanting every node
        // drawn asks for it with `*`, which is `59` §3.7's retained control and
        // not a compatibility shim.
        let union = fathom_layout::lay_out_with(estate, &fathom_layout::agg::View::parse(text));
        match mask {
            None => protocol::encode_diagram(&union, None),
            Some(m) => {
                let (drawn, filter) = fathom_layout::layers::filter(&union, m);
                protocol::encode_diagram(&drawn, Some(&filter))
            }
        }
    }

    fn inv_rows(&mut self, req: &[u8]) -> Vec<u8> {
        // The kind byte indexes `InvKind::ALL` — it is not a hand-written table.
        // It was one until 2026-08-10, and when the strip grew from three kinds
        // to nine the table did not, so six row sets existed in the crate and
        // were unreachable through the only door the browser has. Indexing the
        // declaration order makes that class of drift unrepresentable, and
        // `ALL`'s order is therefore the wire order: **a kind is appended, never
        // inserted**, or every existing byte means something new.
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
            fathom_inventory::columns(kind),
            &fathom_inventory::rows(estate, kind),
        )
    }

    /// `OP_RACK_PLACE`: put one chassis in one rack at one unit (ADR-0035).
    ///
    /// Frame — the usual 24-byte clock+entropy prefix, then:
    ///
    /// ```text
    ///  24   2   len   (u16) chassis display id length
    ///  26  ..   utf8  the chassis display id
    ///  ..  ..   a field list, exactly OP_EQUIP_ADD's shape
    /// ```
    ///
    /// The field list carries `Rack.*` keys and `MountedIn.*` keys mixed
    /// together, routed by declarer the same way `OP_EQUIP_ADD` routes between
    /// `Device` and `Chassis`, and from the same generated tables. A field that
    /// moves between declarers in a later schema moves here with no edit.
    ///
    /// # Found or created, by label
    ///
    /// A `Rack.label` matching a rack that already exists REUSES it. That is
    /// the schema's own tier-1 identity tuple (`[owner(Premises), label]`)
    /// being used for what identity is for, not a convenience: an engineer
    /// filling a frame says "and node1 is at U7 in the same rack", and creating
    /// a second R12 there would make the elevation a lie.
    ///
    /// On reuse the supplied `height_u` and `unit_numbering` are IGNORED rather
    /// than applied. Silently restating a rack's geometry from a form that was
    /// really about one box is how the second placement quietly resizes the
    /// frame the first one is drawn in.
    ///
    /// # What it does not do
    ///
    /// No `Premises`. `HasRack` is `in: "1"`, but `11` §7.2's containment rule
    /// is an upper bound at write time — the same licence `OP_EQUIP_ADD` uses
    /// to create a `Device` with no `Site`. Inventing a building nobody
    /// mentioned would put a fact in the estate no human asserted.
    ///
    /// No move. Placing a chassis that is already placed is refused, because
    /// `MountedIn` is `out: "0..1"` and a move is a different gesture with a
    /// different undo label. It is named in the refusal rather than silently
    /// re-pointed.
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

        // Route by declarer, from the generated tables. Never hand-written.
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

        // Every `card: "1"` field is demanded at the door. `unit_numbering` is
        // the one that matters: ADR-0035 gives it no default because an
        // elevation drawn the wrong way up is wrong in every position while
        // looking entirely plausible. Defaulting it here would reintroduce
        // exactly the guess the schema refuses to make.
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

        // THE `range:` CONSTRAINT, ENFORCED HERE BECAUSE NOTHING ELSE ENFORCES
        // IT. `schema/schema.yaml` declares `range: { min: 1, max: 100 }` on
        // these three fields, and `fathom-schemagen` does not carry `range:`
        // into `ir_types.rs` at all — grep it, there is nothing. So the bound
        // was decoration: a review drove `height_u = 0` through the form and
        // got a rack that drew zero rows with its only box reported as outside
        // the frame, and `height_u = 200` and got two hundred DOM rows.
        //
        // Teaching the generator is the right long-term fix and is filed for
        // planning; it edits a shared generator with siblings in flight, and it
        // would regenerate every kind in the tree to serve three fields. Taken
        // instead: the door checks the value, with the numbers in one const and
        // `crates/fathom-wasm/tests/rack.rs` reading the DECLARED range out of
        // `schema/schema.yaml` and failing if the two ever disagree. ADR-0008
        // still holds — the schema is the source, and the drift is a red test
        // rather than a silent divergence.
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
            // Out-of-range and unparseable are told apart: `parse_into_slot`
            // below reports the second with the vendor-shaped message it
            // already has, so this only claims the range.
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

        // Parse everything BEFORE touching the store, so a FIELD refusal leaves
        // the estate exactly as it was (OP_EQUIP_ADD's rule, and for its
        // reason).
        //
        // THE LIMIT OF THAT PROPERTY, STATED RATHER THAN IMPLIED. It holds for
        // parse and door-check refusals, which all run above this line. It does
        // NOT hold for a store error inside `build()` below: `Graph` has no
        // rollback, `end_batch` commits what was written, and an `insert_edge`
        // that fails after `insert_node` succeeded leaves an empty `Rack`
        // behind while the caller is told the placement failed. The earlier
        // wording here said "a refusal leaves the estate exactly as it was"
        // without qualification, which was true of the common case and false of
        // that one. Building the rollback is a `fathom-graph` change with three
        // siblings in flight and is filed, not smuggled in here; an orphan rack
        // is visible in the inventory and removable, which is why the honest
        // comment is the acceptable interim and the silent one was not.
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
        // Reuse by label -- the tier-1 identity tuple, used for what identity
        // is for. Ordered by NodeId so the choice is deterministic if two racks
        // somehow share a label (invariant 9).
        let mut existing: Vec<fathom_graph::NodeId> = estate
            .nodes_of_kind(NodeKind::Rack)
            .filter(|n| {
                fathom_inventory::rack_label(estate, n.id).as_deref() == Some(label_text.as_str())
            })
            .map(|n| n.id)
            .collect();
        existing.sort();
        let found = existing.first().copied();

        // `ids` mints the BATCH only. The author was `ids(1)` until 2026-08-21
        // — derived from the host clock, so a fifty-op estate carried up to
        // fifty distinct "users", none of them anybody. See `UserId::LOCAL`.
        let ids = |n: u128| fathom_id::Ulid::from_parts(at.0, n);
        let Ok(batch) = ids(2) else {
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
        // The batch closes either way: leaving one open refuses every later
        // write with `BatchOpen`, turning one bad form into a dead page.
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
        // `None` is the empty state, not an error — a rack whose height was
        // never stated cannot be drawn, and the page says so.
        protocol::encode_rack_reply(fathom_inventory::elevation(estate, node).as_ref())
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

    /// The raw UTF-8 display id both element opcodes take, resolved against
    /// the held estate. An edge id is `ERR_NO_ELEMENT`: this face renders
    /// nodes.
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

// --- the paste reply ---------------------------------------------------------

/// The batch's undo label (`53` §7.2, at most 60 bytes).
const PASTE_LABEL: &str = "Paste junos-srx config";

/// The undo label one hand-added device carries (`53` §7.2). Names the gesture,
/// not the opcode: it is what the person will read in a list of things to undo.
const EQUIP_LABEL: &str = "Add equipment by hand";

/// The undo labels for the two edit gestures (`53` §7.2). Named for what the
/// person did, not for the opcode.
const EDIT_LABEL: &str = "Correct a field";
const REMOVE_LABEL: &str = "Remove equipment";
/// ADR-0036. Named for the gesture, not the opcode: the person put a box in a
/// rack, and that is what the undo stack should offer to take back.
const RACK_LABEL: &str = "Place equipment in a rack";

/// `schema/schema.yaml`'s `range: { min: 1, max: 100 }`, transcribed once for
/// `rack_place`'s door-check because codegen does not carry `range:` yet.
///
/// **These two integers are the only hand-copied schema numbers in this file**,
/// and `crates/fathom-wasm/tests/rack.rs::the_declared_range_is_the_range_the_door_enforces`
/// reads the declaration out of the YAML and fails if they drift. The bound is
/// a sanity check on a typo, not a claim about what racks exist — 42U is the
/// industry-standard cabinet and NetBox allows arbitrary heights, so the max is
/// deliberately far above anything real rather than tight.
const RACK_U_MIN: u8 = 1;
const RACK_U_MAX: u8 = 100;

/// The two placement gestures (`53` §7.2). Named for what the person did, which
/// is what an undo list has to read as — "Place a box" and not "OP_PLACE mode 1".
const PLACE_LABEL: &str = "Place a box on the diagram";
const FREE_LABEL: &str = "Let the layout place it again";

/// The undo labels for the two halves of `OP_LINK`. Named for the gesture, not
/// the opcode: the person drew a line, and that is what an undo stack offers to
/// take back.
const LINK_LABEL: &str = "Draw a link by hand";
const CUT_LABEL: &str = "Cut a link";

/// `OP_LINK`'s three fixed sentences.
///
/// Constants rather than `format!` sites. Nothing in them varies — a short
/// frame is a page defect, not something an operator can act on by knowing how
/// many bytes arrived — and each `format!` this file avoids is argument
/// machinery it does not link.
const SHORT_LINK_FRAME: &str = "that link request is malformed";
const NOT_TWO_BOXES: &str = "pick two boxes that are both still in the estate";
const ONE_BOX: &str = "that is one box, linked to itself — pick a second one";
const NOTHING_TO_CUT: &str = "there is no such link to cut";
const CLOCK_CEILING: &str = "the clock is past the ULID ceiling";
const STORE_REFUSED_CUT: &str = "the store would not record the cut";
const BATCH_DID_NOT_CLOSE: &str = "the change did not close cleanly — reload before changing more";

/// `OP_LINK`'s third answer, in the reply's `written` slot beside `"0"` (cut)
/// and `"1"` (drew): **the link was already there and nothing was written.**
///
/// A word rather than a fourth error code, because it is not a refusal — the
/// end state the operator asked for is the end state they have. It exists so the
/// page can say which of the two happened, and so the journal records only the
/// draws that were draws.
const ALREADY_THERE: &str = "2";

/// One live edge of `kind` between `from` and `to`, or `None`.
///
/// The one place `OP_LINK` decides whether a link is already there, so the
/// draw path's *"do nothing, this is already true"* and the cut path's *"here
/// is what to tombstone"* can never disagree about what counts.
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

/// Tombstone every live edge of `kind` between the two. Never a delete
/// (`11` §10.5): the record keeps *"these two were connected and then they were
/// not"*, which is a different and more honest claim than *"they never were"*.
///
/// Re-asks after every tombstone rather than holding a list, which is also the
/// termination argument: `live_link` only ever returns an edge with no
/// `absent_since`, and each pass sets one, so the loop shrinks a finite set.
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
    // `&'static str` all the way down, and it is the last of the 451 bytes this
    // round had to find. Every message on this path is a constant; the only
    // reason it was `String` is that `link_refusal` used to compose one, and a
    // `String` return drags the allocator and `format!` into a path that never
    // needed either.
    let ulid = mint.next().map_err(|_| CLOCK_CEILING)?;
    let record = hand_record(mint, at, actor).map_err(|_| CLOCK_CEILING)?;
    graph
        .insert_edge(kind, ulid, from, to, record)
        .map(|_| ())
        .map_err(|e| link_refusal(e, kind))
}

/// What the store refused, as TWO WORDS the page turns into a sentence.
///
/// **The wording lives in the page, and that is this file's own rule rather than
/// a new one.** `link`'s `ERR_NO_LINK` arm already says so in terms — *"The page
/// names both kinds in the sentence it shows; see this function's fourth
/// property for why that sentence is not built here."* This function was the one
/// place that broke the rule, and it cost **433 bytes** of a ceiling that had
/// 451 to find: `format!`, `concat` and the prose all instantiate in the module,
/// where the page holds strings for free.
///
/// So the module sends what only the module knows — which bound was exceeded and
/// which edge kind — and the page says it in English. Measured, not assumed.
fn link_refusal(
    e: fathom_graph::WriteError,
    kind: fathom_ir::generated::ir_types::EdgeKind,
) -> &'static str {
    use fathom_graph::WriteError;
    let end = match e {
        WriteError::OutBoundExceeded { .. } => "out",
        WriteError::InBoundExceeded { .. } => "in",
        // Reachable only through the store's normalisation, and only if the
        // both-directions scan in `link` ever stops covering it.
        WriteError::SymmetricDuplicate { .. } => "sym",
        _ => "store",
    };
    // The kind's NAME is not sent, and that is the last of the 451 bytes: this
    // returned a `String` and building one instantiates the allocator path for
    // a value the page can already supply. The page knows which kind it asked
    // for — it either chose it from the chooser or received it in the reply —
    // and where it does not, "a link of that kind" is still true and still
    // actionable. A `&'static str` costs nothing.
    let _ = kind;
    end
}

/// How many residue rows one reply carries. The summary always states the
/// **total**, so a page that renders both can say how many it is not showing —
/// `78` §5 forbids the silent cap, not the cap.
const RESIDUE_ROW_CAP: usize = 500;
/// The same, for references the capture named and did not contain.
const UNRESOLVED_ROW_CAP: usize = 200;

/// How many lines became facts. The exact criterion behind the refusal above:
/// `LineOutcome::Bound` is the parser's own word for "this line is now in the
/// graph", so counting it asks the parser rather than inferring from node
/// counts — which would be wrong, the binder having already seeded a `Device`.
fn bound_lines(ingest: &fathom_ingest::IngestOutput) -> usize {
    ingest
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, fathom_ingest::frame::LineOutcome::Bound { .. }))
        .count()
}

/// The message for a paste that bound nothing. Names the most likely cause it
/// can actually evidence, and never claims more than it checked.
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

    // Curly-brace Junos: what `show configuration` prints without
    // `| display set`. Evidenced rather than assumed — braces AND
    // semicolon-terminated statements, which together no `set`-form capture has.
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
        // The wording matters more than usual here. An empty export and a
        // firewall with no rules are the same file, so an operator who is not
        // told which one they have will believe the wrong thing — and OPNsense
        // issue #10595 (22 July 2026, open and unanswered on 2026-08-15) is a
        // report of the export writing 0 bytes while the assistant said it had
        // found 47 rules. Naming the version is what makes the message
        // actionable rather than merely apologetic.
        // THE MOST LIKELY REAL INPUT ON THIS PATH, AND IT MUST NOT READ AS
        // "your firewall is empty". A header with no records is what OPNsense
        // issue #10595 produces: the Migration assistant reports finding 47
        // legacy rules and writes a 0-byte `download_rules.csv`. Opened 22 July
        // 2026 against 26.7.1; still open, unanswered, no fix found —
        // re-established independently on 2026-08-16 rather than carried
        // forward on trust (ADR-0034).
        //
        // The operator who hits it is one step from documenting their firewall
        // as having no rules at all. So the message says what the file is, says
        // whose bug it is, and says where the rules still are. It does not
        // suggest a workaround, because none was established.
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

/// Why one line was not bound, in the words the person who pasted it would
/// use. Every arm names something they could act on — *"Fathom does not know
/// this statement yet"* is a different problem from *"the paste is clipped"*,
/// and lumping them under "unparsed" hides which one it is.
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
            // Said in full, because this is the one residue reason whose remedy
            // is a specific edit to the file rather than "Fathom does not know
            // this yet". The operator can look at the row, find the stray
            // delimiter in a description, quote it, and paste again.
            ShapeError::RowWidth { cells, columns } => format!(
                "this row has {cells} fields where the header names {columns} columns, so \
                 which value belongs to which column is not known — most often an \
                 unquoted `;` inside a description. The whole row is shown rather than \
                 guessed at: a rule read one column out would say `any` where your file \
                 says a network."
            ),
        },
        // THE BYTE COUNT IS GONE, 2026-08-21, and for the same reason the
        // shape sketch lost its per-token length: a quarantined line is one
        // the gate believes carries a secret, so its exact length is a bound
        // on that secret. `14` §9.5 already says `orig_len` is "for the
        // in-session report only; the persistence layer must not store it" —
        // and this string is journalled with the residue and travels wherever
        // the export goes. The label says WHAT was held back, which is the
        // part a person acts on; the length only ever helped a guesser.
        LineOutcome::Quarantined { label, .. } => {
            format!("held back at the redaction gate: {}", label.token())
        }
        // Reachable only through `csv.rs`, and never as residue — a header is
        // understood, not left over. Named anyway, because the alternative is
        // the `{other:?}` arm below printing a Rust debug string at a person.
        LineOutcome::Header { columns } => {
            format!("the header row — it named {columns} columns")
        }
        // `ingest` builds `residue` from exactly the three arms above, so this
        // is unreachable through `ingest`. Naming the outcome rather than
        // asserting keeps a future fourth arm visible instead of silent.
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

/// The reply one successful paste produces: what was understood, what was not,
/// and what was named and not found.
fn paste_reply(
    graph: &fathom_graph::Graph,
    ingest: &fathom_ingest::IngestOutput,
    weld: &fathom_weld::WeldOutput,
    dict: &fathom_ingest::dict::Dictionary,
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

    // Edges: the fragment's own, plus the containment edges the weld
    // materialised. Both are edges in the store and counting only the first
    // would under-report what was built by roughly the node count.
    let edges = (weld.edges.len() + weld.containment.len()).to_string();
    let nodes = weld.nodes.len().to_string();
    let residue_total = ingest.residue.len().to_string();
    let secrets = ingest.drops.entries.len().to_string();
    let unresolved_total = weld.unresolved.len().to_string();

    protocol::encode_paste_reply(&protocol::PasteReply {
        summary: [
            &nodes,
            &edges,
            &residue_total,
            &secrets,
            &unresolved_total,
            device_id,
            hostname,
            dict.platform(),
        ],
        residue: &residue,
        unresolved: &unresolved,
        capture: text,
    })
}

/// One hand-authoring assertion's provenance: `Origin::Hand`, the host's clock,
/// and `Confidence::Asserted`.
///
/// `Asserted` is right and is worth being explicit about. The three values mean
/// *how directly the thing was observed* (`11` §8.3), not *how much we trust
/// the source*. A person typing what is in front of them has observed it as
/// directly as anything can be observed — more directly than a parser inferring
/// a tunnel from six statements, which is also `Asserted`. Grading hand entry
/// lower would be confusing confidence with authority.
///
/// A fresh id per record, never shared: `Graph::check_prov` fills `supersedes`
/// from the slot's current provenance, so a reused id lands as
/// `ProvenanceIdReused` the moment two assertions touch one slot.
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
/// malformed frame points at which one rather than at the frame as a whole.
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

/// A refused hand-entered value, in the words of the person who typed it.
/// Quotes what they wrote back, because a form that says only "invalid" makes
/// them guess which of four boxes it meant.
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

/// What one hand-added piece of equipment produced: the display id to select,
/// and how many fields were stored.
fn equip_reply(device: fathom_graph::NodeId, written: usize) -> Vec<u8> {
    equip_reply_text(&device.to_string(), &written.to_string())
}

/// The same reply from strings, so the edit and remove opcodes answer in the
/// shape the page already knows how to read.
fn equip_reply_text(id: &str, written: &str) -> Vec<u8> {
    protocol::encode_paste_reply(&protocol::PasteReply {
        summary: [id, written, "", "", "", id, "", ""],
        residue: &[],
        unresolved: &[],
        capture: "",
    })
}

/// Fixed-width little-endian reads that never index out of bounds. The three
/// widths the frames above use.
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
/// `pub(crate)` so `dictframe` can decode `OP_DICT`'s frame with the same
/// reader `OP_INIT`'s uses. Two frames of identical shape read by two cursors
/// is how one of them ends up with an off-by-one nobody notices.
pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Cursor<'a> {
        Cursor { bytes, at: 0 }
    }

    /// How far the cursor has read — the trailing-bytes check both frames make.
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

/// §4.4's OP_INIT frame. Names are labels, never opened: each is prefixed
/// with its section directory so a load error reads the way `load_corpus`'s
/// does.
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

/// A read path into the held estate, **for tests only**.
///
/// The opcodes are the only door a browser has and they answer with rendered
/// faces rather than with the graph — which is right, and which left no way to
/// assert on provenance. That gap is why the clock-derived author survived: a
/// test could see what a face SAID and never who a fact was ATTRIBUTED TO.
///
/// Gated behind `inspect`, which nothing but this crate's own dev-dependency
/// enables. `artifact_gates.rs` proves it is absent from the shipping module
/// rather than trusting the feature resolver.
#[cfg(feature = "inspect")]
impl Shell {
    pub fn estate_for_test(&self) -> Option<&fathom_graph::Graph> {
        self.estate.as_ref()
    }
}

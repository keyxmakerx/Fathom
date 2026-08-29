//! Stage 4 — **the gate** (`14` §9).
//!
//! *"NOTHING PASSES UNGATED."* Position is not negotiable: the gate runs after
//! shape and before bind, so no stage that produces anything durable has ever
//! held pre-redaction text. ADR-0002's amended invariant 3 is the contract —
//! *"A pasted capture may contain a credential; it is redacted at the ingest
//! gate and the unredacted text never reaches the encryptor."*
//!
//! Three structural properties ship here (`14` §9.1's table, slice half):
//! the graph side cannot hold a secret because `SecretPlaceholder` has no
//! text constructor; the capture text is private to [`RedactedCapture`],
//! which only this module constructs; and every stage after the gate reads
//! either that capture or the tree's post-gate segments, where a redacted
//! position holds marker text and carries the `redacted` flag.

use std::collections::BTreeSet;

use crate::dict::{self, Dictionary, Match, PathSeg, ValueSpec};
use crate::frame::{ByteSpan, LineOrdinal, LineOutcome, LogicalLine, Outcome};
use crate::lex::{self, TokenKind};
use crate::shape::{self, Stmt, StmtIdx, StmtTree, UnshapedLine};

/// Only the gate constructs one; the text field is private (14 §9.1's
/// "CaptureStore::insert takes a RedactedCapture" property, at this slice's
/// boundary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactedCapture {
    text: String,
}

impl RedactedCapture {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn seal(text: String) -> RedactedCapture {
        RedactedCapture { text }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DropManifest {
    pub entries: Vec<RedactionEntry>,
    /// 14 §9.6: user pre-redactions — bound, not counted as drops.
    pub already_redacted: Vec<LineOrdinal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactionEntry {
    pub ordinal: LineOrdinal,
    pub span: ByteSpan, // of the marker, post-redaction
    pub label: RedactLabel,
    pub detectors: DetectorSet,
    /// 14 §9.5: for the in-session report only; the persistence layer must
    /// not store it. Enforced by doc comment now, by the store weld later.
    pub orig_len: u32,
}

/// Ingest-side labels. The first five mirror fathom_ir's SecretLabel
/// one-to-one; Unknown covers 14 §9.4's safety-net detections, which have no
/// graph-side label. Extending SecretLabel itself is WO-01 §7 trigger 5 —
/// owner/planning work, not this crate's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedactLabel {
    Psk,
    CertKey,
    SnmpCommunity,
    TacacsKey,
    Password,
    Unknown,
}

impl RedactLabel {
    pub fn to_secret_label(self) -> Option<fathom_ir::scalar::SecretLabel> {
        use fathom_ir::scalar::SecretLabel;
        Some(match self {
            RedactLabel::Psk => SecretLabel::Psk,
            RedactLabel::CertKey => SecretLabel::CertKey,
            RedactLabel::SnmpCommunity => SecretLabel::SnmpCommunity,
            RedactLabel::TacacsKey => SecretLabel::TacacsKey,
            RedactLabel::Password => SecretLabel::Password,
            RedactLabel::Unknown => return None,
        })
    }

    /// The marker token: psk, cert-key, snmp-community, tacacs-key,
    /// password, unknown.
    pub fn token(self) -> &'static str {
        match self {
            RedactLabel::Psk => "psk",
            RedactLabel::CertKey => "cert-key",
            RedactLabel::SnmpCommunity => "snmp-community",
            RedactLabel::TacacsKey => "tacacs-key",
            RedactLabel::Password => "password",
            RedactLabel::Unknown => "unknown",
        }
    }
}

/// Bit set over the detectors that fired (a value may be caught by several;
/// 14 §9.2: "redacted once and the manifest records both reasons").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectorSet(pub u8);

impl DetectorSet {
    pub const PATH: u8 = 1;
    pub const CRYPT_PREFIX: u8 = 2;
    pub const PEM_ARMOUR: u8 = 4;
    pub const LONG_HEX: u8 = 8;
    pub const BASE64: u8 = 16;
    pub const LEAF_NAME: u8 = 32;
}

/// 14 §9.4's secret-word list, case-folded, hyphens = underscores.
///
/// **`simple-password` is an addition to §9.4's list, made 2026-08-15, and it is
/// a defect fix rather than a convenience.** The list was transcribed verbatim
/// until the OSPF entries landed and made the gap reachable.
///
/// Junos spells OSPF's plain-text authentication
///
/// ```text
/// set protocols ospf area A interface I authentication simple-password <key>
/// ```
///
/// and `simple-password` was not `password`: `is_secret_word` was whole-string
/// equality after folding, so the two never matched. (It matches by COMPONENT
/// as well now — `dict::is_secret_word` carries that fix and the six live
/// credentials that forced it. The paragraph below is kept in the past tense it
/// belongs to: it is the reasoning for this member's existence, not a
/// description of today's test.) With no entry declaring a
/// `secret:` at that path, the ONLY thing standing between that key and the
/// store was `base64ish`, the length-and-alphabet safety net.
///
/// **`base64ish` requires 24 characters. Juniper documents this key as 1 to 8.**
/// Two independent pages, both read 2026-08-15:
///
/// - <https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/topic-map/configuring-ospf-authentication.html>
///   — *"The simple key can be from 1 through 8 characters and can include ASCII
///   strings."* and *"Simple authentication uses a plain-text password that is
///   included in the transmitted packet."*
/// - <https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/ref/statement/authentication-edit-protocols-ospf.html>
///   — names `simple-password`, `md5`, `multi-active-md5` and `keychain` as the
///   four forms, and states the MD5 bound separately (*"The MD5 key values can
///   be from 1 through 16 characters long"*), which the `md5` and `key` members
///   below already cover.
///
/// So the safety net could not catch a legal value of this statement — not
/// "rarely", but never, the maximum being a third of the minimum. The canary
/// that was supposed to guard this path used a 28-character value, which no
/// Junos device would have accepted, so it passed while the path was open for
/// every value that could really appear.
///
/// Found by pasting a plausible key into the shipped artifact in Chromium and
/// reading it back out of the EXPORTED JOURNAL — the file an operator keeps.
///
/// A length heuristic is the wrong instrument for a short secret. The right one
/// is the name, which is what this list is for.
///
/// # `bindpw` and `otp_seed` — added 2026-08-16 with the OPNsense table path
///
/// Component matching splits on `-`, `_` and `.` and tests each part, which is
/// what catches `user_password`, `ipsec_psk` and `radius_secret` — the shapes a
/// mis-pasted OPNsense export carries. It cannot catch a name whose credential
/// word is CONCATENATED rather than separated, and OPNsense has exactly two
/// that matter. Both key strings were read out of the vendor's own source on
/// 2026-08-16, not recalled:
///
/// - `ldap_bindpw` — `src/opnsense/mvc/app/library/OPNsense/Auth/LDAP.php` on
///   `opnsense/core` master maps `'ldap_bindpw' => 'ldapBindPassword'` in its
///   `$confMap`. Splitting gives `ldap` and `bindpw`, neither of which was a
///   member, so the LDAP bind password had no name coupling at all. (Its
///   sibling `'radius_secret' => 'sharedSecret'`, from `Auth/Radius.php`, was
///   already caught by the `secret` component.)
/// - `otp_seed` — a plaintext TOTP seed, listed by `64` §7 as the leading
///   example of its own class: *"secrets under names with no credential word"*.
///   `docs.opnsense.org/manual/users.html` names the field *"OTP seed"* (read
///   2026-08-16). Whoever holds it mints valid second factors forever.
///
/// **This closes named instances and NOT the class**, and the distinction is the
/// whole lesson of the `simple-password` entry above. `64` §7 records the rest
/// as open.
///
/// # `mmonitUrl` — OPEN, AND NOTHING HERE CATCHES IT
///
/// **CORRECTED 2026-08-16.** The paragraph that stood here said `pieces()`,
/// splitting on `:` in the unshaped sweep, catches OPNsense's `mmonitUrl` —
/// documented by the vendor as `https://user:pass@192.168.1.10:8443/collector`
/// (docs.opnsense.org/manual/monit.html, read 2026-08-16). **It does not, and it
/// categorically cannot.** Driven three ways, every one `drops: 0` with the
/// value verbatim: through the shipped artifact and read back out of the
/// exported journal, through a width-refused row that really does enter
/// `gate_unshaped`, and through the Junos `key=value` sweep.
///
/// The reason is structural rather than a tuning failure. `pieces()` splits on
/// `=`, `:` and `,` and then runs only `crypt_prefix`, `long_hex` and
/// `base64ish`; `base64ish` requires every character to be alphanumeric, `+` or
/// `/`, so any piece of a URL is rejected by its `@` and its `.` however long the
/// password is. And `key_names_a_secret` sees the left-hand side of the first
/// `:`, which is `https`.
///
/// So this is an OPEN GAP and is recorded as one. A false claim of protection is
/// worse than a stated hole: the hole gets closed, and the claim gets trusted.
/// Closing it needs a value-shaped rule — a URL with a userinfo component is a
/// credential wherever it appears — which is a different instrument from this
/// list and is not built.
pub const SECRET_WORD_LIST: [&str; 30] = [
    "key",
    "keys",
    "key-string",
    "secret",
    "shared-secret",
    "password",
    "passwd",
    "simple-password",
    // Run together with no separator and no case boundary, so neither the
    // component split nor the case split can reach them. Both are real OPNsense
    // credential names carried in `64` §7 and both were driven through the
    // shipped artifact on 2026-08-16 at values a real box holds: `privkey` holds
    // a plaintext SSH private key under `//system/backup/*` and a WireGuard
    // server key (opnsense/core master `Wireguard/Server.xml` declares it), and
    // `basicauthpass` is caddy's, under the top-level `<Pischem>` element.
    "privkey",
    "basicauthpass",
    "plain-text-password",
    "encrypted-password",
    "psk",
    "pre-shared-key",
    "passphrase",
    "community",
    "snmp-community-string",
    // `trap-group` — added 2026-08-17. NOT a new class of secret: the dictionary
    // has declared `snmp.trap-group` with `secret: { label: snmp-community }`
    // since it was written, so the value has always been destroyed on a config
    // this engine understands.
    //
    // IT IS HERE BECAUSE IT WAS THE ONLY ONE OF THE FOURTEEN DECLARED SECRETS
    // WITH EXACTLY ONE DETECTOR. Every other declared secret is caught twice —
    // once by the dictionary path and once by this leaf-name list — so the
    // dictionary going missing, going stale or being replaced degrades those
    // thirteen to a second net and this one to nothing. Found 2026-08-17 by an
    // adversarial review of the "hand in your own engine" proposal, and proved
    // with a canary rather than argued: a `set snmp trap-group <name>` line
    // dropped its value with the shipped dictionary and kept it without one.
    //
    // The proposal is not built and may never be. The gap it exposed is real
    // today for a different reason — `43` §5's offline artifact can be launched
    // with a dictionary that failed to splice — and closing it costs a word.
    // The rule it argues for is bigger than the word and belongs to `03`:
    // NOTHING ARRIVING AFTER THE BUILD MAY REDUCE WHAT THIS GATE DESTROYS,
    // ONLY INCREASE IT.
    "trap-group",
    "authentication-key",
    "auth-key",
    "md5",
    "hmac",
    "credential",
    "token",
    "bearer",
    "phash",
    "passhash",
    "private-key",
    "bindpw",
    "otp_seed",
];

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// The marker written into the capture — unquoted, so the stored capture
/// cannot be pasted back into a box as working config (`14` §14.3).
fn marker(label: RedactLabel) -> String {
    format!("<REDACTED:{}>", label.token())
}

#[derive(Debug, Clone)]
struct Edit {
    start: u32,
    end: u32,
    text: String,
    ordinal: LineOrdinal,
    label: RedactLabel,
    detectors: u8,
    /// Set on a value redaction; the gate re-points this node's segment at a
    /// freshly interned marker (§4.6 rule 1).
    node: Option<StmtIdx>,
    /// Set on a quarantine: the whole line's outcome changes.
    quarantine: bool,
}

pub(crate) struct Gated {
    pub(crate) drops: DropManifest,
    /// Post-redaction span of every logical line, in ordinal order.
    pub(crate) spans: Vec<ByteSpan>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn gate(
    capture: &mut String,
    lines: &[LogicalLine],
    tree: &mut StmtTree,
    outcomes: &mut [Outcome],
    stmts: &[Stmt],
    unshaped: &[UnshapedLine],
    noise: &[UnshapedLine],
    matches: &[Match],
    dict: &Dictionary,
) -> Gated {
    let mut edits: Vec<Edit> = Vec::new();
    let mut already: BTreeSet<u32> = BTreeSet::new();

    for (idx, stmt) in stmts.iter().enumerate() {
        let m = match matches.get(idx) {
            Some(m) => *m,
            None => continue,
        };
        gate_statement(capture, tree, dict, stmt, m, &mut edits, &mut already);
    }
    for line in unshaped {
        gate_unshaped(capture, dict, line, &mut edits);
    }
    // Noise lines, at the same aggression. `14` §9.7's sweep applies to any
    // line that produced no statement, and a prompt-prefixed line is exactly
    // that — see `shape.rs`'s `LineClass::Noise` arm for what this closes.
    for line in noise {
        gate_unshaped(capture, dict, line, &mut edits);
    }

    // Deterministic, non-overlapping edit order. A bracket list expands into
    // several statements sharing their head tokens, so the same position can
    // be proposed twice; the first proposal stands.
    edits.sort_by_key(|e| (e.start, e.end));
    edits.dedup_by_key(|e| e.start);
    let mut kept: Vec<Edit> = Vec::new();
    for edit in edits {
        if kept.last().map(|k| k.end > edit.start).unwrap_or(false) {
            continue;
        }
        kept.push(edit);
    }

    // Rewrite the buffer, recording each marker's post-redaction span.
    let mut rebuilt = String::with_capacity(capture.len());
    let mut cursor = 0u32;
    let mut entries: Vec<RedactionEntry> = Vec::new();
    for edit in &kept {
        rebuilt.push_str(crate::frame::slice(
            capture,
            ByteSpan {
                start: cursor,
                end: edit.start,
            },
        ));
        let new_start = rebuilt.len() as u32;
        rebuilt.push_str(&edit.text);
        entries.push(RedactionEntry {
            ordinal: edit.ordinal,
            span: ByteSpan {
                start: new_start,
                end: rebuilt.len() as u32,
            },
            label: edit.label,
            detectors: DetectorSet(edit.detectors),
            orig_len: edit.end.saturating_sub(edit.start),
        });
        cursor = edit.end;
    }
    rebuilt.push_str(crate::frame::slice(
        capture,
        ByteSpan {
            start: cursor,
            end: capture.len() as u32,
        },
    ));
    *capture = rebuilt;

    // Every span recorded from here on is in post-redaction coordinates
    // (`14` §9.5).
    let spans: Vec<ByteSpan> = lines
        .iter()
        .map(|line| ByteSpan {
            start: remap(line.pieces.first().map(|p| p.start).unwrap_or(0), &kept),
            end: remap(line.pieces.last().map(|p| p.end).unwrap_or(0), &kept),
        })
        .collect();

    // The tree rewrite: a redacted position's segment is re-pointed at a
    // fresh marker segment and flagged. Never rewritten in place — interning
    // is shared, and a secret whose text collides with a literal segment used
    // elsewhere would otherwise corrupt unrelated statements (§4.6 rule 1).
    for edit in &kept {
        if let Some(StmtIdx(node)) = edit.node {
            let seg = shape::SegId(tree.segs.len() as u32);
            tree.segs.push(edit.text.clone());
            if let Some(n) = tree.arena.get_mut(node as usize) {
                n.seg = seg;
                n.redacted = Some(edit.label);
            }
        }
        if edit.quarantine {
            if let Some(o) = outcomes.get_mut(edit.ordinal.0 as usize) {
                o.outcome = LineOutcome::Quarantined {
                    label: edit.label,
                    orig_len: edit.end.saturating_sub(edit.start),
                };
            }
        }
    }

    Gated {
        drops: DropManifest {
            entries,
            already_redacted: already.into_iter().map(LineOrdinal).collect(),
        },
        spans,
    }
}

/// Old offset -> new offset. `kept` is sorted and non-overlapping, so the
/// shift at `pos` is the sum of the length changes strictly before it.
fn remap(pos: u32, kept: &[Edit]) -> u32 {
    let mut delta: i64 = 0;
    for edit in kept {
        if edit.end > pos {
            break;
        }
        delta += edit.text.len() as i64 - i64::from(edit.end - edit.start);
    }
    (i64::from(pos) + delta).max(0) as u32
}

fn gate_statement(
    capture: &str,
    tree: &StmtTree,
    dict: &Dictionary,
    stmt: &Stmt,
    m: Match,
    edits: &mut Vec<Edit>,
    already: &mut BTreeSet<u32>,
) {
    let segs: Vec<String> = stmt
        .path
        .iter()
        .map(|idx| shape::seg_text(tree, *idx).to_owned())
        .collect();

    // PEM armour quarantines the whole line: set-form Junos has no
    // framer-level block forms in scope, and quarantine errs toward
    // destruction, which is `14` §9.7's own stated direction of error.
    if segs.iter().any(|s| s.starts_with("-----BEGIN")) {
        edits.push(Edit {
            start: stmt.span.start,
            end: stmt.span.end,
            text: sketch(capture, dict, &stmt.tokens, &[]),
            ordinal: stmt.line,
            label: RedactLabel::CertKey,
            detectors: DetectorSet::PEM_ARMOUR,
            node: None,
            quarantine: true,
        });
        return;
    }

    let entry = m.entry.and_then(|e| dict.entry(e));
    // "Argument tokens": on a dictionary-matched statement the tokens its
    // captures consume plus the unconsumed trailing tokens; on an Unmapped
    // statement every token after the longest known prefix.
    let mut args: Vec<usize> = Vec::new();
    match entry {
        Some(e) => {
            for (idx, seg) in e.path.iter().enumerate() {
                if matches!(seg, PathSeg::Capture(_)) {
                    args.push(idx);
                }
            }
            for idx in m.consumed..segs.len() {
                args.push(idx);
            }
        }
        None => args.extend(m.known_prefix..segs.len()),
    }
    let secret_pos = entry.and_then(|e| e.secret.and_then(|_| e.secret_pos()));

    for at in args {
        let text = match segs.get(at) {
            Some(t) => t.as_str(),
            None => continue,
        };
        let mut detectors = 0u8;
        let mut label = RedactLabel::Unknown;
        if Some(at) == secret_pos {
            detectors |= DetectorSet::PATH;
            if let Some(l) = entry.and_then(|e| e.secret) {
                label = l;
            }
        }
        if crypt_prefix(text) {
            detectors |= DetectorSet::CRYPT_PREFIX;
        }
        if long_hex(text) {
            detectors |= DetectorSet::LONG_HEX;
        }
        // The base64 guard: `14` §9.4's three-condition rule keeps
        // fingerprints and descriptions alive. A statement the dictionary
        // matched is never "no better information" -- but that is only true of
        // the tokens the entry actually DESCRIBES.
        //
        // DEFECT, found 2026-08-15 during this reconciliation. This guard read
        // `entry.is_none()`, so teaching the dictionary any prefix of a
        // statement switched the base64 detector off for the WHOLE line,
        // including trailing tokens the entry never described. Driven:
        //
        //   set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 \
        //       authentication simple-password <28 chars>
        //
        // -- a form Juniper documents at exactly that hierarchy level -- was
        // DESTROYED at baseline `adbb590`, where nothing under `protocols`
        // matched and `entry` was `None`, and would have been STORED VERBATIM
        // once the OSPF entries landed. `simple-password` is not a member of
        // `SECRET_WORD_LIST` (that list holds `password`, and `is_secret_word`
        // is whole-string equality after folding), so no other detector fires
        // and the leaf-name walk below cannot save it.
        //
        // The rule is the same one the `leaf_hit` match below states: a token
        // past the end of the entry's path is a token the entry never
        // described, so the entry is the wrong authority on it. Two detectors
        // had this bug; fixing one and leaving the other is what made a latent
        // hole into a live invariant-3 regression.
        let described_by_entry = entry.is_some_and(|e| at < e.path.len());
        if !described_by_entry && base64ish(text) {
            detectors |= DetectorSet::BASE64;
        }
        let leaf_hit = match entry {
            // A token PAST the end of what the entry consumed is a token the
            // entry says nothing about, so the entry's own path cannot be the
            // only authority on whether it follows a secret word. The raw line
            // is also consulted there.
            //
            // This is a defect fix, not a widening convenience, and it was
            // found twice independently. (a) The hole was already reachable
            // through the shipped `security-zone … interfaces <unit>` partial
            // entry: `set security zones security-zone Z interfaces ge-0/0/0.0
            // <anything> secret VALUE` matched that entry, so the walk ran over
            // a six-segment path that ends at `interfaces` and never saw the
            // word `secret` on the actual line. (b) The BGP entries make it
            // reachable a second way: `set protocols bgp group G neighbor
            // 203.0.113.1 authentication-key <key>` matches the six-segment
            // `… neighbor $n` entry, leaving `authentication-key` and the key
            // itself as trailing tokens. Judged by the entry's path the walk
            // looks back over `neighbor` and `group` and says clean; judged by
            // the statement it looks back over `authentication-key` and
            // destroys the key. Adding bare-stanza entries (2026-08-15)
            // multiplies the reachable paths, which is what made the hole worth
            // closing rather than merely worth noting.
            //
            // The two walks are UNIONED, never swapped, so this branch is
            // strictly stronger than either alone. They see different windows
            // and each has a blind spot the other covers: the entry walk skips
            // captures and so reaches two LITERALS back in the path, while the
            // raw walk sees the two physical segments before the token, one of
            // which is usually the preceding capture's value and therefore a
            // wasted slot. `14` §9.7 states the direction of error for this
            // gate as destruction, so: hit if either hits.
            //
            // `secret_exempt` suppresses only its own half. An exemption is a
            // claim about the shape the entry models -- the field card's
            // `perfect-forward-secrecy keys group14` -- granted by review for
            // one statement form, and it cannot speak for tokens outside that
            // form, so it may not veto the raw walk.
            //
            // THE ENTRY WALK IS BOUNDED TO ONE TOKEN PAST THE PATH, AND THAT
            // BOUND IS A DEFECT FIX (2026-08-29).
            //
            // `leaf_name_walk(path, at)` starts `path.iter().take(at)`, which
            // for every `at >= path.len()` is the WHOLE path — so it returns
            // the same answer for a token one past the entry as for a token
            // twenty past it. It has no notion of distance once it leaves the
            // modelled path, because the tokens out there are not IN the path
            // to be counted.
            //
            // That was harmless while no short entry path carried a secret
            // word. Adding `trap-group` to the word list on 2026-08-17 — to
            // give `snmp.trap-group` the second detector every other declared
            // secret already had — made it reachable, and it destroyed the
            // whole tail of the statement:
            //
            //   set snmp trap-group branch-traps targets 192.0.2.20 \
            //       categories link routing
            //
            // is one secret (`branch-traps`, which Juniper puts in the trap
            // PDU as the community) followed by five tokens of ordinary
            // configuration — and all six were destroyed, unbounded, because
            // `[snmp, trap-group, $g]` is three segments long and every token
            // past it looks equally adjacent to `trap-group`.
            //
            // **This reduces what the gate destroys, which is the dangerous
            // direction**, so it is bounded as narrowly as the defect allows:
            // the entry walk still runs for the token IMMEDIATELY past the
            // modelled path, which is the only position the path's own leaf
            // names can honestly speak about. Everything beyond that is judged
            // by `raw_walk`, which reads the statement's real preceding tokens
            // and has always had the two-token bound this one lacked. The
            // union is unchanged in strength for every case the paragraphs
            // above describe: the BGP key sits two past its entry and is
            // caught by the raw walk on `authentication-key`; the zones hole
            // is caught by the raw walk on `secret`; a bare
            // `set snmp trap-group NAME` is at `path.len() - 1` and never
            // reaches this arm at all.
            //
            // `14` §9.7 makes destruction the safe direction of error, and it
            // still is — but destroying an unbounded run of the network is not
            // erring toward safety, it is erring toward an estate that has
            // lost the addresses it exists to record (`38` §14.4: the secrets
            // are 2% of the file, the other 98% is the network).
            Some(e) if at >= e.path.len() => {
                raw_walk(&segs, at)
                    || (at == e.path.len() && !e.secret_exempt && dict::leaf_name_walk(&e.path, at))
            }
            Some(e) => {
                // The suppression the field card's own `perfect-forward-secrecy
                // keys group14` line forces (§12 item 2).
                !e.secret_exempt && dict::leaf_name_walk(&e.path, at)
            }
            None => raw_walk(&segs, at),
        };
        if leaf_hit {
            detectors |= DetectorSet::LEAF_NAME;
        }
        if detectors == 0 {
            continue;
        }
        if pre_redacted(text) {
            already.insert(stmt.line.0);
            continue;
        }
        let token = match stmt.tokens.get(at) {
            Some(t) => *t,
            None => continue,
        };
        edits.push(Edit {
            start: token.span.start,
            end: token.span.end,
            text: marker(label),
            ordinal: stmt.line,
            label,
            detectors,
            node: stmt.path.get(at).copied(),
            quarantine: false,
        });
    }
}

/// `14` §9.7's DECISION: an `Unshaped` line is run through the value-shape
/// detectors at token granularity, at maximum aggression, and a line that
/// trips any of them is quarantined — text destroyed, shape sketch stored.
fn gate_unshaped(capture: &str, dict: &Dictionary, line: &UnshapedLine, edits: &mut Vec<Edit>) {
    let texts: Vec<String> = line
        .tokens
        .iter()
        .map(|t| lex::interned_text(capture, t, &lex::JUNOS_SET))
        .collect();
    let mut detectors = 0u8;
    let mut label = RedactLabel::Unknown;
    for (at, text) in texts.iter().enumerate() {
        if text.starts_with("-----BEGIN") {
            detectors |= DetectorSet::PEM_ARMOUR;
            label = RedactLabel::CertKey;
        }
        // The content detectors run from token 0. They used to start at token
        // 2, and the cost was a whole class of paste: a **bare private key**.
        //
        //   -----BEGIN RSA PRIVATE KEY-----
        //   MIIEowIBAAKCAQEA…                <- one token, at index 0
        //   -----END RSA PRIVATE KEY-----
        //
        // The armour line was caught and quarantined; the key underneath was
        // one token on its own line, never reached index 2, and survived into
        // the capture in full. Demonstrated against the shipped code.
        //
        // `raw_walk` still needs its offset and keeps it below — it reads the
        // tokens *before* `at` to decide whether a leaf name marks this one as
        // a secret, so at index 0 and 1 there is nothing for it to read. The
        // other three are pure functions of the token's own text and never
        // needed the offset at all.
        // The content detectors run over the token AND over its pieces split
        // on `=`, `:` and `,` — see `pieces`. A whole-token test is a Junos
        // assumption: Junos writes `… ascii-text $9$abc`, with a space, so the
        // secret is its own token. Almost nothing else does.
        for piece in pieces(text) {
            if crypt_prefix(piece) {
                detectors |= DetectorSet::CRYPT_PREFIX;
            }
            if long_hex(piece) {
                detectors |= DetectorSet::LONG_HEX;
            }
            if base64ish(piece) {
                detectors |= DetectorSet::BASE64;
            }
        }
        // `key=value` and `key: value`, where the key is a secret word. This is
        // the shape of NetworkManager keyfiles, WireGuard configs, systemd
        // units, `docker compose config` output and `/etc/shadow` — none of
        // which the leaf-name walk below can see, because on those the leaf
        // name is not a preceding *token*, it is the left half of one.
        if let Some((lhs, _)) = text.split_once(['=', ':']) {
            if key_names_a_secret(lhs.trim()) {
                detectors |= DetectorSet::LEAF_NAME;
            }
        }
        // `at >= 1`, not `>= 2`. `raw_walk` looks back at most two tokens, so
        // one preceding token is enough for it to have something to read — and
        // at `>= 2` the shape `key-string <secret>` was missed outright, which
        // is a live secret form on Arista, Omada and Sodola.
        if at >= 1 && raw_walk(&texts, at) {
            detectors |= DetectorSet::LEAF_NAME;
        }
    }
    if detectors == 0 {
        return;
    }
    edits.push(Edit {
        start: line.span.start,
        end: line.span.end,
        text: sketch(capture, dict, &line.tokens, &texts),
        ordinal: line.line,
        label,
        detectors,
        node: None,
        quarantine: true,
    });
}

/// §4.6's two-position leaf-name walk over raw tokens: no capture positions
/// are known, so every preceding token counts as a position.
/// A token, plus its pieces split on the separators the lexer does not treat
/// as separators: `=`, `:` and `,`.
///
/// `lex.rs`'s table separates on space, tab, quote and brackets and nothing
/// else, which is correct for Junos set-form and wrong for the rest of the
/// world. Without this, a whole-token detector never sees the secret in
/// `psk=hunter2`, `PrivateKey=<base64>`, `root:$6$…:19000:…` or
/// `DB_PASSWORD: hunter2` — all four were demonstrated leaking, verbatim, with
/// `drops = 0`, against the shipped code on 2026-08-10.
///
/// The whole token is yielded first so nothing that fired before can stop
/// firing: this only ever adds detections.
/// Does this `key=`/`key:` left-hand side name a secret?
///
/// `is_secret_word` is an exact match against `14` §9.4's list, which is right
/// for a Junos path segment — those are exactly `pre-shared-key`, `secret`,
/// `community`. It is wrong for a settings key, where the secret word is a
/// *component* of a compound name: `DB_PASSWORD`, `admin_password`,
/// `TlsDnsApiKey`. So each `_`, `-` and `.` separated part is tested too.
///
/// **Only on the safety-net path.** `14` §9.7 puts the unshaped sweep at
/// maximum aggression on purpose, and a false positive there quarantines a
/// line Fathom had already failed to understand — it costs a residue line's
/// text, not a fact. The bound-statement path keeps the exact match, because
/// there redaction is driven by the dictionary and precision is the point.
fn key_names_a_secret(lhs: &str) -> bool {
    if dict::is_secret_word(lhs) {
        return true;
    }
    lhs.split(['_', '-', '.'])
        .any(|part| !part.is_empty() && dict::is_secret_word(part))
}

fn pieces(text: &str) -> impl Iterator<Item = &str> + '_ {
    std::iter::once(text).chain(text.split(['=', ':', ',']).filter(|p| !p.is_empty()))
}

fn raw_walk(texts: &[String], at: usize) -> bool {
    texts
        .iter()
        .take(at)
        .rev()
        .take(2)
        .any(|t| dict::is_secret_word(t))
}

/// `14` §9.7's sketch: the first two tokens are kept only if neither trips a
/// detector and both are in the dictionary's known segment set; every other
/// token becomes `<word>` or `<quoted>`; no character of any token beyond the
/// second survives.
///
/// # THE LENGTH IS GONE, AND THAT IS A DELIBERATE DEVIATION FROM `14` §9.7
///
/// §9.7 specifies `<word:LEN>` and `<quoted:LEN>` with the token's exact byte
/// length, and that is what this emitted until 2026-08-21. **It was a length
/// oracle for every secret the gate destroys.**
///
/// A quarantined line is, by construction, one the gate believes carries a
/// secret. So `set snmp community <word:12>` says: the community string on
/// this box is exactly twelve characters. With `head_safe` keeping the first
/// two tokens verbatim, the reader gets the statement's name *and* the
/// secret's exact length — which is most of what a guesser wants and all of
/// what a search-space calculation needs.
///
/// **The corpus already forbids this quantity being kept.** Fifty lines above,
/// [`RedactionEntry::orig_len`] carries `14` §9.5's rule in its own doc
/// comment — *"for the in-session report only; the persistence layer must not
/// store it"*. The sketch is written into the capture, and the capture is
/// welded into the workspace as `Origin::Parsed` provenance. So the sketch was
/// persisting, on the operator's own disk, the exact quantity §9.5 says must
/// not be persisted.
///
/// Survivable while nothing left the machine, which is why four reviews and a
/// dedicated adversarial pass over `38` §14 did not catch it until one did.
/// **It stops being survivable the moment a capture crosses a wire**, which is
/// what `49` decided this product will do.
///
/// The number bought nothing it cost. What makes a quarantined line
/// recognisable to the person who pasted it is its SHAPE — how many tokens,
/// which were quoted, and the two head words when they are safe to keep. The
/// length of the fifth token identifies nothing to a human and hands an
/// attacker a bound. It is not bucketed or coarsened, because a bucket is
/// still an oracle with fewer bits; it is removed.
///
/// The deviation follows the precedent set by `simple-password`'s addition to
/// `SECRET_WORD_LIST`: where `14` and a live leak disagree, the leak wins and
/// the reason is written down here rather than in a commit message.
fn sketch(capture: &str, dict: &Dictionary, tokens: &[lex::Token], texts: &[String]) -> String {
    let text_at = |at: usize| -> String {
        texts
            .get(at)
            .cloned()
            .or_else(|| {
                tokens
                    .get(at)
                    .map(|t| lex::interned_text(capture, t, &lex::JUNOS_SET))
            })
            .unwrap_or_default()
    };
    let head_safe = tokens.len() >= 2
        && (0..2).all(|at| {
            let text = text_at(at);
            dict.is_known_segment(&text)
                && !crypt_prefix(&text)
                && !long_hex(&text)
                && !base64ish(&text)
                && !dict::is_secret_word(&text)
        });
    let mut out = String::new();
    for (at, token) in tokens.iter().enumerate() {
        if at > 0 {
            out.push(' ');
        }
        if head_safe && at < 2 {
            out.push_str(&text_at(at));
            continue;
        }
        // No length. See this function's doc comment: the byte count was a
        // length oracle for the secret this line was quarantined to protect.
        match token.kind {
            TokenKind::Quoted => out.push_str("<quoted>"),
            _ => out.push_str("<word>"),
        }
    }
    out
}

/// `^\$[0-9a-z]{1,2}\$` — `$1$` md5crypt, `$5$`, `$6$`, `$8$`, `$9$`.
fn crypt_prefix(text: &str) -> bool {
    let rest = match text.strip_prefix('$') {
        Some(r) => r,
        None => return false,
    };
    let head: String = rest.chars().take_while(|c| *c != '$').collect();
    (1..=2).contains(&head.chars().count())
        && head
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        && rest.len() > head.len()
        && rest.get(head.len()..).map(|r| r.starts_with('$')) == Some(true)
}

/// `^[0-9a-fA-F]{32,}$` — 32 hex characters is 128 bits.
fn long_hex(text: &str) -> bool {
    text.chars().count() >= 32 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// `^[A-Za-z0-9+/]{24,}={0,2}$`.
fn base64ish(text: &str) -> bool {
    let body = text.trim_end_matches('=');
    let pad = text.chars().count() - body.chars().count();
    pad <= 2
        && body.chars().count() >= 24
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
}

/// `14` §9.6: the value consists of ≤ 2 distinct characters, or matches
/// `^<[A-Za-z_ -]+>$`, or equals a placeholder our own emitter writes.
fn pre_redacted(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    let distinct: BTreeSet<char> = text.chars().collect();
    // The two-distinct-character rule recognises a mask an operator typed
    // themselves — `xxxxxxxxxxxx`, `************`. It carries a length floor
    // because without one it also recognises **`1111`**, which is not a mask,
    // it is a bad password. Before 2026-08-10 that value was kept in the
    // capture *verbatim* and reported back as `already_redacted` — Fathom told
    // the operator their secret was safe because they had redacted it, having
    // in fact stored it.
    //
    // The asymmetry decides the floor and is worth stating: destroying a real
    // mask costs nothing, because a mask carries no information. Keeping a real
    // password is a breach of invariant 3. So a short low-variety value is
    // treated as a secret and destroyed, and only a long one is trusted as a
    // mask.
    //
    // `14` §9.6 states the rule without the floor. This narrows it, in the safe
    // direction, and the narrowing is filed as a proposed amendment rather than
    // taken silently — see `70` §13.
    const MASK_MIN_CHARS: usize = 8;
    if distinct.len() <= 2 && text.chars().count() >= MASK_MIN_CHARS {
        return true;
    }
    if text == "<PSK>" {
        return true;
    }
    let inner = text.strip_prefix('<').and_then(|t| t.strip_suffix('>'));
    match inner {
        Some(i) => {
            !i.is_empty()
                && i.chars()
                    .all(|c| c.is_ascii_alphabetic() || c == '_' || c == ' ' || c == '-')
        }
        None => false,
    }
}

/// True when this node's token was redacted by the gate. The flag, not the
/// marker text, is the authority (§4.6 rule 2).
pub(crate) fn is_redacted(tree: &StmtTree, idx: StmtIdx) -> Option<RedactLabel> {
    tree.arena.get(idx.0 as usize).and_then(|n| n.redacted)
}

/// The `SecretPlaceholder` a `secret_placeholder:` field spec constructs. It
/// takes the entry's label and never the argument's text — WO-01 §4.4's only
/// path into the type.
pub(crate) fn placeholder_of(spec: &ValueSpec) -> Option<fathom_ir::scalar::SecretPlaceholder> {
    match spec {
        ValueSpec::Secret { label } => Some(fathom_ir::scalar::SecretPlaceholder::new(*label)),
        _ => None,
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    #[test]
    fn crypt_prefix_detector() {
        assert!(crypt_prefix("$9$abcdef"));
        assert!(crypt_prefix("$1$xyz"));
        assert!(!crypt_prefix("$$abc"));
        assert!(!crypt_prefix("aes-256-cbc"));
        assert!(!crypt_prefix("$abcd$x"));
    }

    #[test]
    fn long_hex_and_base64_detectors() {
        assert!(long_hex(&"a".repeat(32)));
        assert!(!long_hex(&"a".repeat(31)));
        assert!(!long_hex("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
        assert!(base64ish("QUJDREVGR0hJSktMTU5PUFFSU1RVVg=="));
        assert!(!base64ish("short"));
        assert!(!base64ish("has-a-hyphen-in-it-which-is-not-base64"));
    }

    #[test]
    fn pre_redaction_detector() {
        assert!(pre_redacted("<REDACTED>"));
        assert!(pre_redacted("<PSK>"));
        assert!(pre_redacted("xxxxxxxx"));
        assert!(pre_redacted("********"));
        assert!(!pre_redacted("$9$EXAMPLEnotARealKey01234"));
        assert!(!pre_redacted("aes-256-cbc"));
    }

    #[test]
    fn labels_map_onto_the_graph_side_one_for_one() {
        use fathom_ir::scalar::SecretLabel;
        assert_eq!(RedactLabel::Psk.to_secret_label(), Some(SecretLabel::Psk));
        assert_eq!(RedactLabel::Unknown.to_secret_label(), None);
        assert_eq!(
            marker(RedactLabel::SnmpCommunity),
            "<REDACTED:snmp-community>"
        );
    }

    #[test]
    fn secret_words_fold_hyphens_and_case() {
        assert!(dict::is_secret_word("Pre-Shared-Key"));
        assert!(dict::is_secret_word("pre_shared_key"));
        assert!(!dict::is_secret_word("ascii-text"));
    }
}

//! WO-08 §4.7.3 — the encoder's vectors, gate X0.8 against the **final
//! bytes**, the source's egress and sink hygiene, and the splice's
//! determinism.

use std::path::PathBuf;

use fathom_artifact::{
    assemble, base64, SHELL_SOURCE, TOKEN_DICT_B64, TOKEN_TOKENS_CSS, TOKEN_WASM_B64,
};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn base64_matches_rfc4648_vectors() {
    // RFC 4648 §10's seven test vectors.
    for (input, want) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(base64(input.as_bytes()), want, "{input:?}");
    }
}

#[test]
fn assembled_artifact_pins_x08() {
    let bytes = assemble(&workspace_root()).expect("the artifact assembles");
    let text = String::from_utf8(bytes).expect("the artifact is UTF-8");

    // X0.8 (71 §3.6): asserted against the final bytes, not the template.
    assert_eq!(
        text.matches("connect-src 'none'").count(),
        1,
        "connect-src 'none' appears exactly once"
    );
    for directive in [
        "default-src 'none';",
        "script-src 'unsafe-inline' 'wasm-unsafe-eval';",
        "style-src 'unsafe-inline';",
        "img-src data:;",
        "font-src data:;",
        "connect-src 'none';",
        // 'none', not `blob:`. `43` §3.7 and `34` §2.9 both specify `blob:`
        // for a parse worker, and `43` calls it "load-bearing rather than
        // speculative". IT IS SPECULATIVE IN THIS ARTIFACT: nothing here
        // constructs a Worker, and an unused permissive directive inside an
        // otherwise `default-src 'none'` policy is a question a reviewer will
        // ask and the artifact cannot answer. Tightened 2026-08-15 with the
        // deviation recorded in both documents; the trigger to restore it is
        // the first line of code that creates a Worker, and this pin is what
        // makes that restoration deliberate rather than quiet.
        "worker-src 'none';",
        "child-src 'none';",
        "frame-src 'none';",
        "form-action 'none';",
        "base-uri 'none';",
        "object-src 'none';",
        "media-src 'none';",
        "manifest-src 'none';",
        "require-trusted-types-for 'script';",
        "trusted-types fathom-dom fathom-worker;",
    ] {
        assert!(text.contains(directive), "the CSP carries `{directive}`");
    }
    assert!(text.contains(r#"<meta name="referrer" content="no-referrer">"#));

    // Neither splice token survives.
    assert!(
        !text.contains(TOKEN_TOKENS_CSS),
        "the tokens splice happened"
    );
    assert!(!text.contains(TOKEN_WASM_B64), "the module splice happened");
    assert!(
        !text.contains(TOKEN_DICT_B64),
        "the dictionary splice happened"
    );
    // The three splices really landed: a token value and the module's magic.
    assert!(text.contains("--radius: 0"), "design/tokens.css is inlined");
    assert!(
        text.contains("AGFzbQ"),
        "the base64 module opens with \\0asm"
    );
}

#[test]
fn shell_source_carries_no_egress_and_no_sinks() {
    let source = std::fs::read_to_string(workspace_root().join(SHELL_SOURCE))
        .expect("the shell source is checked in");
    // The same literals G8 greps for — invariant 1, and the trusted-types
    // directives the no-sink rule makes real.
    for pattern in [
        "new WebSocket",
        "new EventSource",
        "new XMLHttpRequest",
        "navigator.sendBeacon(",
        "fetch(",
        "import(",
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "<script src",
    ] {
        assert!(
            !source.contains(pattern),
            "the shell source must not contain `{pattern}`"
        );
    }
    // 51 §10, §14: no hex, no px font size, no duration, and radius and
    // elevation only through the tokens.
    for line in source.lines() {
        if line.contains("border-radius") {
            assert!(line.contains("var(--radius)"), "{line}");
        }
        if line.contains("box-shadow") {
            assert!(line.contains("var(--shadow)"), "{line}");
        }
        assert!(!line.contains("@keyframes"), "{line}");
        assert!(!line.contains("transition:"), "{line}");
        assert!(!line.contains("animation:"), "{line}");
    }
}

#[test]
fn artifact_is_deterministic() {
    let root = workspace_root();
    let a = assemble(&root).expect("the artifact assembles");
    let b = assemble(&root).expect("the artifact assembles");
    assert_eq!(a.len(), b.len());
    assert!(a == b, "two assemblies are byte-identical");
}

// --- the dictionary the page hands in ----------------------------------------
//
// Until 2026-08-15 the statement dictionary was `include_str!`'d into the
// WebAssembly module, and `fathom-ingest`'s `tests/embedded.rs` proved the
// compiled-in copy was the copy on disk. Moving the bytes into the page (which
// bought 26 915 bytes of module against `44` §5.2's 900 000-byte ceiling) took
// that guarantee away: the compiler no longer reads the corpus, an assembler
// does, and an assembler can be wrong in ways a compiler cannot.
//
// So the guard moves here, to the boundary that now carries the risk, and it is
// deliberately asserted against the FINAL ARTIFACT rather than against the
// assembler's return value. What ships is what is checked.

/// RFC 4648 §4, the inverse of `fathom_artifact::base64`. Written out rather
/// than reused because a decoder that shares a table with its encoder cannot
/// catch a wrong table.
fn unbase64(text: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in text.bytes() {
        let Some(v) = val(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

/// `fathom_wasm::dictframe`'s frame, read back: `(role, name, source)` per file.
fn unpack_dict(bytes: &[u8]) -> Vec<(u8, String, String)> {
    let u32_at = |at: usize| -> u32 {
        let mut v = [0u8; 4];
        for (i, slot) in v.iter_mut().enumerate() {
            *slot = *bytes.get(at + i).unwrap_or(&0);
        }
        u32::from_le_bytes(v)
    };
    let text_at = |at: usize, len: usize| -> String {
        String::from_utf8(bytes.get(at..at + len).unwrap_or_default().to_vec())
            .unwrap_or_else(|e| panic!("a frame field is not UTF-8: {e}"))
    };

    let count = u32_at(0) as usize;
    let mut at = 4usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let role = *bytes.get(at).expect("a role byte");
        at += 1;
        let name_len = u32_at(at) as usize;
        at += 4;
        let name = text_at(at, name_len);
        at += name_len;
        let src_len = u32_at(at) as usize;
        at += 4;
        let source = text_at(at, src_len);
        at += src_len;
        out.push((role, name, source));
    }
    assert_eq!(at, bytes.len(), "the frame has trailing bytes");
    out
}

/// The base64 the page carries, lifted out of the assembled file by the same
/// variable name the shell source declares.
fn dictionary_frame_in(artifact: &str) -> Vec<(u8, String, String)> {
    let marker = "var FATHOM_DICT_B64 = \"";
    let start = artifact
        .find(marker)
        .expect("the page declares FATHOM_DICT_B64")
        + marker.len();
    let end = start
        + artifact
            .get(start..)
            .and_then(|s| s.find('"'))
            .expect("the literal is closed");
    unpack_dict(&unbase64(
        artifact.get(start..end).expect("the literal's body"),
    ))
}

/// A file added to, removed from or edited in `corpus/dict/junos-srx/`, and the
/// page shipping the old set. `include_str!` made this impossible; an assembler
/// does not, so it is checked.
#[test]
fn the_page_carries_the_dictionary_that_is_on_disk() {
    let root = workspace_root();
    let text = String::from_utf8(assemble(&root).expect("the artifact assembles"))
        .expect("the artifact is UTF-8");
    let files = dictionary_frame_in(&text);

    let dict_dir = root.join(fathom_artifact::dictionary::DICT_DIR);
    let mut on_disk: Vec<String> = std::fs::read_dir(&dict_dir)
        .expect("the dictionary directory is checked in")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    on_disk.sort();
    assert!(!on_disk.is_empty(), "the dictionary directory is not empty");

    let carried: Vec<String> = files
        .iter()
        .filter(|(role, _, _)| *role == fathom_wasm::dictframe::ROLE_DICT_SOURCE)
        .map(|(_, name, _)| name.clone())
        .collect();
    assert_eq!(
        carried,
        on_disk,
        "the page's dictionary and {} disagree. A file was added, removed or \
         renamed and the artifact was not rebuilt, or the assembler's enumeration \
         drifted from Dictionary::load's.",
        fathom_artifact::dictionary::DICT_DIR
    );

    for (_, name, source) in files
        .iter()
        .filter(|(role, _, _)| *role == fathom_wasm::dictframe::ROLE_DICT_SOURCE)
    {
        let disk =
            std::fs::read_to_string(dict_dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(&disk, source, "{name} differs from the copy in the page");
    }

    let keys: Vec<&(u8, String, String)> = files
        .iter()
        .filter(|(role, _, _)| *role == fathom_wasm::dictframe::ROLE_FIELD_KEYS)
        .collect();
    assert_eq!(keys.len(), 1, "exactly one field-key registry travels");
    let disk_keys =
        std::fs::read_to_string(root.join(fathom_artifact::dictionary::FIELD_KEYS_SOURCE))
            .expect("schema/field-keys.yaml is checked in");
    assert_eq!(
        keys.first().map(|(_, _, s)| s.as_str()),
        Some(disk_keys.as_str()),
        "schema/field-keys.yaml differs from the copy in the page"
    );
}

// --- the seed concept graph the page hands in --------------------------------
//
// Until 2026-08-15 `corpus/concepts/seed.yaml` was
// `include_str!("seed_concepts.yaml")` inside `fathom-corpus`, and the compiler
// guaranteed two things for free: the module's copy WAS the repository's copy,
// and a module could not be built without one at all. Moving it onto the
// `OP_INIT` wire (7 643 bytes of module, against `44` §5.2's 900 000-byte
// ceiling) spends both guarantees, so both are bought back explicitly:
//
//   * `build_concept_table` refuses an empty concept set outright, which is
//     the "cannot be built without one" half. `fathom_artifact::corpus::verify`
//     runs the packed frame through `OP_INIT` at assembly time, so that refusal
//     surfaces as a failed `cargo run -p fathom-artifact` rather than as a
//     quietly worse finder in someone's browser.
//   * the two tests below are the "is the repository's copy" half — the bytes,
//     and then the behaviour, mirroring exactly what the dictionary's pair of
//     tests does one section above.

/// `fathom_wasm::protocol::pack_corpus`'s frame, read back:
/// `(section, name, source)` per file. Written out rather than reused because a
/// decoder sharing code with its encoder cannot catch a wrong encoder.
fn unpack_corpus(bytes: &[u8]) -> Vec<(u8, String, String)> {
    let u32_at = |at: usize| -> u32 {
        let mut v = [0u8; 4];
        for (i, slot) in v.iter_mut().enumerate() {
            *slot = *bytes.get(at + i).unwrap_or(&0);
        }
        u32::from_le_bytes(v)
    };
    let text_at = |at: usize, len: usize| -> String {
        String::from_utf8(bytes.get(at..at + len).unwrap_or_default().to_vec())
            .unwrap_or_else(|e| panic!("a frame field is not UTF-8: {e}"))
    };

    let count = u32_at(0) as usize;
    let mut at = 4usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let section = *bytes.get(at).expect("a section byte");
        at += 1;
        let name_len = u32_at(at) as usize;
        at += 4;
        let name = text_at(at, name_len);
        at += name_len;
        let src_len = u32_at(at) as usize;
        at += 4;
        let source = text_at(at, src_len);
        at += src_len;
        out.push((section, name, source));
    }
    assert_eq!(at, bytes.len(), "the frame has trailing bytes");
    out
}

/// The `OP_INIT` base64 the page carries, lifted out of the assembled file by
/// the same variable name the shell source declares.
fn corpus_frame_in(artifact: &str) -> Vec<(u8, String, String)> {
    let marker = "var FATHOM_CORPUS_B64 = \"";
    let start = artifact
        .find(marker)
        .expect("the page declares FATHOM_CORPUS_B64")
        + marker.len();
    let end = start
        + artifact
            .get(start..)
            .and_then(|s| s.find('"'))
            .expect("the literal is closed");
    unpack_corpus(&unbase64(
        artifact.get(start..end).expect("the literal's body"),
    ))
}

/// `Section::Concepts` on the wire. Named as a literal rather than imported so
/// that a renumbering of the section bytes — which would silently reinterpret
/// every frame ever built — fails here instead of agreeing with itself.
const WIRE_SECTION_CONCEPTS: u8 = 3;

/// A file added to, removed from or edited in `corpus/concepts/`, and the page
/// shipping the old graph. `include_str!` made this impossible; an assembler
/// does not, so it is checked — against the FINAL ARTIFACT, because what ships
/// is what is checked.
#[test]
fn the_page_carries_the_seed_concept_graph_that_is_on_disk() {
    let root = workspace_root();
    let text = String::from_utf8(assemble(&root).expect("the artifact assembles"))
        .expect("the artifact is UTF-8");
    let files = corpus_frame_in(&text);

    let dir = root
        .join(fathom_artifact::corpus::CORPUS_DIR)
        .join("concepts");
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .expect("corpus/concepts/ is checked in")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    on_disk.sort();
    assert!(
        !on_disk.is_empty(),
        "corpus/concepts/ holds no .yaml: the page would boot a finder with no \
         seed concept graph, and 16 §12's breadth resolution would silently stop \
         resolving"
    );

    let carried: Vec<String> = files
        .iter()
        .filter(|(section, _, _)| *section == WIRE_SECTION_CONCEPTS)
        .map(|(_, name, _)| name.clone())
        .collect();
    assert_eq!(
        carried, on_disk,
        "the page's concept sources and corpus/concepts/ disagree. A file was \
         added, removed or renamed and the artifact was not rebuilt, or the \
         assembler's enumeration drifted from load_corpus's."
    );

    for (_, name, source) in files
        .iter()
        .filter(|(section, _, _)| *section == WIRE_SECTION_CONCEPTS)
    {
        let disk =
            std::fs::read_to_string(dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(&disk, source, "{name} differs from the copy in the page");
    }
}

/// Bytes being equal does not prove behaviour is equal. The frame the page
/// carries is loaded into a `CorpusIndex` and its concept table compared with
/// the one built by reading the directory — ids, kinds, labels, relations,
/// surfaces and the quantised icf. This is the half of `include_str!`'s
/// guarantee that says the graph the browser reasons over is the graph in the
/// repository, not merely the same bytes in a different order.
#[test]
fn the_concept_graph_in_the_page_builds_what_the_disk_builds() {
    let root = workspace_root();
    let text = String::from_utf8(assemble(&root).expect("the artifact assembles"))
        .expect("the artifact is UTF-8");

    // The page's frame carries bare names; the shell prefixes each with its
    // section directory when it parses one, so the same reconstruction happens
    // here rather than comparing against a name the browser never sees.
    let files: Vec<fathom_corpus::SourceFile> = corpus_frame_in(&text)
        .into_iter()
        .map(|(section, name, source)| {
            let (section, dir) = fathom_corpus::SECTION_DIRS
                .iter()
                .find(|(s, _)| fathom_wasm::protocol::section_byte(*s) == section)
                .copied()
                .unwrap_or_else(|| panic!("section byte {section} is not a section"));
            fathom_corpus::SourceFile {
                section,
                name: format!("{dir}/{name}"),
                source,
            }
        })
        .collect();

    let from_page =
        fathom_corpus::CorpusIndex::from_sources(&files).expect("the page's corpus loads");
    let from_disk = fathom_corpus::CorpusIndex::load(&root.join("corpus"))
        .expect("the checked-in corpus loads");

    let dump = |idx: &fathom_corpus::CorpusIndex| -> String {
        let mut s = String::new();
        for c in &idx.concepts.concepts {
            s.push_str(&format!(
                "{} {:?} {} seed={} icf={} carriers={} narrower={:?} broader={:?} \
                 related={:?} opposite={:?}\n",
                c.id,
                c.kind,
                c.label,
                c.seed,
                c.icf_milli,
                c.entry_count,
                c.narrower,
                c.broader,
                c.related,
                c.opposite
            ));
            for surf in &c.surfaces {
                s.push_str(&format!("  {} {}\n", surf.text, surf.conf_milli));
            }
        }
        s
    };

    let page = dump(&from_page);
    assert!(
        page.contains("concept:state.operational"),
        "the seed graph reached the index: without it this test would pass on \
         two equally empty concept tables"
    );
    assert_eq!(
        page,
        dump(&from_disk),
        "the concept graph the page ships and the one on disk differ"
    );
}

/// Bytes being equal does not prove behaviour is equal: the handed-in path
/// never reads the schema tree. So the frame the page carries is built into a
/// dictionary and compared against the one `Dictionary::load` builds off disk.
/// This is what `fathom-ingest`'s `embedded_and_on_disk_ingest_identically`
/// used to do for the compiled-in copy.
#[test]
fn the_dictionary_in_the_page_builds_what_the_disk_builds() {
    let root = workspace_root();
    let text = String::from_utf8(assemble(&root).expect("the artifact assembles"))
        .expect("the artifact is UTF-8");
    let files = dictionary_frame_in(&text);

    let sources: Vec<(String, String)> = files
        .iter()
        .filter(|(role, _, _)| *role == fathom_wasm::dictframe::ROLE_DICT_SOURCE)
        .map(|(_, n, s)| (n.clone(), s.clone()))
        .collect();
    let keys = files
        .iter()
        .find(|(role, _, _)| *role == fathom_wasm::dictframe::ROLE_FIELD_KEYS)
        .map(|(_, _, s)| s.clone())
        .expect("the frame carries the field-key registry");

    let from_page =
        fathom_ingest::hosted::dictionary_from_host(&sources, "schema/field-keys.yaml", &keys)
            .expect("the page's dictionary loads");
    let from_disk = fathom_ingest::dict::Dictionary::load(&root).expect("the disk's dictionary");

    assert_eq!(from_page.platform(), from_disk.platform());
    assert_eq!(from_page.entry_count(), from_disk.entry_count());
    for i in 0..from_disk.entry_count() {
        let i = u16::try_from(i).expect("fewer than 65536 entries");
        assert_eq!(from_page.entry_id(i), from_disk.entry_id(i), "entry {i}");
    }
}

/// The equipment form's field-key table must name the fields the schema
/// declares, and no other.
///
/// The page carries seven wire numbers in `EQUIP_FIELDS` because the module
/// answers with values rather than with a form description. That is a hand
/// table in a tree whose whole discipline is that hand tables drift — and this
/// one already nearly did: `Chassis.model` was written as 300 from memory and
/// is 19. It was caught by looking, which is not a method that scales.
///
/// So the numbers are pinned here against the generated tables. A schema change
/// that moves a key fails this test instead of silently pointing the form at a
/// different field, which would store the model in the serial and say nothing.
#[test]
fn the_equipment_form_names_the_schema_s_field_keys() {
    use fathom_ir::generated::ir_types::{ChassisField, DeviceField};

    let source = std::fs::read_to_string(workspace_root().join(SHELL_SOURCE))
        .expect("the shell source is checked in");

    // (the page's label, the key the schema declares)
    let expected = [
        ("hostname", DeviceField::Hostname.key().0),
        ("platform", DeviceField::Platform.key().0),
        ("role", DeviceField::Role.key().0),
        ("model", ChassisField::Model.key().0),
        ("serial", ChassisField::Serial.key().0),
        ("os version", DeviceField::OsVersion.key().0),
        ("management address", DeviceField::ManagementAddress.key().0),
    ];

    for (label, key) in expected {
        let row = source
            .lines()
            .find(|l| l.contains(&format!("'{label}'")) && l.trim_start().starts_with('['))
            .unwrap_or_else(|| panic!("EQUIP_FIELDS has no row labelled {label:?}"));
        let got: u32 = row
            .trim_start()
            .trim_start_matches('[')
            .split(',')
            .next()
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or_else(|| panic!("the {label:?} row does not begin with a number: {row}"));
        assert_eq!(
            got, key,
            "the equipment form sends key {got} for {label:?}; the schema declares {key}"
        );
    }
}

/// Every platform the form offers must be one `schema/platforms.yaml` declares.
/// `PlatformId` is a foreign key into that file, so an option that is not a row
/// there is a value the store will hold and nothing will ever understand.
#[test]
fn the_equipment_form_offers_only_declared_platforms() {
    let source = std::fs::read_to_string(workspace_root().join(SHELL_SOURCE))
        .expect("the shell source is checked in");
    let registry = std::fs::read_to_string(workspace_root().join("schema/platforms.yaml"))
        .expect("the platform registry is checked in");

    let start = source
        .find("var PLATFORMS = [")
        .expect("the page declares PLATFORMS");
    let end = source[start..].find("];").expect("PLATFORMS is a literal") + start;
    let listed: Vec<String> = source[start..end]
        .split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect();
    assert!(!listed.is_empty(), "PLATFORMS parsed as empty");

    // The `platforms:` block's rows are `  <id>: { ... }` at two spaces.
    let block = registry
        .find("\nplatforms:")
        .expect("the registry has a platforms block");
    for id in &listed {
        assert!(
            registry[block..].contains(&format!("\n  {id}:")),
            "the form offers platform {id:?}, which schema/platforms.yaml does not declare"
        );
    }
}

/// **Every design token the shell references must exist in `design/tokens.css`.**
///
/// A `var(--typo)` is not an error in CSS — it is an invalid value, so the
/// property silently falls back to its initial. That is how `.dbox rect { fill:
/// var(--bg) }` rendered every diagram box solid black on a white page: SVG's
/// initial fill is black, `--bg` never existed (the token is `--page`), and
/// nothing anywhere said so. The same typo had already been sitting in the
/// equipment form's inputs for days, where a transparent background happened to
/// look correct.
///
/// So the check is mechanical: collect every `var(--x)` the shell uses and
/// require a matching declaration in the token file.
#[test]
fn every_design_token_the_shell_uses_is_declared() {
    let shell = std::fs::read_to_string(workspace_root().join(SHELL_SOURCE))
        .expect("the shell source is checked in");
    let tokens = std::fs::read_to_string(workspace_root().join("design/tokens.css"))
        .expect("design/tokens.css is checked in");

    let mut used: Vec<&str> = Vec::new();
    let mut rest = shell.as_str();
    while let Some(at) = rest.find("var(--") {
        rest = &rest[at + 4..];
        if let Some(end) = rest.find(')') {
            let name = &rest[..end];
            // A fallback -- var(--a, b) -- names its token before the comma.
            let name = name.split(',').next().unwrap_or(name).trim();
            if !used.contains(&name) {
                used.push(name);
            }
        }
    }
    assert!(!used.is_empty(), "the shell uses no tokens at all?");

    let mut missing: Vec<&str> = used
        .into_iter()
        .filter(|n| !tokens.contains(&format!("{n}:")))
        .collect();
    missing.sort_unstable();
    assert!(
        missing.is_empty(),
        "the shell references {} token(s) that design/tokens.css does not declare: {missing:?}. \
         A missing token is not an error in CSS -- the property silently takes its initial value, \
         which is how a diagram box ends up solid black.",
        missing.len()
    );

    // What this does NOT catch, said plainly so nobody trusts it further than it
    // goes: a token that EXISTS but means something else. `--rule-hair` is `1px`,
    // a width, and `stroke: var(--rule-hair)` is just as invalid as a missing
    // token while passing the check above. That one was found by looking at the
    // rendered page, which remains the only way to find it.
    for (prop, token) in [("stroke:", "--rule-hair"), ("fill:", "--rule-hair")] {
        for line in shell.lines() {
            let l = line.trim();
            assert!(
                !(l.contains(prop) && l.contains(token)),
                "`{prop} var({token})` is a length where a colour is wanted: {l}"
            );
        }
    }
}

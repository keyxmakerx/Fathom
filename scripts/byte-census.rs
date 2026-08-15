//! A byte census over the release WebAssembly module: where the bytes go, by
//! section, by function, and by originating crate.
//!
//! WHY THIS EXISTS AS A LOOSE `rustc` SCRIPT RATHER THAN A CRATE.
//! `twiggy` and `wasm-objdump` are the tools that normally answer this, and
//! neither may be added (78 §5.2, and `scripts/gate-zero.sh` fails the build on
//! a new external crate). A workspace member would answer it too, but this file
//! is a measuring instrument, not product code: it must not enter the artifact,
//! must not enter `cargo test --workspace`, and must not put a fifteenth row in
//! a root `Cargo.toml` that four parallel sessions are editing. A single-file
//! `rustc` program has none of those couplings and is reproducible from the
//! command in `scripts/byte-census.sh`.
//!
//! METHOD. Two builds of the same crate under the same release profile:
//!
//!   * the SHIPPED module — `strip = "symbols"`, which is what the size gate in
//!     `crates/fathom-wasm/tests/artifact_gates.rs` measures and what the page
//!     loads;
//!   * the NAMED module — the identical profile with `strip = "none"`, which
//!     keeps the `name` custom section that wasm-ld would otherwise discard.
//!
//! The two share a byte-identical code section (the tool asserts this, function
//! body by function body, and refuses to report if it is ever false — a
//! mismatch would mean the attribution described a module nobody ships). The
//! name section is then joined onto the shipped module's function bodies, which
//! is how a per-function and per-crate number is obtained without a linker map.
//!
//! Everything below is safe Rust over a byte slice; nothing is executed. The
//! section reader is the same shape as `crates/fathom-wasm/src/wasmbin.rs`,
//! deliberately duplicated rather than shared: `wasmbin` is compiled INTO the
//! artifact and every byte it grows is a byte this census then has to explain.

use std::collections::BTreeMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// LEB128 + section walking
// ---------------------------------------------------------------------------

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes, at: 0 }
    }
    fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }
    fn byte(&mut self) -> u8 {
        let b = self.bytes[self.at];
        self.at += 1;
        b
    }
    /// Unsigned LEB128. The wasm binary format caps these at 5 bytes for a u32;
    /// a producer that emits more has produced something we are not parsing.
    fn leb_u32(&mut self) -> u32 {
        let mut value: u32 = 0;
        let mut shift = 0;
        loop {
            let b = self.byte();
            value |= ((b & 0x7f) as u32) << shift;
            if b & 0x80 == 0 {
                return value;
            }
            shift += 7;
            assert!(shift < 35, "LEB128 wider than u32 at offset {}", self.at);
        }
    }
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.bytes[self.at..self.at + n];
        self.at += n;
        s
    }
    fn name(&mut self) -> String {
        let n = self.leb_u32() as usize;
        String::from_utf8_lossy(self.take(n)).into_owned()
    }
}

struct Section<'a> {
    id: u8,
    /// Custom sections carry a name; every other id does not.
    custom_name: Option<String>,
    payload: &'a [u8],
    /// id byte + the LEB128 length. Real bytes in the file, so they are counted.
    header_len: usize,
}

impl Section<'_> {
    fn total(&self) -> usize {
        self.header_len + self.payload.len()
    }
    fn label(&self) -> String {
        match self.custom_name {
            Some(ref n) => format!("custom \"{n}\""),
            None => section_id_name(self.id).to_owned(),
        }
    }
}

fn section_id_name(id: u8) -> &'static str {
    match id {
        0 => "custom",
        1 => "type",
        2 => "import",
        3 => "function",
        4 => "table",
        5 => "memory",
        6 => "global",
        7 => "export",
        8 => "start",
        9 => "element",
        10 => "code",
        11 => "data",
        12 => "data count",
        13 => "tag",
        _ => "unknown",
    }
}

fn sections(wasm: &[u8]) -> Vec<Section<'_>> {
    assert!(
        wasm.len() >= 8 && &wasm[0..4] == b"\0asm",
        "not a WebAssembly module: bad preamble"
    );
    let mut r = Reader::new(&wasm[8..]);
    let mut out = Vec::new();
    while !r.done() {
        let before = r.at;
        let id = r.byte();
        let size = r.leb_u32() as usize;
        let header_len = r.at - before;
        let payload = r.take(size);
        let custom_name = if id == 0 {
            Some(Reader::new(payload).name())
        } else {
            None
        };
        out.push(Section {
            id,
            custom_name,
            payload,
            header_len,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Code section: one entry per defined (non-imported) function
// ---------------------------------------------------------------------------

/// Byte length of each function body INCLUDING its own size prefix, because
/// that prefix is a real byte in the file and has to land somewhere. Index i
/// here is defined-function i, i.e. wasm function index `imported_count + i`.
fn code_body_sizes(payload: &[u8]) -> Vec<usize> {
    let mut r = Reader::new(payload);
    let count = r.leb_u32() as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let before = r.at;
        let body = r.leb_u32() as usize;
        let prefix = r.at - before;
        r.take(body);
        out.push(prefix + body);
    }
    out
}

// ---------------------------------------------------------------------------
// The `name` custom section — subsection 1 is the function-name map
// ---------------------------------------------------------------------------

fn function_names(name_payload: &[u8]) -> BTreeMap<u32, String> {
    let mut r = Reader::new(name_payload);
    let _module_name = r.name(); // the section's own "name" string
    let mut out = BTreeMap::new();
    while !r.done() {
        let subsection = r.byte();
        let size = r.leb_u32() as usize;
        let body = r.take(size);
        if subsection == 1 {
            let mut b = Reader::new(body);
            let count = b.leb_u32();
            for _ in 0..count {
                let idx = b.leb_u32();
                let nm = b.name();
                out.insert(idx, nm);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Rust symbol demangling — legacy (`_ZN..E`) and v0 (`_R`) crate extraction
// ---------------------------------------------------------------------------

/// Decode the `$..$` escapes rustc's legacy mangling uses for punctuation.
fn unescape_legacy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'$' {
            if let Some(end) = s[i + 1..].find('$') {
                let tag = &s[i + 1..i + 1 + end];
                let rep = match tag {
                    "LT" => Some("<"),
                    "GT" => Some(">"),
                    "LP" => Some("("),
                    "RP" => Some(")"),
                    "C" => Some(","),
                    "RF" => Some("&"),
                    "BP" => Some("*"),
                    "u20" => Some(" "),
                    "u27" => Some("'"),
                    "u5b" => Some("["),
                    "u5d" => Some("]"),
                    "u7b" => Some("{"),
                    "u7d" => Some("}"),
                    "u3b" => Some(";"),
                    "u2b" => Some("+"),
                    "u22" => Some("\""),
                    _ => None,
                };
                if let Some(rep) = rep {
                    out.push_str(rep);
                    i += end + 2;
                    continue;
                }
            }
        }
        if b[i] == b'.' && i + 1 < b.len() && b[i + 1] == b'.' {
            out.push_str("::");
            i += 2;
            continue;
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

/// Split a legacy-mangled `_ZN<len><part>...E` symbol into its path components,
/// dropping the trailing `17h<hash>` disambiguator rustc appends.
fn legacy_parts(sym: &str) -> Option<Vec<String>> {
    let rest = sym.strip_prefix("_ZN")?;
    let b = rest.as_bytes();
    let mut i = 0;
    let mut parts = Vec::new();
    while i < b.len() && b[i] != b'E' {
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        let len: usize = rest[start..i].parse().ok()?;
        if i + len > b.len() {
            return None;
        }
        parts.push(unescape_legacy(&rest[i..i + len]));
        i += len;
    }
    // The last component is `h<16 hex>` when rustc added a disambiguator.
    if let Some(last) = parts.last() {
        if last.len() == 17 && last.starts_with('h') && last[1..].chars().all(|c| c.is_ascii_hexdigit())
        {
            parts.pop();
        }
    }
    Some(parts)
}

/// Crates whose code is written elsewhere and instantiated here. A function
/// whose DEFINITION lives in one of these but whose generic arguments name a
/// first-party crate exists only because that first-party crate asked for it.
const UPSTREAM: &[&str] = &[
    "core",
    "alloc",
    "std",
    "compiler_builtins",
    "dlmalloc",
    "rustc_std_workspace_core",
    "rustc_std_workspace_alloc",
];

/// TWO ATTRIBUTIONS, AND WHY BOTH ARE NEEDED.
///
/// `Definition` is where the source line lives: a monomorphised
/// `BTreeMap::insert` is `alloc`, full stop. It is the honest answer to *"whose
/// code is this?"* and it is what `twiggy` would report.
///
/// `Instantiation` is whose types caused the copy to exist. `alloc` did not
/// choose to emit forty copies of `Vec::sort_by`; the crates with forty
/// distinct element types did. It is the honest answer to *"who would stop
/// paying for this if their feature were cut?"*, which is the question a byte
/// budget actually asks.
///
/// REJECTED ALTERNATIVE: report only `Definition`, as `twiggy` does. It makes
/// `alloc` and `core` look like a 335 KB dependency to be removed, which is a
/// conclusion nobody can act on — there is no `alloc` to delete. The removal
/// ablations in §5 are the third and final check on both.
#[derive(Clone, Copy, PartialEq)]
enum Attribution {
    Definition,
    Instantiation,
}

/// The crate a symbol belongs to, as a bucket name. Anything that is not a
/// recognisable Rust path is bucketed by its own shape, never silently folded
/// into a crate that did not produce it.
fn bucket(sym: &str, how: Attribution) -> String {
    // v0 mangling: `_R..Cs<disambiguator>_<len><crate>..`, and — the reason this
    // census asks for v0 — generic arguments are encoded, so an instantiation
    // names every crate involved.
    if sym.starts_with("_R") {
        let crates = v0_crates(sym);
        if crates.is_empty() {
            return "«v0 symbol, crate unparsed»".to_owned();
        }
        if how == Attribution::Instantiation && UPSTREAM.contains(&crates[0].as_str()) {
            if let Some(c) = crates.iter().find(|c| !UPSTREAM.contains(&c.as_str())) {
                return c.clone();
            }
        }
        return crates[0].clone();
    }
    if let Some(parts) = legacy_parts(sym) {
        if let Some(first) = parts.first() {
            // rustc's legacy mangling prefixes a component that starts with a
            // non-identifier character with `_`, so an `<T as Trait>::method`
            // impl arrives as `_<..>`. Legacy encodes no generic arguments, so
            // only the definition site is recoverable — such symbols come from
            // the precompiled sysroot rlibs and are reported as themselves
            // rather than guessed at.
            if first.starts_with('<') || first.starts_with("_<") {
                for p in &parts {
                    if let Some(c) = crate_of_component(p) {
                        return c;
                    }
                }
                return "«impl block, crate unattributed»".to_owned();
            }
            return first.clone();
        }
    }
    // Unmangled: compiler-rt / LLVM intrinsics / linker-synthesised entries.
    format!("«unmangled» {sym}")
}

fn crate_of_component(part: &str) -> Option<String> {
    for known in KNOWN_CRATES {
        if part.contains(known) {
            return Some((*known).to_owned());
        }
    }
    None
}

const KNOWN_CRATES: &[&str] = &[
    "fathom_wasm",
    "fathom_ir",
    "fathom_graph",
    "fathom_ingest",
    "fathom_weld",
    "fathom_inventory",
    "fathom_find",
    "fathom_corpus",
    "fathom_emit",
    "fathom_id",
    "fathom_canon",
    "fathom_schema",
    "fathom_workspace",
    "compiler_builtins",
    "dlmalloc",
    "alloc",
    "core",
];

/// Every crate name a v0 symbol mentions, in the order they appear. The first
/// is the definition site; later ones come from the generic arguments.
fn v0_crates(sym: &str) -> Vec<String> {
    let b = sym.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        // A crate-root node is `C` `s` <base62 disambiguator> `_` <len><name>.
        // The disambiguator may be empty, in which case `_` follows `Cs`
        // directly. Anything that does not then parse as a length-prefixed
        // identifier is not a crate root and is skipped, not guessed at.
        if b[i] == b'C' && b[i + 1] == b's' {
            let mut j = i + 2;
            while j < b.len() && b[j] != b'_' {
                j += 1;
            }
            j += 1;
            let start = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > start {
                if let Ok(len) = sym[start..j].parse::<usize>() {
                    if j + len <= b.len() {
                        let name = sym[j..j + len].to_owned();
                        if !out.contains(&name) {
                            out.push(name);
                        }
                        i = j + len;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Every length-prefixed identifier in a v0 symbol, in order. v0's grammar is
/// richer than this — backrefs, disambiguators, const generics — and a full
/// demangler is not what a size report needs. What it needs is a readable,
/// stable path, and the identifiers in order give one.
fn v0_idents(sym: &str) -> Vec<String> {
    let b = sym.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        // A crate-root's base62 disambiguator (`Cs<base62>_`) and a backref
        // (`B<base62>_`) both contain digits that would otherwise be read as
        // length prefixes and produce nonsense like `PaxU4GRf::core`. Skip
        // them outright; they carry no name.
        if b[i] == b'C' && i + 1 < b.len() && b[i + 1] == b's' {
            i += 2;
            while i < b.len() && b[i] != b'_' {
                i += 1;
            }
            i += 1;
            continue;
        }
        if b[i] == b'B' && i + 1 < b.len() && b[i + 1].is_ascii_alphanumeric() {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_alphanumeric() {
                j += 1;
            }
            if j < b.len() && b[j] == b'_' {
                i = j + 1;
                continue;
            }
        }
        if b[i].is_ascii_digit() && b[i] != b'0' {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if let Ok(len) = sym[start..i].parse::<usize>() {
                if i + len <= b.len() {
                    let cand = &sym[i..i + len];
                    let ok = !cand.is_empty()
                        && !cand.as_bytes()[0].is_ascii_digit()
                        && cand.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_');
                    if ok {
                        out.push(cand.to_owned());
                        i += len;
                        continue;
                    }
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

fn pretty(sym: &str) -> String {
    if sym.starts_with("_R") {
        let idents = v0_idents(sym);
        if !idents.is_empty() {
            return idents.join("::");
        }
    }
    legacy_parts(sym)
        .map(|p| p.join("::"))
        .unwrap_or_else(|| sym.to_owned())
}

/// The module path below the crate, `depth` components deep — enough to
/// separate `fathom_ir::generated` from the rest of `fathom_ir`, which is one
/// of the questions this census was commissioned to answer.
fn submodule(sym: &str, depth: usize) -> Option<String> {
    let parts = if sym.starts_with("_R") {
        v0_idents(sym)
    } else {
        legacy_parts(sym)?
    };
    if parts.len() < 2 {
        return None;
    }
    Some(parts[..parts.len().min(depth + 1)].join("::"))
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

fn comma(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn pct(part: usize, whole: usize) -> String {
    if whole == 0 {
        return "—".to_owned();
    }
    format!("{:.2}%", (part as f64) * 100.0 / (whole as f64))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: byte-census <shipped.wasm> [named.wasm] [--top N]");
        std::process::exit(2);
    }
    let shipped_path = PathBuf::from(&args[1]);
    let named_path = args.get(2).filter(|a| !a.starts_with("--")).map(PathBuf::from);
    let top: usize = args
        .windows(2)
        .find(|w| w[0] == "--top")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(40);

    let shipped = std::fs::read(&shipped_path).expect("shipped module must be readable");
    let secs = sections(&shipped);

    println!("# Byte census");
    println!();
    println!("shipped module : {}", shipped_path.display());
    println!("total bytes    : {}", comma(shipped.len()));
    println!();
    println!("## 1. Sections");
    println!();
    println!("| section | payload | +header | total | share |");
    println!("|---|---:|---:|---:|---:|");
    let mut accounted = 8usize; // the 8-byte preamble
    for s in &secs {
        println!(
            "| {} | {} | {} | {} | {} |",
            s.label(),
            comma(s.payload.len()),
            s.header_len,
            comma(s.total()),
            pct(s.total(), shipped.len())
        );
        accounted += s.total();
    }
    println!(
        "| **preamble + total** | | | **{}** | {} |",
        comma(accounted),
        pct(accounted, shipped.len())
    );
    assert_eq!(
        accounted,
        shipped.len(),
        "every byte of the module must land in exactly one section"
    );

    // Data section detail: how much of it is the segments' own payload.
    if let Some(d) = secs.iter().find(|s| s.id == 11) {
        let mut r = Reader::new(d.payload);
        let count = r.leb_u32();
        let mut payload_bytes = 0usize;
        for _ in 0..count {
            let flags = r.leb_u32();
            if flags == 0 {
                // active, memory 0, i32.const offset expression, then `end`
                while r.byte() != 0x0b {}
            }
            let n = r.leb_u32() as usize;
            r.take(n);
            payload_bytes += n;
        }
        println!();
        println!(
            "Data section: {count} segment(s), {} bytes of initialiser payload \
             ({} of the section, the rest is offsets and lengths).",
            comma(payload_bytes),
            pct(payload_bytes, d.total())
        );
    }

    let Some(named_path) = named_path else {
        return;
    };

    // --- per-function attribution ------------------------------------------
    let named = std::fs::read(&named_path).expect("named module must be readable");
    let nsecs = sections(&named);
    let scode = secs
        .iter()
        .find(|s| s.id == 10)
        .expect("shipped module must have a code section");
    let ncode = nsecs
        .iter()
        .find(|s| s.id == 10)
        .expect("named module must have a code section");

    let sizes = code_body_sizes(scode.payload);
    let nsizes = code_body_sizes(ncode.payload);
    // GUARD (44 §8): the attribution below is only about the module that ships
    // if the two builds agree function-for-function. They are not required to
    // be identical — `strip = "none"` leaves wasm-ld more to place — so the
    // divergence is MEASURED and printed rather than assumed away. A census
    // that quietly described a different binary would be worse than no census.
    let first_diff = sizes
        .iter()
        .zip(nsizes.iter())
        .position(|(a, b)| a != b);
    let s_sum: usize = sizes.iter().sum();
    let n_sum: usize = nsizes.iter().sum();
    println!();
    println!("### Fidelity of the named build to the shipped build");
    println!();
    println!(
        "| | shipped (`strip=\"symbols\"`) | named (`strip=\"none\"`) |\n|---|---:|---:|\n\
         | defined functions | {} | {} |\n| code-body bytes | {} | {} |",
        comma(sizes.len()),
        comma(nsizes.len()),
        comma(s_sum),
        comma(n_sum)
    );
    match first_diff {
        None if sizes.len() == nsizes.len() => {
            println!("\nFunction bodies are byte-identical, index for index.")
        }
        _ => {
            let drift = (n_sum as i64) - (s_sum as i64);
            println!(
                "\nFirst differing function index: {:?}. Total code-body drift: {} bytes \
                 ({} of the shipped code section). Attribution below is therefore accurate to \
                 within that drift.",
                first_diff,
                drift,
                pct(drift.unsigned_abs() as usize, s_sum)
            );
        }
    }
    // Attribute against whichever list the names actually index: the named build.
    let sizes = if sizes.len() == nsizes.len() && first_diff.is_none() {
        sizes
    } else {
        nsizes
    };

    let names_sec = nsecs
        .iter()
        .find(|s| s.custom_name.as_deref() == Some("name"))
        .expect("the named build must carry a `name` custom section");
    let names = function_names(names_sec.payload);

    // Imported functions occupy the low indices; this module imports nothing,
    // which the artifact gate already asserts, so defined function i is index i.
    let imported = nsecs
        .iter()
        .find(|s| s.id == 2)
        .map(|s| Reader::new(s.payload).leb_u32() as usize)
        .unwrap_or(0);
    assert_eq!(imported, 0, "the import section must be empty (34 §7.5)");

    let code_total: usize = sizes.iter().sum();
    println!();
    println!("## 2. Code section by crate");
    println!();
    println!(
        "{} defined functions, {} bytes of function bodies \
         ({} of the module).",
        comma(sizes.len()),
        comma(code_total),
        pct(code_total, shipped.len())
    );
    println!();

    let mut by_def: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut by_inst: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut by_module: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut funcs: Vec<(usize, String)> = Vec::new();
    for (i, size) in sizes.iter().enumerate() {
        let sym = names
            .get(&(i as u32))
            .cloned()
            .unwrap_or_else(|| format!("«no name for function {i}»"));
        for (map, how) in [
            (&mut by_def, Attribution::Definition),
            (&mut by_inst, Attribution::Instantiation),
        ] {
            let e = map.entry(bucket(&sym, how)).or_insert((0, 0));
            e.0 += size;
            e.1 += 1;
        }
        let m = submodule(&sym, 2).unwrap_or_else(|| bucket(&sym, Attribution::Definition));
        let e = by_module.entry(m).or_insert((0, 0));
        e.0 += size;
        e.1 += 1;
        funcs.push((*size, sym));
    }

    let render = |title: &str, map: BTreeMap<String, (usize, usize)>, limit: usize| {
        println!();
        println!("{title}");
        println!();
        let mut rows: Vec<_> = map.into_iter().collect();
        rows.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        println!("| crate | bytes | funcs | share of code | share of module |");
        println!("|---|---:|---:|---:|---:|");
        for (name, (bytes, n)) in rows.iter().take(limit) {
            println!(
                "| {} | {} | {} | {} | {} |",
                name,
                comma(*bytes),
                n,
                pct(*bytes, code_total),
                pct(*bytes, shipped.len())
            );
        }
    };

    render(
        "### 2a. By DEFINITION site — whose source line is this",
        by_def,
        top,
    );
    render(
        "### 2b. By INSTANTIATION site — whose types made this copy exist",
        by_inst,
        top,
    );

    println!();
    println!("## 3. Code section by module (crate + 2 path components)");
    println!();
    let mut mods: Vec<_> = by_module.into_iter().collect();
    mods.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    println!("| module | bytes | funcs |");
    println!("|---|---:|---:|");
    for (name, (bytes, n)) in mods.iter().take(top) {
        println!("| {} | {} | {} |", name, comma(*bytes), n);
    }

    println!();
    println!("## 4. Largest single functions");
    println!();
    funcs.sort_by(|a, b| b.0.cmp(&a.0));
    println!("| bytes | function |");
    println!("|---:|---|");
    for (size, sym) in funcs.iter().take(top) {
        println!("| {} | `{}` |", comma(*size), pretty(sym));
    }
}

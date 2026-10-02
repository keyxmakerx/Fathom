//! fex over a test double: the compiler's refusals, the VM's bounds, determinism, and a
//! seeded fuzz of the lexer, parser, checker and VM. None of these needs an estate.

use std::collections::BTreeMap;

use fathom_rules::compile::{compile, Builtin, Mode, Op, Program, OPCODE_COUNT};
use fathom_rules::lex::MAX_SOURCE;
use fathom_rules::parse::parse;
use fathom_rules::schema::{EdgeInfo, FieldInfo, Schema, World};
use fathom_rules::value::{EdgeId, Elem, EnumId, Field, FieldId, KindId, Scalar, Ty, Val};
use fathom_rules::vm::{run, EvalError, STEP_BUDGET};

struct S;
const N: KindId = KindId(0);

impl Schema for S {
    fn kind(&self, n: &str) -> Option<KindId> {
        (n == "N").then_some(N)
    }
    fn kind_name(&self, _: KindId) -> String {
        "N".into()
    }
    fn node_field(&self, _: KindId, name: &str) -> Option<FieldInfo> {
        let (id, ty) = match name {
            "n" => (1, Ty::Int),
            "s" => (2, Ty::Str),
            "b" => (3, Ty::Bool),
            "o" => (4, Ty::Opaque),
            "sec" => (5, Ty::Secret),
            "e" => (6, Ty::Enum(EnumId(0))),
            "ip" => (7, Ty::Iface),
            _ => return None,
        };
        Some(FieldInfo {
            id: FieldId(id),
            ty,
        })
    }
    fn edge(&self, _: &str) -> Option<EdgeInfo> {
        None
    }
    fn edge_field(&self, _: EdgeId, _: &str) -> Option<FieldInfo> {
        None
    }
    fn enum_tokens(&self, _: EnumId) -> Option<Vec<String>> {
        Some(vec!["red".into(), "green".into()])
    }
}

struct W {
    fields: BTreeMap<(u32, u32), Field>,
}
impl World for W {
    type Node = u32;
    type Edge = ();
    fn nodes(&self, _: KindId, out: &mut Vec<u32>) {
        out.push(0);
    }
    fn hop(&self, _: u32, _: EdgeId, _: bool, _: &mut Vec<(u32, ())>) {}
    fn field(&self, n: u32, f: FieldId) -> Field {
        self.fields.get(&(n, f.0)).cloned().unwrap_or(Field::Unset)
    }
    fn edge_field(&self, _: (), _: FieldId) -> Field {
        Field::Unset
    }
    fn kind_of(&self, _: u32) -> KindId {
        N
    }
}

fn world() -> W {
    let mut fields = BTreeMap::new();
    fields.insert((0, 1), Field::Set(Scalar::Int(7)));
    fields.insert((0, 2), Field::Set(Scalar::Str("abc".into())));
    fields.insert((0, 6), Field::Set(Scalar::Str("red".into())));
    fields.insert(
        (0, 7),
        Field::Set(Scalar::Iface(
            fathom_rules::value::parse_ip("192.168.1.255").unwrap(),
            24,
        )),
    );
    fields.insert((0, 4), Field::Set(Scalar::Present));
    fields.insert((0, 3), Field::Absent);
    W { fields }
}

fn eval(src: &str) -> Result<Val<u32>, String> {
    let (p, _) = compile(src, &S, N, &[]).map_err(|e| e.msg)?;
    run(&p, &world(), vec![Val::Node(0)], STEP_BUDGET)
        .map(|o| o.value)
        .map_err(|e| e.text().to_owned())
}

#[test]
fn arithmetic_and_logic() {
    assert_eq!(eval("n + 1 == 8 && !(n < 3)"), Ok(Val::Bool(true)));
    assert_eq!(eval("n > 3 ? \"big\" == s : false"), Ok(Val::Bool(false)));
    assert_eq!(eval("e in [\"red\", \"green\"]"), Ok(Val::Bool(true)));
    assert_eq!(eval("enum_is(e, \"green\")"), Ok(Val::Bool(false)));
    assert_eq!(
        eval("is_broadcast_address(ip) && !is_network_address(ip)"),
        Ok(Val::Bool(true))
    );
    assert_eq!(
        eval("has(o) && !has(b) && known_absent(b) && !is_known(s) == false"),
        Ok(Val::Bool(true))
    );
    // An absent field is not ordered either way.
    assert_eq!(eval("b == null"), Ok(Val::Bool(true)));
}

#[test]
fn the_checker_refuses_what_would_never_fire() {
    for (src, why) in [
        ("n == \"7\"", "cannot compare"),
        ("e == \"red\"", "enum_is"),
        ("enum_is(e, \"blue\")", "not a declared token"),
        ("e in [\"blue\"]", "not a declared token"),
        ("o", "has(..)"),
        ("has(sec)", "secret"),
        ("sec == \"x\"", "secret"),
        ("nope", "no field"),
        ("n.x", "needs a node"),
        ("n < \"a\"", "ints only"),
        ("len(n) > 1", "list or a string"),
        ("true && 1", "bool"),
        ("foo(1)", "not a fex function"),
        ("n[0]", "unexpected"),
    ] {
        let e = compile(src, &S, N, &[])
            .err()
            .unwrap_or_else(|| panic!("`{src}` compiled"));
        assert!(e.msg.contains(why), "`{src}`: {}", e.msg);
    }
}

#[test]
fn read_sets_are_total() {
    let (_, r) = compile(
        "n > 1 && has(o) && enum_is(e, \"red\") && is_network_address(ip)",
        &S,
        N,
        &[],
    )
    .unwrap();
    let ids: Vec<u32> = r.fields.iter().map(|(_, f)| f.0).collect();
    assert_eq!(ids, vec![1, 4, 6, 7]);
    // A field behind a short-circuit is still in the set: over-approximate, never under.
    let (_, r) = compile("false && n > 1", &S, N, &[]).unwrap();
    assert_eq!(r.fields.len(), 1);
}

#[test]
fn limits_hold() {
    assert!(parse(&"(".repeat(100)).is_err());
    assert!(parse(&format!("n{}", " ".repeat(MAX_SOURCE))).is_err());
    let deep = format!("{}1{}", "-".repeat(500), "");
    assert!(parse(&deep).is_err());
    let toks = vec!["1"; 1100].join(" + ");
    assert!(parse(&toks).is_err());
    assert_eq!(OPCODE_COUNT, 28);
    let (p, _) = compile("true", &S, N, &[]).unwrap();
    assert!(p.code.len() < 4);
}

fn prog(code: Vec<Op>, nslots: usize) -> Program {
    Program {
        code,
        consts: Vec::new(),
        nslots,
        result: Ty::Bool,
    }
}

#[test]
fn a_loop_cannot_outrun_the_budget() {
    // Hand-built: Jmp 0 forever. The VM, not the compiler, is the last line.
    let p = prog(vec![Op::Jmp(0)], 1);
    assert_eq!(
        run(&p, &world(), vec![], 100).err(),
        Some(EvalError::Budget)
    );
    // A stack that only grows.
    let p = prog(vec![Op::Load(0), Op::Jmp(0)], 1);
    assert!(matches!(
        run(&p, &world(), vec![Val::Null], 1_000_000).err(),
        Some(EvalError::StackOverflow)
    ));
}

#[test]
fn integer_overflow_is_an_error_not_a_wrap() {
    assert_eq!(
        eval("9223372036854775807 + 1 > 0"),
        Err("overflowed an integer".into())
    );
    assert_eq!(
        eval("-9223372036854775807 - 2 < 0"),
        Err("overflowed an integer".into())
    );
}

#[test]
fn evaluation_is_deterministic() {
    let a = eval("e in [\"red\"] && n >= 7");
    for _ in 0..50 {
        assert_eq!(eval("e in [\"red\"] && n >= 7"), a);
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

#[test]
fn fuzz_the_front_end_never_panics() {
    let toks = [
        "n",
        "s",
        "e",
        "o",
        "ip",
        "b",
        "self",
        "has(",
        "enum_is(",
        "len(",
        "(",
        ")",
        "[",
        "]",
        ",",
        ".",
        "?",
        ":",
        "!",
        "-",
        "+",
        "==",
        "!=",
        "<",
        ">=",
        "&&",
        "||",
        "in",
        "1",
        "9999999999999999999",
        "\"x\"",
        "\"",
        "\\",
        "10.0.0.1",
        "10.0.0.0/8",
        "300.1.1.1",
        "::",
        "true",
        "null",
        "exists(",
        "x",
        "all(",
        "filter(",
        "count(",
        "é",
        "\u{0}",
    ];
    let mut r = Rng(0x9e3779b97f4a7c15);
    for _ in 0..20_000 {
        let n = 1 + r.below(24);
        let src: String = (0..n)
            .map(|_| toks[r.below(toks.len())])
            .collect::<Vec<_>>()
            .join(if r.below(2) == 0 { " " } else { "" });
        let _ = parse(&src);
        if let Ok((p, _)) = compile(&src, &S, N, &[]) {
            let _ = run(&p, &world(), vec![Val::Node(0)], STEP_BUDGET);
        }
    }
}

#[test]
fn fuzz_the_vm_with_arbitrary_programs() {
    let mut r = Rng(0xdeadbeefcafef00d);
    for _ in 0..20_000 {
        let n = 1 + r.below(16);
        let code: Vec<Op> = (0..n)
            .map(|_| match r.below(24) {
                0 => Op::PushConst(r.below(4) as u16),
                1 => Op::Load(r.below(4) as u8),
                2 => Op::LoadField(FieldId(r.below(8) as u32)),
                3 => Op::Has(FieldId(r.below(8) as u32)),
                4 => Op::Eq,
                5 => Op::Lt,
                6 => Op::InList,
                7 => Op::AndSc(r.below(20) as u16),
                8 => Op::OrSc(r.below(20) as u16),
                9 => Op::Not,
                10 => Op::Jmp(r.below(20) as u16),
                11 => Op::JmpIfFalse(r.below(20) as u16),
                12 => Op::Add,
                13 => Op::Neg,
                14 => Op::Call(
                    [
                        Builtin::Len,
                        Builtin::Contains,
                        Builtin::Overlaps,
                        Builtin::NetOf,
                        Builtin::IsNetworkAddress,
                    ][r.below(5)],
                ),
                15 => Op::MkList(r.below(5) as u8),
                16 => {
                    Op::IterInit([Mode::Exists, Mode::All, Mode::Count, Mode::Filter][r.below(4)])
                }
                17 => Op::IterNext(r.below(4) as u8, r.below(20) as u16),
                18 => Op::IterAcc([Mode::Exists, Mode::Filter][r.below(2)]),
                19 => Op::IterEnd,
                20 => Op::Ret,
                21 => Op::Sub,
                22 => Op::KnownAbsent(FieldId(r.below(8) as u32)),
                _ => Op::Ne,
            })
            .collect();
        let consts = vec![
            fathom_rules::compile::Cst::Int(i64::MAX),
            fathom_rules::compile::Cst::Null,
            fathom_rules::compile::Cst::Str("x".into()),
            fathom_rules::compile::Cst::Prefix(
                fathom_rules::value::parse_ip("10.0.0.0").unwrap(),
                8,
            ),
        ];
        let p = Program {
            code,
            consts,
            nslots: 4,
            result: Ty::List(Elem::Int),
        };
        let _ = run(&p, &world(), vec![Val::Node(0)], 500);
    }
}

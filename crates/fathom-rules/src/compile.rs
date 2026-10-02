//! fex's checker and compiler in one pass: source text → typed bytecode, plus the
//! static read set.
//!
//! **The read set is total by construction** (12 §5.3). Every field a program can read is
//! named by a literal in its source, on an object whose kind the checker knows, so the
//! set is collected as the checker walks and there is no dynamic case.

use std::collections::BTreeSet;
use std::rc::Rc;

use crate::lex::{err, Error};
use crate::parse::{parse, BinOp, Expr, ExprKind};
use crate::schema::{FieldInfo, Schema};
use crate::value::{Elem, EnumId, FieldId, Ip, KindId, Ty};

pub const MAX_CODE: usize = 2048;
pub const MAX_ITER_DEPTH: usize = 3;

/// The 28 opcodes (12 §3.8). One opcode is one step; `Call` charges its builtin's cost.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    PushConst(u16),
    /// Push slot `n` (slot 0 is the anchor).
    Load(u8),
    /// Pop a node, push its field (`Null` for a null node).
    LoadField(FieldId),
    Has(FieldId),
    KnownAbsent(FieldId),
    IsKnown(FieldId),
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    InList,
    /// Short-circuit `&&`: false on top → jump, keeping it; true → pop and fall through.
    AndSc(u16),
    OrSc(u16),
    Not,
    Jmp(u16),
    JmpIfFalse(u16),
    Add,
    Sub,
    Neg,
    Call(Builtin),
    MkList(u8),
    /// Pop a list, open an iteration frame of this mode.
    IterInit(Mode),
    /// Next element into the slot, or jump to the end.
    IterNext(u8, u16),
    /// Pop the body's bool and fold it into the frame.
    IterAcc(Mode),
    IterEnd,
    Ret,
}

pub const OPCODE_COUNT: usize = 28;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Exists,
    All,
    Count,
    Filter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Builtin {
    Len,
    Contains,
    Overlaps,
    IsSubnetOf,
    PrefixLen,
    AddrOf,
    NetOf,
    IsNetworkAddress,
    IsBroadcastAddress,
}

impl Builtin {
    /// Step cost beyond the opcode's own.
    pub fn cost(self) -> u32 {
        1
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cst {
    Null,
    Bool(bool),
    Int(i64),
    Str(Rc<str>),
    Addr(Ip),
    Prefix(Ip, u8),
}

#[derive(Debug, Clone)]
pub struct Program {
    pub code: Vec<Op>,
    pub consts: Vec<Cst>,
    /// Slots the VM must provide: anchor, selector bindings, comprehension variables.
    pub nslots: usize,
    pub result: Ty,
}

/// Whose field it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Owner {
    Node(KindId),
    Edge(crate::value::EdgeId),
}

/// Everything a rule can read, known without running it (12 §5.1). The incremental
/// engine re-evaluates a rule only when a change touches this.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadSet {
    pub fields: BTreeSet<(Owner, FieldId)>,
    /// Edge roles traversed, with direction.
    pub adjacency: BTreeSet<(crate::value::EdgeId, bool)>,
    /// Node kinds whose population matters: the anchor and everything it walks over.
    pub kinds: BTreeSet<KindId>,
}

impl ReadSet {
    pub fn extend(&mut self, other: &ReadSet) {
        self.fields.extend(other.fields.iter().copied());
        self.adjacency.extend(other.adjacency.iter().copied());
        self.kinds.extend(other.kinds.iter().copied());
    }
}

pub fn ty_of_elem(e: Elem) -> Ty {
    match e {
        Elem::Int => Ty::Int,
        Elem::Str => Ty::Str,
        Elem::Enum(x) => Ty::Enum(x),
        Elem::Addr => Ty::Addr,
        Elem::Node(k) => Ty::Node(k),
    }
}

fn elem_of(t: Ty) -> Option<Elem> {
    Some(match t {
        Ty::Int => Elem::Int,
        Ty::Str => Elem::Str,
        Ty::Enum(x) => Elem::Enum(x),
        Ty::Addr => Elem::Addr,
        Ty::Node(k) => Elem::Node(k),
        _ => return None,
    })
}

pub fn describe(t: Ty, s: &dyn Schema) -> String {
    match t {
        Ty::Null => "null".into(),
        Ty::Bool => "bool".into(),
        Ty::Int => "int".into(),
        Ty::Str => "string".into(),
        Ty::Enum(_) => "an enum".into(),
        Ty::Addr => "address".into(),
        Ty::Prefix => "prefix".into(),
        Ty::Iface => "interface address".into(),
        Ty::Node(k) => format!("a {}", s.kind_name(k)),
        Ty::List(e) => format!("a list of {}", describe(ty_of_elem(e), s)),
        Ty::Opaque => "a structured value".into(),
        Ty::Secret => "a secret".into(),
    }
}

/// Compile `src` for an anchor of kind `anchor`, with the selector's bindings in scope.
/// `binds[i]` is slot `i + 1`; slot 0 is the anchor.
pub fn compile(
    src: &str,
    schema: &dyn Schema,
    anchor: KindId,
    binds: &[(String, Ty)],
) -> Result<(Program, ReadSet), Error> {
    let ast = parse(src)?;
    let mut vars = vec![("self".to_owned(), Ty::Node(anchor))];
    vars.extend(binds.iter().cloned());
    let mut c = C {
        s: schema,
        anchor,
        vars,
        code: Vec::new(),
        consts: Vec::new(),
        reads: ReadSet::default(),
        nslots: 0,
        iter_depth: 0,
    };
    c.nslots = c.vars.len();
    let result = c.expr(&ast)?;
    c.emit(Op::Ret, ast.pos)?;
    if c.nslots > 250 {
        return Err(err(0, "too many bindings"));
    }
    Ok((
        Program {
            code: c.code,
            consts: c.consts,
            nslots: c.nslots,
            result,
        },
        c.reads,
    ))
}

struct C<'a> {
    s: &'a dyn Schema,
    anchor: KindId,
    vars: Vec<(String, Ty)>,
    code: Vec<Op>,
    consts: Vec<Cst>,
    reads: ReadSet,
    nslots: usize,
    iter_depth: usize,
}

impl C<'_> {
    fn emit(&mut self, op: Op, pos: usize) -> Result<usize, Error> {
        if self.code.len() >= MAX_CODE {
            return Err(err(
                pos,
                format!("compiles to more than {MAX_CODE} instructions"),
            ));
        }
        self.code.push(op);
        Ok(self.code.len() - 1)
    }

    fn here(&self, pos: usize) -> Result<u16, Error> {
        u16::try_from(self.code.len()).map_err(|_| err(pos, "program too long"))
    }

    fn patch(&mut self, at: usize, to: u16) {
        if let Some(op) = self.code.get_mut(at) {
            *op = match *op {
                Op::AndSc(_) => Op::AndSc(to),
                Op::OrSc(_) => Op::OrSc(to),
                Op::Jmp(_) => Op::Jmp(to),
                Op::JmpIfFalse(_) => Op::JmpIfFalse(to),
                Op::IterNext(s, _) => Op::IterNext(s, to),
                other => other,
            };
        }
    }

    fn konst(&mut self, c: Cst, pos: usize) -> Result<(), Error> {
        let at = self
            .consts
            .iter()
            .position(|x| *x == c)
            .unwrap_or(self.consts.len());
        if at == self.consts.len() {
            self.consts.push(c);
        }
        let k = u16::try_from(at).map_err(|_| err(pos, "too many constants"))?;
        self.emit(Op::PushConst(k), pos)?;
        Ok(())
    }

    fn expect(&self, got: Ty, want: Ty, pos: usize, what: &str) -> Result<(), Error> {
        if got == want {
            Ok(())
        } else {
            Err(err(
                pos,
                format!(
                    "{what} must be {}, not {}",
                    describe(want, self.s),
                    describe(got, self.s)
                ),
            ))
        }
    }

    /// Compile the object half of a field reference and resolve the field, without
    /// emitting the read. Records the read.
    fn field_ref(&mut self, e: &Expr) -> Result<(KindId, FieldInfo), Error> {
        let (obj_ty, name, pos) = match &e.kind {
            ExprKind::Field(obj, name) => (self.expr(obj)?, name.as_str(), e.pos),
            ExprKind::Ident(name) if self.lookup(name).is_none() => {
                self.emit(Op::Load(0), e.pos)?;
                (Ty::Node(self.anchor), name.as_str(), e.pos)
            }
            _ => {
                return Err(err(
                    e.pos,
                    "expected a field, like `connector` or `port.speed`",
                ))
            }
        };
        let Ty::Node(k) = obj_ty else {
            return Err(err(
                pos,
                format!(
                    "`.{name}` needs a node on its left, not {}",
                    describe(obj_ty, self.s)
                ),
            ));
        };
        let info = self.s.node_field(k, name).ok_or_else(|| {
            err(
                pos,
                format!("{} has no field `{name}`", self.s.kind_name(k)),
            )
        })?;
        if info.ty == Ty::Secret {
            return Err(err(
                pos,
                format!("`{name}` is a secret; a rule may not read it, even to ask if it is set"),
            ));
        }
        self.reads.fields.insert((Owner::Node(k), info.id));
        Ok((k, info))
    }

    fn lookup(&self, name: &str) -> Option<usize> {
        self.vars.iter().rposition(|(n, _)| n == name)
    }

    fn expr(&mut self, e: &Expr) -> Result<Ty, Error> {
        let pos = e.pos;
        match &e.kind {
            ExprKind::Int(i) => {
                self.konst(Cst::Int(*i), pos)?;
                Ok(Ty::Int)
            }
            ExprKind::Str(s) => {
                self.konst(Cst::Str(Rc::from(s.as_str())), pos)?;
                Ok(Ty::Str)
            }
            ExprKind::Bool(b) => {
                self.konst(Cst::Bool(*b), pos)?;
                Ok(Ty::Bool)
            }
            ExprKind::Null => {
                self.konst(Cst::Null, pos)?;
                Ok(Ty::Null)
            }
            ExprKind::Addr(a) => {
                self.konst(Cst::Addr(*a), pos)?;
                Ok(Ty::Addr)
            }
            ExprKind::Prefix(a, l) => {
                self.konst(Cst::Prefix(*a, *l), pos)?;
                Ok(Ty::Prefix)
            }
            ExprKind::Ident(name) => {
                if let Some(slot) = self.lookup(name) {
                    let ty = self.vars[slot].1;
                    let slot = u8::try_from(slot).map_err(|_| err(pos, "too many bindings"))?;
                    self.emit(Op::Load(slot), pos)?;
                    return Ok(ty);
                }
                let (_, info) = self.field_ref(e)?;
                self.load_field(info, pos)
            }
            ExprKind::Field(..) => {
                let (_, info) = self.field_ref(e)?;
                self.load_field(info, pos)
            }
            ExprKind::Not(x) => {
                let t = self.expr(x)?;
                self.expect(t, Ty::Bool, x.pos, "`!`'s operand")?;
                self.emit(Op::Not, pos)?;
                Ok(Ty::Bool)
            }
            ExprKind::Neg(x) => {
                let t = self.expr(x)?;
                self.expect(t, Ty::Int, x.pos, "`-`'s operand")?;
                self.emit(Op::Neg, pos)?;
                Ok(Ty::Int)
            }
            ExprKind::Bin(op, l, r) => self.bin(*op, l, r, pos),
            ExprKind::Ternary(c, a, b) => {
                let t = self.expr(c)?;
                self.expect(t, Ty::Bool, c.pos, "the condition of `?:`")?;
                let jf = self.emit(Op::JmpIfFalse(0), pos)?;
                let ta = self.expr(a)?;
                let j = self.emit(Op::Jmp(0), pos)?;
                let h = self.here(pos)?;
                self.patch(jf, h);
                let tb = self.expr(b)?;
                if ta != tb {
                    return Err(err(pos, "both arms of `?:` must have the same type"));
                }
                let h = self.here(pos)?;
                self.patch(j, h);
                Ok(ta)
            }
            ExprKind::List(items) => {
                let mut elem: Option<Ty> = None;
                for it in items {
                    let t = self.expr(it)?;
                    if elem_of(t).is_none() || matches!(t, Ty::Node(_)) {
                        return Err(err(
                            it.pos,
                            "a list literal holds ints, strings or addresses",
                        ));
                    }
                    if elem.is_some_and(|x| x != t) {
                        return Err(err(it.pos, "a list literal's elements must share a type"));
                    }
                    elem = Some(t);
                }
                let n = u8::try_from(items.len()).map_err(|_| err(pos, "list too long"))?;
                self.emit(Op::MkList(n), pos)?;
                Ok(Ty::List(elem.and_then(elem_of).unwrap_or(Elem::Str)))
            }
            ExprKind::Call(name, args) => self.call(name, args, pos),
            ExprKind::Method(obj, name, args) => self.method(obj, name, args, pos),
        }
    }

    fn load_field(&mut self, info: FieldInfo, pos: usize) -> Result<Ty, Error> {
        if info.ty == Ty::Opaque {
            return Err(err(
                pos,
                "this field has no value a rule can read; ask `has(..)` or `known_absent(..)`",
            ));
        }
        self.emit(Op::LoadField(info.id), pos)?;
        Ok(info.ty)
    }

    fn bin(&mut self, op: BinOp, l: &Expr, r: &Expr, pos: usize) -> Result<Ty, Error> {
        match op {
            BinOp::And | BinOp::Or => {
                let t = self.expr(l)?;
                self.expect(t, Ty::Bool, l.pos, "an operand of `&&`/`||`")?;
                let sc = self.emit(
                    if op == BinOp::And {
                        Op::AndSc(0)
                    } else {
                        Op::OrSc(0)
                    },
                    pos,
                )?;
                let t = self.expr(r)?;
                self.expect(t, Ty::Bool, r.pos, "an operand of `&&`/`||`")?;
                let h = self.here(pos)?;
                self.patch(sc, h);
                Ok(Ty::Bool)
            }
            BinOp::In => self.in_op(l, r, pos),
            BinOp::Eq | BinOp::Ne => {
                let a = self.expr(l)?;
                let b = self.expr(r)?;
                let ok = match (a, b) {
                    (Ty::Null, Ty::Null) => false,
                    (Ty::Null, x) | (x, Ty::Null) => {
                        !matches!(x, Ty::Opaque | Ty::List(_)) || x == Ty::Null
                    }
                    (Ty::Enum(_), Ty::Str) | (Ty::Str, Ty::Enum(_)) => {
                        return Err(err(
                            pos,
                            "compare an enum with `enum_is(field, \"token\")` or `field in [\"a\", \"b\"]`, not `==`",
                        ))
                    }
                    (Ty::List(_), _) | (_, Ty::List(_)) => false,
                    (x, y) => x == y,
                };
                if !ok {
                    return Err(err(
                        pos,
                        format!(
                            "cannot compare {} with {}",
                            describe(a, self.s),
                            describe(b, self.s)
                        ),
                    ));
                }
                self.emit(if op == BinOp::Eq { Op::Eq } else { Op::Ne }, pos)?;
                Ok(Ty::Bool)
            }
            BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
                let a = self.expr(l)?;
                let b = self.expr(r)?;
                if a != Ty::Int || b != Ty::Int {
                    return Err(err(pos, "`<`, `<=`, `>` and `>=` compare ints only"));
                }
                self.emit(
                    match op {
                        BinOp::Lt => Op::Lt,
                        BinOp::Le => Op::Le,
                        BinOp::Gt => Op::Gt,
                        _ => Op::Ge,
                    },
                    pos,
                )?;
                Ok(Ty::Bool)
            }
            BinOp::Add | BinOp::Sub => {
                let a = self.expr(l)?;
                let b = self.expr(r)?;
                if a != Ty::Int || b != Ty::Int {
                    return Err(err(pos, "`+` and `-` take ints"));
                }
                self.emit(if op == BinOp::Add { Op::Add } else { Op::Sub }, pos)?;
                Ok(Ty::Int)
            }
        }
    }

    fn in_op(&mut self, l: &Expr, r: &Expr, pos: usize) -> Result<Ty, Error> {
        let a = self.expr(l)?;
        if let (Ty::Enum(e), ExprKind::List(items)) = (a, &r.kind) {
            self.check_tokens(e, items)?;
        }
        let b = match (a, &r.kind) {
            (Ty::Enum(e), ExprKind::List(items)) => {
                for it in items {
                    self.expr(it)?;
                }
                let n = u8::try_from(items.len()).map_err(|_| err(pos, "list too long"))?;
                self.emit(Op::MkList(n), pos)?;
                Ty::List(Elem::Enum(e))
            }
            _ => self.expr(r)?,
        };
        let ok = match (a, b) {
            (x, Ty::List(e)) => elem_of(x) == Some(e),
            _ => false,
        };
        if !ok {
            return Err(err(
                pos,
                format!(
                    "`in` needs a value and a list of the same kind, not {} and {}",
                    describe(a, self.s),
                    describe(b, self.s)
                ),
            ));
        }
        self.emit(Op::InList, pos)?;
        Ok(Ty::Bool)
    }

    /// Enum tokens must be string literals the schema declares: a rule that compares
    /// against a token that does not exist would never fire, and silence is the failure
    /// 12 §3.5 exists to prevent.
    fn check_tokens(&self, e: EnumId, items: &[Expr]) -> Result<(), Error> {
        let declared = self.s.enum_tokens(e);
        for it in items {
            let ExprKind::Str(tok) = &it.kind else {
                return Err(err(it.pos, "an enum is compared with string literals"));
            };
            if let Some(d) = &declared {
                if !d.iter().any(|x| x == tok) {
                    return Err(err(
                        it.pos,
                        format!(
                            "`{tok}` is not a declared token; the schema has: {}",
                            d.join(", ")
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    fn call(&mut self, name: &str, args: &[Expr], pos: usize) -> Result<Ty, Error> {
        let arity = |n: usize| {
            if args.len() == n {
                Ok(())
            } else {
                Err(err(
                    pos,
                    format!("`{name}` takes {n} argument(s), not {}", args.len()),
                ))
            }
        };
        match name {
            "has" | "known_absent" | "is_known" => {
                arity(1)?;
                let (_, info) = self.field_ref(&args[0])?;
                self.emit(
                    match name {
                        "has" => Op::Has(info.id),
                        "known_absent" => Op::KnownAbsent(info.id),
                        _ => Op::IsKnown(info.id),
                    },
                    pos,
                )?;
                Ok(Ty::Bool)
            }
            "enum_is" => {
                arity(2)?;
                let (_, info) = self.field_ref(&args[0])?;
                let Ty::Enum(e) = info.ty else {
                    return Err(err(pos, "`enum_is` takes an enum field"));
                };
                self.check_tokens(e, &args[1..])?;
                self.emit(Op::LoadField(info.id), pos)?;
                self.expr(&args[1])?;
                self.emit(Op::Eq, pos)?;
                Ok(Ty::Bool)
            }
            "len" | "count" => {
                arity(1)?;
                let t = self.expr(&args[0])?;
                if !matches!(t, Ty::List(_) | Ty::Str) {
                    return Err(err(pos, format!("`{name}` takes a list or a string")));
                }
                self.emit(Op::Call(Builtin::Len), pos)?;
                Ok(Ty::Int)
            }
            "contains" => {
                arity(2)?;
                let a = self.expr(&args[0])?;
                let b = self.expr(&args[1])?;
                if a != Ty::Prefix || b != Ty::Addr {
                    return Err(err(pos, "`contains(prefix, address)`"));
                }
                self.emit(Op::Call(Builtin::Contains), pos)?;
                Ok(Ty::Bool)
            }
            "overlaps" | "is_subnet_of" => {
                arity(2)?;
                let a = self.expr(&args[0])?;
                let b = self.expr(&args[1])?;
                if a != Ty::Prefix || b != Ty::Prefix {
                    return Err(err(pos, format!("`{name}(prefix, prefix)`")));
                }
                self.emit(
                    Op::Call(if name == "overlaps" {
                        Builtin::Overlaps
                    } else {
                        Builtin::IsSubnetOf
                    }),
                    pos,
                )?;
                Ok(Ty::Bool)
            }
            "prefix_len" => {
                arity(1)?;
                let a = self.expr(&args[0])?;
                if !matches!(a, Ty::Prefix | Ty::Iface) {
                    return Err(err(
                        pos,
                        "`prefix_len` takes a prefix or an interface address",
                    ));
                }
                self.emit(Op::Call(Builtin::PrefixLen), pos)?;
                Ok(Ty::Int)
            }
            "addr_of" | "net_of" | "is_network_address" | "is_broadcast_address" => {
                arity(1)?;
                let a = self.expr(&args[0])?;
                if a != Ty::Iface {
                    return Err(err(pos, format!("`{name}` takes an interface address")));
                }
                let (b, t) = match name {
                    "addr_of" => (Builtin::AddrOf, Ty::Addr),
                    "net_of" => (Builtin::NetOf, Ty::Prefix),
                    "is_network_address" => (Builtin::IsNetworkAddress, Ty::Bool),
                    _ => (Builtin::IsBroadcastAddress, Ty::Bool),
                };
                self.emit(Op::Call(b), pos)?;
                Ok(t)
            }
            _ => Err(err(pos, format!("`{name}` is not a fex function"))),
        }
    }

    fn method(&mut self, obj: &Expr, name: &str, args: &[Expr], pos: usize) -> Result<Ty, Error> {
        let mode = match name {
            "exists" => Mode::Exists,
            "all" => Mode::All,
            "count" => Mode::Count,
            "filter" => Mode::Filter,
            _ => return Err(err(pos, format!("`.{name}(..)` is not a fex method"))),
        };
        let (Some(var), Some(body), 2) = (
            args.first().and_then(|a| match &a.kind {
                ExprKind::Ident(v) => Some(v.clone()),
                _ => None,
            }),
            args.get(1),
            args.len(),
        ) else {
            return Err(err(pos, format!("`.{name}(x, condition)`")));
        };
        if self.iter_depth >= MAX_ITER_DEPTH {
            return Err(err(
                pos,
                format!("comprehensions nest at most {MAX_ITER_DEPTH} deep"),
            ));
        }
        if self.lookup(&var).is_some() {
            return Err(err(pos, format!("`{var}` is already a name in this rule")));
        }
        let lt = self.expr(obj)?;
        let Ty::List(elem) = lt else {
            return Err(err(
                obj.pos,
                format!("`.{name}(..)` needs a list, not {}", describe(lt, self.s)),
            ));
        };
        if mode == Mode::Filter && !matches!(elem, Elem::Node(_)) {
            return Err(err(pos, "`filter` is for lists of nodes"));
        }
        self.emit(Op::IterInit(mode), pos)?;
        let top = self.here(pos)?;
        let slot = self.vars.len();
        let slot8 = u8::try_from(slot).map_err(|_| err(pos, "too many bindings"))?;
        let next = self.emit(Op::IterNext(slot8, 0), pos)?;
        self.vars.push((var, ty_of_elem(elem)));
        self.nslots = self.nslots.max(self.vars.len());
        self.iter_depth += 1;
        let bt = self.expr(body)?;
        self.expect(bt, Ty::Bool, body.pos, "a comprehension's condition")?;
        self.iter_depth -= 1;
        self.vars.pop();
        self.emit(Op::IterAcc(mode), pos)?;
        self.emit(Op::Jmp(top), pos)?;
        let end = self.here(pos)?;
        self.patch(next, end);
        self.emit(Op::IterEnd, pos)?;
        Ok(match mode {
            Mode::Exists | Mode::All => Ty::Bool,
            Mode::Count => Ty::Int,
            Mode::Filter => lt,
        })
    }
}

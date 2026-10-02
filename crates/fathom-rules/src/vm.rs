//! The fex VM: a stack machine with a step budget (12 §3.8, §7).
//!
//! It cannot panic and cannot allocate without bound: every index is checked, arithmetic
//! is checked, the stack and the iteration depth are capped, and one step is charged per
//! opcode, so a program of at most `MAX_CODE` instructions that loops only over lists a
//! selector bound (themselves capped) ends within the budget or reports
//! [`EvalError::Budget`]. A failure is a value, never a trap.

use std::rc::Rc;

use crate::compile::{Builtin, Cst, Mode, Op, Program, MAX_ITER_DEPTH};
use crate::schema::World;
use crate::value::{Field, Ip, Val};

/// Per rule instance (12 §15.3 gate 7).
pub const STEP_BUDGET: u32 = 2000;
pub const MAX_STACK: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalError {
    /// The step budget ran out.
    Budget,
    StackOverflow,
    /// Integer overflow in `+`, `-`, unary `-`.
    Overflow,
    /// A program the checker would not have produced.
    Malformed,
}

impl EvalError {
    pub fn text(self) -> &'static str {
        match self {
            EvalError::Budget => "ran past its step budget",
            EvalError::StackOverflow => "ran past the stack limit",
            EvalError::Overflow => "overflowed an integer",
            EvalError::Malformed => "is not a program this engine produces",
        }
    }
}

#[derive(Debug)]
pub struct Outcome<N> {
    pub value: Val<N>,
    /// A field the rule read had never been set. The rule's `on_unset` policy decides what
    /// that means; the default is that nothing is claimed.
    pub saw_unset: bool,
    pub steps: u32,
}

struct Frame<N> {
    list: Rc<Vec<Val<N>>>,
    idx: usize,
    acc: Acc<N>,
}

enum Acc<N> {
    Bool(bool),
    Count(i64),
    Keep(Vec<Val<N>>),
}

pub fn run<W: World>(
    p: &Program,
    w: &W,
    slots: Vec<Val<W::Node>>,
    budget: u32,
) -> Result<Outcome<W::Node>, EvalError> {
    let mut slots = slots;
    if slots.len() < p.nslots {
        slots.resize(p.nslots, Val::Null);
    }
    let mut st: Vec<Val<W::Node>> = Vec::new();
    let mut frames: Vec<Frame<W::Node>> = Vec::new();
    let mut pc = 0usize;
    let mut steps = 0u32;
    let mut saw_unset = false;

    macro_rules! pop {
        () => {
            st.pop().ok_or(EvalError::Malformed)?
        };
    }
    macro_rules! push {
        ($v:expr) => {{
            if st.len() >= MAX_STACK {
                return Err(EvalError::StackOverflow);
            }
            st.push($v);
        }};
    }

    loop {
        let op = *p.code.get(pc).ok_or(EvalError::Malformed)?;
        pc += 1;
        steps = steps.checked_add(1).ok_or(EvalError::Budget)?;
        if steps > budget {
            return Err(EvalError::Budget);
        }
        match op {
            Op::PushConst(k) => {
                let v = match p.consts.get(usize::from(k)).ok_or(EvalError::Malformed)? {
                    Cst::Null => Val::Null,
                    Cst::Bool(b) => Val::Bool(*b),
                    Cst::Int(i) => Val::Int(*i),
                    Cst::Str(s) => Val::Str(s.clone()),
                    Cst::Addr(a) => Val::Addr(*a),
                    Cst::Prefix(a, l) => Val::Prefix(*a, *l),
                };
                push!(v);
            }
            Op::Load(s) => {
                let v = slots
                    .get(usize::from(s))
                    .ok_or(EvalError::Malformed)?
                    .clone();
                push!(v);
            }
            Op::LoadField(f) => {
                let v = match pop!() {
                    Val::Node(n) => match w.field(n, f) {
                        Field::Set(s) => s.into_val(),
                        Field::Absent => Val::Null,
                        Field::Unset => {
                            saw_unset = true;
                            Val::Null
                        }
                    },
                    _ => Val::Null,
                };
                push!(v);
            }
            Op::Has(f) | Op::KnownAbsent(f) | Op::IsKnown(f) => {
                let r = match pop!() {
                    Val::Node(n) => {
                        let fld = w.field(n, f);
                        match op {
                            Op::Has(_) => matches!(fld, Field::Set(_)),
                            Op::KnownAbsent(_) => fld == Field::Absent,
                            _ => fld != Field::Unset,
                        }
                    }
                    _ => false,
                };
                push!(Val::Bool(r));
            }
            Op::Eq | Op::Ne => {
                let b = pop!();
                let a = pop!();
                push!(Val::Bool((a == b) == (op == Op::Eq)));
            }
            Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                let b = pop!();
                let a = pop!();
                // A null operand (an absent field) is not ordered: the comparison is false
                // either way. The author says what absence means with `has`.
                let r = match (a, b) {
                    (Val::Int(x), Val::Int(y)) => match op {
                        Op::Lt => x < y,
                        Op::Le => x <= y,
                        Op::Gt => x > y,
                        _ => x >= y,
                    },
                    _ => false,
                };
                push!(Val::Bool(r));
            }
            Op::InList => {
                let l = pop!();
                let v = pop!();
                let r = match l {
                    Val::List(items) => items.contains(&v) && v != Val::Null,
                    _ => false,
                };
                push!(Val::Bool(r));
            }
            Op::AndSc(j) | Op::OrSc(j) => {
                let top = st.last().ok_or(EvalError::Malformed)?;
                let b = matches!(top, Val::Bool(true));
                let short = if matches!(op, Op::AndSc(_)) { !b } else { b };
                if short {
                    pc = usize::from(j);
                } else {
                    st.pop();
                }
            }
            Op::Not => {
                let v = pop!();
                push!(Val::Bool(!matches!(v, Val::Bool(true))));
            }
            Op::Jmp(j) => pc = usize::from(j),
            Op::JmpIfFalse(j) => {
                if !matches!(pop!(), Val::Bool(true)) {
                    pc = usize::from(j);
                }
            }
            Op::Add | Op::Sub => {
                let b = pop!();
                let a = pop!();
                let v = match (a, b) {
                    (Val::Int(x), Val::Int(y)) => {
                        let r = if op == Op::Add {
                            x.checked_add(y)
                        } else {
                            x.checked_sub(y)
                        };
                        Val::Int(r.ok_or(EvalError::Overflow)?)
                    }
                    _ => Val::Null,
                };
                push!(v);
            }
            Op::Neg => {
                let v = match pop!() {
                    Val::Int(x) => Val::Int(x.checked_neg().ok_or(EvalError::Overflow)?),
                    _ => Val::Null,
                };
                push!(v);
            }
            Op::Call(b) => {
                steps = steps.saturating_add(b.cost());
                let v = builtin(b, &mut st)?;
                push!(v);
            }
            Op::MkList(n) => {
                let n = usize::from(n);
                let at = st.len().checked_sub(n).ok_or(EvalError::Malformed)?;
                let items: Vec<Val<W::Node>> = st.split_off(at);
                push!(Val::List(Rc::new(items)));
            }
            Op::IterInit(mode) => {
                if frames.len() >= MAX_ITER_DEPTH {
                    return Err(EvalError::Malformed);
                }
                let list = match pop!() {
                    Val::List(l) => l,
                    _ => Rc::new(Vec::new()),
                };
                let acc = match mode {
                    Mode::Exists => Acc::Bool(false),
                    Mode::All => Acc::Bool(true),
                    Mode::Count => Acc::Count(0),
                    Mode::Filter => Acc::Keep(Vec::new()),
                };
                frames.push(Frame { list, idx: 0, acc });
            }
            Op::IterNext(slot, end) => {
                let f = frames.last_mut().ok_or(EvalError::Malformed)?;
                match f.list.get(f.idx) {
                    None => pc = usize::from(end),
                    Some(v) => {
                        let s = slots
                            .get_mut(usize::from(slot))
                            .ok_or(EvalError::Malformed)?;
                        *s = v.clone();
                        f.idx += 1;
                    }
                }
            }
            Op::IterAcc(mode) => {
                let hit = matches!(pop!(), Val::Bool(true));
                let f = frames.last_mut().ok_or(EvalError::Malformed)?;
                match (&mut f.acc, mode) {
                    (Acc::Bool(a), Mode::Exists) if hit => {
                        *a = true;
                        f.idx = f.list.len();
                    }
                    (Acc::Bool(a), Mode::All) if !hit => {
                        *a = false;
                        f.idx = f.list.len();
                    }
                    (Acc::Count(n), Mode::Count) if hit => {
                        *n = n.checked_add(1).ok_or(EvalError::Overflow)?;
                    }
                    (Acc::Keep(v), Mode::Filter) if hit => {
                        let cur = f
                            .idx
                            .checked_sub(1)
                            .and_then(|i| f.list.get(i))
                            .ok_or(EvalError::Malformed)?;
                        v.push(cur.clone());
                    }
                    _ => {}
                }
            }
            Op::IterEnd => {
                let f = frames.pop().ok_or(EvalError::Malformed)?;
                let v = match f.acc {
                    Acc::Bool(b) => Val::Bool(b),
                    Acc::Count(n) => Val::Int(n),
                    Acc::Keep(v) => Val::List(Rc::new(v)),
                };
                push!(v);
            }
            Op::Ret => {
                let value = pop!();
                return Ok(Outcome {
                    value,
                    saw_unset,
                    steps,
                });
            }
        }
    }
}

fn net_covers(p: Ip, plen: u8, a: Ip) -> bool {
    p.v6 == a.v6 && a.network(plen).bits == p.network(plen).bits
}

fn builtin<N: Clone>(b: Builtin, st: &mut Vec<Val<N>>) -> Result<Val<N>, EvalError> {
    let mut pop = || st.pop().ok_or(EvalError::Malformed);
    Ok(match b {
        Builtin::Len => match pop()? {
            Val::List(l) => Val::Int(i64::try_from(l.len()).map_err(|_| EvalError::Overflow)?),
            Val::Str(s) => Val::Int(i64::try_from(s.len()).map_err(|_| EvalError::Overflow)?),
            _ => Val::Null,
        },
        Builtin::Contains => {
            let a = pop()?;
            let p = pop()?;
            match (p, a) {
                (Val::Prefix(p, l), Val::Addr(a)) => Val::Bool(net_covers(p, l, a)),
                _ => Val::Bool(false),
            }
        }
        Builtin::Overlaps | Builtin::IsSubnetOf => {
            let q = pop()?;
            let p = pop()?;
            match (p, q) {
                (Val::Prefix(p, pl), Val::Prefix(q, ql)) if p.v6 == q.v6 => {
                    let short = pl.min(ql);
                    let sub = net_covers(q, ql, p) && pl >= ql;
                    Val::Bool(if b == Builtin::IsSubnetOf {
                        sub
                    } else {
                        p.network(short).bits == q.network(short).bits
                    })
                }
                _ => Val::Bool(false),
            }
        }
        Builtin::PrefixLen => match pop()? {
            Val::Prefix(_, l) | Val::Iface(_, l) => Val::Int(i64::from(l)),
            _ => Val::Null,
        },
        Builtin::AddrOf => match pop()? {
            Val::Iface(a, _) => Val::Addr(a),
            _ => Val::Null,
        },
        Builtin::NetOf => match pop()? {
            Val::Iface(a, l) => Val::Prefix(a.network(l), l),
            _ => Val::Null,
        },
        Builtin::IsNetworkAddress | Builtin::IsBroadcastAddress => match pop()? {
            // IPv4 only, and only where the subnet has a network and a broadcast address:
            // a /31 (RFC 3021) and a /32 have neither.
            Val::Iface(a, l) if !a.v6 && l <= 30 => {
                let host = a.host_bits(l);
                let all = (1u128 << (32 - u32::from(l))) - 1;
                Val::Bool(if b == Builtin::IsNetworkAddress {
                    host == 0
                } else {
                    host == all
                })
            }
            _ => Val::Bool(false),
        },
    })
}

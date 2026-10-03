//! fex's parser: the grammar of 12 §3.4, recursive descent, depth-bounded.

use crate::lex::{err, lex, Error, Tok};
use crate::value::Ip;

pub const MAX_DEPTH: usize = 24;
pub const MAX_LIST: usize = 32;

#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    pub pos: usize,
    pub kind: ExprKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    In,
    Add,
    Sub,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    Int(i64),
    Str(String),
    Bool(bool),
    Null,
    Addr(Ip),
    Prefix(Ip, u8),
    Ident(String),
    Field(Box<Expr>, String),
    Call(String, Vec<Expr>),
    Method(Box<Expr>, String, Vec<Expr>),
    Not(Box<Expr>),
    Neg(Box<Expr>),
    Bin(BinOp, Box<Expr>, Box<Expr>),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    List(Vec<Expr>),
}

pub fn parse(src: &str) -> Result<Expr, Error> {
    let toks = lex(src)?;
    let mut p = P {
        toks: &toks,
        at: 0,
        depth: 0,
    };
    let e = p.expr()?;
    match p.peek() {
        Tok::Eof => Ok(e),
        other => Err(err(
            p.pos(),
            format!("unexpected {} after the expression", name(other)),
        )),
    }
}

struct P<'a> {
    toks: &'a [(Tok, usize)],
    at: usize,
    depth: usize,
}

fn name(t: &Tok) -> String {
    match t {
        Tok::Eof => "end of expression".into(),
        Tok::Ident(s) => format!("`{s}`"),
        other => format!("{other:?}"),
    }
}

impl P<'_> {
    fn peek(&self) -> &Tok {
        self.toks.get(self.at).map_or(&Tok::Eof, |t| &t.0)
    }
    fn pos(&self) -> usize {
        self.toks.get(self.at).map_or(0, |t| t.1)
    }
    fn bump(&mut self) {
        if self.at < self.toks.len() {
            self.at += 1;
        }
    }
    fn eat(&mut self, t: &Tok) -> bool {
        if self.peek() == t {
            self.bump();
            true
        } else {
            false
        }
    }
    fn expect(&mut self, t: &Tok) -> Result<(), Error> {
        if self.eat(t) {
            Ok(())
        } else {
            Err(err(
                self.pos(),
                format!("expected {t:?}, found {}", name(self.peek())),
            ))
        }
    }
    fn mk(&self, pos: usize, kind: ExprKind) -> Expr {
        Expr { pos, kind }
    }
    fn enter(&mut self) -> Result<(), Error> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(err(
                self.pos(),
                format!("nested more than {MAX_DEPTH} deep"),
            ));
        }
        Ok(())
    }

    fn expr(&mut self) -> Result<Expr, Error> {
        self.enter()?;
        let cond = self.or()?;
        let e = if self.peek() == &Tok::Question {
            let pos = self.pos();
            self.bump();
            let a = self.expr()?;
            self.expect(&Tok::Colon)?;
            let b = self.expr()?;
            self.mk(
                pos,
                ExprKind::Ternary(Box::new(cond), Box::new(a), Box::new(b)),
            )
        } else {
            cond
        };
        self.depth -= 1;
        Ok(e)
    }

    fn bin(&mut self, op: BinOp, l: Expr, r: Expr, pos: usize) -> Expr {
        self.mk(pos, ExprKind::Bin(op, Box::new(l), Box::new(r)))
    }

    fn or(&mut self) -> Result<Expr, Error> {
        let mut l = self.and()?;
        let base = self.depth;
        while self.peek() == &Tok::OrOr {
            self.enter()?;
            let pos = self.pos();
            self.bump();
            let r = self.and()?;
            l = self.bin(BinOp::Or, l, r, pos);
        }
        self.depth = base;
        Ok(l)
    }

    fn and(&mut self) -> Result<Expr, Error> {
        let mut l = self.rel()?;
        let base = self.depth;
        while self.peek() == &Tok::AndAnd {
            self.enter()?;
            let pos = self.pos();
            self.bump();
            let r = self.rel()?;
            l = self.bin(BinOp::And, l, r, pos);
        }
        self.depth = base;
        Ok(l)
    }

    fn rel(&mut self) -> Result<Expr, Error> {
        let l = self.add()?;
        let op = match self.peek() {
            Tok::EqEq => BinOp::Eq,
            Tok::Ne => BinOp::Ne,
            Tok::Lt => BinOp::Lt,
            Tok::Le => BinOp::Le,
            Tok::Gt => BinOp::Gt,
            Tok::Ge => BinOp::Ge,
            Tok::Ident(s) if s == "in" => BinOp::In,
            _ => return Ok(l),
        };
        let pos = self.pos();
        self.bump();
        let r = self.add()?;
        Ok(self.bin(op, l, r, pos))
    }

    fn add(&mut self) -> Result<Expr, Error> {
        let mut l = self.unary()?;
        let base = self.depth;
        loop {
            let op = match self.peek() {
                Tok::Plus => BinOp::Add,
                Tok::Minus => BinOp::Sub,
                _ => {
                    self.depth = base;
                    return Ok(l);
                }
            };
            self.enter()?;
            let pos = self.pos();
            self.bump();
            let r = self.unary()?;
            l = self.bin(op, l, r, pos);
        }
    }

    fn unary(&mut self) -> Result<Expr, Error> {
        let pos = self.pos();
        match self.peek() {
            Tok::Bang => {
                self.bump();
                self.enter()?;
                let e = self.unary()?;
                self.depth -= 1;
                Ok(self.mk(pos, ExprKind::Not(Box::new(e))))
            }
            Tok::Minus => {
                self.bump();
                self.enter()?;
                let e = self.unary()?;
                self.depth -= 1;
                Ok(self.mk(pos, ExprKind::Neg(Box::new(e))))
            }
            _ => self.postfix(),
        }
    }

    fn args(&mut self) -> Result<Vec<Expr>, Error> {
        let mut v = Vec::new();
        self.expect(&Tok::LParen)?;
        if self.eat(&Tok::RParen) {
            return Ok(v);
        }
        loop {
            if v.len() >= MAX_LIST {
                return Err(err(self.pos(), format!("more than {MAX_LIST} arguments")));
            }
            v.push(self.expr()?);
            if self.eat(&Tok::Comma) {
                continue;
            }
            self.expect(&Tok::RParen)?;
            return Ok(v);
        }
    }

    fn postfix(&mut self) -> Result<Expr, Error> {
        let mut e = self.primary()?;
        let base = self.depth;
        while self.peek() == &Tok::Dot {
            self.enter()?;
            self.bump();
            let pos = self.pos();
            let Tok::Ident(n) = self.peek().clone() else {
                return Err(err(pos, "expected a field or method name after `.`"));
            };
            self.bump();
            if self.peek() == &Tok::LParen {
                let a = self.args()?;
                e = self.mk(pos, ExprKind::Method(Box::new(e), n, a));
            } else {
                e = self.mk(pos, ExprKind::Field(Box::new(e), n));
            }
        }
        self.depth = base;
        Ok(e)
    }

    fn primary(&mut self) -> Result<Expr, Error> {
        let pos = self.pos();
        let t = self.peek().clone();
        self.bump();
        match t {
            Tok::Int(i) => Ok(self.mk(pos, ExprKind::Int(i))),
            Tok::Str(s) => Ok(self.mk(pos, ExprKind::Str(s))),
            Tok::Addr(a) => Ok(self.mk(pos, ExprKind::Addr(a))),
            Tok::Prefix(a, l) => Ok(self.mk(pos, ExprKind::Prefix(a, l))),
            Tok::Ident(s) => match s.as_str() {
                "true" => Ok(self.mk(pos, ExprKind::Bool(true))),
                "false" => Ok(self.mk(pos, ExprKind::Bool(false))),
                "null" => Ok(self.mk(pos, ExprKind::Null)),
                "in" => Err(err(pos, "`in` is an operator, not a name")),
                _ if self.peek() == &Tok::LParen => {
                    let a = self.args()?;
                    Ok(self.mk(pos, ExprKind::Call(s, a)))
                }
                _ => Ok(self.mk(pos, ExprKind::Ident(s))),
            },
            Tok::LParen => {
                self.enter()?;
                let e = self.expr()?;
                self.expect(&Tok::RParen)?;
                self.depth -= 1;
                Ok(e)
            }
            Tok::LBrack => {
                let mut v = Vec::new();
                if self.eat(&Tok::RBrack) {
                    return Ok(self.mk(pos, ExprKind::List(v)));
                }
                loop {
                    if v.len() >= MAX_LIST {
                        return Err(err(self.pos(), format!("more than {MAX_LIST} elements")));
                    }
                    v.push(self.expr()?);
                    if self.eat(&Tok::Comma) {
                        continue;
                    }
                    self.expect(&Tok::RBrack)?;
                    return Ok(self.mk(pos, ExprKind::List(v)));
                }
            }
            other => Err(err(pos, format!("unexpected {}", name(&other)))),
        }
    }
}

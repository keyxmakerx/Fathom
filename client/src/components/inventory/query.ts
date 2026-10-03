// The filter query language (inventory v5). Pure: no React, no document.
//   field:value  field!=value  field~text  field^text  field>n  <n  >=n  <=n
//   field:a*b (wildcard)  field:empty  field:any  -term (not)  (a | b) (either)  bare words
// Spaces mean "and". A bad term never stops the rest: it is reported by name and ignored.

export type Op = ':' | '!=' | '~' | '^' | '>' | '<' | '>=' | '<=';

export interface FieldSpec {
  key: string;
  label: string;
  numeric?: boolean;
}

export interface TextTerm {
  type: 'text';
  neg: boolean;
  text: string;
  raw: string;
}
export interface FieldTerm {
  type: 'field';
  neg: boolean;
  field: string;
  op: Op;
  value: string;
  raw: string;
}
export interface GroupTerm {
  type: 'group';
  neg: boolean;
  alts: Term[][];
  raw: string;
}
export type Term = TextTerm | FieldTerm | GroupTerm;

export interface QueryError {
  /** The term as typed. */
  raw: string;
  /** A sentence that starts from the term. */
  message: string;
}

export interface Parsed {
  terms: Term[];
  errors: QueryError[];
}

/** What the evaluator needs of a row. */
export interface Probe {
  /** Every value the field holds (a cable has two ends, so some fields have two). */
  values(field: string): readonly string[];
  number(field: string): number | undefined;
  /** All the row's text, any case. */
  text(): string;
}

// ---------------------------------------------------------------------------
// Tokens

const OPEN = '(';
const NEG_OPEN = '-(';
const CLOSE = ')';
const BAR = '|';

export function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '(' || ch === ')' || ch === '|') {
      out.push(ch);
      i += 1;
    } else if (ch === '-' && s[i + 1] === '(') {
      out.push(NEG_OPEN);
      i += 2;
    } else {
      let j = i;
      let quoted = false;
      while (j < s.length && (quoted || !/[\s()|]/.test(s[j]!))) {
        if (s[j] === '"') quoted = !quoted;
        j += 1;
      }
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

const FIELD_TERM = /^(-?)([a-z][a-z0-9_.]*)(!=|>=|<=|:|~|\^|>|<)(.*)$/i;
const unquote = (v: string): string => v.replace(/"/g, '');
const OP_WORDS: Record<Op, string> = { ':': 'is', '!=': 'is not', '~': 'contains', '^': 'starts with', '>': 'over', '<': 'under', '>=': 'at least', '<=': 'at most' };

function closest(word: string, fields: readonly FieldSpec[]): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestD = 3;
  for (const f of fields) {
    const d = distance(w, f.key.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = f.key;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function parseWord(tok: string, fields: readonly FieldSpec[], kindWord: string, errors: QueryError[]): Term | undefined {
  const m = FIELD_TERM.exec(tok);
  if (!m) {
    const neg = tok.length > 1 && tok.startsWith('-');
    const text = unquote(neg ? tok.slice(1) : tok);
    return text === '' ? undefined : { type: 'text', neg, text, raw: tok };
  }
  const neg = m[1] === '-';
  const field = m[2]!.toLowerCase();
  const op = m[3] as Op;
  const value = unquote(m[4]!);
  const spec = fields.find((f) => f.key.toLowerCase() === field);
  if (!spec) {
    const near = closest(field, fields);
    errors.push({
      raw: tok,
      message: `${tok}: there is no field “${m[2]}” on ${kindWord}.${near ? ` Did you mean ${near}?` : ''} To search for that text, put it in quotes.`,
    });
    return undefined;
  }
  if (value === '') {
    errors.push({ raw: tok, message: `${tok}: give “${spec.key}${op}” a value, for example ${spec.key}${op}${op === '>' || op === '<' || op === '>=' || op === '<=' ? '10' : 'x'}.` });
    return undefined;
  }
  if (foldStars(value).split('*').length - 1 > MAX_WILDCARDS) {
    errors.push({ raw: tok, message: `${tok}: more than ${MAX_WILDCARDS} wildcards (*) in one value. Use fewer.` });
    return undefined;
  }
  if ((op === '>' || op === '<' || op === '>=' || op === '<=') && !Number.isFinite(Number(value))) {
    errors.push({ raw: tok, message: `${tok}: “${value}” is not a number, and ${op} compares numbers.` });
    return undefined;
  }
  return { type: 'field', neg, field: spec.key, op, value, raw: tok };
}

function raw(term: Term): string {
  return term.raw;
}

function groupRaw(neg: boolean, alts: readonly (readonly Term[])[]): string {
  return `${neg ? '-' : ''}(${alts.map((a) => a.map(raw).join(' ')).join(' | ')})`;
}

/** `kindWord` is only for sentences, e.g. "cables". */
export function parseQuery(input: string, fields: readonly FieldSpec[], kindWord = 'this list'): Parsed {
  const t = tokenize(input);
  const errors: QueryError[] = [];
  let i = 0;

  const group = (neg: boolean): GroupTerm | undefined => {
    const alts: Term[][] = [[]];
    let closed = false;
    while (i < t.length) {
      const x = t[i++]!;
      if (x === CLOSE) {
        closed = true;
        break;
      }
      if (x === BAR) {
        alts.push([]);
        continue;
      }
      if (x === OPEN || x === NEG_OPEN) {
        const g = group(x === NEG_OPEN);
        if (g) alts[alts.length - 1]!.push(g);
        continue;
      }
      const term = parseWord(x, fields, kindWord, errors);
      if (term) alts[alts.length - 1]!.push(term);
    }
    if (!closed) errors.push({ raw: OPEN, message: `( : a bracket is not closed. Add ) at the end of the group.` });
    const live = alts.filter((a) => a.length > 0);
    if (live.length === 0) return undefined;
    return { type: 'group', neg, alts: live, raw: groupRaw(neg, live) };
  };

  const terms: Term[] = [];
  while (i < t.length) {
    const x = t[i++]!;
    if (x === OPEN || x === NEG_OPEN) {
      const g = group(x === NEG_OPEN);
      if (g) terms.push(g);
    } else if (x === CLOSE) {
      errors.push({ raw: x, message: `) : a closing bracket has no opening one.` });
    } else if (x === BAR) {
      errors.push({ raw: x, message: `| : put “or” choices inside brackets, like (role:switch | role:router).` });
    } else {
      const term = parseWord(x, fields, kindWord, errors);
      if (term) terms.push(term);
    }
  }
  return { terms, errors };
}

// ---------------------------------------------------------------------------
// Evaluation

/** A pattern may hold this many `*` once runs of them are folded into one. */
export const MAX_WILDCARDS = 12;

/** Runs of `*` mean the same as one. */
const foldStars = (v: string): string => v.replace(/\*+/g, '*');

/**
 * A case-blind matcher for `a*b`, with no regular expression: it walks the text once, going back
 * only to the last `*`, so a hostile pattern in a shared link cannot freeze the page.
 */
export function globMatcher(pattern: string): (text: string) => boolean {
  const p = foldStars(pattern).toLowerCase();
  return (text) => {
    const t = text.toLowerCase();
    let pi = 0;
    let ti = 0;
    let star = -1;
    let mark = 0;
    while (ti < t.length) {
      if (pi < p.length && p[pi] === '*') {
        star = pi;
        mark = ti;
        pi += 1;
      } else if (pi < p.length && p[pi] === t[ti]) {
        pi += 1;
        ti += 1;
      } else if (star >= 0) {
        pi = star + 1;
        mark += 1;
        ti = mark;
      } else {
        return false;
      }
    }
    while (pi < p.length && p[pi] === '*') pi += 1;
    return pi === p.length;
  };
}

export type Predicate = (p: Probe) => boolean;

function compileTerm(term: Term, numeric: ReadonlySet<string>): Predicate {
  if (term.type === 'group') {
    const alts = term.alts.map((alt) => alt.map((x) => compileTerm(x, numeric)));
    return (p) => {
      const hit = alts.some((alt) => alt.every((f) => f(p)));
      return term.neg ? !hit : hit;
    };
  }
  if (term.type === 'text') {
    const needle = term.text.toLowerCase();
    if (needle === '*') return () => !term.neg;
    return (p) => {
      const hit = p.text().toLowerCase().includes(needle);
      return term.neg ? !hit : hit;
    };
  }
  const { field, op, value } = term;
  const lv = value.toLowerCase();
  const wild = value.includes('*') ? globMatcher(value) : null;
  const n = Number(value);
  const isNum = numeric.has(field) && Number.isFinite(n) && value.trim() !== '';
  let test: Predicate;
  if (op === ':') {
    if (lv === 'empty') test = (p) => p.values(field).every((x) => x === '') ;
    else if (lv === 'any') test = (p) => p.values(field).some((x) => x !== '');
    else if (wild) test = (p) => p.values(field).some((x) => wild(x));
    else if (isNum) test = (p) => p.values(field).some((x) => x !== '' && Number(x) === n) || p.number(field) === n;
    else test = (p) => p.values(field).some((x) => x.toLowerCase() === lv);
  } else if (op === '!=') {
    test = lv === 'empty' ? (p) => p.values(field).some((x) => x !== '') : (p) => !p.values(field).some((x) => x.toLowerCase() === lv);
  } else if (op === '~') {
    test = (p) => p.values(field).some((x) => x.toLowerCase().includes(lv));
  } else if (op === '^') {
    test = (p) => p.values(field).some((x) => x.toLowerCase().startsWith(lv));
  } else {
    test = (p) => {
      const y = p.number(field);
      if (y === undefined) return false;
      return op === '>' ? y > n : op === '<' ? y < n : op === '>=' ? y >= n : y <= n;
    };
  }
  return term.neg ? (p) => !test(p) : test;
}

export function compileQuery(terms: readonly Term[], fields: readonly FieldSpec[]): Predicate {
  const numeric = new Set(fields.filter((f) => f.numeric).map((f) => f.key));
  const preds = terms.map((t) => compileTerm(t, numeric));
  return (p) => preds.every((f) => f(p));
}

// ---------------------------------------------------------------------------
// In plain words

function phrase(term: FieldTerm, label: string): string {
  const v = term.value;
  const lv = v.toLowerCase();
  let w: string;
  if (term.op === ':') w = lv === 'empty' ? 'is empty' : lv === 'any' ? 'is filled in' : v.includes('*') ? `matches ${v}` : `is ${v}`;
  else if (term.op === '!=') w = lv === 'empty' ? 'is filled in' : `is not ${v}`;
  else w = `${OP_WORDS[term.op]} ${v}`;
  return `${label} ${w}`;
}

export function readTerm(term: Term, labelOf: (field: string) => string): string {
  const not = term.neg ? 'not: ' : '';
  if (term.type === 'text') return `${not}anything containing “${term.text}”`;
  if (term.type === 'field') return `${not}${phrase(term, labelOf(term.field))}`;
  return `${not}any of ${term.alts.map((a) => a.map((x) => readTerm(x, labelOf)).join(' and ')).join(' or ')}`;
}

export function readQuery(terms: readonly Term[], labelOf: (field: string) => string): string {
  return terms.map((t) => readTerm(t, labelOf)).join(', and ');
}

// ---------------------------------------------------------------------------
// Editing the line as text. A "unit" is one top-level word or one whole bracket group.

export function units(input: string): string[] {
  const t = tokenize(input);
  const out: string[] = [];
  let i = 0;
  const group = (neg: boolean): string => {
    const parts: string[] = [];
    while (i < t.length) {
      const x = t[i++]!;
      if (x === CLOSE) return `${neg ? '-' : ''}(${parts.join(' ').replace(/ \| /g, ' | ')})`;
      if (x === OPEN || x === NEG_OPEN) parts.push(group(x === NEG_OPEN));
      else parts.push(x);
    }
    return `${neg ? '-' : ''}(${parts.join(' ')}`;
  };
  while (i < t.length) {
    const x = t[i++]!;
    if (x === OPEN || x === NEG_OPEN) out.push(group(x === NEG_OPEN));
    else out.push(x);
  }
  return out;
}

export const joinUnits = (u: readonly string[]): string => u.join(' ');

export function removeUnit(input: string, index: number): string {
  return joinUnits(units(input).filter((_, i) => i !== index));
}

export const quoteValue = (v: string): string => (/[\s()|"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

function fieldOfUnit(u: string): string | null {
  const m = FIELD_TERM.exec(u);
  return m && !u.startsWith('(') ? m[2]!.toLowerCase() : null;
}

/** Inner units of a group unit, `|` removed. */
function groupFields(u: string): string[] | null {
  const m = /^-?\((.*)\)$/.exec(u);
  if (!m) return null;
  return tokenize(m[1]!).filter((x) => x !== BAR).map((x) => fieldOfUnit(x) ?? '');
}

/** The line without any plain term on `field` and without bracket groups made only of `field`. */
export function stripField(input: string, field: string): string {
  const f = field.toLowerCase();
  const keep = units(input).filter((u) => {
    if (u.startsWith('(') || u.startsWith('-(')) {
      const inner = groupFields(u);
      return !(inner && inner.length > 0 && inner.every((x) => x === f));
    }
    return fieldOfUnit(u) !== f;
  });
  return joinUnits(keep);
}

/** Put `term` for `field` in the line, replacing the field's earlier plain terms. */
export function setFieldTerm(input: string, field: string, term: string): string {
  return joinUnits([...units(stripField(input, field)), term]);
}

export interface FieldState {
  /** Values chosen with `field:value`; `(blank)` for `field:empty`. */
  values: string[];
  min: string;
  max: string;
  has: string;
}

/** What the Filters panel shows for one field, read back from the line. */
export function fieldState(input: string, field: string): FieldState {
  const f = field.toLowerCase();
  const st: FieldState = { values: [], min: '', max: '', has: '' };
  const visit = (tok: string, inGroup: boolean) => {
    const m = FIELD_TERM.exec(tok);
    if (!m || m[1] || m[2]!.toLowerCase() !== f) return;
    const v = unquote(m[4]!);
    if (m[3] === ':') st.values.push(v.toLowerCase() === 'empty' ? '(blank)' : v);
    else if (m[3] === '>=' || m[3] === '>') st.min = v;
    else if (m[3] === '<=' || m[3] === '<') st.max = v;
    else if (m[3] === '~' && !inGroup) st.has = v;
  };
  for (const u of units(input)) {
    if (u.startsWith('(')) for (const x of tokenize(u.slice(1, -1))) visit(x, true);
    else visit(u, false);
  }
  return st;
}

/** The panel's pick written into the line: one value is `f:v`, several are `(f:a | f:b)`. */
export function setField(input: string, field: string, st: FieldState): string {
  const add: string[] = [];
  const vs = st.values.map((v) => (v === '(blank)' ? `${field}:empty` : `${field}:${quoteValue(v)}`));
  if (vs.length === 1) add.push(vs[0]!);
  else if (vs.length > 1) add.push(`(${vs.join(' | ')})`);
  if (st.min !== '') add.push(`${field}>=${st.min}`);
  if (st.max !== '') add.push(`${field}<=${st.max}`);
  if (st.has !== '') add.push(`${field}~${quoteValue(st.has)}`);
  return joinUnits([...units(stripField(input, field)), ...add]);
}

/** The operators, for the "?" help. */
export const OPERATOR_HELP: ReadonlyArray<{ write: string; means: string; example: string }> = [
  { write: 'field:value', means: 'is', example: 'role:switch' },
  { write: 'field!=value', means: 'is not', example: 'sheath!=grey' },
  { write: 'field~text', means: 'contains', example: 'model~R7' },
  { write: 'field^text', means: 'starts with', example: 'name^lon1' },
  { write: 'field>n  <n  >=n  <=n', means: 'numbers', example: 'length>30' },
  { write: 'field:a*b', means: 'wildcard', example: 'name:lon1-*-tor1' },
  { write: 'field:empty  field:any', means: 'blank or filled in', example: 'label:empty' },
  { write: '-term', means: 'not', example: '-role:switch' },
  { write: '(x | y)', means: 'either', example: '(role:switch | role:router)' },
  { write: 'word', means: 'anything containing it', example: 'R650' },
];

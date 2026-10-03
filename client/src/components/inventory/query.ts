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

/** The term as named in a sentence: a long one is cut short. */
const nameOf = (tok: string): string => (tok.length > 32 ? `${tok.slice(0, 30)}…` : tok);

function parseWord(tok: string, fields: readonly FieldSpec[], kindWord: string, errors: QueryError[]): Term | undefined {
  if ((tok.match(/"/g)?.length ?? 0) % 2 === 1) {
    errors.push({ raw: tok, message: `${nameOf(tok)}: a quote is not closed. Add a second " after the value.` });
    return undefined;
  }
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
  const compares = op === '>' || op === '<' || op === '>=' || op === '<=';
  if (compares && !spec.numeric) {
    errors.push({ raw: tok, message: `${tok}: “${spec.key}” holds text, and ${op} compares numbers. Try ${spec.key}~${value} (contains) or ${spec.key}^${value} (starts with).` });
    return undefined;
  }
  if (compares && !Number.isFinite(Number(value))) {
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
  // `field!=x` is `-field:x`: every kind of value `:` understands (empty, any, a wildcard, a number).
  let test: Predicate;
  if (op === ':' || op === '!=') {
    let is: Predicate;
    if (lv === 'empty') is = (p) => p.values(field).every((x) => x === '');
    else if (lv === 'any') is = (p) => p.values(field).some((x) => x !== '');
    else if (wild) is = (p) => p.values(field).some((x) => wild(x));
    else if (isNum) is = (p) => p.values(field).some((x) => x !== '' && Number(x) === n) || p.number(field) === n;
    else is = (p) => p.values(field).some((x) => x.toLowerCase() === lv);
    test = op === ':' ? is : (p) => !is(p);
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
  else if (term.op === '!=') w = lv === 'empty' ? 'is filled in' : lv === 'any' ? 'is blank' : v.includes('*') ? `does not match ${v}` : `is not ${v}`;
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

// ---------------------------------------------------------------------------
// The Filters panel and the column menus read one field out of the line and write it back. They
// understand only some shapes (see `Role`); every other unit that mentions the field is left exactly
// as it is and is listed in `others`, so a panel never drops or rewrites a term it cannot show.

type Role = 'free' | 'value' | 'values' | 'min' | 'max' | 'has' | 'mixed' | 'starts' | 'other';

interface Scanned {
  unit: string;
  role: Role;
  /** value, min, max, has: the text; values / mixed: the ticked values. */
  vals: string[];
  strict?: boolean;
  /** mixed: the group's alternatives as tokens, to rewrite it. */
  alts?: string[][];
  neg?: boolean;
}

/** A plain positive `field:value` that names a literal value (not `any`, not a wildcard). */
function literalValue(tok: string, f: string): string | null {
  const m = FIELD_TERM.exec(tok);
  if (!m || m[1] || m[2]!.toLowerCase() !== f || m[3] !== ':') return null;
  const v = unquote(m[4]!);
  if (v === '' || v.includes('*') || v.toLowerCase() === 'any') return null;
  return v.toLowerCase() === 'empty' ? '(blank)' : v;
}

const mentions = (tok: string, f: string): boolean => {
  const m = FIELD_TERM.exec(tok);
  return !!m && m[2]!.toLowerCase() === f;
};

function scanUnit(unit: string, f: string): Scanned {
  const toks = tokenize(unit);
  if (!toks.some((t) => mentions(t, f))) return { unit, role: 'free', vals: [] };
  const other: Scanned = { unit, role: 'other', vals: [] };
  if (toks.length === 1) {
    const m = FIELD_TERM.exec(toks[0]!);
    if (!m || m[1]) return other;
    const v = unquote(m[4]!);
    switch (m[3]) {
      case ':': {
        const lit = literalValue(toks[0]!, f);
        return lit === null ? other : { unit, role: 'value', vals: [lit] };
      }
      case '>=':
      case '>':
        return { unit, role: 'min', vals: [v], strict: m[3] === '>' };
      case '<=':
      case '<':
        return { unit, role: 'max', vals: [v], strict: m[3] === '<' };
      case '~':
        return { unit, role: 'has', vals: [v] };
      case '^':
        return { unit, role: 'starts', vals: [v] };
      default:
        return other;
    }
  }
  if (toks[0] !== OPEN || toks[toks.length - 1] !== CLOSE) return other; // a negated group, say
  const alts: string[][] = [[]];
  for (const t of toks.slice(1, -1)) {
    if (t === OPEN || t === NEG_OPEN || t === CLOSE) return other; // nested: not ours to rewrite
    if (t === BAR) alts.push([]);
    else alts[alts.length - 1]!.push(t);
  }
  const single = alts.map((a) => (a.length === 1 ? literalValue(a[0]!, f) : null));
  const vals = single.filter((x): x is string => x !== null);
  if (vals.length === 0) return other;
  return single.every((x) => x !== null) ? { unit, role: 'values', vals } : { unit, role: 'mixed', vals, alts };
}

/** Each unit read for `field`; a second min, max or "contains" is not the panel's, so it is `other`. */
function scanField(input: string, field: string): Scanned[] {
  const f = field.toLowerCase();
  const seen = new Set<Role>();
  return units(input).map((u) => {
    const sc = scanUnit(u, f);
    if (sc.role === 'min' || sc.role === 'max' || sc.role === 'has') {
      if (seen.has(sc.role)) return { ...sc, role: 'other' as const };
      seen.add(sc.role);
    }
    return sc;
  });
}

/** The line without the terms a panel owns for `field`: its plain values, its ranges and its "contains". */
export function stripField(input: string, field: string): string {
  const own = new Set<Role>(['value', 'values', 'min', 'max', 'has']);
  return joinUnits(scanField(input, field).filter((s) => !own.has(s.role)).map((s) => s.unit));
}

/**
 * Put `term` for `field` in the line, replacing the field's earlier terms of the same sort (an
 * earlier "is", "at least", "at most", "contains" or "starts with"). "Is not" only ever adds, and a
 * negation or bracket group already there stays.
 */
export function setFieldTerm(input: string, field: string, term: string): string {
  const m = FIELD_TERM.exec(term);
  const op = m && !m[1] ? m[3] : '';
  const replaces: Role[] = op === ':' ? ['value', 'values'] : op === '>=' || op === '>' ? ['min'] : op === '<=' || op === '<' ? ['max'] : op === '~' ? ['has'] : op === '^' ? ['starts'] : [];
  const keep = scanField(input, field)
    .filter((s) => !replaces.includes(s.role))
    .map((s) => s.unit);
  return joinUnits(keep.includes(term) ? keep : [...keep, term]);
}

export interface FieldState {
  /** Values chosen with `field:value`; `(blank)` for `field:empty`. */
  values: string[];
  min: string;
  max: string;
  /** `>` rather than `>=`, `<` rather than `<=`. */
  minStrict: boolean;
  maxStrict: boolean;
  has: string;
  /** Units about this field the panel cannot show; they stay in the line as they are. */
  others: string[];
}

const NONE: FieldState = { values: [], min: '', max: '', minStrict: false, maxStrict: false, has: '', others: [] };

/** What the Filters panel shows for one field, read back from the line. */
export function fieldState(input: string, field: string): FieldState {
  const st: FieldState = { ...NONE, values: [], others: [] };
  for (const s of scanField(input, field)) {
    if (s.role === 'value' || s.role === 'values' || s.role === 'mixed') st.values.push(...s.vals);
    else if (s.role === 'min') [st.min, st.minStrict] = [s.vals[0]!, !!s.strict];
    else if (s.role === 'max') [st.max, st.maxStrict] = [s.vals[0]!, !!s.strict];
    else if (s.role === 'has') st.has = s.vals[0]!;
    else if (s.role === 'other' || s.role === 'starts') st.others.push(s.unit);
  }
  return st;
}

/**
 * The panel's pick written into the line: one value is `f:v`, several are `(f:a | f:b)`. A value
 * ticked inside a bracket group that also asks about something else is unticked by taking it out
 * of that group; every unit the panel does not own is kept as it is.
 */
export function setField(input: string, field: string, st: Omit<FieldState, 'others' | 'minStrict' | 'maxStrict'> & Partial<Pick<FieldState, 'minStrict' | 'maxStrict'>>): string {
  const want = new Set(st.values.map((v) => v.toLowerCase()));
  const kept: string[] = [];
  const inGroups = new Set<string>();
  for (const s of scanField(input, field)) {
    if (s.role === 'value' || s.role === 'values' || s.role === 'min' || s.role === 'max' || s.role === 'has') continue;
    if (s.role !== 'mixed') {
      kept.push(s.unit);
      continue;
    }
    const alts = s.alts!.filter((a) => {
      const lit = a.length === 1 ? literalValue(a[0]!, field.toLowerCase()) : null;
      if (lit === null) return true;
      if (!want.has(lit.toLowerCase())) return false;
      inGroups.add(lit.toLowerCase());
      return true;
    });
    if (alts.length === 1) kept.push(alts[0]!.join(' '));
    else if (alts.length > 1) kept.push(`(${alts.map((a) => a.join(' ')).join(' | ')})`);
  }
  const add: string[] = [];
  const vs = st.values.filter((v) => !inGroups.has(v.toLowerCase())).map((v) => (v === '(blank)' ? `${field}:empty` : `${field}:${quoteValue(v)}`));
  if (vs.length === 1) add.push(vs[0]!);
  else if (vs.length > 1) add.push(`(${vs.join(' | ')})`);
  if (st.min !== '') add.push(`${field}${st.minStrict ? '>' : '>='}${st.min}`);
  if (st.max !== '') add.push(`${field}${st.maxStrict ? '<' : '<='}${st.max}`);
  if (st.has !== '') add.push(`${field}~${quoteValue(st.has)}`);
  return joinUnits([...kept, ...add]);
}

/** A bound as typed in a panel box: `30`, `>30` (strict) or `>=30`. Null when it is not a number. */
export function parseBound(text: string, side: 'min' | 'max'): { v: string; strict: boolean } | null {
  const t = text.trim();
  if (t === '') return { v: '', strict: false };
  const m = (side === 'min' ? /^(>=|>)?\s*(-?\d+(?:\.\d+)?)$/ : /^(<=|<)?\s*(-?\d+(?:\.\d+)?)$/).exec(t);
  return m ? { v: m[2]!, strict: m[1] === '>' || m[1] === '<' } : null;
}

/** The bound as a box shows it: the number, with `>` or `<` in front when the line says "over" or "under". */
export function boundText(v: string, strict: boolean, side: 'min' | 'max'): string {
  return v !== '' && strict ? `${side === 'min' ? '>' : '<'}${v}` : v;
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

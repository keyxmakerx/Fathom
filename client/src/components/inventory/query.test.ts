import { describe, expect, it } from 'vitest';

import {
  compileQuery,
  boundText,
  globMatcher,
  parseBound,
  fieldState,
  parseQuery,
  readQuery,
  removeUnit,
  setField,
  setFieldTerm,
  stripField,
  tokenize,
  units,
  type FieldSpec,
  type Probe,
} from './query';

const FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'site', label: 'Site' },
  { key: 'length', label: 'Length (m)', numeric: true },
  { key: 'label', label: 'Label' },
  { key: 'a.role', label: 'One end: what it is' },
  { key: 'b.role', label: 'Other end: what it is' },
  { key: 'tags', label: 'Tags' },
];

interface Row {
  [k: string]: string | string[];
}
const probe = (row: Row): Probe => ({
  values: (f) => {
    const v = row[f];
    return v === undefined ? [''] : Array.isArray(v) ? v : [v];
  },
  number: (f) => {
    const v = row[f];
    const x = Array.isArray(v) ? v[0] : v;
    return x === undefined || x === '' || !Number.isFinite(Number(x)) ? undefined : Number(x);
  },
  text: () => Object.values(row).flat().join(' '),
});

function run(q: string, rows: Row[]): Row[] {
  const parsed = parseQuery(q, FIELDS, 'cables');
  expect(parsed.errors).toEqual([]);
  const keep = compileQuery(parsed.terms, FIELDS);
  return rows.filter((r) => keep(probe(r)));
}

const ROWS: Row[] = [
  { name: 'lon1-core1', role: 'Switch', site: 'LON1', length: '', label: '', tags: ['core', 'prod'] },
  { name: 'lon1-fw1', role: 'Firewall', site: 'LON1', length: '12', label: 'C-10001', tags: [] },
  { name: 'man1-sw01', role: 'Switch', site: 'MAN1', length: '40', label: 'C-10002', tags: ['prod'] },
  { name: 'man1-ap001', role: 'Access point', site: 'MAN1', length: '85', label: '', tags: [] },
];
const names = (rs: Row[]) => rs.map((r) => r.name);

describe('tokens', () => {
  it('splits words, brackets and bars, and keeps quoted spaces', () => {
    expect(tokenize('role:switch (a.role:x | b.role:x) -site:LON1 name:"my box"')).toEqual([
      'role:switch', '(', 'a.role:x', '|', 'b.role:x', ')', '-site:LON1', 'name:"my box"',
    ]);
  });
  it('reads -( as a negated bracket', () => {
    expect(tokenize('-(a:b | c:d)')).toEqual(['-(', 'a:b', '|', 'c:d', ')']);
  });
});

describe('operators', () => {
  it('field:value is equals, any case', () => {
    expect(names(run('role:switch', ROWS))).toEqual(['lon1-core1', 'man1-sw01']);
  });
  it('field!=value is not equals', () => {
    expect(names(run('role!=switch', ROWS))).toEqual(['lon1-fw1', 'man1-ap001']);
  });
  it('field~text contains', () => {
    expect(names(run('name~sw', ROWS))).toEqual(['man1-sw01']);
  });
  it('field^text starts with', () => {
    expect(names(run('name^lon1', ROWS))).toEqual(['lon1-core1', 'lon1-fw1']);
  });
  it('> < >= <= compare numbers and skip blanks', () => {
    expect(names(run('length>12', ROWS))).toEqual(['man1-sw01', 'man1-ap001']);
    expect(names(run('length<40', ROWS))).toEqual(['lon1-fw1']);
    expect(names(run('length>=40', ROWS))).toEqual(['man1-sw01', 'man1-ap001']);
    expect(names(run('length<=12', ROWS))).toEqual(['lon1-fw1']);
  });
  it('a numeric field equals by number', () => {
    expect(names(run('length:40', ROWS))).toEqual(['man1-sw01']);
  });
  it('* is a wildcard in the value', () => {
    expect(names(run('name:lon1-*', ROWS))).toEqual(['lon1-core1', 'lon1-fw1']);
    expect(names(run('name:*1', ROWS))).toEqual(['lon1-core1', 'lon1-fw1', 'man1-sw01', 'man1-ap001']);
  });
  it('empty and any', () => {
    expect(names(run('label:empty', ROWS))).toEqual(['lon1-core1', 'man1-ap001']);
    expect(names(run('label:any', ROWS))).toEqual(['lon1-fw1', 'man1-sw01']);
    expect(names(run('label!=empty', ROWS))).toEqual(['lon1-fw1', 'man1-sw01']);
  });
  it('a leading - negates any term', () => {
    expect(names(run('-site:LON1', ROWS))).toEqual(['man1-sw01', 'man1-ap001']);
    expect(names(run('-length>12', ROWS))).toEqual(['lon1-core1', 'lon1-fw1']);
    expect(names(run('-label:empty', ROWS))).toEqual(['lon1-fw1', 'man1-sw01']);
  });
  it('bare words match any text, and can be negated', () => {
    expect(names(run('core1', ROWS))).toEqual(['lon1-core1']);
    expect(names(run('man1 -ap', ROWS))).toEqual(['man1-sw01']);
    expect(names(run('*', ROWS))).toHaveLength(4);
  });
  it('a multi-valued field matches if any value does, and != only if none do', () => {
    expect(names(run('tags:prod', ROWS))).toEqual(['lon1-core1', 'man1-sw01']);
    expect(names(run('tags!=core', ROWS))).toEqual(['lon1-fw1', 'man1-sw01', 'man1-ap001']);
  });
  it('spaces mean and', () => {
    expect(names(run('role:switch site:MAN1', ROWS))).toEqual(['man1-sw01']);
  });
});

describe('groups', () => {
  it('(a | b) is either', () => {
    expect(names(run('(role:firewall | site:MAN1)', ROWS))).toEqual(['lon1-fw1', 'man1-sw01', 'man1-ap001']);
  });
  it('a group ands with the rest of the line', () => {
    expect(names(run('length>20 (role:switch | role:firewall)', ROWS))).toEqual(['man1-sw01']);
  });
  it('terms inside one alternative are and-ed', () => {
    expect(names(run('(role:switch site:MAN1 | role:firewall)', ROWS))).toEqual(['lon1-fw1', 'man1-sw01']);
  });
  it('groups nest', () => {
    expect(names(run('(site:LON1 (role:firewall | role:access) | name:man1-sw01)', ROWS))).toEqual(['lon1-fw1', 'man1-sw01']);
  });
  it('-( ) negates the whole group', () => {
    expect(names(run('-(role:switch | role:firewall)', ROWS))).toEqual(['man1-ap001']);
  });
  it('the either-end question on a cable', () => {
    const cables: Row[] = [
      { name: 'x1', 'a.role': 'Server', 'b.role': 'Switch' },
      { name: 'x2', 'a.role': 'Server', 'b.role': 'Server' },
      { name: 'x3', 'a.role': 'Switch', 'b.role': 'Firewall' },
    ];
    expect(names(run('(a.role:switch | b.role:switch)', cables))).toEqual(['x1', 'x3']);
  });
});

describe('errors name the bad term', () => {
  const errs = (q: string) => parseQuery(q, FIELDS, 'cables').errors;
  it('an unknown field, with the nearest real one', () => {
    const e = errs('rol:switch');
    expect(e).toHaveLength(1);
    expect(e[0]!.raw).toBe('rol:switch');
    expect(e[0]!.message).toContain('rol:switch');
    expect(e[0]!.message).toContain('“rol”');
    expect(e[0]!.message).toContain('Did you mean role?');
  });
  it('a number operator with a word', () => {
    const e = errs('length>long');
    expect(e[0]!.raw).toBe('length>long');
    expect(e[0]!.message).toContain('“long” is not a number');
  });
  it('a missing value', () => {
    const e = errs('role:');
    expect(e[0]!.raw).toBe('role:');
    expect(e[0]!.message).toContain('give “role:” a value');
  });
  it('a bracket never closed', () => {
    expect(errs('(role:switch | role:router')[0]!.message).toContain('not closed');
  });
  it('a stray closing bracket', () => {
    const e = errs('role:switch )');
    expect(e[0]!.raw).toBe(')');
  });
  it('a bar outside brackets', () => {
    const e = errs('role:switch | role:router');
    expect(e[0]!.raw).toBe('|');
    expect(e[0]!.message).toContain('inside brackets');
  });
  it('a pasted MAC is a bad field, and quoting it makes it text', () => {
    expect(errs('aa:bb:cc:dd:ee:ff')[0]!.message).toContain('aa:bb:cc:dd:ee:ff');
    expect(errs('"aa:bb:cc:dd:ee:ff"')).toEqual([]);
  });
  it('the good terms still run when one is bad', () => {
    const p = parseQuery('role:switch rol:x', FIELDS);
    expect(p.terms).toHaveLength(1);
    expect(p.errors).toHaveLength(1);
  });
});

describe('reading as', () => {
  const read = (q: string) =>
    readQuery(parseQuery(q, FIELDS).terms, (f) => FIELDS.find((x) => x.key === f)?.label ?? f);
  it('says each operator in words', () => {
    expect(read('role:switch')).toBe('Role is switch');
    expect(read('role!=switch')).toBe('Role is not switch');
    expect(read('name~sw')).toBe('Name contains sw');
    expect(read('name^lon')).toBe('Name starts with lon');
    expect(read('length>30')).toBe('Length (m) over 30');
    expect(read('length>=30')).toBe('Length (m) at least 30');
    expect(read('length<5')).toBe('Length (m) under 5');
    expect(read('length<=5')).toBe('Length (m) at most 5');
    expect(read('label:empty')).toBe('Label is empty');
    expect(read('label:any')).toBe('Label is filled in');
    expect(read('-site:LON1')).toBe('not: Site is LON1');
    expect(read('core')).toBe('anything containing “core”');
  });
  it('joins terms with and, and groups with or', () => {
    expect(read('role:switch (site:LON1 | site:MAN1)')).toBe('Role is switch, and any of Site is LON1 or Site is MAN1');
  });
});

describe('editing the line', () => {
  it('lists top-level units, groups whole', () => {
    expect(units('role:switch (a.role:x | b.role:x) -site:LON1')).toEqual(['role:switch', '(a.role:x | b.role:x)', '-site:LON1']);
  });
  it('removes one unit', () => {
    expect(removeUnit('role:switch (a.role:x | b.role:x) site:LON1', 1)).toBe('role:switch site:LON1');
  });
  it('strips a field, and groups made only of it', () => {
    expect(stripField('role:switch (site:LON1 | site:MAN1) name~x', 'site')).toBe('role:switch name~x');
    expect(stripField('(role:switch | site:LON1)', 'site')).toBe('(role:switch | site:LON1)');
  });
  it('replaces a field term', () => {
    expect(setFieldTerm('role:switch site:LON1', 'site', 'site:MAN1')).toBe('role:switch site:MAN1');
  });
  it('reads the panel state back from the line', () => {
    const st = fieldState('(role:switch | role:"Access point") length>=10 length<=50 name~sw', 'role');
    expect(st.values).toEqual(['switch', 'Access point']);
    const l = fieldState('length>=10 length<=50', 'length');
    expect([l.min, l.max]).toEqual(['10', '50']);
    expect(fieldState('name~sw', 'name').has).toBe('sw');
    expect(fieldState('label:empty', 'label').values).toEqual(['(blank)']);
  });
  it('writes the panel state into the line and reads the same back', () => {
    const q = setField('site:LON1', 'role', { values: ['Switch', 'Access point'], min: '', max: '', has: '' });
    expect(q).toBe('site:LON1 (role:Switch | role:"Access point")');
    expect(fieldState(q, 'role').values).toEqual(['Switch', 'Access point']);
    const r = setField(q, 'length', { values: [], min: '10', max: '50', has: 'x' });
    expect(r).toBe('site:LON1 (role:Switch | role:"Access point") length>=10 length<=50 length~x');
    expect(setField(r, 'role', { values: [], min: '', max: '', has: '' })).toBe('site:LON1 length>=10 length<=50 length~x');
  });
});

describe('wildcards are linear, not a regular expression', () => {
  it('matches the usual shapes, any case', () => {
    expect(globMatcher('lon1-*-tor1')('LON1-a03-tor1')).toBe(true);
    expect(globMatcher('lon1-*-tor1')('lon1-a03-tor2')).toBe(false);
    expect(globMatcher('*core*')('xx-Core-1')).toBe(true);
    expect(globMatcher('a*')('')).toBe(false);
    expect(globMatcher('*')('')).toBe(true);
  });

  it('name:****************x is quick over a batch of long rows (runs of * fold to one)', () => {
    const rows: Row[] = Array.from({ length: 5000 }, (_, i) => ({ name: `${'a'.repeat(200)}${i}`, role: '', site: '', length: '', label: '', tags: [] }));
    const parsed = parseQuery('name:****************x', FIELDS);
    expect(parsed.errors).toEqual([]);
    const keep = compileQuery(parsed.terms, FIELDS);
    const t0 = performance.now();
    const hits = rows.filter((r) => keep(probe(r))).length;
    expect(performance.now() - t0).toBeLessThan(50);
    expect(hits).toBe(0);
  });

  it('many separate wildcards over a long text cannot freeze it', () => {
    const rows: Row[] = Array.from({ length: 2000 }, () => ({ name: 'a'.repeat(300), role: '', site: '', length: '', label: '', tags: [] }));
    const parsed = parseQuery('name:a*a*a*a*a*a*a*a*a*a*b', FIELDS);
    const keep = compileQuery(parsed.terms, FIELDS);
    const t0 = performance.now();
    rows.filter((r) => keep(probe(r)));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('refuses a value with more wildcards than it should, naming the term', () => {
    const q = `name:${'a*'.repeat(30)}`;
    const parsed = parseQuery(q, FIELDS);
    expect(parsed.terms).toEqual([]);
    expect(parsed.errors[0]!.message.startsWith(q)).toBe(true);
  });
});

describe('!=, quotes and number comparisons on text', () => {
  it('!= honours a wildcard', () => {
    expect(names(run('name!=lon1*', ROWS))).toEqual(['man1-sw01', 'man1-ap001']);
    expect(names(run('name!=*-sw01', ROWS))).toEqual(['lon1-core1', 'lon1-fw1', 'man1-ap001']);
  });
  it('!= is the negation of :, so role!=any is the blank ones and role!=empty the filled ones', () => {
    const rows: Row[] = [{ name: 'a', role: 'Switch' }, { name: 'b', role: '' }];
    expect(names(run('role!=any', rows))).toEqual(['b']);
    expect(names(run('role!=empty', rows))).toEqual(['a']);
    expect(names(run('-role:any', rows))).toEqual(['b']);
  });
  it('reads a != on a number as numbers', () => {
    expect(names(run('length!=12', ROWS))).toEqual(['lon1-core1', 'man1-sw01', 'man1-ap001']);
  });
  it('an unclosed quote is an error that names the term', () => {
    const p = parseQuery('role:switch name:"core 1', FIELDS);
    expect(p.terms).toHaveLength(1);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.raw).toBe('name:"core 1');
    expect(p.errors[0]!.message.startsWith('name:"core 1:')).toBe(true);
    expect(p.errors[0]!.message).toContain('quote');
  });
  it('an unclosed quote on a bare word is an error too', () => {
    const p = parseQuery('"core', FIELDS);
    expect(p.terms).toEqual([]);
    expect(p.errors[0]!.message.startsWith('"core:')).toBe(true);
  });
  it('name>3 on a text field is an error that names the term', () => {
    const p = parseQuery('name>3 length>3', FIELDS);
    expect(p.terms).toHaveLength(1);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.message.startsWith('name>3:')).toBe(true);
    expect(p.errors[0]!.message).toContain('text');
  });
});

describe('the panel never drops or rewrites a term it cannot show', () => {
  const write = (q: string, field: string, patch: Partial<ReturnType<typeof fieldState>>) => setField(q, field, { ...fieldState(q, field), ...patch });

  it('keeps a negation when Name contains is set', () => {
    expect(write('-name:lon1-core1', 'name', { has: 'lon' })).toBe('-name:lon1-core1 name~lon');
    expect(fieldState('-name:lon1-core1', 'name').others).toEqual(['-name:lon1-core1']);
  });
  it('keeps a negated group when a value is ticked', () => {
    expect(write('-(role:a | role:b)', 'role', { values: ['server'] })).toBe('-(role:a | role:b) role:server');
    expect(fieldState('-(role:a | role:b)', 'role').values).toEqual([]);
  });
  it('unticks a value inside a bracket group by taking it out of the group', () => {
    const q = '(role:switch | site:LON1)';
    expect(fieldState(q, 'role').values).toEqual(['switch']);
    expect(write(q, 'role', { values: [] })).toBe('site:LON1');
    expect(write('(role:switch | role:router | site:LON1)', 'role', { values: ['router'] })).toBe('(role:router | site:LON1)');
  });
  it('keeps strict > and adds a max next to it', () => {
    expect(write('length>30', 'length', { max: '100', maxStrict: false })).toBe('length>30 length<=100');
    expect(write('length>=30 length<50', 'length', { min: '10' })).toBe('length>=10 length<50');
    expect(fieldState('length>30 length<=100', 'length')).toMatchObject({ min: '30', minStrict: true, max: '100', maxStrict: false });
  });
  it('leaves != , ^ , wildcards and a second range term alone', () => {
    expect(write('role!=switch', 'role', { values: ['firewall'] })).toBe('role!=switch role:firewall');
    expect(write('name^lon', 'name', { has: 'core' })).toBe('name^lon name~core');
    expect(write('name:lon*', 'name', { has: 'x' })).toBe('name:lon* name~x');
    expect(fieldState('length>1 length>2', 'length').others).toEqual(['length>2']);
  });
  it('still replaces its own earlier picks', () => {
    expect(write('role:switch site:LON1', 'role', { values: ['firewall', 'server'] })).toBe('site:LON1 (role:firewall | role:server)');
    expect(write('role:switch', 'role', { values: [] })).toBe('');
  });
  it('a typed condition replaces the same sort of term and keeps the rest', () => {
    expect(setFieldTerm('-name:lon1-core1 name~sw', 'name', 'name~lon')).toBe('-name:lon1-core1 name~lon');
    expect(setFieldTerm('length>30', 'length', 'length<=100')).toBe('length>30 length<=100');
    expect(setFieldTerm('length>30', 'length', 'length>=40')).toBe('length>=40');
    expect(setFieldTerm('name!=a', 'name', 'name!=b')).toBe('name!=a name!=b');
    expect(setFieldTerm('name!=a', 'name', 'name!=a')).toBe('name!=a');
  });
  it('counts scope by stripping only what the panel owns', () => {
    expect(stripField('-name:x name~y name:z', 'name')).toBe('-name:x');
  });
});

describe('bounds typed in the panel', () => {
  it('reads 30, >30 and >=30, and refuses words', () => {
    expect(parseBound('30', 'min')).toEqual({ v: '30', strict: false });
    expect(parseBound(' >30', 'min')).toEqual({ v: '30', strict: true });
    expect(parseBound('>=30', 'min')).toEqual({ v: '30', strict: false });
    expect(parseBound('<100', 'max')).toEqual({ v: '100', strict: true });
    expect(parseBound('', 'max')).toEqual({ v: '', strict: false });
    expect(parseBound('abc', 'min')).toBeNull();
    expect(parseBound('<5', 'min')).toBeNull();
  });
  it('shows a strict bound with its sign, so the panel reads back what the line says', () => {
    expect(boundText('30', true, 'min')).toBe('>30');
    expect(boundText('100', false, 'max')).toBe('100');
  });
});

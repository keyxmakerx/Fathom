// The filter line: one query (query.ts) with chips, "Reading as" in plain words, suggestions while
// typing, "?" for every field and operator, and a Filters panel that writes into the line and reads
// back from it. The line is the truth; the chips, the panel and the column menus only edit it.

import { useEffect, useMemo, useRef, useState } from 'react';

import { BLANK, PANEL_LIMIT, distinctOf, type Distinct } from './facets';
import type { InvRow } from './kinds';
import { OPERATOR_HELP, boundText, fieldState, parseBound, readQuery, removeUnit, setField, stripField, units, type Parsed } from './query';
import { filterRows, type QuerySchema } from './rowQuery';
import { applySuggestion, suggestAt, type Suggestion } from './suggest';

export interface FilterLineProps {
  q: string;
  onQ: (q: string) => void;
  schema: QuerySchema;
  /** The list before the line applies (after Where): what counts are counted from. */
  rows: readonly InvRow[];
  parsed: Parsed;
  kindLabel: string;
}

const fmt = (n: number): string => n.toLocaleString('en-GB');

export function FilterLine(props: FilterLineProps) {
  const { q, onQ, schema, rows, parsed, kindLabel } = props;
  const [open, setOpen] = useState<'help' | 'panel' | null>(null);
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [at, setAt] = useState(-1);
  const input = useRef<HTMLInputElement | null>(null);
  const afterRender = useRef<number | null>(null);

  const cache = useMemo(() => new Map<string, Distinct>(), [rows, schema]);
  const valuesOf = (field: string): Distinct => {
    let d = cache.get(field);
    if (!d) {
      d = distinctOf(rows, schema, field);
      cache.set(field, d);
    }
    return d;
  };

  const sugg = useMemo(() => (focused && open === null && q.trim() !== '' ? suggestAt(q, cursor, schema.fields, valuesOf) : null), [focused, open, q, cursor, schema, cache]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (afterRender.current !== null && input.current) {
      input.current.setSelectionRange(afterRender.current, afterRender.current);
      setCursor(afterRender.current);
      afterRender.current = null;
    }
  });

  const pick = (item: Suggestion) => {
    if (!sugg) return;
    const done = applySuggestion(q, sugg, item);
    afterRender.current = done.cursor;
    setAt(item.isField ? 0 : -1);
    onQ(done.line);
    input.current?.focus();
  };

  const insertField = (field: string) => {
    const base = q.replace(/\s+$/, '');
    const next = `${base ? `${base} ` : ''}${field}:`;
    afterRender.current = next.length;
    setOpen(null);
    setAt(0);
    onQ(next);
    input.current?.focus();
  };

  const unitsOf = units(q);
  const badRaw = new Set(parsed.errors.map((e) => e.raw));
  const reading = readQuery(parsed.terms, schema.labelOf);

  return (
    <div className="inv-fq">
      <div className="inv-fq__line">
        <label className="inv-fq__field">
          <span className="inv-fq__label">Filter</span>
          <input
            ref={input}
            type="text"
            spellCheck={false}
            autoComplete="off"
            aria-label={`Filter ${kindLabel.toLowerCase()}`}
            aria-autocomplete="list"
            aria-expanded={sugg !== null}
            placeholder="e.g. role:switch site:LON1"
            value={q}
            onChange={(e) => {
              setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
              setAt(/\S$/.test(e.currentTarget.value.slice(0, e.currentTarget.selectionStart ?? 0)) ? 0 : -1);
              onQ(e.currentTarget.value);
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 120)}
            onKeyDown={(e) => {
              if (e.key === '?') {
                e.preventDefault();
                setOpen(open === 'help' ? null : 'help');
                return;
              }
              if (!sugg) {
                if (e.key === 'ArrowDown' && open === null) {
                  setAt(0);
                  setFocused(true);
                }
                return;
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setAt(Math.max(0, Math.min(sugg.items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
              } else if ((e.key === 'Enter' || e.key === 'Tab') && at >= 0 && sugg.items[at]) {
                e.preventDefault();
                pick(sugg.items[at]!);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setFocused(false);
              }
            }}
          />
          {q ? (
            <button type="button" className="inv-fq__x" aria-label="Clear filter" onClick={() => onQ('')}>
              ✕
            </button>
          ) : null}
        </label>
        <button type="button" className="inv-fq__help" aria-expanded={open === 'help'} aria-label="How to filter: every field and what to type" title="Every field and what to type" onClick={() => setOpen(open === 'help' ? null : 'help')}>
          ?
        </button>
        <button type="button" className="inv-fq__more" aria-expanded={open === 'panel'} onClick={() => setOpen(open === 'panel' ? null : 'panel')}>
          Filters {open === 'panel' ? '▴' : '▾'}
        </button>
      </div>

      {sugg ? (
        <div className="inv-sugg" role="listbox" aria-label="Suggestions">
          <div className="inv-sugg__head">{sugg.head}</div>
          {sugg.items.map((it, i) => (
            <div
              key={it.insert}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'inv-sugg__item inv-sugg__item--at' : 'inv-sugg__item'}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(it);
              }}
            >
              <span className="inv-sugg__main">{it.main}</span>
              {it.hint ? <span className="inv-sugg__hint">{it.hint}</span> : null}
              <span className="inv-sugg__grow" />
              {it.count != null ? <span className="inv-sugg__n">{fmt(it.count)}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {open === 'help' ? <Help schema={schema} rows={rows} valuesOf={valuesOf} kindLabel={kindLabel} onField={insertField} onClose={() => setOpen(null)} /> : null}
      {open === 'panel' ? <Panel q={q} onQ={onQ} schema={schema} rows={rows} kindLabel={kindLabel} onClose={() => setOpen(null)} /> : null}

      {q ? (
        <div className="inv-fq__chips">
          {unitsOf.map((u, i) => (
            <span key={`${u}:${i}`} className={`inv-chip${u.startsWith('(') || u.startsWith('-(') ? ' inv-chip--group' : ''}${badRaw.has(u) ? ' inv-chip--bad' : ''}`} title={parsed.errors.find((e) => e.raw === u)?.message}>
              <span className="inv-chip__text">{u}</span>
              <button type="button" aria-label={`Remove ${u}`} onClick={() => onQ(removeUnit(q, i))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {parsed.errors.length > 0 ? (
        <div className="inv-fq__errors" role="alert">
          {parsed.errors.map((e, i) => (
            <div key={`${e.raw}:${i}`}>{e.message}</div>
          ))}
        </div>
      ) : reading ? (
        <div className="inv-fq__reading">
          Reading as: <b>{reading}</b>
        </div>
      ) : null}
    </div>
  );
}

function Help(props: { schema: QuerySchema; rows: readonly InvRow[]; valuesOf: (f: string) => Distinct; kindLabel: string; onField: (f: string) => void; onClose: () => void }) {
  const { schema, valuesOf, kindLabel, onField, onClose } = props;
  return (
    <div className="inv-fp inv-fhelp" id="inv-fhelp">
      <div className="inv-fp__head">
        <b>How to filter {kindLabel.toLowerCase()}</b>
        <span className="inv-fp__note">Click a field to start it in the line. Spaces mean “and”.</span>
        <span className="inv-fp__grow" />
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="inv-fhelp__cols">
        <table className="inv-fht">
          <thead>
            <tr>
              <th>Field</th>
              <th>Means</th>
              <th>For example</th>
            </tr>
          </thead>
          <tbody>
            {schema.fields.map((f) => {
              const dv = valuesOf(f.key);
              const real = dv.keys.filter((k) => k !== BLANK);
              const ex = f.numeric ? `a number, e.g. ${f.key}>${real[Math.floor(real.length / 2)] ?? 1}` : `${real.slice(0, 3).join(', ')}${dv.n > 3 ? ` … ${fmt(dv.n)} values` : ''}`;
              return (
                <tr key={f.key}>
                  <td>
                    <button type="button" className="inv-fht__field" onClick={() => onField(f.key)}>
                      {f.key}
                    </button>
                  </td>
                  <td>{f.label}</td>
                  <td className="inv-fht__eg">{ex}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <table className="inv-fht">
          <thead>
            <tr>
              <th>Write</th>
              <th>Means</th>
              <th>For example</th>
            </tr>
          </thead>
          <tbody>
            {OPERATOR_HELP.map((o) => (
              <tr key={o.write}>
                <td className="inv-fht__op">{o.write}</td>
                <td>{o.means}</td>
                <td className="inv-fht__op inv-fht__eg">{o.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Panel(props: { q: string; onQ: (q: string) => void; schema: QuerySchema; rows: readonly InvRow[]; kindLabel: string; onClose: () => void }) {
  const { q, onQ, schema, rows, kindLabel, onClose } = props;
  const cards = useMemo(
    () =>
      schema.fields.map((f) => {
        const others = stripField(q, f.key);
        const scoped = others === '' ? rows : filterRows(rows, schema, others).rows;
        return { f, dv: distinctOf(scoped, schema, f.key) };
      }),
    [q, rows, schema],
  );
  const write = (field: string, patch: Partial<ReturnType<typeof fieldState>>) => onQ(setField(q, field, { ...fieldState(q, field), ...patch }));
  return (
    <div className="inv-fp" id="inv-fpanel">
      <div className="inv-fp__head">
        <b>Filters</b>
        <span className="inv-fp__note">Every field on {kindLabel.toLowerCase()}. Picks write into the filter line above, and the line writes back here. Counts follow your other filters.</span>
        <span className="inv-fp__grow" />
        <button type="button" className="inv-fp__link" onClick={() => onQ('')}>
          Clear all
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="inv-fp__grid">
        {cards.map(({ f, dv }) => {
          const st = fieldState(q, f.key);
          const on = st.values.length > 0 || st.min !== '' || st.max !== '' || st.has !== '' || st.others.length > 0;
          const lower = new Set(dv.keys.map((k) => k.toLowerCase()));
          const keys = [...st.values.filter((v) => !lower.has(v.toLowerCase())), ...dv.keys];
          return (
            <div key={f.key} className={`inv-fp__card${on ? ' inv-fp__card--on' : ''}`}>
              <div className="inv-fp__label">
                <span>{f.label}</span>
                <span className="inv-fp__key">{f.key}</span>
              </div>
              {f.numeric ? (
                <div className="inv-fp__range">
                  <input type="text" inputMode="decimal" aria-label={`${f.label} from`} placeholder="from" defaultValue={boundText(st.min, st.minStrict, 'min')} key={`min:${st.min}:${st.minStrict}`} onBlur={(e) => { const b = parseBound(e.currentTarget.value, 'min'); if (b) write(f.key, { min: b.v, minStrict: b.strict }); else e.currentTarget.value = boundText(st.min, st.minStrict, 'min'); }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
                  <span>to</span>
                  <input type="text" inputMode="decimal" aria-label={`${f.label} to`} placeholder="to" defaultValue={boundText(st.max, st.maxStrict, 'max')} key={`max:${st.max}:${st.maxStrict}`} onBlur={(e) => { const b = parseBound(e.currentTarget.value, 'max'); if (b) write(f.key, { max: b.v, maxStrict: b.strict }); else e.currentTarget.value = boundText(st.max, st.maxStrict, 'max'); }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
                </div>
              ) : dv.n > PANEL_LIMIT ? (
                <input type="text" className="inv-fp__has" aria-label={`${f.label} contains`} placeholder={`contains… (${fmt(dv.n)} values)`} defaultValue={st.has} key={`has:${st.has}`} onBlur={(e) => write(f.key, { has: e.currentTarget.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
              ) : (
                <div className={`inv-fp__vals${keys.length > 6 ? ' inv-fp__vals--long' : ''}`}>
                  {keys.map((k) => {
                    const checked = st.values.some((v) => v.toLowerCase() === k.toLowerCase());
                    return (
                      <label key={k}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const values = checked ? st.values.filter((v) => v.toLowerCase() !== k.toLowerCase()) : [...st.values, k];
                            write(f.key, { values });
                          }}
                        />
                        <span className="inv-fp__val">{k}</span>
                        <span className="inv-fp__n">{fmt(dv.counts.get(k) ?? 0)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {st.others.length > 0 ? (
                <p className="inv-fp__kept">
                  Also in the line, left as it is: <code>{st.others.join(' ')}</code>
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "Find anything": one box above everything. It says how it read the clue, jumps when exactly one
// thing matches, and otherwise lists what matched by kind. Where narrows it and the note says what
// Where hid. Reading is search.ts; nothing here decides what matches.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { placeText, whereText, type Where } from './placeIndex';
import { search, type Hit, type Outcome, type SearchIndex } from './search';

const SHOWN = 6;

export interface FindBoxProps {
  /** Built when the box is first used; null until then. */
  index: SearchIndex | null;
  arm: () => void;
  value: string;
  onValue: (v: string) => void;
  where: Where;
  onOpen: (hit: Hit) => void;
  onClearWhere: () => void;
  /** Where the results are drawn: just below the Where bar, so the bar stays in view. */
  slot?: HTMLElement | null;
}

export function FindBox({ index, arm, value, onValue, where, onOpen, onClearWhere, slot }: FindBoxProps) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(-1);
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const outcome = useMemo(() => (index ? search(index, value, where) : null), [index, value, where]);
  const flat = useMemo(() => {
    if (!outcome) return [];
    return outcome.groups.flatMap((g) => (more.has(g.kind) ? g.hits : g.hits.slice(0, SHOWN)));
  }, [outcome, more]);

  useEffect(() => {
    setAt(-1);
    setMore(new Set());
  }, [value, where]);

  // "/" focuses the box from anywhere that is not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      input.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current && !box.current.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, []);

  const choose = (h: Hit) => {
    setOpen(false);
    onOpen(h);
  };

  const escape = () => {
    if (value) onValue(afterEscape().value);
    setOpen(afterEscape().open);
    input.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      escape();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setAt((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((a) => Math.max(-1, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!outcome) return;
      if (at >= 0 && flat[at]) choose(flat[at]!);
      else if (outcome.jump) choose(outcome.jump);
      else if (flat.length) {
        setOpen(true);
        setAt(0);
      }
    }
  };

  const results = panelVisible(open, value, outcome) ? (
    <FindResults outcome={outcome} where={where} at={at} more={more} onMore={(k) => setMore(new Set([...more, k]))} onChoose={choose} onClearWhere={onClearWhere} panelRef={panel} />
  ) : null;
  return (
    <div
      className="inv-find"
      ref={box}
      role="search"
      onKeyDown={(e) => {
        // Esc inside the results (not only the input) also puts the list back.
        if (e.key === 'Escape' && e.target !== input.current && panel.current?.contains(e.target as Node)) escape();
      }}
    >
      <div className="inv-find__line">
        <label className="inv-find__field">
          <span className="inv-find__label">Find</span>
          <input
            ref={input}
            type="text"
            aria-label="Find anything"
            placeholder="cable label, MAC, IP, device and port, serial, rack, name"
            value={value}
            autoComplete="off"
            spellCheck={false}
            onFocus={() => {
              arm();
              setOpen(true);
            }}
            onChange={(e) => {
              arm();
              onValue(e.currentTarget.value);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        {value ? (
          <button type="button" className="inv-find__x" aria-label="Clear the search" onClick={() => onValue('')}>
            ✕
          </button>
        ) : (
          <kbd className="inv-find__key" aria-hidden="true">
            /
          </kbd>
        )}
      </div>
      {slot ? null : results}
      {slot && results ? createPortal(results, slot) : null}
    </div>
  );
}

/** The results panel shows only while the box is open and holds a clue; clearing it brings the list back. */
export function panelVisible(open: boolean, value: string, outcome: Outcome | null): outcome is Outcome {
  return open && value.trim() !== '' && outcome !== null;
}

/** What Esc does to the box: the clue goes, the panel closes, the list is whole again. */
export function afterEscape(): { value: ''; open: false } {
  return { value: '', open: false };
}

export interface FindResultsProps {
  outcome: Outcome;
  where: Where;
  at: number;
  more: ReadonlySet<string>;
  onMore: (kind: string) => void;
  onChoose: (h: Hit) => void;
  onClearWhere: () => void;
  panelRef?: React.Ref<HTMLDivElement>;
}

/** "Reading as", then the hits grouped by kind with counts. */
export function FindResults({ outcome, where, at, more, onMore, onChoose, onClearWhere, panelRef }: FindResultsProps) {
  let n = -1;
  return (
    <div className="inv-find__panel" role="listbox" aria-label="Search results" ref={panelRef}>
      <p className="inv-find__reading">
        Reading as: <b>{outcome.reading || '…'}</b>
      </p>
      {outcome.groups.map((g) => (
        <section key={g.kind} className="inv-find__group">
          <h4>
            {g.label} <span className="inv-find__n">{g.hits.length}</span>
          </h4>
          {(more.has(g.kind) ? g.hits : g.hits.slice(0, SHOWN)).map((h) => {
            n += 1;
            const i = n;
            const place = h.row.places?.[0];
            return (
              <button key={h.row.key} type="button" role="option" aria-selected={i === at} className={`inv-find__hit${i === at ? ' inv-find__hit--at' : ''}`} onClick={() => onChoose(h)}>
                <span className="inv-find__title">{h.row.title}</span>
                <span className="inv-find__why">{h.why}</span>
                {place ? <span className="inv-find__place">{placeText(place)}</span> : null}
              </button>
            );
          })}
          {!more.has(g.kind) && g.hits.length > SHOWN ? (
            <button type="button" className="inv-find__more" onClick={() => onMore(g.kind)}>
              Show all {g.hits.length}
            </button>
          ) : null}
        </section>
      ))}
      {outcome.total === 0 ? <p className="inv-find__none">Nothing found{outcome.outside > 0 ? ' here' : ''}.</p> : null}
      {outcome.outside > 0 ? (
        <p className="inv-find__outside">
          {outcome.outside} more outside {whereText(where)}.{' '}
          <button type="button" onClick={onClearWhere}>
            Clear Where
          </button>
        </p>
      ) : null}
      {outcome.jump ? <p className="inv-find__foot">Enter opens it.</p> : outcome.total > 1 ? <p className="inv-find__foot">Arrow keys to choose, Enter to open.</p> : null}
    </div>
  );
}

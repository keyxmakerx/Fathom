// Steward › Order types (ADR-0084 decisions 1, 5 to 8, 15; sign-off r103). Every order type is
// one YAML file a Steward can read, change, download and share. The page shows it three ways —
// the board, the file, and the questions it asks — all from the same checked file, and checks it
// on the server as it is typed. Saving makes a new version; open orders keep theirs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  checkOrderType,
  fetchOrderType,
  fetchOrderTypes,
  saveOrderType,
  saveRefusal,
  type CheckAnswer,
  type OrderType,
  type OrderTypeLine,
  type TeamNames,
} from '../../api/orders';
import { addJob, addStage, moveJob, moveStage, type Edit } from './boardEdit';
import { OrderBoard, type BoardEdit } from './OrderBoard';
import { KIND_WORDS, fileNameOf, matchTeams, setIdOf, setsUsed, whenWords } from './orderModel';
import { BLANK, STARTERS, STARTER_SETS } from './starters';
import './orders.css';

/** How long typing pauses before the file is checked again. */
export const CHECK_PAUSE_MS = 500;

type Editing = { id: string | null; version: number; source: string; fieldSets: string[]; teams: Record<string, string>; from: string };
type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Pure: the shared field set files to send with a file: the ones it uses, from what it was
 * saved with first, then from the ones Fathom ships. */
export function setsFor(source: string, saved: readonly string[]): string[] {
  const byId = new Map<string, string>();
  for (const s of saved) {
    const id = setIdOf(s);
    if (id) byId.set(id, s);
  }
  return setsUsed(source)
    .map((id) => byId.get(id) ?? STARTER_SETS[id])
    .filter((s): s is string => typeof s === 'string');
}

export function OrderTypesPage({ organisationId }: { organisationId: string }) {
  const [list, setList] = useState<Load<{ steward: boolean; types: OrderTypeLine[] }>>({ status: 'loading' });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchOrderTypes(organisationId).then(
      (value) => setList({ status: 'ready', value }),
      (e: unknown) => setList({ status: 'error', message: message(e) }),
    );
  }, [organisationId]);
  useEffect(reload, [reload]);

  const openType = (id: string) => {
    setNotice(null);
    fetchOrderType(organisationId, id).then(
      (t: OrderType) => setEditing({ id: t.id, version: t.version, source: t.source, fieldSets: t.fieldSets, teams: t.teams, from: t.name }),
      (e: unknown) => setNotice(`Could not open it: ${message(e)}`),
    );
  };
  const start = (source: string, from: string) => {
    setNotice(null);
    setEditing({ id: null, version: 0, source, fieldSets: [], teams: {}, from });
  };

  if (editing) {
    return (
      <TypeEditor
        key={`${editing.id ?? 'new'}-${editing.version}`}
        organisationId={organisationId}
        editing={editing}
        savedNote={savedNote}
        onBack={() => {
          setEditing(null);
          setSavedNote(null);
          reload();
        }}
        onSaved={(t) => {
          setEditing({ id: t.id, version: t.version, source: t.source, fieldSets: t.fieldSets, teams: t.teams, from: t.name });
          setSavedNote(`Saved as version ${t.version}. Orders already open keep the version they were opened from.`);
          setNotice(null);
        }}
      />
    );
  }

  return (
    <section className="org-page order-types" data-testid="order-types-page">
      <div className="org-page__title">Order types</div>
      <p className="order-types__lead">
        An order type is the questions an order asks and the stages its work goes through, each job given to one team. Each one is a file you
        can read, change, download and share. Anyone in the organisation opens an order from the Work tab.
      </p>
      {notice ? (
        <p className="home__error" role="alert">
          {notice}
        </p>
      ) : null}
      {list.status === 'loading' ? <p className="home__muted">Loading…</p> : null}
      {list.status === 'error' ? (
        <p className="home__error" role="alert">
          Could not load the order types: {list.message}
        </p>
      ) : null}
      {list.status === 'ready' && !list.value.steward ? <p className="home__muted">Only a Steward of the whole organisation writes order types.</p> : null}
      {list.status === 'ready' && list.value.types.length > 0 ? (
        <table className="order-types__table" data-testid="order-types-list">
          <thead>
            <tr>
              <th>Order type</th>
              <th>Code</th>
              <th>Version</th>
              <th>Saved</th>
              <th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {list.value.types.map((t) => (
              <tr key={t.id}>
                <td>
                  <button type="button" className="org-link" onClick={() => openType(t.id)}>
                    {t.name}
                  </button>
                </td>
                <td className="order-types__mono">{t.code ?? '—'}</td>
                <td className="order-types__mono">{t.version}</td>
                <td>{whenWords(t.savedAt)}</td>
                <td>
                  <button type="button" className="btn-small" onClick={() => openType(t.id)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {list.status === 'ready' && list.value.steward ? <NewTypeChoices empty={list.value.types.length === 0} onStart={start} /> : null}
    </section>
  );
}

function NewTypeChoices({ empty, onStart }: { empty: boolean; onStart: (source: string, from: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="order-types__new" data-testid="order-types-new">
      <div className="work__label">{empty ? 'No order types yet. Start from one of these' : 'Start another'}</div>
      <div className="order-types__starters">
        {STARTERS.map((s) => (
          <button key={s.id} type="button" className="order-types__starter" onClick={() => onStart(s.source, s.name)} data-testid={`starter-${s.id}`}>
            <span className="order-types__starter-name">{s.name}</span>
            <span className="org-sub">{s.draft ? 'Starter · a draft to check against a real order' : 'Starter'}</span>
          </button>
        ))}
        <button type="button" className="order-types__starter" onClick={() => onStart(BLANK, 'a blank order type')}>
          <span className="order-types__starter-name">A blank one</span>
          <span className="org-sub">One stage and one job to build from</span>
        </button>
        <button type="button" className="order-types__starter" onClick={() => fileInput.current?.click()}>
          <span className="order-types__starter-name">Bring in a file…</span>
          <span className="org-sub">A .yaml order type someone shared</span>
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".yaml,.yml,text/yaml,text/plain"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!file) return;
          if (file.size > 256 * 1024) {
            setProblem('That file is larger than an order type may be (256 KB).');
            return;
          }
          void file.text().then((text) => onStart(text, file.name));
        }}
      />
      {problem ? (
        <p className="home__error" role="alert">
          {problem}
        </p>
      ) : null}
      <p className="org-sub">Nothing is saved until you save it. A file that is brought in is shown and checked first; its teams are matched to yours before it can be saved.</p>
    </div>
  );
}

type Tab = 'board' | 'file' | 'fields';

function TypeEditor({
  organisationId,
  editing,
  savedNote,
  onBack,
  onSaved,
}: {
  organisationId: string;
  editing: Editing;
  savedNote: string | null;
  onBack: () => void;
  onSaved: (t: OrderType) => void;
}) {
  const [source, setSource] = useState(editing.source);
  const [tab, setTab] = useState<Tab>('board');
  const [check, setCheck] = useState<Load<CheckAnswer>>({ status: 'loading' });
  const [picked, setPicked] = useState<Record<string, string>>(editing.teams);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [lastGood, setLastGood] = useState<CheckAnswer | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [checkedSource, setCheckedSource] = useState<string | null>(null);
  const [boardNote, setBoardNote] = useState<string | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const changed = source !== editing.source || JSON.stringify(picked) !== JSON.stringify(editing.teams);

  const fieldSets = useMemo(() => setsFor(source, editing.fieldSets), [source, editing.fieldSets]);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      checkOrderType(organisationId, source, fieldSets).then(
        (value) => {
          if (!live) return;
          setCheck({ status: 'ready', value });
          setCheckedSource(source);
          if (value.definition) setLastGood(value);
        },
        (e: unknown) => live && setCheck({ status: 'error', message: message(e) }),
      );
    }, CHECK_PAUSE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [organisationId, source, fieldSets]);

  const answer = check.status === 'ready' ? check.value : null;
  const shown = answer?.definition ? answer : lastGood;
  const teams: TeamNames = shown?.teams ?? {};
  const matched = shown ? matchTeams(shown.slugs, teams, picked) : {};
  const unmatched = Object.entries(matched).filter(([, id]) => id === null).map(([slug]) => slug);
  const problems = answer?.problems ?? [];
  const missingSets = setsUsed(source).filter((id) => !fieldSets.some((s) => setIdOf(s) === id));
  const canSave = answer !== null && answer.definition !== null && unmatched.length === 0 && missingSets.length === 0 && !saving && (changed || editing.id === null);

  const save = () => {
    setSaving(true);
    setSaveProblem(null);
    const teamsToSend: Record<string, string> = {};
    for (const [slug, id] of Object.entries(matched)) if (id) teamsToSend[slug] = id;
    saveOrderType(organisationId, { id: editing.id, source, fieldSets, teams: teamsToSend }).then(
      (t) => {
        setSaving(false);
        onSaved(t);
      },
      (e: unknown) => {
        setSaving(false);
        const r = saveRefusal(e);
        setSaveProblem(
          r.kind === 'problems'
            ? `The file has ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}; see the File tab.`
            : r.kind === 'unmatched'
              ? `Match ${r.slugs.join(', ')} to one of your teams first.`
              : r.kind === 'secret'
                ? 'Something in the file reads like a password or key, so it was not saved.'
                : r.message,
        );
      },
    );
  };

  // The board edits the file only while what it shows is this very text checked (r142): its lines are the file's.
  const boardDef = answer?.definition && checkedSource === source ? answer.definition : null;
  const fromBoard = (e: Edit) => {
    if (!e.ok) {
      setBoardNote(e.why);
      return;
    }
    setBoardNote(null);
    if (e.source === source) return;
    setUndo(source);
    setSource(e.source);
  };
  const boardEdit: BoardEdit | null = boardDef
    ? {
        moveJob: (line, to) => fromBoard(moveJob(source, boardDef, line, to)),
        moveStage: (line, to) => fromBoard(moveStage(source, boardDef, line, to)),
        addJob: (stageLine) => fromBoard(addJob(source, boardDef, stageLine)),
        addStage: (laneLine) => fromBoard(addStage(source, boardDef, laneLine)),
      }
    : null;

  const download = () => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameOf(source);
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const status =
    check.status === 'loading'
      ? 'Checking…'
      : check.status === 'error'
        ? `Could not check it: ${check.message}`
        : problems.length > 0
          ? `${problems.length} problem${problems.length === 1 ? '' : 's'} in the file`
          : unmatched.length > 0
            ? `${unmatched.length} team${unmatched.length === 1 ? '' : 's'} to match`
            : 'Checks out';
  const good = check.status === 'ready' && problems.length === 0 && unmatched.length === 0;
  const title = shown?.definition?.name ?? editing.from;

  return (
    <section className="org-page order-type" data-testid="order-type-editor">
      <div className="order-type__crumbs">
        <button type="button" className="order-type__crumb" onClick={onBack}>
          Order types
        </button>{' '}
        › {title}
        {editing.id ? <span className="order-type__version"> · version {editing.version}</span> : <span className="order-type__version"> · not saved yet</span>}
      </div>
      <div className="order-type__bar">
        <span className={good ? 'order-type__status order-type__status--good' : 'order-type__status'} role="status" data-testid="order-type-status">
          {good ? '✓ ' : ''}
          {status}
        </span>
        <span className="order-type__spacer" />
        <button type="button" className="btn-quiet" onClick={download}>
          Download file
        </button>
        <button type="button" className="btn-main" disabled={!canSave} onClick={save} data-testid="order-type-save">
          {saving ? 'Saving…' : editing.id ? `Save as version ${editing.version + 1}` : 'Save as version 1'}
        </button>
      </div>
      {saveProblem ? (
        <p className="home__error" role="alert">
          {saveProblem}
        </p>
      ) : null}
      {savedNote && !changed ? (
        <p className="order-type__saved" role="status">
          {savedNote}
        </p>
      ) : null}
      {missingSets.length > 0 ? (
        <p className="home__error" role="alert">
          The file uses a shared field set Fathom doesn’t have: {missingSets.join(', ')}. Paste its fields into the file, or bring in the file it came with.
        </p>
      ) : null}

      {shown && shown.slugs.length > 0 ? (
        <TeamMatching slugs={shown.slugs} teams={teams} matched={matched} onPick={(slug, id) => setPicked({ ...picked, [slug]: id })} />
      ) : null}

      <div className="order-type__tabs" role="tablist" aria-label="Order type">
        {(
          [
            ['board', 'Board'],
            ['file', 'File'],
            ['fields', `Asks for · ${shown?.definition?.fields.length ?? 0}`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'order-type__tab order-type__tab--on' : 'order-type__tab'} onClick={() => setTab(k)}>
            {label}
            {k === 'file' && problems.length > 0 ? <span className="order-type__count"> {problems.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'board' ? (
        shown?.definition ? (
          <>
            {problems.length > 0 ? <p className="org-sub">The file has problems now; the board shows it as it last checked out.</p> : null}
            {boardNote ? (
              <p className="home__error" role="alert" data-testid="board-note">
                {boardNote}
              </p>
            ) : null}
            <OrderBoard
              definition={shown.definition}
              teams={teams}
              matched={matched}
              edit={boardEdit}
              onPick={(line) => {
                setFocusLine(line);
                setTab('file');
              }}
            />
            <p className="org-sub">
              Drag a job to another stage or place, or a stage along its lane (or use Alt and the arrow keys); + Job and + Stage add one. Each change rewrites the file, keeping everything else in it, and
              the board redraws from the file’s check. Choose a job to see it in the file, to rename it or say more.
              {undo !== null ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => {
                      setSource(undo);
                      setUndo(null);
                      setBoardNote(null);
                    }}
                    data-testid="board-undo"
                  >
                    Undo the last change
                  </button>
                </>
              ) : null}
            </p>
          </>
        ) : (
          <p className="home__muted">{check.status === 'loading' ? 'Checking…' : 'The file has problems, so there is nothing to draw yet. See the File tab.'}</p>
        )
      ) : null}
      {tab === 'file' ? <FileTab source={source} onChange={(v) => { setSource(v); setUndo(null); }} problems={problems} focusLine={focusLine} onFocused={() => setFocusLine(null)} /> : null}
      {tab === 'fields' && shown?.definition ? <FieldsTab answer={shown} /> : null}
      <p className="org-sub">Saving makes a new version. Orders already open carry on with the version they were opened from.</p>
    </section>
  );
}

function TeamMatching({
  slugs,
  teams,
  matched,
  onPick,
}: {
  slugs: readonly string[];
  teams: TeamNames;
  matched: Record<string, string | null>;
  onPick: (slug: string, id: string) => void;
}) {
  const options = Object.entries(teams).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return (
    <div className="order-type__teams" data-testid="order-type-teams">
      <div className="work__label">Teams</div>
      <p className="org-sub">Each job in the file names a team by a short name. Match each one to a team of yours; a job is given to exactly one team.</p>
      <div className="order-type__team-rows">
        {slugs.map((slug) => (
          <label key={slug} className="order-type__team-row">
            <span className="order-types__mono">{slug}</span>
            <select value={matched[slug] ?? ''} onChange={(e) => onPick(slug, e.currentTarget.value)} aria-label={`Team for ${slug}`}>
              <option value="">Not matched yet</option>
              {options.map(([id, t]) => (
                <option key={id} value={id}>
                  {t.name}
                </option>
              ))}
            </select>
            {matched[slug] === null ? <span className="order-type__unmatched">Needs a team</span> : null}
          </label>
        ))}
      </div>
      {options.length === 0 ? <p className="org-sub">This organisation has no teams yet. Make them under Teams first.</p> : null}
    </div>
  );
}

function FileTab({
  source,
  onChange,
  problems,
  focusLine,
  onFocused,
}: {
  source: string;
  onChange: (s: string) => void;
  problems: readonly { line: number; message: string }[];
  focusLine: number | null;
  onFocused: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = source.split('\n').length;
  const bad = new Set(problems.map((p) => p.line));

  const goTo = useCallback((line: number) => {
    const el = area.current;
    if (!el) return;
    const rows = el.value.split('\n');
    const start = rows.slice(0, line - 1).reduce((n, r) => n + r.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (rows[line - 1]?.length ?? 0));
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.scrollTop = Math.max(0, (line - 4) * lineHeight);
  }, []);

  useEffect(() => {
    if (focusLine !== null) {
      goTo(focusLine);
      onFocused();
    }
  }, [focusLine, goTo, onFocused]);

  return (
    <div className="order-file" data-testid="order-file">
      <div className="order-file__box">
        <div className="order-file__gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className={bad.has(i + 1) ? 'order-file__n order-file__n--bad' : 'order-file__n'}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={area}
          className="order-file__text"
          value={source}
          spellCheck={false}
          wrap="off"
          aria-label="The order type, as a file"
          onChange={(e) => onChange(e.currentTarget.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      {problems.length > 0 ? (
        <ul className="order-file__problems" aria-label="Problems" data-testid="order-file-problems">
          {problems.map((p, i) => (
            <li key={i}>
              <button type="button" className="order-link" onClick={() => goTo(p.line)}>
                Line {p.line}
              </button>{' '}
              {p.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="org-sub">The file reads cleanly. It only describes the order: nothing in it ever runs.</p>
      )}
    </div>
  );
}

function FieldsTab({ answer }: { answer: CheckAnswer }) {
  const def = answer.definition;
  if (!def) return null;
  const askedBy = new Map<string, string>();
  for (const l of def.lanes) for (const s of l.stages) for (const j of s.jobs) for (const k of j.asks) askedBy.set(k, j.name);
  return (
    <table className="order-types__table" data-testid="order-type-fields">
      <thead>
        <tr>
          <th>Question</th>
          <th>Kind</th>
          <th>Asked</th>
          <th>From</th>
        </tr>
      </thead>
      <tbody>
        {def.fields.map((f) => (
          <tr key={f.key}>
            <td>
              {f.label}
              {f.required ? <span className="org-sub"> · needed</span> : null}
              {f.help ? <div className="org-sub">{f.help}</div> : null}
            </td>
            <td>
              {KIND_WORDS[f.kind]}
              {f.kind === 'prefix' && f.family && f.size !== null ? ` (${f.family === 'ipv4' ? 'IPv4' : 'IPv6'} /${f.size})` : ''}
              {f.choices.length > 0 ? <div className="org-sub">{f.choices.join(', ')}</div> : null}
            </td>
            <td>{askedBy.has(f.key) ? `By ${askedBy.get(f.key)}` : f.when ? 'When the order opens, for some orders' : 'When the order opens'}</td>
            <td>{f.fromSet ? `Shared set · ${f.fromSet}` : 'This order type'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

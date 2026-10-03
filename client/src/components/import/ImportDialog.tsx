// Bring a file in (round 9): drop it, say which columns are which, check the counts, import. Three
// steps: 1 Drop (detect), 2 Match (map), 3 Check (preview). The file is read here in the browser and
// goes nowhere else; every value passes the redaction gate before the plan is made. The whole
// import is one undo step. The host saves the document `onApply` hands back.

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import type { CatalogueModel } from '../../api/catalogue';
import type { FieldFor, FieldType } from '../../api/fieldDefinitions';
import type { FieldDefView } from '../../document/fields';
import type { Document } from '../../document/model';
import { applyPlan, importLabel, type ApplyResult, type Pick } from '../../import/apply';
import { gateTable } from '../../import/gate';
import { ImportRefusal } from '../../import/limits';
import {
  CORE_KEYS,
  CORE_LABEL,
  NEW_FIELD_TYPES,
  SECRET_REASON,
  defaultMapping,
  looksLikeSecret,
  mappingErrors,
  newFieldFor,
  sampleOf,
  type Mapping,
  type NewFieldType,
  type Target,
} from '../../import/mapping';
import { buildPlan, choiceKey, holdChangedConflicts, type Bucket, type Plan, type PlanItem } from '../../import/plan';
import { readFile } from '../../import/read';
import type { GatedTable } from '../../import/table';
import { oneLine } from '../../import/text';
import './import.css';

export interface ImportSummary {
  fileName: string;
  created: number;
  placed: number;
  filled: number;
  overwritten: number;
  newFields: number;
  refused: string[];
}

export interface ImportDialogProps {
  /** The open design. */
  doc: Document;
  catalogue: readonly CatalogueModel[];
  /** The organisation's field definitions (`useFieldDefinitions().defs`), kept current by the host. */
  fieldDefs: readonly FieldDefView[];
  /** `useFieldDefinitions().create`: makes a shared field for the organisation. */
  createField: (kind: FieldFor, name: string, type: FieldType) => Promise<{ refused: string } | void>;
  /** The wasm redaction gate, as PasteDialog takes it. */
  redact: (text: string) => Promise<string>;
  /** The signed-in account, so the import is the person's own undo step. */
  actor?: string;
  /** False for a reader: nothing can be imported. */
  canDraw?: boolean;
  /** The finished document; the host passes it to `applyDocChange`. */
  onApply: (doc: Document, summary: ImportSummary) => void;
  onCancel: () => void;
}

type Step = 'drop' | 'match' | 'check' | 'done';

const STEPS: ReadonlyArray<{ key: Exclude<Step, 'done'>; label: string }> = [
  { key: 'drop', label: '1 · Drop' },
  { key: 'match', label: '2 · Match' },
  { key: 'check', label: '3 · Check' },
];

const WHAT_HAPPENS: Record<Exclude<Bucket, 'skipped'>, { label: string; text: string }> = {
  new: { label: 'New', text: 'Added, placed in their racks' },
  match: { label: 'Match', text: 'Same name and no clash: blanks filled in, nothing overwritten' },
  differ: { label: 'Differ', text: 'Yours vs the file, side by side; you pick' },
  nomodel: { label: 'No model', text: 'Added as free boxes' },
};

const LIST_LIMIT = 100;

function targetValue(t: Target): string {
  return t.kind === 'core' ? `core:${t.key}` : t.kind === 'field' ? `field:${t.defId}` : t.kind;
}

function messageOf(e: unknown, fallback: string): string {
  return e instanceof ImportRefusal ? e.message : e instanceof Error && e.message ? e.message : fallback;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function ImportDialog(props: ImportDialogProps) {
  const { doc, catalogue, fieldDefs, createField, redact, actor, canDraw = true, onApply, onCancel } = props;
  const [step, setStep] = useState<Step>('drop');
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<GatedTable | null>(null);
  const [mapping, setMapping] = useState<Mapping>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [choices, setChoices] = useState<ReadonlyMap<string, Pick>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The host's definitions and document move on while we wait for the server; read the latest.
  const latest = useRef({ doc, fieldDefs });
  useEffect(() => {
    latest.current = { doc, fieldDefs };
  }, [doc, fieldDefs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const errors = useMemo(() => (table ? mappingErrors(table, mapping, fieldDefs) : []), [table, mapping, fieldDefs]);
  const liveDefs = useMemo(() => fieldDefs.filter((d) => d.appliesTo === 'device' && !d.archived).sort((a, b) => a.name.localeCompare(b.name)), [fieldDefs]);

  // Without a signed-in account the import would not be the person's own undo step: refuse.
  const canImport = actor !== undefined && actor !== '';

  const take = async (file: File | undefined) => {
    if (!file || busy || !canImport) return;
    setError(null);
    setTable(null);
    setFileName(oneLine(file.name).slice(0, 100));
    setBusy('Reading the file…');
    let raw;
    try {
      raw = await readFile(file);
    } catch (e) {
      setError(messageOf(e, 'This file could not be read.'));
      setBusy(null);
      return;
    }
    try {
      const total = raw.rows.length * raw.headers.length;
      setBusy(`Passing ${total.toLocaleString()} values through the redaction gate…`);
      const gated = await gateTable(raw, redact, {
        onProgress: (done, all) => setBusy(`Passing values through the redaction gate… ${Math.round((done / Math.max(all, 1)) * 100)}%`),
      });
      setTable(gated);
      setMapping(defaultMapping(gated, latest.current.fieldDefs));
    } catch (e) {
      setError(`The redaction gate could not run, so nothing was read. ${messageOf(e, '')}`.trim());
    }
    setBusy(null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take(e.dataTransfer.files[0]);
  };

  const setTarget = (i: number, value: string) => {
    if (!table) return;
    setMapping((m) => {
      const next = m.slice();
      if (value === 'ignore') next[i] = { kind: 'ignore' };
      else if (value.startsWith('core:')) next[i] = { kind: 'core', key: value.slice(5) as (typeof CORE_KEYS)[number] };
      else if (value.startsWith('field:')) next[i] = { kind: 'field', defId: value.slice(6) };
      else next[i] = newFieldFor(table, i);
      return next;
    });
  };

  const patchNew = (i: number, patch: Partial<{ name: string; type: NewFieldType }>) =>
    setMapping((m) => m.map((t, j) => (j === i && t.kind === 'new' ? { ...t, ...patch } : t)));

  const toCheck = () => {
    if (!table) return;
    try {
      setPlan(buildPlan(table, mapping, { doc: latest.current.doc, catalogue, defs: latest.current.fieldDefs }));
      setChoices(new Map());
      setError(null);
      setStep('check');
    } catch (e) {
      setError(messageOf(e, 'The rows could not be sorted.'));
    }
  };

  const importable = plan ? plan.counts.new + plan.counts.match + plan.counts.differ + plan.counts.nomodel : 0;

  const run = async () => {
    if (!table || !plan || busy || !canImport) return;
    setError(null);
    const made: string[] = [];
    try {
      // 1. Shared fields the file introduced, made for the whole organisation first. One that now
      // exists by that name (an earlier try, or a colleague) is used instead of making a twin.
      const lower = (s: string) => s.toLowerCase();
      const find = (name: string) => latest.current.fieldDefs.find((d) => d.appliesTo === 'device' && !d.archived && lower(d.name) === lower(name));
      for (const f of plan.newFields) {
        if (find(f.name)) continue;
        setBusy(`Creating the shared field "${f.name}"…`);
        const r = await createField('device', f.name, f.type);
        if (r && 'refused' in r) throw new Error(`The shared field "${f.name}" was refused: ${r.refused} Nothing was imported.`);
        made.push(f.name);
      }
      const fresh: FieldDefView[] = [];
      for (const f of plan.newFields) {
        let def = find(f.name);
        for (let tries = 0; !def && tries < 100; tries += 1) {
          await wait(50);
          def = find(f.name);
        }
        if (!def) throw new Error(`The shared field "${f.name}" was made but has not come back yet. Nothing was imported; try again.`);
        fresh.push(def);
      }
      // 2. Sort the rows again against the design as it is now, then write everything as one step.
      setBusy('Importing…');
      const now = latest.current;
      const finalPlan = buildPlan(table, mapping, { doc: now.doc, catalogue, defs: now.fieldDefs });
      // A Differ row that is not the one the person looked at is left alone and reported.
      const held = holdChangedConflicts(plan, finalPlan);
      const rows = finalPlan.items.filter((i) => i.bucket !== 'skipped').length;
      const result: ApplyResult = await applyPlan(now.doc, finalPlan, {
        choices,
        defs: now.fieldDefs.some((d) => fresh.some((f) => f.id === d.id)) ? now.fieldDefs : [...now.fieldDefs, ...fresh],
        fresh,
        actor,
        label: importLabel(rows),
        onProgress: (done, all) => setBusy(`Importing… ${done} of ${all} rows`),
      });
      const done: ImportSummary = {
        fileName,
        created: result.created,
        placed: result.placed,
        filled: result.filled,
        overwritten: result.overwritten,
        newFields: finalPlan.newFields.length,
        refused: [...held, ...result.refused],
      };
      setSummary(done);
      onApply(result.doc, done);
      setStep('done');
    } catch (e) {
      const kept = made.length > 0 ? ` These shared fields were already created for the organisation and stay: ${made.join(', ')}.` : '';
      setError(`${messageOf(e, 'The import failed, and nothing was imported.')}${kept}`);
    }
    setBusy(null);
  };

  const pickFor = (item: PlanItem): Pick => choices.get(choiceKey(item)) ?? 'mine';
  const setPick = (item: PlanItem, p: Pick) => setChoices((c) => new Map(c).set(choiceKey(item), p));

  const itemsOf = (b: Bucket) => (plan ? plan.items.filter((i) => i.bucket === b) : []);

  return (
    <div className="imp" role="dialog" aria-modal="true" aria-label="Bring a network in">
      <div className="imp__box">
        <ol className="imp__steps" aria-label="Steps">
          {STEPS.map((s) => (
            <li key={s.key} aria-current={step === s.key ? 'step' : undefined} className={step === s.key ? 'imp__step imp__step--on' : 'imp__step'}>
              {s.label}
            </li>
          ))}
        </ol>

        {step === 'drop' ? (
          <section className="imp__body">
            <h2>Bring a network in</h2>
            <div
              className={over ? 'imp__drop imp__drop--over' : 'imp__drop'}
              role="group"
              aria-label="Drop a file here"
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
            >
              <strong>Drop a file here</strong>
              <span className="imp__muted">CSV or spreadsheet · NetBox export · Proxmox (pvesh JSON) · nmap scan (XML)</span>
              <span>
                <button type="button" disabled={busy !== null || !canImport} onClick={() => fileInput.current?.click()}>
                  Choose a file
                </button>
              </span>
              <input
                ref={fileInput}
                type="file"
                hidden
                aria-label="Choose a file"
                accept=".csv,.tsv,.txt,.json,.xml,text/csv,text/tab-separated-values,application/json,text/xml,application/xml"
                onChange={(e) => {
                  void take(e.currentTarget.files?.[0]);
                  e.currentTarget.value = '';
                }}
              />
            </div>
            {!canImport ? <p role="alert" className="imp__error">You are not signed in, so an import could not be undone. Sign in to import.</p> : null}
            {busy ? <p role="status">{busy}</p> : null}
            {error ? <p role="alert" className="imp__error">{error}</p> : null}
            {table && !busy ? (
              <>
                <h3 className="imp__label">Recognised</h3>
                <div className="imp__recognised">
                  <span className="imp__file">{fileName}</span>
                  <span>{table.label}</span>
                </div>
                {table.notes.map((n, i) => (
                  <p key={i} className="imp__muted">{n}</p>
                ))}
                {table.neutralised > 0 ? (
                  <p className="imp__muted">
                    {table.neutralised} {table.neutralised === 1 ? 'value begins' : 'values begin'} with = + - or @, which a spreadsheet would run as a formula. They are kept as text, with a leading '.
                  </p>
                ) : null}
                {table.truncated > 0 ? <p className="imp__muted">{table.truncated} very long values were cut.</p> : null}
              </>
            ) : null}
            <p className="imp__muted">Read in your browser. Every value passes the redaction gate before anything is saved.</p>
            <div className="imp__actions">
              <button type="button" onClick={onCancel} disabled={busy !== null}>
                Cancel
              </button>
              <button type="button" className="imp__primary" disabled={!table || busy !== null} onClick={() => setStep('match')}>
                Match columns
              </button>
            </div>
          </section>
        ) : null}

        {step === 'match' && table ? (
          <section className="imp__body">
            <h2>Match columns · {fileName}</h2>
            <div className="imp__scroll">
              <table className="imp__table" aria-label="Columns">
                <thead>
                  <tr>
                    <th>Column in file</th>
                    <th>Example</th>
                    <th>Fathom field</th>
                  </tr>
                </thead>
                <tbody>
                  {table.headers.map((h, i) => {
                    const t = mapping[i] ?? { kind: 'ignore' as const };
                    const secret = looksLikeSecret(h);
                    return (
                      <tr key={i} className={t.kind === 'new' ? 'imp__row--new' : undefined}>
                        <td>{h}</td>
                        <td className="imp__mono">{sampleOf(table, i).slice(0, 40)}</td>
                        <td>
                          {secret ? (
                            <span className="imp__muted">{SECRET_REASON}</span>
                          ) : (
                          <select aria-label={`Fathom field for ${h}`} value={targetValue(t)} onChange={(e) => setTarget(i, e.currentTarget.value)}>
                            <optgroup label="Fathom">
                              {CORE_KEYS.map((k) => (
                                <option key={k} value={`core:${k}`}>
                                  {CORE_LABEL[k]}
                                </option>
                              ))}
                            </optgroup>
                            {liveDefs.length > 0 ? (
                              <optgroup label="Shared fields">
                                {liveDefs.map((d) => (
                                  <option key={d.id} value={`field:${d.id}`}>
                                    {d.name}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                            <option value="new">New shared field…</option>
                            <option value="ignore">Ignore this column</option>
                          </select>
                          )}
                          {t.kind === 'new' ? (
                            <span className="imp__newfield">
                              <input aria-label={`Name of the new field for ${h}`} value={t.name} onChange={(e) => patchNew(i, { name: e.currentTarget.value })} />
                              <select aria-label={`Type of the new field for ${h}`} value={t.type} onChange={(e) => patchNew(i, { type: e.currentTarget.value as NewFieldType })}>
                                {NEW_FIELD_TYPES.map((x) => (
                                  <option key={x} value={x}>
                                    {x === 'url' ? 'link' : x}
                                  </option>
                                ))}
                              </select>
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {mapping.filter((t) => t.kind === 'new').length > 0 ? (
              <p className="imp__muted">
                {mapping.filter((t) => t.kind === 'new').length} new shared fields will be made for the whole organisation. Undo does NOT remove them. A field in use cannot be deleted, only archived.
              </p>
            ) : null}
            {errors.length > 0 ? (
              <ul role="alert" className="imp__error">
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
            {error ? <p role="alert" className="imp__error">{error}</p> : null}
            <div className="imp__actions">
              <button type="button" onClick={() => setStep('drop')}>
                Back
              </button>
              <button type="button" className="imp__primary" disabled={errors.length > 0} onClick={toCheck}>
                Check
              </button>
            </div>
          </section>
        ) : null}

        {step === 'check' && plan ? (
          <section className="imp__body">
            <h2>Before anything is saved</h2>
            <table className="imp__table" aria-label="Counts">
              <thead>
                <tr>
                  <th />
                  <th>Count</th>
                  <th>What happens</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(WHAT_HAPPENS) as Array<keyof typeof WHAT_HAPPENS>).map((b) => (
                  <tr key={b} className={b === 'differ' && plan.counts.differ > 0 ? 'imp__row--new' : undefined}>
                    <td>{WHAT_HAPPENS[b].label}</td>
                    <td className="imp__mono">{plan.counts[b]}</td>
                    <td>{WHAT_HAPPENS[b].text}</td>
                  </tr>
                ))}
                {plan.counts.skipped > 0 ? (
                  <tr>
                    <td>Left out</td>
                    <td className="imp__mono">{plan.counts.skipped}</td>
                    <td>No usable name, or a repeat of an earlier row</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            {plan.newFields.length > 0 ? (
              <p className="imp__muted">Also made for the organisation, and not removed by Undo: {plan.newFields.map((f) => `${f.name} (${f.type === 'url' ? 'link' : f.type})`).join(', ')}.</p>
            ) : null}
            {plan.warnings > 0 ? <p className="imp__muted">{plan.warnings} values were left out because they do not fit (see below).</p> : null}

            {itemsOf('differ').length > 0 ? (
              <div className="imp__differ">
                <h3>Differ · yours vs the file</h3>
                {itemsOf('differ').slice(0, LIST_LIMIT).map((item) => (
                  <DifferRow key={item.row} item={item} pick={pickFor(item)} onPick={(p) => setPick(item, p)} />
                ))}
                {itemsOf('differ').length > LIST_LIMIT ? <p className="imp__muted">And {itemsOf('differ').length - LIST_LIMIT} more, kept as yours.</p> : null}
              </div>
            ) : null}

            <Names title="Added as free boxes" items={itemsOf('nomodel')} />
            <Names title="Left out" items={itemsOf('skipped')} />
            <Warnings items={plan.items.filter((i) => i.warnings.length > 0)} />

            {error ? <p role="alert" className="imp__error">{error}</p> : null}
            {busy ? <p role="status">{busy}</p> : null}
            <div className="imp__actions">
              <button type="button" className="imp__primary" disabled={busy !== null || importable === 0 || !canDraw || !canImport} onClick={() => void run()}>
                Import {importable}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => setStep('match')}>
                Back
              </button>
            </div>
            <p className="imp__mono imp__muted">One step in history: Undo removes the devices and values{plan.newFields.length > 0 ? ', not the new shared fields' : ''}</p>
          </section>
        ) : null}

        {step === 'done' && summary ? (
          <section className="imp__body">
            <h2>Imported {summary.fileName}</h2>
            <p role="status">
              {summary.created} added ({summary.placed} placed in racks), {summary.filled} blanks filled in, {summary.overwritten} values replaced at your choice
              {summary.newFields > 0 ? `, ${summary.newFields} new shared fields` : ''}. Undo removes the devices and values{summary.newFields > 0 ? ', not the new shared fields' : ''}.
            </p>
            {summary.refused.length > 0 ? (
              <details>
                <summary>{summary.refused.length} things were refused</summary>
                <ul>
                  {summary.refused.slice(0, LIST_LIMIT).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="imp__actions">
              <button type="button" className="imp__primary" onClick={onCancel}>
                Close
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function DifferRow({ item, pick, onPick }: { item: PlanItem; pick: Pick; onPick: (p: Pick) => void }) {
  const group = `pick-${item.row}`;
  return (
    <div className="imp__diff">
      <strong>{item.name}</strong>
      <table className="imp__table" aria-label={`${item.name}: yours and the file's`}>
        <thead>
          <tr>
            <th>Field</th>
            <th>Yours</th>
            <th>The file</th>
          </tr>
        </thead>
        <tbody>
          {item.conflicts.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              <td className="imp__mono">{c.mine}</td>
              <td className="imp__mono">{c.theirs}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="imp__pick">
        <label>
          <input type="radio" name={group} checked={pick === 'mine'} onChange={() => onPick('mine')} /> Keep mine (blanks still filled)
        </label>
        <label>
          <input type="radio" name={group} checked={pick === 'theirs'} onChange={() => onPick('theirs')} /> Use the file&apos;s
        </label>
      </span>
    </div>
  );
}

function Names({ title, items }: { title: string; items: PlanItem[] }) {
  if (items.length === 0) return null;
  return (
    <details className="imp__names">
      <summary>
        {title} · {items.length}
      </summary>
      <ul>
        {items.slice(0, LIST_LIMIT).map((i) => (
          <li key={i.row}>
            <span className="imp__mono">{i.name || `row ${i.row}`}</span> {i.reason ? <span className="imp__muted">{i.reason}</span> : null}
          </li>
        ))}
        {items.length > LIST_LIMIT ? <li className="imp__muted">And {items.length - LIST_LIMIT} more.</li> : null}
      </ul>
    </details>
  );
}

function Warnings({ items }: { items: PlanItem[] }) {
  if (items.length === 0) return null;
  return (
    <details className="imp__names">
      <summary>Values left out · {items.reduce((n, i) => n + i.warnings.length, 0)}</summary>
      <ul>
        {items.slice(0, LIST_LIMIT).flatMap((i) => i.warnings.map((w, k) => (
          <li key={`${i.row}-${k}`}>
            <span className="imp__mono">{i.name}</span> <span className="imp__muted">{w}</span>
          </li>
        )))}
      </ul>
    </details>
  );
}

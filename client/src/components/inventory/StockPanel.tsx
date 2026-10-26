// Spares on hand (ADR-0074, sign-offs r36-stock and r38-stock-how): Inventory, Parts, On hand. What is in stock
// and where it stands, the stores it is kept in, and the fewest of each model to keep. Four ways in: type it,
// paste a list or a device's own `show inventory`, import a CSV, or take a part out of a drawn device. Calls
// `document/stock.ts` directly and hands the result to `applyDocChange`, as the VPN section does.
//
// Who uses it and why (r38): whoever keeps the spares cupboard, to know what is on hand before a swap; whoever
// plans a swap, to keep one for the step; a teacher, to show a lab's spares. Read sees it; Draw edits it.

import { useId, useMemo, useState, type ReactNode } from 'react';

import { readFacts } from '../../document/facts';
import { foldFrom } from '../../document/freeform';
import type { Document } from '../../document/model';
import {
  PART_LABEL,
  STATE_LABEL,
  STOCK_PARTS,
  STOCK_STATES,
  addStock,
  addStore,
  backToSpare,
  belowMinimum,
  itemTitle,
  lend,
  listStock,
  listStores,
  markOnOrder,
  readStockRows,
  removeStock,
  removeStore,
  retire,
  sendToRepair,
  setStockItem,
  setStockLevel,
  setStore,
  stockFromFacts,
  stockFromFitted,
  stockLevels,
  storeView,
  takeFromStock,
  takeOutToStock,
  type NewStock,
  type StockItemView,
  type StockPart,
  type StockState,
} from '../../document/stock';
import { listIssues } from '../../document/issues';
import { buildCanon } from '../checks/checksModel';
import { devicesOf, partsOfDevice } from '../plans/plansModel';
import { getSession } from '../../state/sessionState';
import './stock.css';

function actorOpts(): { actor: string } | undefined {
  const s = getSession();
  return s ? { actor: s.accountId } : undefined;
}

/** Runs an edit; a refusal is shown, never thrown. */
function attempt(apply: () => void, setError: (e: string | null) => void): boolean {
  try {
    apply();
    setError(null);
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

type Show = 'on_hand' | 'on_order' | 'in_repair' | 'lent' | 'retired' | 'all';
const SHOWS: readonly { key: Show; label: string; states: readonly StockState[] | undefined }[] = [
  { key: 'on_hand', label: 'On hand', states: ['spare', 'reserved'] },
  { key: 'on_order', label: 'On order', states: ['on_order'] },
  { key: 'in_repair', label: 'Away for repair', states: ['in_repair'] },
  { key: 'lent', label: 'Lent out', states: ['lent'] },
  { key: 'retired', label: 'Retired', states: ['retired'] },
  { key: 'all', label: 'All', states: undefined },
];

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? 'stock__field stock__field--wide' : 'stock__field'}>
      {label}
      {children}
    </label>
  );
}

/** What the item's state adds to its line: when it is due, who has it, its RMA, what step it is kept for. */
function stateLine(doc: Document, i: StockItemView): string {
  const bits: string[] = [];
  if (i.state === 'lent' && i.lentTo) bits.push(i.lentTo);
  if (i.state === 'in_repair' && i.rma) bits.push(i.rma);
  if (i.due) bits.push(`due ${i.due}`);
  if (i.state === 'reserved' && i.reservedFor) {
    const step = doc.nodes.find((n) => n.id === i.reservedFor);
    const words = step?.fields['PlanStep.change'];
    bits.push(`for: ${words?.presence === 'set' && typeof words.value === 'string' ? words.value.split('\n')[0] : 'a plan step'}`);
  }
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// One item, opened

function ItemDetail({ doc, item, canDraw, apply }: { doc: Document; item: StockItemView; canDraw: boolean; apply: (next: Document) => void }) {
  const stores = listStores(doc);
  const issues = useMemo(() => listIssues(doc).filter((i) => i.stage !== 'closed'), [doc]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: item.name ?? '',
    model: item.model ?? '',
    serial: item.serial ?? '',
    count: String(item.count),
    store: item.storeId ?? '',
    bin: item.bin ?? '',
    note: item.note ?? '',
  });
  const [verb, setVerb] = useState<'' | 'repair' | 'lend' | 'order' | 'take'>('');
  const [extra, setExtra] = useState({ rma: '', due: '', issue: '', to: '', take: '1' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const run = (f: () => Document) => attempt(() => apply(f()), setError);

  if (!canDraw) {
    return (
      <div className="stock__detail">
        {item.cameFrom ? <p className="stock__note">Came from {item.cameFrom}.</p> : null}
        {item.note ? <p className="stock__note">{item.note}</p> : null}
        <p className="stock__note">Read only. Switch to Draw to change stock.</p>
      </div>
    );
  }

  return (
    <div className="stock__detail" data-testid="stock-item-detail">
      <form
        className="stock__grid"
        onSubmit={(e) => {
          e.preventDefault();
          run(() =>
            setStockItem(
              doc,
              item.id,
              {
                name: form.name,
                model: form.model,
                serial: form.serial,
                count: item.serial || form.serial ? undefined : Number(form.count),
                storeId: form.store === '' ? null : form.store,
                bin: form.bin,
                note: form.note,
              },
              actorOpts(),
            ),
          );
        }}
      >
        <Field label="Name">
          <input className="stock__input" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Model or part no.">
          <input className="stock__input stock__input--mono" value={form.model} onChange={(e) => set('model', e.target.value)} />
        </Field>
        <Field label="Serial">
          <input className="stock__input stock__input--mono" value={form.serial} data-scan-target="serial" onChange={(e) => set('serial', e.target.value)} />
        </Field>
        {!form.serial ? (
          <Field label="How many">
            <input className="stock__input stock__input--num" type="number" min={1} value={form.count} onChange={(e) => set('count', e.target.value)} />
          </Field>
        ) : null}
        <Field label="Store">
          <select className="stock__input" value={form.store} onChange={(e) => set('store', e.target.value)}>
            <option value="">No store</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bin">
          <input className="stock__input" value={form.bin} onChange={(e) => set('bin', e.target.value)} placeholder="bin 3" />
        </Field>
        <Field label="Note" wide>
          <input className="stock__input" value={form.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <div className="stock__actions">
          <button type="submit" className="stock__primary">
            Save
          </button>
        </div>
      </form>

      {item.cameFrom ? <p className="stock__note">Came from {item.cameFrom}.</p> : null}

      <div className="stock__verbs" role="group" aria-label="Move it on">
        {item.state !== 'spare' ? (
          <button type="button" onClick={() => run(() => backToSpare(doc, item.id, actorOpts()))}>
            {item.state === 'on_order' ? 'It arrived' : item.state === 'in_repair' ? 'Back from repair' : item.state === 'lent' ? 'Given back' : 'Back in stock'}
          </button>
        ) : null}
        {item.state === 'spare' || item.state === 'reserved' ? (
          <>
            <button type="button" aria-expanded={verb === 'take'} onClick={() => setVerb(verb === 'take' ? '' : 'take')}>
              Used it
            </button>
            <button type="button" aria-expanded={verb === 'lend'} onClick={() => setVerb(verb === 'lend' ? '' : 'lend')}>
              Lend
            </button>
          </>
        ) : null}
        {item.state !== 'in_repair' && item.state !== 'on_order' ? (
          <button type="button" aria-expanded={verb === 'repair'} onClick={() => setVerb(verb === 'repair' ? '' : 'repair')}>
            Send for repair
          </button>
        ) : null}
        {item.state !== 'on_order' ? (
          <button type="button" aria-expanded={verb === 'order'} onClick={() => setVerb(verb === 'order' ? '' : 'order')}>
            On order
          </button>
        ) : null}
        {item.state !== 'retired' ? (
          <button type="button" onClick={() => run(() => retire(doc, item.id, actorOpts()))}>
            Retire
          </button>
        ) : null}
        <button type="button" className="stock__danger" onClick={() => run(() => removeStock(doc, item.id, actorOpts()))}>
          Remove (typed by mistake)
        </button>
      </div>

      {verb === 'repair' ? (
        <form
          className="stock__grid stock__sub-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (run(() => sendToRepair(doc, item.id, { rma: extra.rma, due: extra.due, issueId: extra.issue === '' ? null : extra.issue }, actorOpts()))) setVerb('');
          }}
        >
          <Field label="RMA or ticket no.">
            <input className="stock__input stock__input--mono" value={extra.rma} onChange={(e) => setExtra({ ...extra, rma: e.target.value })} />
          </Field>
          <Field label="Due back">
            <input className="stock__input" type="date" value={extra.due} onChange={(e) => setExtra({ ...extra, due: e.target.value })} />
          </Field>
          {issues.length > 0 ? (
            <Field label="For the issue">
              <select className="stock__input" value={extra.issue} onChange={(e) => setExtra({ ...extra, issue: e.target.value })}>
                <option value="">None</option>
                {issues.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <div className="stock__actions">
            <button type="submit" className="stock__primary">
              Send for repair
            </button>
          </div>
        </form>
      ) : null}
      {verb === 'lend' ? (
        <form
          className="stock__grid stock__sub-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (run(() => lend(doc, item.id, { to: extra.to, due: extra.due, count: item.count > 1 ? Number(extra.take) : undefined }, actorOpts()))) setVerb('');
          }}
        >
          <Field label="Who has it">
            <input className="stock__input" value={extra.to} onChange={(e) => setExtra({ ...extra, to: e.target.value })} />
          </Field>
          <Field label="Due back">
            <input className="stock__input" type="date" value={extra.due} onChange={(e) => setExtra({ ...extra, due: e.target.value })} />
          </Field>
          {item.count > 1 ? (
            <Field label="How many">
              <input className="stock__input stock__input--num" type="number" min={1} max={item.count} value={extra.take} onChange={(e) => setExtra({ ...extra, take: e.target.value })} />
            </Field>
          ) : null}
          <div className="stock__actions">
            <button type="submit" className="stock__primary">
              Lend
            </button>
          </div>
        </form>
      ) : null}
      {verb === 'order' ? (
        <form
          className="stock__grid stock__sub-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (run(() => markOnOrder(doc, item.id, { due: extra.due }, actorOpts()))) setVerb('');
          }}
        >
          <Field label="Due">
            <input className="stock__input" type="date" value={extra.due} onChange={(e) => setExtra({ ...extra, due: e.target.value })} />
          </Field>
          <div className="stock__actions">
            <button type="submit" className="stock__primary">
              Mark on order
            </button>
          </div>
        </form>
      ) : null}
      {verb === 'take' ? (
        <form
          className="stock__grid stock__sub-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (run(() => takeFromStock(doc, item.id, Number(extra.take), actorOpts()))) setVerb('');
          }}
        >
          {item.count > 1 ? (
            <Field label="How many were used">
              <input className="stock__input stock__input--num" type="number" min={1} max={item.count} value={extra.take} onChange={(e) => setExtra({ ...extra, take: e.target.value })} />
            </Field>
          ) : (
            <p className="stock__note">It leaves stock. To fit it in place of a drawn part, use Swap a part in a plan or on the device.</p>
          )}
          <div className="stock__actions">
            <button type="submit" className="stock__primary">
              Take from stock
            </button>
          </div>
        </form>
      ) : null}
      {error ? <p className="stock__error">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list

function ItemRows({ doc, items, canDraw, apply, empty }: { doc: Document; items: StockItemView[]; canDraw: boolean; apply: (next: Document) => void; empty: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const stores = new Map(listStores(doc).map((s) => [s.id, s.name]));
  if (items.length === 0) return <>{empty}</>;
  return (
    <ul className="stock__list" data-testid="stock-list">
      {items.map((i) => (
        <li key={i.id} className="stock__row" data-state={i.state}>
          <button type="button" className="stock__row-head" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>
            <span className="stock__row-name">
              {itemTitle(i)}
              {i.count > 1 ? <span className="stock__count"> × {i.count}</span> : null}
            </span>
            <span>{PART_LABEL[i.part]}</span>
            <span className="stock__mono">{i.serial ?? ''}</span>
            <span>{[i.storeId ? stores.get(i.storeId) : '', i.bin].filter(Boolean).join(' · ')}</span>
            <span>
              <span className={`stock__state stock__state--${i.state}`}>{STATE_LABEL[i.state]}</span> {stateLine(doc, i)}
            </span>
          </button>
          {open === i.id ? <ItemDetail key={i.id} doc={doc} item={i} canDraw={canDraw} apply={apply} /> : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Adding

type Way = 'type' | 'paste' | 'file' | 'device';

function Preview({ rows, skipped, onAdd }: { rows: NewStock[]; skipped: { line: number; why: string }[]; onAdd: () => void }) {
  return (
    <div className="stock__preview">
      {rows.length > 0 ? (
        <>
          <table className="stock__table">
            <thead>
              <tr>
                <th>Sort</th>
                <th>Model</th>
                <th>Serial</th>
                <th>How many</th>
                <th>Name</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, n) => (
                <tr key={n}>
                  <td>{PART_LABEL[r.part]}</td>
                  <td className="stock__mono">{r.model ?? ''}</td>
                  <td className="stock__mono">{r.serial ?? ''}</td>
                  <td>{r.count ?? 1}</td>
                  <td>{r.name ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 50 ? <p className="stock__note">And {rows.length - 50} more.</p> : null}
          <button type="button" className="stock__primary" onClick={onAdd}>
            Add {rows.length} to stock
          </button>
        </>
      ) : (
        <p className="stock__note">Nothing read yet.</p>
      )}
      {skipped.map((s) => (
        <p key={`${s.line}:${s.why}`} className="stock__note">
          Line {s.line}: {s.why}
        </p>
      ))}
    </div>
  );
}

function AddStock({
  doc,
  apply,
  redact,
  onDone,
}: {
  doc: Document;
  apply: (next: Document) => void;
  redact: (text: string) => Promise<string>;
  onDone: (said: string) => void;
}) {
  const stores = listStores(doc);
  const [way, setWay] = useState<Way>('type');
  const [error, setError] = useState<string | null>(null);
  const [store, setStoreId] = useState(stores[0]?.id ?? '');
  const [bin, setBin] = useState('');
  const [state, setState] = useState<StockState>('spare');
  const [one, setOne] = useState({ part: 'optic' as StockPart, model: '', name: '', serial: '', count: '1', type: '', wavelength: '', due: '' });
  const [read, setRead] = useState<{ rows: NewStock[]; skipped: { line: number; why: string }[] } | null>(null);
  const [pasted, setPasted] = useState('');
  const [device, setDevice] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [takeOut, setTakeOut] = useState(true);
  const canon = useMemo(() => buildCanon(doc), [doc]);
  const devices = useMemo(() => devicesOf(doc, canon), [doc, canon]);
  const parts = useMemo(() => (device ? partsOfDevice(doc, canon, device) : []), [doc, canon, device]);
  const ids = { store: useId(), bin: useId(), state: useId() };
  const defaults = { storeId: store === '' ? null : store, bin: bin || undefined, state };

  const addRows = (rows: NewStock[]) =>
    attempt(() => {
      const out = addStock(doc, rows, actorOpts());
      apply(out.doc);
      onDone(rows.length === 1 ? 'Added to stock. One undo step.' : `Added ${rows.length} to stock. One undo step.`);
    }, setError);

  /** A paste goes through the browser's redaction gate first (CLAUDE.md rule 4), then is read; nothing else of it is kept. */
  const readText = async (raw: string) => {
    const clean = await redact(raw);
    const facts = readFacts(clean);
    setRead(facts?.parts?.length ? { rows: stockFromFacts(facts, defaults), skipped: [] } : readStockRows(clean, defaults));
  };

  return (
    <section className="stock__add" aria-label="Add to stock" data-testid="stock-add">
      <div className="stock__ways" role="tablist" aria-label="How">
        {(
          [
            ['type', 'Type it'],
            ['paste', 'Paste a list'],
            ['file', 'Import a file'],
            ['device', 'From a device'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={way === k}
            className="stock__way"
            onClick={() => {
              setWay(k);
              setRead(null);
              setError(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="stock__grid">
        <label className="stock__field" htmlFor={ids.store}>
          Store
          <select id={ids.store} className="stock__input" value={store} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">No store</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="stock__field" htmlFor={ids.bin}>
          Bin
          <input id={ids.bin} className="stock__input" value={bin} onChange={(e) => setBin(e.target.value)} placeholder="bin 3" />
        </label>
        <label className="stock__field" htmlFor={ids.state}>
          It is
          <select id={ids.state} className="stock__input" value={state} onChange={(e) => setState(e.target.value as StockState)}>
            {STOCK_STATES.filter((s) => s !== 'reserved' && s !== 'lent').map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {way === 'type' ? (
        <form
          className="stock__grid"
          onSubmit={(e) => {
            e.preventDefault();
            const row: NewStock = { ...defaults, part: one.part, model: one.model || undefined, name: one.name || undefined, serial: one.serial || undefined };
            if (!one.serial) row.count = Number(one.count);
            if (one.part === 'optic') {
              row.optic = { ...(one.type ? { type: one.type } : {}), ...(one.wavelength ? { wavelengthNm: Number(one.wavelength) } : {}) };
            }
            if (state === 'on_order' && one.due) row.due = one.due;
            if (addRows([row])) setOne({ ...one, serial: '', count: '1' });
          }}
        >
          <Field label="Sort">
            <select className="stock__input" value={one.part} onChange={(e) => setOne({ ...one, part: e.target.value as StockPart })}>
              {STOCK_PARTS.map((p) => (
                <option key={p} value={p}>
                  {PART_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model or part no.">
            <input className="stock__input stock__input--mono" value={one.model} onChange={(e) => setOne({ ...one, model: e.target.value })} placeholder="SFP-10G-SR" />
          </Field>
          <Field label="Serial">
            <input className="stock__input stock__input--mono" value={one.serial} data-scan-target="serial" onChange={(e) => setOne({ ...one, serial: e.target.value })} />
          </Field>
          {!one.serial ? (
            <Field label="How many">
              <input className="stock__input stock__input--num" type="number" min={1} value={one.count} onChange={(e) => setOne({ ...one, count: e.target.value })} />
            </Field>
          ) : null}
          <Field label="Name" wide>
            <input className="stock__input" value={one.name} onChange={(e) => setOne({ ...one, name: e.target.value })} placeholder="Patch lead, Cat6, 2 m, blue" />
          </Field>
          {one.part === 'optic' ? (
            <>
              <Field label="Type">
                <input className="stock__input" value={one.type} onChange={(e) => setOne({ ...one, type: e.target.value })} placeholder="10GBASE-SR" />
              </Field>
              <Field label="Wavelength (nm)">
                <input className="stock__input stock__input--num" type="number" min={1} value={one.wavelength} onChange={(e) => setOne({ ...one, wavelength: e.target.value })} />
              </Field>
            </>
          ) : null}
          {state === 'on_order' ? (
            <Field label="Due">
              <input className="stock__input" type="date" value={one.due} onChange={(e) => setOne({ ...one, due: e.target.value })} />
            </Field>
          ) : null}
          <div className="stock__actions">
            <button type="submit" className="stock__primary">
              Add to stock
            </button>
            <span className="stock__note">A serial makes it one item; without one, give how many.</span>
          </div>
        </form>
      ) : null}

      {way === 'paste' ? (
        <div className="stock__grid">
          <Field label="A list, a spreadsheet's rows, or a device's own show inventory" wide>
            <textarea className="stock__input stock__textarea" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} placeholder={'SFP-10G-SR  AVP19230XYZ\nSFP-10G-SR  AVP19230XZA'} />
          </Field>
          <div className="stock__actions">
            <button type="button" onClick={() => void readText(pasted)}>
              Read it
            </button>
            <span className="stock__note">Read here in the browser; only the rows you add are kept.</span>
          </div>
        </div>
      ) : null}

      {way === 'file' ? (
        <div className="stock__grid">
          <Field label="A CSV or tab-separated file with a header row (Model, Serial, Qty, Bin...)" wide>
            <input
              className="stock__input"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void f.text().then(readText);
              }}
            />
          </Field>
          <p className="stock__note">Columns it does not know, a price or a supplier, are named so you can add them as custom fields.</p>
        </div>
      ) : null}

      {read && (way === 'paste' || way === 'file') ? <Preview rows={read.rows} skipped={read.skipped} onAdd={() => addRows(read.rows)} /> : null}

      {way === 'device' ? (
        <div className="stock__grid">
          <Field label="Device">
            <select
              className="stock__input"
              value={device}
              onChange={(e) => {
                setDevice(e.target.value);
                setPicked(new Set());
              }}
            >
              <option value="">Choose…</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          {device && parts.length === 0 ? <p className="stock__note">This device has no cards, power supplies or optics drawn.</p> : null}
          {parts.length > 0 ? (
            <fieldset className="stock__parts">
              <legend>Parts that come out</legend>
              {parts.map((p) => (
                <label key={p.id} className="stock__check">
                  <input
                    type="checkbox"
                    checked={picked.has(p.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setPicked(next);
                    }}
                  />
                  {p.name}
                </label>
              ))}
              <label className="stock__check">
                <input type="checkbox" checked={takeOut} onChange={(e) => setTakeOut(e.target.checked)} />
                Take them out of the drawing too
              </label>
            </fieldset>
          ) : null}
          {picked.size > 0 ? (
            <div className="stock__actions">
              <button
                type="button"
                className="stock__primary"
                onClick={() =>
                  attempt(() => {
                    let working = doc;
                    const from = doc.batches.length;
                    for (const id of picked) {
                      const opts = { ...actorOpts(), storeId: defaults.storeId, bin: defaults.bin };
                      working = (takeOut ? takeOutToStock(working, id, state, opts) : stockFromFitted(working, id, state, opts)).doc;
                    }
                    apply(foldBatches(working, from, takeOut ? 'take out into stock' : 'into stock'));
                    onDone(`${picked.size} into stock. One undo step.`);
                  }, setError)
                }
              >
                Into stock
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="stock__error">{error}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stores and levels

function StoresSection({ doc, canDraw, apply, onOpen }: { doc: Document; canDraw: boolean; apply: (next: Document) => void; onOpen: (id: string) => void }) {
  const stores = listStores(doc);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [place, setPlace] = useState('');
  return (
    <section className="stock__section" aria-label="Stores">
      <h3 className="stock__sub">Stores</h3>
      <p className="stock__note">Where spares are kept that is not a rack: a cupboard, a shelf, a room. Each has a label to print for its door.</p>
      <ul className="stock__stores">
        {stores.map((s) => {
          const page = storeView(doc, s.id)!;
          return (
            <li key={s.id}>
              <button type="button" className="stock__link" onClick={() => onOpen(s.id)}>
                {s.name}
              </button>
              <span className="stock__note">
                {[s.place, `${page.onHand} on hand`].filter(Boolean).join(' · ')}
              </span>
            </li>
          );
        })}
        {stores.length === 0 ? <li className="stock__note">No stores yet.</li> : null}
      </ul>
      {canDraw ? (
        <form
          className="stock__grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (attempt(() => apply(addStore(doc, { name, place }, actorOpts()).doc), setError)) {
              setName('');
              setPlace('');
            }
          }}
        >
          <Field label="New store">
            <input className="stock__input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Comms cupboard" />
          </Field>
          <Field label="Where it is">
            <input className="stock__input" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="2nd floor, by the lifts" />
          </Field>
          <div className="stock__actions">
            <button type="submit">Add store</button>
          </div>
        </form>
      ) : null}
      {error ? <p className="stock__error">{error}</p> : null}
    </section>
  );
}

function LevelsSection({ doc, canDraw, apply }: { doc: Document; canDraw: boolean; apply: (next: Document) => void }) {
  const levels = stockLevels(doc);
  const models = useMemo(() => [...new Set(listStock(doc).map((i) => i.model).filter((m): m is string => m !== null))].sort(), [doc]);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [atLeast, setAtLeast] = useState('1');
  const listId = useId();
  return (
    <section className="stock__section" aria-label="Keep at least">
      <h3 className="stock__sub">Keep at least</h3>
      <p className="stock__note">The fewest spares of a model to keep. Checks and Gaps say when stock falls below it.</p>
      <table className="stock__table">
        <tbody>
          {levels.map((l) => (
            <tr key={l.id} data-short={l.have < l.atLeast ? 'yes' : undefined}>
              <td className="stock__mono">{l.model}</td>
              <td>
                {l.have} of {l.atLeast}
                {l.onOrder > 0 ? `, ${l.onOrder} on order` : ''}
              </td>
              <td>
                {canDraw ? (
                  <button type="button" className="stock__link" onClick={() => attempt(() => apply(setStockLevel(doc, l.model, 0, actorOpts())), setError)}>
                    Stop keeping
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {levels.length === 0 ? (
            <tr>
              <td className="stock__note">None set.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {canDraw ? (
        <form
          className="stock__grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (attempt(() => apply(setStockLevel(doc, model, Number(atLeast), actorOpts())), setError)) setModel('');
          }}
        >
          <Field label="Model">
            <input className="stock__input stock__input--mono" list={listId} value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id={listId}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="Keep at least">
            <input className="stock__input stock__input--num" type="number" min={0} value={atLeast} onChange={(e) => setAtLeast(e.target.value)} />
          </Field>
          <div className="stock__actions">
            <button type="submit">Set</button>
          </div>
        </form>
      ) : null}
      {error ? <p className="stock__error">{error}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A store's own page: what a bin label opens (ADR-0068 point 8), and a store picked from the list.

export function StoreBinPage({
  doc,
  storeId,
  canDraw,
  onChange,
  onBack,
}: {
  doc: Document;
  storeId: string;
  canDraw: boolean;
  onChange: (next: Document) => void;
  onBack?: () => void;
}) {
  const page = storeView(doc, storeId);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: page?.store.name ?? '', place: page?.store.place ?? '', note: page?.store.note ?? '' });
  if (!page) {
    return (
      <section className="stock" data-testid="store-page">
        <p className="stock__note">That store is not in this design any more.</p>
        {onBack ? (
          <button type="button" className="stock__link" onClick={onBack}>
            Back
          </button>
        ) : null}
      </section>
    );
  }
  return (
    <section className="stock store-page" data-testid="store-page" aria-label={page.store.name}>
      {onBack ? (
        <button type="button" className="stock__link" onClick={onBack}>
          ← Back to On hand
        </button>
      ) : null}
      <header className="stock__head">
        <h2 className="stock__title">{page.store.name}</h2>
        <span className="stock__count">{page.onHand} on hand</span>
      </header>
      {page.store.place ? <p className="stock__note">{page.store.place}</p> : null}
      {page.store.note ? <p className="stock__note">{page.store.note}</p> : null}
      {page.bins.length === 0 ? <p className="stock__note">Nothing in it yet.</p> : null}
      {page.bins.map((b) => (
        <div key={b.bin ?? ''} className="stock__bin">
          <h3 className="stock__sub">{b.bin ?? 'No bin'}</h3>
          <ItemRows doc={doc} items={b.items} canDraw={canDraw} apply={onChange} empty={null} />
        </div>
      ))}
      {canDraw ? (
        editing ? (
          <form
            className="stock__grid"
            onSubmit={(e) => {
              e.preventDefault();
              if (attempt(() => onChange(setStore(doc, storeId, form, actorOpts())), setError)) setEditing(false);
            }}
          >
            <Field label="Name">
              <input className="stock__input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Where it is">
              <input className="stock__input" value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} />
            </Field>
            <Field label="Note" wide>
              <input className="stock__input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <div className="stock__actions">
              <button type="submit" className="stock__primary">
                Save
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="stock__danger"
                onClick={() => attempt(() => { onChange(removeStore(doc, storeId, actorOpts())); onBack?.(); }, setError)}
              >
                Remove store (its spares stay)
              </button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setEditing(true)}>
            Change store
          </button>
        )
      ) : null}
      {error ? <p className="stock__error">{error}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function StockPanel({
  doc,
  canDraw,
  applyDocChange,
  redact,
}: {
  doc: Document;
  canDraw: boolean;
  applyDocChange: (next: Document) => void;
  redact: (text: string) => Promise<string>;
}) {
  const [show, setShow] = useState<Show>('on_hand');
  const [adding, setAdding] = useState(false);
  const [store, setStoreOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const items = useMemo(() => listStock(doc, { states: SHOWS.find((s) => s.key === show)?.states }), [doc, show]);
  const short = useMemo(() => belowMinimum(doc), [doc]);
  const counts = useMemo(() => {
    const all = listStock(doc);
    return Object.fromEntries(SHOWS.map((s) => [s.key, all.filter((i) => !s.states || s.states.includes(i.state)).reduce((n, i) => n + i.count, 0)])) as Record<Show, number>;
  }, [doc]);

  if (store) return <StoreBinPage doc={doc} storeId={store} canDraw={canDraw} onChange={applyDocChange} onBack={() => setStoreOpen(null)} />;

  return (
    <section className="stock" data-testid="stock-panel" aria-label="On hand">
      <p className="stock__note">
        Spares and parts that are not fitted: on the shelf, kept for a plan, on order, away for repair, lent or retired. A swap or a replace picks from here.
      </p>
      {short.length > 0 ? (
        <p className="stock__short" data-testid="stock-short">
          Below the level you keep: {short.map((l) => `${l.model} ${l.have} of ${l.atLeast}`).join(', ')}.
        </p>
      ) : null}
      <div className="stock__toolbar">
        <div className="stock__chips" role="group" aria-label="Show">
          {SHOWS.map((s) => (
            <button key={s.key} type="button" className="stock__chip" aria-pressed={show === s.key} onClick={() => setShow(s.key)}>
              {s.label} <span className="stock__count">{counts[s.key]}</span>
            </button>
          ))}
        </div>
        {canDraw ? (
          <button type="button" className="stock__primary" aria-expanded={adding} onClick={() => setAdding(!adding)} data-testid="stock-add-open">
            + Add to stock
          </button>
        ) : null}
      </div>
      {notice ? <p className="stock__notice">{notice}</p> : null}
      {adding && canDraw ? (
        <AddStock
          doc={doc}
          apply={applyDocChange}
          redact={redact}
          onDone={(said) => {
            setNotice(said);
            setAdding(false);
          }}
        />
      ) : null}
      <ItemRows
        doc={doc}
        items={items}
        canDraw={canDraw}
        apply={applyDocChange}
        empty={
          <p className="stock__note">
            {show === 'on_hand' ? 'Nothing on hand yet. Add spares with the button above, or take a part out of a device into stock.' : 'Nothing here.'}
          </p>
        }
      />
      <StoresSection doc={doc} canDraw={canDraw} apply={applyDocChange} onOpen={setStoreOpen} />
      <LevelsSection doc={doc} canDraw={canDraw} apply={applyDocChange} />
    </section>
  );
}

/** Folds the batches added since `from` into one undo step under `label`. */
function foldBatches(doc: Document, from: number, label: string): Document {
  const folded = foldFrom(doc, from);
  if (folded.batches.length <= from) return folded;
  const last = folded.batches.length - 1;
  return { ...folded, batches: [...folded.batches.slice(0, last), { ...folded.batches[last]!, label }] };
}

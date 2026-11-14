// Opening an order (ADR-0084 piece 4): choose its type, answer what it asks when it opens, and
// the order gets its W- number. Questions a job fills in later aren't asked here.

import { useEffect, useMemo, useState } from 'react';

import { fetchOrderType, openOrder, refusalWords, type AnswerValue, type Order, type OrderType, type OrderTypeLine } from '../../api/orders';
import { FieldInput } from './FieldInput';
import { answerFrom, answersToSend, fieldsAtOpen, missingAtOpen } from './orderModel';

type Raw = Record<string, string | AnswerValue>;

/** Pure: typed answers from what is in the form, leaving out what doesn't read yet. */
export function typedAnswers(fields: OrderType['definition']['fields'], raw: Raw): Record<string, AnswerValue> {
  const out: Record<string, AnswerValue> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined) continue;
    if (typeof v === 'string') {
      const a = answerFrom(f, v);
      if (a !== null && !(typeof a === 'object' && !Array.isArray(a) && 'problem' in a)) out[f.key] = a as AnswerValue;
    } else out[f.key] = v;
  }
  return out;
}

export function OpenOrderForm({
  organisationId,
  types,
  onOpened,
  onCancel,
}: {
  organisationId: string;
  types: readonly OrderTypeLine[];
  onOpened: (o: Order) => void;
  onCancel: () => void;
}) {
  const [typeId, setTypeId] = useState(types.length === 1 ? types[0].id : '');
  const [type, setType] = useState<OrderType | null>(null);
  const [raw, setRaw] = useState<Raw>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setType(null);
    setRaw({});
    setProblem(null);
    if (!typeId) return;
    let live = true;
    fetchOrderType(organisationId, typeId).then(
      (t) => live && setType(t),
      (e: unknown) => live && setProblem(refusalWords(e)),
    );
    return () => {
      live = false;
    };
  }, [organisationId, typeId]);

  const answers = useMemo(() => (type ? typedAnswers(type.definition.fields, raw) : {}), [type, raw]);
  const fields = type ? fieldsAtOpen(type.definition, answers) : [];

  const submit = () => {
    if (!type) return;
    for (const f of fields) {
      const v = raw[f.key];
      if (typeof v === 'string') {
        const a = answerFrom(f, v);
        if (a !== null && typeof a === 'object' && !Array.isArray(a) && 'problem' in a) {
          setProblem(a.problem);
          return;
        }
      }
    }
    const missing = missingAtOpen(type.definition, answers);
    if (missing) {
      setProblem(`${missing.label} is needed to open the order.`);
      return;
    }
    setBusy(true);
    setProblem(null);
    openOrder(organisationId, type.id, answersToSend(type.definition, answers)).then(
      (o) => {
        setBusy(false);
        onOpened(o);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(refusalWords(e));
      },
    );
  };

  return (
    <section className="order-open" aria-label="Open an order" data-testid="order-open">
      <div className="order-open__head">
        <span className="org-page__title">Open an order</span>
      </div>
      <label className="order-open__row">
        <span className="work-fields__label">Order type</span>
        <select value={typeId} onChange={(e) => setTypeId(e.currentTarget.value)} aria-label="Order type">
          <option value="">Choose…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.code ? ` (${t.code})` : ''}
            </option>
          ))}
        </select>
      </label>
      {type
        ? fields.map((f) => (
            <div key={f.key} className="order-open__row">
              <label className="work-fields__label" htmlFor={`open-${f.key}`}>
                {f.label}
                {f.required ? '' : ' · if known'}
              </label>
              <span className="order-open__input">
                <FieldInput organisationId={organisationId} field={f} id={`open-${f.key}`} value={raw[f.key] as AnswerValue | undefined} onChange={(v) => setRaw({ ...raw, [f.key]: v ?? '' })} />
                {f.help ? <span className="org-sub">{f.help}</span> : null}
              </span>
            </div>
          ))
        : null}
      {type ? <p className="org-sub">Questions a job answers later, such as a circuit id, are asked by that job.</p> : null}
      {problem ? (
        <p className="home__error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="order-open__actions">
        <button type="button" className="btn-main" disabled={!type || busy} onClick={submit} data-testid="order-open-submit">
          {busy ? 'Opening…' : 'Open the order'}
        </button>
        <button type="button" className="btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

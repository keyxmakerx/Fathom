// One question an order asks, as the input its kind needs (ADR-0084 decision 15). The value
// handed back is what the server takes for that kind: text, a whole number, yes or no, a date,
// a list of choices, or a device or port picked from the estate.

import type { AnswerValue, OrderField } from '../../api/orders';
import { isRef, RefPicker } from './RefPicker';

export function FieldInput({
  organisationId,
  field,
  value,
  onChange,
  id,
}: {
  organisationId: string;
  field: OrderField;
  value: AnswerValue | undefined;
  onChange: (raw: string | AnswerValue | null) => void;
  id: string;
}) {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  switch (field.kind) {
    case 'long_text':
      return <textarea id={id} rows={3} value={text} onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'number':
      return <input id={id} inputMode="numeric" value={text} onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'date':
      return <input id={id} type="date" value={text} onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'yes_no':
      return (
        <select id={id} value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case 'choice':
      return (
        <select id={id} value={text} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">Choose…</option>
          {field.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    case 'choices': {
      const list = Array.isArray(value) ? value : [];
      return (
        <span className="order-field__choices" id={id}>
          {field.choices.map((c) => (
            <label key={c}>
              <input
                type="checkbox"
                checked={list.includes(c)}
                onChange={(e) => onChange(e.currentTarget.checked ? [...list, c] : list.filter((x) => x !== c))}
              />{' '}
              {c}
            </label>
          ))}
        </span>
      );
    }
    case 'device':
    case 'port':
      return <RefPicker organisationId={organisationId} kind={field.kind} label={field.label} value={isRef(value) ? value : null} onChange={(v) => onChange(v)} />;
    case 'prefix':
      return (
        <input
          id={id}
          value={text}
          placeholder={field.family === 'ipv6' ? `2001:db8::/${field.size ?? 64}` : `192.0.2.0/${field.size ?? 29}`}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    default:
      return <input id={id} value={text} onChange={(e) => onChange(e.currentTarget.value)} />;
  }
}

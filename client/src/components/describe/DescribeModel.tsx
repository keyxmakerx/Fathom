// "Not here? Describe it" (mockup r15-f1): rows of ports, each with what it is, how many and which
// face, and the faceplate drawn as you go, one strip per face. "Use this model" adds the device with
// those ports in one undo step and, unless unticked, keeps the description in this browser so the
// next one is a click in the equipment list.
import { useId, useMemo, useState, type JSX } from 'react';

import { PORT_FACE_VALUES, faceWords, type PortFace } from '../../document/compat';
import type { TemplatePort } from '../../document/plate';
import { PORT_GLYPHS } from '../ports';
import { portKindFor } from '../drawing/portGlyph';
import {
  DESCRIBE_KINDS,
  MAX_ROW_COUNT,
  STARTING_ROWS,
  describeProblem,
  describedPorts,
  describedSummary,
  portsByFace,
  type DescribeKind,
  type DescribeRow,
} from './describe';
import './describe.css';

export interface DescribedModel {
  name: string;
  ports: TemplatePort[];
  /** Keep it in this browser's "Your models". */
  keep: boolean;
}

export interface DescribeModelProps {
  /** What was typed in the search box, as a first guess at the name. */
  initialName: string;
  onCancel: () => void;
  onUse: (model: DescribedModel) => void;
}

const COUNTS = Array.from({ length: MAX_ROW_COUNT + 1 }, (_, i) => i);

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function DescribeModel({ initialName, onCancel, onUse }: DescribeModelProps): JSX.Element {
  const [name, setName] = useState(initialName);
  const [rows, setRows] = useState<DescribeRow[]>(() => STARTING_ROWS.map((r) => ({ ...r })));
  const [keep, setKeep] = useState(true);
  const [tried, setTried] = useState(false);
  const nameId = useId();
  const ports = useMemo(() => describedPorts(rows), [rows]);
  const faces = useMemo(() => portsByFace(ports), [ports]);
  const problem = describeProblem(name, rows);

  const setRow = (i: number, patch: Partial<DescribeRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const use = () => {
    setTried(true);
    if (problem !== null) return;
    onUse({ name: name.trim(), ports, keep });
  };

  return (
    <form
      className="describe"
      aria-label="Describe a device"
      onSubmit={(e) => {
        e.preventDefault();
        use();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="describe__head">Not here? Describe it</div>
      <label className="describe__name" htmlFor={nameId}>
        <span>Name</span>
        <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="NUC 13 Pro" maxLength={80} autoFocus />
      </label>
      <ul className="describe__rows">
        {rows.map((r, i) => (
          <li key={i} className="describe__row">
            <select aria-label="What kind of port" value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as DescribeKind })}>
              {DESCRIBE_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <select aria-label="How many" className="describe__count" value={r.count} onChange={(e) => setRow(i, { count: Number(e.target.value) })}>
              {COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select aria-label="Which face" value={r.face} onChange={(e) => setRow(i, { face: e.target.value as PortFace })}>
              {PORT_FACE_VALUES.map((f) => (
                <option key={f} value={f}>
                  {capital(f)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-quiet describe__remove"
              aria-label="Remove this row"
              title="Remove this row"
              disabled={rows.length === 1}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn-quiet describe__add" onClick={() => setRows((rs) => [...rs, { kind: 'copper', count: 1, face: rs[rs.length - 1]?.face ?? 'front' }])}>
        + More ports
      </button>
      <div className="describe__preview" aria-label={`Preview: ${describedSummary(rows)}`}>
        {faces.length === 0 ? (
          <div className="describe__plate describe__plate--empty">No ports yet</div>
        ) : (
          faces.map(({ face, ports: on }) => (
            <div key={face} className="describe__face">
              <span className="describe__face-name">{faceWords(face)}</span>
              <div className="describe__plate">
                {on.map((p) => {
                  const Glyph = PORT_GLYPHS[portKindFor(p.connector) ?? 'generic'];
                  return (
                    <span key={p.label} className="describe__port" title={p.label}>
                      <Glyph cabled={false} scale={0.5} title={p.label} />
                    </span>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
      <label className="describe__keep">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        Keep it in Your models
      </label>
      {tried && problem !== null ? (
        <p className="describe__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="describe__actions">
        <button type="button" className="btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-main">
          Use this model
        </button>
      </div>
    </form>
  );
}

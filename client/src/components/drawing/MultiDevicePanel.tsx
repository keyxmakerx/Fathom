// The details panel when two or more devices are selected: "N devices selected", and the fields that
// apply to all of them. Each apply is one change, so one undo reverses it. A field the devices disagree
// on reads "Mixed". Tags, role and rack only: nothing here is a field the schema lacks.

import { useMemo, useState } from 'react';
import type { JSX } from 'react';

import { allTagSummaries, moveManyToRack, setRoleMany, tagMany, tagsOfMany, untagMany } from '../../document/bulk';
import { DEVICE_ROLES } from '../../document/edit';
import type { Document } from '../../document/model';
import type { ClosetView } from '../../document/view';
import { TagChips } from '../TagChips';
import { deviceRows, planRackMove, selectionTitle, sharedValue } from './multiEdit';
import '../../styles/multiPanel.css';

export interface MultiDevicePanelProps {
  /** The selected devices, by chassis id. */
  ids: readonly string[];
  view: ClosetView;
  doc: Document;
  /** Writes the changed document (it is saved and shared like any other change). */
  apply: (next: Document) => void;
  /** Who is making the change. */
  actor?: { actor: string };
  /** A reader sees the choices but cannot change them. */
  canDraw: boolean;
  /** Back to no selection. */
  onClear: () => void;
}

const MIXED = 'Mixed';
const NAMES_SHOWN = 5;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function MultiDevicePanel({ ids, view, doc, apply, actor, canDraw, onClear }: MultiDevicePanelProps): JSX.Element {
  const rows = useMemo(() => deviceRows(view, ids), [view, ids]);
  const [rackId, setRackId] = useState('');
  const [note, setNote] = useState<{ kind: 'refused' | 'done'; text: string } | null>(null);

  const owners = rows.map((r) => r.deviceId);
  const tags = useMemo(() => tagsOfMany(doc, owners), [doc, owners.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the ids
  const suggestions = useMemo(() => allTagSummaries(doc).map((t) => ({ name: t.name, count: t.count })), [doc]);

  const role = sharedValue(rows.map((r) => r.role ?? ''));
  const rack = sharedValue(rows.map((r) => r.rackId ?? ''));
  const rackText = rack.kind === 'mixed' ? MIXED : rack.kind === 'shared' ? (rows[0]?.rackLabel ?? 'Not in a rack') : '';

  const run = (write: () => Document, done: string): { refused: string } | void => {
    try {
      apply(write());
      setNote({ kind: 'done', text: done });
    } catch (e) {
      const text = message(e, 'That change was refused.');
      setNote({ kind: 'refused', text });
      return { refused: text };
    }
  };

  const names = rows.slice(0, NAMES_SHOWN).map((r) => r.hostname || 'unnamed');
  const more = rows.length - names.length;

  return (
    <div className="drawing-editor__panel multi-panel" data-testid="multi-panel">
      <div className="drawing-editor__title">{selectionTitle(rows.length)}</div>
      <div className="multi-panel__names">
        {names.join(', ')}
        {more > 0 ? ` and ${more} more` : ''}
      </div>

      <div className="drawing-editor__group">Tags</div>
      <div className="drawing-editor__field">
        <div className="drawing-editor__field-label">Tags on all of them</div>
        <TagChips
          tags={tags.map((t) => ({ id: t.tagId, name: t.name, coverage: t.count < t.total ? `${t.count} of ${t.total}` : undefined }))}
          suggestions={suggestions}
          onAdd={canDraw ? (name) => run(() => tagMany(doc, owners, name, actor), `Tagged ${rows.length} devices.`) : undefined}
          onRemove={canDraw ? (tagId) => run(() => untagMany(doc, owners, tagId, actor), `Tag removed from ${rows.length} devices.`) : undefined}
        />
      </div>

      <div className="drawing-editor__group">Device</div>
      <label className="drawing-editor__field">
        <span className="drawing-editor__field-label">Role</span>
        <select
          className="multi-panel__select"
          value={role.kind === 'shared' ? role.value : role.kind === 'mixed' ? '__mixed' : ''}
          disabled={!canDraw}
          onChange={(e) => {
            const value = e.target.value;
            if (value === '__mixed') return;
            const todo = rows.filter((r) => (r.role ?? '') !== value);
            if (todo.length === 0) return;
            run(() => setRoleMany(doc, todo.map((r) => r.deviceId), value === '' ? null : value, actor), `Role set on ${todo.length} devices.`);
          }}
        >
          {role.kind === 'mixed' ? (
            <option value="__mixed" disabled>
              {MIXED}
            </option>
          ) : null}
          <option value="">Not set</option>
          {DEVICE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r.replace('_', ' ')}
            </option>
          ))}
        </select>
      </label>

      <div className="drawing-editor__group">Location</div>
      <div className="drawing-editor__field">
        <div className="drawing-editor__field-label">Rack now</div>
        <div className="drawing-editor__field-value" data-testid="multi-rack-now">
          {rackText}
        </div>
      </div>
      {canDraw ? (
        <div className="drawing-editor__field">
          <label className="drawing-editor__field-label" htmlFor="multi-rack-pick">
            Move all into
          </label>
          <div className="multi-panel__row">
            <select id="multi-rack-pick" className="multi-panel__select" value={rackId} onChange={(e) => { setRackId(e.target.value); setNote(null); }}>
              <option value="">Choose a rack</option>
              {view.racks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label || 'unnamed rack'}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="multi-panel__apply"
              disabled={rackId === ''}
              onClick={() => {
                const target = view.racks.find((r) => r.id === rackId);
                if (!target) return;
                const plan = planRackMove(target, rows);
                if (!plan.ok) {
                  setNote({ kind: 'refused', text: plan.reason });
                  return;
                }
                if (plan.moves.length === 0) {
                  setNote({ kind: 'done', text: 'They are all in that rack already.' });
                  return;
                }
                run(() => moveManyToRack(doc, plan.moves, actor), `Moved ${plan.moves.length} devices into ${target.label || 'the rack'}.`);
              }}
            >
              Move
            </button>
          </div>
          <div className="multi-panel__hint">They go into the lowest free units, in the order you selected them.</div>
        </div>
      ) : null}

      {note ? (
        <div className={`multi-panel__note multi-panel__note--${note.kind}`} role={note.kind === 'refused' ? 'alert' : 'status'}>
          {note.text}
        </div>
      ) : null}

      <button type="button" className="multi-panel__clear" onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}

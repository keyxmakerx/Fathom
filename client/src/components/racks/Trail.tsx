import { useEffect, useRef, useState } from 'react';

import type { Document } from '../../document/model';
import { trailRows } from './trail';
import './racks.css';

export interface TrailProps {
  doc: Document;
  /** The signed-in account's own ulid, or `null` in the moment between an
   * expired session and the shell noticing (`useDesignSession.ts`'s own
   * comment on the same gap). */
  accountId: string | null;
  /** The signed-in account's own address — `whoLabel`'s "by name" half. */
  accountAddress: string | null;
  /** `DesignPlace.tsx`'s own approximation of ADR-0053 §4's "present in the
   * last version opened or saved" — see that file's header for what this
   * client can and cannot actually observe about a save's own completion. */
  sealedBatchIds: ReadonlySet<string>;
  /** ADR-0053 §3: "a colleague's batch in between... is a refusal wash
   * naming that change, never a silent overwrite." `null` when the last
   * undo/redo was not refused. */
  undoRefusal: string | null;
  /** ADR-0053 §4: "a comment on a pending change is a batch field" — held a
   * beat above this component (`RacksPlace.tsx`) so it survives whichever
   * change it ends up sealed into. */
  pendingComment: string;
  onPendingCommentChange: (text: string) => void;
}

function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The trail beside the drawing (ADR-0053 §4, `design/proposals/screens/Undo.dc.html`):
 * the document's batches, newest first, who and when, sealed or pending, and
 * a one-line comment box for whatever the next change turns out to be.
 * Every row is read straight off `trailRows` (`trail.ts`) — this component
 * only draws it and owns the new-row pulse, UI-SPEC "Motion" #4: "State
 * change pulses once and settles. Never blinks, never loops."
 */
export function Trail({ doc, accountId, accountAddress, sealedBatchIds, undoRefusal, pendingComment, onPendingCommentChange }: TrailProps) {
  const rows = trailRows(doc, accountId, accountAddress, sealedBatchIds);

  // Motion #4: "a new entry pulses once and settles" — never on the very
  // first render (there is nothing "new" about a trail that just loaded),
  // only when the top row's own id changes from whatever it was a moment
  // ago.
  const topIdRef = useRef<string | null | undefined>(undefined);
  const [pulsingId, setPulsingId] = useState<string | null>(null);
  useEffect(() => {
    const topId = rows[0]?.batchId ?? null;
    const prev = topIdRef.current;
    topIdRef.current = topId;
    if (prev === undefined || topId === prev || topId === null) return undefined;
    setPulsingId(topId);
    const timer = setTimeout(() => setPulsingId(null), 260);
    return () => clearTimeout(timer);
  }, [rows]);

  return (
    <div className="racks-trail" aria-label="Trail">
      <div className="racks-trail__head">
        <span className="racks-trail__title">Trail</span>
        <span className="racks-trail__sub">append-only · nothing here is ever rewritten</span>
      </div>

      <div className="racks-trail__cols" aria-hidden="true">
        <span className="racks-trail__col racks-trail__col--when">When</span>
        <span className="racks-trail__col racks-trail__col--who">Who</span>
        <span className="racks-trail__col racks-trail__col--what">What changed</span>
        <span className="racks-trail__col racks-trail__col--why">Why</span>
        <span className="racks-trail__col racks-trail__col--seal">Seal</span>
      </div>

      <div className="racks-trail__rows">
        {rows.length === 0 ? (
          <div className="racks-trail__empty">No changes yet.</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.batchId}
              className={row.batchId === pulsingId ? 'racks-trail__row racks-trail__row--new' : 'racks-trail__row'}
            >
              <span className="racks-trail__cell racks-trail__col--when">{formatWhen(row.whenMs)}</span>
              <span className="racks-trail__cell racks-trail__col--who">{row.who}</span>
              <span className="racks-trail__cell racks-trail__col--what">{row.what}</span>
              <span className="racks-trail__cell racks-trail__col--why">{row.why ?? ''}</span>
              <span className="racks-trail__cell racks-trail__col--seal">{row.sealed ? 'sealed' : 'pending'}</span>
            </div>
          ))
        )}
      </div>

      {undoRefusal != null ? <div className="racks-trail__refusal">{undoRefusal}</div> : null}

      <div className="racks-trail__comment">
        <label className="racks-trail__comment-label" htmlFor="racks-trail-comment">
          Why? (optional — sealed into the next change)
        </label>
        <input
          id="racks-trail-comment"
          className="racks-trail__comment-input"
          value={pendingComment}
          onChange={(e) => onPendingCommentChange(e.target.value)}
          placeholder="a line for the next change"
        />
      </div>
    </div>
  );
}

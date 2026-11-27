import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';

import type { Document } from '../../document/model';
import { whoNamer } from '../collab/changesSince';
import { nextFocus } from './jumpTree';
import { recordLines, trailRows, type RecordLine, type TrailRow } from './trail';
import './racks.css';
import { EmptyState } from '../ui/EmptyState';

export interface TrailProps {
  doc: Document;
  /** The signed-in account's own ulid, or `null` in the moment between an
   * expired session and the shell noticing (`useDesignSession.ts`'s own
   * comment on the same gap). */
  accountId: string | null;
  /** The signed-in account's own address, shown when a row of theirs is pointed at. */
  accountAddress: string | null;
  /** The design the names heard are kept for (`whoNamer`). */
  designId: string | undefined;
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

/** The record a press on a row opens: each line a name and its value. Not part of the button, so it can be selected and copied. */
export function TrailRecord({ id, lines, listRef }: { id: string; lines: readonly RecordLine[]; listRef?: Ref<HTMLDListElement> }) {
  return (
    <dl className="racks-trail__record" id={id} ref={listRef}>
      {lines.map((line) => (
        <div key={line.label} className="racks-trail__record-line">
          <dt>{line.label}</dt>
          <dd>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A drag over a row's words selects them, as it did before a row could be pressed, and is not a press.
 * `clicks` is the event's own count: 0 for Enter and Space, which always press. */
function selectedIn(row: HTMLElement, clicks: number): boolean {
  if (clicks === 0) return false;
  const sel = window.getSelection();
  return sel != null && !sel.isCollapsed && (row.contains(sel.anchorNode) || row.contains(sel.focusNode));
}

function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** The person reading: their own rows carry their address. */
interface Reader {
  accountId: string | null;
  address: string | null;
}

/** What a pointer reads by resting on a name: the whole account id behind it. A press on the row shows the same. */
function accountTitle(row: TrailRow, reader: Reader): string | undefined {
  if (row.account === null) return undefined;
  if (row.account === reader.accountId && reader.address != null) return `${reader.address} · account ${row.account}`;
  return row.who === 'a colleague' ? `Account ${row.account}` : `${row.who} · account ${row.account}`;
}

interface TrailItemProps {
  row: TrailRow;
  reader: Reader;
  open: boolean;
  /** This is the row Tab stops at. */
  stop: boolean;
  pulsing: boolean;
  recordId: string;
  recordRef: Ref<HTMLDListElement>;
  onToggle: (batchId: string) => void;
  onFocusRow: (batchId: string) => void;
}

/** One change: its row, and under it the record a press opens. Remembered, so that a press or an arrow key
 * draws again the one or two rows it changes and not the whole trail. */
const TrailItem = memo(function TrailItem({ row, reader, open, stop, pulsing, recordId, recordRef, onToggle, onFocusRow }: TrailItemProps) {
  return (
    <li className="racks-trail__item">
      <button
        type="button"
        className={pulsing ? 'racks-trail__row racks-trail__row--new' : 'racks-trail__row'}
        aria-expanded={open}
        aria-controls={open ? recordId : undefined}
        tabIndex={stop ? 0 : -1}
        onFocus={() => onFocusRow(row.batchId)}
        onClick={(e) => {
          if (!selectedIn(e.currentTarget, e.detail)) onToggle(row.batchId);
        }}
      >
        <span className="racks-trail__cell racks-trail__col--when">{formatWhen(row.whenMs)}</span>
        <span className="racks-trail__cell racks-trail__col--who" title={accountTitle(row, reader)}>
          {row.who}
        </span>
        <span className="racks-trail__cell racks-trail__col--what">
          <span title={`Recorded as: ${row.label}`}>
            {row.what}
            {row.on != null ? <> · <span className="racks-trail__on">{row.on}</span></> : null}
          </span>
          {row.why != null && row.why !== '' ? <span className="racks-trail__why">{row.why}</span> : null}
        </span>
        <span className="racks-trail__cell racks-trail__col--seal">{row.sealed ? 'sealed' : 'pending'}</span>
      </button>
      {open ? <TrailRecord id={recordId} lines={recordLines(row, reader)} listRef={recordRef} /> : null}
    </li>
  );
});

/** The rows, which one is open, and which one Tab stops at. Apart from `Trail`, so that moving between rows
 * does not read the whole trail off the document again.
 *
 * A row is a button: a press opens the record behind it (`recordLines`), one at a time. The rows are one stop
 * for Tab, and the arrow keys, Home and End move between them, so a long trail is not a long walk to the
 * comment box under it. */
function TrailList({ rows, pulsingId, accountId, accountAddress }: { rows: readonly TrailRow[]; pulsingId: string | null; accountId: string | null; accountAddress: string | null }) {
  const reader = useMemo<Reader>(() => ({ accountId, address: accountAddress }), [accountId, accountAddress]);

  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = useCallback((batchId: string) => setOpenId((was) => (was === batchId ? null : batchId)), []);
  const recordId = useId();
  const recordRef = useRef<HTMLDListElement>(null);
  // A record opened on the last row in sight is brought into sight.
  useEffect(() => {
    if (openId != null) recordRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [openId]);

  // The one row Tab stops at: the row last focused, or the newest.
  const [stopId, setStopId] = useState<string | null>(null);
  const stop = rows.some((row) => row.batchId === stopId) ? stopId : (rows[0]?.batchId ?? null);
  const onRowsKey = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.racks-trail__row'));
    const to = nextFocus(items.length, items.indexOf(document.activeElement as HTMLButtonElement), e.key);
    if (to == null) return;
    // The drawing listens for the arrow keys too, to move what is selected. This press is for the trail.
    e.preventDefault();
    e.stopPropagation();
    items[to]?.focus();
  };

  return (
    <ol className="racks-trail__list" aria-label="Changes, newest first" onKeyDown={onRowsKey}>
      {rows.map((row) => (
        <TrailItem
          key={row.batchId}
          row={row}
          reader={reader}
          open={row.batchId === openId}
          stop={row.batchId === stop}
          pulsing={row.batchId === pulsingId}
          recordId={recordId}
          recordRef={recordRef}
          onToggle={toggle}
          onFocusRow={setStopId}
        />
      ))}
    </ol>
  );
}

/**
 * The trail beside the drawing (ADR-0053 §4, `design/proposals/screens/Undo.dc.html`):
 * the document's batches, newest first, who and when, sealed or pending, and
 * a one-line comment box for whatever the next change turns out to be.
 * Every row is read straight off `trailRows` (`trail.ts`) — this component
 * only draws it and owns the new-row pulse, UI-SPEC "Motion" #4: "State
 * change pulses once and settles. Never blinks, never loops."
 */
export function Trail({ doc, accountId, accountAddress, designId, sealedBatchIds, undoRefusal, pendingComment, onPendingCommentChange }: TrailProps) {
  const rows = trailRows(doc, whoNamer(accountId, designId), sealedBatchIds);

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
        <span className="racks-trail__sub">append-only · nothing here is ever rewritten · press a row for its full record</span>
      </div>

      <div className="racks-trail__cols" aria-hidden="true">
        <span className="racks-trail__col racks-trail__col--when">When</span>
        <span className="racks-trail__col racks-trail__col--who">Who</span>
        <span className="racks-trail__col racks-trail__col--what">What changed</span>
        <span className="racks-trail__col racks-trail__col--seal">Seal</span>
      </div>

      <div className="racks-trail__rows">
        {rows.length === 0 ? (
          <EmptyState className="racks-trail__empty" title="No changes yet.">Every edit to this design is recorded here, with who made it and when.</EmptyState>
        ) : (
          <TrailList rows={rows} pulsingId={pulsingId} accountId={accountId} accountAddress={accountAddress} />
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

// The page beside the list (ADR-0062, ADR-0046): the canvas details panel's own editor under a
// title and tabs. Overview is `EditorFor` itself, so an edit here is the edit the canvas makes.

import type { ReactNode } from 'react';

import type { Document } from '../../document/model';
import { type ClosetView, type EditorActions, type PaletteItem, type PortView, type Selection } from '../drawing/contract';
import { EditorFor, NotesSection, TypedNoteMode } from '../drawing/Editor';
import { findChassis, findFixture, findOccupant } from '../drawing/lookup';
import { historyOf } from './kinds';
import { PanelMap, PathStrip, PluggedInto, RackContents } from './PageParts';
import type { PlaceIndex, Where } from './placeIndex';
import { PortsList } from './PortsList';

type TabKey = 'overview' | 'ports' | 'notes' | 'history';

export interface ItemPageProps {
  doc: Document;
  view: ClosetView;
  selection: Selection;
  /** Owner of notes and history: the Device, Rack, Cable or Port node. */
  ownerId: string | null;
  title: string;
  actions: EditorActions;
  palette: readonly PaletteItem[];
  accountId: string | null;
  onShowOnCanvas: () => void;
  /** Where everything is, for the cable's run, what a device is plugged into and what a rack holds. */
  idx: PlaceIndex;
  /** A rack page's "Set Where to this rack". */
  onSetWhere?: (w: Where) => void;
  /** The open tab, as the address holds it ('' is Overview), so Back lands on the same tab. */
  tab: string;
  onTab: (tab: string) => void;
}

function portsOf(view: ClosetView, selection: Selection): PortView[] {
  if (selection.kind === 'chassis') return (findChassis(view, selection.id)?.chassis ?? view.unplaced.find((c) => c.id === selection.id))?.ports ?? [];
  if (selection.kind === 'occupant') return findOccupant(view, selection.id)?.occupant.ports ?? [];
  if (selection.kind === 'fixture') return findFixture(view, selection.id)?.fixture.ports ?? [];
  return [];
}

export function ItemPage(props: ItemPageProps) {
  const { doc, view, selection, ownerId, title, actions, palette, accountId, onShowOnCanvas, tab: tabText, onTab, idx, onSetWhere } = props;
  const tab: TabKey = tabText === 'ports' || tabText === 'notes' || tabText === 'history' ? tabText : 'overview';
  const setTab = (t: TabKey) => onTab(t === 'overview' ? '' : t);
  const isDevice = selection.kind === 'chassis' || selection.kind === 'occupant' || selection.kind === 'fixture';
  const ports = isDevice ? portsOf(view, selection) : [];
  const notes = ownerId && actions.notesOf ? actions.notesOf(ownerId).length : 0;

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'overview', label: 'Overview' },
    ...(isDevice ? [{ key: 'ports' as const, label: 'Ports', count: ports.length }] : []),
    { key: 'notes', label: 'Notes', count: notes },
    { key: 'history', label: 'History' },
  ];
  const active = tabs.some((t) => t.key === tab) ? tab : 'overview';

  let body: ReactNode = null;
  if (active === 'overview') {
    body = (
      <div className="inv-page__overview">
        {selection.kind === 'cable' ? <PathStrip doc={doc} view={view} idx={idx} cableId={selection.id} actions={actions} /> : null}
        {selection.kind === 'rack' ? <RackContents view={view} idx={idx} rackId={selection.id} actions={actions} onSetWhere={onSetWhere} /> : null}
        {isDevice ? <PluggedInto view={view} idx={idx} hostId={selection.id} actions={actions} /> : null}
        <TypedNoteMode.Provider value="once">{EditorFor(selection, view, actions, palette)}</TypedNoteMode.Provider>
        <p className="inv-page__typed">
          <b>Stored as typed.</b> Fathom does not redact what you type, only what you paste, so it is saved and exported exactly as written.
        </p>
        {notes > 0 ? (
          <button type="button" className="inv-page__link" onClick={() => setTab('notes')}>
            {notes} {notes === 1 ? 'note' : 'notes'}
          </button>
        ) : null}
      </div>
    );
  } else if (active === 'ports') {
    body = (
      <>
        {ports.some((p) => p.passThroughId) ? <PanelMap view={view} ports={ports} actions={actions} /> : null}
        <PortsList view={view} ports={ports} actions={actions} />
      </>
    );
  } else if (active === 'notes') {
    body = ownerId ? (
      <div className="drawing-editor__panel">
        <NotesSection ownerId={ownerId} actions={actions} />
      </div>
    ) : (
      <p className="inv-page__muted">This kind takes no notes.</p>
    );
  } else {
    const ids = [ownerId, selection.id, ...ports.map((p) => p.id)].filter((x): x is string => !!x);
    const lines = historyOf(doc, ids);
    body = (
      <ul className="inv-page__list">
        {lines.length === 0 ? <li className="inv-page__muted">No changes recorded.</li> : null}
        {lines.map((l, i) => (
          <li key={i}>
            <span>{plainLabel(l.label)}</span>
            <span className="inv-page__muted">
              {l.who === accountId ? 'you' : l.who ? l.who.slice(-6) : ''} · {l.when ? new Date(l.when).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <aside className="shell-editor inv-page" aria-label={`${title} page`}>
      <div className="inv-page__head">
        <span className="inv-page__title">{title}</span>
        <button type="button" onClick={onShowOnCanvas}>
          Show on canvas
        </button>
      </div>
      <div className="inv-page__tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === active}
            className={t.key === active ? 'inv-page__tab inv-page__tab--on' : 'inv-page__tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count ? <span className="inv-page__count"> {t.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="inv-page__body">{body}</div>
    </aside>
  );
}

/** A batch label turned into words: "set Device.management_address" becomes "Changed management address". */
function plainLabel(label: string): string {
  const set = /^set (?:\w+\.)?(\w+)$/.exec(label);
  if (set) return `Changed ${set[1]!.replace(/_/g, ' ')}`;
  const fixed: Record<string, string> = {
    'set field': 'Changed a field value',
    'add field': 'Added a field',
    'rename field': 'Renamed a field',
    'remove field': 'Removed a field',
    tag: 'Tagged',
    untag: 'Removed a tag',
    'add note': 'Added a note',
    'remove note': 'Removed a note',
  };
  if (fixed[label]) return fixed[label]!;
  if (/^create /.test(label)) return 'Created';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The page beside the list (ADR-0062, ADR-0046): the canvas details panel's own editor under a
// title and tabs. Overview is `EditorFor` itself, so an edit here is the edit the canvas makes.

import { useState, type ReactNode } from 'react';

import type { Document } from '../../document/model';
import { ABSENT, type ClosetView, type EditorActions, type PaletteItem, type PortView, type Selection } from '../drawing/contract';
import { EditorFor, NotesSection } from '../drawing/Editor';
import { cableEndText } from '../drawing/Editor';
import { findChassis, findFixture, findOccupant } from '../drawing/lookup';
import { historyOf } from './kinds';

type TabKey = 'overview' | 'interfaces' | 'cables' | 'docs' | 'notes' | 'history';

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
  /** When the page was reached from another page (a port from a device), where back goes. */
  backLabel: string | null;
  onBack: () => void;
}

function portsOf(view: ClosetView, selection: Selection): PortView[] {
  if (selection.kind === 'chassis') return (findChassis(view, selection.id)?.chassis ?? view.unplaced.find((c) => c.id === selection.id))?.ports ?? [];
  if (selection.kind === 'occupant') return findOccupant(view, selection.id)?.occupant.ports ?? [];
  if (selection.kind === 'fixture') return findFixture(view, selection.id)?.fixture.ports ?? [];
  return [];
}

export function ItemPage(props: ItemPageProps) {
  const { doc, view, selection, ownerId, title, actions, palette, accountId, onShowOnCanvas, backLabel, onBack } = props;
  const [tab, setTab] = useState<TabKey>('overview');
  const isDevice = selection.kind === 'chassis' || selection.kind === 'occupant' || selection.kind === 'fixture';
  const ports = isDevice ? portsOf(view, selection) : [];
  const cabled = ports.filter((p) => p.cable != null);
  const notes = ownerId && actions.notesOf ? actions.notesOf(ownerId).length : 0;

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'overview', label: 'Overview' },
    ...(isDevice ? [{ key: 'interfaces' as const, label: 'Interfaces', count: ports.length }, { key: 'cables' as const, label: 'Cables', count: cabled.length }] : []),
    { key: 'docs', label: 'Docs' },
    { key: 'notes', label: 'Notes', count: notes },
    { key: 'history', label: 'History' },
  ];
  const active = tabs.some((t) => t.key === tab) ? tab : 'overview';

  let body: ReactNode = null;
  if (active === 'overview') {
    body = <div className="inv-page__overview">{EditorFor(selection, view, actions, palette)}</div>;
  } else if (active === 'interfaces') {
    body = (
      <ul className="inv-page__list">
        {ports.length === 0 ? <li className="inv-page__muted">No interfaces. Add them in Overview.</li> : null}
        {ports.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => actions.onSelect?.({ kind: 'port', id: p.id })}>
              {p.label || ABSENT}
            </button>
            <span className="inv-page__muted">
              {p.connector} · {p.face}
            </span>
          </li>
        ))}
      </ul>
    );
  } else if (active === 'cables') {
    body = (
      <ul className="inv-page__list">
        {cabled.length === 0 ? <li className="inv-page__muted">Nothing cabled yet.</li> : null}
        {cabled.map((p) => {
          const cable = view.cables.find((c) => c.id === p.cable!.cableId);
          const far = cable?.ends.find((e) => !('portId' in e) || e.portId !== p.id);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => cable && actions.onSelect?.({ kind: 'cable', id: cable.id })}>
                {p.label || ABSENT}
              </button>
              <span className="inv-page__muted">to {far ? cableEndText(view, far) : ABSENT}</span>
            </li>
          );
        })}
      </ul>
    );
  } else if (active === 'docs') {
    body = <p className="inv-page__muted">No documents yet.</p>;
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
        {backLabel ? (
          <button type="button" onClick={onBack}>
            ← {backLabel}
          </button>
        ) : (
          <span className="inv-page__title">{title}</span>
        )}
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

// Links between sites (ADR-0079 decision 5). A port's cable can end on a port in another design:
// the near design stores the far design's id, the far port's id and a label, nothing else. The far
// port is picked from the estate index, the same search Ctrl+K's "Other sites" uses.
import { useEffect, useState } from 'react';

import { openElsewhere, searchEstate, type EstateHit, type EstatePort } from '../../api/estate';
import type { CableEnd } from '../../document/view';
import type { EditorActions, EditorChange } from './contract';

/** What the link's outside end is called on this design's canvas: the far site, then the
 * far device. A tray groups cables by it, so every link to one far device shares a tray. */
export function siteLinkLabel(hit: Pick<EstateHit, 'designName' | 'name'>): string {
  const site = hit.designName ?? 'Another site';
  return hit.name !== '' ? `${site} · ${hit.name}` : site;
}

export function siteLinkChange(portId: string, hit: EstateHit, port: EstatePort): EditorChange {
  return {
    kind: 'cable-link-site',
    portId,
    label: siteLinkLabel(hit),
    far: { design: hit.design, element: port.id },
  };
}

/** Devices worth offering: ones in another design that have ports. */
export function linkCandidates(hits: readonly EstateHit[], here: string): EstateHit[] {
  return hits.filter((h) => h.kind === 'device' && h.design !== here && h.ports.length > 0);
}

/** A port in the picker, in words: its name, and what it is already linked to. */
export function farPortWords(port: EstatePort): string {
  const name = port.name !== '' ? port.name : 'Unnamed port';
  return port.far ? `${name} · already linked` : name;
}

/** The far end of a link, if this outside end is one. */
export function siteLinkOf(end: CableEnd | undefined): { design: string; element: string } | undefined {
  return end != null && 'outside' in end ? end.far : undefined;
}

/** The port panel's "Link to another site…": search, pick a device, pick its port. */
export function SiteLinkPicker({ portId, actions }: { portId: string; actions: EditorActions }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<EstateHit[]>([]);
  const [chosen, setChosen] = useState<EstateHit | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const estate = actions.estate;
  const org = estate?.organisationId ?? '';
  const here = estate?.designId ?? '';

  useEffect(() => {
    if (!open || org === '' || q.trim().length < 3) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      searchEstate(org, q.trim(), 'device').then(
        (answer) => {
          if (!live) return;
          setHits(linkCandidates(answer.hits, here).slice(0, 8));
          setNote(answer.behind > 0 ? `${answer.behind} sites are still being brought up to date.` : null);
        },
        () => {
          if (live) setNote('Search across sites is not answering right now.');
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, org, here, q]);

  if (actions.onEdit == null || estate == null) return null;
  if (!open) {
    return (
      <button type="button" className="btn-quiet" onClick={() => setOpen(true)}>
        Link to another site…
      </button>
    );
  }
  const close = () => {
    setOpen(false);
    setChosen(null);
    setQ('');
  };
  return (
    <div className="drawing-editor__site-link" data-testid="site-link-picker">
      {chosen == null ? (
        <>
          <input
            type="search"
            autoFocus
            aria-label="Find the far device"
            placeholder="Far device, by name, serial or address"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="drawing-editor__site-link-list">
            {hits.map((hit) => (
              <li key={`${hit.design}|${hit.element}`}>
                <button type="button" onClick={() => setChosen(hit)}>
                  {siteLinkLabel(hit)}
                  {hit.place !== '' ? <span className="drawing-editor__site-link-place"> · {hit.place}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {q.trim().length > 0 && q.trim().length < 3 ? <div className="drawing-editor__note">Three letters or more.</div> : null}
        </>
      ) : (
        <>
          <div>{siteLinkLabel(chosen)}: which port?</div>
          <ul className="drawing-editor__site-link-list">
            {chosen.ports.map((port) => (
              <li key={port.id}>
                <button
                  type="button"
                  onClick={() => {
                    const refused = actions.onEdit!(siteLinkChange(portId, chosen, port))?.refused;
                    if (refused) setNote(refused);
                    else close();
                  }}
                >
                  {farPortWords(port)}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn-quiet" onClick={() => setChosen(null)}>
            Another device
          </button>
        </>
      )}
      {note != null ? <div className="drawing-editor__note">{note}</div> : null}
      <button type="button" className="btn-quiet" onClick={close}>
        Cancel
      </button>
    </div>
  );
}

/** "Open there": a link's far end opens its own design at the far port. */
export function OpenFarSite({ far, label }: { far: { design: string; element: string }; label: string }) {
  return (
    <button type="button" onClick={() => openElsewhere(far.design, far.element)} title={`Open ${label}`}>
      Open there
    </button>
  );
}

// A device's ports, one row each: port, cable, far end, kind and face in mono. One component for the
// Inventory page and (ADR-0061 §4) the canvas details panel's ports legend.

import { ABSENT, type ClosetView, type EditorActions, type PortView } from '../drawing/contract';
import { cableEndText } from '../drawing/Editor';
import { inPortOrder } from './portOrder';

export function PortsList(props: { view: ClosetView; ports: readonly PortView[]; actions: EditorActions }) {
  const { view, ports, actions } = props;
  if (ports.length === 0) return <p className="inv-page__muted">No ports. Add them in Overview.</p>;
  const ordered = inPortOrder(ports);
  // Every port button is as wide as the longest label, so the column reads evenly.
  const longest = ordered.reduce((n, p) => Math.max(n, (p.label || ABSENT).length), 0);
  const width = Math.max(4, Math.min(16, longest)) + 2;
  return (
    <ul className="inv-page__list inv-page__ports" style={{ ['--port-w' as string]: `${width}ch` }}>
      {ordered.map((p) => {
        const cable = p.cable ? view.cables.find((c) => c.id === p.cable!.cableId) : undefined;
        const far = cable?.ends.find((e) => !('portId' in e) || e.portId !== p.id);
        return (
          <li key={p.id}>
            <button type="button" className="inv-port" onClick={() => actions.onSelect?.({ kind: 'port', id: p.id })}>
              {p.label || ABSENT}
            </button>
            {cable ? (
              <button type="button" onClick={() => actions.onSelect?.({ kind: 'cable', id: cable.id })}>
                to {far ? cableEndText(view, far) : ABSENT}
              </button>
            ) : (
              <span className="inv-page__muted">no cable</span>
            )}
            <span className="inv-page__muted inv-page__mono">
              {p.connector} · {p.face}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

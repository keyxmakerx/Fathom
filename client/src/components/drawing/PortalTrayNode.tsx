import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

/**
 * `docs/UI-SPEC.md` "Portals": "Not either/or — both. The cable visibly
 * sags to the edge of the view and ends in a dashed tray there, naming
 * where it goes and how many cross." One tray node per `PortalGroup`
 * (`portals.ts`) — every cable in that group draws as a real React Flow
 * edge (`CableEdge.tsx`) targeting this node's one handle, so the sag and
 * the tray are the same drag React Flow already knows how to route,
 * nothing hand-rolled. `design/shell/Main.dc.html`'s two tray boxes are the
 * reference: a dashed hairline box, the far side's name, the crossing
 * count right-aligned, an arrow naming which way the run continues.
 */
export interface PortalTrayNodeData extends Record<string, unknown> {
  label: string;
  countLabel: string;
  side: 'above' | 'below';
  /** UI-SPEC "Portals": "When the lit path continues through it the tray's
   * outline goes solid with the continuation named above it." Set by
   * `Drawing.tsx` from `paths.ts`'s own `LitPath.trayKeys`. */
  lit: boolean;
}

export type PortalTrayNodeType = Node<PortalTrayNodeData, 'tray'>;

export const PORTAL_TRAY_HEIGHT = 30;

export function PortalTrayNode({ data }: NodeProps<PortalTrayNodeType>) {
  const { label, countLabel, side, lit } = data;
  return (
    <div className={lit ? 'drawing-tray drawing-tray--lit' : 'drawing-tray'}>
      {lit && (
        // "the continuation named above it" — the far side's own name
        // (already the tray's `label`, UI-SPEC "Portals": "naming where it
        // goes"), repeated as a caption sitting above the box itself,
        // rather than only inline where the count also sits.
        <span className="drawing-tray__continuation">continues to {label}</span>
      )}
      {/* UI-SPEC "Portals": "an arrow pointing out" — up for a run
          continuing above the rack, down for one continuing below, so the
          tray alone (without reading the CSS class beside it) says which
          way the cable is really headed. */}
      <span className="drawing-tray__arrow" aria-hidden="true">
        {side === 'above' ? '↑' : '↓'}
      </span>
      <span className="drawing-tray__label">{label}</span>
      <span className="drawing-tray__count">{countLabel}</span>
      <Handle
        type="source"
        position={side === 'above' ? Position.Bottom : Position.Top}
        id="tray"
        className="drawing-tray__handle"
      />
    </div>
  );
}

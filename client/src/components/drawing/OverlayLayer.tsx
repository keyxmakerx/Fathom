import { ViewportPortal } from '@xyflow/react';

import { PROVIDER_LABEL, PROVIDER_NOUN, type OverlayView } from '../../document/overlays';
import { HUB_H, HUB_W, type OverlayShape } from './overlayDraw';

/** The VPNs layer on the Diagram look: dashed spokes from each VPN's badge, or one dashed line for
 * a two-member tunnel. Drawn in the canvas's own coordinates, over the boxes. */
export function OverlayLayer({ shapes, overlays, openId, onOpen }: { shapes: readonly OverlayShape[]; overlays: readonly OverlayView[]; openId: string | null; onOpen: (id: string) => void }) {
  const byId = new Map(overlays.map((o) => [o.id, o]));
  return (
    <ViewportPortal>
      <svg className="drawing-vpn" width={1} height={1} aria-hidden="true">
        {shapes.flatMap((s) =>
          s.spokes.map((sp) => (
            <path
              key={`${s.id}|${sp.deviceId}`}
              className={`drawing-vpn__spoke drawing-vpn--tone${s.tone}${s.id === openId ? ' drawing-vpn--open' : ''}`}
              d={sp.c != null ? `M${sp.a.x},${sp.a.y} Q${sp.c.x},${sp.c.y} ${sp.b.x},${sp.b.y}` : `M${sp.a.x},${sp.a.y} L${sp.b.x},${sp.b.y}`}
            />
          )),
        )}
      </svg>
      {shapes.map((s) => {
        const o = byId.get(s.id);
        if (o == null) return null;
        const at = s.hub ?? s.mid!;
        const cls = `drawing-vpn__badge drawing-vpn--tone${s.tone}${s.hub == null ? ' drawing-vpn__badge--line' : ''}${s.id === openId ? ' drawing-vpn--open' : ''}`;
        return (
          <button
            key={s.id}
            type="button"
            className={cls}
            data-overlay-id={s.id}
            style={s.hub != null ? { transform: `translate(${at.x - HUB_W / 2}px, ${at.y - HUB_H / 2}px)`, width: HUB_W, height: HUB_H } : { transform: `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)` }}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(s.id);
            }}
            title={`${o.name} (${PROVIDER_LABEL[o.provider]})`}
          >
            <span className="drawing-vpn__name">{o.name === '' ? PROVIDER_NOUN[o.provider] : o.name}</span>
            {s.hub != null && <span className="drawing-vpn__count">{o.members.length} {o.members.length === 1 ? 'member' : 'members'}</span>}
          </button>
        );
      })}
    </ViewportPortal>
  );
}

/** What a VPN is, when its badge is clicked: range, members and their addresses, exit node, routes. */
export function OverlayCard({ overlay, onClose }: { overlay: OverlayView; onClose: () => void }) {
  const exits = overlay.members.filter((m) => m.exitNode);
  const routes = overlay.members.flatMap((m) => m.routes.map((r) => ({ r, via: m.hostname || 'unnamed device' })));
  const name = (h: string) => (h === '' ? 'unnamed device' : h);
  return (
    <aside className="drawing-vpn-card" aria-label={`VPN ${overlay.name}`} onClick={(e) => e.stopPropagation()}>
      <div className="drawing-vpn-card__head">
        <span className="drawing-vpn-card__kind">
          {PROVIDER_NOUN[overlay.provider]} · {PROVIDER_LABEL[overlay.provider]}
        </span>
        <button type="button" className="drawing-vpn-card__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <h3 className="drawing-vpn-card__name">{overlay.name}</h3>
      <dl className="drawing-vpn-card__rows">
        <div>
          <dt>Range</dt>
          <dd>{overlay.range ?? '—'}</dd>
        </div>
        {overlay.members.map((m) => (
          <div key={m.edgeId}>
            <dt>{name(m.hostname)}</dt>
            <dd>{m.address ?? '—'}</dd>
          </div>
        ))}
        <div>
          <dt>Exit node</dt>
          <dd>{exits.length === 0 ? 'none' : exits.map((m) => name(m.hostname)).join(', ')}</dd>
        </div>
        {routes.map(({ r, via }) => (
          <div key={`${r}|${via}`}>
            <dt>Subnet route</dt>
            <dd>
              {r} via {via}
            </dd>
          </div>
        ))}
      </dl>
      {overlay.note != null && <p className="drawing-vpn-card__note">{overlay.note}</p>}
      <p className="drawing-vpn-card__how">Change it in Inventory, under VPNs.</p>
    </aside>
  );
}

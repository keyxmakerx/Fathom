// UI-SPEC "Inside a box" / the Firewall board (`design/rebuild/Firewall.dc.html`)
// — the camera stop beyond the faceplate (`geometry.ts`'s `CAMERA_STOPS.inside`).
// "Same gesture as going inside a rack. The jacks on the panel at the edge
// are the same ports you cabled, seen from inside — the cable continues
// through the wall": `props.chassis.ports` is that panel, drawn once here
// and never re-derived. Everything past the edge is `props.faces` —
// `Mirror.inside`/`Engine.inside`'s decode of `OP_INSIDE`
// (`crates/fathom-wasm/tests/inside.rs`) — read straight through: "zones
// are regions inside the box, interfaces sit in them. A policy set is a
// stack with an ordinal rail — a rack of rules" (UI-SPEC "Inside a box"),
// and routes/tunnels drawn as the lines a trace would leave the box on.
//
// **Not built this session.** The Firewall board also hatches policy rows
// that can never be reached ("rows that can never be reached are hatched
// like free U", UI-SPEC "Inside a box") and collapses same-shaped zone-pair
// sets to a click-to-expand row. Neither is here: ADR-0052 §5 scopes this
// session to "the inside stop for a Junos SRX from the existing inside
// door" and names unreachable-policy hatching separately as not this
// session's work. The board's lit end-to-end trace ("in → zone → policy →
// route → out") is not built either — the only lighting this component
// does is `litPortLabel` on the edge jacks, which is this session's own
// contract (`ConfigDrawer`'s "click a line and the port it built lights"
// reaching this stop too).
import type { JSX } from 'react';

import type { InsideFaces, InsideRoute, InsideTunnel, InsideUnit, InsideZone } from '../../engine/engine';
import type { ChassisView } from '../../document/view';
import './inside.css';

export interface InsideStopProps {
  chassis: ChassisView;
  faces: InsideFaces;
  litPortLabel: string | null;
}

/** One `PortView` per jack at the edge — "the same ports you cabled." */
function JackStrip({ chassis, litPortLabel }: { chassis: ChassisView; litPortLabel: string | null }): JSX.Element {
  return (
    <div className="inside-stop__jacks" role="list" aria-label="panel">
      {chassis.ports.map((port) => (
        <div
          key={port.id}
          role="listitem"
          className={'inside-stop__jack' + (port.label === litPortLabel ? ' inside-stop__jack--lit' : '')}
        >
          <span className="inside-stop__jack-mark" aria-hidden="true" />
          <span className="inside-stop__jack-label">{port.label}</span>
        </div>
      ))}
    </div>
  );
}

/** One unit's own row inside its zone's region (or, unassigned, inside the
 * unzoned band below). `unit.label` is already the full dotted
 * `<interface>.<unit>` string (`protocol.rs`'s own join, `FACE_IN_UNIT`
 * slot 2 — `tests/inside.rs`'s `by_label("ge-0/0/0.0")`), so this draws it
 * as-is rather than re-composing it from the parent interface's name. */
function UnitRow({ unit }: { unit: InsideUnit }): JSX.Element {
  return (
    <div className="inside-stop__unit">
      <span className="inside-stop__unit-label">{unit.label}</span>
      {unit.addresses !== '' && <span className="inside-stop__unit-addr">{unit.addresses}</span>}
      {unit.tunnel !== '' && <span className="inside-stop__unit-tunnel">{unit.tunnel}</span>}
    </div>
  );
}

function flattenUnits(faces: InsideFaces): InsideUnit[] {
  const out: InsideUnit[] = [];
  for (const iface of faces.interfaces) {
    out.push(...iface.units);
  }
  return out;
}

/** One zone: a region, its member units inside it. UI-SPEC "Absent is
 * drawn as absent" — a zone with no live member reads as an empty region
 * carrying only its own name, never a sentence inserted to fill the space. */
function ZoneBox({ zone, units }: { zone: InsideZone; units: InsideUnit[] }): JSX.Element {
  const inZone = units.filter((u) => u.zoneId === zone.id);
  return (
    <div className="inside-stop__zone">
      <div className="inside-stop__zone-name">{zone.name}</div>
      {inZone.map((u) => (
        <UnitRow key={u.id} unit={u} />
      ))}
    </div>
  );
}

/** Units the config binds to no zone at all — "ge-0/0/1.10 is in no zone,
 * and that is reported rather than blank" (`tests/inside.rs`'s own doc).
 * Drawn plainly, outside any region, since no region claims them. */
function UnzonedBand({ units }: { units: InsideUnit[] }): JSX.Element | null {
  const unzoned = units.filter((u) => u.zoneId === '');
  if (unzoned.length === 0) return null;
  return (
    <div className="inside-stop__unzoned">
      <div className="inside-stop__unzoned-label">unzoned</div>
      {unzoned.map((u) => (
        <UnitRow key={u.id} unit={u} />
      ))}
    </div>
  );
}

/** A policy set: "a stack with an ordinal rail — a rack of rules," in the
 * order `faces.policySets[].policies` already arrives (`Engine.inside`'s
 * own decode never re-sorts it; `tests/inside.rs`'s
 * `policies_come_back_in_the_order_the_device_reads_them` is the property
 * this relies on). `scope` prints only when the module supplies one — this
 * build's own `PolicyScope` carries none yet
 * (`tests/inside.rs`'s `a_policy_set_cannot_name_the_zone_pair_it_governs`),
 * so nothing here invents a "governs X → Y" line the schema cannot back. */
function PolicySetStack({ setId, scope, policies }: { setId: string; scope: string; policies: InsideFaces['policySets'][number]['policies'] }): JSX.Element {
  return (
    <div className="inside-stop__policy-set" data-set-id={setId}>
      {scope !== '' && <div className="inside-stop__policy-scope">{scope}</div>}
      <div className="inside-stop__policy-stack">
        {policies.map((policy) => (
          <div
            key={policy.id}
            className={'inside-stop__policy-row' + (policy.enabled === '0' ? ' inside-stop__policy-row--off' : '')}
          >
            <span className="inside-stop__policy-ordinal">{policy.ordinal}</span>
            <span className="inside-stop__policy-body">
              <span className="inside-stop__policy-name">{policy.name}</span>
              <span className="inside-stop__policy-action">{policy.action}</span>
              {policy.enabled === '0' && <span className="inside-stop__policy-off">disabled</span>}
              {policy.description !== '' && (
                <span className="inside-stop__policy-description">{policy.description}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Routes (and the routing protocols hanging off each) and tunnels — "the
 * lines out." Both are lines leaving the box rather than regions inside
 * it, so they sit apart from the zones/policy bands above. */
function RoutesAndTunnels({ routes, tunnels }: { routes: InsideRoute[]; tunnels: InsideTunnel[] }): JSX.Element | null {
  if (routes.length === 0 && tunnels.length === 0) return null;
  return (
    <div className="inside-stop__out">
      {routes.map((route) => (
        <div key={route.id} className="inside-stop__route">
          <span className="inside-stop__route-name">{route.name}</span>
          {route.protocols.map((proto) => (
            <span key={proto.id} className="inside-stop__proto">
              {proto.protocol} · {proto.adjacencies} {proto.adjacencies === 1 ? 'adjacency' : 'adjacencies'}
            </span>
          ))}
        </div>
      ))}
      {tunnels.map((tunnel) => (
        <div key={tunnel.id} className="inside-stop__tunnel">
          <span className="inside-stop__tunnel-name">{tunnel.name}</span>
          <span className="inside-stop__tunnel-unit">{tunnel.unit}</span>
        </div>
      ))}
    </div>
  );
}

export function InsideStop(props: InsideStopProps): JSX.Element {
  const { chassis, faces, litPortLabel } = props;
  const units = flattenUnits(faces);

  return (
    <div className="inside-stop">
      <div className="inside-stop__header">
        <span className="inside-stop__hostname">{faces.hostname !== '' ? faces.hostname : chassis.hostname}</span>
      </div>
      <div className="inside-stop__body">
        <JackStrip chassis={chassis} litPortLabel={litPortLabel} />
        <div className="inside-stop__zones" role="list" aria-label="zones">
          {faces.zones.map((zone) => (
            <ZoneBox key={zone.id} zone={zone} units={units} />
          ))}
          <UnzonedBand units={units} />
        </div>
        {faces.policySets.length > 0 && (
          <div className="inside-stop__policy-sets" role="list" aria-label="policy sets">
            {faces.policySets.map((set) => (
              <PolicySetStack key={set.id} setId={set.id} scope={set.scope} policies={set.policies} />
            ))}
          </div>
        )}
        <RoutesAndTunnels routes={faces.routes} tunnels={faces.tunnels} />
      </div>
    </div>
  );
}

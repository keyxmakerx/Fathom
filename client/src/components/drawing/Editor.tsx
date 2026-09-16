import type { ReactNode } from 'react';

import '../../styles/drawing.css';
import { ABSENT, UNNAMED_HOSTNAME, type ClosetView, type Selection } from './contract';
import { findChassis, findPort, findRack } from './lookup';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">{label}</div>
      <div className="drawing-editor__field-value">{value}</div>
    </div>
  );
}

/**
 * The selected thing's fields, exactly as the shell's `editor` prop wants
 * them (`Shell.tsx`'s `editor: ReactNode | null`). The same function serves
 * the drawing's side panel and (per UI-SPEC "One editor") the inventory
 * page — this file draws only the fields, no chrome of its own.
 */
export function EditorFor(selection: Selection | null, view: ClosetView): ReactNode {
  if (selection == null) return null;

  if (selection.kind === 'rack') {
    const rack = findRack(view, selection.id);
    if (rack == null) return null;
    const usedU = rack.chassis.reduce((sum, c) => sum + c.heightU, 0);
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{rack.label}</div>
        <Field label="Height" value={`${rack.heightU}U`} />
        <Field label="Numbering" value={rack.unitNumbering} />
        <Field label="Used" value={`${usedU} of ${rack.heightU}U`} />
        <Field label="Devices" value={String(rack.chassis.length)} />
      </div>
    );
  }

  if (selection.kind === 'chassis') {
    const found = findChassis(view, selection.id);
    if (found == null) return null;
    const { rack, chassis } = found;
    const topU = chassis.positionU + chassis.heightU - 1;
    const uRange = chassis.heightU === 1 ? `U${chassis.positionU}` : `U${chassis.positionU}–U${topU}`;
    // UI-SPEC "Absent is drawn as absent": an unset hostname reads as the
    // same muted placeholder word here as it does on the box itself
    // (`ChassisNode.tsx`), not the generic `ABSENT` dash every other field
    // uses — a name's absence gets a word, not a mark.
    const hasHostname = chassis.hostname.length > 0;
    return (
      <div className="drawing-editor__panel">
        <div
          className={
            hasHostname ? 'drawing-editor__title' : 'drawing-editor__title drawing-editor__title--placeholder'
          }
        >
          {hasHostname ? chassis.hostname : UNNAMED_HOSTNAME}
        </div>
        <Field label="Model" value={chassis.model || ABSENT} />
        <Field label="Vendor" value={chassis.vendor || ABSENT} />
        <Field label="Rack" value={`${rack.label} · ${uRange}`} />
        <Field label="Face" value={chassis.face} />
        {/* PortView carries no cabled state yet — the count shown is honest
            about that rather than inventing a "0 of n". */}
        <Field label="Ports" value={`${ABSENT} of ${chassis.ports.length} cabled`} />
      </div>
    );
  }

  const found = findPort(view, selection.id);
  if (found == null) return null;
  const { rack, chassis, port } = found;
  return (
    <div className="drawing-editor__panel">
      <div className="drawing-editor__title">{port.label || ABSENT}</div>
      <Field label="Connector" value={port.connector} />
      <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
      <Field label="Device" value={chassis.hostname || UNNAMED_HOSTNAME} />
      <Field label="Rack" value={rack.label} />
      <Field label="Cabled" value={ABSENT} />
    </div>
  );
}

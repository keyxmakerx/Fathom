// ADR-0052, UI-SPEC "Config" — the drawer under the faceplate. The plate
// itself and the dimming of it are the caller's concern (`RacksPlace.tsx`
// mounts this under the faceplate and positions both); this component draws
// only the drawer's own box: the gutter, the config text with its destroyed
// blocks, the paste box, and the assistant's six rules, printed here and
// nowhere else.
import { useState, type JSX, type ReactNode } from 'react';

import type { CaptureLine, CaptureView } from '../../document/capture';
import type { ChassisView } from '../../document/view';
import './config.css';

/** UI-SPEC "Config": "click a line and the port it built lights". A line's
 * own `builtLabel` (`document/capture.ts`) is checked against this
 * chassis's own ports by exact match — the same rule stated in the brief
 * this component was built from: "the built node is an interface whose name
 * matches a port label on this chassis's faceplate (exact match)". */
function matchedPortLabel(line: CaptureLine, chassis: ChassisView): string | null {
  if (!line.builtLabel) return null;
  const port = chassis.ports.find((p) => p.label === line.builtLabel);
  return port ? port.label : null;
}

/** A destroyed value's marker span, overlaid as a fixed-width block reading
 * "<label> · destroyed at the gate" — never the original length, and never
 * the marker text itself (`<REDACTED:label>`), which would put the raw
 * gate-left marker in front of someone reading the drawer instead of the
 * words UI-SPEC asks for: "a black block that says so — gone, not hidden". */
function lineSegments(line: CaptureLine): ReactNode {
  if (line.drops.length === 0) return line.text;
  const sorted = [...line.drops].sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((drop, i) => {
    if (drop.start > cursor) parts.push(line.text.slice(cursor, drop.start));
    parts.push(
      <span key={`drop-${line.ordinal}-${i}`} className="config-drawer__block">
        {drop.label} · destroyed at the gate
      </span>,
    );
    cursor = drop.end;
  });
  if (cursor < line.text.length) parts.push(line.text.slice(cursor));
  return parts;
}

function gutterMark(mark: CaptureLine['mark']): string {
  switch (mark) {
    case 'built':
      return '●';
    case 'destroyed':
      return '—';
    case 'kept':
      return '○';
  }
}

/** Cap named in the brief this component was built from: "cap the drawer at
 * 20,000 lines with a sentence saying how many were not shown". A render
 * cap only — `capture.lines` itself is never truncated
 * (`document/capture.ts`'s own derivation is complete), so the count in the
 * sentence below is always the true number left out, not a guess. */
const LINE_CAP = 20_000;

/** UI-SPEC "Config": "The assistant's six rules, printed on the screen and
 * not in a help page" — verbatim from that page, not the retired board's
 * own slightly different wording. The assistant itself is out of this
 * session's scope (ADR-0052 §5); this is the six sentences and nothing
 * that acts on them. */
const ASSISTANT_RULES = [
  'reads this config and this graph only',
  'cites a line for every claim',
  'cannot see a credential ever',
  'never says permitted or denied',
  'says "could not establish" over a guess',
  'never changes the estate',
];

export interface ConfigDrawerProps {
  chassis: ChassisView;
  capture: CaptureView | null;
  canDraw: boolean;
  onPaste: (text: string) => void;
  onLineHover: (portLabel: string | null) => void;
  onLineSelect: (portLabel: string | null) => void;
  refusal: string | null;
}

export function ConfigDrawer(props: ConfigDrawerProps): JSX.Element {
  const { chassis, capture, canDraw, onPaste, onLineHover, onLineSelect, refusal } = props;
  const [pasteText, setPasteText] = useState('');
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null);

  const lines = capture?.lines ?? [];
  const shown = lines.slice(0, LINE_CAP);
  const hiddenCount = lines.length - shown.length;

  function commitPaste() {
    if (pasteText.trim().length === 0) return;
    onPaste(pasteText);
    setPasteText('');
  }

  function handleEnter(line: CaptureLine) {
    onLineHover(matchedPortLabel(line, chassis));
  }

  function handleLeave() {
    onLineHover(null);
  }

  function handleClick(line: CaptureLine) {
    setSelectedOrdinal(line.ordinal);
    onLineSelect(matchedPortLabel(line, chassis));
  }

  return (
    <div className="config-drawer">
      <div className="config-drawer__handle">
        <span className="config-drawer__title">config</span>
        <span className="config-drawer__legend">
          <span className="config-drawer__legend-mark">●</span> built graph
          <span className="config-drawer__legend-mark">○</span> kept as text
          <span className="config-drawer__legend-mark">—</span> destroyed at the gate
        </span>
        {capture && (
          <span className="config-drawer__summary">
            {capture.platform} · {capture.lineCount} lines
          </span>
        )}
      </div>

      {canDraw && (
        <div className="config-drawer__paste">
          <textarea
            className="config-drawer__paste-input"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="paste a config"
            rows={4}
          />
          <button type="button" className="config-drawer__paste-button" onClick={commitPaste}>
            Paste
          </button>
          {refusal && <div className="config-drawer__refusal">{refusal}</div>}
        </div>
      )}

      {capture === null && (
        <div className="config-drawer__empty">No config captured for this device yet.</div>
      )}

      {capture !== null && (
        <div className="config-drawer__lines" role="list">
          {shown.map((line) => {
            const port = matchedPortLabel(line, chassis);
            const showNoPortNote = line.mark === 'built' && line.builtLabel !== null && port === null;
            return (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
              <div
                key={line.ordinal}
                role="listitem"
                className={
                  'config-drawer__line' +
                  ` config-drawer__line--${line.mark}` +
                  (selectedOrdinal === line.ordinal ? ' config-drawer__line--selected' : '')
                }
                onMouseEnter={() => handleEnter(line)}
                onMouseLeave={handleLeave}
                onClick={() => handleClick(line)}
              >
                <span className="config-drawer__ordinal">{line.ordinal}</span>
                <span className="config-drawer__gutter">{gutterMark(line.mark)}</span>
                <span className="config-drawer__text">
                  {lineSegments(line)}
                  {showNoPortNote && (
                    <span className="config-drawer__built-note">
                      {' '}
                      built {line.builtLabel} · no port on this plate
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <div className="config-drawer__cap">{hiddenCount} lines not shown.</div>
          )}
        </div>
      )}

      <div className="config-drawer__rules">
        <div className="config-drawer__rules-title">The assistant</div>
        <ul className="config-drawer__rules-list">
          {ASSISTANT_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

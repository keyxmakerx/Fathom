// r31-bar A and r116: the drawing's own controls sit on the drawing, top left, not in the bar. Back (when there is
// somewhere to go back to), Select and Pan (drawn by the canvas), the lens, Layers, Look and Views share one tool
// row; the camera (zoom out, the stop, zoom in, fit) is a pill at the bottom (`BottomPill`). Undo and Redo are the bar's.

import type { ReactNode } from 'react';

import { DIAGRAM_STYLES, DIAGRAM_STYLE_LABEL } from '../drawing/diagramStyle';
import { CABLE_COLOURS, CABLE_COLOUR_LABEL, CABLE_STYLES, CABLE_STYLE_HINT, CABLE_STYLE_LABEL } from '../drawing/cableStyle';
import { LAYERS } from '../drawing/layers';
import { LENSES_IN, LENS_LABEL, type Lens } from './lens';
import { Popover } from './Popover';
import type { Place, ShellProps } from './types';

export interface LensGroupProps {
  place: Place;
  lens: Lens;
  onLensChange: (lens: Lens) => void;
  cablesGroupsPopover?: ReactNode;
  cablesGroupsSummary?: string | null;
}

/** The lenses as a row of buttons; the lit Cables lens opens its list of groups. */
export function LensGroup({ place, lens, onLensChange, cablesGroupsPopover, cablesGroupsSummary }: LensGroupProps) {
  return (
    <div className="shell-bar__lenses">
      {LENSES_IN[place].map((candidate) =>
        candidate === 'cables' && cablesGroupsPopover != null ? (
          <Popover
            key={candidate}
            align="left"
            renderTrigger={({ toggle, triggerRef, triggerProps }) => (
              <button
                type="button"
                aria-pressed={candidate === lens}
                className={candidate === lens ? 'shell-lens shell-lens--on' : 'shell-lens'}
                aria-haspopup={triggerProps['aria-haspopup']}
                aria-expanded={candidate === lens ? triggerProps['aria-expanded'] : false}
                aria-controls={triggerProps['aria-controls']}
                onClick={(event) => {
                  triggerRef.current = event.currentTarget;
                  // Clicking the Cables lens while it is lit opens
                  // the list; while it is some other lens's turn, a
                  // click only switches to Cables, the same as any
                  // other lens button — it never also opens the
                  // popover in the same click.
                  if (candidate !== lens) {
                    onLensChange(candidate);
                    return;
                  }
                  toggle();
                }}
              >
                {LENS_LABEL[candidate]}
                {cablesGroupsSummary != null && ` · ${cablesGroupsSummary}`}
                {candidate === lens && (
                  <span className="shell-lens__caret" aria-hidden="true">
                    {' '}
                    ▾
                  </span>
                )}
              </button>
            )}
          >
            {cablesGroupsPopover}
          </Popover>
        ) : (
          <button
            key={candidate}
            type="button"
            aria-pressed={candidate === lens}
            className={candidate === lens ? 'shell-lens shell-lens--on' : 'shell-lens'}
            onClick={() => onLensChange(candidate)}
          >
            {LENS_LABEL[candidate]}
          </button>
        ),
      )}
    </div>
  );
}

export interface LayersMenuProps {
  layers: NonNullable<ShellProps['layers']>;
  look?: ShellProps['look'];
}

/** One kind of tick box for every row that is on or off. */
function TickRow({ id, label, on, note, onToggle }: { id: string; label: string; on: boolean; note?: string; onToggle: () => void }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} className="shell-show__row" data-testid={`show-${id}`} onClick={onToggle}>
      <span className="shell-show__tick" aria-hidden="true">{on ? '✓' : ''}</span>
      <span>{label}</span>
      {note != null && <span className="shell-show__note">{note}</span>}
    </button>
  );
}

/** What Layers holds: the ticks, and nothing about how the drawing looks. */
export function LayersPanel({ layers, look }: LayersMenuProps) {
  return (
      <div className="shell-show" role="group" aria-label="Show on the drawing">
        <div className="shell-show__head">Show on the drawing</div>
        {LAYERS.filter((l) => l.available).map((l) => (
          <TickRow key={l.id} id={l.id} label={l.label} on={layers.value[l.id]} note={l.onByDefault ? 'on by default' : undefined} onToggle={() => layers.onToggle(l.id)} />
        ))}
        {layers.aids?.items.map((a) => (
          <TickRow key={a.id} id={a.id} label={a.label} on={a.on} note={a.note} onToggle={() => layers.aids!.onToggle(a.id)} />
        ))}
        {look?.value === 'rack' && <p className="shell-show__hint">The words and icons are drawn in the Diagram look.</p>}
        <p className="shell-show__hint">Each layer adds words in ink, placed so they never overlap. Yours, per browser.</p>
      </div>
  );
}

/** Layers ▾: what is drawn on the drawing (the nine ticks), and the Mini-map. How it looks is `LookMenu`'s. */
export function LayersMenu({ layers, look }: LayersMenuProps) {
  return (
    <Popover
      renderTrigger={({ open, triggerProps, triggerRef }) => (
        <button
          type="button"
          className={open ? 'shell-lens shell-lens--on' : 'shell-lens'}
          data-testid="shell-show"
          ref={(el) => {
            triggerRef.current = el;
          }}
          {...triggerProps}
        >
          Layers ▾
        </button>
      )}
    >
      <LayersPanel layers={layers} look={look} />
    </Popover>
  );
}

export interface LookMenuProps {
  layers: NonNullable<ShellProps['layers']>;
  /** More at the foot of the menu: the cable colour key (r30-panels). */
  extra?: ReactNode;
}

/** What Look holds: device style, cable style, cable colour and the colour key. */
export function LookPanel({ layers, extra }: LookMenuProps) {
  return (
      <div className="shell-show" role="group" aria-label="Look of the drawing">
        {layers.style != null && (
          <div className="shell-show__style" role="group" aria-label="Device style">
            <span className="shell-show__head">Device style</span>
            <span className="btn-group">
            {DIAGRAM_STYLES.map((st) => (
              <button
                key={st}
                type="button"
                role="menuitemradio"
                aria-checked={layers.style!.value === st}
                className={layers.style!.value === st ? 'shell-lens shell-lens--on' : 'shell-lens'}
                data-testid={`style-${st}`}
                onClick={() => layers.style!.onChange(st)}
              >
                {DIAGRAM_STYLE_LABEL[st]}
              </button>
            ))}
            </span>
          </div>
        )}
        {layers.cables != null && (
          <div className="shell-show__style" role="group" aria-label="Cable style">
            <span className="shell-show__head">Cable style</span>
            <span className="btn-group">
            {CABLE_STYLES.map((st) => (
              <button
                key={st}
                type="button"
                role="menuitemradio"
                aria-checked={layers.cables!.value === st}
                className={layers.cables!.value === st ? 'shell-lens shell-lens--on' : 'shell-lens'}
                data-testid={`cable-style-${st}`}
                title={CABLE_STYLE_HINT[st]}
                onClick={() => layers.cables!.onChange(st)}
              >
                {CABLE_STYLE_LABEL[st]}
              </button>
            ))}
            </span>
            <p className="shell-show__hint" data-testid="cable-style-hint">{CABLE_STYLE_HINT[layers.cables.value]}</p>
          </div>
        )}
        {layers.cables?.colour != null && (
          <div className="shell-show__style" role="group" aria-label="Cable colour">
            <span className="shell-show__head">Cable colour</span>
            <span className="btn-group">
            {CABLE_COLOURS.map((c) => (
              <button
                key={c}
                type="button"
                role="menuitemradio"
                aria-checked={layers.cables!.colour!.value === c}
                className={layers.cables!.colour!.value === c ? 'shell-lens shell-lens--on' : 'shell-lens'}
                data-testid={`cable-colour-${c}`}
                onClick={() => layers.cables!.colour!.onChange(c)}
              >
                {CABLE_COLOUR_LABEL[c]}
              </button>
            ))}
            </span>
          </div>
        )}
        {extra}
      </div>
  );
}

/** Look ▾: device style, cable style, cable colour and the colour key. Nothing here changes what is drawn, only how. */
export function LookMenu({ layers, extra }: LookMenuProps) {
  if (layers.style == null && layers.cables == null && extra == null) return null;
  return (
    <Popover
      renderTrigger={({ open, triggerProps, triggerRef }) => (
        <button
          type="button"
          className={open ? 'shell-lens shell-lens--on' : 'shell-lens'}
          data-testid="shell-look"
          ref={(el) => {
            triggerRef.current = el;
          }}
          {...triggerProps}
        >
          Look ▾
        </button>
      )}
    >
      <LookPanel layers={layers} extra={extra} />
    </Popover>
  );
}

export interface CanvasStripProps extends LensGroupProps {
  layers?: ShellProps['layers'];
  look?: ShellProps['look'];
  layersExtra?: ReactNode;
  /** The saved views menu. */
  views?: ReactNode;
  hiddenCablesCount?: number;
  onShowAllHiddenCables?: () => void;
  /** Where the canvas's own Select and Pan, and the one Back, are drawn into. */
  slotRef: (id: string) => (el: HTMLElement | null) => void;
}

/** The tool row on the drawing, top left: Back, Select and Pan, the lens, Layers, Look and the saved views. */
export function CanvasStrip({ layers, look, layersExtra, views, hiddenCablesCount, onShowAllHiddenCables, slotRef, ...lens }: CanvasStripProps) {
  return (
    <div className="shell-canvas-bar" data-print-omit="">
      <div className="shell-canvas-bar__group" role="toolbar" aria-label="Drawing tools">
        <div className="shell-canvas-bar__slot" data-slot="jump-trail" ref={slotRef('jump-trail')} />
        <div className="shell-canvas-bar__slot" data-slot="canvas-tools" ref={slotRef('canvas-tools')} />
        <LensGroup {...lens} />
        {hiddenCablesCount != null && hiddenCablesCount > 0 && (
          <span className="shell-chip shell-bar__hidden-chip" data-testid="shell-hidden-cables-chip">
            {hiddenCablesCount} hidden ·{' '}
            <button type="button" className="shell-chip__link" onClick={onShowAllHiddenCables}>
              show
            </button>
          </span>
        )}
        {layers != null && <LayersMenu layers={layers} look={look} />}
        {layers != null && <LookMenu layers={layers} extra={layersExtra} />}
        {views}
      </div>
    </div>
  );
}

export interface BottomPillProps {
  /** Absent where there is nothing to zoom. */
  zoom?: { value: number; onIn: () => void; onOut: () => void; onFit?: () => void; stops?: ShellProps['zoomStops'] };
}

/** The camera, in a pill at the bottom of the drawing: zoom out, the stop or percentage (it opens the stops upward),
 * zoom in, fit. Undo and Redo are the bar's. */
export function BottomPill({ zoom }: BottomPillProps) {
  const stops = zoom?.stops;
  return (
    <div className="shell-pill" role="toolbar" aria-label="Zoom" data-print-omit="" data-testid="shell-pill">
      {zoom != null && (
        <>
          <button type="button" className="shell-pill__btn" aria-label="Zoom out" title="Zoom out" onClick={zoom.onOut}>
            &minus;
          </button>
          {stops != null ? (
            <Popover
              className="shell-popover--above"
              renderTrigger={({ open, triggerProps, triggerRef }) => (
                <button
                  type="button"
                  className={open ? 'shell-pill__value shell-pill__value--on' : 'shell-pill__value'}
                  title="Zoom stops"
                  ref={(el) => {
                    triggerRef.current = el;
                  }}
                  {...triggerProps}
                >
                  {zoom.value}%
                </button>
              )}
            >
              <div className="shell-pill__stops" role="group" aria-label="Zoom stops">
                {stops.stops.map((s) => (
                  <button key={s.id} type="button" className="shell-pill__stop" aria-pressed={s.id === stops.current} onClick={() => stops.onGo(s.id)}>
                    <span className="shell-pill__stop-dot" aria-hidden="true" />
                    {s.label}
                  </button>
                ))}
              </div>
            </Popover>
          ) : (
            <span className="shell-pill__value">{zoom.value}%</span>
          )}
          <button type="button" className="shell-pill__btn" aria-label="Zoom in" title="Zoom in" onClick={zoom.onIn}>
            +
          </button>
          {zoom.onFit && (
            <>
              <span className="shell-pill__rule" aria-hidden="true" />
              <button type="button" className="shell-pill__btn" aria-label="Fit to view" title="Fit to view" onClick={zoom.onFit}>
                <svg {...PILL_ICON}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

const PILL_ICON = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round', 'aria-hidden': true } as const;

// r31-bar A: the drawing's own controls sit on the drawing, top left, not in the bar. Select and Pan (drawn by the
// canvas), the lens and Layers share one strip; Undo, Redo and zoom sit in a pill at the bottom (`BottomPill`).

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
  /** More at the foot of the menu: the cable colour key (r30-panels). */
  extra?: ReactNode;
}

/** Layers ▾: what is drawn on the drawing, the device and cable styles, and the colour key. */
export function LayersMenu({ layers, look, extra }: LayersMenuProps) {
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
      <div className="shell-show" role="group" aria-label="Show on the drawing">
        <div className="shell-show__head">Show on the drawing</div>
        {LAYERS.filter((l) => l.available).map((l) => (
          <button
            key={l.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={layers.value[l.id]}
            className="shell-show__row"
            data-testid={`show-${l.id}`}
            onClick={() => layers.onToggle(l.id)}
          >
            <span className="shell-show__tick" aria-hidden="true">{layers.value[l.id] ? '✓' : ''}</span>
            <span>{l.label}</span>
            {l.onByDefault && <span className="shell-show__note">on by default</span>}
          </button>
        ))}
        {layers.aids?.items.map((a) => (
          <button
            key={a.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={a.on}
            className="shell-show__row"
            data-testid={`show-${a.id}`}
            onClick={() => layers.aids!.onToggle(a.id)}
          >
            <span aria-hidden="true">{a.on ? '☑' : '☐'}</span>
            <span>{a.label}</span>
            {a.note != null && <span className="shell-show__note">{a.note}</span>}
          </button>
        ))}
        {look?.value === 'rack' && <p className="shell-show__hint">The words and icons are drawn in the Diagram look.</p>}
        <p className="shell-show__hint">Each layer adds words in ink, placed so they never overlap. Yours, per browser.</p>
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
  /** Where the canvas's own Select and Pan, and the Back trail, are drawn into. */
  slotRef: (id: string) => (el: HTMLElement | null) => void;
}

/** The strip on the drawing, top left: Select and Pan, the lens, Layers, the saved views, and Back. */
export function CanvasStrip({ layers, look, layersExtra, views, hiddenCablesCount, onShowAllHiddenCables, slotRef, ...lens }: CanvasStripProps) {
  return (
    <div className="shell-canvas-bar" data-print-omit="">
      <div className="shell-canvas-bar__group" role="toolbar" aria-label="Drawing tools">
        <div className="shell-canvas-bar__slot" ref={slotRef('canvas-tools')} />
        <LensGroup {...lens} />
        {hiddenCablesCount != null && hiddenCablesCount > 0 && (
          <span className="shell-chip shell-bar__hidden-chip" data-testid="shell-hidden-cables-chip">
            {hiddenCablesCount} hidden ·{' '}
            <button type="button" className="shell-chip__link" onClick={onShowAllHiddenCables}>
              show
            </button>
          </span>
        )}
        {layers != null && <LayersMenu layers={layers} look={look} extra={layersExtra} />}
        {views}
      </div>
      <div className="shell-canvas-bar__slot" ref={slotRef('jump-trail')} />
    </div>
  );
}

export interface BottomPillProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Absent where there is nothing to zoom (Inventory). */
  zoom?: { value: number; onIn: () => void; onOut: () => void; onFit?: () => void; stops?: ShellProps['zoomStops'] };
}

/** Undo, Redo and zoom in a pill at the bottom of the drawing. The percentage opens the zoom stops upward. */
export function BottomPill({ canUndo, canRedo, onUndo, onRedo, zoom }: BottomPillProps) {
  const stops = zoom?.stops;
  return (
    <div className="shell-pill" role="toolbar" aria-label="Undo and zoom" data-print-omit="" data-testid="shell-pill">
      <button type="button" className="shell-pill__btn" aria-label="Undo" title="Undo (Ctrl Z)" disabled={!canUndo} onClick={onUndo}>
        <svg {...PILL_ICON}><path d="M5 4L2.5 6.5 5 9" /><path d="M2.5 6.5h7a3.5 3.5 0 010 7H7" /></svg>
      </button>
      <button type="button" className="shell-pill__btn" aria-label="Redo" title="Redo (Ctrl Shift Z)" disabled={!canRedo} onClick={onRedo}>
        <svg {...PILL_ICON}><path d="M11 4l2.5 2.5L11 9" /><path d="M13.5 6.5h-7a3.5 3.5 0 000 7H9" /></svg>
      </button>
      {zoom != null && (
        <>
          <span className="shell-pill__rule" aria-hidden="true" />
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

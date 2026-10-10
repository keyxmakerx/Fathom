// The open device's faceplate tools (owner's ticked ideas, 2026-10-10): arrange hand-typed ports
// by dragging, put them back, and save or reuse the faceplate as a template. Templates are kept in
// this browser for this person; using one adds its ports in one step, so one undo takes it back.
import { useEffect, useRef, useState, type JSX } from 'react';

import type { TemplatePort } from '../../document/plate';
import type { ChassisView } from '../../document/view';
import { newUlid } from '../../document/ulid';
import { captureTemplate, useFaceplateTemplates, type FaceplateTemplate } from './faceplateTemplates';
import './plateTools.css';

export interface PlateToolsProps {
  device: ChassisView;
  canDraw: boolean;
  arranging: boolean;
  onArrange: (on: boolean) => void;
  /** Absent: ports cannot be moved here. */
  onReset?: () => void;
  /** Whose templates; `undefined` leaves templates out. */
  templateOwner?: string | null;
  onApplyTemplate?: (ports: readonly TemplatePort[]) => void;
  canArrange: boolean;
}

function portCount(n: number): string {
  return n === 1 ? '1 port' : `${n} ports`;
}

export function PlateTools(props: PlateToolsProps): JSX.Element | null {
  const { device, canDraw, arranging, onArrange, onReset, templateOwner, onApplyTemplate, canArrange } = props;
  const handTyped = device.model === '';
  if (!canDraw || !handTyped) return null;
  const typed = device.ports.filter((p) => p.rowKind === undefined);
  const placed = typed.some((p) => p.plate != null);
  return (
    <span className="plate-tools">
      {canArrange && typed.length > 0 && (
        <button type="button" aria-pressed={arranging} onClick={() => onArrange(!arranging)} title="Drag ports to any spot on the faceplate">
          Arrange ports
        </button>
      )}
      {arranging && placed && onReset && (
        <button type="button" onClick={onReset} title="Put every port back in the usual order">
          Reset layout
        </button>
      )}
      {templateOwner !== undefined && <TemplatesButton owner={templateOwner} device={device} empty={device.ports.length === 0} onApply={onApplyTemplate} />}
    </span>
  );
}

function TemplatesButton({ owner, device, empty, onApply }: { owner: string | null; device: ChassisView; empty: boolean; onApply?: (ports: readonly TemplatePort[]) => void }): JSX.Element | null {
  const { templates, save, remove } = useFaceplateTemplates(owner);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const typed = device.ports.filter((p) => p.rowKind === undefined);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);

  if (typed.length === 0 && !(empty && templates.length > 0)) return null;
  const label = empty ? 'Start from a template' : 'Templates';

  const doSave = () => {
    const t: FaceplateTemplate = captureTemplate(newUlid(Date.now()), name || device.hostname, device);
    save(t);
    setSaved(t.name);
    setName('');
  };

  return (
    <span className="plate-templates" ref={boxRef}>
      <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div
          className="plate-templates__pop"
          role="dialog"
          aria-label="Faceplate templates"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            }
          }}
        >
          {typed.length > 0 && (
            <form
              className="plate-templates__save"
              onSubmit={(e) => {
                e.preventDefault();
                doSave();
              }}
            >
              <label className="plate-templates__head" htmlFor="plate-template-name">
                Save as template
              </label>
              <div className="plate-templates__row">
                <input id="plate-template-name" value={name} placeholder={device.hostname || 'My faceplate'} onChange={(e) => setName(e.target.value)} />
                <button type="submit">Save</button>
              </div>
              <p className="plate-templates__note">
                {saved !== null ? `Saved “${saved}”, ${portCount(typed.length)}.` : `${portCount(typed.length)}, with where each sits. Kept in this browser for you.`}
              </p>
            </form>
          )}
          <div className="plate-templates__head">{empty ? 'Start from a template' : 'Saved templates'}</div>
          {templates.length === 0 ? (
            <p className="plate-templates__note">None saved yet.</p>
          ) : (
            <ul className="plate-templates__list">
              {templates.map((t) => (
                <li key={t.id} className="plate-templates__item">
                  <span className="plate-templates__name">{t.name}</span>
                  <span className="plate-templates__count">{portCount(t.ports.length)}</span>
                  {empty && onApply && (
                    <button
                      type="button"
                      onClick={() => {
                        onApply(t.ports);
                        setOpen(false);
                      }}
                    >
                      Use
                    </button>
                  )}
                  <button type="button" className="plate-templates__delete" aria-label={`Delete template ${t.name}`} onClick={() => remove(t.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!empty && templates.length > 0 && <p className="plate-templates__note">A template starts an empty box. Add a box, open it, and pick one.</p>}
        </div>
      )}
    </span>
  );
}

// Sign-off r60: the device panel's sections in the order this person chose, without the ones they hid,
// and at the foot of the tab a fold to choose them. What is chosen is `panelSections.ts`.

import { Fragment, useState, type ReactNode } from 'react';

import { Fold } from './Fold';
import {
  ALWAYS_SHOWN,
  DEVICE_SECTIONS,
  loadSectionPrefs,
  moveSection,
  saveSectionPrefs,
  toggleSection,
  type DeviceSectionId,
  type SectionPrefs,
} from './panelSections';

export function DeviceSections({ sections }: { sections: Readonly<Record<DeviceSectionId, ReactNode>> }) {
  const [prefs, setPrefsState] = useState(loadSectionPrefs);
  const setPrefs = (next: SectionPrefs) => {
    saveSectionPrefs(next);
    setPrefsState(next);
  };
  const shown = prefs.order.filter((id) => !prefs.hidden.includes(id));
  const titleOf = (id: DeviceSectionId) => DEVICE_SECTIONS.find((s) => s.id === id)?.title ?? id;

  return (
    <>
      {shown.map((id) => (
        <Fragment key={id}>{sections[id]}</Fragment>
      ))}
      <Fold title="Sections" summary={`${shown.length} of ${prefs.order.length} shown`} testId="sections-fold">
        <p className="drawing-editor__empty-next">Choose what this panel shows and in what order. Kept in this browser only.</p>
        <ol className="dev-sections" data-testid="sections-chooser">
          {prefs.order.map((id, i) => {
            const fixed = ALWAYS_SHOWN[id];
            const title = titleOf(id);
            return (
              <li key={id} className="dev-sections__row">
                <label className="dev-sections__label" title={fixed}>
                  <input
                    type="checkbox"
                    checked={!prefs.hidden.includes(id)}
                    disabled={fixed != null}
                    onChange={() => setPrefs(toggleSection(prefs, id))}
                  />
                  {title}
                </label>
                {fixed != null ? <span className="dev-sections__why">{fixed}</span> : null}
                <button
                  type="button"
                  className="dev-sections__move"
                  aria-label={`Move ${title} up`}
                  disabled={i === 0}
                  onClick={() => setPrefs(moveSection(prefs, id, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="dev-sections__move"
                  aria-label={`Move ${title} down`}
                  disabled={i === prefs.order.length - 1}
                  onClick={() => setPrefs(moveSection(prefs, id, 1))}
                >
                  ↓
                </button>
              </li>
            );
          })}
        </ol>
      </Fold>
    </>
  );
}

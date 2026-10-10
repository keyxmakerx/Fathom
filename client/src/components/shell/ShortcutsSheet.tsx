import { useEffect, useRef } from 'react';

import { SHORTCUTS, SHORTCUT_GROUPS, capsFor, isMac } from './shortcuts';
import '../../styles/palette.css';

/** "Keyboard shortcuts": every shortcut in the one table, grouped. Esc or a click outside closes it. */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const mac = isMac();

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="float-scrim" onPointerDown={onClose}>
      <div
        ref={sheetRef}
        className="float-sheet shortcuts-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="float-sheet__head">
          <h2 className="float-sheet__title">Keyboard shortcuts</h2>
          <button type="button" className="float-sheet__close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="shortcuts-sheet__body">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group} className="shortcuts-sheet__group" aria-label={group}>
              <h3 className="shortcuts-sheet__heading">{group}</h3>
              <dl className="shortcuts-sheet__list">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.id} className="shortcuts-sheet__row">
                    <dt className="shortcuts-sheet__keys">
                      {capsFor(s.keys, mac).map((cap, i) => (
                        <kbd key={`${cap}-${i}`} className="shortcuts-sheet__cap">
                          {cap}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="shortcuts-sheet__what">{s.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

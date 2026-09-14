/** `docs/UI-SPEC.md` "The shape": inspector for whatever is selected.
 * Nothing can be selected yet, so this is only its empty state. */
export function Inspector() {
  return (
    <aside className="inspector" aria-label="Inspector">
      <p className="inspector__empty">Nothing selected.</p>
    </aside>
  );
}

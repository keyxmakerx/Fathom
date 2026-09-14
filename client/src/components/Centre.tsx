/** `docs/UI-SPEC.md` "The shape": the racks, at whatever zoom. The canvas
 * itself (React Flow, drag-and-drop, cabling) is a later slice — this is
 * the empty state it will replace. */
export function Centre() {
  return (
    <main className="centre">
      <div className="centre__empty">
        <h2 className="centre__empty-title">Nothing to draw yet</h2>
        <p>Add a rack to start documenting a closet.</p>
      </div>
    </main>
  );
}

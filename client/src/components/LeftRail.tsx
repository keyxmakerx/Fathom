/** `docs/UI-SPEC.md` "The shape": racks in this closet, other closets, and
 * an equipment palette to drag from. Static empty states — nothing is
 * loaded yet, and this slice draws no diagram to drag equipment onto. */
export function LeftRail() {
  return (
    <nav className="rail" aria-label="Racks and equipment">
      <section className="rail__section">
        <h2 className="rail__heading">This closet</h2>
        <ul className="rail__list">
          <li className="rail__item">No racks yet.</li>
        </ul>
      </section>
      <section className="rail__section">
        <h2 className="rail__heading">Other closets</h2>
        <ul className="rail__list">
          <li className="rail__item">No other closets yet.</li>
        </ul>
      </section>
      <section className="rail__section">
        <h2 className="rail__heading">Equipment palette</h2>
        <ul className="rail__list">
          <li className="rail__item">Not available yet.</li>
        </ul>
      </section>
    </nav>
  );
}

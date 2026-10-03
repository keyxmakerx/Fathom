import { useContext } from "react";
import { DocsContext } from "./context";
import "./docs.css";

/** The "Docs" line in a thing's panel: its own docs, then its model's, and "+ Add doc". */
export function DocsSection({
  ownerId,
  model,
}: {
  ownerId: string;
  model?: string | null;
}) {
  const api = useContext(DocsContext);
  if (!api) return null;
  const docs = api.of(ownerId, model);
  return (
    <div
      className="drawing-editor__field docs-section"
      data-testid="docs-section"
    >
      <div className="drawing-editor__field-label">Docs</div>
      {docs.length === 0 ? (
        <div className="drawing-editor__field-value">—</div>
      ) : null}
      <ul className="docs-section__list">
        {docs.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="docs-link"
              onClick={() => api.open({ kind: "doc", id: d.id })}
            >
              {d.title}
            </button>
            {d.onModel ? (
              <span className="docs-section__tag"> on the model</span>
            ) : null}
          </li>
        ))}
      </ul>
      {api.canEdit ? (
        <button
          type="button"
          className="docs-link"
          onClick={() => api.open({ kind: "new", ownerId, model })}
        >
          + Add doc
        </button>
      ) : null}
    </div>
  );
}

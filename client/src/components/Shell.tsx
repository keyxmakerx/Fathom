import '../styles/shell.css';
import { Bar } from './shell/Bar';
import { Editor } from './shell/Editor';
import { Strip } from './shell/Strip';
import type { ShellProps } from './shell/types';

export type {
  AccountInfo,
  Lens,
  PathItem,
  PathPart,
  Place,
  PresenceUser,
  ShellProps,
} from './shell/types';
export { LENSES, LENS_LABEL, isLensLit, pathToItems } from './shell/types';

/**
 * The application shell — the bar, the folded rail strip, the drawing, and
 * the editor surface, per the board the owner approved 2026-09-16
 * (`design/shell/Main.dc.html`, `docs/decisions/adr-0047-*`). Driven
 * entirely by props: no sample data lives here. See `./shell/types.ts` for
 * the full contract.
 */
export function Shell({
  place,
  onPlaceChange,
  path,
  tree,
  lens,
  onLensChange,
  presence,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  account,
  editor,
  rail,
  trail,
  children,
  viewOnly,
  menu,
  onHome,
  search,
}: ShellProps) {
  return (
    <div className="shell">
      <Bar
        place={place}
        onPlaceChange={onPlaceChange}
        path={path}
        tree={tree}
        lens={lens}
        onLensChange={onLensChange}
        presence={presence}
        zoom={zoom}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomFit={onZoomFit}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
        account={account}
        viewOnly={viewOnly}
        menu={menu}
        onHome={onHome}
        search={search}
      />
      <div className="shell__body">
        {/* The folded rail exists where it has something to open (the Racks
            palette); Home, Site and Inventory carry their own rails. */}
        {rail != null && <Strip rail={rail} />}
        <main className="shell__drawing" aria-label="Drawing">
          {children}
        </main>
        {editor != null && <Editor>{editor}</Editor>}
        {/* ADR-0053 §4 — the Trail panel, beside the drawing: its own aside,
            not `Editor`'s (a selection's editor and the document's whole
            trail are different things and may both be open at once). */}
        {trail != null && (
          <aside className="shell-trail" aria-label="Trail">
            {trail}
          </aside>
        )}
      </div>
    </div>
  );
}

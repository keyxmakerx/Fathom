import { useState } from 'react';

import '../styles/shell.css';
import { Bar } from './shell/Bar';
import { Editor } from './shell/Editor';
import { Strip } from './shell/Strip';
import { TrailPane } from './shell/TrailPane';
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
  onPrint,
  account,
  editor,
  notices,
  noticeField,
  noticeElement,
  announce,
  rail,
  trail,
  trailOpen,
  onTrailOpenChange,
  children,
  viewOnly,
  menu,
  adminPill,
  onHome,
  search,
}: ShellProps) {
  // The notice sits under its field when the open panel shows it; otherwise in the canvas corner.
  const [anchored, setAnchored] = useState(false);
  const inEditor = editor != null && anchored;
  return (
    <div className="shell">
      {announce !== undefined && (
        <div className="shell__sr-only" role="status" aria-live="polite">
          {announce}
        </div>
      )}
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
        onPrint={onPrint}
        account={account}
        viewOnly={viewOnly}
        menu={menu}
        adminPill={adminPill}
        onHome={onHome}
        search={search}
      />
      <div className="shell__body">
        {/* The folded rail exists where it has something to open (the Racks
            palette); Home, Site and Inventory carry their own rails. */}
        {rail != null && <Strip rail={rail} />}
        <main className="shell__drawing" aria-label="Drawing">
          {children}
          {!inEditor && notices != null && <div className="shell__notices-corner">{notices}</div>}
        </main>
        {editor != null && (
          <Editor notices={notices} noticeField={noticeField} noticeElement={noticeElement} onAnchored={setAnchored}>
            {editor}
          </Editor>
        )}
        {/* The trail folds to a strip on the right; it can be open beside the editor. */}
        {trail != null && (
          <TrailPane open={trailOpen ?? false} onOpenChange={(open) => onTrailOpenChange?.(open)}>
            {trail}
          </TrailPane>
        )}
      </div>
    </div>
  );
}

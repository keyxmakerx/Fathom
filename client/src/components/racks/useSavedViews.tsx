import { useCallback, useEffect, useState } from 'react';

import type { CameraHub } from '../drawing/camera';
import type { LayerSet } from '../drawing/layers';
import type { Look } from '../drawing/look';
import { addView, loadViews, newViewId, removeView, renameView, saveViews, type SavedView, type ViewCamera } from '../drawing/savedViews';
import { SavedViewsMenu } from '../shell/SavedViewsMenu';

/**
 * The Views menu's state for the Racks place: the person's saved views for this design, kept in
 * this browser, and what going to one does (set its Show layers, then glide the camera there).
 * A view saved in the other look switches the look first.
 */
export function useSavedViews({
  accountId,
  designId,
  hub,
  look,
  layers,
  applyLayers,
  changeLook,
  setRackCamera,
  onWillGo,
}: {
  accountId: string | null;
  designId: string;
  hub: CameraHub;
  look: Look;
  layers: LayerSet;
  applyLayers: (layers: LayerSet) => void;
  changeLook: (look: Look) => void;
  /** Where the rack drawing starts the next time it mounts. */
  setRackCamera: (camera: ViewCamera) => void;
  /** Called with the view's name just before going to it in the same look (Jump back makes it a step). */
  onWillGo?: (name: string) => void;
}) {
  const [views, setViews] = useState<SavedView[]>(() => loadViews(accountId, designId));
  useEffect(() => setViews(loadViews(accountId, designId)), [accountId, designId]);
  const persist = useCallback(
    (next: SavedView[]) => {
      setViews(next);
      saveViews(accountId, designId, next);
    },
    [accountId, designId],
  );

  const onSave = (name: string): string | null => {
    const camera = hub.control?.get();
    if (camera == null) return 'The drawing is still opening. Try again in a moment.';
    const result = addView(views, { id: newViewId(), name, look, camera: { x: camera.x, y: camera.y, zoom: camera.zoom }, layers });
    if ('refused' in result) return result.refused;
    persist(result.views);
    return null;
  };

  const onGo = (view: SavedView) => {
    if (view.look === look) onWillGo?.(view.name);
    applyLayers(view.layers);
    if (view.look !== look) {
      if (view.look === 'rack') setRackCamera(view.camera);
      else hub.pending = view.camera;
      changeLook(view.look);
      return;
    }
    hub.control?.set(view.camera, true);
  };

  const onRename = (id: string, name: string): string | null => {
    const result = renameView(views, id, name);
    if ('refused' in result) return result.refused;
    persist(result.views);
    return null;
  };

  return (
    <SavedViewsMenu views={views} onSave={onSave} onGo={onGo} onRename={onRename} onDelete={(id) => persist(removeView(views, id))} />
  );
}

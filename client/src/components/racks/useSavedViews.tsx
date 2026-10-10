import { useCallback, useEffect, useRef, useState } from 'react';

import { GLIDE_MS, type CameraHub } from '../drawing/camera';
import type { LayerSet } from '../drawing/layers';
import type { Look } from '../drawing/look';
import { addView, loadViews, newViewId, removeView, renameView, saveViews, viewIsCurrent, type SavedView, type ViewCamera } from '../drawing/savedViews';
import { SavedViewsFolded, SavedViewsMenu } from '../shell/SavedViewsMenu';
import { usePaletteActions } from '../shell/paletteRegistry';

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

  // Which saved view is on screen is read from the camera, which has no events of its own: look again
  // shortly after the pointer, wheel or keys have moved it, and after a glide.
  const [, setTick] = useState(0);
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recheck = useCallback((after: number) => {
    if (tickTimer.current != null) clearTimeout(tickTimer.current);
    tickTimer.current = setTimeout(() => setTick((n) => n + 1), after);
  }, []);
  useEffect(() => {
    const again = () => recheck(200);
    window.addEventListener('pointerup', again);
    window.addEventListener('wheel', again, { passive: true });
    window.addEventListener('keyup', again);
    return () => {
      window.removeEventListener('pointerup', again);
      window.removeEventListener('wheel', again);
      window.removeEventListener('keyup', again);
      if (tickTimer.current != null) clearTimeout(tickTimer.current);
    };
  }, [recheck]);
  const camera = hub.control?.get() ?? null;
  const currentId = views.find((v) => viewIsCurrent(v, { look, layers, camera }))?.id ?? null;

  const onSave = (name: string): string | null => {
    const camera = hub.control?.get();
    if (camera == null) return 'The drawing is still opening. Try again in a moment.';
    const result = addView(views, { id: newViewId(), name, look, camera: { x: camera.x, y: camera.y, zoom: camera.zoom }, layers });
    if ('refused' in result) return result.refused;
    persist(result.views);
    recheck(0);
    return null;
  };

  const onGo = (view: SavedView) => {
    recheck(GLIDE_MS + 150);
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

  // The palette's "Go to" rows.
  usePaletteActions('saved-views', () =>
    views.map((v) => ({ id: `view:${v.id}`, label: `Saved view · ${v.name}`, group: 'go' as const, keywords: ['view', 'camera', 'go'], run: () => onGo(v) })),
  );

  const props = { views, currentId, onSave, onGo, onRename, onDelete: (id: string) => persist(removeView(views, id)) };
  return { group: <SavedViewsMenu {...props} />, folded: <SavedViewsFolded {...props} /> };
}

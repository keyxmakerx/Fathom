import { useEffect } from 'react';
import { useOnViewportChange, useReactFlow, type Viewport } from '@xyflow/react';

/** The camera as the bar's Views menu sees it: read it, and move it. */
export interface CameraControl {
  get: () => Viewport;
  /** `glide` eases to the place unless the person asked for reduced motion. */
  set: (viewport: Viewport, glide: boolean) => void;
}

/** Held by the place; the drawing fills it in while it is mounted. `pending` is a camera to apply as
 * soon as a drawing mounts (a view saved in the other look). */
export interface CameraHub {
  control: CameraControl | null;
  pending: Viewport | null;
  /** Called with the camera whenever a pan or zoom comes to rest, in either look (Jump back keeps it). */
  onSettled?: ((viewport: Viewport) => void) | null;
}

export const GLIDE_MS = 300;

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Registers the surrounding React Flow's camera with the hub for as long as this is mounted. */
export function useCameraHub(hub: CameraHub | undefined): void {
  const rf = useReactFlow();
  useOnViewportChange({ onEnd: (viewport) => hub?.onSettled?.(viewport) });
  useEffect(() => {
    if (hub == null) return undefined;
    hub.control = {
      get: () => rf.getViewport(),
      set: (viewport, glide) => {
        void rf.setViewport(viewport, glide && !reducedMotion() ? { duration: GLIDE_MS } : undefined);
      },
    };
    if (hub.pending != null) {
      const pending = hub.pending;
      hub.pending = null;
      // After the drawing's own first fit has been asked for.
      const id = setTimeout(() => hub.control?.set(pending, false), 0);
      return () => {
        clearTimeout(id);
        hub.control = null;
      };
    }
    return () => {
      hub.control = null;
    };
  }, [hub, rf]);
}

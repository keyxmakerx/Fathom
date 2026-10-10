import { useCallback, useEffect, useRef } from 'react';

import { findEdge, findNode, type Document } from '../../document/model';
import { loadResume, patchResume, type Resume, type ResumeCamera } from '../design/resume';
import type { Selection } from '../drawing';

const SAVE_AFTER_MS = 400;

/**
 * "Pick up where you left off" for the rack drawing: the camera the last visit ended on, and the
 * selected thing. Kept per person and design in this browser (`design/resume.ts`). The camera is
 * handed to the drawing, which uses it in place of its first fit; the selection comes back once the
 * design has loaded, and is dropped if that thing no longer exists.
 *
 * Something chosen on the way in ("Show on rack") wins over both.
 */
export function useResumeView({
  accountId,
  designId,
  doc,
  hasFocus,
  selection,
  setSelection,
}: {
  accountId: string | null;
  designId: string;
  doc: Document | null;
  hasFocus: boolean;
  selection: Selection | null;
  setSelection: (s: Selection) => void;
}) {
  const resumed = useRef<Resume | null>(null);
  if (resumed.current == null) resumed.current = loadResume(accountId, designId);
  const camera = useRef<ResumeCamera | null>(hasFocus ? null : resumed.current.camera);

  const restoredSelection = useRef(false);
  const hasDoc = doc != null;
  useEffect(() => {
    if (!hasDoc || restoredSelection.current) return;
    restoredSelection.current = true;
    const want = resumed.current?.selection;
    if (hasFocus || want == null || doc == null) return;
    if (findNode(doc, want.id) != null || findEdge(doc, want.id) != null) setSelection({ kind: want.kind, id: want.id } as Selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the design first arrives
  }, [hasDoc]);

  // Written on every change after the first look at the loaded design (which may be about to restore one).
  const armed = useRef(false);
  const kind = selection?.kind ?? null;
  const id = selection?.id ?? null;
  useEffect(() => {
    if (!hasDoc) return;
    if (!armed.current) {
      armed.current = true;
      return;
    }
    patchResume(accountId, designId, { selection: kind != null && id != null ? { kind, id } : null });
  }, [accountId, designId, hasDoc, kind, id]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<ResumeCamera | null>(null);
  const flush = useCallback(() => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current != null) patchResume(accountId, designId, { camera: pending.current });
    pending.current = null;
  }, [accountId, designId]);
  useEffect(() => flush, [flush]);
  const onViewportSettled = useCallback(
    (vp: ResumeCamera) => {
      const next = { x: vp.x, y: vp.y, zoom: vp.zoom };
      camera.current = next;
      pending.current = next;
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_AFTER_MS);
    },
    [flush],
  );

  /** A place the rack drawing should start at the next time it mounts (a saved view from the other look). */
  const setCamera = useCallback((next: ResumeCamera) => {
    camera.current = next;
  }, []);

  return { initialViewport: camera.current, onViewportSettled, setCamera };
}

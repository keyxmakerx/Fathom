// The design's cable corrections: fetched when a design opens and again whenever the window
// regains focus, so a correction sent from the floor shows up without a reload. A reader holds
// their own; a drawer holds everything waiting. Nothing here touches the design itself.

import { useCallback, useEffect, useState } from 'react';

import { ApiRefusal } from '../../api/errors';
import { decideCorrection, fetchCorrections, sendCorrection, type CorrectionKind, type CorrectionView } from '../../api/corrections';

export interface CorrectionsStore {
  list: readonly CorrectionView[];
  refresh(): Promise<void>;
  send(cable: string, kind: CorrectionKind, text: string): Promise<{ refused: string } | void>;
  /** Marks a correction accepted or dismissed on the server. Resolves to the decided correction. */
  decide(correction: CorrectionView, verb: 'accept' | 'dismiss'): Promise<{ refused: string } | CorrectionView>;
}

const refusal = (e: unknown, fallback: string): { refused: string } => ({
  refused: e instanceof ApiRefusal && e.status === 403 ? 'You do not have permission to do that here.' : e instanceof Error && e.message ? e.message : fallback,
});

export function useCorrections(organisationId: string, designId: string | undefined): CorrectionsStore {
  const [list, setList] = useState<readonly CorrectionView[]>([]);

  const refresh = useCallback(async () => {
    if (!designId) return;
    try {
      setList(await fetchCorrections(organisationId, designId));
    } catch {
      // Keep the last list; it is looked at again on the next focus.
    }
  }, [organisationId, designId]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const send = useCallback<CorrectionsStore['send']>(
    async (cable, kind, text) => {
      if (!designId) return { refused: 'No design is open.' };
      try {
        const made = await sendCorrection(organisationId, designId, { cable, kind, text: kind === 'traced' ? undefined : text });
        setList((l) => [...l.filter((x) => x.id !== made.id), made]);
      } catch (e) {
        return refusal(e, 'That correction was refused.');
      }
    },
    [organisationId, designId],
  );

  const decide = useCallback<CorrectionsStore['decide']>(
    async (correction, verb) => {
      if (!designId) return { refused: 'No design is open.' };
      try {
        const done = await decideCorrection(organisationId, designId, correction, verb);
        setList((l) => l.map((x) => (x.id === done.id ? done : x)));
        return done;
      } catch (e) {
        void refresh();
        return refusal(e, 'That was refused.');
      }
    },
    [organisationId, designId, refresh],
  );

  return { list, refresh, send, decide };
}

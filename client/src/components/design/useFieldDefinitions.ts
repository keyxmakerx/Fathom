// The organisation's custom-field definitions (ADR-0062): fetched when a design opens and again
// whenever the window regains focus, so a field another member adds appears without a reload.

import { useCallback, useEffect, useState } from 'react';

import {
  archiveFieldDefinition,
  createFieldDefinition,
  fetchFieldDefinitions,
  updateFieldDefinition,
  type FieldDefView,
  type FieldFor,
  type FieldType,
} from '../../api/fieldDefinitions';

export interface FieldDefinitions {
  defs: readonly FieldDefView[];
  refresh(): Promise<void>;
  create(kind: FieldFor, name: string, type: FieldType, choices?: readonly string[]): Promise<{ refused: string } | void>;
  archive(defId: string): Promise<{ refused: string } | void>;
  rename(defId: string, name: string): Promise<{ refused: string } | void>;
}

const refusal = (e: unknown, fallback: string): { refused: string } => ({ refused: e instanceof Error && e.message ? e.message : fallback });

export function useFieldDefinitions(organisationId: string): FieldDefinitions {
  const [defs, setDefs] = useState<readonly FieldDefView[]>([]);

  const refresh = useCallback(async () => {
    try {
      setDefs(await fetchFieldDefinitions(organisationId));
    } catch {
      // Keep the last list; fields simply stay as they were until the next try.
    }
  }, [organisationId]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const create = useCallback<FieldDefinitions['create']>(
    async (kind, name, type, choices) => {
      try {
        const made = await createFieldDefinition(organisationId, { kind, name, type, choices: type === 'choice' ? choices : undefined });
        setDefs((d) => [...d.filter((x) => x.id !== made.id), made]);
      } catch (e) {
        return refusal(e, 'That field was refused.');
      }
    },
    [organisationId],
  );

  const archive = useCallback<FieldDefinitions['archive']>(
    async (defId) => {
      const current = defs.find((d) => d.id === defId);
      if (!current) return { refused: 'That field is already gone.' };
      try {
        const next = await archiveFieldDefinition(organisationId, defId, current.version);
        setDefs((d) => d.map((x) => (x.id === defId ? next : x)));
      } catch (e) {
        void refresh();
        return refusal(e, 'That removal was refused.');
      }
    },
    [organisationId, defs, refresh],
  );

  const rename = useCallback<FieldDefinitions['rename']>(
    async (defId, name) => {
      const current = defs.find((d) => d.id === defId);
      if (!current) return { refused: 'That field is already gone.' };
      try {
        const next = await updateFieldDefinition(organisationId, defId, { ifVersion: current.version, name });
        setDefs((d) => d.map((x) => (x.id === defId ? next : x)));
      } catch (e) {
        void refresh();
        return refusal(e, 'That rename was refused.');
      }
    },
    [organisationId, defs, refresh],
  );

  return { defs, refresh, create, archive, rename };
}

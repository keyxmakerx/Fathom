// Loads the explainers once per open design and owns which Learn view is showing.

import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchExplainers, type Explainer } from '../../api/learn';
import { fieldValue, findNode, type Document } from '../../document/model';
import type { LearnApi } from './context';
import type { LearnView } from './LearnOverlay';

export function useLearnApi(doc: Document | null): { api: LearnApi; view: LearnView | null; setView: (v: LearnView | null) => void } {
  const [status, setStatus] = useState<LearnApi['status']>('loading');
  const [explainers, setExplainers] = useState<readonly Explainer[]>([]);
  const [view, setView] = useState<LearnView | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    let live = true;
    fetchExplainers().then(
      (list) => {
        if (!live) return;
        setExplainers(list);
        setStatus('ready');
      },
      () => {
        if (live) setStatus('error');
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const api = useMemo<LearnApi>(
    () => ({
      status,
      explainers,
      openExplainer: (id) => setView({ kind: 'entry', id, from: 'direct' }),
      openLibrary: () => setView({ kind: 'library' }),
      platformOf: (deviceId) => {
        const d = docRef.current;
        const n = d ? findNode(d, deviceId) : undefined;
        const v = n ? fieldValue(n.fields, 'Device.platform') : undefined;
        return typeof v === 'string' ? v : '';
      },
    }),
    [status, explainers],
  );
  return { api, view, setView };
}

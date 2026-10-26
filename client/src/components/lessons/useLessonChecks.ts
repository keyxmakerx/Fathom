// The engine a lesson checks its steps with: its own Mirror on the same wasm module, so the runner reads Checks and
// traces without reaching into the canvas. Lessons run on small sample copies, so a full load per change is cheap.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Document } from '../../document/model';
import type { ChecksResult, TraceResult } from '../../engine/engine';
import { Engine } from '../../engine/engine';
import { Mirror } from '../../engine/mirror';

export type BootMirror = () => Promise<Mirror>;

let shared: Promise<Mirror> | null = null;

/** One Mirror for the page's lessons, started on first use. */
export const bootLessonMirror: BootMirror = () => {
  shared ??= Engine.init().then((engine) => new Mirror(engine));
  shared.catch(() => {
    shared = null;
  });
  return shared;
};

export interface LessonChecks {
  /** Checks on the design as it is now; null until the first run, or while `wantChecks` is false. */
  checks: ChecksResult | null;
  /** Runs a trace on the design as it is now. */
  trace(from: string, to: string, flow?: { protocol: number; port: number }): Promise<TraceResult>;
  /** The engine could not start or threw. */
  failed: boolean;
}

/** Checks re-run a moment after the design stops changing, only while a step needs them. */
export function useLessonChecks(doc: Document | null, wantChecks: boolean, boot: BootMirror = bootLessonMirror): LessonChecks {
  const [checks, setChecks] = useState<ChecksResult | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(doc);
  latest.current = doc;

  useEffect(() => {
    if (!wantChecks || doc == null) {
      setChecks(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      boot()
        .then((mirror) => {
          if (cancelled) return;
          mirror.load(doc);
          setChecks(mirror.checks());
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, wantChecks, boot]);

  const trace = useCallback(
    async (from: string, to: string, flow?: { protocol: number; port: number }) => {
      const mirror = await boot();
      const now = latest.current;
      if (now == null) throw new Error('The design is not open.');
      mirror.load(now);
      return mirror.trace(from, to, flow);
    },
    [boot],
  );

  return { checks, trace, failed };
}

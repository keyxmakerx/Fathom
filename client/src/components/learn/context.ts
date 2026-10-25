// The Learn entry point every screen shares (ADR-0066 item 1.1): the explainers once loaded, and
// one way to open one. `useLearn()` is null where no provider is mounted, so a caller shows its
// "Learn more" only when it is not.

import { createContext, useContext } from 'react';

import type { Explainer } from '../../api/learn';

export interface LearnApi {
  status: 'loading' | 'ready' | 'error';
  explainers: readonly Explainer[];
  /** Opens the explainer with this corpus id, e.g. `explain:concept:ubiquiti.basics`. */
  openExplainer(id: string): void;
  /** Opens the library of every explainer. */
  openLibrary(): void;
  /** `Device.platform` of a device in the open design, or '' when none is recorded. */
  platformOf(deviceId: string): string;
}

export const LearnContext = createContext<LearnApi | null>(null);

export function useLearn(): LearnApi | null {
  return useContext(LearnContext);
}

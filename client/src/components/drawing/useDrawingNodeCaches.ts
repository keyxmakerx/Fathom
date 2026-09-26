import { useState } from 'react';

import type { Sheath } from './contract';
import { createDrawingNodeCaches, type DrawingNodeCaches } from './buildDrawingNodes';
import { StableRef } from './idCache';

export interface DrawingCaches {
  /** `buildDrawingNodes`' own caches: a node keeps its reference until what it draws changes. */
  nodes: DrawingNodeCaches;
  /** Hands the port-sheath map back unchanged when an edit left every entry as it was. */
  portSheath: StableRef<ReadonlyMap<string, Sheath>>;
}

function createDrawingCaches(): DrawingCaches {
  return { nodes: createDrawingNodeCaches(), portSheath: new StableRef<ReadonlyMap<string, Sheath>>() };
}

/** The one place `Drawing.tsx` gets its caches: created on mount, kept for its life. */
export function useDrawingNodeCaches(): DrawingCaches {
  const [caches] = useState(createDrawingCaches);
  return caches;
}

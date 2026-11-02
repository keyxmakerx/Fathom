// A trace to an address this design does not hold (sign-off r96, round 2 item 4): the estate index
// (ADR-0079) is asked which other designs this person may read hold it, so the panel can say where it is
// and open that design on the device. It never carries the walk across: the far design is not loaded here,
// so what happens past this site's edge is that design's own trace.

import { useEffect, useState } from 'react';

import { searchEstate, type EstateHit } from '../../api/estate';
import type { TraceResult } from '../../engine/engine';
import { readAddress } from './traceModel';

export interface ElsewhereHit {
  design: string;
  /** The design's name, or "another site" when it has none. */
  site: string;
  device: string;
  /** What opening it shows: the device's chassis. */
  open: string;
}

export interface Elsewhere {
  address: string;
  hits: ElsewhereHit[];
  /** Designs still being indexed: the answer may be short. */
  behind: number;
}

/** The address a trace was asked to reach, when it did not reach it here; else null. */
export function unreachedAddress(result: TraceResult | null): string | null {
  if (result == null) return null;
  const to = readAddress(result.to);
  if (to == null) return null;
  return result.hops.some((h) => h.kind === 'end') ? null : to;
}

/** Devices in other designs that hold exactly `address`, at most three, by site then name. */
export function elsewhereHits(hits: readonly EstateHit[], here: string, address: string): ElsewhereHit[] {
  return hits
    .filter((h) => h.kind === 'device' && h.design !== here && h.addresses.includes(address))
    .map((h) => ({ design: h.design, site: h.designName ?? 'another site', device: h.name || h.model || 'a device', open: h.open }))
    .sort((a, b) => a.site.localeCompare(b.site) || a.device.localeCompare(b.device))
    .slice(0, 3);
}

/** Asks the index once per unreached address. Null while there is nothing to say. */
export function useTraceElsewhere(organisationId: string | null | undefined, designId: string | null | undefined, result: TraceResult | null): Elsewhere | null {
  const address = unreachedAddress(result);
  const [answer, setAnswer] = useState<Elsewhere | null>(null);
  useEffect(() => {
    setAnswer(null);
    if (address == null || organisationId == null || designId == null) return undefined;
    let live = true;
    searchEstate(organisationId, address, 'device').then(
      (a) => {
        if (!live) return;
        const hits = elsewhereHits(a.hits, designId, address);
        setAnswer(hits.length > 0 || a.behind > 0 ? { address, hits, behind: a.behind } : null);
      },
      () => {
        // The index not answering is not a finding about the path; the panel says nothing.
      },
    );
    return () => {
      live = false;
    };
  }, [organisationId, designId, address]);
  return answer;
}

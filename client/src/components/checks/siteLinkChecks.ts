// The Check for links between sites (ADR-0079 decision 5). The engine sees one design; whether a
// link's far end is still there, and whether it points back, is a question for the estate index
// on the server (`api/estate.ts`'s `fetchFarEnds`). These findings join the engine's in the panel.
import { useEffect, useMemo, useState } from 'react';

import { fetchFarEnds, type FarAnswer } from '../../api/estate';
import type { Document } from '../../document/model';
import { siteLinks, type SiteLink } from '../../document/siteLinks';
import type { CheckFinding, ChecksResult } from '../../engine/engine';

const SOURCE = { title: '', url: '', note: 'A link between two sites is one cable, so each end should name the other.' };

/** One finding per link whose far end has gone or doesn't point back. A far end in a site this
 * person can't open, or one still being indexed, says nothing: Fathom cannot see it. */
export function siteLinkFindings(links: readonly SiteLink[], answers: readonly FarAnswer[], here: string): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const link of links) {
    const answer = answers.find((a) => a.design === link.far.design && a.element === link.far.element);
    if (answer == null) continue;
    const elements = [{ id: link.cableId, name: link.label || 'Link to another site' }];
    const site = answer.designName ?? link.label;
    if (answer.state === 'gone') {
      out.push({
        rule: 'site-link.far-gone',
        severity: 'warn',
        title: `The far end of this link is gone from ${site}`,
        fix: 'Pick the far port again, or remove the link.',
        why: `This cable says it lands on a port in ${site}, and that design no longer has the port.`,
        concept: 'links between sites',
        source: SOURCE,
        elements,
      });
      continue;
    }
    if (answer.state !== 'here') continue;
    const back = answer.back;
    if (back == null || back.design !== here || back.element !== (link.nearPortId ?? '')) {
      const where = [answer.device, answer.port].filter((s) => s !== '').join(' ');
      out.push({
        rule: 'site-link.one-sided',
        severity: 'idea',
        title: `This link is one-sided: ${where || 'the far port'} in ${site} doesn't point back`,
        fix: back == null ? `Open ${site} and link that port back to this one.` : `Open ${site}: that port links somewhere else.`,
        why: 'Each end of a link between sites is drawn in its own design. Until both ends name each other, a trace from the far side stops at its edge.',
        concept: 'links between sites',
        source: SOURCE,
        elements,
      });
    }
  }
  return out;
}

/** The engine's result with these findings added and counted. */
export function withSiteLinkFindings(result: ChecksResult | null, extra: readonly CheckFinding[]): ChecksResult | null {
  if (result == null || extra.length === 0) return result;
  const count = (s: CheckFinding['severity']) => extra.filter((f) => f.severity === s).length;
  return {
    ...result,
    refuse: result.refuse + count('refuse'),
    warn: result.warn + count('warn'),
    idea: result.idea + count('idea'),
    findings: [...result.findings, ...extra],
  };
}

/** The far ends this design's links name, asked of the server once the set of links changes. */
export function useSiteLinkFindings(doc: Document | null, organisationId: string | undefined, designId: string | undefined): CheckFinding[] {
  const links = useMemo(() => (doc == null ? [] : siteLinks(doc)), [doc]);
  const key = links.map((l) => `${l.cableId}>${l.far.design}/${l.far.element}@${l.nearPortId ?? ''}`).join('|');
  const [answers, setAnswers] = useState<FarAnswer[]>([]);
  useEffect(() => {
    if (organisationId == null || links.length === 0) {
      setAnswers([]);
      return;
    }
    let live = true;
    const unique = [...new Map(links.map((l) => [`${l.far.design}/${l.far.element}`, l.far])).values()];
    fetchFarEnds(organisationId, unique).then(
      (got) => {
        if (live) setAnswers(got);
      },
      () => {
        // The server is not answering: say nothing rather than guess.
        if (live) setAnswers([]);
      },
    );
    return () => {
      live = false;
    };
    // `key` stands for `links`: a new document with the same links asks nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organisationId, key]);
  return useMemo(() => (designId == null ? [] : siteLinkFindings(links, answers, designId)), [links, answers, designId]);
}

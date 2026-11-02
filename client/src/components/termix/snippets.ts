// Step commands become Termix snippets; the person runs them (ADR-0080 decision 4). Fathom makes the
// snippets and never runs one: it does not call Termix's `/execute` for a step's commands.
//
// What Termix's Snippets add-on offers, read from its source on 1 November 2026 (CLAUDE.md rule 1),
// `Termix-SSH/Plugin-Snippets` 1.2.0 at `d66ae50`, `src/backend/routes.ts`, mounted at
// `/plugin-api/snippets`:
// - `GET /` lists the user's snippets (`id`, `name`, `folder`, ...).
// - `POST /folders` {name} makes a folder, 409 when it exists.
// - `POST /` {name, content, description, folder, hostFilter} makes a snippet; `hostFilter` is a list of
//   Termix host ids the snippet is offered on (`src/frontend/types.ts`, `parseHostFilter`).
// - In a snippet, `${INPUT_n:label}` asks the person for a value when they run it
//   (`src/shared/variables.ts`).

import type { Plan, PlanStep } from '../../document/plans';
import { LINK_PLACEHOLDER, stepTitle, upgradeGroups } from '../firmware/upgradePlan';
import { TermixError, type TermixHost, call, matchHost } from './termix';

export const SNIPPETS = 'snippets';

/** Termix's folder for a plan's snippets: `Fathom / <plan>`, Termix's own nesting separator. */
export function snippetFolder(plan: Pick<Plan, 'title'>): string {
  const t = plan.title.replace(/\s*\/\s*/g, ' - ').trim();
  return t ? `Fathom / ${t}` : 'Fathom';
}

/** The steps that carry commands: a firmware plan's steps with commands in their detail. */
export function commandSteps(plan: Plan): PlanStep[] {
  if (upgradeGroups(plan).length === 0) return [];
  return plan.steps.filter((s) => s.after.trim() !== '');
}

/** The one-time link is never in a plan; Termix asks for it when the snippet runs. */
export const LINK_INPUT = '${INPUT_1:One-time link from Fathom}';

export interface SnippetBody {
  name: string;
  content: string;
  description: string;
  folder: string;
  hostFilter: number[] | null;
}

/** `<n> · <step title>`, the step's commands, and the plan's devices as Termix hosts. */
export function snippetFor(plan: Plan, step: PlanStep, deviceNames: readonly string[], hostIds: readonly number[]): SnippetBody {
  const names = deviceNames.length > 0 ? ` For ${deviceNames.join(', ')}.` : '';
  return {
    name: `${step.ordinal + 1} · ${stepTitle(step.change)}`,
    content: step.after.split(LINK_PLACEHOLDER).join(LINK_INPUT).trim(),
    description: `From Fathom's plan "${plan.title}", step ${step.ordinal + 1}.${names} Run it yourself, on the terminal you opened.`,
    folder: snippetFolder(plan),
    hostFilter: hostIds.length > 0 ? [...hostIds] : null,
  };
}

/** Termix host ids for these addresses, port 22 first, as Open in Termix finds them. */
export function hostIdsFor(hosts: readonly TermixHost[], addresses: readonly string[]): number[] {
  const ids = addresses.flatMap((a) => {
    const h = a.trim() === '' ? null : matchHost([...hosts], a);
    return h ? [h.id] : [];
  });
  return [...new Set(ids)];
}

export interface SnippetResult {
  sent: number;
  /** Already in that folder under the same name: Fathom does not overwrite a snippet a person may have edited. */
  already: number;
  folder: string;
}

type Fetch = typeof fetch;

/** Makes the folder (if missing) and one snippet per command step, skipping names already there. */
export async function sendSnippets(origin: string, key: string, bodies: readonly SnippetBody[], f: Fetch = fetch): Promise<SnippetResult> {
  const folder = bodies[0]?.folder ?? 'Fathom';
  const existing = await call(origin, key, 'GET', '/plugin-api/snippets', undefined, f);
  const have = new Set(
    (Array.isArray(existing) ? existing : []).flatMap((s: unknown) => {
      const r = s as Record<string, unknown> | null;
      return r && typeof r.name === 'string' ? [`${typeof r.folder === 'string' ? r.folder : ''}\u0000${r.name}`] : [];
    }),
  );
  try {
    await call(origin, key, 'POST', '/plugin-api/snippets/folders', { name: folder }, f);
  } catch (e) {
    // 409: the folder is there already. A refused key still stops the run.
    if (!(e instanceof TermixError) || e.status !== 409) throw e;
  }
  const out: SnippetResult = { sent: 0, already: 0, folder };
  for (const b of bodies) {
    if (have.has(`${b.folder}\u0000${b.name}`)) {
      out.already++;
      continue;
    }
    await call(origin, key, 'POST', '/plugin-api/snippets', b, f);
    out.sent++;
  }
  return out;
}

export function snippetSummary(r: SnippetResult): string {
  const parts = [`Sent ${r.sent} ${r.sent === 1 ? 'step' : 'steps'} to Termix as snippets, in ${r.folder}`];
  if (r.already) parts.push(`${r.already} ${r.already === 1 ? 'was there already and is left as it is' : 'were there already and are left as they are'}`);
  return parts.join('; ') + '. Run each one yourself, on the terminal you opened.';
}

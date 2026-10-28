// AI ideas on a design (ADR-0072 decision 7; mockup r33-ai-recs2-a, approved 2026-10-25):
// one panel, the same on the Canvas, Racks and Inventory, so deciding in one place is one
// decision everywhere. An idea changes nothing by itself: an AI never changes a design
// (owner, 2026-10-27). One that carries a change can be shown on the canvas in the plan
// colour first, and accepting it makes it, as the person's own edit; one that is steps only
// is marked done and the person makes the edit. Dismissing keeps nothing the AI wrote.
// Make it a plan turns the steps into a draft maintenance plan (no edits in it) and accepts.

import { useCallback, useEffect, useState } from 'react';

import { decideIdea, fetchIdeas, type AiIdea, type IdeaPreview } from '../../api/ai';
import { useAiPreview } from './aiPreview';
import type { SideTab } from '../shell/sideSlot';
import { aiError, ago, Info } from './parts';

/** How often a design that is open asks for new ideas. An idea is not urgent. */
const REFRESH_MS = 120_000;

export interface AiIdeasState {
  ideas: AiIdea[];
  open: AiIdea[];
  /** Ids a step of an open idea names, for the marks beside rows and devices. */
  targets: ReadonlySet<string>;
  reload: () => void;
}

/** The design's AI ideas, asked for when it opens and every two minutes after. */
export function useAiIdeas(organisationId: string, designId: string): AiIdeasState {
  const [ideas, setIdeas] = useState<AiIdea[]>([]);
  const reload = useCallback(() => {
    fetchIdeas(organisationId, designId).then(setIdeas, () => setIdeas([]));
  }, [organisationId, designId]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const open = ideas.filter((i) => i.state === 'open');
  const targets = new Set(open.flatMap((i) => i.steps.map((s) => s.target).filter((t): t is string => t !== null)));
  return { ideas, open, targets, reload };
}

/** The side tab, present while there is an idea to decide or the panel is open. */
export function aiIdeasTab(
  state: AiIdeasState,
  panelOpen: boolean,
  setPanelOpen: (open: boolean) => void,
  content: React.ReactNode,
): SideTab | null {
  if (state.open.length === 0 && !panelOpen) return null;
  return {
    id: 'ai-ideas',
    label: 'AI ideas',
    count: state.open.length,
    open: panelOpen,
    onOpen: () => setPanelOpen(true),
    onClose: () => setPanelOpen(false),
    content: panelOpen ? content : null,
  };
}

export interface AiIdeasPanelProps {
  organisationId: string;
  designId: string;
  state: AiIdeasState;
  /** The name a step's target has in this design, or null when it is not there. */
  nameOf: (id: string) => string | null;
  /** Show a target where the person is (select it on the canvas or in the list). */
  onShow?: (id: string) => void;
  canDraw: boolean;
  /** Make a draft maintenance plan from the idea (its steps become the plan's), then accept it. */
  onPlan?: (idea: AiIdea) => void;
  /** Show an idea's proposed change on the canvas, or null to stop showing it. */
  onPreview?: (idea: AiIdea | null) => void;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What Accept and apply would do, in words, for beside the canvas marks. */
export function previewSummary(p: IdeaPreview): string {
  const parts: string[] = [];
  if (p.changes.length > 0) parts.push(`changes ${plural(p.changes.length, 'thing', 'things')}`);
  if (p.removes.length > 0) parts.push(`removes ${p.removes.length}`);
  if (p.adds.length > 0) parts.push(`adds ${p.adds.map((a) => (a.name ? `${a.kind} “${a.name}”` : `a ${a.kind}`)).join(', ')}`);
  if (p.links.length > 0) parts.push(`draws ${plural(p.links.length, 'link', 'links')}`);
  return parts.length > 0 ? `It ${parts.join(', ')}.` : '';
}

export function AiIdeasPanel({ organisationId, designId, state, nameOf, onShow, canDraw, onPlan, onPreview }: AiIdeasPanelProps) {
  const shown = useAiPreview().ideaId;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const decided = state.ideas.filter((i) => i.state !== 'open');

  async function decide(idea: AiIdea, verb: 'accept' | 'dismiss') {
    setBusy(idea.id);
    setError(null);
    try {
      await decideIdea(organisationId, designId, idea, verb);
      if (shown === idea.id) onPreview?.(null);
      state.reload();
    } catch (e) {
      setError(aiError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ai-ideas" data-testid="ai-ideas">
      <p className="ai-muted">
        Ideas an AI app sent for this design.{' '}
        <Info label="What an AI idea is">
          Someone connected an AI app to Fathom and let it send ideas. An AI never changes the design itself: nothing changes
          until you decide. When the AI sent the change itself, Show on canvas draws it in the plan colour, with anything it
          removes greyed out, and Accept and apply makes it, as your own edit, so it is in the history under your name and History
          can restore the version before it. When it sent only steps, Mark done records that you accepted it, and you
          make the change yourself. Make it a plan turns its steps into a draft maintenance plan you can change, schedule and work
          through, and accepts it. Dismiss throws the idea away. In some folders a Steward asks for a second person to accept.
        </Info>
      </p>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {state.open.length === 0 && <p className="ai-muted">Nothing waiting.</p>}
      {state.open.map((idea) => (
        <article key={idea.id} className="ai-idea">
          <div className="ai-idea__by">
            <span>AI idea · from {idea.ownerName}’s connection</span>
            <span className="ai-idea__when">{ago(idea.createdAt)}</span>
          </div>
          <div className="ai-idea__title">{idea.title}</div>
          {idea.why && <p className="ai-body">{idea.why}</p>}
          <p className="ai-muted" data-testid="ai-idea-applies">
            {idea.changes !== null
              ? `Accept and apply makes ${idea.changes === 1 ? '1 change' : `${idea.changes} changes`} in this design, as your edit.`
              : 'Steps only: accepting changes nothing, you make the edit.'}
            {idea.preview !== null && ` ${previewSummary(idea.preview)}`}
          </p>
          {idea.preview !== null && onPreview && (
            <button
              type="button"
              className="ai-btn btn-small"
              data-testid="ai-idea-preview"
              aria-pressed={shown === idea.id}
              onClick={() => onPreview(shown === idea.id ? null : idea)}
            >
              {shown === idea.id ? 'Hide from canvas' : 'Show on canvas'}
            </button>
          )}
          <ul className="ai-idea__steps">
            {idea.steps.map((step, n) => {
              const target = step.target !== null ? nameOf(step.target) : null;
              return (
                <li key={n}>
                  <span className="ai-idea__action">{step.action}</span>
                  <span>
                    {step.text}
                    {target !== null && onShow && step.target !== null && (
                      <>
                        {' '}
                        <button type="button" className="ai-btn btn-small" onClick={() => onShow(step.target as string)}>
                          Show {target}
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {canDraw ? (
            <div className="ai-actions">
              <button type="button" className="ai-btn btn-main" disabled={busy !== null} onClick={() => void decide(idea, 'accept')}>
                {idea.changes !== null ? 'Accept and apply' : 'Mark done'}
              </button>
              {onPlan && (
                <button type="button" className="ai-btn" disabled={busy !== null} onClick={() => onPlan(idea)}>
                  Make it a plan
                </button>
              )}
              <button type="button" className="ai-btn" disabled={busy !== null} onClick={() => void decide(idea, 'dismiss')}>
                Dismiss
              </button>
            </div>
          ) : (
            <p className="ai-muted">Someone who can draw here accepts or dismisses it.</p>
          )}
        </article>
      ))}
      {decided.length > 0 && (
        <button type="button" className="ai-btn btn-small" onClick={() => setShowDecided(!showDecided)}>
          {showDecided ? 'Hide decided' : `Decided (${decided.length})`}
        </button>
      )}
      {showDecided &&
        decided.map((idea) => (
          <p key={idea.id} className="ai-muted">
            {idea.state === 'accepted' ? `Accepted: ${idea.title}` : 'Dismissed. Nothing of it was kept.'} {ago(idea.decidedAt)}
          </p>
        ))}
    </div>
  );
}

// AI ideas on a design (ADR-0072 decision 7; mockup r33-ai-recs2-a, approved 2026-10-25):
// one panel, the same on the Canvas, Racks and Inventory, so deciding in one place is one
// decision everywhere. An idea changes nothing by itself. Accepting marks it accepted and
// the person makes the change, as their own edit; dismissing keeps nothing the AI wrote.

import { useCallback, useEffect, useState } from 'react';

import { decideIdea, fetchIdeas, type AiIdea } from '../../api/ai';
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
}

export function AiIdeasPanel({ organisationId, designId, state, nameOf, onShow, canDraw }: AiIdeasPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const decided = state.ideas.filter((i) => i.state !== 'open');

  async function decide(idea: AiIdea, verb: 'accept' | 'dismiss') {
    setBusy(idea.id);
    setError(null);
    try {
      await decideIdea(organisationId, designId, idea, verb);
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
          Someone connected an AI app to Fathom and let it send ideas. An idea changes nothing in the design. Accept marks it as
          accepted, and you make the change yourself, as your own edit, so it is in the history under your name. Dismiss throws the
          idea away. In some folders a Steward asks for a second person to accept.
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
                        <button type="button" className="ai-btn ai-btn--small" onClick={() => onShow(step.target as string)}>
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
              <button type="button" className="ai-btn ai-btn--primary" disabled={busy !== null} onClick={() => void decide(idea, 'accept')}>
                Accept
              </button>
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
        <button type="button" className="ai-btn ai-btn--small" onClick={() => setShowDecided(!showDecided)}>
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

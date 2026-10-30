// Sign-off r60: "Also in", at the end of a device's panel. Each line opens the plan, the check or the AI
// ideas it names; nothing shows when nothing names the device.

import type { Plan } from '../../document/plans';
import type { CheckFinding } from '../../engine/engine';
import type { AlsoInLists } from './alsoIn';

export function AlsoIn({ lists, onOpenPlan, onOpenFinding, onOpenIdeas }: { lists: AlsoInLists; onOpenPlan: (plan: Plan) => void; onOpenFinding: (f: CheckFinding) => void; onOpenIdeas?: () => void }) {
  const { plans, findings, ideas } = lists;
  if (plans.length === 0 && findings.length === 0 && (!ideas || onOpenIdeas == null)) return null;
  return (
    <section className="drawing-editor__field also-in" aria-label="Also in" data-testid="also-in">
      <div className="drawing-editor__field-label">Also in</div>
      <ul className="also-in__list">
        {plans.map((p) => (
          <li key={p.id}>
            <span className="also-in__kind">Plan</span>
            <button type="button" className="also-in__link" onClick={() => onOpenPlan(p)}>
              {p.title || 'Untitled plan'}
            </button>
          </li>
        ))}
        {findings.map((f, i) => (
          <li key={`${f.rule}:${i}`}>
            <span className="also-in__kind">Check</span>
            <button type="button" className="also-in__link" onClick={() => onOpenFinding(f)}>
              {f.title}
            </button>
          </li>
        ))}
        {ideas && onOpenIdeas != null ? (
          <li>
            <span className="also-in__kind">AI idea</span>
            <button type="button" className="also-in__link" onClick={onOpenIdeas}>
              An open AI idea would change it
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

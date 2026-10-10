// Port ties (brief: port-ties): the list a paste, the device page's Ports tab and a trace or troubleshooting stop all
// open. Suggested pairs come ticked; the rest sit under "Not tied" with a port picker. "Tie these" is one edit, one
// undo step. Skipping is always allowed.
import { useId, useMemo, useState, type JSX } from 'react';

import type { TiePair, TiePlan } from '../../document/portTies';
import '../paste/paste.css';
import './ties.css';

export interface TieListProps {
  plan: TiePlan;
  /** Writes the ties; a returned string is the refusal to show. */
  onTie: (pairs: TiePair[]) => string | void;
  onAddPorts: () => string | void;
  onSkip: () => void;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function TieList({ plan, onTie, onAddPorts, onSkip }: TieListProps): JSX.Element {
  const suggested = plan.rows.filter((r) => r.suggested !== null);
  const open = plan.rows.filter((r) => r.suggested === null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(suggested.map((r) => r.interfaceId)));
  const [picks, setPicks] = useState<ReadonlyMap<string, string>>(new Map());
  const [refusal, setRefusal] = useState('');
  const headId = useId();
  const label = useMemo(() => new Map(plan.ports.map((p) => [p.id, p.label])), [plan.ports]);

  // A pick whose row or port has gone (someone else tied it) is dropped, never sent unseen.
  const pairs: TiePair[] = [
    ...suggested.filter((r) => ticked.has(r.interfaceId)).map((r) => ({ interfaceId: r.interfaceId, portId: r.suggested! })),
    ...[...picks].filter(([i, p]) => open.some((r) => r.interfaceId === i) && label.has(p)).map(([interfaceId, portId]) => ({ interfaceId, portId })),
  ];
  const used = new Set(pairs.map((p) => p.portId));
  const run = (r: string | void) => setRefusal(typeof r === 'string' ? r : '');

  return (
    <section className="ties" aria-labelledby={headId} data-testid="tie-list">
      <h3 className="ties__head" id={headId}>Tie {plural(plan.rows.length, 'interface', 'interfaces')} to ports</h3>

      {plan.canAddPorts ? (
        <>
          <p className="ties__note">This device has no ports drawn yet.</p>
          <p className="ties__note ties__muted">Each new port is tied to its interface. Read the numbers off the faceplate later.</p>
          <div className="paste-card__actions">
            <button type="button" onClick={() => run(onAddPorts())}>Add {plural(plan.rows.length, 'port', 'ports')} from this config</button>
            <button type="button" onClick={onSkip}>Not now</button>
          </div>
        </>
      ) : (
        <>
          {suggested.length > 0 && (
            <ul className="ties__rows">
              {suggested.map((r) => (
                <li key={r.interfaceId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={ticked.has(r.interfaceId)}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if (e.target.checked) next.add(r.interfaceId);
                        else next.delete(r.interfaceId);
                        setTicked(next);
                      }}
                    />{' '}
                    <span className="ties__name">{r.name}</span> ⇄ {label.get(r.suggested!) ?? ''}
                  </label>
                </li>
              ))}
            </ul>
          )}

          {open.length > 0 && (
            <>
              {suggested.length > 0 && <h4 className="ties__sub">Not tied</h4>}
              {plan.ports.length === 0 && <p className="ties__note ties__muted">This device has no free port to tie them to.</p>}
              <ul className="ties__rows">
                {open.map((r) => (
                  <li key={r.interfaceId} className="ties__open">
                    <span className="ties__name">{r.name}</span>
                    {plan.ports.length > 0 && (
                      <select
                        aria-label={`Port for ${r.name}`}
                        value={picks.get(r.interfaceId) ?? ''}
                        onChange={(e) => {
                          const next = new Map(picks);
                          if (e.target.value === '') next.delete(r.interfaceId);
                          else next.set(r.interfaceId, e.target.value);
                          setPicks(next);
                        }}
                      >
                        <option value="">Not tied</option>
                        {plan.ports
                          .filter((p) => p.id === picks.get(r.interfaceId) || !used.has(p.id))
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="paste-card__actions">
            <button type="button" disabled={pairs.length === 0} onClick={() => run(onTie(pairs))}>
              {pairs.length === 0 ? 'Tie these' : `Tie ${plural(pairs.length, 'interface', 'interfaces')}`}
            </button>
            <button type="button" onClick={onSkip}>Not now</button>
          </div>
        </>
      )}

      {refusal !== '' && <p className="paste-card__refusal" role="alert">{refusal}</p>}
    </section>
  );
}

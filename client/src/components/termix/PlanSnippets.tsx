// "Send to Termix" for a plan's command steps (ADR-0080 decision 4): one Termix snippet per step,
// in the folder `Fathom / <plan>`, offered on the plan's devices. The person runs them; Fathom never
// does. Without Termix, or without its Snippets add-on, each step's own Copy is the way.

import { useState } from 'react';

import type { Plan } from '../../document/plans';
import type { ReachableDevice } from './planDevices';
import { SNIPPETS, commandSteps, hostIdsFor, sendSnippets, snippetFor, snippetSummary } from './snippets';
import { TermixError, forgetKey, isTermixKey, listHosts, saveKey } from './termix';
import { useAddOns, useTermixKey } from './useAddOns';
import { useTermix } from './useTermix';
import './termix.css';

export function PlanSnippets({ plan, devices }: { plan: Plan; devices: readonly ReachableDevice[] }) {
  const { url: origin } = useTermix();
  const key = useTermixKey();
  const addOns = useAddOns(origin);
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const steps = commandSteps(plan);
  if (!origin || steps.length === 0) return null;
  if (addOns && !addOns.has(SNIPPETS)) {
    return (
      <p className="termix__hint" data-testid="termix-snippets-off">
        This Termix does not run its Snippets add-on, so the steps are not sent there. Copy each step&rsquo;s commands instead.
      </p>
    );
  }

  const run = async (k: string) => {
    setBusy(true);
    setSaid(null);
    try {
      const hosts = await listHosts(origin, k);
      const ids = hostIdsFor(hosts, devices.map((d) => d.address));
      const names = devices.map((d) => d.name);
      setSaid(snippetSummary(await sendSnippets(origin, k, steps.map((s) => snippetFor(plan, s, names, ids)))));
    } catch (e) {
      if (e instanceof TermixError && /API key/.test(e.message)) forgetKey();
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitKey = () => {
    if (!isTermixKey(typed)) {
      setSaid('A Termix API key starts tmx_ and has 64 letters and digits after it.');
      return;
    }
    saveKey(typed);
    setAsking(false);
    setTyped('');
    void run(typed.trim());
  };

  return (
    <div className="termix-snippets" data-testid="termix-snippets">
      <button type="button" className="plans-btn" disabled={busy} onClick={() => (key ? void run(key) : setAsking(true))}>
        {busy ? 'Sending…' : `Send ${steps.length === 1 ? 'the step' : `${steps.length} steps`} to Termix as snippets`}
      </button>
      {asking ? (
        <span className="termix-send__key">
          <input
            type="password"
            className="termix__key"
            aria-label="Termix API key"
            placeholder="Termix API key (tmx_…)"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitKey()}
          />
          <button type="button" className="btn-main" onClick={submitKey}>
            Send
          </button>
        </span>
      ) : null}
      <p className="termix__hint">Each step&rsquo;s commands become a snippet you run yourself in Termix. Fathom does not run them.</p>
      {said ? (
        <p className="termix__hint" role="status">
          {said}
        </p>
      ) : null}
    </div>
  );
}

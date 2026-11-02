// Fetch from Termix beside a check step's paste box (ADR-0080 decision 9). Shown only when a steward
// turned it on here, Termix is set, and the step's commands are all on the device's read-only list.
// What comes back goes into the paste box, unkept: the person reads it and presses Keep and compare,
// which runs the redaction gate first, as for any paste. Fathom never acts on it.

import { useState } from 'react';

import { fetchCheck } from './fetchCheck';
import type { ReachableDevice } from './planDevices';
import { readOnlyVerdict } from './readOnly';
import { TermixError, forgetKey, listHosts, matchHost } from './termix';
import { useTermixKey } from './useAddOns';
import { useTermix } from './useTermix';
import './termix.css';

interface Props {
  /** The step's commands, one per line, as written in the step. */
  commands: readonly string[];
  devices: readonly (ReachableDevice & { platform: string })[];
  onFetched: (text: string) => void;
}

export function FetchFromTermix({ commands, devices, onFetched }: Props) {
  const access = useTermix();
  const key = useTermixKey();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (!access.url || !access.fetch || commands.length === 0) return null;
  const origin = access.url;
  const usable = devices.filter((d) => d.address !== '');
  if (usable.length === 0) return null;

  const run = async (d: ReachableDevice & { platform: string }) => {
    if (!key) {
      setSaid('Paste your Termix API key under Open in Termix first.');
      return;
    }
    setBusy(d.id);
    setSaid(null);
    try {
      const host = matchHost(await listHosts(origin, key), d.address);
      if (!host) throw new TermixError(`${d.name} is not in Termix. Add it to Termix first.`);
      const parts: string[] = [];
      for (const c of commands) {
        const got = await fetchCheck(origin, key, d.platform, host.id, c);
        parts.push(`${d.name}> ${c}\n${got.output}${got.failed ? '\n(Termix says the command did not finish cleanly.)' : ''}`);
      }
      onFetched(parts.join('\n'));
      setSaid(`Fetched from ${d.name} through Termix. Read it, then Keep and compare; the redaction gate runs first.`);
    } catch (e) {
      if (e instanceof TermixError && e.status === 401) forgetKey();
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="termix-fetch" data-testid="termix-fetch">
      {usable.map((d) => {
        const refused = commands.map((c) => readOnlyVerdict(d.platform, c)).find((v) => !v.ok);
        if (refused && !refused.ok) {
          return (
            <p key={d.id} className="termix__hint" data-testid="termix-fetch-refused">
              No Fetch from Termix for {d.name}: {refused.why}
            </p>
          );
        }
        return (
          <button key={d.id} type="button" className="plans-btn" disabled={busy !== null} onClick={() => void run(d)}>
            {busy === d.id ? `Fetching from ${d.name}…` : `Fetch from Termix: ${d.name}`}
          </button>
        );
      })}
      <p className="termix__hint">Runs the step’s own read-only command in Termix, as your Termix user. Fathom does nothing because of what it reads.</p>
      {said ? (
        <p className="termix__hint" role="status">
          {said}
        </p>
      ) : null}
    </div>
  );
}

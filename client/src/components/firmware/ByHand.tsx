// "How the file gets there": Fathom's own route (the device pulls with a one-time link) or the same
// job by hand from a Windows PC or a Linux box, over SSH, on a USB stick or by TFTP (with its
// warning). Fathom is a learning tool, so the by-hand way sits beside its own (sign-off card
// "firmware by hand", answered 25 October: option A, all four ways, Fathom first). Only getting the file there changes;
// the steps before and after are the plan's. The pick is a per-browser convenience, never saved.

import { useId, useState, type ReactNode } from 'react';

import type { ByHand, ByHandStep, ByHandWay } from '../../api/firmware';
import { CommandToType, TypeItYourselfNote } from '../typing/CommandToType';
import { useTypeItYourself } from '../typing/typeItYourself';
import { CopyButton } from './parts';
import './firmware.css';
import { readPref, writePref } from '../../prefs';

export type Route = 'fathom' | 'windows' | 'linux';

const ROUTES: { route: Route; label: string }[] = [
  { route: 'fathom', label: 'Fathom link' },
  { route: 'windows', label: 'From Windows' },
  { route: 'linux', label: 'From Linux' },
];

const KEY = 'fathom.firmware.route';

export function readRoute(): Route {
  const v = readPref(KEY);
  return v === 'windows' || v === 'linux' ? v : 'fathom';
}

function keepRoute(route: Route): void {
  writePref(KEY, route);
}

const AT_WORD: Record<ByHandStep['at'], string> = { computer: 'On your computer', device: 'On the device' };

/** "check the file on your computer" as "Check the file on your computer". */
const sentence = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

export function ByHandSteps({ way, os, couldNotEstablish = [] }: { way: ByHandWay; os: 'windows' | 'linux'; couldNotEstablish?: string[] }) {
  const steps = way[os];
  const typing = useTypeItYourself();
  const all = steps.filter((s) => s.command !== '').map((s) => s.command).join('\n');
  return (
    <div className="fw-hand" data-testid="fw-by-hand">
      {typing && all !== '' ? <TypeItYourselfNote /> : null}
      {way.warning ? (
        <p className="fw-hand__warning" role="note">
          {way.warning}
        </p>
      ) : null}
      <ol className="fw-hand__steps">
        {steps.map((s) => (
          <li key={s.order} className="fw-hand__step">
            <span className="fw-label">{AT_WORD[s.at]}</span>
            <span className="fw-hand__title">{sentence(s.step)}</span>
            {s.command !== '' ? (
              <span className="fw-hand__cmd">
                {typing ? (
                  <CommandToType command={s.command} />
                ) : (
                  <>
                    <code className="fw-mono">{s.command}</code> <CopyButton text={s.command} label="Copy" className="fw-btn btn-quiet" />
                  </>
                )}
              </span>
            ) : null}
            <span className="fw-muted fw-hand__why">{s.note}</span>
          </li>
        ))}
      </ol>
      {all !== '' && !typing ? <CopyButton text={all} label="Copy all" /> : null}
      <p className="fw-muted">Then carry on with the next step: the check on the device is the same whichever way the file came.</p>
      {couldNotEstablish.map((line) => (
        <p key={line} className="fw-muted fw-not-established">{`Not established: ${line}`}</p>
      ))}
    </div>
  );
}

/** Chips that pick one of a few values. */
function Chips<T extends string>({ label, options, value, onPick }: { label: string; options: { value: T; label: string }[]; value: T; onPick: (v: T) => void }) {
  const labelId = useId();
  return (
    <>
      <div className="fw-label" id={labelId}>
        {label}
      </div>
      <div className="fw-route__switch" role="radiogroup" aria-labelledby={labelId}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`fw-chip${value === o.value ? ' fw-chip--on' : ''}`} onClick={() => onPick(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * The three-way switch, and under the two by-hand routes the ways the platform has (over SSH, USB
 * stick, TFTP). `children` is Fathom's own route, shown when it is picked, which it is by default.
 */
export function HowItGetsThere({ byHand, children }: { byHand: ByHand | null | undefined; children?: ReactNode }) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [wayKey, setWayKey] = useState('scp');
  if (!byHand) return <>{children}</>;
  const way = byHand.ways.find((w) => w.way === wayKey) ?? byHand.ways[0]!;
  return (
    <div className="fw-route">
      <Chips
        label="How the file gets there"
        options={ROUTES.map((r) => ({ value: r.route, label: r.label }))}
        value={route}
        onPick={(r) => {
          setRoute(r);
          keepRoute(r);
        }}
      />
      {route === 'fathom' ? (
        children
      ) : (
        <>
          {byHand.ways.length > 1 ? <Chips label="Which way" options={byHand.ways.map((w) => ({ value: w.way, label: w.label }))} value={way.way} onPick={setWayKey} /> : null}
          <ByHandSteps way={way} os={route} couldNotEstablish={byHand.couldNotEstablish} />
        </>
      )}
    </div>
  );
}

// Corrections from the floor, on a cable's page. A person who can only read sends "Traced",
// "Label wrong" or "Not here"; a person who can draw sees what is waiting and accepts or dismisses
// it. Nothing sent changes the record until someone with Draw accepts it.

import { useState } from 'react';

import type { CorrectionKind, CorrectionView } from '../../api/corrections';

export interface CorrectionsApi {
  /** Every correction the signed-in person may see, any cable. */
  list: readonly CorrectionView[];
  canDraw: boolean;
  send(cable: string, kind: CorrectionKind, text: string): Promise<{ refused: string } | void>;
  accept(c: CorrectionView): Promise<{ refused: string } | void>;
  dismiss(c: CorrectionView): Promise<{ refused: string } | void>;
}

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** One correction in a sentence. */
export function sayCorrection(c: CorrectionView, who: string): string {
  if (c.kind === 'traced') return `${who} traced this cable on ${new Date(c.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  const says = who === 'You' ? 'said' : 'says';
  if (c.kind === 'label') return `${who} ${says} the label should read “${c.text}”`;
  return `${who} ${says} it is not here: ${c.text}`;
}

const PROMPT: Record<Exclude<CorrectionKind, 'traced'>, { button: string; ask: string; max: number }> = {
  label: { button: 'Label wrong', ask: 'What should the label say?', max: 200 },
  not_here: { button: 'Not here', ask: 'Where is it actually?', max: 500 },
};

export function CableCorrections(props: { cableId: string; api: CorrectionsApi; accountId: string | null }) {
  const { cableId, api, accountId } = props;
  const here = api.list.filter((c) => c.cable === cableId);
  return api.canDraw ? <Waiting here={here} api={api} /> : <Send cableId={cableId} here={here} api={api} accountId={accountId} />;
}

function Send(props: { cableId: string; here: readonly CorrectionView[]; api: CorrectionsApi; accountId: string | null }) {
  const { cableId, here, api, accountId } = props;
  const [asking, setAsking] = useState<Exclude<CorrectionKind, 'traced'> | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async (kind: CorrectionKind, value: string) => {
    setBusy(true);
    const r = await api.send(cableId, kind, value);
    setBusy(false);
    if (r && 'refused' in r) {
      setMessage({ ok: false, text: r.refused });
      return;
    }
    setMessage({ ok: true, text: 'Sent. Someone who can edit this will look at it; nothing has changed yet.' });
    setAsking(null);
    setText('');
  };

  const mine = here.filter((c) => c.sender === accountId);
  return (
    <section className="inv-corr" aria-label="Tell the people who maintain this">
      <h3 className="inv-path__head">Seen something wrong?</h3>
      <div className="inv-corr__buttons">
        <button type="button" disabled={busy} onClick={() => void send('traced', '')}>
          Traced ✓
        </button>
        {(['label', 'not_here'] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={busy}
            aria-expanded={asking === k}
            onClick={() => {
              setMessage(null);
              setAsking(asking === k ? null : k);
              setText('');
            }}
          >
            {PROMPT[k].button}
          </button>
        ))}
      </div>
      {asking ? (
        <form
          className="inv-corr__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== '') void send(asking, text);
          }}
        >
          <label>
            <span className="inv-page__muted">{PROMPT[asking].ask}</span>
            <input type="text" value={text} maxLength={PROMPT[asking].max} autoFocus onChange={(e) => setText(e.currentTarget.value)} />
          </label>
          <button type="submit" disabled={busy || text.trim() === ''}>
            Send
          </button>
          <button type="button" onClick={() => setAsking(null)}>
            Cancel
          </button>
          <p className="inv-page__muted">Type it, or paste (pasted text passes the redaction gate). It goes to the people who can edit this design; it does not change the record.</p>
        </form>
      ) : null}
      {message ? (
        <p className={message.ok ? 'inv-page__muted' : 'inv-corr__refused'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      ) : null}
      {mine.length > 0 ? (
        <ul className="inv-page__list inv-corr__sent" aria-label="What you have sent about this cable">
          {mine.map((c) => (
            <li key={c.id}>
              <span>{sayCorrection(c, 'You')}</span>
              <span className="inv-page__muted">
                {c.state === 'open' ? 'waiting' : c.state} · {when(c.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Waiting(props: { here: readonly CorrectionView[]; api: CorrectionsApi }) {
  const { here, api } = props;
  const open = here.filter((c) => c.state === 'open');
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  if (open.length === 0) return null;
  const run = async (c: CorrectionView, verb: 'accept' | 'dismiss') => {
    setBusy(c.id);
    setRefused(null);
    const r = await (verb === 'accept' ? api.accept(c) : api.dismiss(c));
    setBusy(null);
    if (r && 'refused' in r) setRefused(r.refused);
  };
  return (
    <section className="inv-corr" aria-label="Corrections waiting">
      <h3 className="inv-path__head">Corrections waiting ({open.length})</h3>
      <ul className="inv-corr__waiting">
        {open.map((c) => (
          <li key={c.id}>
            <span>{sayCorrection(c, c.senderName)}</span>
            <span className="inv-page__muted">
              {when(c.createdAt)}
              {c.kind === 'not_here' ? ' · accepting adds it as a note on this cable' : c.kind === 'label' ? ' · accepting changes the label' : ' · accepting records the Last traced date'}
            </span>
            <span className="inv-corr__decide">
              <button type="button" disabled={busy === c.id} onClick={() => void run(c, 'accept')}>
                Accept
              </button>
              <button type="button" disabled={busy === c.id} onClick={() => void run(c, 'dismiss')}>
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
      {refused ? (
        <p className="inv-corr__refused" role="alert">
          {refused}
        </p>
      ) : null}
    </section>
  );
}

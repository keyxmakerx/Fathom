// Corrections from the floor, on a cable's page. A person who can only read sends "Traced",
// "Label wrong" or "Not here"; a person who can draw sees what is waiting and accepts or dismisses
// it. Nothing sent changes the record until someone with Draw accepts it.

import { useState } from "react";

import type { CorrectionKind, CorrectionView } from "../../api/corrections";

export interface CorrectionsApi {
  /** Every correction the signed-in person may see, any cable. */
  list: readonly CorrectionView[];
  canDraw: boolean;
  /** The Rust gate, for text about to be sent; null when it is not loaded. */
  redact?: ((text: string) => Promise<string>) | null;
  send(
    cable: string,
    kind: CorrectionKind,
    text: string,
  ): Promise<{ refused: string } | void>;
  accept(c: CorrectionView): Promise<{ refused: string } | void>;
  dismiss(c: CorrectionView): Promise<{ refused: string } | void>;
}

const when = (ms: number): string =>
  new Date(ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** One correction in a sentence. */
export function sayCorrection(c: CorrectionView, who: string): string {
  if (c.state === "dismissed" && c.kind !== "traced" && c.text === "") {
    return `${who} ${"sent"} ${c.kind === "label" ? "a label correction" : 'a "not here" report'} (the text is removed once dismissed)`;
  }
  if (c.kind === "traced")
    return `${who} traced this cable on ${new Date(c.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`;
  const says = who === "You" ? "said" : "says";
  if (c.kind === "label")
    return `${who} ${says} the label should read “${c.text}”`;
  return `${who} ${says} it is not here: ${c.text}`;
}

/** Said beside the box a reader types into. */
export const TYPED_WARNING =
  "Fathom does not hide what you type, so do not type passwords.";

const PROMPT: Record<
  Exclude<CorrectionKind, "traced">,
  { button: string; ask: string; max: number }
> = {
  label: { button: "Label wrong", ask: "What should the label say?", max: 200 },
  not_here: { button: "Not here", ask: "Where is it actually?", max: 500 },
};

export function CableCorrections(props: {
  cableId: string;
  api: CorrectionsApi;
  accountId: string | null;
}) {
  const { cableId, api, accountId } = props;
  const here = api.list.filter((c) => c.cable === cableId);
  // People who can draw edit directly, so they only get the Traced stamp beside what is waiting.
  return api.canDraw ? (
    <>
      <Waiting here={here} api={api} />
      <Send
        cableId={cableId}
        here={[]}
        api={api}
        accountId={accountId}
        stampOnly
      />
    </>
  ) : (
    <Send cableId={cableId} here={here} api={api} accountId={accountId} />
  );
}

function Send(props: {
  cableId: string;
  here: readonly CorrectionView[];
  api: CorrectionsApi;
  accountId: string | null;
  stampOnly?: boolean;
}) {
  const { cableId, here, api, accountId, stampOnly } = props;
  const [asking, setAsking] = useState<Exclude<
    CorrectionKind,
    "traced"
  > | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // Text the gate changed, held for the person to confirm: "Hidden before sending".
  const [hidden, setHidden] = useState<string | null>(null);

  const check = async (
    kind: Exclude<CorrectionKind, "traced">,
    value: string,
  ) => {
    if (!api.redact) {
      await send(kind, value);
      return;
    }
    setBusy(true);
    try {
      const flat = value.replace(/[\r\n\t]+/g, " ").trim();
      const clean = await api.redact(flat);
      setBusy(false);
      if (clean !== flat) {
        setHidden(clean);
        return;
      }
      await send(kind, flat);
    } catch {
      setBusy(false);
      setMessage({
        ok: false,
        text: "The redaction gate could not check that text, so nothing was sent.",
      });
    }
  };

  const send = async (kind: CorrectionKind, value: string) => {
    setBusy(true);
    const r = await api.send(cableId, kind, value);
    setBusy(false);
    if (r && "refused" in r) {
      setMessage({ ok: false, text: r.refused });
      return;
    }
    setMessage({
      ok: true,
      text: "Sent. Someone who can edit this will look at it; nothing has changed yet.",
    });
    setAsking(null);
    setText("");
    setHidden(null);
  };

  const mine = here.filter((c) => c.sender === accountId);
  return (
    <section
      className="inv-corr"
      aria-label="Tell the people who maintain this"
    >
      <h3 className="inv-path__head">Seen something wrong?</h3>
      <div className="inv-corr__buttons">
        <button
          type="button"
          disabled={busy}
          onClick={() => void send("traced", "")}
        >
          Traced ✓
        </button>
        {(stampOnly ? [] : (["label", "not_here"] as const)).map((k) => (
          <button
            key={k}
            type="button"
            disabled={busy}
            aria-expanded={asking === k}
            onClick={() => {
              setMessage(null);
              setAsking(asking === k ? null : k);
              setText("");
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
            if (text.trim() !== "") void check(asking, text);
          }}
        >
          <label>
            <span className="inv-page__muted">{PROMPT[asking].ask}</span>
            <input
              type="text"
              value={text}
              maxLength={PROMPT[asking].max}
              autoFocus
              onChange={(e) => {
                setText(e.currentTarget.value);
                setHidden(null);
              }}
            />
          </label>
          {hidden !== null ? (
            <p role="status" className="inv-page__muted">
              Hidden before sending: <q>{hidden}</q>
            </p>
          ) : null}
          {hidden !== null ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(asking, hidden)}
              >
                Send
              </button>
              <button type="button" onClick={() => setHidden(null)}>
                Edit
              </button>
            </>
          ) : (
            <button type="submit" disabled={busy || text.trim() === ""}>
              Send
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setAsking(null);
              setHidden(null);
            }}
          >
            Cancel
          </button>
          <p className="inv-page__muted">
            Type it, or paste (pasted text passes the redaction gate). It goes
            to the people who can edit this design; it does not change the
            record. {TYPED_WARNING}
          </p>
        </form>
      ) : null}
      {message ? (
        <p
          className={message.ok ? "inv-page__muted" : "inv-corr__refused"}
          role={message.ok ? "status" : "alert"}
        >
          {message.text}
        </p>
      ) : null}
      {mine.length > 0 ? (
        <ul
          className="inv-page__list inv-corr__sent"
          aria-label="What you have sent about this cable"
        >
          {mine.map((c) => (
            <li key={c.id}>
              <span>{sayCorrection(c, "You")}</span>
              <span className="inv-page__muted">
                {c.state === "open" ? "waiting" : c.state} · {when(c.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One waiting correction with its buttons. An orphan (its cable is gone) can only be dismissed. */
function WaitingRow(props: {
  c: CorrectionView;
  api: CorrectionsApi;
  exists: boolean;
  cableLabel?: string;
  onOpenCable?: () => void;
  busy: string | null;
  run: (c: CorrectionView, verb: "accept" | "dismiss") => void;
}) {
  const { c, api, exists, cableLabel, onOpenCable, busy, run } = props;
  void api;
  return (
    <li>
      {cableLabel !== undefined ? (
        <span>
          {onOpenCable ? (
            <button
              type="button"
              className="inv-page__link-inline"
              onClick={onOpenCable}
            >
              {cableLabel || "unlabelled cable"}
            </button>
          ) : (
            <span className="inv-page__muted">
              A cable that is no longer in this design
            </span>
          )}
        </span>
      ) : null}
      <span>{sayCorrection(c, c.senderName)}</span>
      <span className="inv-page__muted">
        {when(c.createdAt)}
        {!exists
          ? " · the cable is gone, so this can only be dismissed"
          : c.kind === "not_here"
            ? " · accepting adds it as a note on this cable"
            : c.kind === "label"
              ? " · accepting changes the label"
              : " · accepting records the Last traced date"}
      </span>
      <span className="inv-corr__decide">
        {exists ? (
          <button
            type="button"
            disabled={busy === c.id}
            onClick={() => run(c, "accept")}
          >
            Accept
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy === c.id}
          onClick={() => run(c, "dismiss")}
        >
          Dismiss
        </button>
      </span>
    </li>
  );
}

function useDecider(api: CorrectionsApi) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const run = async (c: CorrectionView, verb: "accept" | "dismiss") => {
    setBusy(c.id);
    setRefused(null);
    const r = await (verb === "accept" ? api.accept(c) : api.dismiss(c));
    setBusy(null);
    if (r && "refused" in r) setRefused(r.refused);
  };
  return { busy, refused, run };
}

function Waiting(props: {
  here: readonly CorrectionView[];
  api: CorrectionsApi;
}) {
  const { here, api } = props;
  const open = here.filter((c) => c.state === "open");
  const { busy, refused, run } = useDecider(api);
  if (open.length === 0 && !refused) return null;
  return (
    <section className="inv-corr" aria-label="Corrections waiting">
      <h3 className="inv-path__head">Corrections waiting ({open.length})</h3>
      <ul className="inv-corr__waiting">
        {open.map((c) => (
          <WaitingRow key={c.id} c={c} api={api} exists busy={busy} run={run} />
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

/** Every correction waiting on the design, whichever cable it is about, including ones whose cable
 * has since been removed: those can still be dismissed, so none can become impossible to clear. */
export function WaitingPage(props: {
  api: CorrectionsApi;
  cables: ReadonlyMap<string, string | null>;
  onOpenCable: (cableId: string) => void;
}) {
  const { api, cables, onOpenCable } = props;
  const open = api.list.filter((c) => c.state === "open");
  const { busy, refused, run } = useDecider(api);
  return (
    <section
      className="inv-corr inv-corr--page"
      aria-label="Corrections waiting"
    >
      <h3 className="inv-path__head">Corrections waiting ({open.length})</h3>
      {open.length === 0 ? (
        <p className="inv-page__muted">Nothing is waiting.</p>
      ) : null}
      <ul className="inv-corr__waiting">
        {open.map((c) => {
          const exists = cables.has(c.cable);
          return (
            <WaitingRow
              key={c.id}
              c={c}
              api={api}
              exists={exists}
              cableLabel={exists ? (cables.get(c.cable) ?? "") : ""}
              onOpenCable={exists ? () => onOpenCable(c.cable) : undefined}
              busy={busy}
              run={run}
            />
          );
        })}
      </ul>
      {refused ? (
        <p className="inv-corr__refused" role="alert">
          {refused}
        </p>
      ) : null}
    </section>
  );
}

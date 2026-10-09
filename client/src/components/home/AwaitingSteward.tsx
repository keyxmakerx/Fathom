import { useEffect, useState } from 'react';

import { spacedCode } from '../../api/grantBytes';
import { keyCheckCode } from '../../api/joining';

/** What someone who has joined from an invitation sees until a steward confirms them. */
export function AwaitingStewardView({ code }: { code: string | null }) {
  return (
    <section className="home__section" data-testid="awaiting-steward">
      <div className="home__label">Waiting for a steward to confirm you</div>
      <p className="home__muted">
        If you joined from an invitation, a steward has to confirm you before you can see anything here. Read them this
        code so they can check it is you. Nothing else is needed from you.
      </p>
      {code !== null && <p className="home__key-code">{spacedCode(code)}</p>}
      <p className="home__muted">
        Once they confirm you, the organisation appears here. Reload this page to check. If their code is different from
        this one, tell them: someone else may have used your link.
      </p>
    </section>
  );
}

/** Reads the code of this browser's own key for the signed-in account. */
export function AwaitingSteward({ address }: { address: string }) {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    keyCheckCode(address).then(
      (c) => !cancelled && setCode(c),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [address]);
  return <AwaitingStewardView code={code} />;
}

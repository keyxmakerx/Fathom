// The open organisation's Termix for the signed-in person (ADR-0078 decisions 1 and 6), shared by
// "Open in Termix" and "Send to Termix". Outside an organisation there is none.

import { createContext, useContext, useEffect, useState } from 'react';

import { fetchTermixAccess, type TermixAccess } from '../../api/termix';

/** The open organisation's id, provided by the place that shows a design. */
export const TermixOrganisation = createContext<string | null>(null);

const NONE: TermixAccess = { url: null, off: null };

/** `given` and `givenOff` are for tests: the answer without asking the server. */
export function useTermix(given?: string | null, givenOff: TermixAccess['off'] = null): TermixAccess {
  const organisation = useContext(TermixOrganisation);
  const [access, setAccess] = useState<TermixAccess>(given !== undefined ? { url: givenOff ? null : given, off: givenOff } : NONE);

  useEffect(() => {
    if (given !== undefined || organisation === null) return;
    let live = true;
    fetchTermixAccess(organisation).then(
      (a) => live && setAccess(a),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [given, organisation]);

  return access;
}

/** Why there is no Termix button, in a line. */
export function offWords(off: TermixAccess['off']): string | null {
  if (off === 'everyone') return 'A steward turned Termix off for everyone in this organisation.';
  if (off === 'you') return 'A steward turned Termix off for you in this organisation.';
  return null;
}

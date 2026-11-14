// Steward › Mail (ADR-0085 decision 7, the alpha card's Mail, 2026-11-14). Whether this server
// can send mail, and what was sent for this organisation: sent, waiting or failed, with the mail
// server's own reply. Never a body. `GET /organisations/{organisation}/mail`.

import { arrayOf, asRec, bool, int, jsonObject, oneOf, optInt, optStr, str } from './json';
import { signedFetch } from './signedFetch';

export type MailState = 'queued' | 'sent' | 'failed';

export interface SentMail {
  id: string;
  kind: 'reset' | 'invitation';
  state: MailState;
  to: string;
  what: string;
  attempts: number;
  createdAtUnix: number;
  nextAttemptAtUnix: number | null;
  finishedAtUnix: number | null;
  lastReply: string | null;
}

export interface MailPageData {
  /** Mail can go out: settings applied and links configured. */
  setUp: boolean;
  /** The server knows the address people open Fathom at, so mail can carry links. */
  links: boolean;
  fromAddress: string | null;
  /** Why mail cannot go out, in one sentence. */
  problem: string | null;
  mail: SentMail[];
}

export function parseMailPage(bytes: Uint8Array): MailPageData {
  const r = jsonObject(bytes, 'mail page');
  return {
    setUp: bool(r, 'set_up', 'mail page'),
    links: bool(r, 'links', 'mail page'),
    fromAddress: optStr(r, 'from_address', 'mail page'),
    problem: optStr(r, 'problem', 'mail page'),
    mail: arrayOf(r, 'mail', 'mail page').map((v) => {
      const m = asRec(v, 'mail');
      return {
        id: str(m, 'id', 'mail'),
        kind: oneOf(m, 'kind', ['reset', 'invitation'] as const, 'mail'),
        state: oneOf(m, 'state', ['queued', 'sent', 'failed'] as const, 'mail'),
        to: str(m, 'to', 'mail'),
        what: str(m, 'what', 'mail'),
        attempts: int(m, 'attempts', 'mail'),
        createdAtUnix: int(m, 'created_at_unix', 'mail'),
        nextAttemptAtUnix: optInt(m, 'next_attempt_at_unix', 'mail'),
        finishedAtUnix: optInt(m, 'finished_at_unix', 'mail'),
        lastReply: optStr(m, 'last_reply', 'mail'),
      };
    }),
  };
}

export async function fetchMailPage(organisationId: string): Promise<MailPageData> {
  return parseMailPage(await signedFetch('GET', `/organisations/${encodeURIComponent(organisationId)}/mail`));
}

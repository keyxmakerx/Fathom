import type { Notice } from '../../api/console';
import { countdownSentence } from './placementCopy';
import '../../styles/console.css';

/**
 * The standing facts every operator session has to show -- ADR-0055
 * decisions 4 and 8, `GET /admin/notices`, plus the one fact that does not
 * come from there: a console placement still waiting to be confirmed, which
 * `GET /placement/flag` carries because it is a fact about THIS host.
 *
 * Nothing here can be dismissed. The server derives each line from the
 * chain and the register and stores none of them (`operators::notices`),
 * so there is nothing for a button to clear -- and both facts are about
 * somebody having done something they should not be able to hide.
 */
export interface NoticesBannerProps {
  notices: Notice[];
  /** From `useConsoleHost()`: the unix second an unconfirmed placement stops
   * being honoured, or `null`. */
  pendingConfirmByUnix: number | null;
  /** Seconds remaining on that placement, recomputed by the caller's own
   * tick so there is one clock on this page and not three. */
  pendingSecondsLeft: number | null;
  host: string;
}

/**
 * The count `operators::live_independent_operators` gives, said honestly.
 *
 * **Zero is the ordinary answer on a fresh install**, and it does not mean
 * there is no operator: the register counts an operator as independent only
 * once their own sign-in is older than the independence window, so the first
 * operator does not count on their first day. Saying "0 live operators" to
 * the person who is signed in as one would be both wrong and alarming.
 */
export function countSentence(live: number): string {
  if (live <= 0) {
    return (
      'No server admin counts as a separate person yet. A server admin counts only after having their own ' +
      'sign-in for a while, so the first one does not count on their first day.'
    );
  }
  if (live === 1) {
    return 'Only one server admin counts so far; there should be two.';
  }
  return `${live} server admins count; there should be two.`;
}

export function NoticesBanner({
  notices,
  pendingConfirmByUnix,
  pendingSecondsLeft,
  host,
}: NoticesBannerProps) {
  const lines: { key: string; text: string; loud: boolean }[] = [];

  if (pendingConfirmByUnix !== null) {
    lines.push({
      key: 'placement',
      text: `The new address for Admin is not confirmed yet. ${countdownSentence(host, pendingSecondsLeft ?? 0)}`,
      loud: true,
    });
  }

  for (const notice of notices) {
    if (notice.kind === 'one_operator') {
      lines.push({
        key: 'one_operator',
        text:
          `${countSentence(notice.live)} If the only one is away, ` +
          `the way back in is the command fathom-server recover-operator, run on the machine that holds the key volume. ` +
          `This server was set up ${notice.weeks === 0 ? 'less than a week' : notice.weeks === 1 ? 'a week' : `${notice.weeks} weeks`} ago. ` +
          `Add a colleague below; with one server admin, the request waits out its delay on its own.`,
        loud: notice.weeks >= 1,
      });
    } else if (notice.kind === 'recovered_from_host') {
      lines.push({
        key: `recovered-${notice.atUnix}`,
        text:
          `A server admin was restored from the server machine on ${new Date(notice.atUnix * 1000).toLocaleString()}. ` +
          `Anyone with access to the key volume can do this: Fathom records it but cannot stop it. ` +
          `This notice stays until ${new Date(notice.untilUnix * 1000).toLocaleString()}. If it was not you, treat it as a security problem.`,
        loud: true,
      });
    } else if (notice.kind === 'backup') {
      lines.push({ key: `backup-${notice.line}`, text: notice.line, loud: true });
    } else {
      lines.push({ key: `raw-${notice.line}`, text: notice.line, loud: false });
    }
  }

  if (lines.length === 0) {
    return null;
  }

  return (
    <section
      className={`console-banner${lines.some((l) => l.loud) ? ' console-banner--loud' : ''}`}
      aria-label="Notices"
    >
      <h2 className="console-banner__title">Notices</h2>
      {lines.map((line) => (
        <p key={line.key} className="console-banner__line">
          {line.text}
        </p>
      ))}
    </section>
  );
}

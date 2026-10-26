import { useCallback, useEffect, useState } from 'react';

import { type BackupStatus, fetchBackupStatus } from '../../api/backups';
import { SkeletonRows } from '../ui/Skeleton';
import '../../styles/console.css';

/**
 * Admin › Settings › Backups (ADR-0070). What the nightly service last did,
 * whether the weekly restore test passed, whether a keys file exists for the
 * keys this server holds now, and the data files on hand.
 *
 * **It shows commands rather than buttons.** Making a keys file prints a
 * recovery phrase that must reach a person and never this server, and a
 * restore replaces the database under the server's feet; both belong on the
 * host, in a terminal, where `docs/OPERATING.md` walks through them.
 */
export interface BackupsViewProps {
  loaded: { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: BackupStatus };
}

export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** `made_at` is unix seconds; the rest of the times are already UTC text. */
function madeAt(unix: string | undefined): string | null {
  const n = Number(unix);
  if (!unix || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

export function lastBackupSentence(status: Record<string, string>): string {
  const at = status.last_backup_at;
  if (!at) return 'No backup has been made yet.';
  const size = status.last_backup_bytes ? `, ${sizeText(Number(status.last_backup_bytes))}` : '';
  const failed = status.last_result === 'failed' ? ' The run after it failed; see the notice above.' : '';
  return `Last backup ${at} (${status.last_backup_file ?? 'unnamed'}${size}).${failed}`;
}

export function restoreTestSentence(status: Record<string, string>): string {
  const result = status.last_test_result;
  if (!result) return 'No restore test has run yet. One runs weekly after the nightly backup.';
  if (result === 'ok') {
    const secs = status.last_test_seconds ? ` in ${status.last_test_seconds} s` : '';
    return `The last restore test passed${secs}, ${status.last_test_at ?? ''}, on ${status.last_test_file ?? 'the newest file'}.`;
  }
  if (result === 'failed') return `The last restore test failed, ${status.last_test_at ?? ''}: ${status.last_test_error ?? 'no reason recorded'}.`;
  return `Restore test: ${result}.`;
}

export function offsiteSentence(status: Record<string, string>): string {
  const target = status.offsite_target;
  if (!target) return 'No off-site copy is set up. The offsite profile copies the data files to S3-compatible storage.';
  if (status.offsite_result === 'failed') {
    return `The last copy to ${target} failed, ${status.offsite_failed_at ?? ''}: ${status.offsite_error ?? 'no reason recorded'}.`;
  }
  return `Data files are copied to ${target}; last copy ${status.offsite_last_ok_at ?? 'not yet made'}.`;
}

export function BackupsView({ loaded }: BackupsViewProps) {
  if (loaded.status === 'loading') return <SkeletonRows label="Loading the backup status…" rows={3} />;
  if (loaded.status === 'error') return <p className="console__warn">Could not read the backup status: {loaded.message}</p>;
  const b = loaded.value;
  const keysMade = madeAt(b.keysFile.made_at);
  return (
    <div data-testid="backups-panel">
      {b.notices.map((n) => (
        <p key={n} className="console__warn">
          {n}
        </p>
      ))}
      <p className="console__note">{lastBackupSentence(b.status)}</p>
      {b.status.schedule && (
        <p className="console__note">
          Schedule: {b.status.schedule}.{b.status.next_backup_at ? ` Next at ${b.status.next_backup_at}.` : ''}
        </p>
      )}
      <p className="console__note">{restoreTestSentence(b.status)}</p>
      <p className="console__note">{offsiteSentence(b.status)}</p>
      <p className="console__note">
        {keysMade
          ? `Keys file made ${keysMade}. Keep it and its recovery phrase apart from the backups, and apart from each other.`
          : 'No keys file has been made yet.'}
      </p>
      {b.files.length > 0 && (
        <table className="console__table">
          <thead>
            <tr>
              <th>Data file</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {b.files.map((f) => (
              <tr key={f.name}>
                <td>
                  <code>{f.name}</code>
                </td>
                <td>{sizeText(f.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="console__note">On the host, from the folder with compose.yaml:</p>
      <ul className="console__note">
        <li>
          Make a keys file (prints its recovery phrase once):{' '}
          <code>docker compose run --rm -T backup-keys &gt; fathom-keys.fkeys</code>
        </li>
        <li>
          Back up now: <code>docker compose exec backup backup-loop.sh once</code>
        </li>
        <li>
          Test a restore now: <code>docker compose exec backup backup-loop.sh test</code>
        </li>
        <li>
          Copy the backups off this host: <code>docker compose --profile offsite run --rm backup-offsite once</code>
        </li>
      </ul>
      <p className="console__note">Restoring onto a new host is in docs/OPERATING.md, under Restore.</p>
    </div>
  );
}

export function BackupsPanel() {
  const [loaded, setLoaded] = useState<BackupsViewProps['loaded']>({ status: 'loading' });
  const refresh = useCallback(() => {
    fetchBackupStatus()
      .then((value) => setLoaded({ status: 'ready', value }))
      .catch((error: unknown) =>
        setLoaded({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
      );
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <div className="console__form" aria-label="Backups">
      <div className="console__form-title">Backups</div>
      <BackupsView loaded={loaded} />
      <button type="button" className="console__btn console__btn--quiet" onClick={refresh}>
        Refresh
      </button>
    </div>
  );
}

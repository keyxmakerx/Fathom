import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseBackupStatus } from '../../api/backups';
import { concatBytes, lp, utf8 } from '../../crypto/bytes';
import { BackupsView, offsiteSentence, sizeText } from './BackupsPanel';

// Admin › Settings › Backups (ADR-0070). Render-to-string, per
// `ConsoleTabs.render.test.ts`; the bytes are the shape
// `backup_status.rs` answers.

function answer(status: string, record: string, files: string, notices: string): Uint8Array {
  const current = 'made_at 0\nfathom 0.1.0\nbackup_key aa\nmaster_key bb\nchain_key cc\nvault_key -\n';
  return concatBytes(lp(utf8(status)), lp(utf8(record)), lp(utf8(current)), lp(utf8(files)), lp(utf8(notices)));
}

describe('the backups panel', () => {
  it('reads the five fields and drops "-" values', () => {
    const b = parseBackupStatus(
      answer(
        'last_backup_at 2026-10-25T02:00:04Z\nlast_result ok\nlast_error -\n',
        'made_at 1792886400\nbackup_key aa\n',
        'fathom-2026-10-25T020004Z.fdata 2048\nfathom-2026-10-24T020003Z.fdata 1024\n',
        '',
      ),
    );
    expect(b.status.last_result).toBe('ok');
    expect(b.status.last_error).toBeUndefined();
    expect(b.current.vault_key).toBeUndefined();
    expect(b.files.map((f) => f.bytes)).toEqual([2048, 1024]);
    expect(b.notices).toEqual([]);
  });

  it('refuses trailing bytes', () => {
    const bytes = concatBytes(answer('', '', '', ''), new Uint8Array([1]));
    expect(() => parseBackupStatus(bytes)).toThrow(/trailing/);
  });

  it('shows the last backup, the files, the notices and the commands, and no button that restores', () => {
    const value = parseBackupStatus(
      answer(
        'last_backup_at 2026-10-25T02:00:04Z\nlast_backup_file fathom-2026-10-25T020004Z.fdata\n' +
          'last_backup_bytes 2048\nlast_result ok\nlast_test_result failed\nlast_test_error pg_restore: bad\n',
        '',
        'fathom-2026-10-25T020004Z.fdata 2048\n',
        'No keys file has been made for this install, so no backup can be opened yet.',
      ),
    );
    const html = renderToStaticMarkup(createElement(BackupsView, { loaded: { status: 'ready', value } }));
    expect(html).toContain('Last backup 2026-10-25T02:00:04Z');
    expect(html).toContain('2.0 KiB');
    expect(html).toContain('restore test failed');
    expect(html).toContain('No keys file has been made');
    expect(html).toContain('docker compose run --rm -T backup-keys');
    expect(html).not.toMatch(/<button/);
  });

  it('says where the off-site copy goes, or that there is none', () => {
    expect(offsiteSentence({})).toContain('No off-site copy');
    expect(offsiteSentence({ offsite_target: 'offsite:b/fathom', offsite_result: 'ok', offsite_last_ok_at: 'T' })).toContain(
      'copied to offsite:b/fathom',
    );
    expect(offsiteSentence({ offsite_target: 'x', offsite_result: 'failed', offsite_error: 'AccessDenied' })).toContain(
      'AccessDenied',
    );
  });

  it('says sizes plainly', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(3 * 1024 * 1024)).toBe('3.0 MiB');
  });
});

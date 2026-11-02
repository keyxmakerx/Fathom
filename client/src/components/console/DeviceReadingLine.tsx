import { useEffect, useState } from 'react';

import { fetchServerDeviceReading, type ServerDeviceReading } from '../../api/deviceReadServer';
import '../../styles/console.css';

/**
 * Admin › Settings › Device reading (ADR-0082 §4.4, ADR-0088 item 4). One
 * read-only line: whether this server reads devices at all. It is an
 * environment setting, so changing it is a restart on the host
 * (`docs/OPERATING.md`), and each organisation's Steward still decides
 * whether to use it and which ranges it may reach.
 */
export function deviceReadingSentence(v: ServerDeviceReading): string {
  if (!v.server) return 'Off for this server. To turn it on, set FATHOM_DEVICE_READ=on and start the reader profile, then restart.';
  if (!v.reader) return 'On for this server, but its reader is not answering. Start the reader profile.';
  return 'On for this server, and its reader is answering. Each organisation’s Steward decides whether to use it, and for which ranges.';
}

export function DeviceReadingLineView({ loaded }: { loaded: ServerDeviceReading | 'loading' | { error: string } }) {
  return (
    <div className="console__form" aria-label="Device reading" data-testid="console-device-reading">
      <div className="console__form-title">Device reading</div>
      {loaded === 'loading' ? (
        <p className="console__note">Loading…</p>
      ) : 'error' in loaded ? (
        <p className="console__warn" role="alert">
          Could not read whether this server reads devices: {loaded.error}
        </p>
      ) : (
        <p className="console__note" data-testid="console-device-reading-state">
          {deviceReadingSentence(loaded)}
        </p>
      )}
    </div>
  );
}

export function DeviceReadingLine() {
  const [loaded, setLoaded] = useState<ServerDeviceReading | 'loading' | { error: string }>('loading');
  useEffect(() => {
    let live = true;
    fetchServerDeviceReading().then(
      (v) => live && setLoaded(v),
      (e: unknown) => live && setLoaded({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return <DeviceReadingLineView loaded={loaded} />;
}

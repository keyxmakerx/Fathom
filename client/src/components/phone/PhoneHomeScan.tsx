// Home on a phone starts with one big Scan button (ADR-0075). A Fathom label opens its item; a serial
// needs a design open first, because Find searches the design you are in.

import { useState } from 'react';
import { ScanSheet } from './ScanSheet';
import { parseScannedText, type ScanTarget } from './scan';
import { usePhone } from './usePhone';
import './phone.css';

export function PhoneHomeScan({ onScan }: { onScan(target: ScanTarget): void }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!phone) return null;
  return (
    <div className="phone-home">
      <button
        type="button"
        className="phone-home__scan"
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}
      >
        Scan a label
      </button>
      {open && (
        <ScanSheet
          message={message}
          onClose={() => setOpen(false)}
          onResult={(text) => {
            const target = parseScannedText(text, window.location.origin);
            if (target == null) {
              setMessage('That is not a Fathom label. To look up a serial, open a design first and use Find.');
              return;
            }
            setOpen(false);
            onScan(target);
          }}
        />
      )}
    </div>
  );
}

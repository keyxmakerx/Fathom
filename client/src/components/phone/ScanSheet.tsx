// Scan, from inside Fathom (ADR-0075 decision 3). The camera is asked for only when this opens, the
// browser's own barcode reader does the reading (no package: OPEN-QUESTIONS A3), and the frames never
// leave the phone; only the text it reads is used. Where the browser has no reader (Safari on iPhone
// keeps it off: caniuse "BarcodeDetector API", read 2026-10-26), the sheet says so and the person
// types instead. A Fathom label still opens from the phone's own Camera app on every phone.

import { useEffect, useId, useRef, useState } from 'react';
import './phone.css';

/** The slice of the Barcode Detection API this uses (not in TypeScript's DOM library). */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

/** QR for Fathom's own labels; the 1D and 2D codes serials come in on optics, PSUs and boxes. */
const WANTED = ['qr_code', 'code_128', 'code_39', 'data_matrix', 'ean_13', 'upc_a'];
const TICK_MS = 250;

export type CameraState = 'starting' | 'looking' | 'no-reader' | 'no-camera' | 'refused';

function detectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

export interface ScanSheetProps {
  /** What was read or typed, trimmed and not empty. */
  onResult(text: string): void;
  onClose(): void;
  /** Shown under the camera, e.g. why the last read did not open anything. */
  message?: string | null;
}

export function ScanSheet({ onResult, onClose, message }: ScanSheetProps) {
  const [state, setState] = useState<CameraState>('starting');
  const [typed, setTyped] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const last = useRef('');
  const fieldId = useId();
  const resultRef = useRef(onResult);
  resultRef.current = onResult;

  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor) {
      setState('no-reader');
      return undefined;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setState('no-camera');
      return undefined;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;
    void (async () => {
      let formats = WANTED;
      try {
        const have = (await Ctor.getSupportedFormats?.()) ?? WANTED;
        formats = WANTED.filter((f) => have.includes(f));
      } catch {
        // keep the wanted list; the constructor refuses what it cannot read
      }
      if (formats.length === 0) {
        if (live) setState('no-reader');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        if (live) setState(e instanceof DOMException && e.name === 'NotAllowedError' ? 'refused' : 'no-camera');
        return;
      }
      if (!live || !video.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      setState('looking');
      const detector = new Ctor({ formats });
      const tick = async () => {
        if (!live || !video.current) return;
        try {
          const found = await detector.detect(video.current);
          const text = found.map((b) => b.rawValue.trim()).find((t) => t !== '');
          // The same code held in view reads every tick; it is handed on once, not every 250 ms.
          if (text && text !== last.current) {
            last.current = text;
            resultRef.current(text);
          }
        } catch {
          // a frame that is not ready yet; try the next one
        }
        if (live) timer = setTimeout(() => void tick(), TICK_MS);
      };
      void tick();
    })();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = typed.trim();
    if (t) onResult(t);
  };

  return (
    <div className="phone-scan" role="dialog" aria-modal="true" aria-label="Scan a label">
      <div className="phone-scan__head">
        <span className="phone-scan__title">Scan</span>
        <button type="button" className="phone-scan__close" onClick={onClose}>
          Close
        </button>
      </div>
      {(state === 'starting' || state === 'looking') && (
        <div className="phone-scan__camera">
          <video ref={video} muted playsInline aria-label="What the camera sees" />
          <span className="phone-scan__frame" aria-hidden="true" />
        </div>
      )}
      <p className="phone-scan__say" role="status">
        {state === 'starting' && 'Starting the camera…'}
        {state === 'looking' && 'Point at a Fathom label or a serial barcode.'}
        {state === 'no-reader' && (
          <>
            This browser can't read barcodes. Fathom labels still open from your phone's Camera app. Type a serial
            below.
          </>
        )}
        {state === 'no-camera' && 'No camera is available here. The camera needs the page opened over HTTPS.'}
        {state === 'refused' && 'The camera was not allowed. You can allow it in the browser’s site settings, or type below.'}
      </p>
      {message && (
        <p className="phone-scan__message" role="alert">
          {message}
        </p>
      )}
      <form className="phone-scan__type" onSubmit={submit}>
        <label htmlFor={fieldId}>Or type the label or serial</label>
        <div className="phone-scan__row">
          <input
            id={fieldId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          <button type="submit" disabled={typed.trim() === ''}>
            Go
          </button>
        </div>
      </form>
      <p className="phone-scan__note">Nothing the camera sees leaves this phone. Only the text it reads is used.</p>
    </div>
  );
}

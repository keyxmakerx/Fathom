import { useMemo } from 'react';

import { QrTooLongError, encodeQr } from './encode';
import { QR_QUIET_ZONE, qrPath, qrSide } from './svg';

export interface QrCodeProps {
  /** What the code says. For the enrolment screen this is the `otpauth://`
   * URI the server drew. */
  value: string;
  /** What a screen reader says instead of the picture. The value itself is
   * never read out: it carries the setup key, and a page that reads a secret
   * aloud has chosen for the person in the room. */
  label: string;
}

/**
 * The QR code, drawn as inline SVG (ADR-0056 decision 5).
 *
 * **Why a picture at all, when the setup key is right beside it.** Bitwarden
 * captures an authenticator secret by decoding a QR code out of a screenshot
 * of the visible tab; text, copy buttons and an `otpauth://` link are
 * invisible to it (ADR-0056, *What was looked at*). A person whose password
 * manager holds their second factor cannot enrol from a page with no code on
 * it. A phone camera is the same requirement from the other direction.
 *
 * Two colours, fixed rather than themed: the code needs dark modules on a
 * light field whichever way round the page is, so `styles/authenticator.css`
 * paints the paper white and the modules black in both themes. That is the
 * one place in this client where the theme does not decide.
 */
export function QrCode({ value, label }: QrCodeProps) {
  const drawn = useMemo(() => {
    try {
      const symbol = encodeQr(value);
      return { side: qrSide(symbol.size), path: qrPath(symbol.modules, QR_QUIET_ZONE) };
    } catch (error) {
      // Only the one refusal this encoder has. Anything else is a fault, and
      // a fault in drawing a picture must not take the screen down: the
      // setup key underneath it is the way through either way.
      if (!(error instanceof QrTooLongError)) console.error(error);
      return null;
    }
  }, [value]);

  if (drawn === null) {
    return (
      <p className="qr__missing" data-testid="qr-missing">
        This code could not be drawn here. Use the setup key below instead — it says the same thing.
      </p>
    );
  }

  return (
    <svg
      className="qr"
      data-testid="qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${drawn.side} ${drawn.side}`}
      shapeRendering="crispEdges"
    >
      <rect className="qr__paper" x="0" y="0" width={drawn.side} height={drawn.side} />
      <path className="qr__modules" d={drawn.path} />
    </svg>
  );
}

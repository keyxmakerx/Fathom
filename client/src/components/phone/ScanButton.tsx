// A Scan button beside a field that takes a serial number (ADR-0075): on a phone it opens the scan
// sheet and puts what the camera read into the field. On a computer it is not shown; typing is quicker.

import { useState } from "react";
import { createPortal } from "react-dom";

import { ScanSheet } from "./ScanSheet";
import { usePhone } from "./usePhone";

export function ScanButton({
  onText,
  label = "Scan",
}: {
  onText(text: string): void;
  label?: string;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!phone) return null;
  return (
    <>
      <button
        type="button"
        className="btn-quiet phone-scan-into"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {/* To the body: the button sits inside the field's label, and a click in the sheet must not reach it. */}
      {open &&
        createPortal(
          <ScanSheet
            onResult={(text) => {
              setOpen(false);
              onText(text);
            }}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

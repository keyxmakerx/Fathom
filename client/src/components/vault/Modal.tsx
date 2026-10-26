import { useEffect, useId, useRef, type ReactNode } from 'react';

/** A centred sheet over a scrim. Escape and the scrim close it; focus starts inside. */
export function VaultModal({ title, onClose, children, wide, testId }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string }) {
  const head = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input, button, select, textarea');
    first?.focus();
  }, []);
  return (
    <div className="vault-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={wide ? 'vault-sheet vault-sheet--wide' : 'vault-sheet'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={head}
        data-testid={testId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="vault-sheet__title" id={head}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

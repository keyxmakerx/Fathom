// The hint card: point at a control (or tab to it) and a small frosted card says its name, what it does in a
// plain sentence, and its shortcut. One listener for the whole page, so the controls stay as they are: a
// control opts in with `hint(...)` (`hints.ts`). Moving along a row of tools, the card glides to the next
// one instead of blinking. It never takes a click, and it goes at the first press, key or scroll.
//
// The control keeps its `title` for a screen reader; it is taken off only while the pointer is on the
// control, so the browser's own tooltip never shows beside the card (the port peek does the same).

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import '../../styles/hints.css';
import { HINT_LINGER_MS, HINT_WARM_DELAY_MS, hintDelay, keyCaps, placeHint, readHint, type Hint, type HintPlace, type HintSide } from './hints';

const SELECTOR = '[data-hint]';

interface Shown {
  hint: Hint;
  side: HintSide;
  box: { left: number; top: number; width: number; height: number };
  /** The card was already up when this hint came: it glides here. */
  glide: boolean;
}

function controlOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(SELECTOR) : null;
}

function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** The card itself: what `Hints` draws, and what the tests read. */
export function HintCard({ hint }: { hint: Hint }) {
  return (
    <div className="hint__card">
      <div className="hint__head">
        <span className="hint__name">{hint.name}</span>
        {hint.keys != null && (
          <span className="hint__keys">
            {keyCaps(hint.keys).map((cap, i) => (
              <kbd key={`${cap}-${i}`} className="hint__key">
                {cap}
              </kbd>
            ))}
          </span>
        )}
      </div>
      {hint.more != null && <div className="hint__more">{hint.more}</div>}
    </div>
  );
}

export function Hints() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [place, setPlace] = useState<HintPlace | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let linger: ReturnType<typeof setTimeout> | null = null;
    // The control the pointer (or focus) is on, and its own title while we hold it.
    let current: HTMLElement | null = null;
    let savedTitle: string | null = null;
    // The control the card is describing now.
    let described: HTMLElement | null = null;
    let describedBefore: string | null = null;
    let lastUpUntil: number | null = null;
    // The control just pressed: its hint stays away until the pointer has left it.
    let pressed: HTMLElement | null = null;
    let tabbing = false;
    let gone: MutationObserver | null = null;

    const giveTitleBack = () => {
      if (current != null && savedTitle != null && !current.hasAttribute('title')) current.setAttribute('title', savedTitle);
      current = null;
      savedTitle = null;
    };
    const undescribe = () => {
      if (described != null) {
        if (describedBefore != null) described.setAttribute('aria-describedby', describedBefore);
        else described.removeAttribute('aria-describedby');
      }
      described = null;
      describedBefore = null;
    };
    const stopTimers = () => {
      if (timer != null) clearTimeout(timer);
      if (linger != null) clearTimeout(linger);
      timer = null;
      linger = null;
    };
    const hide = () => {
      stopTimers();
      giveTitleBack();
      if (described != null) lastUpUntil = Date.now();
      undescribe();
      gone?.disconnect();
      gone = null;
      setShown(null);
    };
    const show = (el: HTMLElement) => {
      timer = null;
      const hint = el.isConnected && el.getAttribute('aria-expanded') !== 'true' ? readHint((name) => el.getAttribute(name)) : null;
      if (hint == null) return hide();
      const glide = described != null;
      undescribe();
      described = el;
      describedBefore = el.getAttribute('aria-describedby');
      el.setAttribute('aria-describedby', id);
      const r = el.getBoundingClientRect();
      setShown({ hint, glide, side: el.getAttribute('data-hint-side') === 'left' ? 'left' : 'below', box: { left: r.left, top: r.top, width: r.width, height: r.height } });
      // The control went away under the pointer (its menu closed, the view changed): so does its hint.
      if (gone == null) {
        gone = new MutationObserver(() => {
          if (described != null && !described.isConnected) hide();
        });
        gone.observe(document.body, { childList: true, subtree: true });
      }
    };
    const schedule = (el: HTMLElement, focus: boolean) => {
      if (el === current) return;
      stopTimers();
      giveTitleBack();
      current = el;
      // The browser's own tooltip would say the same a moment later; ours replaces it while pointed at.
      savedTitle = el.getAttribute('title');
      if (savedTitle != null) el.removeAttribute('title');
      // A card already up stays where it is until the next one is ready, then glides: nothing blinks.
      const delay = described != null ? HINT_WARM_DELAY_MS : hintDelay(Date.now(), lastUpUntil, focus);
      timer = setTimeout(() => show(el), delay);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = controlOf(e.target);
      if (el == null || e.buttons !== 0 || el === pressed) return;
      if (el.getAttribute('aria-expanded') === 'true') return;
      schedule(el, false);
    };
    const onOut = (e: PointerEvent) => {
      const left = controlOf(e.target);
      if (left == null) return;
      if (e.relatedTarget instanceof Node && left.contains(e.relatedTarget)) return;
      if (left === pressed) pressed = null;
      if (left !== current) return;
      // Off this control. The card waits a moment in case the pointer is on its way to the next one.
      if (timer != null) clearTimeout(timer);
      timer = null;
      giveTitleBack();
      if (described == null) return;
      if (linger != null) clearTimeout(linger);
      linger = setTimeout(hide, HINT_LINGER_MS);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = controlOf(e.target);
      // Only a Tab to the control itself: focus handed back by a closing menu says nothing new.
      if (tabbing && el != null && el === e.target && focusVisible(el)) schedule(el, true);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (current != null && controlOf(e.target) === current) hide();
    };
    const onDown = (e: PointerEvent) => {
      pressed = controlOf(e.target);
      tabbing = false;
      if (current != null || described != null || timer != null) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      tabbing = e.key === 'Tab';
      if (current != null || described != null || timer != null) hide();
    };
    const onAway = () => {
      if (current != null || described != null || timer != null) hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', onAway, { capture: true, passive: true });
    window.addEventListener('blur', onAway);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', onAway, true);
      window.removeEventListener('blur', onAway);
      stopTimers();
      gone?.disconnect();
      giveTitleBack();
      undescribe();
    };
  }, [id]);

  useLayoutEffect(() => {
    if (shown == null) {
      setPlace(null);
      return;
    }
    const card = cardRef.current;
    setPlace(placeHint(shown.box, { width: card?.offsetWidth ?? 0, height: card?.offsetHeight ?? 0 }, { width: window.innerWidth, height: window.innerHeight }, shown.side));
  }, [shown]);

  if (shown == null) return null;
  return createPortal(
    <div
      ref={cardRef}
      id={id}
      data-fathom-layer=""
      className={shown.glide && place != null ? 'hint hint--glide' : 'hint'}
      role="tooltip"
      data-testid="hint"
      data-from={place?.from}
      data-print-omit=""
      style={{ transform: `translate3d(${Math.round(place?.left ?? 0)}px, ${Math.round(place?.top ?? 0)}px, 0)`, visibility: place == null ? 'hidden' : 'visible' }}
    >
      <HintCard hint={shown.hint} />
    </div>,
    document.body,
  );
}

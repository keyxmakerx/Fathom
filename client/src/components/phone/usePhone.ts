import { useEffect, useState } from 'react';

/** The field view's width (ADR-0075): the same 760px Inventory already folds to one column at. */
export const PHONE_QUERY = '(max-width: 760px)';

export function isPhoneNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/** True while the window is phone-narrow; follows rotation and a resized desktop window. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhoneNow);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const read = () => setPhone(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);
  return phone;
}

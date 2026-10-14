import { useEffect, useRef } from 'react';
import { isImeComposing } from '../utils/imeComposition';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for a hand-built modal: Escape closes it (unless
 * `busy`), focus moves into it on open and back to the trigger on close, and
 * Tab cycles inside it. Attach the returned ref to the dialog panel.
 */
export function useModalFocus<T extends HTMLElement>(isOpen: boolean, onClose: () => void, busy = false) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!isOpen) return undefined;
    const returnTo = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    // An autoFocus field inside keeps its focus.
    if (!panel?.contains(document.activeElement)) focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      // An Escape that cancels an IME composition belongs to the field.
      if (e.key === 'Escape' && !busyRef.current && !isImeComposing(e)) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [isOpen]);

  return ref;
}

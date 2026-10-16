import { useEffect, useRef } from 'react';

const inOtherDialog = (el: Element | null, container: HTMLElement) =>
  !!el && !container.contains(el) && !!el.closest('[role="dialog"]');

/**
 * `containFocus` is for a drawer over the page: focus that lands outside it
 * anyway (the focused control unmounted, so the next Tab starts from the
 * body) is pulled back in, and a dialog open on top keeps its focus, both
 * when the trap starts and while it runs.
 */
export const useFocusTrap = (isActive: boolean, { containFocus = false }: { containFocus?: boolean } = {}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    // Read on every Tab, not once: a control enabled or added after the trap
    // opened (a dialog's primary action, once its data has loaded) must be
    // reachable too. A control not rendered at this breakpoint (`hidden
    // lg:flex`) is skipped: as the first or last entry it cannot take focus,
    // so the wrap would stall on it. Without checkVisibility (jsdom, older
    // Safari) every match counts, as before.
    const focusable = () => Array.from(container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => typeof el.checkVisibility !== 'function' || el.checkVisibility());

    // Focus first element when trap is activated
    if (!(containFocus && inOtherDialog(document.activeElement, container))) {
      focusable()[0]?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const elements = focusable();
      const firstFocusable = elements[0];
      const lastFocusable = elements[elements.length - 1];

      if (e.shiftKey) {
        // Shift + Tab
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable?.focus();
        }
      } else {
        // Tab
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable?.focus();
        }
      }
    };

    // Only focus arriving from outside (or from nowhere) is pulled back:
    // focus the owner moves out on purpose, such as back to the toggle as the
    // drawer closes, comes from inside and is let through.
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as Element | null;
      const from = e.relatedTarget as Node | null;
      if (!target || container.contains(target) || inOtherDialog(target, container)) return;
      if (from && container.contains(from)) return;
      focusable()[0]?.focus();
    };

    container.addEventListener('keydown', handleKeyDown);
    if (containFocus) document.addEventListener('focusin', handleFocusIn);

    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [isActive, containFocus]);

  return containerRef;
};
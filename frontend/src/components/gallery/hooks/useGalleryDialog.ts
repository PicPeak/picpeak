import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { pushDialogLayer } from '../../common/Modal';
import { lockBodyScroll } from '../../../utils/scrollLock';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface GalleryDialogOptions {
  open: boolean;
  onClose: () => void;
  /** The dialog box: focus moves into it and stays inside while open. */
  panelRef: RefObject<HTMLElement>;
  /** Focused on open instead of the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement>;
  /** False when the dialog must be answered: Escape then does nothing. */
  dismissible?: boolean;
}

/**
 * The keyboard and focus behaviour of the common `Modal`, for the gallery's
 * own dialogs. The common Modal paints with the admin UI tokens, which never
 * follow the operator's gallery theme, so gallery dialogs keep their themed
 * markup and take the behaviour from here: Escape closes the top dialog only
 * (a confirm over a dialog closes the confirm), Tab stays inside, focus goes
 * back to the opener, and the page behind does not scroll.
 *
 * Escape is caught in the capture phase so a dialog opened over the lightbox
 * closes itself, not the lightbox underneath.
 */
export function useGalleryDialog({
  open,
  onClose,
  panelRef,
  initialFocusRef,
  dismissible = true,
}: GalleryDialogOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const panelHasFocus = panel?.contains(document.activeElement);
    if (!panelHasFocus) {
      const first = initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
      first?.focus();
    }

    const unlockScroll = lockBodyScroll();

    const layer = pushDialogLayer();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!layer.isTop()) return;
      // Escape that cancels an IME composition in a field belongs to the
      // field. Safari ends the composition before the keydown, so only the
      // 229 keyCode tells it apart there.
      if (e.key === 'Escape' && (e.isComposing || e.keyCode === 229)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const all = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      // Skip controls that are not rendered (display: none has no offsetParent);
      // a layout-less DOM reports none at all, so then keep every one.
      const shown = all.filter((el) => el.offsetParent !== null);
      const items = shown.length > 0 ? shown : all;
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Focus on a control that has since been disabled (a rating button
      // while its request is out) is on none of the stops, so the browser
      // would carry Tab past the end of the dialog. Move on from its place.
      if (active && !items.includes(active)) {
        e.preventDefault();
        const follows = (el: HTMLElement) => !!(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const next = e.shiftKey
          ? [...items].reverse().find((el) => !follows(el)) ?? lastItem
          : items.find(follows) ?? firstItem;
        next.focus();
        return;
      }
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      layer.release();
      unlockScroll();
      if (opener && opener !== document.body && document.contains(opener)) opener.focus?.();
    };
  }, [open, panelRef, initialFocusRef]);
}

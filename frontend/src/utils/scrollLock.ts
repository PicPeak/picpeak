/**
 * One shared, reference-counted lock on body scrolling for every overlay
 * (lightbox, gallery dialogs, admin modals, the phone sidebar).
 *
 * Each overlay used to snapshot `document.body.style.overflow` and restore
 * it on close. Stacked overlays then restored each other's 'hidden': a dialog
 * opened over the lightbox saved 'hidden', and if the lightbox closed first
 * the dialog put 'hidden' back and the page could no longer scroll. Here only
 * the first lock remembers the original value, and only the last release puts
 * it back, whatever order the overlays close in.
 */
let count = 0;
let original = '';

export function lockBodyScroll(): () => void {
  if (count === 0) {
    original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count -= 1;
    if (count === 0) document.body.style.overflow = original;
  };
}

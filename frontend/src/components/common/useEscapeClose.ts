import { useEffect, useRef } from 'react';
import { pushDialogLayer } from './Modal';

/**
 * Escape closes an overlay that is not a `Modal` — a drawer, a menu, a
 * hand-built dialog — without saving (UX.md › Popups and dialogs). It joins
 * the same stack as `Modal` and `useConfirm`, so only the top overlay
 * answers. Pass `enabled: false` while a request runs: closing waits for it.
 */
export function useEscapeClose(open: boolean, onClose: () => void, { enabled = true }: { enabled?: boolean } = {}): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!open) return undefined;
    const layer = pushDialogLayer();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !layer.isTop()) return;
      e.stopPropagation();
      if (enabledRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      layer.release();
    };
  }, [open]);
}

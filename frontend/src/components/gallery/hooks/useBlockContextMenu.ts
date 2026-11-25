import { useEffect } from 'react';

/**
 * Blocks the browser's context menu on the whole document while `enabled`
 * (the event's "Block right-click menu" setting). Document-wide, so it also
 * covers the lightbox and a zoomed original that takes no pointer events.
 */
export function useBlockContextMenu(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [enabled]);
}

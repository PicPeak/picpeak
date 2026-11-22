import { useCallback, useEffect, useState } from 'react';
import type { WalkthroughScope } from './walkthroughSteps';
import { hasSeenWalkthrough, markWalkthroughSeen } from './walkthroughStorage';

interface Options {
  slug: string;
  scope: WalkthroughScope;
  /** The gallery switched the walkthrough on, and this is no admin preview. */
  enabled: boolean;
  /** The gallery and its feature settings have loaded, so the steps are final. */
  ready: boolean;
}

export interface GalleryWalkthroughState {
  open: boolean;
  /** The help icon: reopens the tour from its first step. */
  reopen: () => void;
  close: () => void;
}

/**
 * Opens the walkthrough once on a visitor's first visit (issue 2551) and
 * records that it was shown, so it does not come back on the next visit.
 * It counts as seen as soon as it opens: a visitor who reloads in the middle
 * of it has seen enough to find the help icon.
 */
export function useGalleryWalkthrough({ slug, scope, enabled, ready }: Options): GalleryWalkthroughState {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !ready) return;
    if (hasSeenWalkthrough(slug, scope)) return;
    markWalkthroughSeen(slug, scope);
    setOpen(true);
  }, [enabled, ready, slug, scope]);

  // Switched off while open (a refetch after the admin's change).
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const reopen = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  return { open: open && enabled, reopen, close };
}

/** The gallery tab an admin opened from the dashboard (#868). */
export function isAdminPreviewUrl(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('admin_preview') === '1';
}

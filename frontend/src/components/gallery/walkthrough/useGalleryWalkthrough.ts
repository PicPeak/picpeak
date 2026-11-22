import { useCallback, useEffect, useState } from 'react';
import type { WalkthroughScope } from './walkthroughSteps';
import { hasSeenWalkthrough, markWalkthroughSeen } from './walkthroughStorage';

interface Options {
  slug: string;
  scope: WalkthroughScope;
  /** The gallery switched the walkthrough on, and this is no admin preview. */
  enabled: boolean;
  /**
   * The steps are final and the gallery is on screen with nothing else
   * modal over it. Auto-opening waits for this.
   */
  ready: boolean;
}

export interface GalleryWalkthroughState {
  open: boolean;
  /** The help icon: reopens the tour from its first step. */
  reopen: () => void;
  close: () => void;
  /** Called by the dialog once it is actually on screen: records it as seen. */
  markShown: () => void;
}

/**
 * Opens the walkthrough once on a visitor's first visit (issue 2551). It
 * counts as seen when the dialog is actually on screen (markShown), not when
 * it is asked to open: a page that never renders it (the hidden-until-reveal
 * notice) must not use up the first visit. A visitor who reloads in the
 * middle of it has seen enough to find the help icon.
 */
export function useGalleryWalkthrough({ slug, scope, enabled, ready }: Options): GalleryWalkthroughState {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !ready) return;
    if (hasSeenWalkthrough(slug, scope)) return;
    setOpen(true);
  }, [enabled, ready, slug, scope]);

  // Switched off while open (a refetch after the admin's change).
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const reopen = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const markShown = useCallback(() => markWalkthroughSeen(slug, scope), [slug, scope]);
  return { open: open && enabled, reopen, close, markShown };
}

/** The gallery tab an admin opened from the dashboard (#868). */
export function isAdminPreviewUrl(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('admin_preview') === '1';
}

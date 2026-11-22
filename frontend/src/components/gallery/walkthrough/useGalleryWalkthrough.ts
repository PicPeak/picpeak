import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WalkthroughScope } from './walkthroughSteps';
import { hasSeenWalkthrough, markWalkthroughSeen } from './walkthroughStorage';

interface Options {
  slug: string;
  scope: WalkthroughScope;
  /** The gallery switched the walkthrough on, and this is no admin preview. */
  enabled: boolean;
}

export interface GalleryWalkthroughState {
  open: boolean;
  /** The help icon: reopens the tour from its first step. */
  reopen: () => void;
  close: () => void;
  /**
   * The first-visit opening: opens unless this visitor has seen the tour.
   * GalleryWalkthroughHost calls it once the gallery is ready and nothing
   * else modal is up.
   */
  autoOpen: () => void;
  /** autoOpen would open it now: on, closed, and not seen on this device. */
  autoOpenPending: boolean;
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
export function useGalleryWalkthrough({ slug, scope, enabled }: Options): GalleryWalkthroughState {
  const [open, setOpen] = useState(false);
  // Bumped when the tour is recorded as seen, so autoOpenPending follows.
  const [seenVersion, setSeenVersion] = useState(0);

  const autoOpen = useCallback(() => {
    if (enabled && !hasSeenWalkthrough(slug, scope)) setOpen(true);
  }, [enabled, slug, scope]);

  // Switched off while open (a refetch after the admin's change).
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const reopen = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const markShown = useCallback(() => {
    markWalkthroughSeen(slug, scope);
    setSeenVersion((v) => v + 1);
  }, [slug, scope]);
  const autoOpenPending = useMemo(
    () => enabled && !open && !hasSeenWalkthrough(slug, scope),
    // seenVersion: re-read storage once the tour has been shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, open, slug, scope, seenVersion],
  );
  return { open: open && enabled, reopen, close, autoOpen, autoOpenPending, markShown };
}

/** The gallery tab an admin opened from the dashboard (#868). */
export function isAdminPreviewUrl(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('admin_preview') === '1';
}

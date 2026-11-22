import React, { useEffect, useState } from 'react';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';
import { GalleryWalkthrough } from './GalleryWalkthrough';
import type { GalleryWalkthroughState } from './useGalleryWalkthrough';
import type { WalkthroughStep } from './walkthroughSteps';

interface GalleryWalkthroughHostProps {
  walkthrough: GalleryWalkthroughState;
  /**
   * The steps are final and the gallery is on screen with none of the
   * gallery's own dialogs open (GalleryView decides).
   */
  ready: boolean;
  /**
   * The page was opened with an `?album=` link for a client or portal
   * customer, which opens the album configurator once its offers load.
   */
  albumLinkPending?: boolean;
  steps: WalkthroughStep[];
  anchored: boolean;
}

/** How long an `?album=` link may take to open its dialog before the tour stops waiting. */
export const ALBUM_LINK_GRACE_MS = 4000;

const MODAL_SELECTOR = '[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]';

/**
 * Another dialog is on the page (not the walkthrough's own): any modal
 * component, whoever rendered it. Closes the class of "a dialog opened on
 * its own and the tour opened over it" (download picker, recovery, album
 * configurator, ...) rather than listing each one.
 */
export function otherDialogOpen(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).some((el) => {
    if (el.closest('[data-walkthrough-root]')) return false;
    if (el.closest('[hidden], [inert]')) return false;
    if (el instanceof HTMLDialogElement && !el.open) return false;
    return window.getComputedStyle(el).display !== 'none';
  });
}

const hasAlbumParam = () => new URLSearchParams(window.location.search).has('album');

/**
 * Renders the walkthrough inside the guest identity provider (issue 2551)
 * and decides when the first-visit opening may happen. It waits while:
 *
 *  - GalleryView says the gallery is not ready (`ready`)
 *  - the identity provider's name prompt or recovery is open, or an invite
 *    is still being redeemed (its outcome may open recovery)
 *  - any other dialog is in the page (re-checked by a MutationObserver on
 *    the body, disconnected once the tour opened)
 *  - an `?album=` link has not opened its configurator yet (up to
 *    ALBUM_LINK_GRACE_MS, so a link to an unknown album does not block it)
 *
 * Opening the tour behind or over one of those would split the keyboard
 * between two dialogs. Reopening from the help icon is the visitor's own
 * choice and is never deferred.
 */
export const GalleryWalkthroughHost: React.FC<GalleryWalkthroughHostProps> = ({
  walkthrough, ready, albumLinkPending = false, steps, anchored,
}) => {
  const identity = useGuestIdentityOptional();
  const identityBusy = !!identity && (identity.promptOpen || identity.recoveryOpen || identity.invitePending);
  const { autoOpen, autoOpenPending } = walkthrough;
  const [albumGraceOver, setAlbumGraceOver] = useState(false);

  useEffect(() => {
    if (!albumLinkPending) return;
    const timer = window.setTimeout(() => setAlbumGraceOver(true), ALBUM_LINK_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [albumLinkPending]);

  useEffect(() => {
    if (!autoOpenPending || !ready || identityBusy) return;
    const attempt = () => {
      if (otherDialogOpen()) return false;
      if (albumLinkPending && !albumGraceOver && hasAlbumParam()) return false;
      autoOpen();
      return true;
    };
    if (attempt()) return;
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (attempt()) observer.disconnect();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'open', 'role', 'hidden'],
    });
    return () => observer.disconnect();
  }, [autoOpenPending, ready, identityBusy, albumLinkPending, albumGraceOver, autoOpen]);

  return (
    <GalleryWalkthrough
      open={walkthrough.open}
      steps={steps}
      anchored={anchored}
      onClose={walkthrough.close}
      onShown={walkthrough.markShown}
    />
  );
};

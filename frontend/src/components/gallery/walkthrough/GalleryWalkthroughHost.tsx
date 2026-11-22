import React, { useEffect } from 'react';
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
  steps: WalkthroughStep[];
  anchored: boolean;
}

/**
 * Renders the walkthrough inside the guest identity provider (issue 2551),
 * so the first-visit opening can also wait for that provider's dialogs: the
 * name prompt, recovery (opened on its own for a spent invite) and an
 * invite still being redeemed, whose outcome may open recovery. Opening the
 * tour behind one of them would take the keyboard from it.
 */
export const GalleryWalkthroughHost: React.FC<GalleryWalkthroughHostProps> = ({ walkthrough, ready, steps, anchored }) => {
  const identity = useGuestIdentityOptional();
  const identityBusy = !!identity && (identity.promptOpen || identity.recoveryOpen || identity.invitePending);
  const { autoOpen } = walkthrough;

  useEffect(() => {
    if (ready && !identityBusy) autoOpen();
  }, [ready, identityBusy, autoOpen]);

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

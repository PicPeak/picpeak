import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DownloadResolutionChoice, Photo } from '../../types';
import { DownloadChoiceContext, type DownloadChoiceValue, type StartPhotoDownload } from '../../contexts/DownloadChoiceContext';
import { isVideoItem } from '../../utils/mediaCounts';
import { isCameraRawPhoto } from '../../utils/downloadChoice';
import { DownloadResolutionModal } from './DownloadResolutionModal';

interface PhotoDownloadChoiceProviderProps {
  slug: string;
  /** The picker's choices; empty when the gallery has no picker. */
  choices: DownloadResolutionChoice[];
  watermarked: boolean;
  children: React.ReactNode;
}

/**
 * Download menu for one photo (issue 1733, E2). Every single-photo download
 * button — tile, lightbox, Premium lightbox — goes through `choose`, so a
 * gallery that lets guests pick a size asks here, once, in the same dialog
 * "download all" and a selection use. With nothing to choose (no picker, a
 * single size, or a video, which always ships as uploaded) it downloads
 * straight away, as before.
 */
export const PhotoDownloadChoiceProvider: React.FC<PhotoDownloadChoiceProviderProps> = ({
  slug,
  choices,
  watermarked,
  children,
}) => {
  const [pending, setPending] = useState<{ photo: Photo; start: StartPhotoDownload } | null>(null);
  const hasChoice = choices.length > 1;

  const choose = useCallback((photo: Photo, start: StartPhotoDownload) => {
    if (!hasChoice || isVideoItem(photo) || isCameraRawPhoto(photo)) {
      start();
      return;
    }
    setPending({ photo, start });
  }, [hasChoice]);

  const value = useMemo<DownloadChoiceValue>(() => ({ watermarked, choose }), [watermarked, choose]);

  return (
    <DownloadChoiceContext.Provider value={value}>
      {children}
      {/* On body: the Premium lightbox (YARL) makes every other child of
          body inert while open, the app root included. */}
      {pending && createPortal(
        <DownloadResolutionModal
          slug={slug}
          choices={choices}
          photo={pending.photo}
          quotaPhotos={[pending.photo]}
          onPick={(resolution) => pending.start(resolution)}
          onClose={() => setPending(null)}
        />,
        document.body,
      )}
    </DownloadChoiceContext.Provider>
  );
};

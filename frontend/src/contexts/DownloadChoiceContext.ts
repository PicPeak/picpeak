import { createContext, useContext } from 'react';
import type { Photo } from '../types';

// Download menu (issue 1733, E2). Provided by GalleryView
// (PhotoDownloadChoiceProvider); anything rendered outside a gallery, or in a
// gallery without a size picker, reads the default and downloads at once.

/** Starts the download; `resolution` omitted = the gallery's standard size. */
export type StartPhotoDownload = (resolution?: string) => void;

export interface DownloadChoiceValue {
  /** Downloads carry a watermark, so every size the menu offers does too. */
  watermarked: boolean;
  /**
   * A single photo's download button: asks the guest which size first when
   * the gallery offers a choice, else calls `start` straight away.
   */
  choose: (photo: Photo, start: StartPhotoDownload) => void;
}

export const DownloadChoiceContext = createContext<DownloadChoiceValue>({
  watermarked: false,
  choose: (_photo, start) => start(),
});

export const useDownloadChoice = (): DownloadChoiceValue => useContext(DownloadChoiceContext);

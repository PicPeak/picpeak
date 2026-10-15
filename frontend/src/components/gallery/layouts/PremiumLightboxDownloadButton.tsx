import React from 'react';
import { IconButton, useLightboxState, type Slide } from 'yet-another-react-lightbox';
import { Loader2 } from 'lucide-react';
import { usePhotoDownloadPending, preparingDownloadMessage } from '../../../hooks/usePhotoDownloadPending';

// The download plugin's own glyph, so the button looks as before until busy.
const DownloadGlyph = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" {...props}>
    <g fill="currentColor">
      <path d="M0 0h24v24H0z" fill="none" />
      <path d="M18 15v3H6v-3H4v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3h-2zm-1-4-1.41-1.41L13 12.17V4h-2v8.17L8.41 9.59 7 11l5 5 5-5z" />
    </g>
  </svg>
);

/**
 * The Premium lightbox's download button (render.buttonDownload). Issue 2043:
 * it spins while the slide's photo is being prepared; the handler ignores
 * a repeated tap meanwhile.
 */
export const PremiumLightboxDownloadButton: React.FC<{ onDownload: (slide: Slide) => void }> = ({ onDownload }) => {
  const { currentSlide } = useLightboxState();
  const pending = usePhotoDownloadPending((currentSlide as { photoId?: number } | undefined)?.photoId);
  return (
    <IconButton
      label="Download"
      icon={DownloadGlyph}
      renderIcon={pending ? () => <Loader2 className="yarl__icon animate-spin" aria-hidden="true" /> : undefined}
      disabled={!currentSlide}
      onClick={() => {
        if (currentSlide) onDownload(currentSlide);
      }}
      {...(pending ? {
        'aria-busy': true,
        'aria-disabled': true,
        'aria-label': preparingDownloadMessage(),
        title: preparingDownloadMessage(),
      } : {})}
    />
  );
};

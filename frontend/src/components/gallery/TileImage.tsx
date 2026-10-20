import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon } from 'lucide-react';
import { AuthenticatedImage } from '../common';
import { thumbHashToDataUrl } from '../../utils/thumbHash';

type TileImageProps = React.ComponentProps<typeof AuthenticatedImage> & {
  /** `photo.thumb_hash`; without one this is a plain AuthenticatedImage. */
  thumbHash?: string | null;
  /** Fade-out duration (and easing) classes, for a card that fades its image in itself. */
  placeholderFadeClassName?: string;
  /** Icon only on the unavailable tile, for tiles too small for the caption. */
  compactUnavailable?: boolean;
};

/**
 * Two, not AuthenticatedImage's default three (issue 1733, E9). With its
 * 2 s / 4 s backoff a tile settles within about six seconds of the first
 * failure; the lightbox keeps the longer budget for the photo in view.
 */
const TILE_MAX_RETRIES = 2;

/**
 * A tile image with a blurred placeholder over it until it has loaded
 * (issue 1733, B1).
 *
 * The placeholder is decoded from the ThumbHash in the photo list, so it is
 * there on the first frame, before any request. It is absolutely positioned
 * over the tile's box (the parent must be positioned, which every tile is),
 * so it takes no space and nothing moves when the image arrives. It sits on
 * top because AuthenticatedImage paints an opaque loading box, and fades out
 * once the image reports its load; with reduced motion it simply goes.
 *
 * Decoding happens here, on mount, so a tile that is not mounted (lazy mount
 * and the release band in PhotoCard) costs nothing. The decode itself is
 * memoised per hash in utils/thumbHash.
 *
 * A div with a background, not an <img>: several layouts style every `img`
 * inside a card (hover zoom, object-fit), and this must not pick that up.
 *
 * A thumbnail that will not load gets two retries and then a neutral
 * "image unavailable" tile in the same box (issue 1733, E9), over the
 * placeholder's position: never the browser's broken-image icon.
 */
export const TileImage: React.FC<TileImageProps> = ({
  thumbHash,
  placeholderFadeClassName = 'duration-300',
  compactUnavailable = false,
  onLoad,
  ...imageProps
}) => {
  const { t } = useTranslation();
  const { src, className } = imageProps;
  // Given up on (issue 1733, E9). AuthenticatedImage leaves its empty box in
  // place, which keeps the tile's size; this covers it with a calm "image
  // unavailable" tile instead of a grey square or, with a ThumbHash, a blur
  // that would read as still loading forever.
  const [unavailable, setUnavailable] = useState(false);
  // Keyed by src: when the source changes the image goes back to loading,
  // and the placeholder with it.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const srcRef = useRef(src);
  srcRef.current = src;
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  // Stable on purpose: AuthenticatedImage redraws its canvas when onLoad
  // changes identity.
  const handleLoad = useCallback((dimensions: { width: number; height: number }) => {
    setLoadedSrc(srcRef.current);
    onLoadRef.current?.(dimensions);
  }, []);

  const placeholder = useMemo(() => thumbHashToDataUrl(thumbHash), [thumbHash]);
  // The image's own corner rounding, where the tile does not clip.
  const rounding = className?.match(/(?:^|\s)(rounded(?:-[\w[\].]+)*)/)?.[1] ?? '';
  // The layouts' "hidden from guests" dimming, which the opaque unavailable
  // tile would otherwise cover. Only that class: other opacity on the image
  // (a fade-in from opacity-0) is not the tile's.
  const dimming = className?.match(/(?:^|\s)(!?opacity-40)(?=\s|$)/)?.[1] ?? '';

  return (
    <>
      <AuthenticatedImage
        maxRetries={TILE_MAX_RETRIES}
        {...imageProps}
        onLoad={handleLoad}
        onUnavailable={setUnavailable}
      />
      {unavailable ? (
        <div
          // A decorative image (alt="") stays decorative when it is missing.
          {...(imageProps.alt === ''
            ? { 'aria-hidden': true }
            : { role: 'img', 'aria-label': t('gallery.imageUnavailable', 'Image unavailable') })}
          data-testid="tile-unavailable"
          className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2 bg-elevated text-muted-theme pointer-events-none ${rounding} ${dimming}`}
        >
          <ImageIcon className="w-6 h-6 opacity-60" strokeWidth={1.5} aria-hidden="true" />
          {!compactUnavailable && (
            <span className="text-xs text-center leading-tight" aria-hidden="true">
              {t('gallery.imageUnavailable', 'Image unavailable')}
            </span>
          )}
        </div>
      ) : placeholder && (
        <div
          aria-hidden="true"
          data-testid="tile-placeholder"
          className={`absolute inset-0 overflow-hidden pointer-events-none transition-opacity motion-reduce:transition-none ${placeholderFadeClassName} ${rounding} ${loadedSrc === src ? 'opacity-0' : 'opacity-100'}`}
        >
          {/* Drawn a little larger than the tile and clipped by it. Scaling
              a 32px image up to a tile leaves its outermost pixels blended
              with nothing, which showed as a dark hairline around every
              placeholder; this keeps that rim outside the box. */}
          <div
            className="absolute -inset-[4%] bg-cover bg-center"
            style={{ backgroundImage: `url(${placeholder})` }}
          />
        </div>
      )}
    </>
  );
};

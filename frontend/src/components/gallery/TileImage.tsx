import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AuthenticatedImage } from '../common';
import { thumbHashToDataUrl } from '../../utils/thumbHash';

type TileImageProps = React.ComponentProps<typeof AuthenticatedImage> & {
  /** `photo.thumb_hash`; without one this is a plain AuthenticatedImage. */
  thumbHash?: string | null;
  /** Fade-out duration (and easing) classes, for a card that fades its image in itself. */
  placeholderFadeClassName?: string;
};

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
 */
export const TileImage: React.FC<TileImageProps> = ({
  thumbHash,
  placeholderFadeClassName = 'duration-300',
  onLoad,
  ...imageProps
}) => {
  const { src, className } = imageProps;
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

  return (
    <>
      <AuthenticatedImage {...imageProps} onLoad={handleLoad} />
      {placeholder && (
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

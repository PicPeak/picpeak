import { useCallback } from 'react';
import type { RenderSlideProps, SlideImage } from 'yet-another-react-lightbox';
import { isImageSlide } from 'yet-another-react-lightbox';
import { AuthenticatedImage } from '../../common/AuthenticatedImage';

interface PremiumLightboxImageProps extends RenderSlideProps {
  slug: string;
  useCanvasRendering: boolean;
  protectionLevel: 'basic' | 'standard' | 'enhanced' | 'maximum';
  onImageLoad: (src: string, dimensions: { width: number; height: number }) => void;
}

/** Return undefined for YARL's ordinary image renderer, including all neighbours.
 * Keeping the slide's image type lets its Zoom plugin own gestures and transforms. */
export function renderPremiumLightboxImage({
  slide, offset, slug, useCanvasRendering, protectionLevel, onImageLoad,
}: PremiumLightboxImageProps) {
  if (!isImageSlide(slide) || offset !== 0 || !(useCanvasRendering || protectionLevel === 'maximum')) {
    return undefined;
  }

  return <PremiumLightboxImage key={slide.src} slide={slide} slug={slug} onImageLoad={onImageLoad} />;
}

function PremiumLightboxImage({ slide, slug, onImageLoad }: {
  slide: SlideImage;
  slug: string;
  onImageLoad: PremiumLightboxImageProps['onImageLoad'];
}) {
  // Stable across zoom/parent renders: AuthenticatedImage's decode effect
  // depends on this callback, so an inline function would decode again.
  const handleLoad = useCallback((dimensions: { width: number; height: number }) => {
    onImageLoad(slide.src, dimensions);
  }, [slide.src, onImageLoad]);

  return (
    <AuthenticatedImage
      src={slide.src}
      fallbackSrc={slide.thumbnail}
      alt={slide.alt || ''}
      slug={slug}
      isGallery
      queuePriority="high"
      useCanvasRendering
      className="yarl__slide_image"
      onLoad={handleLoad}
      draggable={false}
    />
  );
}

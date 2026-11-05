import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../config/api';
/**
 * Scoped API images: no remote supplier URLs or browser-visible credentials.
 * Tiles ask for the small rendition, a detail view for the large one. A tile
 * is a 3:2 box, the camera's own ratio, so a landscape product shot fills it
 * with neither bars nor crop, and the box is there before the image is. The
 * one big view is `natural` and keeps whatever ratio the studio uploaded; a
 * colour swatch is `square`, to fill its circle.
 */
export function ProductImage({
  imageId,
  alt,
  slug,
  imageLoader,
  size = 480,
  shape = 'tile',
}: {
  imageId: string | null;
  alt: string;
  slug?: string;
  imageLoader?: (id: string) => Promise<Blob>;
  size?: 480 | 1200;
  shape?: 'tile' | 'natural' | 'square';
}) {
  const { t } = useTranslation();
  const background = slug
    ? 'bg-surface text-text-secondary'
    : 'bg-inset text-muted';
  const box = shape === 'square' ? 'aspect-square' : 'aspect-[3/2]';
  const [src, setSrc] = useState(''),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true,
      url = '';
    setSrc('');
    setFailed(false);
    if (!imageId) return;
    const path = slug
      ? `/gallery/${slug}/album-products/images/${imageId}`
      : `/admin/album-products/images/${imageId}`;
    (imageLoader
      ? imageLoader(imageId).then((data) => ({ data }))
      : api.get<Blob>(path, { params: { size }, responseType: 'blob' })
    )
      .then((r) => {
        url = URL.createObjectURL(r.data);
        if (active) setSrc(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageId, slug, imageLoader, size]);
  return src && !failed ? (
    <img
      className={`w-full rounded-lg ${shape === 'natural' ? 'h-auto' : `${box} object-cover`} ${background}`}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className={`flex ${box} items-center justify-center rounded-lg text-sm ${background}`}
    >
      {failed
        ? t('albumProducts.imageUnavailable', 'Image unavailable')
        : imageId
          ? null
          : t('albumProducts.noImage', 'No image')}
    </span>
  );
}

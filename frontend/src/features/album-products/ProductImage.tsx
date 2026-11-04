import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../config/api';
/**
 * Scoped API images: no remote supplier URLs or browser-visible credentials.
 * Tiles ask for the small rendition, a detail view for the large one; the
 * picture fills its square, and the square is there before the image is.
 */
export function ProductImage({
  imageId,
  alt,
  slug,
  imageLoader,
  size = 480,
}: {
  imageId: string | null;
  alt: string;
  slug?: string;
  imageLoader?: (id: string) => Promise<Blob>;
  size?: 480 | 1200;
}) {
  const { t } = useTranslation();
  const background = slug
    ? 'bg-surface text-text-secondary'
    : 'bg-inset text-muted';
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
      className={`w-full aspect-square object-cover rounded-lg ${background}`}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className={`flex aspect-square items-center justify-center rounded-lg text-sm ${background}`}
    >
      {failed
        ? t('albumProducts.imageUnavailable', 'Image unavailable')
        : imageId
          ? null
          : t('albumProducts.noImage', 'No image')}
    </span>
  );
}

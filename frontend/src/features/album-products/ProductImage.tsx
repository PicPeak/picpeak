import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../config/api';
/** Scoped API images: no remote supplier URLs or browser-visible credentials. */
export function ProductImage({
  imageId,
  alt,
  slug,
  imageLoader,
}: {
  imageId: string | null;
  alt: string;
  slug?: string;
  imageLoader?: (id: string) => Promise<Blob>;
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
      : api.get<Blob>(path, { responseType: 'blob' })
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
  }, [imageId, slug, imageLoader]);
  return src && !failed ? (
    <img
      className={`w-full aspect-square object-contain rounded ${background}`}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className={`flex aspect-square items-center justify-center rounded text-sm ${background}`}
    >
      {failed
        ? t('albumProducts.imageUnavailable', 'Image unavailable')
        : t('albumProducts.noImage', 'No image')}
    </span>
  );
}

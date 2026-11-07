import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SwatchDot } from './ColourSwatches';
import type { ChosenPhoto, Choice, PhotoRoleKey } from './model';

export function usePhotoRoleLabel() {
  const { t } = useTranslation();
  return (key: PhotoRoleKey) =>
    key === 'cover'
      ? t('albumProducts.coverPhoto', 'Cover photo')
      : t('albumProducts.posterPhotos', 'Poster photos');
}

/**
 * One album choice in one place: the album, every configured attribute and
 * every photo role. The caller draws a photo, and with `renderImage` the
 * album's and each option's product image, because the gallery and the admin
 * reach them through different authenticated routes.
 */
export function AlbumChoiceDetails({
  choice,
  renderPhoto,
  productImageId,
  renderImage,
}: {
  choice: Choice;
  renderPhoto: (photo: ChosenPhoto) => ReactNode;
  productImageId?: string | null;
  renderImage?: (imageId: string, alt: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const label = usePhotoRoleLabel();
  const row = 'grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]';
  // Small pictures to the right of the text; a row without one is unchanged.
  // Several chosen options wrap within half the row instead of overflowing.
  const images = (list: { id: string; name: string }[]) =>
    renderImage && list.length > 0 ? (
      <span className="flex max-w-[50%] flex-wrap justify-end gap-2">
        {list.map((image) => (
          <span key={image.id} className="block w-24 sm:w-32">
            {renderImage(image.id, image.name)}
          </span>
        ))}
      </span>
    ) : null;
  return (
    <dl className="space-y-3">
      <div className={row}>
        <dt className="font-semibold">{t('albumProducts.album', 'Album')}</dt>
        <dd className="flex items-start justify-between gap-3">
          <span className="min-w-0">{choice.product.name}</span>
          {images(productImageId ? [{ id: productImageId, name: choice.product.name }] : [])}
        </dd>
      </div>
      {choice.attributes?.map((a) => (
        <div key={a.id} className={row}>
          <dt className="font-semibold">{a.name}</dt>
          <dd className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              {a.options.map((o) => (
                <span key={o.id} className="inline-flex items-center gap-1.5">
                  <SwatchDot hex={o.hex} />
                  {o.name}
                </span>
              ))}
            </span>
            {images(a.options.flatMap((o) => (o.imageId ? [{ id: o.imageId, name: o.name }] : [])))}
          </dd>
        </div>
      ))}
      {choice.photoRoles
        ?.filter((role) => role.photos.length > 0)
        .map((role) => (
          <div key={role.key} className={row}>
            <dt className="font-semibold">{label(role.key)}</dt>
            <dd className="flex flex-wrap gap-3">
              {role.photos.map((photo) => (
                <div key={photo.id} className="w-32 min-w-0 sm:w-40">
                  {renderPhoto(photo)}
                </div>
              ))}
            </dd>
          </div>
        ))}
    </dl>
  );
}

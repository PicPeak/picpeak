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
 * every photo role. The caller draws a photo, because the gallery and the
 * admin reach it through different authenticated routes.
 */
export function AlbumChoiceDetails({
  choice,
  renderPhoto,
}: {
  choice: Choice;
  renderPhoto: (photo: ChosenPhoto) => ReactNode;
}) {
  const { t } = useTranslation();
  const label = usePhotoRoleLabel();
  const row = 'grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]';
  return (
    <dl className="space-y-3">
      <div className={row}>
        <dt className="font-semibold">{t('albumProducts.album', 'Album')}</dt>
        <dd>{choice.product.name}</dd>
      </div>
      {choice.attributes?.map((a) => (
        <div key={a.id} className={row}>
          <dt className="font-semibold">{a.name}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {a.options.map((o) => (
              <span key={o.id} className="inline-flex items-center gap-1.5">
                <SwatchDot hex={o.hex} />
                {o.name}
              </span>
            ))}
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
                <div key={photo.id} className="w-28 min-w-0">
                  {renderPhoto(photo)}
                </div>
              ))}
            </dd>
          </div>
        ))}
    </dl>
  );
}

import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AuthenticatedImage, Button, Loading } from '../../components/common';
import type { Photo } from '../../types';

const PAGE = 48;

/** A gallery thumbnail through the gallery's own authenticated route. */
export function GalleryPhoto({
  id,
  slug,
  photo,
  alt,
}: {
  id: number;
  slug: string;
  photo?: Photo;
  alt: string;
}) {
  return (
    <AuthenticatedImage
      src={photo?.thumbnail_url || `/api/gallery/${slug}/thumbnail/${id}`}
      alt={alt}
      isGallery
      slug={slug}
      className="h-full w-full object-cover"
      loading="lazy"
    />
  );
}

/**
 * Picks the photos of one role from what the client can see in this gallery.
 * Replacing needs no extra step: a one-photo role swaps on the next click, and
 * a selected photo can always be removed.
 */
export function PhotoRolePicker({
  slug,
  photos,
  loading,
  chosen,
  unavailable,
  min,
  max,
  onChange,
  disabled = false,
}: {
  slug: string;
  photos: Photo[];
  loading: boolean;
  chosen: number[];
  unavailable: number[];
  min: number;
  max: number;
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(PAGE);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const label = (id: number) =>
    t('albumProducts.photoNumber', 'Photo {{number}}', {
      number: photos.findIndex((p) => p.id === id) + 1,
    });
  const toggle = (id: number) => {
    if (chosen.includes(id)) onChange(chosen.filter((other) => other !== id));
    else if (max === 1) onChange([id]);
    else if (chosen.length < max) onChange([...chosen, id]);
  };
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        {max === 1
          ? t('albumProducts.photoCountOne', '{{count}} of 1 selected', { count: chosen.length })
          : min === max
            ? t('albumProducts.photoCountExact', '{{count}} of {{max}} selected', { count: chosen.length, max })
            : t('albumProducts.photoCountRange', '{{count}} selected, choose {{min}} to {{max}}', { count: chosen.length, min, max })}
      </p>
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {chosen.map((id) => (
            <li key={id} className="w-28">
              <span className="relative block aspect-square overflow-hidden rounded-lg border border-border-token bg-surface">
                <GalleryPhoto id={id} slug={slug} photo={byId.get(id)} alt={label(id)} />
              </span>
              {unavailable.includes(id) && (
                <span className="mt-1 block text-xs">
                  {t('albumProducts.photoUnavailable', 'No longer available, please replace it')}
                </span>
              )}
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 text-sm underline"
                disabled={disabled}
                onClick={() => toggle(id)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                {t('albumProducts.removePhoto', 'Remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading ? (
        <Loading />
      ) : photos.length === 0 ? (
        <p>{t('albumProducts.noPhotos', 'There are no photos to choose from yet.')}</p>
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {photos.slice(0, shown).map((photo) => {
              const selected = chosen.includes(photo.id);
              const full = !selected && max > 1 && chosen.length >= max;
              return (
                <li key={photo.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={label(photo.id)}
                    disabled={disabled || full}
                    onClick={() => toggle(photo.id)}
                    className={`relative block aspect-square w-full overflow-hidden rounded-lg bg-surface focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-2 disabled:opacity-50 ${selected ? 'outline outline-2 outline-offset-2 outline-accent' : ''}`}
                  >
                    <GalleryPhoto id={photo.id} slug={slug} photo={photo} alt="" />
                    {selected && (
                      <span className="tile-selected absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full">
                        <Check className="h-4 w-4" aria-hidden="true" />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {shown < photos.length && (
            <Button variant="secondary" onClick={() => setShown(shown + PAGE)}>
              {t('albumProducts.showMorePhotos', 'Show more photos')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

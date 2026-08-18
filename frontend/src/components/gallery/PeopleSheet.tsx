import React, { useMemo, useState } from 'react';
import { Search, X, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AuthenticatedImage } from '../common/AuthenticatedImage';
import type { GalleryPerson, Photo } from '../../types';
import { faceCropStyle } from './faceCrop';

/**
 * "Show all" people (#1074).
 *
 * A bottom sheet on mobile, a centred panel on desktop. The footnote is not
 * decoration — "where does this data go?" is the first question every guest
 * has, and answering it inline is cheaper than losing their trust.
 */

interface PeopleSheetProps {
  open: boolean;
  onClose: () => void;
  people: GalleryPerson[];
  photos: Photo[];
  slug: string;
  selectedPersonIds: number[];
  onToggle: (personId: number) => void;
}

export const PeopleSheet: React.FC<PeopleSheetProps> = ({
  open, onClose, people, photos, slug, selectedPersonIds, onToggle,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const photoById = useMemo(() => {
    const map = new Map<number, Photo>();
    for (const photo of photos) map.set(photo.id, photo);
    return map;
  }, [photos]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    // Only named people are searchable — there is nothing to match an
    // unnamed cluster against, and pretending otherwise (matching the count,
    // say) would be a puzzle rather than a feature.
    return people.filter((p) => p.label?.toLowerCase().includes(q));
  }, [people, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('gallery.people.title', { defaultValue: 'People in this gallery' })}
        className="relative w-full sm:max-w-2xl bg-white rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-neutral-100">
          <h2 className="text-base font-medium text-neutral-900">
            {t('gallery.people.title', { defaultValue: 'People in this gallery' })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            className="p-2 -m-2 text-neutral-400 hover:text-neutral-600"
          >
            <X size={20} />
          </button>
        </div>

        {people.some((p) => p.label) && (
          <div className="px-4 pt-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('gallery.people.searchPlaceholder', { defaultValue: 'Find a person' })}
                className="w-full pl-9 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
            {filtered.map((person) => {
              const photo = person.cover ? photoById.get(person.cover.photo_id) : undefined;
              const selected = selectedPersonIds.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => onToggle(person.id)}
                  aria-pressed={selected}
                  className="flex flex-col items-center gap-1.5 group focus:outline-none"
                >
                  <span
                    className={[
                      'relative block w-16 h-16 rounded-full overflow-hidden bg-neutral-100 transition-all',
                      selected
                        ? 'ring-[3px] ring-offset-2 ring-primary-600'
                        : 'ring-1 ring-neutral-200 group-hover:ring-neutral-400',
                    ].join(' ')}
                  >
                    {photo && (
                      <AuthenticatedImage
                        src={photo.thumbnail_url || photo.url}
                        alt=""
                        isGallery
                        slug={slug}
                        photoId={photo.id}
                        requiresToken={photo.requires_token}
                        secureUrlTemplate={photo.secure_url_template}
                        // Crop to the face, exactly as the strip does. Without
                        // this a group photo shows whoever is centred — often
                        // not the person being labelled, and identical for two
                        // people whose cover is the same photo.
                        style={faceCropStyle(person.cover, photo.width, photo.height, 64)
                          || { width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                  </span>
                  <span className="w-full text-center leading-tight">
                    <span className={`block truncate text-xs ${person.label ? 'font-medium text-neutral-800' : 'text-neutral-500'}`}>
                      {person.label || t('gallery.people.unnamedCount', {
                        count: person.face_count,
                        defaultValue: `${person.face_count} photos`,
                      })}
                    </span>
                    {person.label && (
                      <span className="block text-[11px] text-neutral-400">{person.face_count}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <p className="text-sm text-neutral-500 text-center py-8">
              {t('gallery.people.noMatches', { defaultValue: 'No one matches that name.' })}
            </p>
          )}
        </div>

        {/* The answer to the first question every guest has. Deliberately in
            plain language — this copy never says "biometric" or
            "recognition", because those words describe our implementation,
            not the guest's experience. */}
        <div className="px-4 py-3 border-t border-neutral-100 flex gap-2 text-xs text-neutral-500">
          <Info size={14} className="flex-shrink-0 mt-0.5" />
          <p>
            {t('gallery.people.privacyNote', {
              defaultValue: 'People are detected automatically inside this gallery. Nothing is sent to any external service.',
            })}
          </p>
        </div>
      </div>
    </div>
  );
};

export default PeopleSheet;

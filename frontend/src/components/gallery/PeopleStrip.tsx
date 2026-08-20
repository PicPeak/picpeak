import React, { useMemo, useState } from 'react';
import { ChevronRight, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AuthenticatedImage } from '../common/AuthenticatedImage';
import type { GalleryPerson, Photo } from '../../types';
import { faceCropStyle } from './faceCrop';
import { facePreviewUrl } from './imageTiers';

/**
 * "People in this gallery" (#1074).
 *
 * The design goal is that a guest on a phone finds themselves in two taps and
 * never learns the words "face recognition". So: circular crops, first names
 * where the photographer supplied them, a photo count where they didn't, and
 * no vocabulary from the implementation anywhere in the UI.
 *
 * Unnamed people show ONLY a count. Never "Person 7" — a number is honest
 * about what the system knows; an invented name is not.
 */

interface PersonAvatarProps {
  person: GalleryPerson;
  photo: Photo | undefined;
  slug: string;
  size: number;
  selected: boolean;
  onClick: () => void;
}

/**
 * A face crop, produced by scaling the source photo inside a round window so
 * the stored bbox lands centred.
 *
 * The bbox is in ORIGINAL image pixels but the thumbnail is served at some
 * other size, so everything is done in RATIOS of the source dimensions —
 * which survives whatever rendition the browser actually gets. Without the
 * photo's width/height we can't compute those ratios, so the component falls
 * back to an un-cropped thumbnail rather than rendering a wrongly-offset crop.
 */
const PersonAvatar: React.FC<PersonAvatarProps> = ({
  person, photo, slug, size, selected, onClick,
}) => {
  const { t } = useTranslation();

  const cropStyle = useMemo(
    () => faceCropStyle(person.cover, photo?.width, photo?.height, size),
    [person.cover, photo?.width, photo?.height, size],
  );

  const label = person.label
    || t('gallery.people.unnamedCount', { count: person.face_count, defaultValue: `${person.face_count} photos` });

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={person.label
        ? t('gallery.people.filterBy', { name: person.label, defaultValue: `Show photos of ${person.label}` })
        : t('gallery.people.filterByUnnamed', { defaultValue: 'Show photos of this person' })}
      className="flex flex-col items-center gap-1.5 flex-shrink-0 group focus:outline-none"
      style={{ width: `${size + 8}px` }}
    >
      <span
        className={[
          'relative block rounded-full overflow-hidden bg-neutral-100 transition-all',
          selected
            ? 'ring-[3px] ring-offset-2 ring-primary-600'
            : 'ring-1 ring-neutral-200 group-hover:ring-neutral-400 group-focus-visible:ring-primary-500',
        ].join(' ')}
        style={{ width: `${size}px`, height: `${size}px` }}
      >
        {photo && person.cover ? (
          <AuthenticatedImage
            src={facePreviewUrl(slug, photo, person.cover) || photo.thumbnail_url || photo.url}
            alt=""
            isGallery
            slug={slug}
            photoId={photo.id}
            requiresToken={photo.requires_token}
            secureUrlTemplate={photo.secure_url_template}
            style={cropStyle || { width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span className="flex items-center justify-center w-full h-full text-neutral-400">
            <Users size={size / 2.5} />
          </span>
        )}
      </span>

      <span className="w-full text-center leading-tight">
        {/* Colours come from the gallery theme tokens, not fixed neutrals:
            galleries can be dark, and hardcoded `text-neutral-800` renders
            a named person's label almost invisibly against one. */}
        <span
          className="block truncate text-xs"
          style={{
            color: selected ? 'var(--color-accent)' : 'var(--color-text)',
            fontWeight: person.label ? 500 : 400,
            opacity: person.label ? 1 : 0.75,
          }}
        >
          {label}
        </span>
        {person.label && (
          <span className="block text-[11px]" style={{ color: 'var(--color-muted-text)' }}>
            {person.face_count}
          </span>
        )}
      </span>
    </button>
  );
};

interface PeopleStripProps {
  people: GalleryPerson[];
  photos: Photo[];
  slug: string;
  selectedPersonIds: number[];
  onToggle: (personId: number) => void;
  onShowAll: () => void;
  scan?: { in_progress: boolean; scanned: number; total: number };
  /** Persisted per-slug so a guest who dismisses it stays dismissed. */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Avatars shown inline; the rest live behind "Show all". */
  maxInline?: number;
}

export const PeopleStrip: React.FC<PeopleStripProps> = ({
  people, photos, slug, selectedPersonIds, onToggle, onShowAll,
  scan, collapsed, onCollapsedChange, maxInline = 12,
}) => {
  const { t } = useTranslation();
  const [avatarSize] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? 56 : 64));

  const photoById = useMemo(() => {
    const map = new Map<number, Photo>();
    for (const photo of photos) map.set(photo.id, photo);
    return map;
  }, [photos]);

  // Fewer than two people isn't a "people in this gallery" feature, it's a
  // single face taking up a row of the screen. Don't render at all.
  if (people.length < 2 && !scan?.in_progress) return null;

  if (collapsed) {
    return (
      <div className="flex items-center justify-between px-1 py-2 text-sm">
        <span style={{ color: 'var(--color-muted-text)' }}>
          {t('gallery.people.collapsedSummary', {
            count: people.length,
            defaultValue: `${people.length} people found`,
          })}
        </span>
        <button
          type="button"
          onClick={() => onCollapsedChange(false)}
          className="text-primary-600 hover:text-primary-700 font-medium"
        >
          {t('gallery.people.show', { defaultValue: 'Show' })}
        </button>
      </div>
    );
  }

  const inline = people.slice(0, maxInline);
  const hasMore = people.length > inline.length;

  return (
    <div className="py-3">
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          {t('gallery.people.title', { defaultValue: 'People in this gallery' })}
        </h3>

        <div className="flex items-center gap-3">
          {hasMore && (
            <button
              type="button"
              onClick={onShowAll}
              className="flex items-center gap-0.5 text-sm text-primary-600 hover:text-primary-700"
            >
              {t('gallery.people.showAll', {
                count: people.length,
                defaultValue: `Show all ${people.length}`,
              })}
              <ChevronRight size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onCollapsedChange(true)}
            aria-label={t('gallery.people.dismiss', { defaultValue: 'Hide the people bar' })}
            className="p-1 -m-1 text-neutral-400 hover:text-neutral-600"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Backfill progress. The strip appears as soon as the first clusters
          exist rather than blocking the gallery behind a spinner — a guest
          who arrives mid-scan gets a working gallery and a growing strip. */}
      {scan?.in_progress && (
        <div className="px-1 pb-2">
          <div className="flex items-center justify-between text-xs text-neutral-500 mb-1">
            <span style={{ color: 'var(--color-muted-text)' }}>
              {t('gallery.people.scanning', {
                scanned: scan.scanned,
                total: scan.total,
                defaultValue: `Finding people… ${scan.scanned}/${scan.total} photos`,
              })}
            </span>
          </div>
          <div className="h-0.5 bg-neutral-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 transition-all duration-500"
              style={{ width: `${scan.total ? Math.round((scan.scanned / scan.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      <div
        className="flex gap-3 overflow-x-auto pb-1 px-1 snap-x scrollbar-thin"
        style={{ scrollbarWidth: 'thin', WebkitOverflowScrolling: 'touch' }}
      >
        {inline.map((person) => (
          <div key={person.id} className="snap-start">
            <PersonAvatar
              person={person}
              photo={person.cover ? photoById.get(person.cover.photo_id) : undefined}
              slug={slug}
              size={avatarSize}
              selected={selectedPersonIds.includes(person.id)}
              onClick={() => onToggle(person.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default PeopleStrip;

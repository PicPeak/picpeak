/**
 * Neutral photo labels (issue 1733, E6): with the per-event switch on, a guest
 * sees "Photo 12 of 84" wherever the gallery would otherwise name a photo by
 * its filename (lightbox, tile captions, alt text, the selection tray). The
 * number is the photo's position in the list the guest is looking at, the same
 * list the lightbox steps through, so a tile and its lightbox agree.
 *
 * Display only. Downloads keep the real filename, and the photo payload still
 * carries it: what is saved to disk is named as before.
 *
 * Carried by context, like the tile badges: the name is rendered from every
 * layout and from the lightbox, and none of them decides on it. A nested
 * provider (Story, Premium) re-numbers against the layout's own filtered list
 * and inherits the switch from the gallery's provider.
 */
import React, { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Photo } from '../../types';

interface PhotoLabelsValue {
  neutral: boolean;
  positions: ReadonlyMap<number, number>;
  total: number;
}

const PhotoLabelsContext = createContext<PhotoLabelsValue>({ neutral: false, positions: new Map(), total: 0 });

export const PhotoLabelsProvider: React.FC<{
  /** Omitted on a nested provider: keep the gallery's setting. */
  neutral?: boolean;
  photos: ReadonlyArray<Pick<Photo, 'id'>>;
  children: React.ReactNode;
}> = ({ neutral, photos, children }) => {
  const parent = useContext(PhotoLabelsContext);
  const resolved = neutral ?? parent.neutral;
  const value = useMemo<PhotoLabelsValue>(() => ({
    neutral: resolved,
    // Built only when it is needed: a gallery of thousands with the switch
    // off should not pay for a map nobody reads.
    positions: resolved ? new Map(photos.map((photo, index) => [photo.id, index])) : new Map(),
    total: photos.length,
  }), [resolved, photos]);
  return <PhotoLabelsContext.Provider value={value}>{children}</PhotoLabelsContext.Provider>;
};

export interface PhotoLabels {
  /** Whether the gallery shows neutral labels instead of filenames. */
  neutral: boolean;
  /** "Photo 12 of 84" for a 0-based index into a list of `total`. */
  at: (index: number, total: number) => string;
  /**
   * The name to show for a photo: `fallback` (the filename the caller would
   * have shown) unless neutral labels are on. A photo outside the numbered
   * list (the hero) gets the label without a number.
   */
  of: (photo: Pick<Photo, 'id'>, fallback: string) => string;
  /** Whether the photo is in the numbered list (false with the switch off). */
  has: (photo: Pick<Photo, 'id'>) => boolean;
}

export function usePhotoLabels(): PhotoLabels {
  const { neutral, positions, total } = useContext(PhotoLabelsContext);
  const { t } = useTranslation();
  return useMemo<PhotoLabels>(() => {
    const at = (index: number, count: number) =>
      t('gallery.neutralLabel.numbered', { position: index + 1, total: count, defaultValue: 'Photo {{position}} of {{total}}' });
    return {
      neutral,
      at,
      of: (photo, fallback) => {
        if (!neutral) return fallback;
        const index = positions.get(photo.id);
        return index === undefined ? t('gallery.neutralLabel.plain', 'Photo') : at(index, total);
      },
      has: (photo) => positions.has(photo.id),
    };
  }, [neutral, positions, total, t]);
}

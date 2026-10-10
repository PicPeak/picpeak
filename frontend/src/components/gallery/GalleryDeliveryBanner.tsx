/**
 * Two-stage delivery (issue 1562): "More photos are on their way", rendered
 * AFTER the delivered photos, plus a few placeholder tiles where the rest will
 * land.
 *
 * Renders nothing unless the delivery is still partial, so a complete gallery
 * is unchanged. The placeholders are decoration only: aria-hidden, not
 * clickable, and never part of any count or selection.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

import type { GalleryDelivery } from '../../types';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useTheme } from '../../contexts/ThemeContext';
import { gridGeometryClass } from './layouts/GridGalleryLayout';

interface GalleryDeliveryBannerProps {
  delivery: GalleryDelivery | null | undefined;
  /**
   * Draw the placeholder tiles below the banner. Off for the full-page
   * layouts (Premium, Story), whose own tile geometry a plain grid of
   * skeletons would not match.
   */
  showPlaceholders?: boolean;
  className?: string;
}

export const GalleryDeliveryBanner: React.FC<GalleryDeliveryBannerProps> = ({
  delivery,
  showPlaceholders = true,
  className = '',
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { theme } = useTheme();

  if (!delivery || delivery.status !== 'partial') return null;

  const delivered = delivery.delivered_count;
  const expected = delivery.expected_count && delivery.expected_count > 0 ? delivery.expected_count : null;
  // Through the general date format setting, like every other guest-facing date.
  const date = delivery.due_at ? format(delivery.due_at) : '';

  let text: string;
  if (expected !== null && date) {
    text = t(
      'gallery.delivery.progressWithDate',
      '{{delivered}} of approx. {{expected}} photos are here. Your photographer is still working on the remaining images — the complete gallery will be here by {{date}} at the latest.',
      { delivered, expected, date }
    );
  } else if (expected !== null) {
    text = t(
      'gallery.delivery.progress',
      '{{delivered}} of approx. {{expected}} photos are here. Your photographer is still working on the remaining images.',
      { delivered, expected }
    );
  } else if (date) {
    text = t(
      'gallery.delivery.withDate',
      'Your photographer is still working on the remaining images — the complete gallery will be here by {{date}} at the latest.',
      { date }
    );
  } else {
    text = t('gallery.delivery.noDetails', 'Your photographer is still working on the remaining images.');
  }

  const percent = expected !== null ? Math.min(100, Math.round((delivered / expected) * 100)) : null;
  const placeholders = showPlaceholders ? Math.max(0, delivery.placeholder_count || 0) : 0;

  return (
    <div className={className} data-testid="gallery-delivery-banner">
      <div
        className="flex items-start gap-4 p-4 sm:p-5 rounded-lg border border-border-token bg-surface"
        style={{ borderLeft: '3px solid var(--color-accent)' }}
      >
        <span
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full border border-border-token"
          style={{ backgroundColor: 'var(--color-background)', color: 'var(--color-accent)' }}
          aria-hidden="true"
        >
          <Sparkles className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium" style={{ color: 'var(--color-text)' }}>
            {t('gallery.delivery.title', 'More photos are on their way')}
          </h3>
          <p className="mt-1 text-sm text-muted-theme">{text}</p>
          {percent !== null && (
            <div
              className="mt-3 h-1 w-full max-w-xs rounded-full overflow-hidden"
              style={{ backgroundColor: 'var(--color-surface-border)' }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={expected ?? undefined}
              aria-valuenow={Math.min(delivered, expected ?? delivered)}
              aria-label={t('gallery.delivery.progressLabel', 'Photos delivered so far')}
            >
              <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: 'var(--color-accent)' }} />
            </div>
          )}
        </div>
      </div>

      {placeholders > 0 && (
        <div
          className={`mt-4 ${gridGeometryClass(theme.gallerySettings || {})}`}
          aria-hidden="true"
          data-testid="gallery-delivery-placeholders"
          // Fade out downwards: these hint at more to come, they are not a
          // second gallery to scroll through.
          style={{
            maskImage: 'linear-gradient(to bottom, black 20%, transparent)',
            WebkitMaskImage: 'linear-gradient(to bottom, black 20%, transparent)',
            pointerEvents: 'none',
          }}
        >
          {Array.from({ length: placeholders }, (_, index) => (
            <div
              key={index}
              // The .skeleton class paints a fixed light grey; the gallery
              // theme's border tone keeps it right on dark themes (#358).
              className="skeleton bg-border-token aspect-square"
            />
          ))}
        </div>
      )}
    </div>
  );
};

import React from 'react';
import { useTranslation } from 'react-i18next';
import { COLOR_LABEL_SWATCHES, type ColorLabel } from '../../services/feedback.service';

interface ColorLabelBadgeProps {
  colorLabel?: string | null;
  /** Extra classes for positioning inside the tile. */
  className?: string;
}

/**
 * The colour a guest gave a photo, shown on the thumbnail (#1044).
 *
 * The whole point of the feature is that a client can see their selection
 * progress across the grid without reopening anything, so this is deliberately
 * loud: an inset ring around the tile plus a corner dot. Both are
 * pointer-events-none so they never swallow a click meant for the tile.
 */
export const ColorLabelBadge: React.FC<ColorLabelBadgeProps> = ({ colorLabel, className = '' }) => {
  const { t } = useTranslation();

  if (!colorLabel || !(colorLabel in COLOR_LABEL_SWATCHES)) return null;
  const swatch = COLOR_LABEL_SWATCHES[colorLabel as ColorLabel];
  const name = t(`feedback.colorLabels.${colorLabel}`, colorLabel);

  return (
    <>
      <span
        className={`absolute inset-0 pointer-events-none rounded-[inherit] ${className}`}
        // Inset rather than an outline: the tile is often flush against its
        // neighbours in masonry/justified layouts, where an outer ring would
        // be clipped.
        style={{ boxShadow: `inset 0 0 0 3px ${swatch.fill}` }}
        aria-hidden="true"
      />
      <span
        className="absolute top-2 left-2 pointer-events-none flex items-center justify-center w-5 h-5 rounded-full border-2 border-white/90 shadow"
        style={{ backgroundColor: swatch.fill }}
        // Colour alone can't carry the meaning — the accessible name does.
        title={t('feedback.markedAs', 'Marked as {{color}}', { color: name })}
        role="img"
        aria-label={t('feedback.markedAs', 'Marked as {{color}}', { color: name })}
      />
    </>
  );
};
